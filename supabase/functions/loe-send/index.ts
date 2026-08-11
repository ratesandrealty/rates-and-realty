import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { requireStaff } from '../_shared/require-staff.ts'
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1'

const URL = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-api-version' }
const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
const svc = () => createClient(URL, SERVICE, { auth: { persistSession: false } })
const esc = (x: any) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

async function requireAdmin(req: Request) {
  const auth = req.headers.get('Authorization') || ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  if (!token) return { ok: false, status: 401, msg: 'missing authorization' }
  if (token === SERVICE) return { ok: true }
  try {
    const u = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } })
    const { data: { user } } = await u.auth.getUser()
    if (!user) return { ok: false, status: 401, msg: 'invalid session' }
    const { data: isAdmin } = await u.rpc('is_admin')
    if (!isAdmin) return { ok: false, status: 403, msg: 'admin only' }
    return { ok: true }
  } catch (_e) { return { ok: false, status: 401, msg: 'auth failed' } }
}

function letterToHtml(text: string) {
  return String(text || '').trim().split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;">${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
}

const SIGNER_BLOCK = `<div style="margin:16px 0 4px;">
  <div style="min-height:46px;">{{signature}}</div>
  <div style="border-top:1px solid #333;width:300px;padding-top:3px;font-size:13px;color:#222;">{{printed_name}} &nbsp;&middot;&nbsp; Date: {{signed_date}}</div>
</div>`

/* ── MULTI-LOE PACKAGE ────────────────────────────────────────────────────────
 *
 * Several letters drafted in one sitting, sent as ONE signature package, each
 * letter signed individually.
 *
 * WHY THIS RENDERS A PDF RATHER THAN REUSING THE TEMPLATE PATH.
 * esign has two envelope shapes. `create` with `template_key` builds ONE html
 * document and hangs it on signature_requests.document_html — it is single by
 * construction. `create` with `document_ids[]` builds an envelope over N
 * esign_documents rows, each with its own esign_fields keyed on
 * (document_id, signer_index), and view/sign/finalize already loop those
 * documents (esign/index.ts:437, :635, :684). The N-document path is the one
 * that already works, so a package is N documents on it — NOT a change to the
 * signing machinery of a legally significant function.
 *
 * A consequence worth stating: because these are separate documents with
 * separate fields, ONE SIGNATURE CANNOT COVER THE PACKAGE. The signer signs each
 * letter, which is the point.
 *
 * Generating the PDF here (rather than converting supplied HTML) is what makes
 * the field placement exact: the renderer knows the y of every signature rule it
 * drew, so the signature box is placed directly above the printed name instead
 * of being guessed from a layout engine's output.
 *
 * COORDINATES: esign_fields x/y/w/h are FRACTIONS of the page, y measured from
 * the TOP. pdf-lib draws from the BOTTOM. Verified against live rows before
 * writing this — a wrong axis puts a signature somewhere else on a legal
 * document, and it would look plausible. */
const PAGE_W = 612, PAGE_H = 792            // US Letter, matching existing esign_documents.page_sizes
const MARGIN = 56
const SIG_BOX_H = 34                        // height of the signature area above the rule
const SIG_BOX_W = 240

type PlacedField = { page: number; x: number; y: number; w: number; h: number; signer_index: number }

function wrap(text: string, font: any, size: number, maxW: number): string[] {
  const out: string[] = []
  for (const para of String(text || '').replace(/\r/g, '').split('\n')) {
    if (!para.trim()) { out.push(''); continue }
    let line = ''
    for (const word of para.split(/\s+/)) {
      const probe = line ? line + ' ' + word : word
      if (font.widthOfTextAtSize(probe, size) <= maxW) { line = probe; continue }
      if (line) out.push(line)
      line = word
    }
    if (line) out.push(line)
  }
  return out
}

/* One letter → one PDF, plus the signature fields it placed.
 * signerNames is in signer order, so index i becomes signer_index i+1 — the same
 * 1-based convention esign's createPdf reads when it counts required signers. */
async function renderLoePdf(title: string, bodyText: string, signerNames: string[]) {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.TimesRoman)
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold)
  const SIZE = 11, LEAD = 16, TEXT_W = PAGE_W - MARGIN * 2

  let page = pdf.addPage([PAGE_W, PAGE_H])
  let y = PAGE_H - MARGIN
  let pageNo = 1
  const fields: PlacedField[] = []

  const nextPageIfNeeded = (need: number) => {
    if (y - need >= MARGIN) return
    page = pdf.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; pageNo++
  }

  page.drawText(String(title || 'Letter of Explanation').slice(0, 90), { x: MARGIN, y, size: 14, font: bold, color: rgb(0, 0, 0) })
  y -= LEAD * 2

  for (const line of wrap(bodyText, font, SIZE, TEXT_W)) {
    nextPageIfNeeded(LEAD)
    if (line) page.drawText(line, { x: MARGIN, y, size: SIZE, font, color: rgb(0, 0, 0) })
    y -= LEAD
  }

  /* SIGNATURE BLOCKS — one per signer, each directly ABOVE that signer's own
   * printed full name. Two borrowers on one letter therefore get two separate
   * blocks and two separate names, never a shared line. */
  y -= LEAD
  for (let i = 0; i < signerNames.length; i++) {
    nextPageIfNeeded(SIG_BOX_H + LEAD * 3)
    const boxTopPdf = y                      // pdf-lib space, measured from the bottom
    const ruleY = boxTopPdf - SIG_BOX_H
    page.drawLine({ start: { x: MARGIN, y: ruleY }, end: { x: MARGIN + SIG_BOX_W, y: ruleY }, thickness: 1, color: rgb(0.2, 0.2, 0.2) })
    page.drawText(String(signerNames[i] || '').slice(0, 80), { x: MARGIN, y: ruleY - 14, size: SIZE, font, color: rgb(0, 0, 0) })

    fields.push({
      page: pageNo,
      x: MARGIN / PAGE_W,
      // y from the TOP of the page, as a fraction — see the coordinates note above.
      y: (PAGE_H - boxTopPdf) / PAGE_H,
      w: SIG_BOX_W / PAGE_W,
      h: SIG_BOX_H / PAGE_H,
      signer_index: i + 1,
    })
    y = ruleY - 14 - LEAD * 2
  }

  const bytes = await pdf.save()
  const pageSizes = pdf.getPages().map(() => ({ w: PAGE_W, h: PAGE_H }))
  return { bytes, fields, pageCount: pageSizes.length, pageSizes }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  try {
    /* STAFF. Sending an LOE for signature is ordinary loan-processing work and
     * the VA is the primary processor; requireAdmin() refused her with
     * "admin only", so she could draft an LOE (loe-generate admits staff) and
     * then not send it. This function only sends — it deletes nothing. */
    const adm = await requireStaff(req, { what: 'Sending an LOE' })
    if (!adm.ok) return json({ error: adm.msg }, adm.status || 403)
    const body = await req.json().catch(() => ({}))
    const loe_id = body.loe_id
    const sendSms = body.send_sms !== false
    const db = svc()

    /* action:'send_package' — several LOEs, one envelope, each signed on its own
     * document. Falls through to the single-LOE path when absent, so every
     * existing caller is untouched. */
    if (body.action === 'send_package') {
      const loeIds: string[] = Array.isArray(body.loe_ids) ? body.loe_ids.filter(Boolean) : []
      if (!loeIds.length) return json({ error: 'loe_ids[] required' }, 400)

      const { data: loeRows } = await db.from('loe_requests').select('*').in('id', loeIds)
      const loes = loeIds.map((id) => (loeRows || []).find((l: any) => l.id === id)).filter(Boolean) as any[]
      if (loes.length !== loeIds.length) return json({ error: 'one or more LOEs not found' }, 404)
      for (const l of loes) {
        if (!l.body || !String(l.body).trim()) return json({ error: `LOE "${l.title || l.topic || l.id}" has no drafted body` }, 400)
        if (l.envelope_id && ['sent', 'signed'].includes(l.status)) return json({ error: `LOE "${l.title || l.id}" is already ${l.status}` }, 409)
      }

      /* ONE signer set for the package. Each letter is a separate document, but
       * they go to the same people in one sitting — that is what "one package"
       * means. Mixed signer sets would need separate envelopes, so refuse rather
       * than silently sending letter 2 to letter 1's borrowers. */
      const sig = (l: any) => JSON.stringify(
        ((Array.isArray(l.signer_contact_ids) && l.signer_contact_ids.length) ? l.signer_contact_ids : [l.contact_id]).filter(Boolean).slice().sort())
      const first = sig(loes[0])
      const mismatch = loes.find((l) => sig(l) !== first)
      if (mismatch) return json({ error: `"${mismatch.title || mismatch.id}" has different signers from the first letter. Send it as its own package.` }, 400)

      const signerIds: string[] = JSON.parse(first)
      if (!signerIds.length) return json({ error: 'no signer contacts on these LOEs' }, 400)
      const { data: cs } = await db.from('contacts').select('id,first_name,middle_name,last_name,email,phone,secondary_phone').in('id', signerIds)
      const signers = signerIds.map((id) => {
        const c = (cs || []).find((x: any) => x.id === id)
        if (!c) return null
        const name = [c.first_name, c.middle_name, c.last_name].filter(Boolean).join(' ').trim()
        return { person_contact_id: c.id, name, email: c.email || null, phone: c.phone || c.secondary_phone || null, role: 'borrower' }
      }).filter(Boolean) as any[]
      if (!signers.length) return json({ error: 'could not resolve signer details' }, 400)
      if (!signers.some((s) => s.email || s.phone)) return json({ error: 'signers have no email or phone to send to' }, 400)

      const documentIds: string[] = []
      for (let i = 0; i < loes.length; i++) {
        const l = loes[i]
        const title = (l.title && String(l.title).trim()) || l.topic || 'Letter of Explanation'
        const { bytes, fields, pageCount, pageSizes } = await renderLoePdf(title, l.body, signers.map((s) => s.name))

        /* storage_path is written on the SAME insert that puts the object in the
         * bucket. esign_documents is what the storage reconcile registry matches
         * bucket objects against, so an upload without its row is exactly the
         * orphan shape — the object exists and nothing references it. */
        const path = `loe/${l.contact_id || 'nocontact'}/${crypto.randomUUID()}.pdf`
        const up = await db.storage.from('esign').upload(path, bytes, { contentType: 'application/pdf', upsert: false })
        if (up.error) return json({ error: `upload failed for "${title}": ${up.error.message}` }, 500)

        const { data: doc, error: docErr } = await db.from('esign_documents').insert({
          name: `${title}.pdf`, storage_path: path, page_count: pageCount, page_sizes: pageSizes,
          source: 'upload', contact_id: l.contact_id ?? null, created_by: adm.userId ?? null, sort_order: i,
        }).select('id').single()
        if (docErr) {
          // Do not leave the object behind if its row failed — that IS the orphan.
          await db.storage.from('esign').remove([path])
          return json({ error: `could not record document for "${title}": ${docErr.message}` }, 500)
        }
        documentIds.push(doc.id)

        const fieldRows = fields.map((f) => ({
          document_id: doc.id, signer_index: f.signer_index, type: 'signature',
          page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: true, fill_by: 'signer',
        }))
        const { error: fErr } = await db.from('esign_fields').insert(fieldRows)
        if (fErr) return json({ error: `could not place signature fields on "${title}": ${fErr.message}` }, 500)
      }

      const packageTitle = String(body.document_title || '').trim() || `${loes.length} letters of explanation`
      const r = await fetch(`${URL}/functions/v1/esign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE}`, 'apikey': SERVICE },
        body: JSON.stringify({
          action: 'create', document_ids: documentIds, contact_id: loes[0].contact_id, signers,
          document_title: packageTitle, send_sms: sendSms, order_mode: 'parallel',
          email_subject: `Please sign: ${packageTitle}`,
        }),
      })
      const out = await r.json().catch(() => ({}))
      if (!r.ok || out?.error) return json({ error: out?.error || 'esign create failed', detail: out }, r.status || 500)

      await db.from('loe_requests').update({ envelope_id: out.envelope_id, status: 'sent', sent_at: new Date().toISOString() }).in('id', loeIds)
      return json({ ok: true, envelope_id: out.envelope_id, documents: documentIds.length, letters: loeIds.length, signers: out.signers })
    }

    if (!loe_id) return json({ error: 'loe_id required' }, 400)

    const { data: loe } = await db.from('loe_requests').select('*').eq('id', loe_id).maybeSingle()
    if (!loe) return json({ error: 'LOE not found' }, 404)
    if (!loe.body || !String(loe.body).trim()) return json({ error: 'LOE has no drafted body to send' }, 400)
    if (loe.envelope_id && ['sent', 'signed'].includes(loe.status)) return json({ error: `LOE already ${loe.status}` }, 409)

    let signerIds: string[] = (Array.isArray(loe.signer_contact_ids) && loe.signer_contact_ids.length) ? loe.signer_contact_ids.filter(Boolean) : (loe.contact_id ? [loe.contact_id] : [])
    signerIds = [...new Set(signerIds)]
    if (!signerIds.length) return json({ error: 'no signer contacts on this LOE' }, 400)

    const { data: cs } = await db.from('contacts').select('id,first_name,middle_name,last_name,email,phone,secondary_phone').in('id', signerIds)
    const byId = new Map((cs || []).map((c: any) => [c.id, c]))
    const signers = signerIds.map((id) => {
      const c: any = byId.get(id); if (!c) return null
      const name = [c.first_name, c.middle_name, c.last_name].filter(Boolean).join(' ').trim()
      return { name, email: c.email || null, phone: c.phone || c.secondary_phone || null, person_contact_id: id, role: 'borrower' }
    }).filter(Boolean) as any[]
    if (!signers.length) return json({ error: 'could not resolve signer details' }, 400)
    if (!signers.some((s) => s.email || s.phone)) return json({ error: 'signers have no email or phone to send to' }, 400)

    const title = (loe.title && String(loe.title).trim()) || loe.topic || 'Letter of Explanation'
    const tplKey = `loe_${loe_id}`
    const bodyHtml = `<div style="font-family:Georgia,'Times New Roman',serif;font-size:14px;line-height:1.65;color:#1a1a1a;max-width:680px;">${letterToHtml(loe.body)}<div style="margin-top:10px;">{{SIGNERS}}</div></div>`

    const tplRow: any = { key: tplKey, name: title, document_type: 'letter', body_html: bodyHtml, signer_block_html: SIGNER_BLOCK, defaults: {}, collects: [], active: true, updated_at: new Date().toISOString() }
    const { data: existingTpl } = await db.from('signature_templates').select('id').eq('key', tplKey).maybeSingle()
    let tErr: any = null
    if (existingTpl) { const r = await db.from('signature_templates').update(tplRow).eq('key', tplKey); tErr = r.error }
    else { const r = await db.from('signature_templates').insert(tplRow); tErr = r.error }
    if (tErr) return json({ error: 'template prep failed: ' + tErr.message }, 500)

    const r = await fetch(`${URL}/functions/v1/esign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE}`, 'apikey': SERVICE },
      body: JSON.stringify({ action: 'create', template_key: tplKey, contact_id: loe.contact_id, lead_id: null, signers, document_title: title, send_sms: sendSms, order_mode: 'parallel', email_subject: `Please sign: ${title}` })
    })
    const out = await r.json().catch(() => null)
    await db.from('signature_templates').update({ active: false }).eq('key', tplKey)
    if (!out || out.error || !out.envelope_id) return json({ error: (out && out.error) || 'send failed' }, 502)

    await db.from('loe_requests').update({ envelope_id: out.envelope_id, status: 'sent', sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', loe_id)

    return json({ ok: true, loe_id, envelope_id: out.envelope_id, status: 'sent', signers: out.signers })
  } catch (e: any) {
    return json({ error: e?.message || 'error' }, 500)
  }
})

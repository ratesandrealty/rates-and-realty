import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { requireStaff } from '../_shared/require-staff.ts'
import { renderLoePdf } from '../_shared/loe-pdf.ts'

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

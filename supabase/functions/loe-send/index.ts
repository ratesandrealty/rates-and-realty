import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

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
    const adm = await requireAdmin(req)
    if (!adm.ok) return json({ error: adm.msg }, adm.status || 403)
    const body = await req.json().catch(() => ({}))
    const loe_id = body.loe_id
    const sendSms = body.send_sms !== false
    if (!loe_id) return json({ error: 'loe_id required' }, 400)
    const db = svc()

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

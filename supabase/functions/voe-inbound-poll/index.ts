// voe-inbound-poll v1 — VOE Phase 2 inbound Gmail capture.
// Polls rene@ Gmail for HR VOE replies, matches them to loan_orders via
// voe_match_reply (token in To/Delivered-To, else from_email = hr_contact_email),
// and logs each into email_log via voe_log_inbound (idempotent on gmail_message_id).
// Deployed verify_jwt=false (project cron convention); optional x-cron-secret gate.
// Body opts: { dry_run?:bool, lookback_days?:int (default 14), max_messages?:int (default 60) }

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { requireStaff } from '../_shared/require-staff.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!

const SELF_ADDRESSES = ['rene@ratesandrealty.com','processing@ratesandrealty.com','reneduarte.homeside@gmail.com']
const J = { 'Content-Type': 'application/json' }

function rest(path: string){ return `${SUPABASE_URL}/rest/v1/${path}` }
function svc(){ return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' } }

async function getToken(): Promise<string> {
  const r = await fetch(rest('google_calendar_tokens?id=eq.rene&select=access_token,refresh_token,expires_at'), { headers: svc() })
  const rows = await r.json()
  if (!rows || !rows.length) throw new Error('no google token row for rene')
  let { access_token, refresh_token, expires_at } = rows[0]
  const exp = expires_at ? new Date(expires_at).getTime() : 0
  if (exp < Date.now() + 120000 && refresh_token) {
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token, grant_type: 'refresh_token' })
    })
    const t = await tr.json()
    if (t.access_token) {
      access_token = t.access_token
      await fetch(rest('google_calendar_tokens?id=eq.rene'), { method: 'PATCH', headers: svc(),
        body: JSON.stringify({ access_token, expires_at: new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString(), updated_at: new Date().toISOString() }) })
    }
  }
  return access_token
}

async function gmailList(token: string, q: string, max = 25){
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(q)}`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) return { error: `list ${r.status}`, messages: [] as any[] }
  const j = await r.json()
  return { messages: (j.messages || []) as any[] }
}

async function gmailGet(token: string, id: string){
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) return null
  return await r.json()
}

function hdr(headers: any[], name: string){ const h = (headers || []).find((x: any) => (x.name || '').toLowerCase() === name.toLowerCase()); return h ? h.value : null }
function parseEmail(v: string | null){ if (!v) return null; const m = v.match(/<([^>]+)>/); return (m ? m[1] : v).trim().toLowerCase() }
function b64urlDecode(data: string){ try { const b = data.replace(/-/g, '+').replace(/_/g, '/'); const pad = b.length % 4 ? '='.repeat(4 - (b.length % 4)) : ''; const bin = atob(b + pad); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return new TextDecoder('utf-8').decode(bytes) } catch { return '' } }
function walk(part: any, acc: { text: string, html: string }){ if (!part) return; const mt = (part.mimeType || '').toLowerCase(); const d = part.body && part.body.data; if (mt === 'text/plain' && d && !acc.text) acc.text = b64urlDecode(d); else if (mt === 'text/html' && d && !acc.html) acc.html = b64urlDecode(d); if (Array.isArray(part.parts)) for (const p of part.parts) walk(p, acc) }

async function rpc(name: string, args: any){ const r = await fetch(rest('rpc/' + name), { method: 'POST', headers: svc(), body: JSON.stringify(args || {}) }); const t = await r.text(); try { return JSON.parse(t) } catch { return t } }

serve(async (req) => {
  /* ── GUARDED. THIS FUNCTION WAS COMPLETELY OPEN. ──────────────────────────
   *
   * What was here:
   *
   *     if (POLL_SECRET) {
   *       const s = req.headers.get('x-cron-secret') || ''
   *       if (s !== POLL_SECRET) return 401
   *     }
   *
   * VOE_POLL_SECRET was never set, so `if (POLL_SECRET)` was false and the
   * whole check was skipped. verify_jwt = false on top of that, so ANY
   * unauthenticated POST ran a full Gmail poll of rene@'s mailbox and wrote
   * email_log rows. A gate that disables itself when its secret is missing
   * fails OPEN, and reads in a grep exactly like a gate that works — which is
   * how it survived: docs/EDGE-FUNCTION-CAPABILITY-MAP.md recorded it as
   * "shared secret compare", and docs/CRON-REHEADER recorded it as needing
   * x-cron-secret. Both described the code, not its behaviour.
   *
   * PROVEN, not inferred: cron job 37 sent Content-Type ONLY — no secret of any
   * kind — and returned 200 with real output on every ten-minute run. That is
   * only possible with the gate off.
   *
   * requireStaff FAILS CLOSED: no header, wrong secret, and unset secret are
   * all refusals.
   *
   * allowInternal — the only caller is pg_cron job 37, every ten minutes, which
   * cannot hold a session. No browser caller; grepped repo-wide, the sole hits are this
   * file, config.toml and two docs.
   *
   * CALLER FIRST: job 37 was re-headered to internal_call_headers() BEFORE this
   * guard shipped, and proven by its own natural run — net._http_response
   * 386458 at 23:00:02Z, 200, authenticated_as rene@ratesandrealty.com. */
  const auth = await requireStaff(req, { allowInternal: true, what: 'Polling VOE inbound mail' })
  if (!auth.ok) {
    console.error('[voe-inbound-poll] REJECTED:', auth.status, auth.msg)
    return new Response(JSON.stringify({ ok: false, error: auth.msg || 'unauthorized' }), { status: auth.status || 401, headers: J })
  }
  let body: any = {}
  try { body = await req.json() } catch {}
  const lookback = (body.lookback_days ? Number(body.lookback_days) : 14) + 'd'
  const dryRun = !!body.dry_run
  const maxMsgs = body.max_messages ? Number(body.max_messages) : 60

  const summary: any = { ok: true, dry_run: dryRun, authenticated_as: null, queries: [], candidate_orders: 0, ids_found: 0, already_logged_skipped: 0, fetched: 0, logged: 0, duplicates: 0, unmatched: 0, results: [], errors: [] }

  try {
    const token = await getToken()
    const pr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${token}` } })
    if (pr.ok) { const pj = await pr.json(); summary.authenticated_as = pj.emailAddress } else { summary.errors.push('profile ' + pr.status) }

    let orders: any[] = []
    try { const o = await rpc('voe_orders_awaiting_reply', {}); if (Array.isArray(o)) orders = o } catch (e) { summary.errors.push('orders rpc: ' + (e as any).message) }
    summary.candidate_orders = orders.length

    const queries: string[] = []
    for (const o of orders) {
      if (o.hr_contact_email) queries.push(`from:${o.hr_contact_email} newer_than:${lookback}`)
      if (o.voe_reply_token) queries.push(`to:rene+${o.voe_reply_token}@ratesandrealty.com newer_than:${lookback}`)
    }
    queries.push(`newer_than:${lookback} -in:sent (subject:"verification of employment" OR subject:"employment verification")`)
    summary.queries = queries

    const idset = new Map<string, string>()
    for (const q of queries) {
      const res = await gmailList(token, q, 25)
      if ((res as any).error) { summary.errors.push((res as any).error); continue }
      for (const m of res.messages) idset.set(m.id, m.threadId)
    }
    summary.ids_found = idset.size

    const ids = [...idset.keys()].slice(0, maxMsgs)
    if (ids.length) {
      const inList = ids.map((x) => `"${x}"`).join(',')
      const er = await fetch(rest(`email_log?select=gmail_message_id&gmail_message_id=in.(${inList})`), { headers: svc() })
      const existing = er.ok ? await er.json() : []
      const have = new Set((existing || []).map((r: any) => r.gmail_message_id))
      const todo = ids.filter((id) => !have.has(id))
      summary.already_logged_skipped = ids.length - todo.length

      for (const id of todo) {
        const msg = await gmailGet(token, id)
        if (!msg) { summary.errors.push('get ' + id + ' failed'); continue }
        summary.fetched++
        const headers = msg.payload && msg.payload.headers
        const fromEmail = parseEmail(hdr(headers, 'From'))
        if (fromEmail && SELF_ADDRESSES.includes(fromEmail)) continue
        const toRaw = hdr(headers, 'To'); const dto = hdr(headers, 'Delivered-To'); const cc = hdr(headers, 'Cc')
        const subject = hdr(headers, 'Subject')
        const acc = { text: '', html: '' }
        walk(msg.payload, acc)
        const args: any = {
          p_gmail_message_id: id,
          p_gmail_thread_id: msg.threadId || idset.get(id) || null,
          p_from_email: fromEmail,
          p_to_email: [toRaw, dto].filter(Boolean).join(' '),
          p_cc_email: cc,
          p_subject: subject,
          p_body_html: acc.html || null,
          p_body_text: acc.text || (msg.snippet || null),
          p_received_at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null
        }
        if (dryRun) {
          const m = await rpc('voe_match_reply', { p_from_email: fromEmail, p_to_email: args.p_to_email, p_cc_email: cc, p_subject: subject, p_body: acc.text, p_reply_token: null })
          summary.results.push({ id, from: fromEmail, subject, matched_by: m && m.matched_by, order_id: m && m.order_id, action: 'dry_run' })
          if (m && m.matched_by === 'unmatched') summary.unmatched++
          continue
        }
        const res = await rpc('voe_log_inbound', args)
        if (res && res.duplicate) summary.duplicates++
        else if (res && res.email_log_id) summary.logged++
        if (res && res.matched_by === 'unmatched') summary.unmatched++
        summary.results.push({ id, from: fromEmail, subject, matched_by: res && res.matched_by, order_id: res && res.order_id, duplicate: res && res.duplicate })
      }
    }
  } catch (e) {
    summary.ok = false
    summary.errors.push('fatal: ' + ((e as any) && (e as any).message ? (e as any).message : String(e)))
  }
  return new Response(JSON.stringify(summary), { headers: J })
})

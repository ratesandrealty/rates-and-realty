// loan-date-nudges v2 — daily digest SMS to staff about loan dates overdue /
// due today / due in 3 days, plus third-party orders overdue.
// v2: sends FROM the AI-assistant 888 line (TWILIO_ASSISTANT_NUMBER, default
//     +18886881231) via Twilio directly + logs to sms_log — so nudges thread with
//     the assistant. (General sends stay on the 866 via sms-service, untouched.)
// Sources gathered + deduped by loan_date_nudge_scan(). verify_jwt=false (cron).
// Body: { dry_run?: bool }

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID')
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')
// Send nudges FROM the AI-assistant 888 line so they thread with the assistant.
const NUDGE_FROM = Deno.env.get('TWILIO_ASSISTANT_NUMBER') || '+18886881231'
const J = { 'Content-Type': 'application/json' }

function rest(p: string) { return `${SUPABASE_URL}/rest/v1/${p}` }
function svc() { return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' } }

async function rpc(name: string, args: any) {
  const r = await fetch(rest('rpc/' + name), { method: 'POST', headers: svc(), body: JSON.stringify(args || {}) })
  const t = await r.text(); try { return JSON.parse(t) } catch { return t }
}

function formatPhone(phone: string) {
  const d = (phone || '').replace(/\D/g, '')
  if (d.startsWith('1') && d.length === 11) return `+${d}`
  if (d.length === 10) return `+1${d}`
  return phone.startsWith('+') ? phone : `+${d}`
}

async function sendSMS(to: string, body: string): Promise<{ sent: boolean; sid?: string; error?: string }> {
  if (!TWILIO_SID || !TWILIO_TOKEN) return { sent: false, error: 'Twilio not configured' }
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: formatPhone(to), From: NUDGE_FROM, Body: body })
    })
    const data = await res.json()
    return res.ok && data.sid ? { sent: true, sid: data.sid } : { sent: false, error: data.message || data.code || 'Twilio error' }
  } catch (e: any) { return { sent: false, error: e.message } }
}

async function logSMS(p: { to_phone: string; body: string; twilio_sid?: string; status: string; error_message?: string }) {
  try {
    await fetch(rest('sms_log'), {
      method: 'POST', headers: svc(),
      body: JSON.stringify({
        to_phone: p.to_phone, body: p.body, trigger_type: 'loan_date_nudge',
        from_phone: NUDGE_FROM, direction: 'outbound',
        twilio_sid: p.twilio_sid || null, status: p.status, error_message: p.error_message || null,
        created_at: new Date().toISOString()
      })
    })
  } catch (_e) { /* non-fatal */ }
}

function fmtDate(d: string) {
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) } catch { return d }
}

function buildDigest(items: any[]) {
  const groups: Record<string, any[]> = { overdue: [], dayof: [], '3day': [] }
  for (const it of items) (groups[it.stage] || (groups[it.stage] = [])).push(it)
  const lines: string[] = [`R&R loan alerts (${items.length}):`]
  const section = (key: string, header: string, suffix: (it: any) => string) => {
    const g = groups[key]; if (!g || !g.length) return
    lines.push(header)
    for (const it of g) lines.push(`- ${it.borrower}: ${it.label}${suffix(it)}`)
  }
  section('overdue', 'OVERDUE:', (it) => ` (was ${fmtDate(it.due_date)})`)
  section('dayof', 'TODAY:', () => '')
  section('3day', 'IN 3 DAYS:', (it) => ` (${fmtDate(it.due_date)})`)
  return lines.join('\n')
}

serve(async (req) => {
  let body: any = {}
  try { body = await req.json() } catch {}
  const dryRun = !!body.dry_run
  const summary: any = { ok: true, dry_run: dryRun, from: NUDGE_FROM, item_count: 0, recipients: [], sent: 0, digest: null, errors: [] }

  /* Third-party order reminders ride on THIS schedule rather than a new cron.
   * Every outstanding order gets a task every 2 days until it is received or
   * marked not required. order_reminders_run() is idempotent — it skips any
   * order that already has an OPEN reminder, and counts from the last reminder
   * rather than the order date so a 30-day-old order does not generate 15
   * backdated tasks on first run.
   *
   * FIRST, and outside the main try, so a failure in the nudge digest below
   * cannot stop the reminders — and vice versa. They are unrelated jobs sharing
   * a timer, not one job. */
  if (!dryRun) {
    try {
      const created = await rpc('order_reminders_run', {})
      summary.order_reminders = Array.isArray(created) ? created.length : 0
    } catch (e) {
      summary.errors.push('order_reminders_run: ' + String((e as any)?.message || e))
    }
  }

  try {
    const items = await rpc('loan_date_nudge_scan', {})
    if (!Array.isArray(items)) { summary.ok = false; summary.errors.push('scan failed: ' + JSON.stringify(items)); return new Response(JSON.stringify(summary), { headers: J }) }
    summary.item_count = items.length
    if (items.length === 0) { summary.message = 'nothing due'; return new Response(JSON.stringify(summary), { headers: J }) }

    const capped = items.slice(0, 15)
    let digest = buildDigest(capped)
    if (items.length > 15) digest += `\n...and ${items.length - 15} more (check CRM)`
    summary.digest = digest

    const rres = await fetch(rest('sms_authorized_phones?select=phone,label,role&is_active=eq.true&role=in.(admin,owner,va,loa,staff,agent)'), { headers: svc() })
    const recips = rres.ok ? await rres.json() : []
    summary.recipients = recips.map((r: any) => r.phone)

    if (dryRun) return new Response(JSON.stringify(summary), { headers: J })

    for (const r of recips) {
      const result = await sendSMS(r.phone, digest)
      await logSMS({ to_phone: r.phone, body: digest, twilio_sid: result.sid, status: result.sent ? 'sent' : 'failed', error_message: result.error })
      if (result.sent) summary.sent++; else summary.errors.push(`send ${r.phone}: ${result.error || 'unknown'}`)
    }

    if (summary.sent > 0) {
      const marked = await rpc('loan_date_nudge_mark', { p_items: items })
      summary.marked = marked
    }
  } catch (e) {
    summary.ok = false
    summary.errors.push('fatal: ' + ((e as any) && (e as any).message ? (e as any).message : String(e)))
  }
  return new Response(JSON.stringify(summary), { headers: J })
})

// send-scheduled-sms v1 — mirrors send-scheduled-emails.
// Every minute: find sms_log rows status='scheduled' & scheduled_at<=now(), send via
// Twilio from the 866 business line, then UPDATE the same row to sent (no duplicate log).
// verify_jwt=false (cron). Body: { dry_run?: bool }

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID')
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')
// Manual composer texts go from the business line (same lane as sms-service 'custom').
const FROM_NUMBER = Deno.env.get('TWILIO_PHONE_NUMBER') || '+18668919394'
const J = { 'Content-Type': 'application/json' }

function rest(p: string) { return `${SUPABASE_URL}/rest/v1/${p}` }
function svc() { return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' } }

function formatPhone(phone: string) {
  const d = (phone || '').replace(/\D/g, '')
  if (d.startsWith('1') && d.length === 11) return `+${d}`
  if (d.length === 10) return `+1${d}`
  return phone && phone.startsWith('+') ? phone : `+${d}`
}

async function sendSMS(to: string, body: string, mediaUrl?: string | null) {
  if (!TWILIO_SID || !TWILIO_TOKEN) return { sent: false, error: 'Twilio not configured' }
  try {
    const form: Record<string, string> = { To: formatPhone(to), From: FROM_NUMBER, Body: body }
    if (mediaUrl) form.MediaUrl = mediaUrl
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form)
    })
    const data = await res.json()
    return res.ok && data.sid ? { sent: true, sid: data.sid } : { sent: false, error: data.message || data.code || 'Twilio error' }
  } catch (e: any) { return { sent: false, error: e.message } }
}

serve(async (req) => {
  let body: any = {}
  try { body = await req.json() } catch {}
  const dryRun = !!body.dry_run
  const summary: any = { ok: true, dry_run: dryRun, due: 0, sent: 0, failed: 0, errors: [] }

  try {
    // Find due scheduled texts
    const nowIso = new Date().toISOString()
    const url = rest(`sms_log?select=id,to_phone,body,media_url,contact_id&status=eq.scheduled&scheduled_at=lte.${encodeURIComponent(nowIso)}&order=scheduled_at.asc&limit=25`)
    const r = await fetch(url, { headers: svc() })
    const rows = r.ok ? await r.json() : []
    summary.due = rows.length
    if (dryRun || rows.length === 0) { summary.rows = rows.map((x: any) => x.id); return new Response(JSON.stringify(summary), { headers: J }) }

    /* OPT-OUT GATE — the last one before Twilio.
     *
     * This function used to send whatever sat in sms_log with status=scheduled and
     * never joined contacts, so a row queued before someone replied STOP still went
     * out afterwards. Queue-time checks upstream cannot cover that: the opt-out can
     * happen in the gap between scheduling and sending. Checking HERE catches every
     * path that can ever queue a row, including ones not yet written.
     *
     * Matches the contact when the row names one, and otherwise on the last 10
     * digits of the number — an opt-out belongs to a person, and a row with a null
     * contact_id must not be a way around it.
     *
     * Blocks IS FALSE only: an explicit opt-out, never a mere absence of recorded
     * consent. Blocked rows are parked at status='blocked' so they neither send nor
     * spin round the cron again. */
    async function optedOut(row: any): Promise<boolean> {
      try {
        if (row.contact_id) {
          const q = rest(`contacts?select=sms_opt_in&id=eq.${row.contact_id}&limit=1`)
          const rr = await fetch(q, { headers: svc() })
          const d = rr.ok ? await rr.json() : []
          if (d.length) return d[0].sms_opt_in === false
        }
        const digits = String(row.to_phone || '').replace(/\D/g, '').slice(-10)
        if (digits.length !== 10) return false
        const q2 = rest(`contacts?select=sms_opt_in,phone,secondary_phone&or=(phone.ilike.*${digits},secondary_phone.ilike.*${digits})&limit=20`)
        const rr2 = await fetch(q2, { headers: svc() })
        const d2 = rr2.ok ? await rr2.json() : []
        return d2.some((c: any) =>
          c.sms_opt_in === false &&
          (String(c.phone || '').replace(/\D/g, '').slice(-10) === digits ||
           String(c.secondary_phone || '').replace(/\D/g, '').slice(-10) === digits))
      } catch (_) {
        // A lookup failure must not become an accidental send to an opted-out number.
        return true
      }
    }

    for (const row of rows) {
      if (await optedOut(row)) {
        await fetch(rest(`sms_log?id=eq.${row.id}`), {
          method: 'PATCH', headers: { ...svc(), Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'blocked', error_message: 'recipient has opted out of SMS' })
        })
        summary.blocked = (summary.blocked || 0) + 1
        continue
      }
      const result = await sendSMS(row.to_phone, row.body, row.media_url)
      const patch = result.sent
        ? { status: 'sent', twilio_sid: result.sid, sent_at: new Date().toISOString() }
        : { status: 'failed', error_message: (result.error || 'unknown').slice(0, 300) }
      await fetch(rest(`sms_log?id=eq.${row.id}`), {
        method: 'PATCH', headers: { ...svc(), Prefer: 'return=minimal' }, body: JSON.stringify(patch)
      })
      if (result.sent) summary.sent++; else { summary.failed++; summary.errors.push(`${row.id}: ${result.error}`) }
    }
  } catch (e: any) {
    summary.ok = false
    summary.errors.push('fatal: ' + (e?.message || String(e)))
  }
  return new Response(JSON.stringify(summary), { headers: J })
})

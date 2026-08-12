// proactive-followups v1
// Sends proactive SMS alerts to the LO about loans/leads needing attention.
// Two modes:
//   mode=digest  (runs daily 8am Pacific) - one consolidated SMS with all 4 alert types
//   mode=urgent  (runs every 6 hours)     - one SMS per alert for things within 48h
// Authorized via x-cron-secret header or ?secret= query param (called by pg_cron).
// Reuses existing Twilio config (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SMS_ASSISTANT_FROM_NUMBER, AUTHORIZED_PHONES[0]).
// Logs every alert to proactive_alerts_sent for dedup + audit.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireStaff } from '../_shared/require-staff.ts'

type SbClient = ReturnType<typeof createClient>

/* HISTORY of this function's credential, kept because each step was a real
 * failure and the shape recurs:
 *
 *   1. `Deno.env.get(...) || '<literal>'` — the env var was never set, so it ran
 *      on the hardcoded fallback. In git, in every clone, and carried in
 *      cleartext in cron.job.command. The fallback always matched, so nothing
 *      ever looked wrong. (Same shape as sms-assistant's OCR_CRON_SECRET, which
 *      is still a literal in source today.)
 *   2. Rotated out 2026-08-06 into vault as `proactive_followups_secret`, read
 *      at request time via cron_secret_get().
 *   3. 2026-08-11 — replaced entirely by x-internal-secret. The vault read and
 *      the `?secret=` query-parameter path are both GONE; see the handler.
 *
 * `cron_secret_get('proactive_followups_secret')` now has no caller. The vault
 * entry can be deleted once nothing else references it — checked at the time of
 * writing: nothing does. Left in place rather than deleted blind, since a vault
 * entry costs nothing and a wrong deletion is unrecoverable. */
const STALE_LEAD_DAYS = 14
const PREAPPROVAL_WARN_DAYS = 30
const CREDIT_WARN_DAYS = 90
const LOCK_WARN_DAYS = 7
const URGENT_WINDOW_DAYS = 2
const URGENT_DEDUP_HOURS = 24
const SMS_MAX_LENGTH = 1500

function ptDateString(d: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
    const obj: Record<string, string> = {}
    for (const p of parts) obj[p.type] = p.value
    return `${obj.year}-${obj.month}-${obj.day}`
  } catch { return d.toISOString().slice(0, 10) }
}
function ptFriendlyDate(d: Date | string | null): string {
  if (!d) return ''
  try { const dt = typeof d === 'string' ? new Date(d) : d; return dt.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric' }) } catch { return String(d) }
}
function daysFromTodayPt(dateStr: string): number {
  const today = new Date(`${ptDateString(new Date())}T00:00:00-07:00`).getTime()
  const target = new Date(`${dateStr}T00:00:00-07:00`).getTime()
  return Math.round((target - today) / 86400000)
}

// ── ALERT CHECKS ───────────────────────────────────────────────────────────

async function getStaleLeads(sb: SbClient) {
  const cutoffIso = new Date(Date.now() - STALE_LEAD_DAYS * 86400000).toISOString()
  // Stale = no contact in N days, not closed/lost. Either last_contact_date is set and < cutoff,
  // OR last_contact_date is null and created_at < cutoff (new lead never touched).
  const { data, error } = await sb.from('contacts')
    .select('id, first_name, last_name, last_contact_date, created_at, pipeline_status')
    .or(`last_contact_date.lt.${cutoffIso},and(last_contact_date.is.null,created_at.lt.${cutoffIso})`)
    .not('pipeline_status', 'in', '("Closed","Lost","Dead")')
    // READ FILTER: a merged duplicate is not a lead to chase. 1020 contacts
    // qualify and this takes 50 of them with no ORDER BY, so a ghost surfaced
    // on some runs and not others — non-determinism, not safety.
    .is('merged_into_contact_id', null)
    .limit(50)
  if (error) { console.error('[stale]', error.message); return [] }
  const now = Date.now()
  return (data || []).map((c: Record<string, unknown>) => {
    const refDate = (c.last_contact_date as string) || (c.created_at as string)
    const daysStale = Math.floor((now - new Date(refDate).getTime()) / 86400000)
    return { contact_id: c.id as string, name: `${c.first_name || ''} ${c.last_name || ''}`.trim() || '(no name)', days_stale: daysStale, pipeline_status: (c.pipeline_status as string) || 'New Lead' }
  }).sort((a, b) => b.days_stale - a.days_stale)
}

async function getPreapprovalsExpiring(sb: SbClient, windowDays: number) {
  const today = ptDateString(new Date())
  const cutoff = ptDateString(new Date(Date.now() + windowDays * 86400000))
  const { data, error } = await sb.from('mortgage_applications')
    .select('id, contact_id, first_name, last_name, preapproval_expiry, contacts(first_name, last_name, pipeline_status)')
    .gte('preapproval_expiry', today).lte('preapproval_expiry', cutoff).limit(50)
  if (error) { console.error('[preapproval]', error.message); return [] }
  return (data || []).filter((a: Record<string, unknown>) => {
    const c = (a.contacts as Record<string, unknown>) || {}
    return !['Closed', 'Lost', 'Dead'].includes(String(c.pipeline_status || ''))
  }).map((a: Record<string, unknown>) => {
    const linked = (a.contacts as Record<string, unknown>) || {}
    const name = `${linked.first_name || a.first_name || ''} ${linked.last_name || a.last_name || ''}`.trim() || '(no name)'
    return { application_id: a.id as string, contact_id: a.contact_id as string, name, preapproval_expiry: a.preapproval_expiry as string, days_left: daysFromTodayPt(a.preapproval_expiry as string) }
  }).sort((a, b) => a.days_left - b.days_left)
}

async function getCreditAging(sb: SbClient) {
  const cutoff = ptDateString(new Date(Date.now() - CREDIT_WARN_DAYS * 86400000))
  const { data, error } = await sb.from('mortgage_applications')
    .select('id, contact_id, first_name, last_name, credit_report_pulled_date, contacts(first_name, last_name, pipeline_status)')
    .lt('credit_report_pulled_date', cutoff).limit(50)
  if (error) { console.error('[credit]', error.message); return [] }
  return (data || []).filter((a: Record<string, unknown>) => {
    const c = (a.contacts as Record<string, unknown>) || {}
    return !['Closed', 'Lost', 'Dead'].includes(String(c.pipeline_status || ''))
  }).map((a: Record<string, unknown>) => {
    const linked = (a.contacts as Record<string, unknown>) || {}
    const name = `${linked.first_name || a.first_name || ''} ${linked.last_name || a.last_name || ''}`.trim() || '(no name)'
    return { application_id: a.id as string, contact_id: a.contact_id as string, name, credit_pulled: a.credit_report_pulled_date as string }
  })
}

async function getLocksExpiring(sb: SbClient, windowDays: number) {
  const today = ptDateString(new Date())
  const cutoff = ptDateString(new Date(Date.now() + windowDays * 86400000))
  const { data, error } = await sb.from('mortgage_applications')
    .select('id, contact_id, first_name, last_name, rate_lock_expiry, contacts(first_name, last_name)')
    .gte('rate_lock_expiry', today).lte('rate_lock_expiry', cutoff).limit(50)
  if (error) { console.error('[lock]', error.message); return [] }
  return (data || []).map((a: Record<string, unknown>) => {
    const linked = (a.contacts as Record<string, unknown>) || {}
    const name = `${linked.first_name || a.first_name || ''} ${linked.last_name || a.last_name || ''}`.trim() || '(no name)'
    return { application_id: a.id as string, contact_id: a.contact_id as string, name, rate_lock_expiry: a.rate_lock_expiry as string, days_left: daysFromTodayPt(a.rate_lock_expiry as string) }
  }).sort((a, b) => a.days_left - b.days_left)
}

// ── DEDUP ──────────────────────────────────────────────────────────────────

async function digestAlreadySentToday(sb: SbClient): Promise<boolean> {
  const startOfDayPt = new Date(`${ptDateString(new Date())}T00:00:00-07:00`).toISOString()
  const { count, error } = await sb.from('proactive_alerts_sent').select('id', { count: 'exact', head: true })
    .eq('mode', 'digest').gte('sent_at', startOfDayPt)
  if (error) return false
  return (count || 0) > 0
}

async function urgentRecentlySent(sb: SbClient, alertType: string, contactId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - URGENT_DEDUP_HOURS * 3600000).toISOString()
  const { count } = await sb.from('proactive_alerts_sent').select('id', { count: 'exact', head: true })
    .eq('alert_type', alertType).eq('contact_id', contactId).gte('sent_at', cutoff)
  return (count || 0) > 0
}

// ── TWILIO ─────────────────────────────────────────────────────────────────

async function sendSmsToLO(body: string, sid: string, token: string, from: string, to: string): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`
  const auth = btoa(`${sid}:${token}`)
  const params = new URLSearchParams()
  params.set('To', to); params.set('From', from); params.set('Body', body.slice(0, SMS_MAX_LENGTH))
  try {
    const resp = await fetch(url, { method: 'POST', headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() })
    if (!resp.ok) return { ok: false, error: `Twilio ${resp.status}: ${(await resp.text().catch(() => '')).substring(0, 200)}` }
    const data = await resp.json().catch(() => ({}))
    return { ok: true, sid: (data as { sid?: string })?.sid }
  } catch (err) { return { ok: false, error: (err as Error).message } }
}

async function logAlert(sb: SbClient, row: Record<string, unknown>): Promise<void> {
  const { error } = await sb.from('proactive_alerts_sent').insert(row)
  if (error) console.error('[log alert]', error.message)
}

// ── DIGEST COMPOSITION ─────────────────────────────────────────────────────

function composeDigest(stale: ReturnType<typeof getStaleLeads> extends Promise<infer T> ? T : never, preapp: ReturnType<typeof getPreapprovalsExpiring> extends Promise<infer T> ? T : never, credit: ReturnType<typeof getCreditAging> extends Promise<infer T> ? T : never, lock: ReturnType<typeof getLocksExpiring> extends Promise<infer T> ? T : never): string | null {
  const total = stale.length + preapp.length + credit.length + lock.length
  if (total === 0) return null
  const lines = ['Good morning Rene.', `${total} ${total === 1 ? 'item' : 'items'} on your radar:`, '']
  if (lock.length > 0) {
    lines.push(`LOCK EXPIRING (next ${LOCK_WARN_DAYS}d):`)
    for (const x of lock.slice(0, 6)) lines.push(`- ${x.name} - ${ptFriendlyDate(x.rate_lock_expiry)} (${x.days_left}d)`)
    if (lock.length > 6) lines.push(`+ ${lock.length - 6} more`)
    lines.push('')
  }
  if (preapp.length > 0) {
    lines.push(`PREAPPROVAL EXPIRING (next ${PREAPPROVAL_WARN_DAYS}d):`)
    for (const x of preapp.slice(0, 6)) lines.push(`- ${x.name} - ${ptFriendlyDate(x.preapproval_expiry)} (${x.days_left}d)`)
    if (preapp.length > 6) lines.push(`+ ${preapp.length - 6} more`)
    lines.push('')
  }
  if (credit.length > 0) {
    lines.push(`CREDIT AGING (>${CREDIT_WARN_DAYS}d):`)
    for (const x of credit.slice(0, 6)) lines.push(`- ${x.name} - pulled ${ptFriendlyDate(x.credit_pulled)}`)
    if (credit.length > 6) lines.push(`+ ${credit.length - 6} more`)
    lines.push('')
  }
  if (stale.length > 0) {
    lines.push(`STALE LEADS (no contact ${STALE_LEAD_DAYS}d+):`)
    for (const x of stale.slice(0, 8)) lines.push(`- ${x.name} (${x.days_stale}d, ${x.pipeline_status})`)
    if (stale.length > 8) lines.push(`+ ${stale.length - 8} more`)
  }
  return lines.join('\n').slice(0, SMS_MAX_LENGTH).trim()
}

// ── RUNNERS ────────────────────────────────────────────────────────────────

async function runDigest(sb: SbClient, twilio: { sid: string; token: string; from: string; to: string }, force = false) {
  if (!force && await digestAlreadySentToday(sb)) {
    return { sent: false, reason: 'Already sent digest today (Pacific).' }
  }
  const [stale, preapp, credit, lock] = await Promise.all([
    getStaleLeads(sb), getPreapprovalsExpiring(sb, PREAPPROVAL_WARN_DAYS), getCreditAging(sb), getLocksExpiring(sb, LOCK_WARN_DAYS),
  ])
  const counts = { stale: stale.length, preapp: preapp.length, credit: credit.length, lock: lock.length }
  const body = composeDigest(stale, preapp, credit, lock)
  if (!body) return { sent: false, reason: 'Nothing to alert about.', counts }
  const send = await sendSmsToLO(body, twilio.sid, twilio.token, twilio.from, twilio.to)
  await logAlert(sb, {
    alert_type: 'digest', mode: 'digest', alert_payload: body, recipient_phone: twilio.to,
    twilio_message_sid: send.sid || null, delivery_ok: send.ok, delivery_error: send.error || null,
  })
  return { sent: send.ok, body, twilio_sid: send.sid, error: send.error, counts }
}

async function runUrgent(sb: SbClient, twilio: { sid: string; token: string; from: string; to: string }) {
  const [lockUrgent, preappUrgent] = await Promise.all([getLocksExpiring(sb, URGENT_WINDOW_DAYS), getPreapprovalsExpiring(sb, URGENT_WINDOW_DAYS)])
  let sent = 0, skipped = 0
  const sentAlerts: Array<Record<string, unknown>> = []

  for (const x of lockUrgent) {
    if (await urgentRecentlySent(sb, 'lock_expiring', x.contact_id)) { skipped++; continue }
    const body = `Urgent: ${x.name}'s rate lock expires ${ptFriendlyDate(x.rate_lock_expiry)} (${x.days_left}d). Contact them today.`
    const send = await sendSmsToLO(body, twilio.sid, twilio.token, twilio.from, twilio.to)
    await logAlert(sb, { alert_type: 'lock_expiring', mode: 'urgent', contact_id: x.contact_id, application_id: x.application_id, alert_payload: body, recipient_phone: twilio.to, twilio_message_sid: send.sid || null, delivery_ok: send.ok, delivery_error: send.error || null })
    if (send.ok) sent++
    sentAlerts.push({ type: 'lock_expiring', name: x.name, days_left: x.days_left, sent: send.ok, error: send.error })
  }

  for (const x of preappUrgent) {
    if (await urgentRecentlySent(sb, 'preapproval_expiring', x.contact_id)) { skipped++; continue }
    const body = `Urgent: ${x.name}'s preapproval expires ${ptFriendlyDate(x.preapproval_expiry)} (${x.days_left}d). Re-issue or extend.`
    const send = await sendSmsToLO(body, twilio.sid, twilio.token, twilio.from, twilio.to)
    await logAlert(sb, { alert_type: 'preapproval_expiring', mode: 'urgent', contact_id: x.contact_id, application_id: x.application_id, alert_payload: body, recipient_phone: twilio.to, twilio_message_sid: send.sid || null, delivery_ok: send.ok, delivery_error: send.error || null })
    if (send.ok) sent++
    sentAlerts.push({ type: 'preapproval_expiring', name: x.name, days_left: x.days_left, sent: send.ok, error: send.error })
  }

  return { sent, skipped, urgent_locks: lockUrgent.length, urgent_preapps: preappUrgent.length, alerts: sentAlerts }
}

// ── HTTP ENTRYPOINT ────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } })
  const url = new URL(req.url)

  /* ── MIGRATION COMPLETE (2026-08-11). x-internal-secret ONLY. ──────────────
   *
   * This function used to authenticate with its own `x-cron-secret`, compared
   * against a vault value, and also accepted the secret as a `?secret=` QUERY
   * PARAMETER — which put a live credential in the URL, where it lands in
   * request logs and in net._http_response rows. Both are gone.
   *
   * Why move at all, when the old guard worked: this project had three
   * cron-secret conventions — x-cron-secret, x-cron-key, x-internal-secret —
   * and that is how the CRON_KEY rotation missed three workflows. A rotation is
   * only as reliable as the number of places you have to remember.
   *
   * Done in five steps so there was never a window where the only caller was
   * refused. The function and its cron jobs cannot change atomically: a deploy
   * takes ~30s and pg_cron lives in the database, so guarding first breaks jobs
   * 20/21 until they are re-headered, and re-headering first breaks them until
   * the deploy lands. An intermediate deploy accepting BOTH removed the window:
   *
   *   1. deploy dual-accept            ✅ behaviour-neutral
   *   2. prove legacy still works      ✅ 386489, 200 dry_run
   *   3. re-header jobs 20 and 21      ✅ url/schedule verified vs snapshot
   *   4. prove the new path works      ✅ 386679, job 21's own 00:00Z run,
   *                                       200 {"mode":"urgent","sent":0,…}
   *   5. delete the legacy branch      ✅ this commit
   *
   * FAILS CLOSED: no header, wrong secret, and an unreadable internal secret are
   * all refusals. Nothing here can pass because a value is absent — the trap
   * voe-inbound-poll fell into, where `if (POLL_SECRET)` turned a missing secret
   * into no check at all. */
  const auth = await requireStaff(req, { allowInternal: true, what: 'Running proactive follow-ups' })
  if (!auth.ok) {
    console.error('[proactive-followups] REJECTED:', auth.status, auth.msg)
    return new Response(JSON.stringify({ error: 'Forbidden — missing or invalid credentials' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
  }

  const mode = (url.searchParams.get('mode') || 'digest').toLowerCase()
  const force = url.searchParams.get('force') === 'true'
  const dryRun = url.searchParams.get('dry_run') === 'true'

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const twilio = {
    sid: Deno.env.get('TWILIO_ACCOUNT_SID') || '',
    token: Deno.env.get('TWILIO_AUTH_TOKEN') || '',
    from: Deno.env.get('SMS_ASSISTANT_FROM_NUMBER') || Deno.env.get('TWILIO_PHONE_NUMBER') || '',
    to: (Deno.env.get('AUTHORIZED_PHONES') || '').split(',')[0]?.trim() || '',
  }
  if (!dryRun && (!twilio.sid || !twilio.token || !twilio.from || !twilio.to)) {
    return new Response(JSON.stringify({ error: 'Missing Twilio config', twilio_config_present: { sid: !!twilio.sid, token: !!twilio.token, from: !!twilio.from, to: !!twilio.to } }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  // Dry-run path: gather what WOULD be alerted, but don't send / don't log
  if (dryRun) {
    const [stale, preapp, credit, lock] = await Promise.all([
      getStaleLeads(sb), getPreapprovalsExpiring(sb, PREAPPROVAL_WARN_DAYS), getCreditAging(sb), getLocksExpiring(sb, LOCK_WARN_DAYS),
    ])
    const body = composeDigest(stale, preapp, credit, lock)
    return new Response(JSON.stringify({ mode: 'dry_run', would_send: !!body, body, counts: { stale: stale.length, preapp: preapp.length, credit: credit.length, lock: lock.length }, stale, preapp, credit, lock }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  let result
  try {
    if (mode === 'urgent') result = await runUrgent(sb, twilio)
    else result = await runDigest(sb, twilio, force)
  } catch (err) {
    return new Response(JSON.stringify({ mode, error: (err as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  return new Response(JSON.stringify({ mode, ...result, sent_at: new Date().toISOString() }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } })
})

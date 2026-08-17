// quote-reply-poll — ONE poller for HOI quote replies and VOE replies.
//
// WHY ONE AND NOT TWO. The correlation is identical for both; only the target
// table differs. Two pollers would mean two idempotency answers that can
// disagree about whether a reply was already handled, and two Gmail sweeps for
// the same messages. Sharing gives one sweep and one key.
//
// THE LADDER lives in the quote_reply_match() SQL function, strongest first:
//   1. In-Reply-To / References -> rfc_message_id    PRIMARY
//   2. hoi_/voe_ token in the addressing or body     secondary
//   3. sender address, ONLY when it names exactly one row
// Rung 3 returns NOTHING when the address is on more than one row. Every HOI
// agent address currently in the table is on two borrowers, so that refusal is
// the common case, not an edge one. See quote_reply_match for why guessing there
// would be worse than not matching.
//
// EVERY message considered gets a quote_reply_log row, matched or not. A table
// holding only successes cannot answer "is correlation working?" — a dead ladder
// and a quiet mailbox look identical in it, which is precisely how VOE's token
// rung stayed dead for its whole existence with nothing to notice.
//
// Idempotent on gmail_message_id (UNIQUE + ON CONFLICT DO NOTHING), so re-polling
// a window is a no-op rather than a duplicate.
//
// This function CORRELATES AND RECORDS. It deliberately does not advance order
// status, write contact notes, or mutate the quote row — those are product
// decisions, and a poller that silently edits borrower records on a guess is the
// failure the ladder above exists to prevent.
//
// Body opts: { dry_run?: bool, lookback_days?: int (default 14),
//              max_messages?: int (default 60), mailboxes?: string[] }
// Deployed verify_jwt=false (project cron convention); the real gate is
// requireStaff({allowInternal, roles:['admin']}) — x-internal-secret via the
// vault, or an admin session.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { gmailApi } from '../_shared/gmail-dwd.ts'
import { requireStaff } from '../_shared/require-staff.ts'
import { isOurAddress } from '../_shared/identity.ts'
import { attachmentsOf } from '../_shared/gmail-attachments.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const PROCESSING = 'processing@ratesandrealty.com'
const RENE = 'rene@ratesandrealty.com'

/* Both mailboxes are swept. New sends all carry reply_to: processing+<token>@,
   but VOE requests sent before the cutover carry reply_to: rene@ and HR will
   answer there. Dropping rene@ would silently stop matching those. */
const DEFAULT_MAILBOXES = [PROCESSING, RENE]

/* Mailboxes this function may SWEEP. Deliberately NOT OUR_ADDRESSES, which is
   broader and includes personal gmail accounts: those are not Workspace mailboxes,
   DWD cannot impersonate them, and accepting one from the request body would be a
   request to go read an account we do not host. "Is this ours?" and "may we open
   it?" are different questions and this file needs both, separately. */
const POLLABLE = new Set([RENE, PROCESSING])

const J = { 'Content-Type': 'application/json' }

function svcHeaders() {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }
}
function ok(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: J }) }
function err(m: string, s = 400) { return new Response(JSON.stringify({ ok: false, error: m }), { status: s, headers: J }) }

function hdr(headers: any[], name: string): string {
  if (!Array.isArray(headers)) return ''
  const h = headers.find((x) => String(x.name || '').toLowerCase() === name.toLowerCase())
  return h ? String(h.value || '') : ''
}

// "Name <a@b.com>" -> "a@b.com"; a bare address passes through.
function parseEmail(raw: string): string {
  const m = String(raw || '').match(/<([^>]+)>/)
  return (m ? m[1] : String(raw || '')).trim().toLowerCase()
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: J })

  /* Gate. verify_jwt=false is the cron convention and is NOT what protects this:
     the anon key is a project-signed JWT printed in every page, so true would not
     have closed it either.

     requireStaff({allowInternal}) rather than a fresh x-cron-key of its own. This
     project had THREE cron-secret conventions — x-cron-secret, x-cron-key,
     x-internal-secret — and that spread is exactly how the CRON_KEY rotation
     missed three workflows: a rotation is only as reliable as the number of
     places somebody has to remember. x-internal-secret is the one that survived,
     validated against the vault, and a fourth convention here would re-open the
     problem that consolidation closed.

     roles:['admin'] is explicit because requireStaff DEFAULTS OPEN relative to
     admin — its default STAFF_ROLES admits va, agent and loa. */
  const gate = await requireStaff(req, { allowInternal: true, roles: ['admin'], what: 'quote-reply-poll' })
  if (!gate.ok) return err(gate.msg || 'forbidden', gate.status || 403)

  const body = await req.json().catch(() => ({} as any))
  const dryRun = !!body.dry_run
  const lookbackDays = Math.max(1, Math.min(90, Number(body.lookback_days) || 14))
  const maxMessages = Math.max(1, Math.min(200, Number(body.max_messages) || 60))
  const mailboxes: string[] = Array.isArray(body.mailboxes) && body.mailboxes.length
    ? body.mailboxes.map((m: unknown) => String(m).toLowerCase().trim())
    : DEFAULT_MAILBOXES

  for (const mb of mailboxes) {
    if (!POLLABLE.has(mb)) return err(`refusing to poll a mailbox that is not ours: ${mb}`, 400)
  }

  const results: any[] = []
  const counts: Record<string, number> = {
    considered: 0, skipped_self: 0, recorded: 0, duplicate: 0,
    in_reply_to: 0, token: 0, address_unique: 0, ambiguous_address: 0, unmatched: 0,
  }

  for (const mailbox of mailboxes) {
    let listed: any
    try {
      const q = encodeURIComponent(`newer_than:${lookbackDays}d`)
      const lr = await gmailApi(mailbox, `messages?q=${q}&maxResults=${maxMessages}`)
      if (!lr.ok) {
        results.push({ mailbox, error: `list failed: ${lr.status}` })
        continue
      }
      listed = await lr.json()
    } catch (e) {
      results.push({ mailbox, error: `list threw: ${String((e as Error)?.message || e)}` })
      continue
    }

    const ids: string[] = (listed.messages || []).map((m: any) => m.id)
    for (const id of ids) {
      const mr = await gmailApi(mailbox, `messages/${id}?format=full`)
      if (!mr.ok) continue
      const msg = await mr.json()
      const H = msg.payload && msg.payload.headers

      const fromEmail = parseEmail(hdr(H, 'From'))
      counts.considered++

      // Our own outbound and CC copies are not replies.
      /* Our own outbound and the CC HOI sends to processing@ land in these
         mailboxes too, and a message From: us is never a reply TO us. Uses the
         WIDER shared list, not POLLABLE: a reply forwarded from either personal
         gmail is still us. */
      if (isOurAddress(fromEmail)) { counts.skipped_self++; continue }

      /* Delivered-To is included with To/Cc because that is where the
         plus-address actually survives: Gmail rewrites To on delivery in some
         paths, and the token rung reads whatever we hand it. */
      const toHay = [hdr(H, 'To'), hdr(H, 'Delivered-To'), hdr(H, 'X-Original-To')]
        .filter(Boolean).join(' ')
      const inReplyTo = hdr(H, 'In-Reply-To')
      const references = hdr(H, 'References')
      const subject = hdr(H, 'Subject')
      const snippet = String(msg.snippet || '')

      const mrsp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/quote_reply_match`, {
        method: 'POST',
        headers: svcHeaders(),
        body: JSON.stringify({
          p_in_reply_to: inReplyTo || null,
          p_references: references || null,
          p_from_email: fromEmail || null,
          p_to_email: toHay || null,
          p_cc_email: hdr(H, 'Cc') || null,
          p_subject: subject || null,
          p_body: snippet || null,
        }),
      })
      if (!mrsp.ok) {
        results.push({ mailbox, gmail_message_id: id, error: `match failed: ${await mrsp.text()}` })
        continue
      }
      const match = await mrsp.json()
      const matchedBy = String(match?.matched_by || 'unmatched')
      counts[matchedBy] = (counts[matchedBy] || 0) + 1

      const row = {
        gmail_message_id: id,
        gmail_thread_id: msg.threadId || null,
        mailbox,
        from_email: fromEmail || null,
        to_email: toHay || null,
        subject: subject || null,
        snippet: snippet.slice(0, 500) || null,
        in_reply_to: inReplyTo || null,
        kind: match?.kind || null,
        row_id: match?.row_id || null,
        contact_id: match?.contact_id || null,
        reply_token: match?.reply_token || null,
        matched_by: matchedBy,
        received_at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
        /* METADATA ONLY, from the format=full message already in hand. Discarding
           it here would cost a Gmail round trip PER MESSAGE the first time anyone
           asks what arrived — the tree is fetched either way, so not recording it
           buys nothing and forecloses the question.
           Never bodies: attachmentId is the handle that fetches bytes on demand,
           and a correlation log is not a document store. Same shape and same
           extractor as email_log.attachments, which is what makes "is this our
           own form returned on reply-all" a comparison rather than a guess. */
        attachments: attachmentsOf(msg),
      }

      /* A dry run computes everything and writes NOTHING, so the correlation can
         be evaluated without consuming the idempotency key. Recording a dry run
         would make the next real poll skip the message as already seen — testing
         the poller would blind it, which is the trap no_alert=1 exists to avoid
         in gdrive-health-monitor. */
      if (dryRun) {
        results.push({ ...row, would_record: true })
        continue
      }

      /* on_conflict=gmail_message_id is REQUIRED, not decoration. Without it
         PostgREST applies resolution=ignore-duplicates to the PRIMARY KEY, and
         id defaults to a fresh uuid every call — so there is never a PK conflict
         to ignore, the insert proceeds, and it dies on the UNIQUE index instead.
         Measured before the fix: a re-poll of five already-recorded messages
         reported recorded:0 duplicate:0, because every one of them took the
         error branch. The table stayed correct — the constraint held — but the
         poller was erroring where it believed it was no-oping, which is the
         worse failure of the two: idempotency that works by accident. */
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/quote_reply_log?on_conflict=gmail_message_id`, {
        method: 'POST',
        headers: { ...svcHeaders(), Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify(row),
      })
      const insBody = await ins.json().catch(() => null)
      if (!ins.ok) {
        results.push({ ...row, error: `insert failed: ${JSON.stringify(insBody)}` })
        continue
      }
      // ignore-duplicates returns an EMPTY array when the row was already there.
      const wasNew = Array.isArray(insBody) && insBody.length > 0
      if (wasNew) counts.recorded++; else counts.duplicate++
      results.push({ ...row, recorded: wasNew })
    }
  }

  return ok({ ok: true, dry_run: dryRun, lookback_days: lookbackDays, mailboxes, counts, results })
})

// TEMPORARY — proof fixture for quote-reply-poll. DELETE AFTER USE.
//
// Inserts a raw RFC822 message into one of OUR OWN mailboxes so the poller can be
// exercised against messages whose From, In-Reply-To and To we control exactly.
//
// WHY THIS EXISTS. quote-reply-poll skips messages sent from our own addresses —
// correctly, since our outbound and CC copies land in the same mailboxes and are
// not replies to us. Every mail account reachable from this session IS one of
// ours (the Gmail tool authenticates as rene@), so a genuine "insurance agent
// replies" message cannot be produced here at all. Crafting the message is the
// only way to exercise the real path: Gmail list -> fetch -> headers -> match ->
// record. It also gives exact control over In-Reply-To, which the stripped-header
// and break-it proofs need and a real reply cannot provide on demand.
//
// WHAT IT THEREFORE DOES NOT PROVE: that a third-party MTA delivers to us. The
// deliverability gate was settled separately (SPF includes _spf.google.com,
// Workspace DKIM published, MX on Google).
//
// Touches nothing but our own mailbox: no borrower record, no Drive folder, no
// contact, no SMS.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { gmailApi } from '../_shared/gmail-dwd.ts'
import { requireStaff } from '../_shared/require-staff.ts'

const J = { 'Content-Type': 'application/json' }
const OURS = new Set(['rene@ratesandrealty.com', 'processing@ratesandrealty.com'])

function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

serve(async (req) => {
  // Same single convention as everything else: x-internal-secret via the vault,
  // or an admin session. Never a fourth cron-secret name.
  const gate = await requireStaff(req, { allowInternal: true, roles: ['admin'], what: 'zztest-mailbox-insert' })
  if (!gate.ok) {
    return new Response(JSON.stringify({ error: gate.msg || 'forbidden' }), { status: gate.status || 403, headers: J })
  }

  const b = await req.json().catch(() => ({} as any))
  const mailbox = String(b.mailbox || '').toLowerCase().trim()
  // Refuses any mailbox but ours, so this cannot be pointed at a real person.
  if (!OURS.has(mailbox)) {
    return new Response(JSON.stringify({ error: 'mailbox must be one of ours' }), { status: 400, headers: J })
  }

  const lines: string[] = []
  lines.push(`From: ${String(b.from || 'zz-test@example.org')}`)
  lines.push(`To: ${String(b.to || mailbox)}`)
  if (b.delivered_to) lines.push(`Delivered-To: ${String(b.delivered_to)}`)
  lines.push(`Subject: ${String(b.subject || 'ZZ-TEST reply')}`)
  if (b.in_reply_to) lines.push(`In-Reply-To: ${String(b.in_reply_to)}`)
  if (b.references) lines.push(`References: ${String(b.references)}`)
  lines.push(`Message-ID: <zztest-${crypto.randomUUID()}@example.org>`)
  lines.push('MIME-Version: 1.0')
  lines.push('Content-Type: text/plain; charset="UTF-8"')
  lines.push('')
  lines.push(String(b.body || 'ZZ-TEST fixture body.'))

  const raw = b64url(lines.join('\r\n'))

  /* import, not insert: import runs the message through normal delivery
     classification so it lands the way a received message would, which is what
     the poller reads. neverMarkSpam keeps a synthetic sender out of Spam, where
     the poller's query would not see it and the proof would fail for a reason
     that has nothing to do with correlation. */
  const r = await gmailApi(
    mailbox,
    'messages/import?internalDateSource=dateHeader&neverMarkSpam=true',
    { method: 'POST', body: JSON.stringify({ raw, labelIds: ['INBOX'] }) },
  )
  const j = await r.json().catch(() => null)
  return new Response(JSON.stringify({ ok: r.ok, status: r.status, result: j }), {
    status: r.ok ? 200 : 502, headers: J,
  })
})

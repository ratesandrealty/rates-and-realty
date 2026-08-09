// gmail-inbox — CRM live inbox backend over Gmail Domain-Wide Delegation.
//
// Architecture C: the inbox is LIVE from Gmail. INBOUND is persisted to email_log only when
// the thread is tagged to a borrower or a participant matches a known contact/vendor — that
// keeps newsletters and rate-sheet blasts out of the record.
//
// OUTBOUND IS ALWAYS PERSISTED. Mail sent from the CRM was sent deliberately by a human, so
// it is a business record even when nobody on it matches a contact. Unmatched sends are
// logged with contact_id = null (logged, just unfiled) rather than dropped.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 SECURITY BOUNDARY (enforced in resolveMailbox, before any Gmail call):
// The `mailbox` request param is NEVER trusted. The caller's identity comes from
// their verified Supabase JWT; their role comes from auth_user_roles (same source
// as current_app_role()). Mailbox access is then hard-gated by role:
//    admin -> rene@ OR processing@
//    va    -> processing@ ONLY   (a VA requesting rene@ is REJECTED 403)
//    else  -> 403
// rene@ holds 160k+ personal messages; a VA reaching it would be a serious breach.
// ─────────────────────────────────────────────────────────────────────────────
//
// Actions: list_threads, get_thread, send, modify, tag, untag, label_counts,
//          list_drafts, get_draft, delete_draft.
// verify_jwt: true (pinned in config.toml) — the gateway rejects unauthenticated calls.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { gmailApi } from '../_shared/gmail-dwd.ts'
// MIME building lives in _shared/mime.ts so its boundary nesting can be unit-tested
// (nothing in this file is importable — it calls serve() at module load).
import {
  buildMime, b64url, utf8ToB64, htmlToText, safeMime,
  type OutAttachment,
} from '../_shared/mime.ts'
// The attachment download below runs as the service role and bypasses storage RLS, so
// this predicate is the actual authorization control. Kept in _shared to be testable.
import { attachmentPathError } from '../_shared/attach.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const RENE = 'rene@ratesandrealty.com'
const PROCESSING = 'processing@ratesandrealty.com'
const SELF = new Set([RENE, PROCESSING])

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const J = { ...cors, 'Content-Type': 'application/json' }

// ── Security: which mailboxes may a given role touch? ──
function allowedMailboxes(role: string): string[] {
  if (role === 'admin') return [RENE, PROCESSING]
  if (role === 'va') return [PROCESSING]
  return [] // loa/agent/staff/none → no Gmail mailbox access
}

// ── Gmail header/body parsing ──
function hdr(headers: any[], name: string): string | null {
  const h = (headers || []).find((x: any) => (x.name || '').toLowerCase() === name.toLowerCase())
  return h ? h.value : null
}
function parseEmail(v: string | null): string | null {
  if (!v) return null
  const m = v.match(/<([^>]+)>/)
  return (m ? m[1] : v).trim().toLowerCase()
}
function parseName(v: string | null): string | null {
  if (!v) return null
  const m = v.match(/^\s*"?([^"<]*?)"?\s*</)
  return m && m[1].trim() ? m[1].trim() : null
}
function splitAddrs(v: string | null): string[] {
  if (!v) return []
  return v.split(',').map((s) => parseEmail(s)).filter((x): x is string => !!x)
}
/* Gmail returns `snippet` ALREADY HTML-entity-encoded ("That&#39;s great news!"). The
 * client then esc()s it for safe rendering, which double-encodes it and shows the raw
 * entity to the user. Decode once here, at the boundary where the encoded form arrives,
 * so every consumer holds plain text and the client's esc() is correct on its own.
 * Subject/From headers are NOT entity-encoded by Gmail and must not be touched. */
function decodeEntities(s: string | null | undefined): string {
  if (!s) return ''
  return String(s)
    .replace(/&#(\d+);/g, (_m, d) => { try { return String.fromCodePoint(Number(d)) } catch { return _m } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hx) => { try { return String.fromCodePoint(parseInt(hx, 16)) } catch { return _m } })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    // &amp; LAST, or "&amp;lt;" would decode all the way to "<".
    .replace(/&amp;/g, '&')
}

function b64urlDecode(data: string): string {
  try {
    const b = data.replace(/-/g, '+').replace(/_/g, '/')
    const pad = b.length % 4 ? '='.repeat(4 - (b.length % 4)) : ''
    const bin = atob(b + pad)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8').decode(bytes)
  } catch { return '' }
}
/* Takes the LARGEST text/html and text/plain part, not the first.
 *
 * "First wins" is wrong on nested mail and it was actively breaking two things.
 * On thread 19fb8d82 the first text/html encountered is a 476-byte fragment, so
 * that is what the reading pane rendered — a truncated body — AND it is what the
 * inline-image test below was handed, which left it with no cid: references to
 * match and produced phantom attachments. The real body was further down the
 * tree. Largest-wins is a crude heuristic but it is right in every case here:
 * the substantive body is never the smallest candidate. */
function walk(part: any, acc: { text: string; html: string }) {
  if (!part) return
  const mt = (part.mimeType || '').toLowerCase()
  const d = part.body && part.body.data
  if (mt === 'text/plain' && d) {
    const t = b64urlDecode(d)
    if (t.length > acc.text.length) acc.text = t
  } else if (mt === 'text/html' && d) {
    const h = b64urlDecode(d)
    if (h.length > acc.html.length) acc.html = h
  }
  if (Array.isArray(part.parts)) for (const p of part.parts) walk(p, acc)
}
/* Recursive, because real mail nests: multipart/mixed wrapping a
 * multipart/alternative, with attachments as siblings at whatever depth the
 * sending client chose. Content-ID and Content-Disposition come along because
 * they are the only way to tell a real attachment from an inline image. */
function collectAttachments(part: any, out: any[]) {
  if (!part) return
  if (part.filename && part.body && part.body.attachmentId) {
    const h = part.headers || []
    const cid = (hdr(h, 'Content-ID') || '').replace(/^<|>$/g, '').trim()
    const disp = (hdr(h, 'Content-Disposition') || '').trim().toLowerCase()
    out.push({
      filename: part.filename,
      mimeType: part.mimeType || null,
      size: part.body.size || null,
      attachmentId: part.body.attachmentId,
      partId: part.partId || null,
      contentId: cid || null,
      disposition: disp ? disp.split(';')[0] : null,
    })
  }
  if (Array.isArray(part.parts)) for (const p of part.parts) collectAttachments(p, out)
}

/* One classifier for attachment type, so the list icon and the chip icon in the
 * thread view cannot drift apart. Extension is checked as well as MIME because
 * senders mislabel: the eLEND threads carry files named *.html with a PDF-ish
 * intent, and DMARC reports arrive as application/gzip named *.xml.gz. */
function attKind(mime: string | null, name: string | null): string {
  const t = String(mime || '').toLowerCase()
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,6})$/)
  const e = m ? m[1].toLowerCase() : ''
  if (t.includes('pdf') || e === 'pdf') return 'pdf'
  if (t.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic'].includes(e)) return 'image'
  if (t.includes('spreadsheet') || t.includes('excel') || ['xls', 'xlsx', 'csv'].includes(e)) return 'sheet'
  if (t.includes('word') || t.includes('opendocument.text') || ['doc', 'docx', 'rtf', 'odt'].includes(e)) return 'doc'
  if (t.includes('zip') || t.includes('gzip') || t.includes('compressed') || ['zip', 'gz', 'rar', '7z'].includes(e)) return 'archive'
  if (t.includes('calendar') || e === 'ics') return 'calendar'
  return 'other'
}

/* INLINE IMAGES ARE NOT ATTACHMENTS.
 *
 * Rene's signature carries five images. Each is a real MIME part with a filename
 * and an attachmentId, so a naive "has filename" test reports five attachments on
 * every reply he has ever sent. They are not attachments — they are pixels the
 * HTML already draws, referenced as src="cid:...".
 *
 * CONTENT-DISPOSITION IS IGNORED ENTIRELY. It is wrong in BOTH directions, and
 * both directions were measured on real mail in this mailbox:
 *
 *   disposition says "attachment" but the part is inline —
 *     thread 19fb05c5, Gmail's own signature images:
 *       image003.png · Content-ID ii_19fb05c5c3b7605c1153
 *       Content-Disposition: attachment
 *     …while the 52KB body HTML draws every one as src="cid:ii_19fb05c5…".
 *     Trusting the header showed 10 phantom attachments per reply.
 *
 *   disposition says "inline" but the part is a real attachment —
 *     thread 19fb55c5 ("RRR" from Giselle Tovar), the PDF Rene could not see:
 *       Request_for_Repair__1___6_26.pdf · application/pdf · 406,347 bytes
 *       Content-ID: NONE
 *       Content-Disposition: inline; filename=Request_for_Repair__1___6_26.pdf
 *     The message has no HTML part at all, so nothing could possibly reference
 *     it inline. Trusting the header hid a document a borrower actually sent.
 *
 * Gmail's composer marks a previewable attachment `inline`, and marks embedded
 * signature images `attachment`. The header describes intent to render, not
 * whether something is an attachment, so it decides nothing here.
 *
 * ONE rule, from the only reliable signal — is the markup already drawing it?
 *   1. Content-ID present AND referenced as cid: in the body → inline, drop.
 *   2. otherwise a filename means a real attachment → keep.
 *
 * Rule 1 depends on holding the REAL body HTML, which is why walk() takes the
 * largest text/html part rather than the first — with a truncated body there are
 * no cid: references to find and the rule silently stops working. */
function filterRealAttachments(atts: any[], html: string): any[] {
  const body = String(html || '')
  /* A stricter variant was tried and REVERTED: "a Content-ID plus a body with no
   * cid: reference anywhere ⇒ inline". It cleaned up the last three phantoms
   * (thread 19fb8d82, whose 476-byte body references nothing), but it also hid a
   * genuine DMARC report — enterprise.protection.outlook.com!….xml.gz, a real
   * attachment carrying a Content-ID in a message with no cid: markup. Hiding a
   * real attachment recreates the exact bug this work exists to fix, and a few
   * spurious chips on one vendor's footer does not. So the looser rule stands
   * and those three logos are accepted as noise. */
  return atts.filter((a) => {
    if (!a.filename) return false
    if (a.contentId) {
      const id = a.contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp('cid:' + id, 'i').test(body)) return false
    }
    return true
  })
}

// Gmail message → email_log row shape (plus a non-column `participants` for matching).
function messageToRow(mailbox: string, threadId: string, msg: any) {
  const headers = msg.payload && msg.payload.headers
  const fromRaw = hdr(headers, 'From')
  const fromEmail = parseEmail(fromRaw)
  const toEmails = splitAddrs(hdr(headers, 'To'))
  const ccRaw = hdr(headers, 'Cc')
  const acc = { text: '', html: '' }
  walk(msg.payload, acc)
  const attsRaw: any[] = []
  collectAttachments(msg.payload, attsRaw)
  // Inline signature images are dropped here, against the HTML that will render.
  const atts = filterRealAttachments(attsRaw, acc.html)
  const dir = fromEmail === mailbox.toLowerCase() ? 'outbound' : 'inbound'
  const iso = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null
  return {
    gmail_message_id: msg.id,
    gmail_thread_id: threadId || msg.threadId,
    direction: dir,
    mailbox,
    from_email: fromEmail,
    from_name: parseName(fromRaw),
    to_email: toEmails[0] || null,
    to_emails: toEmails.length ? toEmails : null,
    to_name: null,
    cc_email: ccRaw || null,
    subject: hdr(headers, 'Subject'),
    body_html: acc.html || null,
    body_text: acc.text || (msg.snippet ? decodeEntities(msg.snippet) : null),
    attachments: atts.length ? atts : null,
    status: dir === 'inbound' ? 'received' : 'sent',
    created_at: iso,
    sent_at: dir === 'outbound' ? iso : null,
    participants: [fromEmail, ...toEmails, ...splitAddrs(ccRaw)].filter(Boolean),
  }
}

// Idempotent persist — race-safe. The UNIQUE INDEX on email_log(gmail_message_id) is the
// arbiter; ON CONFLICT DO NOTHING (ignoreDuplicates) skips already-ingested messages atomically
// in the DB, so concurrent polls/tags can't create duplicates. .select() returns ONLY the rows
// actually inserted, so its length is the true inserted count.
/* actorUid is the SEND path's caller and nothing else.
 *
 * This one funnel serves both syncing and sending. Stamping the caller on a
 * SYNC would be actively false: a synced row can be an inbound borrower email,
 * or a reply typed directly in Gmail — in neither case is the person who
 * happened to trigger the sync its author. So the two sync call sites pass
 * null and only the send site passes a uid, which is why this is an argument
 * rather than something read from the request in here.
 *
 * email_log had NO identity column at all before 2026-08-05 — not unpopulated,
 * absent — across 460 rows. See the column comment for what null means; it is
 * ambiguous by nature and must not be read as "nobody sent it". */
async function persistMessages(svc: any, rows: any[], contactId: string | null, actorUid: string | null = null) {
  if (!rows.length) return { inserted: 0, skipped: 0 }
  const payload = rows.map((r) => {
    const { participants: _p, ...row } = r
    if (contactId) (row as any).contact_id = contactId
    if (actorUid) (row as any).actor_user_id = actorUid
    return row
  })
  const { data, error } = await svc.from('email_log')
    .upsert(payload, { onConflict: 'gmail_message_id', ignoreDuplicates: true })
    .select('gmail_message_id')
  if (error) throw new Error('persist upsert: ' + error.message)
  const inserted = (data || []).length
  return { inserted, skipped: rows.length - inserted }
}

// MATCH: first participant email that resolves to a contact (direct) or a vendor
// (→ borrower via that vendor's most recent loan_order) wins.
async function matchContact(svc: any, emails: string[]) {
  const uniq = [...new Set(emails.map((e) => (e || '').toLowerCase()).filter((e) => e && !SELF.has(e)))]
  for (const e of uniq) {
    const { data: c } = await svc.from('contacts').select('id').or(`email.ilike.${e},secondary_email.ilike.${e}`).limit(1)
    if (c && c.length) return { contact_id: c[0].id, matched_by: 'contact', email: e }
  }
  for (const e of uniq) {
    const { data: v } = await svc.from('vendor_directory').select('id').ilike('email', e).limit(1)
    if (v && v.length) {
      const { data: o } = await svc.from('loan_orders').select('borrower_contact_id,contact_id').eq('vendor_id', v[0].id).order('ordered_at', { ascending: false }).limit(1)
      if (o && o.length) {
        const cid = o[0].borrower_contact_id || o[0].contact_id
        if (cid) return { contact_id: cid, matched_by: 'vendor', email: e }
      }
    }
  }
  return { contact_id: null, matched_by: 'none' }
}

// (MIME helpers now live in ../_shared/mime.ts — see the import above.)

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const ok = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: J })
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: J })

  // 1) Identity — verify the Supabase JWT (never trust the client for who they are).
  const authHeader = req.headers.get('Authorization') || ''
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!jwt) return err('Missing Authorization header', 401)
  const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  const { data: userData, error: authErr } = await svc.auth.getUser(jwt)
  if (authErr || !userData?.user) return err('Invalid or expired session', 401)
  const uid = userData.user.id

  // 2) Role — from auth_user_roles (same source as current_app_role()).
  const { data: roleRow } = await svc.from('auth_user_roles').select('role').eq('user_id', uid).limit(1)
  const role = (roleRow && roleRow.length ? roleRow[0].role : 'none') as string

  // 3) Parse request + enforce the mailbox boundary BEFORE any Gmail call.
  const body = await req.json().catch(() => ({} as any))
  const action = String(body.action || '')
  const requested = String(body.mailbox || '').toLowerCase().trim()
  if (!requested) return err('mailbox required', 400)
  const allowed = allowedMailboxes(role)
  if (!allowed.includes(requested)) {
    return err(`forbidden: role '${role}' may not access ${requested}`, 403)
  }
  const mailbox = requested // server-validated; safe to impersonate

  // Per-user client for the tag RPCs (so auth.uid()/current_app_role() resolve + tagged_by is recorded).
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } })

  try {
    /* Unread badges for the left rail. labels.list does NOT carry counts — only
     * labels.get does — so this is one call per label, issued in parallel and once per
     * mailbox load rather than per render. "Archived" is deliberately absent: it is not
     * a Gmail label but a search expression, so it has no count to read. */
    if (action === 'label_counts') {
      /* CATEGORY_* included so the rail's category group can show unread badges.
       * Caveat worth knowing when reading them: Gmail's category counters span the
       * WHOLE mailbox, while the list under them is INBOX ∧ CATEGORY_x — so a
       * category holding archived unread mail reads a little high. A label that
       * does not exist (categories are absent when Gmail's tabbed inbox is off)
       * simply fails its fetch and is omitted, which renders no badge. */
      const ids = [
        'INBOX', 'SENT', 'DRAFT', 'STARRED', 'TRASH',
        'CATEGORY_PERSONAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES',
        'CATEGORY_SOCIAL', 'CATEGORY_FORUMS',
      ]
      const counts: Record<string, { unread: number; total: number }> = {}
      await Promise.all(ids.map(async (id) => {
        const r = await gmailApi(mailbox, `labels/${id}`)
        if (!r.ok) return
        const j = await r.json()
        counts[id] = {
          unread: Number(j.threadsUnread || 0),
          total: Number(j.threadsTotal || 0),
        }
      }))
      return ok({ counts })
    }

    /* ── INBOUND ATTACHMENT DOWNLOAD ──────────────────────────────────────────
     * The SAME confused-deputy shape _shared/attach.ts guards on the send side,
     * pointing the other way. There, a client names a storage path and the server
     * fetches it with the service role. Here, a client names a Gmail messageId
     * and the server fetches it with an IMPERSONATED MAILBOX. In both cases the
     * caller supplies the identifier and the server supplies the privilege, so
     * the identifier has to be checked against the caller's own boundary before
     * anything is read.
     *
     * `mailbox` is the server-derived one (step 3 above: verified JWT →
     * auth_user_roles → allowedMailboxes), never a value the client sent. Every
     * Gmail call below impersonates THAT mailbox, so a message belonging to
     * rene@ simply does not exist for a va — Gmail answers 404 and we answer 403.
     * The explicit lookup is not redundant with that: it also proves the
     * attachmentId belongs to this message rather than being a bare id lifted
     * from somewhere else, and it yields the size so an oversized part can be
     * refused BEFORE its bytes are pulled.
     *
     * Bytes are fetched ONLY here, on an explicit click — never while rendering
     * a thread. Gmail hands back base64url, so a 25MB file is ~33MB of JSON;
     * pulling every attachment of every message on open would be an OOM waiting
     * to happen. */
    if (action === 'get_attachment') {
      const messageId = String(body.message_id || '').trim()
      const attachmentId = String(body.attachment_id || '').trim()
      if (!messageId || !attachmentId) return err('message_id and attachment_id required', 400)

      // 1. Ownership + membership, in the caller's own mailbox.
      const mr = await gmailApi(mailbox, `messages/${encodeURIComponent(messageId)}?format=full`)
      if (!mr.ok) {
        return err(`forbidden: message not in ${mailbox}`, 403)
      }
      const mj = await mr.json()
      const parts: any[] = []
      collectAttachments(mj.payload, parts)
      /* Match on partId FIRST. Gmail's attachmentId is not stable across
       * responses — the id handed out with threads.get can be rejected by
       * messages.attachments.get minutes later, which is exactly what happened
       * in testing (403 "not part of that message" for an attachment plainly on
       * that message). partId addresses the position in the MIME tree and does
       * not drift, so the client sends that and the server resolves a FRESH
       * attachmentId from its own read. Ownership is unaffected: this lookup
       * runs inside the caller's impersonated mailbox either way. */
      const partId = String(body.part_id || '').trim()
      let part = partId ? parts.find((p) => String(p.partId) === partId) : null
      if (!part) part = parts.find((p) => p.attachmentId === attachmentId)
      if (!part) return err('forbidden: attachment is not part of that message', 403)
      // Always use the id from THIS read, never the client's.
      const freshId = part.attachmentId

      // 2. Cap BEFORE the bytes move. Fail loudly rather than OOM the function.
      const ATT_DOWNLOAD_MAX = 15 * 1024 * 1024
      if (part.size && part.size > ATT_DOWNLOAD_MAX) {
        return err(`attachment is ${(part.size / 1024 / 1024).toFixed(1)}MB — too large to open here (limit ${ATT_DOWNLOAD_MAX / 1024 / 1024}MB). Open it in Gmail.`, 413)
      }

      // 3. Now the bytes.
      const ar = await gmailApi(mailbox, `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(freshId)}`)
      if (!ar.ok) {
        const t = await ar.text()
        console.error('[get_attachment] gmail fetch failed', ar.status, t.slice(0, 200))
        return err('could not read the attachment from Gmail', 502)
      }
      const aj = await ar.json()
      const data = String(aj.data || '')
      // Gmail's own size can disagree with the encoded length; re-check the real one.
      if (data.length > ATT_DOWNLOAD_MAX * 1.4) {
        return err('attachment is too large to open here. Open it in Gmail.', 413)
      }
      return ok({
        filename: part.filename,
        mime_type: part.mimeType || 'application/octet-stream',
        size: aj.size ?? part.size ?? null,
        data_b64url: data,
      })
    }

    if (action === 'list_threads') {
      let path = 'threads?maxResults=25'
      if (body.q) path += `&q=${encodeURIComponent(String(body.q))}`
      // `labels` (array) ANDs multiple system labels — needed for a category tab, which is
      // INBOX + CATEGORY_*. `label` (string) is kept for backward compatibility.
      const labels: string[] = Array.isArray(body.labels)
        ? body.labels.map((l: any) => String(l)).filter(Boolean)
        : (body.label ? [String(body.label)] : [])
      for (const l of labels) path += `&labelIds=${encodeURIComponent(l)}`
      // threads.list hides SPAM and TRASH unless asked; without this the Trash folder is
      // always empty no matter what labelIds say.
      if (body.include_spam_trash) path += '&includeSpamTrash=true'
      if (body.page_token) path += `&pageToken=${encodeURIComponent(String(body.page_token))}`
      const lr = await gmailApi(mailbox, path)
      const lj = await lr.json()
      if (!lr.ok) return err('list failed: ' + JSON.stringify(lj.error || lj), 502)
      const detailed = await Promise.all((lj.threads || []).map(async (t: any) => {
        /* format=full, not metadata. Measured, not assumed: +110ms wall clock per
         * page (415ms vs 305ms for 25 threads) and ZERO additional quota —
         * threads.get bills 10 units whichever format is asked for, so the page
         * still costs 25×10 + 10 = 260 units either way. The extra ~4.3MB is
         * Gmail→function only; this function parses it and returns the same
         * small summary, so the browser payload is unchanged.
         *
         * metadata cannot do this job at all: it returns payload.mimeType and no
         * parts, so it can say "this thread has some non-alternative structure"
         * (47% recall, measured) but never "this is a PDF". Rene asked for a PDF
         * icon; only the parts tree carries MIME types. */
        const mr = await gmailApi(mailbox, `threads/${t.id}?format=full`)
        if (!mr.ok) return { id: t.id, snippet: decodeEntities(t.snippet), subject: null, from: null, date: null, unread: false, message_count: 0 }
        const mj = await mr.json()
        const ms = mj.messages || []
        const first = ms[0]
        const last = ms[ms.length - 1]
        const fromRaw = last ? hdr(last.payload?.headers, 'From') : null
        /* ATTACHMENT HINT AT ZERO API COST.
         *
         * format=metadata does NOT return the parts tree — measured: it yields
         * one node with kids=0, so there is no filename or attachmentId to read.
         * The only options for a truthful per-thread flag would each cost
         * something: a second messages.get per thread (25 extra calls a page),
         * switching this list to format=full (same call count but every message
         * body inlined, so a page balloons from tens of KB to megabytes), or a
         * has:attachment search (+1 call, but Gmail counts inline images so it
         * flags every signature-bearing reply).
         *
         * What metadata DOES return is payload.mimeType, which is already in
         * this response. A message carrying an attachment is multipart/mixed; a
         * body-only message is multipart/alternative or text/*. Measured over 20
         * real INBOX threads: 1 true positive, 19 true negatives, ZERO false
         * positives and ZERO misses.
         *
         * NOT RENDERED. Measured over 38 threads it is 7 TP / 0 FP / 23 TN /
         * 8 FN — reliable when true, but ~47% recall, and a clip whose absence
         * means "unknown" reads to a human as "no attachment". It is computed
         * and returned so the measurement is reproducible and so a decision to
         * switch this list to format=full (which would make it exact) has
         * somewhere to land, but no UI consumes it. */
        /* Real attachment summary, from the same filter the thread view uses —
         * so the list and the opened thread can never disagree. Inline signature
         * images are excluded here exactly as they are there. */
        const attTypes: Record<string, number> = {}
        let attCount = 0
        for (const msg of ms) {
          const raw: any[] = []
          collectAttachments(msg.payload, raw)
          if (!raw.length) continue
          /* Only decode the body when it can actually change the answer.
           * filterRealAttachments consults the HTML solely to test whether a
           * Content-ID is cid:-referenced, so a message whose parts carry NO
           * Content-ID needs no body at all. walk() base64-decodes every
           * text/html part it finds, which on a 25-thread page is the bulk of
           * both the memory and the CPU — and most attachments (every one of
           * the 68 PDFs in processing@, for instance) have no Content-ID. */
          const needsBody = raw.some((a) => !!a.contentId)
          let html = ''
          if (needsBody) {
            const acc = { text: '', html: '' }
            walk(msg.payload, acc)
            html = acc.html
          }
          for (const a of filterRealAttachments(raw, html)) {
            attCount++
            const k = attKind(a.mimeType, a.filename)
            attTypes[k] = (attTypes[k] || 0) + 1
          }
        }
        return {
          id: t.id, snippet: decodeEntities(t.snippet),
          subject: first ? hdr(first.payload?.headers, 'Subject') : null,
          from: { email: parseEmail(fromRaw), name: parseName(fromRaw) },
          date: last?.internalDate ? new Date(Number(last.internalDate)).toISOString() : null,
          unread: ms.some((x: any) => (x.labelIds || []).includes('UNREAD')),
          message_count: ms.length,
          has_attachment: attCount > 0,
          attachment_count: attCount,
          // e.g. { pdf: 2, image: 1 } — the client picks one icon, or a count.
          attachment_types: attCount ? attTypes : null,
        }
      }))
      return ok({ threads: detailed, next_page_token: lj.nextPageToken || null })
    }

    if (action === 'get_thread') {
      const threadId = String(body.thread_id || '')
      if (!threadId) return err('thread_id required')
      const tr = await gmailApi(mailbox, `threads/${threadId}?format=full`)
      const tj = await tr.json()
      if (!tr.ok) return err('get_thread failed: ' + JSON.stringify(tj.error || tj), 502)
      const msgs = tj.messages || []
      const rows = msgs.map((m: any) => messageToRow(mailbox, threadId, m))
      // MATCH → persist only if a participant is a known contact/vendor.
      const participants = [...new Set(rows.flatMap((r: any) => r.participants))] as string[]
      const m = await matchContact(svc, participants)
      let persisted = null
      if (m.contact_id) persisted = await persistMessages(svc, rows, m.contact_id)
      // reply_to / message_id are read straight off the Gmail headers rather than added to
      // `rows` — those objects are spread into the email_log insert and have no such columns.
      const messages = rows.map((r: any, i: number) => {
        const mh = msgs[i]?.payload?.headers
        return {
          id: r.gmail_message_id, direction: r.direction,
          from: { email: r.from_email, name: r.from_name },
          to: r.to_emails || [], cc: splitAddrs(r.cc_email), subject: r.subject,
          // Reply must honor Reply-To (mailing lists, no-reply relays) over From.
          reply_to: parseEmail(hdr(mh, 'Reply-To')),
          message_id: hdr(mh, 'Message-ID'),
          date: r.created_at, body_html: r.body_html, body_text: r.body_text,
          attachments: r.attachments || [], unread: (msgs[i].labelIds || []).includes('UNREAD'),
        }
      })
      return ok({ thread_id: threadId, matched: m, persisted, messages })
    }

    if (action === 'send') {
      const to = String(body.to || '').trim()
      const subject = String(body.subject || '')
      const html = String(body.body_html || '')
      const text = body.body_text ? String(body.body_text) : ''
      const cc = body.cc ? String(body.cc).trim() : ''
      const bcc = body.bcc ? String(body.bcc).trim() : ''
      if (!to || !subject || !html) return err('to, subject, body_html required')

      /* ── REFUSE UNROUTABLE RECIPIENTS ────────────────────────────────────
       *
       * This validated nothing but non-emptiness, and that was a silent failure
       * on borrower mail. contacts_secure masks a lead's address for the va role
       * as `lead-<id8>@masked.local`; that string flows into the composer's TO
       * field, and pressing Send used to produce — measured, not reasoned:
       *
       *   {"ok":true,"message_id":"19fe8917…","persisted":{"inserted":1},"filed_as":null}
       *
       * Gmail accepts the API call and queues it, we log an outbound row, the
       * composer says sent, and the borrower receives nothing. The bounce is
       * asynchronous and nothing here reads it. "Sent" in the CRM was a claim
       * about an API call, not about delivery.
       *
       * .local is reserved for mDNS (RFC 6762) and .invalid/.test/.example/
       * .localhost are reserved by RFC 2606/6761 — none is routable on the
       * public internet, so a message addressed to one can only ever bounce.
       *
       * SERVER-SIDE because it has to be: the masking that produces these
       * addresses is server-side and role-dependent, so the client that renders
       * a masked address is the least able to know it is fake. The composer also
       * refuses to prefill one, but that is a courtesy — this is the control. */
      const UNROUTABLE = /\.(local|localhost|invalid|test|example)$/i
      const allRecipients = [...splitAddrs(to), ...splitAddrs(cc), ...splitAddrs(bcc)]
      const bad = allRecipients.filter((a) => UNROUTABLE.test(String(a).split('@')[1] || ''))
      if (bad.length) {
        console.error(`[gmail-inbox] REFUSED send to unroutable recipient(s): ${bad.join(', ')}`)
        return err(
          `Cannot send: ${bad.join(', ')} is not a real address. ` +
          `Addresses like lead-xxxxxxxx@masked.local are placeholders shown when a lead's ` +
          `email is hidden for your role — mail to them is never delivered. ` +
          `Ask an admin for the real address, or send from an account that can see it.`,
          422,
        )
      }

      const threadId = body.thread_id ? String(body.thread_id) : ''
      let inReplyTo: string | null = body.in_reply_to ? String(body.in_reply_to) : null
      let references: string | null = null
      if (threadId) {
        // Reply in-thread: chain References/In-Reply-To off the thread's last message.
        const tr = await gmailApi(mailbox, `threads/${threadId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`)
        if (tr.ok) {
          const tj = await tr.json()
          const last = (tj.messages || [])[(tj.messages || []).length - 1]
          if (last) {
            const lh = last.payload?.headers
            const mid = hdr(lh, 'Message-ID')
            if (!inReplyTo) inReplyTo = mid
            const refs = hdr(lh, 'References')
            references = `${refs ? refs + ' ' : ''}${mid || ''}`.trim() || null
          }
        }
      }
      /* ── attachments ────────────────────────────────────────────────────────
       * The client uploads to the PRIVATE email-attachments bucket first and sends
       * only storage paths, so a 20MB file never has to survive a base64 JSON body.
       * Bytes are pulled here with the service role. The path is confined to this
       * mailbox's own prefix — a client cannot name someone else's object and have
       * it mailed out. */
      const attIn = Array.isArray(body.attachments) ? body.attachments : []
      const ATT_MAX_TOTAL = 20 * 1024 * 1024
      const outAtts: OutAttachment[] = []
      const attMeta: Array<Record<string, unknown>> = []
      if (attIn.length > 25) return err('Too many attachments (25 max)')
      let attTotal = 0
      for (const a of attIn) {
        /* THE control for this fetch. The download below uses the service role and so
         * bypasses storage RLS completely — attachmentPathError() is what confines the
         * path to the prefix of the mailbox the server derived from the caller's JWT
         * (see step 3 above), not to anything the client claimed. 403, not 400: this is
         * an authorization refusal. */
        const path = String((a && a.path) || '')
        const pathErr = attachmentPathError(path, mailbox)
        if (pathErr) return err(pathErr, pathErr === 'attachment missing path' ? 400 : 403)
        const dl = await svc.storage.from('email-attachments').download(path)
        if (dl.error || !dl.data) {
          return err(`attachment not found in storage: ${String((a && a.name) || path)}`, 404)
        }
        const buf = new Uint8Array(await dl.data.arrayBuffer())
        attTotal += buf.byteLength
        if (attTotal > ATT_MAX_TOTAL) {
          return err(`attachments exceed the 20MB limit (${(attTotal / 1024 / 1024).toFixed(1)}MB)`, 413)
        }
        const name = String((a && a.name) || path.split('/').pop() || 'attachment')
        const mime = safeMime(String((a && a.mime) || dl.data.type || ''))
        outAtts.push({ name, mime, bytes: buf })
        attMeta.push({ name, mime, size: buf.byteLength, bucket: 'email-attachments', path })
      }

      const raw = b64url(utf8ToB64(buildMime({
        from: mailbox, to, cc, bcc, subject, html, text, inReplyTo, references,
        attachments: outAtts,
      })))
      const sendBody: any = { raw }
      if (threadId) sendBody.threadId = threadId
      const sr = await gmailApi(mailbox, 'messages/send', { method: 'POST', body: JSON.stringify(sendBody) })
      const sj = await sr.json()
      if (!sr.ok) return err('send failed: ' + JSON.stringify(sj.error || sj), 502)

      // ── Always log the send. Contact matching decides FILING, never whether we record it. ──
      const resolvedThread = sj.threadId
      let cid: string | null = null
      let matched_by: string | null = null
      const { data: tag } = await svc.from('email_thread_tags').select('contact_id').eq('gmail_thread_id', resolvedThread).limit(1)
      if (tag && tag.length) { cid = tag[0].contact_id; matched_by = 'tag' }
      if (!cid) {
        const m = await matchContact(svc, [...splitAddrs(to), ...splitAddrs(cc)])
        if (m.contact_id) { cid = m.contact_id; matched_by = m.matched_by }
      }

      // Prefer the message Gmail actually stored — real Message-ID headers, true internalDate,
      // final body. If that read fails the mail has still gone out, so fall back to a row built
      // from what we sent rather than losing the record entirely. Both paths carry the same
      // gmail_message_id, and the UNIQUE index on it makes a retry a no-op instead of a dup.
      let row: any
      const gm = await gmailApi(mailbox, `messages/${sj.id}?format=full`)
      if (gm.ok) {
        row = messageToRow(mailbox, resolvedThread, await gm.json())
      } else {
        const nowIso = new Date().toISOString()
        const toList = splitAddrs(to)
        row = {
          gmail_message_id: sj.id,
          gmail_thread_id: resolvedThread,
          direction: 'outbound',
          mailbox,
          from_email: mailbox,
          from_name: null,
          to_email: toList[0] || null,
          to_emails: toList.length ? toList : null,
          to_name: null,
          cc_email: cc || null,
          subject,
          body_html: html || null,
          body_text: text || null,
          attachments: null,
          status: 'sent',
          created_at: nowIso,
          sent_at: nowIso,
          participants: [],
        }
      }
      // cid may be null — that is a logged-but-unfiled row, which is the point.
      /* The ONLY site that passes an actor. This row is a message the caller has
       * just sent, so uid is genuinely its author. get_thread and tag persist
       * SYNCED messages — inbound borrower mail, or replies typed in Gmail —
       * where the caller is not the author and stamping them would be false.
       * uid is already resolved above; the mailbox boundary depends on it. */
      const persisted = await persistMessages(svc, [row], cid, uid)

      /* Link the persisted copies to the email_log row. Written after the upsert
       * rather than inside `row` because the Gmail-read path builds `row` from the
       * stored message, whose own attachment metadata has no bucket/path — these are
       * OUR retained copies, retrievable later via a signed URL. */
      if (attMeta.length) {
        const { error: attErr } = await svc.from('email_log')
          .update({ attachments: attMeta })
          .eq('gmail_message_id', sj.id)
        // The mail is already delivered; a bookkeeping failure must not read as a
        // send failure, so surface it in the response instead of throwing.
        if (attErr) console.error('[send] attachment link failed:', attErr.message)
      }

      return ok({
        ok: true, message_id: sj.id, thread_id: resolvedThread, persisted,
        filed_as: matched_by, attachments: attMeta.length,
      })
    }

    // ── Drafts: read-only for now (compose-from-draft). Draft autosave is a later stage. ──
    if (action === 'list_drafts') {
      const dr = await gmailApi(mailbox, 'drafts?maxResults=25')
      const dj = await dr.json()
      if (!dr.ok) return err('list_drafts failed: ' + JSON.stringify(dj.error || dj), 502)
      const drafts = await Promise.all((dj.drafts || []).map(async (d: any) => {
        const mid = d.message && d.message.id
        if (!mid) return { id: d.id, subject: null, to: [], date: null, snippet: '' }
        const mr = await gmailApi(mailbox, `messages/${mid}?format=metadata&metadataHeaders=Subject&metadataHeaders=To&metadataHeaders=Date`)
        if (!mr.ok) return { id: d.id, subject: null, to: [], date: null, snippet: '' }
        const mj = await mr.json()
        const mh = mj.payload?.headers
        return {
          id: d.id,
          message_id: mid,
          thread_id: mj.threadId || null,
          subject: hdr(mh, 'Subject'),
          to: splitAddrs(hdr(mh, 'To')),
          date: mj.internalDate ? new Date(Number(mj.internalDate)).toISOString() : null,
          snippet: decodeEntities(mj.snippet),
        }
      }))
      return ok({ drafts })
    }

    if (action === 'get_draft') {
      const draftId = String(body.draft_id || '')
      if (!draftId) return err('draft_id required')
      const dr = await gmailApi(mailbox, `drafts/${draftId}?format=full`)
      const dj = await dr.json()
      if (!dr.ok) return err('get_draft failed: ' + JSON.stringify(dj.error || dj), 502)
      const msg = dj.message || {}
      const mh = msg.payload?.headers
      const acc = { text: '', html: '' }
      walk(msg.payload, acc)
      return ok({
        draft_id: dj.id,
        thread_id: msg.threadId || null,
        // Bcc survives on a draft (it is only stripped from delivered copies), so restore it.
        to: splitAddrs(hdr(mh, 'To')),
        cc: splitAddrs(hdr(mh, 'Cc')),
        bcc: splitAddrs(hdr(mh, 'Bcc')),
        subject: hdr(mh, 'Subject') || '',
        body_html: acc.html || null,
        body_text: acc.text || null,
      })
    }

    if (action === 'delete_draft') {
      const draftId = String(body.draft_id || '')
      if (!draftId) return err('draft_id required')
      const dr = await gmailApi(mailbox, `drafts/${draftId}`, { method: 'DELETE' })
      if (!dr.ok && dr.status !== 404) {
        const dj = await dr.json().catch(() => ({}))
        return err('delete_draft failed: ' + JSON.stringify(dj.error || dj), 502)
      }
      return ok({ ok: true, draft_id: draftId })
    }

    if (action === 'modify') {
      const threadId = String(body.thread_id || '')
      if (!threadId) return err('thread_id required')
      const remove: string[] = []
      const add: string[] = []
      if (body.mark_read) remove.push('UNREAD')
      if (body.archive) remove.push('INBOX')
      if (!remove.length && !add.length) return err('nothing to modify (mark_read and/or archive)')
      const mr = await gmailApi(mailbox, `threads/${threadId}/modify`, { method: 'POST', body: JSON.stringify({ removeLabelIds: remove, addLabelIds: add }) })
      const mj = await mr.json()
      if (!mr.ok) return err('modify failed: ' + JSON.stringify(mj.error || mj), 502)
      return ok({ ok: true, thread_id: threadId, removed: remove, added: add })
    }

    if (action === 'tag') {
      const threadId = String(body.thread_id || '')
      const contactId = String(body.contact_id || '')
      if (!threadId || !contactId) return err('thread_id and contact_id required')
      // Fetch the full thread and persist every message (idempotent), then file it.
      const tr = await gmailApi(mailbox, `threads/${threadId}?format=full`)
      const tj = await tr.json()
      if (!tr.ok) return err('tag: get_thread failed: ' + JSON.stringify(tj.error || tj), 502)
      const rows = (tj.messages || []).map((m: any) => messageToRow(mailbox, threadId, m))
      const persisted = await persistMessages(svc, rows, contactId)
      // email_thread_tag (as the user): records the tag + backfills contact_id + auto-files future msgs.
      const { data: tagRes, error: tagErr } = await userClient.rpc('email_thread_tag', { p_thread_id: threadId, p_contact_id: contactId })
      if (tagErr) return err('email_thread_tag failed: ' + tagErr.message, 502)
      return ok({ ok: true, thread_id: threadId, contact_id: contactId, persisted, filed: tagRes })
    }

    if (action === 'untag') {
      const threadId = String(body.thread_id || '')
      if (!threadId) return err('thread_id required')
      const { data: res, error: uErr } = await userClient.rpc('email_thread_untag', { p_thread_id: threadId, p_unfile: !!body.unfile })
      if (uErr) return err('email_thread_untag failed: ' + uErr.message, 502)
      return ok({ ok: true, thread_id: threadId, result: res })
    }

    return err('unknown action: ' + action, 400)
  } catch (e) {
    return err('fatal: ' + ((e as Error).message || String(e)), 500)
  }
})

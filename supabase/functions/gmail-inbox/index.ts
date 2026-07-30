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
// Actions: list_threads, get_thread, send, modify, tag, untag,
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
function walk(part: any, acc: { text: string; html: string }) {
  if (!part) return
  const mt = (part.mimeType || '').toLowerCase()
  const d = part.body && part.body.data
  if (mt === 'text/plain' && d && !acc.text) acc.text = b64urlDecode(d)
  else if (mt === 'text/html' && d && !acc.html) acc.html = b64urlDecode(d)
  if (Array.isArray(part.parts)) for (const p of part.parts) walk(p, acc)
}
function collectAttachments(part: any, out: any[]) {
  if (!part) return
  if (part.filename && part.body && part.body.attachmentId) {
    out.push({ filename: part.filename, mimeType: part.mimeType || null, size: part.body.size || null, attachmentId: part.body.attachmentId })
  }
  if (Array.isArray(part.parts)) for (const p of part.parts) collectAttachments(p, out)
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
  const atts: any[] = []
  collectAttachments(msg.payload, atts)
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
    body_text: acc.text || (msg.snippet || null),
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
async function persistMessages(svc: any, rows: any[], contactId: string | null) {
  if (!rows.length) return { inserted: 0, skipped: 0 }
  const payload = rows.map((r) => {
    const { participants: _p, ...row } = r
    if (contactId) (row as any).contact_id = contactId
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
        const mr = await gmailApi(mailbox, `threads/${t.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`)
        if (!mr.ok) return { id: t.id, snippet: t.snippet, subject: null, from: null, date: null, unread: false, message_count: 0 }
        const mj = await mr.json()
        const ms = mj.messages || []
        const first = ms[0]
        const last = ms[ms.length - 1]
        const fromRaw = last ? hdr(last.payload?.headers, 'From') : null
        return {
          id: t.id, snippet: t.snippet,
          subject: first ? hdr(first.payload?.headers, 'Subject') : null,
          from: { email: parseEmail(fromRaw), name: parseName(fromRaw) },
          date: last?.internalDate ? new Date(Number(last.internalDate)).toISOString() : null,
          unread: ms.some((x: any) => (x.labelIds || []).includes('UNREAD')),
          message_count: ms.length,
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
        const path = String((a && a.path) || '')
        if (!path) return err('attachment missing path')
        if (path.includes('..') || !path.startsWith(mailbox + '/')) {
          return err('attachment path outside this mailbox')
        }
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
      const persisted = await persistMessages(svc, [row], cid)

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
          snippet: mj.snippet || '',
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

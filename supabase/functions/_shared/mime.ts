// ── Outbound MIME construction for Gmail sends ────────────────────────────────
//
// Extracted from gmail-inbox/index.ts so the boundary nesting is unit-testable:
// index.ts calls serve() at import time, so nothing inside it can be exercised from
// a test. Hand-rolled multipart with nested boundaries is exactly where a missing
// CRLF or a mis-ordered terminator silently produces mail that renders as raw
// base64 in some clients and fine in others — worth being able to assert on.
//
// See mime.test.ts for the structural assertions.

export type OutAttachment = { name: string; mime: string; bytes: Uint8Array }

export function utf8ToB64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export function b64url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function encSubject(s: string): string {
  return /[^\x00-\x7F]/.test(s) ? `=?UTF-8?B?${utf8ToB64(s)}?=` : s
}

export function b64Body(s: string): string {
  return utf8ToB64(s).replace(/(.{76})/g, '$1\r\n')
}

// Binary → base64 in chunks. String.fromCharCode(...bytes) on a 20MB attachment
// blows the argument limit, so never spread the whole array.
export function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)) as unknown as number[])
  }
  return btoa(bin)
}

export function b64Binary(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/(.{76})/g, '$1\r\n')
}

/* Filenames reach us from the browser and land in MIME headers, so CR/LF must go or a
 * crafted name could inject headers. Non-ASCII gets RFC 2047 encoded. */
export function safeFilename(n: string): string {
  const cleaned = String(n || 'attachment').replace(/[\r\n"\\]/g, '').trim().slice(0, 200) || 'attachment'
  return /[^\x20-\x7E]/.test(cleaned) ? `=?UTF-8?B?${utf8ToB64(cleaned)}?=` : cleaned
}

// Only a conservative token set is allowed through as a MIME type.
export function safeMime(m: string): string {
  const t = String(m || '').trim()
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(t) ? t : 'application/octet-stream'
}

// Strip HTML to a readable plain-text fallback (server-side safety net — the composer
// normally sends its own body_text derived from the sanitized DOM).
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim()
}

/* multipart/alternative: text/plain + text/html. HTML-only mail gets spam-scored, and
 * some clients (and every screen reader fallback) want the text part. With attachments
 * that whole alternative entity becomes the first part of a multipart/mixed. */
export function buildMime(o: {
  from: string; to: string; cc?: string; bcc?: string; subject: string
  html: string; text?: string; inReplyTo?: string | null; references?: string | null
  replyTo?: string | null
  attachments?: OutAttachment[]
  // Injectable only so tests get deterministic boundaries; production uses randomUUID.
  boundaryFn?: () => string
}): string {
  const uid = o.boundaryFn || (() => crypto.randomUUID().replace(/-/g, ''))
  const boundary = 'alt_' + uid()
  const text = (o.text && o.text.trim()) ? o.text : htmlToText(o.html)
  const atts = o.attachments || []

  const h: string[] = []
  h.push(`From: ${o.from}`)
  h.push(`To: ${o.to}`)
  if (o.cc) h.push(`Cc: ${o.cc}`)
  // Gmail honors a Bcc header on send and strips it from every delivered copy.
  if (o.bcc) h.push(`Bcc: ${o.bcc}`)
  /* Reply-To carries the plus-addressed correlation token for HOI/VOE quote
     requests, so a reply lands on an address that names the row it belongs to.
     CR and LF are stripped rather than rejected: this value reaches here from a
     caller, and a bare newline in a header value is header INJECTION — it would
     let a caller append its own Bcc to outbound mail sent from a staff mailbox.
     Stripping is safe because no legal address contains either character. */
  if (o.replyTo) {
    const rt = String(o.replyTo).replace(/[\r\n]+/g, ' ').trim()
    if (rt) h.push(`Reply-To: ${rt}`)
  }
  h.push(`Subject: ${encSubject(o.subject)}`)
  if (o.inReplyTo) h.push(`In-Reply-To: ${o.inReplyTo}`)
  if (o.references) h.push(`References: ${o.references}`)
  h.push('MIME-Version: 1.0')

  const altParts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64Body(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64Body(o.html),
    `--${boundary}--`,
  ]

  if (!atts.length) {
    h.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    h.push('')
    return h.join('\r\n') + '\r\n' + altParts.concat(['']).join('\r\n')
  }

  const mix = 'mix_' + uid()
  h.push(`Content-Type: multipart/mixed; boundary="${mix}"`)
  h.push('')
  const parts: string[] = [
    `--${mix}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    ...altParts,
  ]
  for (const a of atts) {
    const fn = safeFilename(a.name)
    parts.push(
      `--${mix}`,
      `Content-Type: ${safeMime(a.mime)}; name="${fn}"`,
      `Content-Disposition: attachment; filename="${fn}"`,
      'Content-Transfer-Encoding: base64',
      '',
      b64Binary(a.bytes),
    )
  }
  parts.push(`--${mix}--`, '')
  return h.join('\r\n') + '\r\n' + parts.join('\r\n')
}

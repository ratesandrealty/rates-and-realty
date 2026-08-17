// Attachment METADATA off a Gmail `format=full` message. One definition.
//
// Extracted from gmail-inbox so quote-reply-poll can record the same shape
// rather than growing a second extractor. Two copies of "what an attachment
// looks like" would drift, and the whole point of recording it is that
// email_log.attachments and quote_reply_log.attachments can be COMPARED — an
// inbound part matching one we sent on the same thread is our own form coming
// back on reply-all, not the document arriving. That comparison is only sound
// while both sides are produced by the same code.
//
// METADATA ONLY, NEVER BODIES. attachmentId is the Gmail handle that fetches the
// bytes on demand; storing it means a later question about a document costs one
// round trip when asked, instead of a round trip per message now, and instead of
// putting borrower documents in a correlation log. Documents belong in the Drive
// path that already exists.
//
// Note on `contentId`: its presence does NOT mean "inline logo". Measured on the
// 119 attachments held at 2026-08-17, a 3.2MB lease and a 1.2MB
// "Request for VOE BLANK.pdf" both carry one. Anything filtering on it to dodge
// signature images will discard real documents.

export type GmailAttachment = {
  filename: string
  mimeType: string | null
  size: number | null
  attachmentId: string
  partId: string | null
  contentId: string | null
  disposition: string | null
}

function hdr(headers: any[], name: string): string | null {
  if (!Array.isArray(headers)) return null
  const h = headers.find((x) => String(x?.name || '').toLowerCase() === name.toLowerCase())
  return h ? String(h.value || '') : null
}

/** Walks the MIME tree and returns every part that has a filename and a body id. */
export function collectAttachments(part: any, out: GmailAttachment[]): void {
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

/** Convenience: every attachment on a `format=full` message payload. */
export function attachmentsOf(message: any): GmailAttachment[] {
  const out: GmailAttachment[] = []
  collectAttachments(message?.payload, out)
  return out
}

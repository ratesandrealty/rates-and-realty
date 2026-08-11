/* Escrow-number → contact matching, as a pure function.
 *
 * See docs/ESCROW-THREAD-SUGGESTION-2026-08-10.md.
 *
 * This is NOT a search. loan_orders is eleven rows; the caller loads every
 * populated `reference` (realistically one to ten strings) and scans thread text
 * against that list. There is no per-email query to price.
 *
 * It lives here, apart from gmail-inbox/index.ts, for the reason mime.ts does:
 * index.ts calls serve() at import time, so nothing inside it can be exercised
 * from a test. See escrow-match.test.ts — and note that roughly half of those
 * tests are things this must NOT match. A matcher shown only things it should
 * match proves nothing.
 *
 *   deno test supabase/functions/_shared/escrow-match.test.ts
 */

export type EscrowRef = {
  reference: string
  contact_id: string
  contact_name?: string | null
}

export type MatchableVerdict =
  | { ok: true }
  | { ok: false; code: 'empty' | 'too_short' | 'no_digit' | 'all_digits_too_short' | 'bad_characters'; reason: string }

/* ── THE FLOOR ───────────────────────────────────────────────────────────────
 *
 * The case for it, from the auto-tagging report: one of the two populated
 * contacts.loan_number values is THREE CHARACTERS, ALL DIGITS. Matched loosely
 * against mail, a token like that hits a dollar amount, a street number, a date,
 * a phone fragment and an order id — in almost any email in the mailbox.
 *
 * Escrow numbers are usually better shaped (24-118432-KM, ESC-2026-0847), but
 * the field is free text and nothing guarantees it. So the floor is checked, not
 * assumed.
 *
 * Below the floor the behaviour is SILENCE, not a lower-confidence suggestion.
 * A suggestion with a caveat attached is still a thing somebody has to read and
 * dismiss. */
const MIN_LEN = 6
const MIN_LEN_ALL_DIGITS = 7

/* A matchable reference is alphanumeric at both ends and may contain hyphens or
 * slashes in between. Nothing else.
 *
 * This does more work than it looks like. Rejecting spaces, commas, '$', '%' and
 * '.' means a reference that is really a money amount ("412,500.00"), a
 * percentage or a sentence can never be matched on at all — the boundary rules
 * further down cannot save you from a reference that IS a false positive, so the
 * charset stops it here instead. */
const MATCHABLE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9\-\/]*[A-Za-z0-9]$/

export function referenceIsMatchable(raw: string | null | undefined): MatchableVerdict {
  const ref = (raw || '').trim()
  if (!ref) return { ok: false, code: 'empty', reason: 'is empty' }

  if (!MATCHABLE_SHAPE.test(ref)) {
    return {
      ok: false,
      code: 'bad_characters',
      reason: 'contains characters other than letters, digits, hyphens and slashes',
    }
  }
  if (ref.length < MIN_LEN) {
    return { ok: false, code: 'too_short', reason: `is shorter than ${MIN_LEN} characters` }
  }
  if (!/[0-9]/.test(ref)) {
    return { ok: false, code: 'no_digit', reason: 'contains no digit' }
  }
  /* An all-numeric token of six digits is a zip+1, a price, or a date written
   * without separators. One with a letter or a hyphen carries structure that
   * makes an accidental collision far less likely, so it clears at six. */
  if (/^[0-9]+$/.test(ref) && ref.length < MIN_LEN_ALL_DIGITS) {
    return {
      ok: false,
      code: 'all_digits_too_short',
      reason: `is all digits and shorter than ${MIN_LEN_ALL_DIGITS} characters`,
    }
  }
  return { ok: true }
}

/* One sentence, addressed to the person who typed the number. Used by the escrow
 * editor in lead-detail.html so the floor is visible at ENTRY, not only inside
 * the matcher where it is invisible and the feature merely looks broken. */
export function unmatchableNotice(v: MatchableVerdict): string | null {
  if (v.ok) return null
  return `Saved. This number ${v.reason}, so it is too ambiguous to search mail for — threads will not be suggested from it.`
}

/* ── BOUNDARIES ──────────────────────────────────────────────────────────────
 *
 * A hit is rejected when the character on either side is:
 *   - alphanumeric  → the token is part of a longer identifier. This is what
 *     stops escrow 24118432 matching the MLS number OC24118432.
 *   - '-' or '/'    → reference syntax, so the token is a FRAGMENT of a longer
 *     reference. This is what stops a bare 118432 matching inside 24-118432-KM,
 *     which would file a thread on the wrong borrower with real confidence. */
const BOUNDARY_CHAR = /[A-Za-z0-9\/-]/

/* '$24118432' is a dollar amount, not escrow 24118432. '$' is not a boundary
 * character (it is punctuation), so this is checked separately. The optional
 * space covers '$ 24,118,432'-style spacing. */
const MONEY_LEAD = /\$\s?$/

/* Case-insensitive literal search. Deliberately indexOf and not a RegExp:
 * references are free text a user typed, so building a pattern from one would
 * be regex injection — a reference containing '(' or '+' would throw, and one
 * containing '.*' would match everything. */
function occurrences(haystack: string, needle: string): number[] {
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  if (!n) return []
  const out: number[] = []
  let i = h.indexOf(n)
  while (i !== -1) {
    out.push(i)
    i = h.indexOf(n, i + 1)
  }
  return out
}

function occurrenceIsClean(text: string, at: number, len: number): boolean {
  const before = at > 0 ? text[at - 1] : ''
  const after = at + len < text.length ? text[at + len] : ''
  if (before && BOUNDARY_CHAR.test(before)) return false
  if (after && BOUNDARY_CHAR.test(after)) return false
  if (MONEY_LEAD.test(text.slice(Math.max(0, at - 2), at))) return false
  return true
}

export function referenceAppearsIn(text: string, reference: string): boolean {
  if (!referenceIsMatchable(reference).ok) return false
  const ref = reference.trim()
  return occurrences(text || '', ref).some((at) => occurrenceIsClean(text, at, ref.length))
}

/* ── TEXT ────────────────────────────────────────────────────────────────────
 *
 * Tags become a SPACE, not nothing. A number split across markup —
 * `24<span>118432</span>` — therefore reads as "24 118432" and does NOT match.
 *
 * That direction is chosen on purpose. Stripping tags to nothing would join
 * genuinely separate runs of text into tokens nobody wrote, inventing matches
 * out of markup. Missing a number that a mail client happened to split is a lost
 * suggestion; inventing one is a misfiled loan file. */
export function htmlToScannableText(html: string): string {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export type ScannableMessage = {
  subject?: string | null
  body_text?: string | null
  body_html?: string | null
}

/* Subject lines included: escrow correspondence routinely carries the number
 * there and nowhere else. Quoted reply chains are scanned too — a number quoted
 * from earlier in the same thread is still evidence about the same thread. */
export function threadScanText(messages: ScannableMessage[]): string {
  const parts: string[] = []
  for (const m of messages || []) {
    if (m.subject) parts.push(String(m.subject))
    if (m.body_text) parts.push(String(m.body_text))
    else if (m.body_html) parts.push(htmlToScannableText(m.body_html))
  }
  return parts.join('\n')
}

// ── VERDICT ──────────────────────────────────────────────────────────────────

export type EscrowHit = {
  reference: string
  contact_ids: string[]
}

export type EscrowVerdict =
  /* Nothing matched, or nothing was matchable. */
  | { kind: 'none' }
  /* Exactly one file is implicated. The only kind that produces a suggestion. */
  | { kind: 'match'; reference: string; contact_id: string }
  /* One number, recorded on more than one file. Almost certainly a typo on one
   * of them. Suggest NOTHING and say so — nothing constrains reference to be
   * unique across contacts (only ux_loan_orders_contact_type_single exists, on
   * contact+type), and picking a winner hides a data-entry error. The last time
   * a tie-break was quietly resolved in this table it chose an order that had
   * never been placed. */
  | { kind: 'ambiguous_reference'; reference: string; contact_ids: string[] }
  /* Several different numbers, on different files, in one thread — a forwarded
   * digest from an escrow officer working several of ours. Also suggests
   * nothing: the thread is genuinely about more than one loan. */
  | { kind: 'multiple_references'; hits: EscrowHit[] }

export function escrowVerdict(text: string, refs: EscrowRef[]): EscrowVerdict {
  const byRef = new Map<string, EscrowHit>()

  for (const r of refs || []) {
    const reference = (r?.reference || '').trim()
    if (!reference || !r?.contact_id) continue
    if (!referenceIsMatchable(reference).ok) continue
    if (!referenceAppearsIn(text, reference)) continue

    const key = reference.toLowerCase()
    const hit = byRef.get(key) || { reference, contact_ids: [] }
    if (!hit.contact_ids.includes(r.contact_id)) hit.contact_ids.push(r.contact_id)
    byRef.set(key, hit)
  }

  const hits = [...byRef.values()]
  if (!hits.length) return { kind: 'none' }

  const multiContact = hits.find((h) => h.contact_ids.length > 1)
  if (multiContact) {
    return {
      kind: 'ambiguous_reference',
      reference: multiContact.reference,
      contact_ids: multiContact.contact_ids,
    }
  }

  /* Several numbers that all resolve to the SAME borrower is still one answer —
   * an escrow and a title reference on one file, say. Only distinct borrowers
   * make it unanswerable. */
  const contacts = [...new Set(hits.map((h) => h.contact_ids[0]))]
  if (contacts.length > 1) return { kind: 'multiple_references', hits }

  return { kind: 'match', reference: hits[0].reference, contact_id: contacts[0] }
}

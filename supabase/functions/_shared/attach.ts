/* ── Outbound attachment path authorization ────────────────────────────────────
 *
 * gmail-inbox downloads attachment objects with the SERVICE ROLE, which bypasses
 * storage RLS entirely. So RLS is NOT the control here — this predicate is. It is the
 * only thing standing between a caller and any object in the email-attachments bucket.
 *
 * The prefix it checks against is the mailbox the SERVER derived from the caller's
 * verified JWT + auth_user_roles (gmail-inbox/index.ts, "enforce the mailbox boundary
 * BEFORE any Gmail call"), never a value the client supplied. That is what makes the
 * va case fall out for free: a va can only ever resolve to processing@, so a path under
 * rene@'s prefix cannot match.
 *
 * Scope note: this confines paths PER MAILBOX, not per user. Two admins both resolve to
 * rene@ and can therefore reach each other's rene@ uploads — that is the same trust
 * boundary they already share on the mailbox itself.
 *
 * Lives in _shared so it is unit-testable: index.ts calls serve() at import time, so
 * nothing defined inside it can be exercised from a test.
 */

export function attachmentPathError(path: unknown, mailbox: unknown): string | null {
  const p = typeof path === 'string' ? path : ''
  if (!p) return 'attachment missing path'

  // Traversal, absolute paths, Windows separators, and NUL are all rejected outright
  // rather than normalized — there is no legitimate reason for any of them here.
  if (p.includes('..')) return 'attachment path outside this mailbox'
  if (p.includes('\\')) return 'attachment path outside this mailbox'
  if (p.includes('\0')) return 'attachment path outside this mailbox'
  if (p.startsWith('/')) return 'attachment path outside this mailbox'
  if (p.includes('//')) return 'attachment path outside this mailbox'

  const mb = typeof mailbox === 'string' ? mailbox.toLowerCase().trim() : ''
  if (!mb) return 'attachment path outside this mailbox'
  const prefix = mb + '/'

  // Exact, case-sensitive prefix. The composer builds paths from the same lowercased
  // mailbox string, so a case difference means the path is not the one we vouched for.
  if (!p.startsWith(prefix)) return 'attachment path outside this mailbox'
  // Must name an object INSIDE the prefix, not the prefix itself.
  if (p.length <= prefix.length) return 'attachment path outside this mailbox'

  return null
}

// Who we are, and what counts as a well-formed address. ONE definition each.
//
// ══ WHY THIS FILE EXISTS ══
//
// There were THREE separate "is this one of our addresses" sets and they
// disagreed:
//
//   gmail-inbox      rene@, processing@                                  (2)
//   voe-inbound-poll rene@, processing@, reneduarte.homeside@gmail.com   (3)
//   quote-reply-poll rene@, processing@, reneduarte.homeside@gmail.com   (3)
//
// and none of them held reneduarte.realty1@gmail.com. The cost was measured, not
// hypothetical: gmail-inbox's matchContact() excludes "our" addresses before
// resolving a message to a contact, so with only two entries it attributed every
// message touching either personal gmail to the CONTACT RECORD that holds them —
// 344 email_log rows, 185 threads, 96 distinct sender domains (Zillow, Flexmls,
// PayPal, Lowe's, Adidas, TikTok) filed onto one borrower record. The next
// busiest contact has 47 rows from 6 domains, all escrow/title/realty, so this
// was a self-match on one record and not a general matcher fault.
//
// The knowledge was already in the repo — voe-inbound-poll had the homeside
// address listed — just not where the matcher could read it. That is the whole
// argument for one definition.
//
// ══ ATTRIBUTION IS NOT AUTHORIZATION. DO NOT WIRE THIS INTO A MAILBOX GATE. ══
//
// OUR_ADDRESSES answers "is this message from/to us, so do not treat it as a
// third party". It is deliberately BROADER than the set of mailboxes a caller may
// impersonate, because it includes personal gmail accounts we do not host.
//
// gmail-inbox's allowedMailboxes() decides impersonation from the RENE/PROCESSING
// constants directly and must keep doing so. Feeding this list into it would let
// a caller name a gmail account as the sending mailbox — a security change wearing
// the clothes of a de-duplication. Same reason quote-reply-poll validates the
// mailboxes it will sweep against its own short list rather than this one.

export const RENE = 'rene@ratesandrealty.com';
export const PROCESSING = 'processing@ratesandrealty.com';

/* Addresses that belong to us for ATTRIBUTION purposes. Lowercase; compare
   lowercased. Adding one here stops new mail attaching to a contact record that
   happens to hold it — it does NOT rewrite rows already written. */
export const OUR_ADDRESSES: readonly string[] = [
  RENE,
  PROCESSING,
  'reneduarte.homeside@gmail.com',
  'reneduarte.realty1@gmail.com',
];

const OUR_SET = new Set(OUR_ADDRESSES.map((a) => a.toLowerCase()));

export function isOurAddress(e: unknown): boolean {
  return OUR_SET.has(String(e ?? '').trim().toLowerCase());
}

/* Conservative address shape, and the excluded characters are the point rather
   than an attempt at RFC 5322. Comma, quote and parenthesis are exactly what
   breaks out of a PostgREST `or=` filter, which is built by string concatenation
   and splits on commas. An address reaching a resolver comes from an inbound
   To/Cc header — attacker-controllable — so a value that cannot be validated is
   REFUSED, never escaped. Escaping needs the escaper to be right every time;
   refusing needs the pattern to be right once.

   Same expression portal-data has used for this since the or-filter injection was
   closed there; imported rather than copied so the two cannot drift. */
export const EMAIL_RE = /^[^\s,"'()]+@[^\s,"'()]+\.[^\s,"'()]+$/;

/** Lowercased address, or null when it is not a shape we will put in a filter. */
export function validEmail(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  return s && EMAIL_RE.test(s) ? s : null;
}

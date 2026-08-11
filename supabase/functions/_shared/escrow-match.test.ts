/* Escrow-number matching, tested offline.
 *
 * loan_orders.reference is 0-populated, so NOTHING in production exercises this
 * code today and no real thread will until Rene starts entering numbers. Same
 * argument as transcript-format.test.ts, which exists so the dual-channel path
 * did not wait on a real phone call for coverage.
 *
 * MORE THAN HALF OF THESE ARE THINGS IT MUST NOT MATCH — dollar amounts, MLS
 * numbers, invoice and order numbers, tracking numbers, phone fragments, dates.
 * A matcher shown only things it should match proves nothing, the same way a
 * harness that has only ever passed proves nothing. The false-positive block is
 * the point of this file; the true positives are the easy half.
 *
 *   deno test supabase/functions/_shared/escrow-match.test.ts
 */
import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import {
  escrowVerdict,
  htmlToScannableText,
  referenceAppearsIn,
  referenceIsMatchable,
  threadScanText,
  unmatchableNotice,
} from './escrow-match.ts'

const TANIA = '11111111-1111-1111-1111-111111111111'
const MARCUS = '22222222-2222-2222-2222-222222222222'

const refs = (reference: string, contact_id = TANIA) => [{ reference, contact_id }]

// ── THE FLOOR ────────────────────────────────────────────────────────────────

Deno.test('floor: a well-formed escrow number is matchable', () => {
  for (const r of ['24-118432-KM', 'ESC-2026-0847', '0812345-KM', 'NCS-1234567-SA', '24118432']) {
    assertEquals(referenceIsMatchable(r).ok, true, r)
  }
})

Deno.test('floor: shorter than 6 characters is refused', () => {
  const v = referenceIsMatchable('A1234')
  assertEquals(v.ok, false)
  assertEquals(v.ok === false && v.code, 'too_short')
})

/* The case the floor exists for. One of the two populated contacts.loan_number
 * values is three characters, all digits — see the auto-tagging report. */
Deno.test('floor: the real 3-digit loan number is refused', () => {
  assertEquals(referenceIsMatchable('847').ok, false)
})

Deno.test('floor: all digits must reach 7, not 6', () => {
  const six = referenceIsMatchable('241184')
  assertEquals(six.ok, false)
  assertEquals(six.ok === false && six.code, 'all_digits_too_short')
  assertEquals(referenceIsMatchable('2411843').ok, true)
  // A 6-char reference WITH structure clears at 6 — the hyphen is the difference.
  assertEquals(referenceIsMatchable('24-118').ok, true)
})

Deno.test('floor: a zip code cannot be matched on', () => {
  assertEquals(referenceIsMatchable('92801').ok, false)
})

Deno.test('floor: no digit at all is refused', () => {
  const v = referenceIsMatchable('ESCROW-KM')
  assertEquals(v.ok, false)
  assertEquals(v.ok === false && v.code, 'no_digit')
})

/* The charset is doing real work: it is what stops a reference that IS a false
 * positive — a money amount, a percentage — from ever being matched on. The
 * boundary rules further down cannot rescue you from that. */
Deno.test('floor: amounts, percentages and prose are refused by the charset', () => {
  for (const r of ['412,500.00', '6.875%', '$412500', 'see escrow 24-118432', '24 118432']) {
    const v = referenceIsMatchable(r)
    assertEquals(v.ok, false, r)
    assertEquals(v.ok === false && v.code, 'bad_characters', r)
  }
})

Deno.test('floor: empty and null are refused, not crashed on', () => {
  assertEquals(referenceIsMatchable('').ok, false)
  assertEquals(referenceIsMatchable(null).ok, false)
  assertEquals(referenceIsMatchable(undefined).ok, false)
})

Deno.test('unmatchableNotice: a sentence for the person who typed it, null when fine', () => {
  assertEquals(unmatchableNotice(referenceIsMatchable('24-118432-KM')), null)
  const msg = unmatchableNotice(referenceIsMatchable('847'))
  assertEquals(typeof msg === 'string' && msg.includes('shorter than 6'), true)
  assertEquals(typeof msg === 'string' && msg.includes('not be suggested'), true)
})

// ── FALSE POSITIVES — real shapes that must NOT match ────────────────────────

Deno.test('NOT a match: a dollar amount that happens to be the digits', () => {
  assertEquals(referenceAppearsIn('Wire $24118432 to escrow', '24118432'), false)
  assertEquals(referenceAppearsIn('Wire $ 24118432 to escrow', '24118432'), false)
})

/* CA MLS numbers are a two-letter area prefix plus digits — OC24118432,
 * PW26012345. An escrow number that is only the digit run is a substring of one. */
Deno.test('NOT a match: an MLS number containing the digits', () => {
  assertEquals(referenceAppearsIn('MLS# OC24118432 · 3 bd', '24118432'), false)
  assertEquals(referenceAppearsIn('Listing PW24118432 went pending', '24118432'), false)
})

Deno.test('NOT a match: an invoice number the reference is a fragment of', () => {
  assertEquals(referenceAppearsIn('Invoice INV-1184321-A attached', '1184321'), false)
})

/* Amazon-style order ids are hyphenated digit runs, which is exactly the shape
 * an escrow number has. The '-' boundary rule is what separates them. */
Deno.test('NOT a match: an order confirmation number', () => {
  assertEquals(referenceAppearsIn('Order # 112-4829301-4820394 shipped', '4829301'), false)
})

Deno.test('NOT a match: UPS and USPS tracking numbers', () => {
  assertEquals(referenceAppearsIn('UPS 1Z999AA10123456784 delivered', '0123456'), false)
  assertEquals(referenceAppearsIn('USPS 9400111899223197428490', '1899223'), false)
})

Deno.test('NOT a match: a hyphenated phone number', () => {
  assertEquals(referenceAppearsIn('Call me at 714-555-0142 today', '555-0142'), false)
})

Deno.test('NOT a match: an ISO date the reference is the head of', () => {
  assertEquals(referenceAppearsIn('Closing set for 2026-08-10 at noon', '2026-08'), false)
})

/* THE ONE THAT WOULD FILE A LOAN FILE ON THE WRONG BORROWER.
 * A short reference sitting inside a longer, DIFFERENT escrow number reads as a
 * confident exact match — the worst kind of wrong, because the evidence quoted
 * back to Rene would look real. */
Deno.test('NOT a match: the reference is a fragment of a longer escrow number', () => {
  assertEquals(referenceAppearsIn('Re: escrow 24-1184321-KM', '1184321'), false)
  assertEquals(referenceAppearsIn('Re: escrow 24-118432-KM', '118432-KM'), false)
})

Deno.test('NOT a match: glued to a word on either side', () => {
  assertEquals(referenceAppearsIn('ABC24118432', '24118432'), false)
  assertEquals(referenceAppearsIn('24118432XYZ', '24118432'), false)
})

/* KNOWN LIMITATION, pinned rather than papered over. A reference shaped exactly
 * like the tail of a space-separated phone number is indistinguishable from one,
 * because nothing here reads context. The defence is the charset and the length
 * floor, not the surrounding text — so this DOES match, and that is the honest
 * behaviour to record. Nobody enters 555-0142 as an escrow number; if they did,
 * the suggestion would be wrong and dismissable. */
Deno.test('LIMITATION: a space-separated phone tail is not distinguishable', () => {
  assertEquals(referenceAppearsIn('Call (714) 555-0142 today', '555-0142'), true)
})

// ── TRUE POSITIVES ───────────────────────────────────────────────────────────

Deno.test('match: plain, mid-sentence, and at end of sentence', () => {
  assertEquals(referenceAppearsIn('Escrow 24-118432-KM is open', '24-118432-KM'), true)
  assertEquals(referenceAppearsIn('The file is 24-118432-KM.', '24-118432-KM'), true)
})

Deno.test('match: after a # or a colon, which are not boundary characters', () => {
  assertEquals(referenceAppearsIn('Escrow #24-118432-KM', '24-118432-KM'), true)
  assertEquals(referenceAppearsIn('Escrow No: 24-118432-KM', '24-118432-KM'), true)
  assertEquals(referenceAppearsIn('(24-118432-KM)', '24-118432-KM'), true)
})

Deno.test('match: case-insensitive', () => {
  assertEquals(referenceAppearsIn('escrow 24-118432-km open', '24-118432-KM'), true)
  assertEquals(referenceAppearsIn('ESCROW 24-118432-KM OPEN', '24-118432-km'), true)
})

/* Escrow portals put the file number in the link. Preceded by '=' — punctuation,
 * not a boundary character — so it matches, and it is a true positive. */
Deno.test('match: inside a URL query string', () => {
  assertEquals(referenceAppearsIn('https://portal.example.com/f?file=24-118432-KM', '24-118432-KM'), true)
})

Deno.test('match: a stored reference with surrounding whitespace is trimmed', () => {
  assertEquals(referenceAppearsIn('Escrow 24-118432-KM', '  24-118432-KM  '), true)
})

// ── TEXT EXTRACTION ──────────────────────────────────────────────────────────

Deno.test('subject-only and body-only both reach the scanner', () => {
  const subjOnly = threadScanText([{ subject: 'Wire for escrow 24-118432-KM', body_text: 'See attached.' }])
  assertEquals(referenceAppearsIn(subjOnly, '24-118432-KM'), true)

  const bodyOnly = threadScanText([{ subject: 'Wire instructions', body_text: 'Escrow 24-118432-KM, please confirm.' }])
  assertEquals(referenceAppearsIn(bodyOnly, '24-118432-KM'), true)
})

/* A number quoted from earlier in the same thread is still evidence about that
 * thread. Quoted chains are scanned deliberately. */
Deno.test('a reference only in a quoted reply chain still counts', () => {
  const text = threadScanText([{
    subject: 'Re: Wire instructions',
    body_text: 'Confirmed, thanks.\n\n> On Aug 8, Judy wrote:\n> Escrow 24-118432-KM is ready to fund.',
  }])
  assertEquals(referenceAppearsIn(text, '24-118432-KM'), true)
})

Deno.test('html: tags become spaces and entities are decoded', () => {
  assertEquals(
    htmlToScannableText('<p>Escrow&nbsp;<b>24-118432-KM</b> is open</p>'),
    'Escrow 24-118432-KM is open',
  )
  assertEquals(htmlToScannableText('<style>.a{color:red}</style><p>Hi</p>'), 'Hi')
})

/* PINNED, and the conservative direction on purpose. Stripping tags to nothing
 * would join separate runs of text into tokens nobody wrote — inventing matches
 * out of markup. A missed suggestion is a lost convenience; an invented one is a
 * misfiled loan file. */
Deno.test('html: a number split across markup does NOT match', () => {
  const text = htmlToScannableText('Escrow 24<span>118432</span>')
  assertEquals(referenceAppearsIn(text, '24118432'), false)
})

Deno.test('html is only used when there is no plain-text part', () => {
  const t = threadScanText([{ body_text: 'plain 24-118432-KM', body_html: '<p>html 99-999999-ZZ</p>' }])
  assertEquals(referenceAppearsIn(t, '24-118432-KM'), true)
  assertEquals(referenceAppearsIn(t, '99-999999-ZZ'), false)
})

// ── VERDICTS ─────────────────────────────────────────────────────────────────

Deno.test('verdict none: nothing in the text, and no references at all', () => {
  assertEquals(escrowVerdict('Nothing relevant here', refs('24-118432-KM')).kind, 'none')
  assertEquals(escrowVerdict('Escrow 24-118432-KM', []).kind, 'none')
})

Deno.test('verdict none: a below-floor reference is never matched, even verbatim', () => {
  assertEquals(escrowVerdict('The number is 847', refs('847')).kind, 'none')
  assertEquals(escrowVerdict('Total 412,500.00 due', refs('412,500.00')).kind, 'none')
})

Deno.test('verdict match: exactly one file implicated', () => {
  const v = escrowVerdict('Escrow #24-118432-KM funding Friday', refs('24-118432-KM'))
  assertEquals(v.kind, 'match')
  assertEquals(v.kind === 'match' && v.contact_id, TANIA)
  assertEquals(v.kind === 'match' && v.reference, '24-118432-KM')
})

/* Nothing constrains reference to be unique across contacts —
 * ux_loan_orders_contact_type_single is on (contact_id, order_type). Two files
 * carrying one number is a typo on one of them, and picking a winner hides it.
 * The last quiet tie-break in this table chose an order that was never placed. */
Deno.test('verdict ambiguous_reference: one number on two files suggests nothing', () => {
  const v = escrowVerdict('Escrow 24-118432-KM', [
    { reference: '24-118432-KM', contact_id: TANIA },
    { reference: '24-118432-KM', contact_id: MARCUS },
  ])
  assertEquals(v.kind, 'ambiguous_reference')
  assertEquals(v.kind === 'ambiguous_reference' && v.contact_ids.length, 2)
})

Deno.test('verdict multiple_references: two numbers, two borrowers, one thread', () => {
  const v = escrowVerdict('Status: 24-118432-KM and 24-990011-JM both fund Friday', [
    { reference: '24-118432-KM', contact_id: TANIA },
    { reference: '24-990011-JM', contact_id: MARCUS },
  ])
  assertEquals(v.kind, 'multiple_references')
  assertEquals(v.kind === 'multiple_references' && v.hits.length, 2)
})

/* Two numbers on ONE file is still one answer — an escrow and a title reference
 * on the same loan. Only distinct borrowers make a thread unanswerable. */
Deno.test('verdict match: two references resolving to the same borrower', () => {
  const v = escrowVerdict('Files 24-118432-KM / NCS-1234567-SA', [
    { reference: '24-118432-KM', contact_id: TANIA },
    { reference: 'NCS-1234567-SA', contact_id: TANIA },
  ])
  assertEquals(v.kind, 'match')
  assertEquals(v.kind === 'match' && v.contact_id, TANIA)
})

/* References are free text a user typed. Building a RegExp from one would be
 * regex injection: '(' throws, '.*' matches everything. The charset floor
 * refuses these outright, and the search is indexOf regardless — so the only
 * acceptable outcome is a clean 'none', never a throw and never a wild match. */
Deno.test('regex metacharacters in a reference neither throw nor match wildly', () => {
  for (const bad of ['24.*', '(24)118', '24|11', '[0-9]+', '24\\d+']) {
    assertEquals(escrowVerdict('Escrow 24118432 and 2411 and anything', refs(bad)).kind, 'none', bad)
  }
})

/* ── DRIFT ───────────────────────────────────────────────────────────────────
 *
 * admin/lead-detail.html restates this floor in plain JS, because no build step
 * bundles edge-function TypeScript into the admin pages. Two copies of a rule
 * drift, and a floor that disagrees with itself is worse than either version of
 * it: the editor either promises matching that never happens, or stays silent
 * about a number the matcher quietly ignores.
 *
 * So the duplication is allowed and WATCHED. Change the floor here and this
 * fails until the page is changed too. */
Deno.test('drift: the escrow editor mirrors this floor exactly', async () => {
  const page = await Deno.readTextFile(
    new URL('../../../admin/lead-detail.html', import.meta.url),
  )
  assertEquals(page.includes(`const LP_ESC_MIN_LEN = ${MIN_LEN_FOR_TEST};`), true, 'MIN_LEN out of step')
  assertEquals(
    page.includes(`const LP_ESC_MIN_LEN_ALL_DIGITS = ${MIN_LEN_ALL_DIGITS_FOR_TEST};`),
    true,
    'MIN_LEN_ALL_DIGITS out of step',
  )
  assertEquals(
    page.includes('const LP_ESC_SHAPE = /^[A-Za-z0-9][A-Za-z0-9\\-\\/]*[A-Za-z0-9]$/;'),
    true,
    'MATCHABLE_SHAPE out of step',
  )
})

/* Derived from the module's own behaviour rather than hardcoded, so this test
 * cannot pass by agreeing with a stale copy of the constants. '12345' is 5 and
 * refused; '123456' is 6 digits and refused only by the all-digit rule; 'A12345'
 * is 6 with a letter and accepted. */
const MIN_LEN_FOR_TEST = (() => {
  for (let n = 1; n <= 12; n++) {
    if (referenceIsMatchable('A' + '1'.repeat(n - 1)).ok) return n
  }
  throw new Error('could not derive MIN_LEN')
})()
const MIN_LEN_ALL_DIGITS_FOR_TEST = (() => {
  for (let n = 1; n <= 12; n++) {
    if (referenceIsMatchable('1'.repeat(n)).ok) return n
  }
  throw new Error('could not derive MIN_LEN_ALL_DIGITS')
})()

Deno.test('malformed rows are skipped rather than throwing', () => {
  const v = escrowVerdict('Escrow 24-118432-KM', [
    { reference: '', contact_id: TANIA },
    { reference: '24-118432-KM', contact_id: '' },
    { reference: '24-118432-KM', contact_id: TANIA },
  ])
  assertEquals(v.kind, 'match')
})

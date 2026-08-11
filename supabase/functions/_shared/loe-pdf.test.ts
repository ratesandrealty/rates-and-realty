/* LOE rendering + signature-field placement, tested offline.
 *
 * These assertions cannot be made against production: loe-send requires a staff
 * session, and sending a package emails and texts the signers. The geometry is
 * also the part that fails INVISIBLY — a flipped axis or a stale index puts a
 * signature somewhere plausible-looking on a legally significant document, and
 * nothing errors.
 *
 *   deno test supabase/functions/_shared/loe-pdf.test.ts
 */
import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { renderLoePdf, wrap, PAGE_H, PAGE_W, MARGIN, SIG_BOX_H } from './loe-pdf.ts'
import { PDFDocument, StandardFonts } from 'https://esm.sh/pdf-lib@1.17.1'

const BODY = `To Whom It May Concern:

The deposit of $8,400 into my checking account on July 12, 2026 was the proceeds from the sale of a personal vehicle. It was not borrowed and carries no repayment obligation.

Please let me know if any further documentation is required.`

Deno.test('one borrower: exactly one signature field, and it is a real PDF', async () => {
  const { bytes, fields, pageCount } = await renderLoePdf('LOE — Large Deposit', BODY, ['Rafael Hernandez Andrade'])
  assertEquals(fields.length, 1)
  assertEquals(fields[0].signer_index, 1)
  assertEquals(pageCount >= 1, true)
  // %PDF- magic. A renderer that silently produced nothing would still return bytes.
  assertEquals(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-')
})

/* THE REQUIREMENT FROM RENE'S ACTUAL LETTER: two borrowers on one LOE get both
 * full names, each with its OWN signature block above their OWN name — never one
 * shared line that a single signature could cover. */
Deno.test('two borrowers: two blocks, distinct signer_index, one above the other', async () => {
  const { fields } = await renderLoePdf('LOE — Address Gap', BODY, ['Rafael Hernandez Andrade', 'Lilyana Torres'])
  assertEquals(fields.length, 2)
  assertEquals(fields.map((f) => f.signer_index), [1, 2])
  // y grows downward (fraction from the top), so the second block sits BELOW the
  // first. Equal or inverted y would mean the two blocks overlap.
  assertEquals(fields[1].y > fields[0].y, true)
  // And they must not overlap: the first block's bottom edge is above the second.
  assertEquals(fields[0].y + fields[0].h <= fields[1].y, true)
})

/* COORDINATE CONTRACT. esign_fields x/y/w/h are FRACTIONS with y from the TOP —
 * checked against live rows before the renderer was written. pdf-lib draws from
 * the bottom, so this is the conversion most likely to be wrong, and wrong in a
 * way that still renders a signature box somewhere believable. */
Deno.test('fields are fractions of the page, y measured from the top', async () => {
  const { fields } = await renderLoePdf('LOE', BODY, ['A Borrower'])
  const f = fields[0]
  for (const [k, v] of Object.entries({ x: f.x, y: f.y, w: f.w, h: f.h })) {
    assertEquals(v > 0 && v < 1, true, `${k} must be a 0..1 fraction, got ${v}`)
  }
  assertEquals(Math.abs(f.x - MARGIN / PAGE_W) < 1e-9, true)
  assertEquals(Math.abs(f.h - SIG_BOX_H / PAGE_H) < 1e-9, true)
  assertEquals(f.y + f.h < 1, true, 'block must not run off the bottom of the page')
  // Below the header, never at the very top.
  assertEquals(f.y > (MARGIN * 2) / PAGE_H, true, `block should sit below the title, got y=${f.y}`)
})

/* THE AXIS, proved by an invariant rather than a magic number.
 *
 * A first attempt asserted "y > 0.4 for a short letter" and failed — correctly,
 * because a five-line letter legitimately ends a quarter of the way down. The
 * number was wrong, not the renderer, and a number picked to make the test pass
 * would have proved nothing about the axis at all.
 *
 * MORE BODY MUST PUSH THE BLOCK DOWN. Under y-from-the-top, a longer letter
 * gives a LARGER y. If the conversion were flipped, more text would move the
 * block UP and this fails — which is the whole failure mode being guarded. */
Deno.test('axis: a longer body moves the signature block DOWN the page', async () => {
  const short = await renderLoePdf('LOE', 'One short line.', ['A Borrower'])
  const longer = await renderLoePdf('LOE', Array.from({ length: 12 }, () => BODY).join('\n\n'), ['A Borrower'])
  assertEquals(short.fields[0].page, 1)
  assertEquals(longer.fields[0].y > short.fields[0].y || longer.fields[0].page > 1, true,
    `more body must push the block down: short y=${short.fields[0].y}, long y=${longer.fields[0].y}`)
})

Deno.test('a long letter paginates and the block lands on the last page', async () => {
  const long = Array.from({ length: 90 }, (_, i) => `Paragraph ${i + 1}. ${BODY}`).join('\n\n')
  const { fields, pageCount } = await renderLoePdf('LOE — Long', long, ['A Borrower'])
  assertEquals(pageCount > 1, true, 'expected multiple pages')
  assertEquals(fields[0].page, pageCount, 'signature must be on the page it was drawn on')
  assertEquals(fields[0].y + fields[0].h < 1, true)
})

/* WRAPPING LOSES NOTHING.
 *
 * convert-to-pdf's textToPdf does line.substring(0, 100), which silently drops
 * the end of every long line. A letter missing a sentence is a different letter,
 * so this renderer wraps — and this asserts the wrap itself is lossless, word
 * for word and in order.
 *
 * WHAT THIS DOES NOT CATCH, stated because the first version of this test
 * pretended otherwise: it compared output byte sizes, and a deliberate
 * substring(0,100) reintroduced into drawText PASSED it — wrap() already emits
 * lines shorter than 100 characters, so the truncation was a no-op on this
 * input. The byte-size assertion proved nothing. Truncation applied AFTER
 * wrapping is invisible to these tests; catching it needs the PDF content
 * stream read back, which is not done here. */
Deno.test('wrap is lossless: every word survives, in order', async () => {
  const font = await (await PDFDocument.create()).embedFont(StandardFonts.TimesRoman)
  const text = BODY + '\n\n' + 'x'.repeat(400) + '\n\nsupercalifragilistic ' + 'y'.repeat(300)
  const lines = wrap(text, font, 11, PAGE_W - MARGIN * 2)
  const wordsIn = text.split(/\s+/).filter(Boolean)
  const wordsOut = lines.join(' ').split(/\s+/).filter(Boolean)
  assertEquals(wordsOut, wordsIn)
})

Deno.test('wrap keeps every line inside the text column', async () => {
  const font = await (await PDFDocument.create()).embedFont(StandardFonts.TimesRoman)
  const maxW = PAGE_W - MARGIN * 2
  const lines = wrap(BODY, font, 11, maxW)
  // A single unbreakable token may legitimately overflow; ordinary prose must not.
  for (const l of lines) {
    if (!l || l.split(/\s+/).length === 1) continue
    assertEquals(font.widthOfTextAtSize(l, 11) <= maxW, true, `line too wide: ${l}`)
  }
})

Deno.test('no signers: renders, places nothing, and does not throw', async () => {
  const { fields, bytes } = await renderLoePdf('LOE', BODY, [])
  assertEquals(fields.length, 0)
  assertEquals(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-')
})

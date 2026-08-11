/* Letter-of-Explanation → PDF, with the signature fields it placed.
 *
 * Extracted from loe-send/index.ts for the reason mime.ts and escrow-match.ts
 * were: index.ts calls Deno.serve() at import time, so nothing inside it can be
 * exercised from a test. See loe-pdf.test.ts.
 *
 * WHY A GENERATED PDF AND NOT THE TEMPLATE PATH.
 * esign has two envelope shapes. `create` with `template_key` builds ONE html
 * document on signature_requests.document_html — single by construction.
 * `create` with `document_ids[]` builds an envelope over N esign_documents, each
 * with its own esign_fields keyed on (document_id, signer_index), and
 * view/sign/finalize already loop them (esign/index.ts:437, :635, :684). A
 * package is therefore N documents on the path that already works, not surgery
 * on the signing machinery of a legally significant function.
 *
 * A consequence worth stating: separate documents with separate fields mean ONE
 * SIGNATURE CANNOT COVER THE PACKAGE. The signer signs each letter.
 *
 * Generating the PDF here is what makes placement exact — the renderer knows the
 * y of every rule it drew, so the signature box sits directly above the printed
 * name instead of being inferred from a layout engine's output.
 *
 * COORDINATES: esign_fields x/y/w/h are FRACTIONS of the page and y is measured
 * from the TOP. pdf-lib draws from the BOTTOM. Verified against live rows before
 * this was written — a flipped axis puts a signature elsewhere on a legal
 * document and still looks plausible.
 */
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1'

export const PAGE_W = 612, PAGE_H = 792   // US Letter, matching existing esign_documents.page_sizes
export const MARGIN = 56
export const SIG_BOX_H = 34               // signature area sitting above the rule
export const SIG_BOX_W = 240

export type PlacedField = { page: number; x: number; y: number; w: number; h: number; signer_index: number }

export function wrap(text: string, font: any, size: number, maxW: number): string[] {
  const out: string[] = []
  for (const para of String(text || '').replace(/\r/g, '').split('\n')) {
    if (!para.trim()) { out.push(''); continue }
    let line = ''
    for (const word of para.split(/\s+/)) {
      const probe = line ? line + ' ' + word : word
      if (font.widthOfTextAtSize(probe, size) <= maxW) { line = probe; continue }
      if (line) out.push(line)
      line = word
    }
    if (line) out.push(line)
  }
  return out
}

/* One letter -> one PDF plus its signature fields.
 * signerNames is in signer order, so index i becomes signer_index i+1 — the
 * 1-based convention esign's createPdf reads when counting required signers.
 * Two borrowers therefore get two separate blocks and two separate names, each
 * block directly above its own name, never a shared line. */
export async function renderLoePdf(title: string, bodyText: string, signerNames: string[]) {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.TimesRoman)
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold)
  const SIZE = 11, LEAD = 16, TEXT_W = PAGE_W - MARGIN * 2

  let page = pdf.addPage([PAGE_W, PAGE_H])
  let y = PAGE_H - MARGIN
  let pageNo = 1
  const fields: PlacedField[] = []

  const nextPageIfNeeded = (need: number) => {
    if (y - need >= MARGIN) return
    page = pdf.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; pageNo++
  }

  page.drawText(String(title || 'Letter of Explanation').slice(0, 90), { x: MARGIN, y, size: 14, font: bold, color: rgb(0, 0, 0) })
  y -= LEAD * 2

  for (const line of wrap(bodyText, font, SIZE, TEXT_W)) {
    nextPageIfNeeded(LEAD)
    if (line) page.drawText(line, { x: MARGIN, y, size: SIZE, font, color: rgb(0, 0, 0) })
    y -= LEAD
  }

  y -= LEAD
  for (let i = 0; i < signerNames.length; i++) {
    nextPageIfNeeded(SIG_BOX_H + LEAD * 3)
    const boxTopPdf = y                       // pdf-lib space, from the bottom
    const ruleY = boxTopPdf - SIG_BOX_H
    page.drawLine({ start: { x: MARGIN, y: ruleY }, end: { x: MARGIN + SIG_BOX_W, y: ruleY }, thickness: 1, color: rgb(0.2, 0.2, 0.2) })
    page.drawText(String(signerNames[i] || '').slice(0, 80), { x: MARGIN, y: ruleY - 14, size: SIZE, font, color: rgb(0, 0, 0) })

    fields.push({
      page: pageNo,
      x: MARGIN / PAGE_W,
      y: (PAGE_H - boxTopPdf) / PAGE_H,       // from the TOP, as a fraction
      w: SIG_BOX_W / PAGE_W,
      h: SIG_BOX_H / PAGE_H,
      signer_index: i + 1,
    })
    y = ruleY - 14 - LEAD * 2
  }

  const bytes = await pdf.save()
  const pageSizes = pdf.getPages().map(() => ({ w: PAGE_W, h: PAGE_H }))
  return { bytes, fields, pageCount: pageSizes.length, pageSizes }
}

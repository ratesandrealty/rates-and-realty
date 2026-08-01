/* Page-text extraction that does not hold a whole PDF's text layer at once.
 *
 * WHY THIS EXISTS
 * Both chunkers called unpdf's extractText(pdf, { mergePages: false }), which
 * materialises every page's text content in one go. On USDA HB-1-3560 — 3.3 MB,
 * 511 pages — that returns WORKER_RESOURCE_LIMIT. Extracting page-by-page from a
 * single getDocumentProxy() still failed, so the wall is the pdf.js document
 * itself, not just the accumulated strings.
 *
 * So the document is SPLIT FIRST with pdf-lib, and pdf.js only ever sees a slice.
 * Same shape as textract-ocr's vision path, which splits before the model call
 * rather than discovering the limit by catching an error.
 *
 * pdf-lib parses the source once and holds it; that is a structural parse, far
 * lighter than pdf.js's text-layer machinery, and it is what makes the peak
 * bounded: one source document plus one small slice, never one huge slice.
 */
// @ts-ignore
import { getDocumentProxy } from "https://esm.sh/unpdf@0.12.1";
// @ts-ignore
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

/** Pages per slice. 50 keeps a slice's text layer small while keeping the
 *  number of pdf.js parses low — a 511-page document becomes 11 slices. */
export const PAGE_SLICE = 50;

export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getPageCount();
}

/**
 * Extract text for every page, slice by slice.
 *
 * `onProgress(done, total)` is called after each slice so a caller can log or
 * checkpoint. Returns one string per page, 0-indexed, always exactly
 * `pageCount` long — a page whose text cannot be read contributes "" rather
 * than shortening the array and silently shifting every later page's number.
 */
export async function extractPagesRanged(
  bytes: Uint8Array,
  onProgress?: (done: number, total: number) => void,
  fromPage = 0,
  toPage?: number,
): Promise<string[]> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const total = src.getPageCount();
  /* Bounded window, so a caller can extract 150 pages now and the rest on the
   * next invocation. Returns text for [fromPage, toPage) ONLY, indexed from 0
   * of that window — the caller places it back at the right offset. */
  const lo = Math.max(0, fromPage);
  const hi = Math.min(toPage ?? total, total);
  const out: string[] = new Array(Math.max(0, hi - lo)).fill("");

  for (let start = lo; start < hi; start += PAGE_SLICE) {
    const end = Math.min(start + PAGE_SLICE, hi);
    let sliceBytes: Uint8Array;
    try {
      const slice = await PDFDocument.create();
      const idx: number[] = [];
      for (let i = start; i < end; i++) idx.push(i);
      const copied = await slice.copyPages(src, idx);
      copied.forEach((pg: any) => slice.addPage(pg));
      sliceBytes = await slice.save();
    } catch (e) {
      console.error(`[pdf-pages] slice ${start + 1}-${end} could not be built:`, String(e));
      onProgress?.(end, hi);
      continue;   // those pages stay "" — a hole, not a failure
    }

    try {
      const pdf = await getDocumentProxy(sliceBytes);
      for (let n = 1; n <= pdf.numPages; n++) {
        try {
          const page = await pdf.getPage(n);
          const tc = await page.getTextContent();
          out[start - lo + n - 1] = (tc.items || []).map((i: any) => i.str || "").join(" ");
          page.cleanup?.();
        } catch (e) {
          console.error(`[pdf-pages] page ${start + n} text failed:`, String(e));
        }
      }
      pdf.cleanup?.();
      pdf.destroy?.();
    } catch (e) {
      console.error(`[pdf-pages] slice ${start + 1}-${end} parse failed:`, String(e));
    }
    onProgress?.(end, hi);
  }
  return out;
}

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// @ts-ignore
import { extractText, getDocumentProxy } from 'https://esm.sh/unpdf@0.12.1'
// @ts-ignore
import { PDFDocument } from 'https://esm.sh/pdf-lib@1.17.1'
import { requireStaff } from "../_shared/require-staff.ts";

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

/* 28 MB of base64 ≈ 21 MB of PDF. The Anthropic 32 MB request cap no longer
 * binds here: whole documents are never sent to the model any more — text is
 * extracted locally, and vision sees 25-page slices. What binds now is edge
 * function memory. Peak residency when splitting is roughly 4x the file: the
 * raw bytes, pdf-lib's parsed source document, the copied output, and the
 * base64 of the slice. At 21 MB that is ~85 MB against a ~150 MB ceiling. */
const MAX_BASE64_BYTES = 28 * 1024 * 1024


function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function toBase64(bytes: Uint8Array): string {
  let s = ''
  const CH = 0x8000   // chunked, or a large PDF blows the call stack
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH))
  return btoa(s)
}
/** Extract pages [from..to] (1-based, inclusive) as a standalone PDF. */
async function slicePdf(bytes: Uint8Array, from: number, to: number): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const out = await PDFDocument.create()
  const idx: number[] = []
  for (let i = from - 1; i <= to - 1 && i < src.getPageCount(); i++) idx.push(i)
  const copied = await out.copyPages(src, idx)
  copied.forEach((pg: any) => out.addPage(pg))
  return await out.save()
}
/** OCR one page-range slice. Throws on any non-200 so the caller can halve. */
async function visionOcr(slice: Uint8Array, key: string): Promise<string> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'pdfs-2024-09-25' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(slice) } },
        { type: 'text', text: 'Transcribe all text from these pages verbatim, preserving headings and table structure as plain text. Output only the transcription.' },
      ] }],
    }),
  })
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`)
  const d = await r.json()
  return d.content?.[0]?.text || ''
}
/** Summarize from TEXT. No document block, so no page or token ceiling. */
async function summarizeGuideline(text: string, docCategory: string, key: string): Promise<any> {
  const prompt = `You are reviewing a lender ${docCategory.toLowerCase()} document. Extract a structured summary as JSON ONLY. Do not include any prose outside the JSON.

{
  "summary": "2-3 sentence plain-English summary of what this document covers",
  "loan_programs": ["list","of","loan programs covered, e.g. FHA, VA, Conventional, Jumbo, DSCR, Bank Statement"],
  "min_fico": 0,
  "max_ltv": 0,
  "max_dti": 0,
  "min_loan_amount": 0,
  "max_loan_amount": 0,
  "states_available": ["CA","NV"],
  "key_requirements": ["bullet of one important requirement, overlay, or rule"]
}

Rules:
- Return ONLY the JSON object, no markdown, no backticks, no commentary.
- Use 0 for unknown numeric fields, [] for unknown arrays, "" for unknown strings.
- Do not invent values. If the doc doesn't say it, leave it empty/zero.
- key_requirements should capture overlays, restrictions, and unusual rules.

DOCUMENT TEXT:
${text}`
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`)
  const d = await r.json()
  const t: string = d.content?.[0]?.text || '{}'
  const m = t.match(/\{[\s\S]*\}/)
  return m ? JSON.parse(m[0]) : {}
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  /* GUARD FIRST — before the body or query string is read, so an action
     added later is covered by default rather than by remembering.
     verify_jwt=true does NOT do this: the anon key is a project-signed JWT
     printed in every page's source. See docs/PINNED-NOT-GUARDED.md. */
  const _auth = await requireStaff(req);
  if (!_auth.ok) return new Response(JSON.stringify({ error: _auth.msg || 'not authorized' }),
    { status: _auth.status || 401, headers: { ...cors, 'Content-Type': 'application/json' } });
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json().catch(() => ({}))
    const { action } = body

    // ─────────────────────────────────────────────────────────
    // POLLING: result lookup for borrower OCR jobs
    // ─────────────────────────────────────────────────────────
    if (action === 'result') {
      const { job_id } = body
      if (!job_id) return jsonErr(400, 'job_id required')
      const { data: job } = await sb.from('ocr_jobs').select('*').eq('id', job_id).single()
      if (!job) {
        // Don't 500 — return pending so the front-end can keep polling
        return new Response(JSON.stringify({ status: 'pending', fields: {}, doc_type: 'Document' }), { headers: jsonHeaders() })
      }
      return new Response(JSON.stringify({ status: job.status, fields: job.extracted_fields || {}, doc_type: job.doc_type || 'Document' }), { headers: jsonHeaders() })
    }

    // ─────────────────────────────────────────────────────────
    // START: validate inputs once for both branches
    // ─────────────────────────────────────────────────────────
    if (action !== 'start') return jsonErr(400, 'Unknown action: ' + action)

    const {
      file_base64, file_name, file_type, contact_id,
      lender_id, category, version, notes, title,
      doc_type
    } = body

    if (!file_base64 || typeof file_base64 !== 'string') {
      return jsonErr(400, 'file_base64 missing or empty')
    }
    if (file_base64.length > MAX_BASE64_BYTES) {
      return jsonErr(413, `File too large (${(file_base64.length/1024/1024).toFixed(1)}MB base64). Max ~20MB. Compress the PDF first.`)
    }

    const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') || Deno.env.get('CLAUDE_API_KEY')
    if (!ANTHROPIC_KEY) return jsonErr(500, 'No Anthropic key configured (ANTHROPIC_API_KEY)')

    const isPdf = (file_type || '').includes('pdf') || (file_name || '').toLowerCase().endsWith('.pdf')
    const mediaType = isPdf ? 'application/pdf' : 'image/jpeg'
    const contentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file_base64 } }
      : { type: 'image',    source: { type: 'base64', media_type: mediaType,         data: file_base64 } }

    // ─────────────────────────────────────────────────────────
    // BRANCH A — LENDER DOCUMENT (guidelines, rate sheet, etc.)
    // Triggered by lender_id or category being present.
    //
    // ORDER MATTERS. The old flow called Claude with the whole PDF as one
    // document block and only uploaded to storage afterwards, so a document
    // that tripped an Anthropic limit was lost entirely — that is why
    // "Jumbo A+ Underwriting Guidelines 4.23.21" and "Oaktree Funding Platinum
    // Advantage 9.1.24" are in neither the corpus nor the bucket. Now the file
    // is stored and the row exists BEFORE any model call, so the worst case is
    // a document with no summary, never a document that vanished.
    //
    // Then: text layer first. 86 of 90 guidelines sampled from the live corpus
    // (95%) have an extractable text layer at a median 1,882 chars/page — for
    // those the model never sees a PDF at all, so neither the 100-page cap nor
    // the 200k-token cap can apply, and the call costs a fraction as much.
    // Vision is the fallback for genuinely scanned documents, batched.
    // ─────────────────────────────────────────────────────────
    if (lender_id || category) {
      const docCategory = category || 'General'
      const pdfBytes = decodeBase64(file_base64)
      const safeFileName = (file_name || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_')

      // ── 1. STORE FIRST ──────────────────────────────────────────────────
      let publicUrl: string | null = null
      try {
        const up = await sb.storage.from('lender-guidelines')
          .upload(safeFileName, pdfBytes, { contentType: 'application/pdf', upsert: true })
        if (up.error) throw new Error(up.error.message)
        publicUrl = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/lender-guidelines/${encodeURIComponent(safeFileName)}`
      } catch (e) {
        // Storage is the one step whose failure genuinely loses the document.
        return jsonErr(500, 'Storage upload failed, nothing was saved: ' + (e as Error).message)
      }

      const { data: row0, error: upsertErr0 } = await sb.from('lender_guidelines').upsert({
        lender_id: lender_id || null,
        title: title || file_name?.replace(/\.pdf$/i, '') || 'Untitled',
        category: docCategory,
        file_name: safeFileName,
        file_url: publicUrl,
        file_type: file_type || 'application/pdf',
        file_size: pdfBytes.byteLength,
        version: version || null,
        content_notes: notes || null,
        is_active: true,
        ocr_status: 'processing',
        upload_source: 'lender_modal',
        source_type: 'lender',
        updated_at: new Date().toISOString()
      }, { onConflict: 'lender_id,file_name' }).select('id').single()
      if (upsertErr0) return jsonErr(500, 'DB upsert failed: ' + upsertErr0.message)
      const guidelineId = row0!.id

      // ── 2. TEXT LAYER ───────────────────────────────────────────────────
      let pageTexts: string[] = []
      let pageCount = 0
      try {
        const pdf = await getDocumentProxy(pdfBytes)
        pageCount = pdf.numPages
        const r = await extractText(pdf, { mergePages: false })
        pageTexts = Array.isArray(r?.text) ? r.text.map((t: any) => String(t ?? '')) : [String(r?.text ?? '')]
      } catch (e) {
        console.error('[lender] text extraction failed:', (e as Error).message)
      }
      const totalChars = pageTexts.reduce((n, t) => n + t.trim().length, 0)
      const pagesWithText = pageTexts.filter((t) => t.trim().length > 50).length
      const charsPerPage = pageCount ? Math.round(totalChars / pageCount) : 0
      // Same test the corpus was measured with: real text on most pages, not a
      // header stamped over a scan.
      const hasTextLayer = charsPerPage >= 200 && pagesWithText >= Math.ceil(pageCount * 0.6)

      let fullText = ''
      const failedRanges: string[] = []
      let batchLog: any[] = []
      let method = 'text-layer'

      if (hasTextLayer) {
        fullText = pageTexts.join('\n\n')
      } else {
        // ── 3. VISION FALLBACK, BATCHED BY PAGE RANGE ─────────────────────
        // Batch size is derived from the token ceiling, not guessed. A PDF page
        // costs roughly 1,600 image tokens plus its text; at the corpus median
        // (1,882 chars/page ≈ 470 tokens) that is ~2,070 tokens/page, and at the
        // densest page observed (6,787 chars ≈ 1,700 tokens) ~3,300. The ceiling
        // is 200,000 for prompt+output. 25 pages is 52k–83k tokens across that
        // whole range — a 2.4x margin at worst-observed density — and it is the
        // same PAGE_BATCH_SIZE chunk-guidelines-large already uses, so there is
        // one number to reason about rather than two. Oaktree failed at 204,090
        // tokens, i.e. it was sent as ~100 pages at once; 25 could not.
        //
        // The 400 is never caught as a surprise: page count is known up front,
        // so batches are planned. Adaptive halving exists only for documents
        // denser than anything measured.
        method = 'vision'
        const PAGE_BATCH = 25
        for (let start = 1; start <= pageCount; ) {
          let size = Math.min(PAGE_BATCH, pageCount - start + 1)
          let done = false
          while (!done && size >= 1) {
            const endP = start + size - 1
            try {
              const slice = await slicePdf(pdfBytes, start, endP)
              const txt = await visionOcr(slice, ANTHROPIC_KEY!)
              fullText += (fullText ? '\n\n' : '') + txt
              batchLog.push({ pages: `${start}-${endP}`, ok: true, chars: txt.length })
              start = endP + 1
              done = true
            } catch (e) {
              const msg = String((e as Error).message || e)
              if (size > 1) {
                console.warn(`[lender] pages ${start}-${endP} failed (${msg.slice(0, 80)}), halving`)
                batchLog.push({ pages: `${start}-${endP}`, ok: false, retrying_smaller: true, error: msg.slice(0, 120) })
                size = Math.floor(size / 2)
              } else {
                // ── 4. PARTIAL SUCCESS: skip the page, keep the document ────
                failedRanges.push(String(start))
                batchLog.push({ pages: String(start), ok: false, error: msg.slice(0, 120) })
                start = start + 1
                done = true
              }
            }
          }
        }
      }

      // ── 5. SUMMARY FROM TEXT, never from the whole PDF ──────────────────
      // Bounded so a 300-page guideline cannot reproduce the token failure the
      // document block caused. The summary does not need every page; the
      // chunker indexes the full text separately for retrieval.
      const SUMMARY_CHAR_BUDGET = 120_000   // ~30k tokens, well inside the ceiling
      const excerpt = fullText.slice(0, SUMMARY_CHAR_BUDGET)
      let summary = '', loanPrograms: string[] = [], keyReqs: string[] = [], states: string[] = []
      let minFico: number | null = null, maxLtv: number | null = null
      let summaryError: string | null = null

      if (excerpt.trim().length > 0) {
        try {
          const parsed = await summarizeGuideline(excerpt, docCategory, ANTHROPIC_KEY!)
          summary = String(parsed.summary || '')
          loanPrograms = Array.isArray(parsed.loan_programs) ? parsed.loan_programs.map(String) : []
          keyReqs = Array.isArray(parsed.key_requirements) ? parsed.key_requirements.map(String) : []
          states = Array.isArray(parsed.states_available) ? parsed.states_available.map(String) : []
          minFico = Number(parsed.min_fico) > 0 ? Math.round(Number(parsed.min_fico)) : null
          maxLtv = Number(parsed.max_ltv) > 0 ? Number(parsed.max_ltv) : null
        } catch (e) {
          // The document is already stored and its text extracted. A failed
          // summary is a missing field, not a failed upload.
          summaryError = String((e as Error).message || e).slice(0, 200)
          console.error('[lender] summary failed:', summaryError)
        }
      }

      const ocrStatus = failedRanges.length ? 'partial' : (fullText.trim() ? 'completed' : 'no_text')
      const { error: upErr } = await sb.from('lender_guidelines').update({
        ocr_status: ocrStatus,
        ocr_text: fullText.slice(0, 1_000_000),
        ocr_page_count: pageCount,
        ocr_completed_at: new Date().toISOString(),
        extracted_text: fullText.slice(0, 1_000_000),
        ai_summary: summary || null,
        ai_indexed_at: summary ? new Date().toISOString() : null,
        key_requirements: keyReqs.length ? keyReqs : null,
        min_fico: minFico,
        max_ltv: maxLtv,
        states_available: states.length ? states : null,
        loan_types: loanPrograms.length ? loanPrograms : null,
        // Let the existing chunker pipeline index it — this path does not chunk.
        chunk_status: null,
        chunked_at: null,
        chunk_count: 0,
        updated_at: new Date().toISOString()
      }).eq('id', guidelineId)
      if (upErr) console.error('[lender] final update failed:', upErr.message)

      // ── 6. REPORT WHAT HAPPENED, INCLUDING WHAT DIDN'T ──────────────────
      return new Response(JSON.stringify({
        success: true,
        partial: failedRanges.length > 0,
        document_id: guidelineId,
        file_url: publicUrl,
        method,
        page_count: pageCount,
        chars_extracted: fullText.length,
        chars_per_page: charsPerPage,
        pages_failed: failedRanges,
        batches: batchLog,
        summary_error: summaryError,
        summary,
        loan_programs: loanPrograms,
        min_fico: minFico,
        max_ltv: maxLtv,
        states_available: states,
        key_requirements: keyReqs,
        message: failedRanges.length
          ? `Indexed ${pageCount - failedRanges.length} of ${pageCount} pages. Pages ${failedRanges.join(', ')} could not be read.`
          : `Indexed ${pageCount} page(s) via ${method}.`
      }), { headers: jsonHeaders() })
    }

    // ─────────────────────────────────────────────────────────
    // BRANCH B — BORROWER DOCUMENT (W2, ID, paystub, bank stmt, etc.)
    // Original flow, unchanged behavior.
    // ─────────────────────────────────────────────────────────
    const nameLower = (file_name || '').toLowerCase()
    let docType = 'Document'

    // Optional explicit doc_type from caller (e.g. per-card Scan button passing
    // the Drive file's appProperties.docType). Maps to a display label; if
    // missing / empty / 'other' / 'unknown', fall through to the filename
    // heuristic below (backward-compatible — existing callers don't send doc_type).
    // Note: gov_id -> "Identification Document" (NOT "Driver's License") because
    // it's a generic key — could be passport / state ID / DL.
    const docTypeKey = String(doc_type || '').trim().toLowerCase()
    const DOC_TYPE_LABELS: Record<string, string> = {
      gov_id:            'Identification Document',
      drivers_license:   "Driver's License",
      license:           "Driver's License",
      dl:                "Driver's License",
      w2:                'W-2',
      'w-2':             'W-2',
      pay_stubs:         'Pay Stub',
      pay_stub:          'Pay Stub',
      paystub:           'Pay Stub',
      bank_statements:   'Bank Statement',
      bank_statement:    'Bank Statement',
      tax_returns:       'Tax Return',
      tax_return:        'Tax Return',
      '1040':            'Tax Return',
      purchase_contract: 'Purchase Contract',
    }
    const mapped = (docTypeKey && docTypeKey !== 'other' && docTypeKey !== 'unknown')
      ? (DOC_TYPE_LABELS[docTypeKey]
         || (docTypeKey.charAt(0).toUpperCase() + docTypeKey.slice(1).replace(/_/g, ' ')))
      : ''
    if (mapped) {
      docType = mapped
    } else if (nameLower.includes('id') || nameLower.includes('license') || nameLower.includes('dl')) {
      docType = "Driver's License"
    } else if (nameLower.includes('w2') || nameLower.includes('w-2')) {
      docType = 'W-2'
    } else if (nameLower.includes('pay') || nameLower.includes('stub')) {
      docType = 'Pay Stub'
    } else if (nameLower.includes('bank')) {
      docType = 'Bank Statement'
    } else if (nameLower.includes('tax') || nameLower.includes('1040')) {
      docType = 'Tax Return'
    }

    // Doc-type-branched extraction template + hint. The downstream parse,
    // filter (null/N/A drop), and ocr_jobs insert are source-agnostic — they
    // store whatever keys come back. Frontend wiring per doc type is a
    // separate pass (Item 2b). Default branch = original ID/employment
    // field set — preserves behavior for gov_id, drivers_license,
    // tax_returns, unknown, and any unmapped doc_type.
    let extractionTemplate: string
    let extractionHint: string
    if (docTypeKey === 'bank_statements' || docTypeKey === 'bank_statement') {
      extractionTemplate = '{"bank_name":"","account_type":"","account_number":"","total_balance":"","statement_start_date":"MM/DD/YYYY","statement_end_date":"MM/DD/YYYY","account_holder_first_name":"","account_holder_last_name":"","street_address":"","city":"","state":"","zip_code":""}'
      extractionHint = 'total_balance digits only (no $, no commas). Dates MM/DD/YYYY. account_holder name identifies which borrower the statement belongs to. Proper-case names.'
    } else if (docTypeKey === 'w2' || docTypeKey === 'w-2') {
      extractionTemplate = '{"employer_name":"","employee_first_name":"","employee_last_name":"","wages":"","federal_tax_withheld":"","tax_year":"","ssn":""}'
      extractionHint = `IMPORTANT W-2 box-mapping (lender standard):
- wages = Box 1 ("Wages, tips, other compensation") — federal taxable wages. NOT Box 3 (Social Security wages, capped) and NOT Box 5 (Medicare wages).
- federal_tax_withheld = Box 2 ("Federal income tax withheld").
- employer_name = Box c (employer name + address block — name only, no address).
- employee_first_name + employee_last_name = Box e (employee name; split into first/last).
- tax_year = the year printed at top of the form (YYYY only).
- ssn = Box a ("Employee SSN") — digits only, no dashes.
If the document contains multiple W-2 copies of the SAME W-2 (Copy A, Copy 1, Copy 2, Copy B, Copy C), they have IDENTICAL data — just pick one.
If the document contains DIFFERENT employers (multiple jobs), extract from the FIRST employer only (caller will re-scan for the second).
All money fields digits only (no $, no commas, no decimals if whole-dollar).`
    } else if (docTypeKey === 'pay_stubs' || docTypeKey === 'pay_stub' || docTypeKey === 'paystub') {
      extractionTemplate = '{"employer_name":"","first_name":"","last_name":"","gross_pay":"","net_pay":"","pay_period_start":"MM/DD/YYYY","pay_period_end":"MM/DD/YYYY","ytd_gross":""}'
      extractionHint = `IMPORTANT paystub field-mapping (lender standard):
- gross_pay = THIS PAY PERIOD gross earnings (not YTD). Usually labeled "Current Gross", "Period Gross", "Gross Pay", or "Total Earnings" for this paycheck.
- net_pay = THIS PAY PERIOD net (take-home) — after taxes/deductions for this period only.
- ytd_gross = Year-to-date gross earnings (cumulative from Jan 1). Usually in a "YTD" column next to current.
- pay_period_start + pay_period_end = the dates this paycheck covers (NOT the pay date / check date).
- employer_name = company name on the stub.
- first_name + last_name = employee name (split).
If multiple paystubs in one document, extract the MOST RECENT one (latest pay_period_end).
All money fields digits only (no $, no commas).`
    } else {
      extractionTemplate = '{"first_name":"","last_name":"","middle_name":"","date_of_birth":"MM/DD/YYYY","ssn":"","driver_license_number":"","dl_state":"","id_expiration_date":"MM/DD/YYYY","street_address":"","city":"","state":"","zip_code":"","employer_name":"","position":"","monthly_income":""}'
      extractionHint = 'CA DL: LN=last name FN=first name. Proper-case names.'
    }
    const promptText = `Extract fields from this ${docType}. Return ONLY JSON: ${extractionTemplate}. ${extractionHint} ONLY JSON.`

    let claudeResp: Response
    try {
      claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'pdfs-2024-09-25' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{ role: 'user', content: [
            contentBlock,
            { type: 'text', text: promptText }
          ]}]
        })
      })
    } catch (fetchErr) {
      return jsonErr(502, 'Anthropic request failed: ' + (fetchErr as Error).message)
    }

    console.log('Claude resp status:', claudeResp.status)
    let fields: Record<string, string> = {}
    if (!claudeResp.ok) {
      const errText = await claudeResp.text().catch(() => '')
      console.error('Claude error:', claudeResp.status, errText.substring(0, 400))
      return jsonErr(502, `Claude API ${claudeResp.status}: ${errText.substring(0, 200)}`)
    }
    const cd = await claudeResp.json()
    const text = cd.content?.[0]?.text || '{}'
    console.log('Claude text:', text.substring(0, 200))
    try {
      const m = text.match(/\{[\s\S]*\}/)
      if (m) {
        const p = JSON.parse(m[0])
        Object.keys(p).forEach(k => { if (p[k] && p[k] !== 'null' && p[k] !== 'N/A') fields[k] = String(p[k]) })
      }
    } catch (e) { console.error('Parse err:', e) }

    const { data: job } = await sb.from('ocr_jobs').insert({
      contact_id: contact_id || null, file_name, s3_key: 'claude-vision',
      textract_job_id: 'claude-' + Date.now(), status: 'completed',
      extracted_fields: fields, completed_at: new Date().toISOString()
    }).select().single()

    return new Response(JSON.stringify({ job_id: job?.id, status: 'completed', fields, doc_type: docType }), { headers: jsonHeaders() })

  } catch (err) {
    console.error('textract-ocr error:', (err as Error).message)
    return jsonErr(500, (err as Error).message)
  }
})

function jsonHeaders() {
  return { ...cors, 'Content-Type': 'application/json' }
}
function jsonErr(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), { status, headers: jsonHeaders() })
}

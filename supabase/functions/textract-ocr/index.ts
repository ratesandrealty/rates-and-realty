import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

const MAX_BASE64_BYTES = 28 * 1024 * 1024 // ~21 MB raw, well under Anthropic 32 MB cap

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
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
    // ─────────────────────────────────────────────────────────
    if (lender_id || category) {
      const docCategory = category || 'General'
      const lenderPrompt = `You are reviewing a lender ${docCategory.toLowerCase()} document. Extract a structured summary as JSON ONLY. Do not include any prose outside the JSON.

{
  "summary": "2-3 sentence plain-English summary of what this document covers",
  "loan_programs": ["list","of","loan programs covered, e.g. FHA, VA, Conventional, Jumbo, DSCR, Bank Statement"],
  "min_fico": 0,
  "max_ltv": 0,
  "max_dti": 0,
  "min_loan_amount": 0,
  "max_loan_amount": 0,
  "states_available": ["CA","NV"],
  "key_requirements": [
    "bullet of one important requirement, overlay, or rule"
  ],
  "raw_excerpt": "first ~1500 chars of the document text exactly as printed, for keyword search"
}

Rules:
- Return ONLY the JSON object, no markdown, no backticks, no commentary.
- Use 0 for unknown numeric fields, [] for unknown arrays, "" for unknown strings.
- Do not invent values. If the doc doesn't say it, leave it empty/zero.
- key_requirements should capture overlays, restrictions, and unusual rules — anything a loan officer would need to know.`

      let claudeResp: Response
      try {
        claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'pdfs-2024-09-25' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 2048,
            messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: lenderPrompt }] }]
          })
        })
      } catch (fetchErr) {
        return jsonErr(502, 'Anthropic request failed: ' + (fetchErr as Error).message)
      }

      if (!claudeResp.ok) {
        const errText = await claudeResp.text().catch(() => '')
        console.error('[lender] Claude error:', claudeResp.status, errText.substring(0, 400))
        return jsonErr(502, `Claude API ${claudeResp.status}: ${errText.substring(0, 200)}`)
      }

      const cd = await claudeResp.json()
      const text: string = cd.content?.[0]?.text || '{}'
      console.log('[lender] Claude raw:', text.substring(0, 300))

      let parsed: any = {}
      try {
        const m = text.match(/\{[\s\S]*\}/)
        if (m) parsed = JSON.parse(m[0])
      } catch (e) {
        console.error('[lender] JSON parse failed:', (e as Error).message)
      }

      const summary = String(parsed.summary || '')
      const loanPrograms = Array.isArray(parsed.loan_programs) ? parsed.loan_programs.map(String) : []
      const minFico = Number(parsed.min_fico) > 0 ? Math.round(Number(parsed.min_fico)) : null
      const maxLtv = Number(parsed.max_ltv) > 0 ? Number(parsed.max_ltv) : null
      const states = Array.isArray(parsed.states_available) ? parsed.states_available.map(String) : []
      const keyReqs = Array.isArray(parsed.key_requirements) ? parsed.key_requirements.map(String) : []
      const rawExcerpt = String(parsed.raw_excerpt || '')

      // Upload the raw PDF to the lender-guidelines storage bucket so Guideline AI
      // (and the lender modal preview) can fetch it via a public URL.
      const safeFileName = (file_name || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_')
      let publicUrl: string | null = null
      try {
        const fileBytes = Uint8Array.from(atob(file_base64), (c) => c.charCodeAt(0))
        const { error: storageErr } = await sb.storage
          .from('lender-guidelines')
          .upload(safeFileName, fileBytes, { contentType: 'application/pdf', upsert: true })
        if (storageErr) {
          console.error('[lender] Storage upload failed:', storageErr.message)
        } else {
          publicUrl = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/lender-guidelines/${encodeURIComponent(safeFileName)}`
        }
      } catch (storageEx) {
        console.error('[lender] Storage exception:', (storageEx as Error).message)
      }

      // Upsert into lender_guidelines (onConflict: lender_id + file_name).
      // Same lender re-uploading the same filename overwrites the existing row.
      const { data: row, error: upsertErr } = await sb.from('lender_guidelines').upsert({
        lender_id: lender_id || null,
        title: title || file_name?.replace(/\.pdf$/i, '') || 'Untitled',
        category: docCategory,
        file_name: safeFileName,
        file_url: publicUrl,
        file_type: file_type || 'application/pdf',
        version: version || null,
        content_notes: notes || null,
        is_active: true,
        ocr_status: 'completed',
        ocr_text: rawExcerpt,
        ocr_completed_at: new Date().toISOString(),
        extracted_text: rawExcerpt,
        ai_summary: summary,
        ai_indexed_at: new Date().toISOString(),
        key_requirements: keyReqs.length ? keyReqs : null,
        min_fico: minFico,
        max_ltv: maxLtv,
        states_available: states.length ? states : null,
        loan_types: loanPrograms.length ? loanPrograms : null,
        upload_source: 'lender_modal',
        source_type: 'lender',
        updated_at: new Date().toISOString()
      }, { onConflict: 'lender_id,file_name' }).select('id').single()

      if (upsertErr) {
        console.error('[lender] DB upsert failed:', upsertErr.message)
        return jsonErr(500, 'DB upsert failed: ' + upsertErr.message)
      }

      return new Response(JSON.stringify({
        success: true,
        document_id: row?.id,
        file_url: publicUrl,
        summary,
        loan_programs: loanPrograms,
        min_fico: minFico,
        max_ltv: maxLtv,
        states_available: states,
        key_requirements: keyReqs
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

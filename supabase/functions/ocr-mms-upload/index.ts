// ocr-mms-upload v4
// v4: populate ocr_jobs.document_id = uploaded_documents.id so the SMS activity
// dashboard can join OCR rows to upload rows cleanly. FK constraint dropped in
// migration drop_ocr_jobs_document_id_fkey (was unused; NULL in all 66 prior rows).
// v3: inlined Claude Vision Haiku 4.5 (anthropic-beta pdfs-2024-09-25); paystub
// prompt is the v82 textract-ocr prompt verbatim.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireStaff } from '../_shared/require-staff.ts'

/* LEGACY, being retired. Step 1 of 3 in the rotation: this deploy accepts both
   the old literal and the real guard, so no caller is refused while the callers
   are moved. Deleted in the final step — do not add a new caller to it. */
const LEGACY_SHARED_SECRET = 'rr-cron-2026-x7k3m9pq2r5tw8z4y6h8b3n1'
const STORAGE_BUCKET = 'borrower-documents'
const SMS_MAX = 1500
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'

const DOC_TYPE_MAP: Record<string, string> = {
  'Pay Stubs': 'pay_stubs', 'Pay Stub': 'pay_stubs',
  'W-2': 'w2',
  'Bank Statements': 'bank_statements', 'Bank Statement': 'bank_statements',
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    binary += String.fromCharCode.apply(null, Array.from(slice) as number[])
  }
  return btoa(binary)
}

function money(s: any): string {
  if (!s) return '?'
  const cleaned = String(s).replace(/[^0-9.-]/g, '')
  const n = parseFloat(cleaned)
  if (isNaN(n) || n <= 0) return '?'
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function extractionPromptFor(docTypeKey: string): { template: string; hint: string; docLabel: string } {
  if (docTypeKey === 'pay_stubs') {
    return {
      docLabel: 'Pay Stub',
      template: '{"employer_name":"","employer_street":"","employer_city":"","employer_state":"","employer_zip":"","first_name":"","last_name":"","gross_pay":"","net_pay":"","pay_period_start":"MM/DD/YYYY","pay_period_end":"MM/DD/YYYY","ytd_gross":"","pay_elements":[{"name":"","current":"","ytd":""}]}',
      hint: 'CRITICAL paystub field mapping (lender standard).\n\nMULTI-PAYSTUB PROTOCOL (read this first, applies before any other field extraction): If the document contains MORE THAN ONE paystub (multi-page PDFs commonly bundle 2-4 paystubs), follow this two-step procedure: STEP 1 — scan every page and identify each distinct paystub by its pay_period_end date (the date the work period covers, NOT the check date). STEP 2 — extract ALL fields ONLY from the SINGLE paystub with the LATEST (most recent) pay_period_end. Do NOT mix data across paystubs. Do NOT extract from an older paystub even if it appears first in the document or has cleaner formatting. Do NOT average across paystubs. If only one paystub is present, this step is a no-op.\n\nFIELD MAPPING: gross_pay = CURRENT pay period gross earnings only (look for column labeled "Current", "This Period", or the period-only earnings line). NOT YTD. Usually labeled "Gross Pay", "Total Earnings", "Current Gross", or "Period Gross". net_pay = CURRENT pay period net (take-home after taxes/deductions for this period only). ytd_gross = YEAR-TO-DATE gross from a YTD column (cumulative from Jan 1 of the year). pay_period_start + pay_period_end = the dates THIS paycheck COVERS (work period), NOT the pay date / check date / advice date.\n\nEMPLOYER HEADER: The employer header block (usually top-left) contains the company NAME + ADDRESS: employer_name = company name only (first line). employer_street = street address (concatenate multiple lines with space if present). employer_city = city only. employer_state = 2-letter state abbreviation (e.g. "CA"). employer_zip = ZIP code (5-digit or 5+4). first_name + last_name = employee name (split). All money fields digits only (no $, no commas). Proper-case the employer name + address fields.\n\npay_elements EXTRACTION: pay_elements is an ARRAY of income line items from the paystub Earnings / Pay Elements section. Common types include Regular / Base Pay / Salary, Overtime (or O.T. / OT), Holiday, Vacation, Sick, Bonus, Commission, Night Shift / Shift Differential, Hazard Pay, Tips, Reimbursements, Mileage, Per Diem, Incentive. For EACH line item in the Earnings/Pay Elements section: name = the line label as printed (e.g. "Regular", "Overtime", "Night Shift"). current = the CURRENT pay period amount for that line (digits only, no $, no commas).\n\nytd FIELD (CRITICAL — read carefully): ytd = the YEAR-TO-DATE amount for that line ONLY IF a real YTD value is EXPLICITLY printed in a YTD column for THAT specific line item (digits only). Many paystubs print YTD totals ONLY on the summary/totals row (e.g. "YTD Gross" or "Total YTD" at the top or bottom) and LEAVE THE PER-ELEMENT YTD COLUMN BLANK, MISSING, OR ABSENT for individual earnings rows. In that case, return empty string "" for ytd. ABSOLUTELY DO NOT: copy the current value into ytd, estimate YTD from current × pay periods, calculate YTD by any means, or use the current value as a fallback when YTD is blank. Only populate ytd when an actual YTD number is printed in a YTD column on the same row as that element. If the only YTD value visible on the paystub is the top-level ytd_gross total, then EVERY pay_elements entry should have ytd = "".\n\nFILTERING: Skip lines where current AND ytd are both zero or blank. Skip total/subtotal rows ("Total Gross Pay", "Total Earnings", "Net Pay"). Skip deductions (taxes, retirement, insurance, 401k, FICA, Medicare, AOCDS, federal tax, state tax, etc.) — pay_elements is INCOME only. If a paystub does not break out line items (rare — usually salaried admin), return pay_elements with a single entry {"name":"Regular","current":"<gross_pay>","ytd":"<ytd_gross>"}.',
    }
  }
  if (docTypeKey === 'w2') {
    return {
      docLabel: 'W-2',
      template: '{"employer_name":"","employer_street":"","employer_city":"","employer_state":"","employer_zip":"","employee_first_name":"","employee_last_name":"","wages":"","federal_tax_withheld":"","tax_year":"","ssn":""}',
      hint: 'wages = Box 1 (federal taxable wages). federal_tax_withheld = Box 2. Box c contains employer name + address (employer_name = first line, employer_street, employer_city, employer_state 2-letter, employer_zip). Box e = employee name (split first/last). tax_year = 4-digit year at top. ssn = Box a (digits only). If multiple copies of same W-2 appear, extract from one. If multiple employers, extract from first. Money fields digits only.',
    }
  }
  // bank_statements
  return {
    docLabel: 'Bank Statement',
    template: '{"bank_name":"","account_type":"","account_number":"","total_balance":"","statement_start_date":"MM/DD/YYYY","statement_end_date":"MM/DD/YYYY","account_holder_first_name":"","account_holder_last_name":"","street_address":"","city":"","state":"","zip_code":""}',
    hint: 'total_balance is ending balance, digits only. Dates MM/DD/YYYY. account_holder name identifies which borrower. Proper-case names.',
  }
}

async function runOcr(b64: string, docTypeKey: string, anthropicKey: string): Promise<{ fields: Record<string, any>; raw: string; err?: string }> {
  const { template, hint, docLabel } = extractionPromptFor(docTypeKey)
  const promptText = `Extract fields from this ${docLabel}. Return ONLY JSON: ${template}. ${hint} ONLY JSON.`
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'pdfs-2024-09-25',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1536,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
          { type: 'text', text: promptText },
        ],
      }],
    }),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    return { fields: {}, raw: '', err: `Claude ${resp.status}: ${errText.slice(0, 200)}` }
  }
  const cd = await resp.json()
  const text: string = cd?.content?.[0]?.text || '{}'
  let parsed: any = {}
  try {
    const m = text.match(/\{[\s\S]*\}/)
    if (m) parsed = JSON.parse(m[0])
  } catch (e) { /* parse err */ }
  // Clean: drop null/N/A, preserve arrays + objects, stringify primitives
  const fields: Record<string, any> = {}
  for (const k of Object.keys(parsed)) {
    const val = parsed[k]
    if (val == null || val === 'null' || val === 'N/A') continue
    if (typeof val === 'object') fields[k] = val
    else if (val) fields[k] = String(val)
  }
  return { fields, raw: text }
}

serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  /* HEADER ONLY. The `?secret=` query-parameter path was removed 2026-08-15.

     A credential in a URL is written down everywhere the URL is: edge request
     logs, pg_net's net._http_request_queue and net._http_response rows, browser
     history, any proxy in between. A header is not. proactive-followups carried
     exactly this defect and had it removed for exactly this reason — the same
     mistake in two functions is a pattern, not an oversight.

     Removing it needed no migration: both callers already send the header, and
     both were checked rather than assumed — sms-assistant (index.ts:1082) and
     the trigger_ocr_on_uploaded_document DB trigger, whose DEPLOYED source was
     read from pg_proc, not just the repo copy. No pg_cron job and no n8n
     workflow invokes this function at all.

     Note `url` is no longer read here; it was only ever parsed to reach the
     query string. */
  /* ROTATION, step 1 of 3 (2026-08-15). DUAL-ACCEPT.

     The secret this used to compare against was a literal committed in three
     files — here, sms-assistant, and the DB trigger — so it sits in git history
     on every branch and cannot be un-published. See
     docs/OCR-SHARED-SECRET-2026-08-15.md.

     Rotating it to a NEW literal would have re-created the same defect with a
     different string. Instead the secret is being RETIRED: requireStaff already
     accepts the service key (sms-assistant holds one) and, with allowInternal,
     an x-internal-secret that Postgres reads from the VAULT at call time via
     verify_cron_secret — a credential that never exists outside the database.
     That also collapses one more of this project's competing cron-secret
     conventions, which is how the CRON_KEY rotation missed three workflows.

     Both are accepted for now because a function deploy and a DB trigger change
     cannot land atomically. Guarding first would refuse the trigger until the
     trigger is changed; changing the trigger first would refuse it until this
     deploys. */
  const auth = await requireStaff(req, { allowInternal: true, what: 'OCR of an MMS upload' })
  const legacy = (req.headers.get('x-cron-secret') || '').trim()
  /* Non-empty check first: an absent header must never equal an absent secret. */
  const legacyOk = legacy !== '' && legacy === LEGACY_SHARED_SECRET
  if (!auth.ok && !legacyOk) {
    console.error('[ocr-mms-upload] REJECTED:', auth.status, auth.msg)
    return new Response('Forbidden', { status: 403 })
  }
  if (legacyOk && !auth.ok) console.warn('[ocr-mms-upload] LEGACY SECRET USED — caller still needs migrating')

  let body: any = {}
  try { body = await req.json() } catch { /* ok */ }
  const documentId: string = body?.uploaded_document_id || body?.id
  if (!documentId) return new Response(JSON.stringify({ error: 'uploaded_document_id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') || Deno.env.get('CLAUDE_API_KEY') || ''
  if (!anthropicKey) return new Response(JSON.stringify({ error: 'no_anthropic_key' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  const sb = createClient(supabaseUrl, serviceKey)

  const { data: doc, error: docErr } = await sb.from('uploaded_documents')
    .select('id, contact_id, document_type, file_name, file_size, file_path, storage_path, gdrive_file_url')
    .eq('id', documentId).single()
  if (docErr || !doc) return new Response(JSON.stringify({ error: 'document_not_found', detail: docErr?.message }), { status: 404, headers: { 'Content-Type': 'application/json' } })

  const docTypeRaw = String(doc.document_type || '').trim()
  const docTypeKey = DOC_TYPE_MAP[docTypeRaw]
  if (!docTypeKey) return new Response(JSON.stringify({ skipped: true, reason: 'not_ocr_eligible', document_type: docTypeRaw }), { headers: { 'Content-Type': 'application/json' } })

  const { data: contact } = await sb.from('contacts').select('first_name, last_name').eq('id', doc.contact_id).maybeSingle()
  const borrowerName = `${(contact as any)?.first_name || ''} ${(contact as any)?.last_name || ''}`.trim() || '(borrower)'

  const path: string = doc.storage_path || doc.file_path
  if (!path) return new Response(JSON.stringify({ error: 'no_storage_path' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  const { data: fileBlob, error: dlErr } = await sb.storage.from(STORAGE_BUCKET).download(path)
  if (dlErr || !fileBlob) return new Response(JSON.stringify({ error: 'storage_download_failed', detail: dlErr?.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  const bytes = new Uint8Array(await fileBlob.arrayBuffer())
  const b64 = bytesToBase64(bytes)

  // Inline Claude Vision OCR
  const t0 = Date.now()
  const ocrResult = await runOcr(b64, docTypeKey, anthropicKey)
  const ocrMs = Date.now() - t0
  if (ocrResult.err) return new Response(JSON.stringify({ error: 'ocr_failed', detail: ocrResult.err, ocr_ms: ocrMs }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  const fields = ocrResult.fields
  const fieldCount = Object.keys(fields).length

  let summary = ''
  if (docTypeKey === 'pay_stubs') {
    const employer = String(fields.employer_name || '(employer?)').slice(0, 40)
    const gross = money(fields.gross_pay)
    const ytd = money(fields.ytd_gross)
    const period = fields.pay_period_end ? ` ending ${fields.pay_period_end}` : ''
    summary = `OCR ${borrowerName} paystub${period}: ${employer} · ${gross} gross · YTD ${ytd}`
    if (Array.isArray(fields.pay_elements) && fields.pay_elements.length > 0) {
      const els = fields.pay_elements
        .filter((e: any) => e && e.current && String(e.current).replace(/[^0-9.]/g, '') !== '0' && String(e.current).replace(/[^0-9.]/g, '') !== '')
        .slice(0, 4)
        .map((e: any) => `${String(e.name || '?').slice(0, 12)}: ${money(e.current)}`)
        .join(', ')
      if (els) summary += `. ${els}`
    }
  } else if (docTypeKey === 'w2') {
    summary = `OCR ${borrowerName} W-2 ${fields.tax_year || '?'}: ${String(fields.employer_name || '?').slice(0, 40)} · wages ${money(fields.wages)}`
  } else if (docTypeKey === 'bank_statements') {
    const end = fields.statement_end_date || ''
    summary = `OCR ${borrowerName} bank stmt: ${String(fields.bank_name || '?').slice(0, 40)} ${String(fields.account_type || '').slice(0, 20)} · Balance ${money(fields.total_balance)}${end ? ' · ' + end : ''}`
  }

  // Save contact_note with full extraction
  const noteText = `[SMS OCR — ${docTypeRaw}] ${doc.file_name}\n${summary}\n\nFull extraction:\n${JSON.stringify(fields, null, 2)}`
  const { data: insertedNote } = await sb.from('contact_notes').insert({
    contact_id: doc.contact_id, note_text: noteText, source: 'sms_ocr', author_display: 'SMS OCR', tags: ['sms', 'ocr', docTypeKey],
  }).select('id').single()

  // Also save to ocr_jobs for consistency with textract-ocr.
  // v4: populate document_id with uploaded_documents.id so SMS dashboard joins cleanly.
  // (FK constraint was dropped; loose reference, accepts uploaded_documents.id or borrower_documents.id.)
  await sb.from('ocr_jobs').insert({
    contact_id: doc.contact_id,
    document_id: doc.id,
    file_name: doc.file_name,
    s3_key: 'claude-vision-sms',
    textract_job_id: 'sms-ocr-' + Date.now(),
    status: 'completed',
    extracted_fields: fields,
    completed_at: new Date().toISOString(),
  })

  // Send Twilio SMS
  let twilioSent = false
  let twilioError: string | null = null
  if (summary) {
    const fromNumber = Deno.env.get('SMS_ASSISTANT_FROM_NUMBER') || Deno.env.get('TWILIO_PHONE_NUMBER') || ''
    const toPhone = (Deno.env.get('AUTHORIZED_PHONES') || '').split(',').map(s => s.trim()).filter(Boolean)[0]
    /* Twilio credentials are no longer read here; sms-service holds them. Left
       in the condition they would have gated a routed send on an env var this
       path no longer touches, and reported 'twilio_creds_missing' for a send
       that was fine. */
    if (fromNumber && toPhone) {
      try {
        /* ROUTED THROUGH sms-service (2026-08-15). Was a direct Twilio POST,
           so quietHours() was never evaluated for it — see
           docs/SMS-BYPASSES-QUIET-HOURS-2026-08-15.md.

           bypass = 'staff_alert'. `toPhone` is AUTHORIZED_PHONES[0], i.e. Rene:
           this is the summary of a document HE just MMS'd in, sent back to him.
           The doc listed this function under 'user_initiated' on the strength
           of that reply shape, which is true but weaker — the recipient is read
           from a staff env var and can never be a borrower.

           SMS_ASSISTANT_FROM_NUMBER is passed through so the summary stays on
           the same thread as the MMS it answers. */
        const twResp = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/sms-service`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json',
                     'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
                     'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''}` },
          body: JSON.stringify({ trigger: 'mms_upload_ack', to_phone: toPhone,
                                 params: { message: summary.slice(0, SMS_MAX) },
                                 from_phone: fromNumber, quiet_hours_bypass: 'staff_alert' }),
        })
        const twData = await twResp.json().catch(() => ({}))
        if (twResp.ok && (twData as { sent?: boolean }).sent) twilioSent = true
        else { twilioError = (twData as { error?: string }).error || `sms_service_${twResp.status}`; console.error('[ocr] sms-service:', twilioError) }
      } catch (err) { twilioError = (err as Error).message }
    } else twilioError = 'sms_from_or_to_missing'
  }

  return new Response(JSON.stringify({
    success: true, document_id: doc.id, contact_id: doc.contact_id, contact_name: borrowerName,
    doc_type: docTypeKey, doc_type_label: docTypeRaw, fields_extracted: fieldCount, ocr_ms: ocrMs,
    summary, fields, note_id: (insertedNote as any)?.id || null,
    twilio_sent: twilioSent, twilio_error: twilioError,
  }), { headers: { 'Content-Type': 'application/json' } })
})

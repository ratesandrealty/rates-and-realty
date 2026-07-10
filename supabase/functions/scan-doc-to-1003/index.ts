// scan-doc-to-1003 v1 — Claude-vision doc reader that extracts 1003 (URLA) fields for review.
// On-demand: frontend sends a doc (base64 image OR pdf) + optional doc_type; returns mapped
// 1003 fields (mortgage_applications column names) for the user to approve, then prefill the form.
// Does NOT write to the DB — review-first by design. verify_jwt=false (CORS-safe).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-region, x-requested-with' };
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY');

// Extractable 1003 fields -> mortgage_applications columns. null when not present in the doc.
const FIELDS = [
  'first_name','middle_name','last_name','suffix','ssn','date_of_birth','marital_status','citizenship',
  'home_phone','cell_phone','email',
  'current_address_street','current_address_unit','current_address_city','current_address_state','current_address_zip',
  'dl_number','dl_state','dl_expiry',
  'employer_name','employer_phone','employer_street','employer_city','employer_state','employer_zip',
  'position_title','employment_start_date','is_self_employed',
  'base_income','overtime_income','bonus_income','commission_income','total_monthly_income','ytd_gross_income','pay_frequency',
  'bank_name','account_type','account_last4','ending_balance',
  'property_address_street','property_address_city','property_address_state','property_address_zip',
  'purchase_price','property_value','credit_score'
];

const PROMPT = `You are a mortgage loan-processing assistant. The attached document is a single borrower document — it may be a pay stub, W-2, bank statement, driver's license / state ID, purchase contract, or similar.

Extract every field below that the document actually contains, and return ONLY one JSON object (no markdown, no commentary). Use null for anything not present — NEVER guess or infer values that aren't shown.

Return exactly these keys:
{
  "detected_doc_type": "one of: Pay Stub, W-2, Bank Statement, Driver License, Purchase Contract, Other",
  "first_name": null, "middle_name": null, "last_name": null, "suffix": null,
  "ssn": "digits only or null", "date_of_birth": "YYYY-MM-DD or null",
  "marital_status": null, "citizenship": null,
  "home_phone": "digits only or null", "cell_phone": "digits only or null", "email": null,
  "current_address_street": null, "current_address_unit": null, "current_address_city": null,
  "current_address_state": "2-letter or null", "current_address_zip": null,
  "dl_number": null, "dl_state": "2-letter or null", "dl_expiry": "YYYY-MM-DD or null",
  "employer_name": null, "employer_phone": "digits only or null",
  "employer_street": null, "employer_city": null, "employer_state": "2-letter or null", "employer_zip": null,
  "position_title": null, "employment_start_date": "YYYY-MM-DD or null",
  "is_self_employed": "true/false or null",
  "base_income": "MONTHLY gross base pay as a plain number, or null",
  "overtime_income": "monthly, plain number or null", "bonus_income": "monthly, plain number or null",
  "commission_income": "monthly, plain number or null",
  "total_monthly_income": "total monthly gross, plain number or null",
  "ytd_gross_income": "year-to-date gross from a pay stub, plain number or null",
  "pay_frequency": "Weekly / Biweekly / Semimonthly / Monthly / Annual, or null",
  "bank_name": null, "account_type": "Checking/Savings or null", "account_last4": null,
  "ending_balance": "statement ending balance, plain number or null",
  "property_address_street": null, "property_address_city": null,
  "property_address_state": "2-letter or null", "property_address_zip": null,
  "purchase_price": "plain number or null", "property_value": "plain number or null",
  "credit_score": "integer or null"
}

Rules:
- Amounts: plain numbers only, no $ or commas.
- Income: if a pay stub shows a per-period amount, CONVERT base_income to a MONTHLY figure using pay_frequency (weekly*52/12, biweekly*26/12, semimonthly*2, monthly as-is) and report pay_frequency. If you cannot determine frequency, leave base_income null and put the raw figure logic in null rather than guessing.
- Phones/SSN: digits only.
- Dates: YYYY-MM-DD.
- Do not invent data. Return the JSON object only.`;

function cleanB64(b64: string): string {
  let s = b64.includes(',') ? b64.split(',')[1] : b64;
  return s.replace(/ /g, '+').replace(/[\r\n\t]/g, '').trim();
}
function isPdf(m?: string): boolean { return (m || '').toLowerCase().includes('pdf'); }
function normImageMime(m?: string): string {
  const x = (m || '').toLowerCase();
  if (x.includes('png')) return 'image/png';
  if (x.includes('webp')) return 'image/webp';
  if (x.includes('gif')) return 'image/gif';
  return 'image/jpeg';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok  = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type':'application/json' } });
  const bad = (m: string, detail?: string) => new Response(JSON.stringify({ ok:false, error:m, detail }), { headers: { ...cors, 'Content-Type':'application/json' } });

  try {
    if (!ANTHROPIC_KEY) return bad('AI key not configured');
    const body = await req.json().catch(() => ({}));
    const raw = body.file || body.image || body.file_base64 || body.image_base64;
    if (!raw) return bad('file (base64) required');
    const data = cleanB64(raw);
    const mime = body.media_type || body.mime_type || '';

    const source = isPdf(mime)
      ? { type:'document', source:{ type:'base64', media_type:'application/pdf', data } }
      : { type:'image', source:{ type:'base64', media_type: normImageMime(mime), data } };

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version':'2023-06-01', 'content-type':'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role:'user', content: [ source, { type:'text', text: PROMPT } ] }]
      })
    });
    if (!res.ok) { const t = await res.text(); console.error('Claude error:', t); return bad('AI request failed', t.slice(0,300)); }
    const out = await res.json();
    const text = out?.content?.find((c: any) => c.type === 'text')?.text || out?.content?.[0]?.text || '{}';
    let parsed: any = {};
    try { parsed = JSON.parse(text.replace(/```json|```/g,'').trim()); }
    catch (e) { console.error('parse error:', e, text.slice(0,300)); return bad('Could not read the document. Try a clearer scan.'); }

    const fields: Record<string, any> = {};
    let found = 0;
    for (const k of FIELDS) {
      let v = parsed[k];
      if (v === undefined || v === '' || v === 'null') v = null;
      if (v !== null && (k === 'ssn' || k.endsWith('phone'))) v = String(v).replace(/\D/g,'') || null;
      if (v !== null) found++;
      fields[k] = v;
    }
    return ok({ ok:true, detected_doc_type: parsed.detected_doc_type || null, fields, found });
  } catch (e: any) {
    console.error('scan-doc-to-1003 error:', e);
    return bad(e?.message || 'Server error');
  }
});

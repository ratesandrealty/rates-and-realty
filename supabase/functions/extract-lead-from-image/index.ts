import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Broadened Access-Control-Allow-Headers to include x-client-info / x-supabase-api-version
// (supabase-js functions.invoke() sends these; omitting them made the browser CORS preflight fail
//  -> "Failed to send a request to the Edge Function"). Everything else unchanged.
const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-region, x-requested-with' };
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY');

const FIELDS = [
  'first_name','last_name','email','phone','secondary_phone','address','city','state','zip',
  'date_of_birth','loan_type','loan_purpose','loan_amount','purchase_price','property_address',
  'credit_score','company','lead_source','notes'
];

const PROMPT = `You are a data-entry assistant for a mortgage CRM. The attached image is a screenshot or photo containing information about a new lead/borrower. It could be a CRM lead card, a Zillow/Realtor.com/LendingTree lead, a text message, an email, a business card, a handwritten note, or a web form.

Extract the person's information and return ONLY a single JSON object (no markdown, no commentary) with exactly these keys. Use null for anything not present — never guess.

{
  "first_name": "given name only",
  "last_name": "family name only",
  "email": "email address",
  "phone": "primary phone, digits only, 10 digits if US (e.g. 7145551234)",
  "secondary_phone": "second phone digits only or null",
  "address": "street address of where they live (line 1)",
  "city": "city",
  "state": "2-letter state code",
  "zip": "postal code",
  "date_of_birth": "YYYY-MM-DD or null",
  "loan_type": "e.g. Conventional, FHA, VA, DSCR, Jumbo — only if stated",
  "loan_purpose": "Purchase or Refinance — only if stated",
  "loan_amount": "requested loan amount as a plain number, no $ or commas, or null",
  "purchase_price": "purchase price / home value as a plain number, no $ or commas, or null",
  "property_address": "the SUBJECT PROPERTY address if different from where they live, else null",
  "credit_score": "credit score as an integer or null",
  "company": "employer/company or null",
  "lead_source": "where the lead came from (e.g. Zillow, Referral, Website) or null",
  "notes": "any other useful detail in one short sentence, or null"
}

Rules:
- If only a full name appears, split it: first token -> first_name, the rest -> last_name.
- Phones: strip spaces, dashes, parentheses, and leading +1/1. Return only digits.
- Do not invent data. If unsure, use null.
- Return the JSON object only.`;

// Standard base64 never contains spaces or newlines. Some transports turn '+' into ' '. Repair that.
function cleanB64(b64: string): string {
  let s = b64.includes(',') ? b64.split(',')[1] : b64;
  s = s.replace(/ /g, '+').replace(/[\r\n\t]/g, '').trim();
  return s;
}
function normMime(m?: string): string {
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
    const raw = body.image || body.image_base64 || body.file_base64;
    if (!raw) return bad('image (base64) required');
    const media_type = normMime(body.media_type || body.mime_type);
    const data = cleanB64(raw);

    if (body.debug === true) {
      return ok({ debug:true, in_len: raw.length, out_len: data.length, in_had_space: raw.includes(' '), out_mod4: data.length % 4, head: data.slice(0,24) });
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version':'2023-06-01', 'content-type':'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        messages: [{ role:'user', content: [
          { type:'image', source:{ type:'base64', media_type, data } },
          { type:'text', text: PROMPT }
        ] }]
      })
    });

    if (!res.ok) { const t = await res.text(); console.error('Claude error:', t); return bad('AI request failed', t.slice(0,300)); }
    const out = await res.json();
    const text = out?.content?.[0]?.text || '{}';
    let parsed: any = {};
    try { parsed = JSON.parse(text.replace(/```json|```/g,'').trim()); }
    catch (e) { console.error('parse error:', e, text.slice(0,300)); return bad('Could not read the image. Try a clearer screenshot.'); }

    const fields: Record<string, any> = {};
    let found = 0;
    for (const k of FIELDS) {
      let v = parsed[k];
      if (v === undefined || v === '' || v === 'null') v = null;
      if (v !== null && (k === 'phone' || k === 'secondary_phone')) v = String(v).replace(/\D/g,'') || null;
      if (v !== null) found++;
      fields[k] = v;
    }
    return ok({ ok:true, fields, found });
  } catch (e: any) {
    console.error('extract-lead-from-image error:', e);
    return bad(e?.message || 'Server error');
  }
});

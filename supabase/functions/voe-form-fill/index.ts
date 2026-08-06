import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { PDFDocument } from 'npm:pdf-lib@1.17.1';
import { requireStaff } from '../_shared/require-staff.ts';

/* voe-form-fill — merge Part I of Request_for_VOE_BLANK.pdf from CRM data.
 *
 * WHY AN EDGE FUNCTION AND NOT THE BROWSER
 * One place, and the browser never merges borrower data. The composer used to
 * fetch the blank and attach it untouched; it now asks for the filled bytes.
 *
 * WHAT IS FILLED — Part I only, the broker's half:
 *   voe_loan_number     Loan #
 *   voe_employer_block  Item 1  To (name and address of employer)
 *   voe_date            Item 5  Date
 *   voe_applicant_block Item 7  Name and address of applicant
 * Item 2 (broker block) is pre-printed on the form. Item 8 is the applicant
 * signature, covered by the attached Borrower Authorization. Part II's 56 fields
 * belong to HR and are LEFT EDITABLE — the form is useless to them otherwise,
 * which is why this does NOT call form.flatten(). Part I is marked read-only
 * instead, so HR cannot alter what we asserted.
 *
 * A MISSING FIELD REFUSES TO ATTACH. If the stored blank is ever replaced with a
 * fresh download from the agency, the four named fields vanish. getTextField()
 * throws, and this returns 4xx with the field name rather than a half-filled
 * form. Sending an outside HR contact a VOE with the employer block blank is
 * worse than sending nothing, and this must not be swallowed the way sendRaw's
 * bare catch swallows e-signature failures.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUCKET = 'borrower-documents';
const REQUIRED = ['voe_loan_number', 'voe_employer_block', 'voe_date', 'voe_applicant_block'];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

function b64(bytes: Uint8Array): string {
  let bin = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

/* The path inside the bucket, from whatever app_config holds — it has stored a
 * full public URL at least once, so accept either form rather than assuming. */
function pathOf(v: string): string {
  const m = String(v || '').match(/\/borrower-documents\/(.+?)(?:\?|$)/);
  return m ? decodeURIComponent(m[1]) : String(v || '');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = await requireStaff(req, { what: 'Filling the VOE form' });
  if (!auth.ok) return json({ error: auth.msg || 'not authorized' }, auth.status || 401);

  try {
    const body = await req.json().catch(() => ({}));
    const orderId = body.order_id;
    if (!orderId) return json({ error: 'order_id required' }, 400);

    const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    const { data: order } = await db.from('loan_orders')
      .select('id, contact_id, employer_name, hr_contact_name, order_type').eq('id', orderId).maybeSingle();
    if (!order) return json({ error: 'order not found' }, 404);

    const { data: c } = await db.from('contacts')
      .select('first_name,last_name,address,city,state,zip,property_address,crm_id')
      .eq('id', order.contact_id).maybeSingle();

    const { data: app } = await db.from('mortgage_applications')
      .select('id, loan_number, employments, employer_street, employer_city, employer_state, employer_zip, prev_employer_street, prev_employer_city, prev_employer_state, prev_employer_zip, employer_name, prev_employer_name')
      .eq('contact_id', order.contact_id).order('created_at', { ascending: false }).limit(1).maybeSingle();

    /* Employer address: match the ORDER's employer against the application's
     * current/previous blocks rather than assuming current — the picker can
     * select a PREVIOUS employer, which is the whole point of it.
     *
     * Then fall back to the employments JSONB, because the flat columns are
     * frequently empty where the JSONB is not: on the file this was built
     * against, prev_employer_street/city/state/zip are all NULL while the JSONB
     * entry carries "950 North Burke Street, Visalia, CA, USA". Reading only the
     * flat columns produced an Item 1 with the employer NAME and no address —
     * a half-filled box, which is the thing this function exists to prevent. */
    const emp = String(order.employer_name || '').trim();
    const same = (a: unknown) => String(a || '').trim().toLowerCase() === emp.toLowerCase();
    let addr: string[] = [];
    if (app && same(app.prev_employer_name)) {
      addr = [app.prev_employer_street, [app.prev_employer_city, app.prev_employer_state, app.prev_employer_zip].filter(Boolean).join(', ')];
    } else if (app) {
      addr = [app.employer_street, [app.employer_city, app.employer_state, app.employer_zip].filter(Boolean).join(', ')];
    }
    if (!addr.filter((s) => String(s || '').trim()).length && Array.isArray(app?.employments)) {
      const hit = (app!.employments as any[]).find((e) => same(e?.employer));
      if (hit) addr = [hit.street, [hit.city, hit.state_zip].filter(Boolean).join(', ')];
    }
    const employerBlock = [emp, ...addr].map(s => String(s || '').trim()).filter(Boolean).join('\n');

    const applicantName = [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim();
    const applicantBlock = [applicantName,
      c?.address, [c?.city, c?.state, c?.zip].filter(Boolean).join(', ')]
      .map(s => String(s || '').trim()).filter(Boolean).join('\n');

    const loanNumber = String(app?.loan_number || c?.crm_id || '').trim();
    const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });

    // stored blank
    const { data: cfg } = await db.from('app_config').select('value').eq('key', 'voe_form_url').maybeSingle();
    if (!cfg?.value) return json({ error: 'voe_form_url is not configured' }, 409);
    const { data: file, error: dlErr } = await db.storage.from(BUCKET).download(pathOf(cfg.value));
    if (dlErr || !file) return json({ error: 'could not read the VOE form: ' + (dlErr?.message || 'missing') }, 502);

    const pdf = await PDFDocument.load(new Uint8Array(await file.arrayBuffer()));
    const form = pdf.getForm();

    /* Refuse rather than half-fill. Checked BEFORE writing anything so the
     * failure is all-or-nothing. */
    const present = new Set(form.getFields().map((f) => f.getName()));
    const missing = REQUIRED.filter((n) => !present.has(n));
    if (missing.length) {
      return json({
        error: 'The stored VOE form is missing field(s): ' + missing.join(', ')
             + '. It was probably replaced with a blank copy. Re-stage the fielded form — nothing was attached.',
        missing,
      }, 409);
    }

    const put = (name: string, value: string) => {
      const f = form.getTextField(name);
      f.setText(value || '');
      f.enableReadOnly();            // HR must not edit the broker's half
    };
    put('voe_loan_number', loanNumber);
    put('voe_employer_block', employerBlock);
    put('voe_date', today);
    put('voe_applicant_block', applicantBlock);

    /* NO flatten(): Part II's 56 fields are HR's to complete. */
    const out = await pdf.save();

    return json({
      success: true,
      filename: 'Request_for_VOE.pdf',
      content: b64(out),
      merged: { loan_number: loanNumber, employer: employerBlock, applicant: applicantBlock, date: today },
    });
  } catch (e) {
    return json({ error: (e as Error)?.message || 'fill failed' }, 500);
  }
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireStaff } from "../_shared/require-staff.ts";

// generate-mismo
// Phase 0 (de-risk): returns the loan's STORED MISMO 3.4 XML for loans imported
// from a MISMO file, so the LendingPad Import-Loan round-trip can be tested.
// SSN hard-block: the full SSN-bearing XML lives in the admin-only application_ssn
// vault; mortgage_applications.mismo_raw_xml is SSN-scrubbed. This function runs as
// service_role, so it reads the full XML from the vault (falling back to the table
// copy for loans whose XML never contained an SSN).

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};
const hdrs = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  /* GUARD FIRST — before req.json(), so an action added later is covered by
     default rather than by remembering. verify_jwt=true does NOT do this:
     the anon key is a project-signed JWT printed in every page's source, so
     the pin alone left this reachable by anyone who read the HTML.
     See docs/PINNED-NOT-GUARDED.md. */
  const _auth = await requireStaff(req);
  if (!_auth.ok) return new Response(JSON.stringify({ error: _auth.msg || 'not authorized' }),
    { status: _auth.status || 401, headers: { ...cors, 'Content-Type': 'application/json' } });
  try {
    const body = await req.json().catch(() => ({}));
    const contact_id = body.contact_id;
    if (!contact_id) return new Response(JSON.stringify({ error: 'contact_id required' }), { status: 400, headers: cors });

    const url = `${SUPABASE_URL}/rest/v1/mortgage_applications?contact_id=eq.${contact_id}` +
      `&select=id,mismo_raw_xml,mismo_file_name,last_name,mismo_imported_at` +
      `&order=created_at.desc&limit=1`;
    const res = await fetch(url, { headers: hdrs });
    const app = ((await res.json()) || [])[0] || {};

    // Prefer the full SSN-bearing XML from the admin-only vault.
    let rawXml = app.mismo_raw_xml;
    if (app.id) {
      try {
        const vres = await fetch(`${SUPABASE_URL}/rest/v1/application_ssn?application_id=eq.${app.id}&select=mismo_raw_xml&limit=1`, { headers: hdrs });
        const vrow = ((await vres.json()) || [])[0];
        if (vrow && vrow.mismo_raw_xml) rawXml = vrow.mismo_raw_xml;
      } catch (_e) { /* fall back to table copy */ }
    }

    if (!rawXml) {
      return new Response(JSON.stringify({
        error: 'no_stored_mismo',
        message: 'This loan was not imported from a MISMO file, so there is no stored XML to export yet. The data-driven generator is the next phase.',
      }), { status: 404, headers: cors });
    }

    const xml = String(rawXml);
    const bytes = new TextEncoder().encode(xml);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);

    const fileName = app.mismo_file_name ||
      `MISMO_${String(app.last_name || 'Borrower').replace(/\s/g, '_')}_${new Date().toISOString().slice(0, 10)}.xml`;

    return new Response(JSON.stringify({
      success: true,
      source: 'stored',
      xml: b64,
      file_name: fileName,
      imported_at: app.mismo_imported_at || null,
    }), { headers: cors });
  } catch (err: any) {
    console.error('[generate-mismo] Error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
  }
});

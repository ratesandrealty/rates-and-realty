import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

const headers = {
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
};

// Tables that may have a contact_id FK
const RELATED_TABLES = [
  'activity_events', 'email_log', 'sms_log', 'loan_conditions',
  'condition_documents', 'condition_notes', 'listing_alerts',
  'alert_sent_listings', 'leads', 'portal_users',
];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { contact_ids } = await req.json();
    if (!Array.isArray(contact_ids) || !contact_ids.length) {
      return new Response(JSON.stringify({ error: 'contact_ids array required' }), { status: 400, headers: cors });
    }

    console.log(`[delete-contacts] Deleting ${contact_ids.length} contacts`);
    const results: any[] = [];

    for (const id of contact_ids) {
      try {
        // Delete related records first (ignore errors for tables without FK)
        for (const table of RELATED_TABLES) {
          await fetch(`${SUPABASE_URL}/rest/v1/${table}?contact_id=eq.${id}`, {
            method: 'DELETE', headers,
          }).catch(() => {});
        }

        // Delete the contact
        const res = await fetch(`${SUPABASE_URL}/rest/v1/contacts?id=eq.${id}`, {
          method: 'DELETE', headers,
        });

        results.push({ id, success: res.ok });
        console.log(`[delete-contacts] ${id}: ${res.ok ? 'deleted' : 'failed ' + res.status}`);
      } catch (err: any) {
        console.error(`[delete-contacts] Error deleting ${id}:`, err.message);
        results.push({ id, success: false, error: err.message });
      }
    }

    const deleted = results.filter(r => r.success).length;
    return new Response(JSON.stringify({ deleted, total: contact_ids.length, results }), { headers: cors });

  } catch (err: any) {
    console.error('[delete-contacts] Fatal error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
  }
});

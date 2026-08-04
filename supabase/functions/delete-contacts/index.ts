import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

const h = {
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { contact_ids } = await req.json();
    if (!Array.isArray(contact_ids) || !contact_ids.length)
      return new Response(JSON.stringify({ error: 'contact_ids array required' }), { status: 400, headers: cors });

    console.log(`[delete-contacts] Deleting ${contact_ids.length}:`, contact_ids.join(', '));
    const results: any[] = [];

    for (const id of contact_ids) {
      try {
        // All FK constraints are now ON DELETE CASCADE so a single
        // DELETE on contacts cascades through the entire tree.
        // Only need to handle self-referential SET NULL FKs first.

        // 1. NULL out self-referential FKs on OTHER contacts pointing to this one
        await Promise.allSettled([
          fetch(`${SUPABASE_URL}/rest/v1/contacts?referred_by_contact_id=eq.${id}`, {
            method: 'PATCH', headers: h,
            body: JSON.stringify({ referred_by_contact_id: null })
          }),
          fetch(`${SUPABASE_URL}/rest/v1/contacts?primary_borrower_contact_id=eq.${id}`, {
            method: 'PATCH', headers: h,
            body: JSON.stringify({ primary_borrower_contact_id: null, is_co_borrower: false })
          }),
        ]);

        // 2. Single DELETE — Postgres CASCADE handles everything else
        const res = await fetch(`${SUPABASE_URL}/rest/v1/contacts?id=eq.${id}`, {
          method: 'DELETE', headers: h,
        });

        let errText = '';
        if (!res.ok) {
          try { errText = await res.text(); } catch(_){}
          console.error(`[delete-contacts] FAILED ${id} (${res.status}): ${errText}`);
        } else {
          console.log(`[delete-contacts] ✓ deleted ${id}`);
        }

        results.push({ id, success: res.ok, status: res.status, error: res.ok ? undefined : errText });

      } catch (e: any) {
        console.error(`[delete-contacts] Exception for ${id}:`, e.message);
        results.push({ id, success: false, error: e.message });
      }
    }

    const deleted = results.filter(r => r.success).length;
    console.log(`[delete-contacts] Done: ${deleted}/${contact_ids.length}`);
    return new Response(JSON.stringify({ deleted, total: contact_ids.length, results }), { headers: cors });

  } catch (e: any) {
    console.error('[delete-contacts] Fatal:', e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
});

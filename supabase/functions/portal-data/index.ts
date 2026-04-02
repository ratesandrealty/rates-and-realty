import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * portal-data edge function
 * Serves all data needed by the borrower portal + CRM showings page
 * Uses service role key — bypasses Cloudflare Worker API key interception
 *
 * Actions:
 * - get_showings: fetch showings by portal_user_id, email, or borrower_id
 * - get_application: fetch mortgage application by email/borrower_id/portal_user_id
 * - get_saved_homes: fetch saved listings
 * - get_all_showings: fetch all showings (admin CRM use)
 * - get_documents: fetch uploaded documents by contact_id, portal_user_id, or lead_id
 */

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info'
};

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const url = new URL(req.url);
    const action = body.action || url.searchParams.get('action');

    // ─── GET SHOWINGS (portal) ───────────────────────────────────────────
    if (action === 'get_showings') {
      const { portal_user_id, email, borrower_id } = body;
      if (!portal_user_id && !email && !borrower_id) return err('portal_user_id, email or borrower_id required');

      let query = sb.from('showings').select('*').order('created_at', { ascending: false });

      if (portal_user_id) {
        query = sb.from('showings').select('*')
          .or(`portal_user_id.eq.${portal_user_id},email.eq.${email || ''},borrower_id.eq.${borrower_id || ''}`)
          .order('created_at', { ascending: false });
      } else if (email) {
        query = sb.from('showings').select('*')
          .eq('email', email.toLowerCase().trim())
          .order('created_at', { ascending: false });
      } else if (borrower_id) {
        query = sb.from('showings').select('*')
          .eq('borrower_id', borrower_id)
          .order('created_at', { ascending: false });
      }

      const { data, error } = await query;
      if (error) return err(error.message, 500);
      return ok({ showings: data || [], count: data?.length || 0 });
    }

    // ─── GET ALL SHOWINGS (CRM admin) ────────────────────────────────────
    if (action === 'get_all_showings') {
      const { data, error } = await sb.from('showings')
        .select('*, contacts(id, first_name, last_name, email, phone, crm_id)')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) return err(error.message, 500);
      return ok({ showings: data || [], count: data?.length || 0 });
    }

    // ─── GET APPLICATION ─────────────────────────────────────────────────
    if (action === 'get_application') {
      const { email, borrower_id, portal_user_id } = body;
      if (!email && !borrower_id && !portal_user_id) return err('email, borrower_id or portal_user_id required');

      let data = null;

      if (email) {
        const res = await sb.from('mortgage_applications')
          .select('*').or(`email.eq.${email},borrower_email.eq.${email}`)
          .order('updated_at', { ascending: false }).limit(1).maybeSingle();
        data = res.data;
      }
      if (!data && borrower_id) {
        const res = await sb.from('mortgage_applications')
          .select('*').eq('borrower_id', borrower_id)
          .order('updated_at', { ascending: false }).limit(1).maybeSingle();
        data = res.data;
      }
      if (!data && portal_user_id) {
        const res = await sb.from('mortgage_applications')
          .select('*').eq('borrower_user_id', portal_user_id)
          .order('updated_at', { ascending: false }).limit(1).maybeSingle();
        data = res.data;
      }
      return ok({ application: data });
    }

    // ─── SAVE APPLICATION ────────────────────────────────────────────────
    if (action === 'save_application') {
      const { email, borrower_id, portal_user_id, data: appData } = body;
      if (!email && !borrower_id) return err('email or borrower_id required');

      const { data: result, error } = await sb.rpc('save_mortgage_application', {
        p_email: email,
        p_borrower_id: borrower_id || null,
        p_borrower_user_id: portal_user_id || null,
        p_data: appData || {}
      });
      if (error) return err(error.message, 500);
      return ok(result);
    }

    // ─── GET SAVED HOMES ─────────────────────────────────────────────────
    if (action === 'get_saved_homes') {
      const { portal_user_id, contact_id, email } = body;
      let q = sb.from('saved_listings').select('*').order('created_at', { ascending: false });
      if (portal_user_id) q = q.eq('portal_user_id', portal_user_id);
      else if (contact_id) q = q.eq('contact_id', contact_id);
      else if (email) q = q.eq('email', email);
      else return err('portal_user_id, contact_id or email required');
      const { data, error } = await q;
      if (error) return err(error.message, 500);
      return ok({ saved_homes: data || [] });
    }

    // ─── GET DOCUMENTS ───────────────────────────────────────────────────
    if (action === 'get_documents') {
      const { contact_id, portal_user_id, lead_id, borrower_id, email } = body;

      // If portal_user_id provided, resolve to contact_id first
      let resolvedContactId = contact_id || null;
      if (!resolvedContactId && portal_user_id) {
        const { data: pu } = await sb.from('portal_users').select('contact_id').eq('id', portal_user_id).single();
        resolvedContactId = pu?.contact_id || null;
      }
      if (!resolvedContactId && email) {
        const { data: c } = await sb.from('contacts').select('id').eq('email', email.toLowerCase()).single();
        resolvedContactId = c?.id || null;
      }

      // Build OR filter to catch all docs for this person
      const filters: string[] = [];
      if (resolvedContactId) filters.push(`contact_id.eq.${resolvedContactId}`);
      if (lead_id) filters.push(`lead_id.eq.${lead_id}`);
      if (portal_user_id) filters.push(`portal_user_id.eq.${portal_user_id}`);
      if (borrower_id) filters.push(`borrower_id.eq.${borrower_id}`);

      if (!filters.length) return err('contact_id, portal_user_id, lead_id, borrower_id, or email required');

      const { data, error } = await sb.from('uploaded_documents')
        .select('*')
        .or(filters.join(','))
        .order('uploaded_at', { ascending: false });

      if (error) return err(error.message, 500);
      return ok({ documents: data || [] });
    }

    // ─── UPDATE SHOWING STATUS ───────────────────────────────────────────
    if (action === 'update_showing_status') {
      const { batch_id, showing_id, status } = body;
      const allowed = ['new', 'pending', 'confirmed', 'completed', 'cancelled'];
      if (!allowed.includes(status)) return err('Invalid status');

      let q = sb.from('showings').update({ status, updated_at: new Date().toISOString() });
      if (batch_id) q = q.eq('batch_id', batch_id);
      else if (showing_id) q = q.eq('id', showing_id);
      else return err('batch_id or showing_id required');

      const { error } = await q;
      if (error) return err(error.message, 500);
      return ok({ success: true, status });
    }

    return err('Unknown action: ' + action);

  } catch (e: any) {
    console.error('portal-data error:', e);
    return err(e.message || 'Server error', 500);
  }
});

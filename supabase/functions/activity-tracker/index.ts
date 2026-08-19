import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey,x-client-info' };
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

/* WHO ASKED, as opposed to who wrote.
 *
 * Every write here goes through the service role, which has no auth.uid() — so
 * activity_events.created_by was populated on 50 of 1,277 rows (3.9%) and NOT
 * ONE row in the entire database was attributable to the VA. "What she did"
 * could not be answered at all, and it is the one thing that cannot be
 * backfilled: a day that ships without this is a day of work permanently
 * unattributable.
 *
 * DELIBERATELY OPTIONAL. It returns null for an anon key, a missing header, an
 * expired token or a service-role call, and every caller carries on exactly as
 * before. This is attribution, NOT a guard — nothing is rejected on its
 * account, so it cannot cause the kind of outage the email-service guard did.
 * Callers that do not yet send a session token simply keep stamping null, and
 * start working the moment they do.
 *
 * Attribution is to the ACCOUNT, not a person: processing@ is a shared login,
 * so a stamped uid means "somebody signed in as the VA", not a named human.
 * The surfaces that display this say so. */
async function callerUid(req: Request): Promise<string | null> {
  const raw = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw || raw.split('.').length !== 3) return null;
  try {
    // The anon and service keys are well-formed JWTs too; neither has a user.
    const claims = JSON.parse(atob(raw.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!claims?.sub || claims.role === 'anon' || claims.role === 'service_role') return null;
  } catch (_) { return null; }
  try {
    const { data, error } = await sb.auth.getUser(raw);
    return (!error && data?.user?.id) ? data.user.id : null;
  } catch (_) { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const { action } = body;
    const uid = await callerUid(req);   // null unless a real user session was sent

    // Track page view
    if (action === 'page_view') {
      const { portal_user_id, contact_id, page_url, page_title, referrer, session_id, device_type } = body;
      const ua = req.headers.get('user-agent') || '';
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || '';

      // Save page view
      await sb.from('page_views').insert({
        contact_id: contact_id || null,
        portal_user_id: portal_user_id || null,
        session_id: session_id || null,
        page_url, page_title: page_title || null,
        referrer: referrer || null,
        ip_address: ip, user_agent: ua,
        device_type: device_type || null,
        created_at: new Date().toISOString()
      });

      // Log to activity_events if we have a contact
      if (contact_id) {
        const pageLabel = page_title || page_url?.split('/').pop() || 'Unknown page';
        await sb.from('activity_events').insert({
          contact_id,
          portal_user_id: portal_user_id || null,
          type: 'page_view',
          channel: 'web',
          direction: 'inbound',
          title: `Viewed: ${pageLabel}`,
          description: page_url,
          page_url,
          status: 'viewed',
          created_by: uid,
          session_id: session_id || null,
          metadata: JSON.stringify({ referrer, device_type, ip }),
          created_at: new Date().toISOString()
        });

        // Update last_contact_date
        await sb.from('contacts').update({ last_contact_date: new Date().toISOString() }).eq('id', contact_id);
      }

      return ok({ success: true });
    }

    // Track any custom event
    if (action === 'track_event') {
      const { contact_id, portal_user_id, crm_id, type, channel, direction, title, description, metadata, status } = body;
      await sb.from('activity_events').insert({
        contact_id: contact_id || null,
        portal_user_id: portal_user_id || null,
        crm_id: crm_id || null,
        type: type || 'system',
        channel: channel || 'web',
        direction: direction || 'inbound',
        title: title || 'Event',
        description: description || null,
        status: status || 'completed',
        created_by: uid,
        metadata: metadata ? JSON.stringify(metadata) : null,
        created_at: new Date().toISOString()
      });
      return ok({ success: true });
    }

    // Get activity timeline for a contact
    if (action === 'get_timeline') {
      const { contact_id, limit = 50, offset = 0 } = body;
      if (!contact_id) return ok({ events: [] });
      const { data, error } = await sb.from('activity_events')
        .select('*')
        .eq('contact_id', contact_id)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) return ok({ events: [], error: error.message });
      return ok({ events: data || [] });
    }

    // Get page views for a contact
    if (action === 'get_page_views') {
      const { contact_id, portal_user_id } = body;
      let q = sb.from('page_views').select('*').order('created_at', { ascending: false }).limit(50);
      if (contact_id) q = q.eq('contact_id', contact_id);
      else if (portal_user_id) q = q.eq('portal_user_id', portal_user_id);
      const { data } = await q;
      return ok({ page_views: data || [] });
    }

    return ok({ success: true });
  } catch(e: any) {
    console.error('activity-tracker error:', e);
    return ok({ success: false, error: e.message });
  }
});

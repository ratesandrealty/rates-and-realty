import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info'
};

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const respond = (data: any, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const {
      email, name, phone,
      portal_user_id, borrower_id,
      preferred_date, preferred_time, notes,
      homes = []
    } = body;

    if (!homes.length) return respond({ error: 'No homes provided' }, 400);

    // Find or create contact
    let contactId: string | null = null;

    if (email) {
      const { data: c } = await sb.from('contacts').select('id').eq('email', email.toLowerCase().trim()).maybeSingle();
      contactId = c?.id || null;
    }
    if (!contactId && borrower_id) {
      const { data: c } = await sb.from('contacts').select('id').eq('crm_id', borrower_id).maybeSingle();
      contactId = c?.id || null;
    }
    if (!contactId && portal_user_id) {
      const { data: c } = await sb.from('contacts').select('id').eq('portal_user_id', portal_user_id).maybeSingle();
      contactId = c?.id || null;
    }
    // Auto-create contact
    if (!contactId && (email || phone)) {
      const nameParts = (name || '').split(' ');
      const { data: newC } = await sb.from('contacts').insert({
        email: email ? email.toLowerCase().trim() : null,
        phone: phone || null,
        first_name: nameParts[0] || 'Borrower',
        last_name: nameParts.slice(1).join(' ') || '',
        source: 'showing_request',
        /* Explicit. contacts.sms_opt_in DEFAULTS TO TRUE, and this is a PUBLIC
         * form with no consent field — asking to see a house is not agreement to
         * be texted. Set false; record real consent where it is obtained. */
        sms_opt_in: false
      }).select('id').single();
      contactId = newC?.id || null;
    }

    // Generate batch ID
    const batchId = crypto.randomUUID();

    // Insert one showing per home
    const inserts = homes.map((h: any) => ({
      name: name || null,
      email: email ? email.toLowerCase().trim() : null,
      phone: phone || null,
      contact_id: contactId,
      portal_user_id: portal_user_id || null,
      borrower_id: borrower_id || null,
      crm_id: borrower_id || null,
      batch_id: batchId,
      preferred_date: preferred_date || null,
      preferred_time: preferred_time || null,
      notes: notes || null,
      status: 'new',
      property_address: h.address || null,
      property_price: h.price ? Number(h.price) : null,
      property_beds: h.beds ? Number(h.beds) : null,
      property_baths: h.baths ? Number(h.baths) : null,
      property_sqft: h.sqft ? Number(h.sqft) : null,
      property_city: h.city || null,
      property_photo: h.photo || null,
      listing_key: h.listingKey || null,
      listing_agent_name: h.agentName || null,
      listing_agent_phone: h.agentPhone || null,
      listing_agent_email: h.agentEmail || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }));

    const { error: insertErr } = await sb.from('showings').insert(inserts);
    if (insertErr) throw new Error(insertErr.message);

    // Log to activity_events
    if (contactId) {
      await sb.from('activity_events').insert({
        contact_id: contactId,
        portal_user_id: portal_user_id || null,
        crm_id: borrower_id || null,
        type: 'showing',
        channel: 'showing',
        title: `Showing Request: ${homes.length} home${homes.length !== 1 ? 's' : ''}`,
        description: `${name || 'Borrower'} requested ${homes.length} showing${homes.length !== 1 ? 's' : ''} on ${preferred_date || 'TBD'}`,
        status: 'new',
        metadata: JSON.stringify({
          batch_id: batchId,
          home_count: homes.length,
          preferred_date,
          preferred_time,
          email,
          phone
        }),
        created_at: new Date().toISOString()
      });
    }

    return respond({
      success: true,
      batch_id: batchId,
      contact_id: contactId,
      homes_submitted: homes.length
    });

  } catch (e: any) {
    console.error('submit-showing error:', e);
    return respond({ error: e.message || 'Server error' }, 500);
  }
});

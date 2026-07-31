import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey,x-client-info' };
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const ML_KEY = Deno.env.get('MAILERLITE_API_KEY');
const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID');
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');
const TWILIO_FROM = Deno.env.get('TWILIO_PHONE_NUMBER') || '+17144728508';

async function sendEmail(to: string, toName: string, subject: string, html: string) {
  const key = ML_KEY;
  if (!key) {
    console.error('MAILERLITE_API_KEY not set');
    return { sent: false, error: 'MAILERLITE_API_KEY not configured in edge function secrets' };
  }
  try {
    const res = await fetch('https://connect.mailerlite.com/api/messages/email', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: { email: 'rene@ratesandrealty.com', name: 'Rene Duarte | Rates & Realty' },
        to: [{ email: to, name: toName }],
        subject,
        html
      })
    });
    const responseText = await res.text();
    console.log('MailerLite response:', res.status, responseText.substring(0, 200));
    return { sent: res.ok, error: res.ok ? undefined : responseText, status: res.status };
  } catch(e: any) {
    return { sent: false, error: e.message };
  }
}

async function sendSMS(to: string, body: string): Promise<{ sent: boolean; error?: string }> {
  if (!TWILIO_SID || !TWILIO_TOKEN) {
    console.log('Twilio not configured — SMS skipped');
    return { sent: false, error: 'Twilio not configured' };
  }
  const phone = to.replace(/\D/g,'');
  const formattedTo = phone.startsWith('1') ? `+${phone}` : `+1${phone}`;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: formattedTo, From: TWILIO_FROM, Body: body })
    });
    const data = await res.json();
    return { sent: res.ok && data.sid, error: res.ok ? undefined : data.message };
  } catch(e: any) { return { sent: false, error: e.message }; }
}

function buildMapsUrl(homes: any[]): string {
  const addrs = homes.filter(h => h.property_address).map(h => encodeURIComponent((h.property_address + ' ' + (h.property_city||'') + ' CA').trim()));
  if (!addrs.length) return 'https://maps.google.com';
  if (addrs.length === 1) return `https://www.google.com/maps/search/?api=1&query=${addrs[0]}`;
  const waypoints = addrs.slice(1,-1).join('|');
  let url = `https://www.google.com/maps/dir/?api=1&origin=${addrs[0]}&destination=${addrs[addrs.length-1]}`;
  if (waypoints) url += `&waypoints=${waypoints}`;
  return url + '&travelmode=driving';
}

function buildConfirmationEmail(p: { firstName: string; email: string; borrowerId: string; date: string; time: string; exactTime?: string; homes: any[]; notes?: string; mapsUrl: string; }): string {
  const dateStr = p.date ? new Date(p.date+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'}) : 'TBD';
  const displayTime = p.exactTime ? p.exactTime : (p.time || 'TBD');

  const homeRows = p.homes.map((h,i) => {
    const mapLink = h.property_address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(h.property_address+' '+(h.property_city||'')+' CA')}` : '';
    const listingLink = h.listing_url || 'https://beta.ratesandrealty.com/public/search-homes.html';
    return `
    <tr>
      <td style="padding:16px 0;border-bottom:1px solid #1e1e1e;vertical-align:top">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="width:100px;vertical-align:top;padding-right:16px">
            <div style="position:relative">
              ${ h.property_photo ? `<img src="${h.property_photo}" width="100" height="80" style="border-radius:8px;object-fit:cover;display:block">` : `<div style="width:100px;height:80px;background:#1a1a1a;border-radius:8px;text-align:center;line-height:80px;font-size:1.8rem">&#127968;</div>` }
              <div style="position:absolute;top:-6px;left:-6px;background:#C9A84C;color:#000;font-size:.62rem;font-weight:800;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;border:2px solid #111">${i+1}</div>
            </div>
          </td>
          <td style="vertical-align:top">
            <div style="font-size:.95rem;font-weight:800;color:#fff;margin-bottom:3px">${h.property_address||'&mdash;'}</div>
            <div style="font-size:.78rem;color:#888;margin-bottom:6px">${h.property_city||''},CA</div>
            <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:6px">
              ${h.property_price ? `<span style="font-size:.9rem;font-weight:700;color:#C9A84C">$${Number(h.property_price).toLocaleString()}</span>` : ''}
              ${h.property_beds ? `<span style="font-size:.76rem;color:#888">${h.property_beds} bd</span>` : ''}
              ${h.property_baths ? `<span style="font-size:.76rem;color:#888">${h.property_baths} ba</span>` : ''}
              ${h.property_sqft ? `<span style="font-size:.76rem;color:#888">${Number(h.property_sqft).toLocaleString()} sqft</span>` : ''}
              ${h.year_built ? `<span style="font-size:.76rem;color:#888">Built ${h.year_built}</span>` : ''}
            </div>
            ${h.listing_agent_name ? `<div style="font-size:.72rem;color:#555">Agent: ${h.listing_agent_name}${h.listing_agent_phone?' &bull; '+h.listing_agent_phone:''}</div>` : ''}
            <div style="margin-top:8px;display:flex;gap:8px">
              ${mapLink ? `<a href="${mapLink}" target="_blank" style="font-size:.72rem;color:#C9A84C;text-decoration:none;background:rgba(201,168,76,.1);border:1px solid rgba(201,168,76,.2);padding:3px 9px;border-radius:5px">View on Maps</a>` : ''}
              <a href="${listingLink}" target="_blank" style="font-size:.72rem;color:#888;text-decoration:none;background:#1a1a1a;border:1px solid #2a2a2a;padding:3px 9px;border-radius:5px">View Listing</a>
            </div>
          </td>
        </tr></table>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Showing Confirmation</title></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
<div style="display:none">Your showings are confirmed for ${dateStr}. Here are the ${p.homes.length} homes in tour order.</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a">
<tr><td align="center" style="padding:32px 16px">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px">

  <tr><td style="background:linear-gradient(135deg,#1a1408,#2a1f0a);border-radius:14px 14px 0 0;padding:24px 32px;border-bottom:2px solid #C9A84C">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><div style="font-size:1.25rem;font-weight:800;color:#C9A84C">Rates &amp; Realty</div><div style="font-size:.62rem;color:#666;text-transform:uppercase;letter-spacing:.14em;margin-top:2px">AI-Powered Mortgage</div></td>
      <td align="right"><div style="background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.4);color:#22c55e;font-size:.68rem;font-weight:800;padding:5px 14px;border-radius:20px">Showings Confirmed</div></td>
    </tr></table>
  </td></tr>

  <tr><td style="background:#111;padding:36px 32px 20px">
    <div style="font-size:.78rem;color:#C9A84C;font-weight:700;text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px">You're confirmed!</div>
    <h1 style="margin:0 0 12px;font-size:1.9rem;font-weight:800;color:#fff;line-height:1.15">See you soon,<br><span style="color:#C9A84C">${p.firstName}!</span></h1>
    <p style="margin:0 0 22px;font-size:.88rem;color:#999;line-height:1.75">We're all set for <strong style="color:#eee">${p.homes.length} home${p.homes.length!==1?'s':''}</strong> on <strong style="color:#eee">${dateStr}</strong>. First showing starts at <strong style="color:#C9A84C">${displayTime}</strong>. Tour below is in order from first to last stop.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #2a2a2a;border-radius:10px;overflow:hidden">
      <tr>
        <td style="background:#1a1a1a;padding:14px 18px;text-align:center;border-right:1px solid #2a2a2a">
          <div style="font-size:.6rem;color:#555;text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px">Date</div>
          <div style="font-size:.88rem;font-weight:700;color:#eee">${dateStr}</div>
        </td>
        <td style="background:#1a1a1a;padding:14px 18px;text-align:center;border-right:1px solid #2a2a2a">
          <div style="font-size:.6rem;color:#555;text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px">First Stop</div>
          <div style="font-size:.88rem;font-weight:700;color:#C9A84C">${displayTime}</div>
        </td>
        <td style="background:#1a1a1a;padding:14px 18px;text-align:center">
          <div style="font-size:.6rem;color:#555;text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px">Homes</div>
          <div style="font-size:.88rem;font-weight:700;color:#eee">${p.homes.length}</div>
        </td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="background:#111;padding:0 32px 20px">
    <div style="font-size:.72rem;font-weight:800;color:#C9A84C;text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px">Your Tour - Stop by Stop</div>
    <div style="font-size:.73rem;color:#555;margin-bottom:14px">Listed in exact visiting order starting at ${displayTime}</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #1e1e1e">${homeRows}</table>
  </td></tr>

  <tr><td style="background:#111;padding:0 32px 28px">
    <div style="background:linear-gradient(135deg,#16120a,#1e1808);border:1px solid #3a2e10;border-radius:12px;padding:20px 22px;text-align:center">
      <div style="font-size:.8rem;color:#C9A84C;font-weight:700;margin-bottom:6px">Full Driving Route - All ${p.homes.length} Homes</div>
      <div style="font-size:.74rem;color:#666;margin-bottom:14px">Turn-by-turn directions in Google Maps for all stops in order</div>
      <a href="${p.mapsUrl}" target="_blank" style="display:inline-block;background:linear-gradient(135deg,#C9A84C,#e8c96a);color:#000;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:800;font-size:.9rem">Open Full Route in Google Maps</a>
    </div>
  </td></tr>

  ${p.notes ? `<tr><td style="background:#111;padding:0 32px 24px"><div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:13px 15px"><div style="font-size:.68rem;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:5px">Notes from Rene</div><div style="font-size:.82rem;color:#bbb;line-height:1.65">${p.notes}</div></div></td></tr>` : ''}

  <tr><td style="background:#0f0f0f;padding:20px 32px;border-top:1px solid #1a1a1a">
    <table cellpadding="0" cellspacing="0" width="100%"><tr>
      <td style="vertical-align:middle;padding-right:14px;width:52px">
        <div style="width:48px;height:48px;background:linear-gradient(135deg,#C9A84C,#a87a30);border-radius:50%;text-align:center;line-height:48px;font-weight:800;color:#000;font-size:1rem">RD</div>
      </td>
      <td style="vertical-align:middle">
        <div style="font-size:.9rem;font-weight:700;color:#eee">Rene Duarte</div>
        <div style="font-size:.72rem;color:#666">Mortgage Loan Officer &bull; NMLS #1795044</div>
        <div style="margin-top:5px">
          <a href="tel:7144728508" style="font-size:.76rem;color:#C9A84C;text-decoration:none;margin-right:12px">(714) 472-8508</a>
          <a href="mailto:rene@ratesandrealty.com" style="font-size:.76rem;color:#C9A84C;text-decoration:none">rene@ratesandrealty.com</a>
        </div>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="background:#0d0d0d;padding:12px 32px;border-top:1px solid #131313">
    <p style="margin:0;font-size:.7rem;color:#444;text-align:center">Borrower ID: <strong style="font-family:monospace;color:#666">${p.borrowerId}</strong> &bull; Reference when contacting Rene</p>
  </td></tr>
  <tr><td style="background:#080808;padding:14px 32px;border-radius:0 0 14px 14px;border-top:1px solid #111">
    <p style="margin:0;font-size:.63rem;color:#333;text-align:center;line-height:1.8">&copy; 2026 Rates &amp; Realty &bull; NMLS #1795044 &bull; Equal Housing Lender<br>E Mortgage Capital &bull; Huntington Beach, CA</p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const { action } = body;

    if (action === 'update_batch') {
      const { batch_id, status, exact_time } = body;
      if (!batch_id) return err('batch_id required');
      if (!['new','pending','confirmed','completed','cancelled'].includes(status)) return err('Invalid status');
      const updateData: any = { status, updated_at: new Date().toISOString() };
      if (exact_time !== undefined) updateData.exact_time = exact_time;
      await sb.from('showings').update(updateData).eq('batch_id', batch_id);
      return ok({ success: true, status });
    }

    if (action === 'set_exact_time') {
      const { batch_id, exact_time } = body;
      if (!batch_id) return err('batch_id required');
      await sb.from('showings').update({ exact_time, updated_at: new Date().toISOString() }).eq('batch_id', batch_id);
      return ok({ success: true, exact_time });
    }

    if (action === 'send_confirmation_email') {
      const { batch_id } = body;
      if (!batch_id) return err('batch_id required');

      const { data: showings } = await sb.from('showings').select('*')
        .eq('batch_id', batch_id).is('deleted_at', null)
        .order('sort_order').order('created_at');
      if (!showings?.length) return err('No showings found');

      const meta = showings[0];
      if (!meta.email) return err('No email address for borrower');

      const firstName = meta.name?.split(' ')[0] || 'there';
      const mapsUrl = buildMapsUrl(showings);
      const displayTime = meta.exact_time || meta.preferred_time || 'TBD';
      // Clean subject — no HTML entities
      const subject = `Showing Tour Confirmed - ${showings.length} Home${showings.length!==1?'s':''} on ${meta.preferred_date||'TBD'} at ${displayTime}`;
      const html = buildConfirmationEmail({
        firstName, email: meta.email,
        borrowerId: meta.borrower_id || meta.crm_id || '',
        date: meta.preferred_date || '',
        time: meta.preferred_time || '',
        exactTime: meta.exact_time || undefined,
        homes: showings, notes: meta.notes || undefined, mapsUrl
      });

      const emailResult = await sendEmail(meta.email, firstName, subject, html);
      console.log('Email result:', JSON.stringify(emailResult));

      /* OPT-OUT GATE. Found while auditing every Twilio call site, not in the
       * original three: this confirmation goes to a BORROWER phone (meta.phone)
       * and never consulted contacts.sms_opt_in, so it reached people who had
       * replied STOP — while itself saying "Reply STOP to opt out".
       * Blocks IS FALSE only; a lookup failure blocks rather than sends. */
      let smsResult = { sent: false, error: 'No phone or Twilio not configured' };
      const phone = meta.phone;
      let smsBlocked = false;
      if (phone) {
        try {
          // Shared predicate — both lists, one implementation. See sms-service.
          const { data, error } = await sb.rpc('is_phone_suppressed', {
            p_phone: phone, p_contact_id: meta.contact_id || null,
          });
          smsBlocked = error ? true : data === true;
        } catch (_) { smsBlocked = true; }
      }
      if (phone && smsBlocked) {
        smsResult = { sent: false, error: 'recipient has opted out of SMS' };
        console.log('[showing-actions] SMS suppressed — recipient opted out');
      } else if (phone) {
        const smsBody = `Hi ${firstName}! Your home tour is confirmed for ${meta.preferred_date || 'TBD'} at ${displayTime}. We'll be visiting ${showings.length} home${showings.length!==1?'s':''}. Check your email for the full route and details. Reply STOP to opt out. - Rene (714) 472-8508`;
        smsResult = await sendSMS(phone, smsBody);
        // Log SMS to activity
        if (meta.contact_id) {
          await sb.from('activity_events').insert({
            contact_id: meta.contact_id, portal_user_id: meta.portal_user_id || null,
            crm_id: meta.borrower_id || null,
            type: 'sms', channel: 'sms',
            title: 'SMS: Showing Tour Confirmation',
            description: `SMS sent to ${phone} — tour confirmed ${meta.preferred_date} at ${displayTime}`,
            status: smsResult.sent ? 'sent' : 'failed',
            sms_body: `Showing tour confirmed for ${meta.preferred_date} at ${displayTime} - ${showings.length} homes. Check email for route.`,
            sms_to: phone,
            metadata: JSON.stringify({ batch_id, sms_error: smsResult.error }),
            created_at: new Date().toISOString()
          });
        }
      }

      // Log email activity
      if (meta.contact_id) {
        await sb.from('activity_events').insert({
          contact_id: meta.contact_id, portal_user_id: meta.portal_user_id || null,
          crm_id: meta.borrower_id || meta.crm_id || null,
          type: 'email', channel: 'email',
          title: `Showing Tour Email - ${showings.length} homes`,
          description: `Tour confirmation email sent to ${meta.email} for ${meta.preferred_date} at ${displayTime}`,
          status: emailResult.sent ? 'sent' : 'failed',
          email_subject: subject, email_html: html, email_to: meta.email,
          email_from: 'rene@ratesandrealty.com',
          metadata: JSON.stringify({ batch_id, home_count: showings.length, maps_url: mapsUrl, email_error: emailResult.error, ml_key_present: !!ML_KEY }),
          created_at: new Date().toISOString()
        });
      }

      return ok({
        success: true,
        emailed: emailResult.sent,
        sms_sent: smsResult.sent,
        to: meta.email,
        phone: phone || null,
        homes_included: showings.length,
        email_error: emailResult.error,
        sms_error: smsResult.error,
        ml_key_present: !!ML_KEY,
        display_time: displayTime
      });
    }

    if (action === 'trash_home') {
      const { showing_id } = body;
      if (!showing_id) return err('showing_id required');
      await sb.from('showings').update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', showing_id);
      return ok({ success: true });
    }

    if (action === 'restore_home') {
      const { showing_id } = body;
      if (!showing_id) return err('showing_id required');
      await sb.from('showings').update({ deleted_at: null, updated_at: new Date().toISOString() }).eq('id', showing_id);
      return ok({ success: true });
    }

    if (action === 'get_trash') {
      const { batch_id } = body;
      if (!batch_id) return err('batch_id required');
      const { data } = await sb.from('showings').select('*').eq('batch_id', batch_id).not('deleted_at', 'is', null).order('deleted_at', { ascending: false });
      return ok({ showings: data || [] });
    }

    if (action === 'delete_home') {
      const { showing_id } = body;
      if (!showing_id) return err('showing_id required');
      await sb.from('showings').delete().eq('id', showing_id);
      return ok({ success: true });
    }

    if (action === 'add_home') {
      const { batch_id, home } = body;
      if (!batch_id || !home) return err('batch_id and home required');
      const { data: existing } = await sb.from('showings').select('*').eq('batch_id', batch_id).is('deleted_at', null).order('sort_order', { ascending: false }).limit(1).single();
      if (!existing) return err('Batch not found');
      const { data: newRow, error } = await sb.from('showings').insert({
        name: existing.name, email: existing.email, phone: existing.phone,
        contact_id: existing.contact_id, portal_user_id: existing.portal_user_id,
        borrower_id: existing.borrower_id, crm_id: existing.crm_id,
        batch_id, preferred_date: existing.preferred_date, preferred_time: existing.preferred_time,
        exact_time: existing.exact_time, notes: existing.notes, status: existing.status,
        sort_order: (existing.sort_order || 0) + 1,
        property_address: home.address||null, property_price: home.price ? Number(home.price) : null,
        property_beds: home.beds ? Number(home.beds) : null, property_baths: home.baths ? Number(home.baths) : null,
        property_sqft: home.sqft ? Number(home.sqft) : null, property_city: home.city||null,
        property_photo: home.photo||null, listing_key: home.listingKey||null,
        listing_agent_name: home.agentName||null, listing_agent_phone: home.agentPhone||null,
        listing_agent_email: home.agentEmail||null, listing_url: home.listingUrl||null,
        property_type: home.propertyType||null, year_built: home.yearBuilt ? Number(home.yearBuilt) : null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      }).select().single();
      if (error) return err(error.message, 500);
      return ok({ success: true, showing: newRow });
    }

    if (action === 'reorder_homes') {
      const { ordered_ids } = body;
      if (!Array.isArray(ordered_ids)) return err('ordered_ids array required');
      for (let i = 0; i < ordered_ids.length; i++) {
        await sb.from('showings').update({ sort_order: i + 1, updated_at: new Date().toISOString() }).eq('id', ordered_ids[i]);
      }
      return ok({ success: true, reordered: ordered_ids.length });
    }

    if (action === 'get_batch') {
      const { batch_id } = body;
      if (!batch_id) return err('batch_id required');
      const { data } = await sb.from('showings').select('*').eq('batch_id', batch_id).is('deleted_at', null).order('sort_order').order('created_at');
      return ok({ showings: data || [], count: data?.length || 0 });
    }

    return err('Unknown action: ' + action);
  } catch(e: any) {
    console.error('showing-actions error:', e);
    return err(e.message||'Server error', 500);
  }
});

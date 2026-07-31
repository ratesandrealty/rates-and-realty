import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey' };
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const MS_KEY = Deno.env.get('MAILERSEND_API_KEY');
const TRESTLE_FN = 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/trestle-proxy';
const PORTAL_URL = 'https://beta.ratesandrealty.com/public/unified-portal.html';

async function trestleQuery(endpoint: string, rawFilter: string): Promise<any[]> {
  const res = await fetch(TRESTLE_FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint, rawFilter })
  });
  if (!res.ok) { console.error('Trestle error:', res.status, await res.text()); return []; }
  const data = await res.json();
  return data.value || [];
}

function buildODataFilter(alert: any, hoursBack: number): string {
  const filters: string[] = [];
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  filters.push(`ModificationTimestamp ge ${since}`);
  filters.push(`StandardStatus in ('Active','Coming Soon')`);
  if (alert.listing_type === 'rent') filters.push(`PropertyType eq 'Residential Lease'`);
  else filters.push(`PropertyType in ('Residential','Single Family Residence','Condominium','Townhouse','Multi-Family')`);
  if (alert.min_price) filters.push(`ListPrice ge ${alert.min_price}`);
  if (alert.max_price) filters.push(`ListPrice le ${alert.max_price}`);
  if (alert.min_beds) filters.push(`BedroomsTotal ge ${alert.min_beds}`);
  if (alert.min_baths) filters.push(`BathroomsTotalInteger ge ${alert.min_baths}`);
  if (alert.min_sqft) filters.push(`LivingArea ge ${alert.min_sqft}`);
  if (alert.max_sqft) filters.push(`LivingArea le ${alert.max_sqft}`);
  if (alert.has_pool) filters.push(`PoolPrivateYN eq true`);
  if (alert.new_construction_only) filters.push(`NewConstructionYN eq true`);
  if (alert.max_dom) filters.push(`DaysOnMarket le ${alert.max_dom}`);
  if (alert.max_hoa) filters.push(`AssociationFee le ${alert.max_hoa}`);
  if (alert.cities?.length) {
    const cityList = alert.cities.map((c: string) => `'${c}'`).join(',');
    filters.push(`City in (${cityList})`);
  } else if (alert.counties?.length) {
    const countyList = alert.counties.map((c: string) => `'${c.replace(' County','')}'`).join(',');
    filters.push(`CountyOrParish in (${countyList})`);
  }
  if (alert.keywords) filters.push(`contains(tolower(PublicRemarks),'${alert.keywords.toLowerCase()}')`);
  const select = '$select=ListingKey,ListPrice,StreetNumber,StreetName,City,StateOrProvince,PostalCode,BedroomsTotal,BathroomsTotalInteger,LivingArea,DaysOnMarket,StandardStatus,MediaURL,PublicRemarks,ListingId,PropertyType';
  return `$filter=${filters.join(' and ')}&${select}&$top=5&$orderby=ModificationTimestamp desc`;
}

async function sendMatchEmail(to: string, firstName: string, alert: any, listings: any[]): Promise<boolean> {
  if (!MS_KEY || !listings.length) return false;
  const listingCards = listings.map(l => {
    const price = l.ListPrice ? '$' + Number(l.ListPrice).toLocaleString() : 'Price N/A';
    const addr = [l.StreetNumber, l.StreetName, l.City].filter(Boolean).join(' ');
    const beds = l.BedroomsTotal || '?';
    const baths = l.BathroomsTotalInteger || '?';
    const sqft = l.LivingArea ? Number(l.LivingArea).toLocaleString() + ' sqft' : '';
    const dom = l.DaysOnMarket !== undefined ? `${l.DaysOnMarket} days on market` : '';
    const img = l.MediaURL || '';
    return `
    <tr><td style="padding:0 0 16px">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;overflow:hidden">
        ${img ? `<tr><td><img src="${img}" width="100%" style="display:block;max-height:200px;object-fit:cover" alt="${addr}"/></td></tr>` : ''}
        <tr><td style="padding:16px">
          <div style="font-size:1.1rem;font-weight:800;color:#C9A84C;margin-bottom:4px">${price}</div>
          <div style="font-size:.88rem;color:#eee;margin-bottom:6px">${addr}</div>
          <div style="font-size:.78rem;color:#888">${beds} bd · ${baths} ba${sqft ? ' · ' + sqft : ''}${dom ? ' · ' + dom : ''}</div>
        </td></tr>
      </table>
    </td></tr>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a">
<tr><td align="center" style="padding:32px 16px">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
  <tr><td style="background:#1a1408;border-radius:14px 14px 0 0;padding:24px 32px;border-bottom:2px solid #C9A84C">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><div style="font-size:1.2rem;font-weight:800;color:#C9A84C">Rates &amp; Realty</div><div style="font-size:.62rem;color:#666;text-transform:uppercase;letter-spacing:.14em;margin-top:2px">New Listing Alert</div></td>
      <td align="right"><div style="background:rgba(201,168,76,.15);border:1px solid rgba(201,168,76,.4);color:#C9A84C;font-size:.68rem;font-weight:800;padding:5px 14px;border-radius:20px">${listings.length} New Match${listings.length > 1 ? 'es' : ''}</div></td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#111;padding:32px 32px 8px">
    <h1 style="margin:0 0 8px;font-size:1.5rem;font-weight:800;color:#fff">New homes for you, ${firstName}!</h1>
    <p style="margin:0 0 24px;font-size:.88rem;color:#999;line-height:1.7">${listings.length} new listing${listings.length > 1 ? 's match' : ' matches'} your <strong style="color:#eee">${alert.name}</strong> alert.</p>
    <table width="100%" cellpadding="0" cellspacing="0">${listingCards}</table>
    <a href="${PORTAL_URL}" style="display:block;text-align:center;background:#C9A84C;color:#000;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:800;font-size:.88rem;margin-bottom:24px">View All in Portal</a>
  </td></tr>
  <tr><td style="background:#0d0d0d;padding:18px 32px;border-top:1px solid #1a1a1a">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="padding-right:12px"><div style="width:40px;height:40px;background:#C9A84C;border-radius:50%;text-align:center;line-height:40px;font-weight:800;color:#000">RD</div></td>
      <td><div style="font-size:.82rem;font-weight:700;color:#eee">Rene Duarte &bull; NMLS #1795044</div>
        <div style="font-size:.7rem;color:#666"><a href="tel:7144728508" style="color:#C9A84C;text-decoration:none">(714) 472-8508</a> &bull; <a href="mailto:rene@ratesandrealty.com" style="color:#C9A84C;text-decoration:none">rene@ratesandrealty.com</a></div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#080808;padding:12px 32px;border-radius:0 0 14px 14px;border-top:1px solid #111">
    <p style="margin:0;font-size:.62rem;color:#333;text-align:center">&copy; 2026 Rates &amp; Realty &bull; NMLS #1795044 &bull; Equal Housing Lender</p>
  </td></tr>
</table></td></tr></table></body></html>`;

  const res = await fetch('https://api.mailersend.com/v1/email', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${MS_KEY}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ from: { email: 'rene@ratesandrealty.com', name: 'Rene Duarte | Rates & Realty' }, to: [{ email: to, name: firstName }], subject: `${listings.length} new home${listings.length > 1 ? 's' : ''} match your "${alert.name}" alert!`, html })
  });
  console.log('Match email sent:', res.status, to);
  return res.ok;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json().catch(() => ({}));
    const { action, alert_id, test_mode } = body;

    // Run matcher for all active alerts (called by cron)
    if (action === 'run' || !action) {
      const now = new Date();
      const { data: alerts, error } = await sb.from('listing_alerts')
        .select('*, portal_users(email, first_name)')
        .eq('is_active', true)
        .eq('status', 'Active');

      if (error) return err(error.message, 500);
      if (!alerts?.length) return ok({ success: true, processed: 0, message: 'No active alerts' });

      let sent = 0, checked = 0, errors = 0;

      for (const alert of alerts) {
        try {
          // Determine hours back based on frequency
          const freq = alert.frequency || 'Daily';
          const hoursBack = freq === 'Instant' ? 1 : freq === 'Weekly' ? 168 : 24;

          // Skip if checked recently (avoid duplicate sends)
          if (alert.last_checked_at) {
            const lastChecked = new Date(alert.last_checked_at);
            const hoursSince = (now.getTime() - lastChecked.getTime()) / (1000 * 60 * 60);
            if (hoursSince < hoursBack * 0.9) { continue; } // too soon
          }

          checked++;
          const rawFilter = buildODataFilter(alert, hoursBack);
          const listings = test_mode ? [] : await trestleQuery('Property', rawFilter);

          // Update last_checked_at regardless
          await sb.from('listing_alerts').update({
            last_checked_at: now.toISOString(),
            last_listing_count: listings.length,
            updated_at: now.toISOString()
          }).eq('id', alert.id);

          if (!listings.length) continue;

          // Resolve email
          const pu = Array.isArray(alert.portal_users) ? alert.portal_users[0] : alert.portal_users;
          let toEmail = pu?.email || null;
          let firstName = pu?.first_name || 'there';

          if (!toEmail && alert.contact_id) {
            const { data: c } = await sb.from('contacts').select('email, first_name').eq('id', alert.contact_id).single();
            toEmail = c?.email || null;
            firstName = c?.first_name || firstName;
          }

          if (!toEmail) continue;

          const emailSent = await sendMatchEmail(toEmail, firstName, alert, listings);

          if (emailSent) {
            sent++;
            await sb.from('listing_alerts').update({ last_sent_at: now.toISOString() }).eq('id', alert.id);
            // Log activity
            try {
              await sb.from('activity_events').insert({
                contact_id: alert.contact_id || null,
                portal_user_id: alert.portal_user_id || null,
                type: 'email', channel: 'email',
                title: `Listing Alert Match: ${alert.name} (${listings.length} listings)`,
                description: `Sent ${listings.length} matching listing${listings.length > 1 ? 's' : ''} to ${toEmail}`,
                status: 'sent',
                email_to: toEmail,
                email_from: 'rene@ratesandrealty.com',
                metadata: JSON.stringify({ alert_id: alert.id, listing_count: listings.length, frequency: freq }),
                created_at: now.toISOString()
              });
            } catch(logErr) { console.warn('Log error:', logErr); }
          }
        } catch(alertErr) {
          console.error('Alert processing error:', alertErr);
          errors++;
        }
      }

      return ok({ success: true, processed: checked, emails_sent: sent, errors, total_alerts: alerts.length });
    }

    // Test a single alert
    if (action === 'test_alert') {
      if (!alert_id) return err('alert_id required');
      const { data: alert } = await sb.from('listing_alerts').select('*').eq('id', alert_id).single();
      if (!alert) return err('Alert not found');
      const rawFilter = buildODataFilter(alert, 24);
      const listings = await trestleQuery('Property', rawFilter);
      return ok({ success: true, alert_name: alert.name, listings_found: listings.length, listings: listings.slice(0,3), filter_used: rawFilter });
    }

    return err('Unknown action');
  } catch(e: any) {
    console.error('listing-alert-matcher error:', e);
    return err(e.message || 'Server error', 500);
  }
});

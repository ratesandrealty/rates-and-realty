import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey,x-client-info' };
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TRESTLE_TOKEN_URL = 'https://api.cotality.com/trestle/oidc/connect/token';
const TRESTLE_API = 'https://api.cotality.com/trestle/odata';
const ML_KEY = Deno.env.get('MAILERLITE_API_KEY')!;
const sb = createClient(SB_URL, SB_SERVICE);

let trestleToken: string|null = null;
let tokenExp = 0;
async function getTrestleToken() {
  if (trestleToken && Date.now() < tokenExp) return trestleToken;
  const r = await fetch(TRESTLE_TOKEN_URL, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ grant_type:'client_credentials', client_id: Deno.env.get('TRESTLE_CLIENT_ID')!, client_secret: Deno.env.get('TRESTLE_CLIENT_SECRET')!, scope:'api' }) });
  const d = await r.json();
  trestleToken = d.access_token;
  tokenExp = Date.now() + (d.expires_in - 60) * 1000;
  return trestleToken!;
}

function buildODataFilter(alert: any): string {
  const parts: string[] = [];
  const cities = alert.cities || [];
  if (cities.length === 1) parts.push(`City eq '${cities[0]}'`);
  else if (cities.length > 1) parts.push(`(${cities.slice(0,8).map((c:string) => `City eq '${c}'`).join(' or ')})`);
  const status = alert.status || 'Active';
  parts.push(`StandardStatus eq '${status}'`);
  const types = alert.property_types || [];
  if (types.length > 0 && types.length < 8) parts.push(`(${types.map((t:string) => `PropertyType eq '${t}'`).join(' or ')})`);
  if (alert.min_price) parts.push(`ListPrice ge ${alert.min_price}`);
  if (alert.max_price) parts.push(`ListPrice le ${alert.max_price}`);
  if (alert.min_beds) parts.push(`BedroomsTotal ge ${alert.min_beds}`);
  if (alert.min_baths) parts.push(`BathroomsTotalInteger ge ${alert.min_baths}`);
  if (alert.min_sqft) parts.push(`LivingArea ge ${alert.min_sqft}`);
  if (alert.max_sqft) parts.push(`LivingArea le ${alert.max_sqft}`);
  if (alert.min_year_built) parts.push(`YearBuilt ge ${alert.min_year_built}`);
  if (alert.max_dom != null) parts.push(`DaysOnMarket le ${alert.max_dom}`);
  if (alert.min_lot_acres) parts.push(`LotSizeAcres ge ${alert.min_lot_acres}`);
  if (alert.min_garage) parts.push(`GarageSpaces ge ${alert.min_garage}`);
  return parts.join(' and ');
}

async function fetchListings(filterStr: string) {
  const token = await getTrestleToken();
  const rawFilter = `$filter=${encodeURIComponent(filterStr)}&$top=10&$orderby=ListingContractDate desc&$expand=Media($top=1;$select=MediaURL)&$select=ListingKey,ListPrice,UnparsedAddress,City,StateOrProvince,PostalCode,BedroomsTotal,BathroomsTotalInteger,LivingArea,PropertyType,PropertySubType,StandardStatus,DaysOnMarket,YearBuilt,Latitude,Longitude`;
  const res = await fetch(`${TRESTLE_API}/Property?${rawFilter}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const data = await res.json();
  return data.value || [];
}

async function sendAlertEmail(email: string, firstName: string, alertName: string, listings: any[], freq: string) {
  if (!ML_KEY || !listings.length) return;
  const fmtPrice = (p: number) => p ? '$' + p.toLocaleString() : 'N/A';
  const listingsHtml = listings.slice(0, 8).map(l => {
    const photo = l.Media?.[0]?.MediaURL || '';
    const isLand = l.PropertyType === 'Land';
    return `
    <div style="margin-bottom:16px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;overflow:hidden;display:flex;gap:0">
      ${photo ? `<img src="${photo}" style="width:130px;height:100px;object-fit:cover;flex-shrink:0" alt="${l.UnparsedAddress}">` : `<div style="width:130px;height:100px;background:#222;display:flex;align-items:center;justify-content:center;flex-shrink:0"><span style="color:#444;font-size:1.5rem">🏠</span></div>`}
      <div style="padding:12px;flex:1">
        <div style="font-weight:700;font-size:1rem;color:#C9A84C;margin-bottom:4px">${fmtPrice(l.ListPrice)}</div>
        <div style="font-size:.82rem;color:#ddd;margin-bottom:3px">${l.UnparsedAddress || ''}</div>
        <div style="font-size:.75rem;color:#888;margin-bottom:8px">${[l.City, l.StateOrProvince, l.PostalCode].filter(Boolean).join(', ')}</div>
        <div style="font-size:.75rem;color:#aaa">${!isLand && l.BedroomsTotal ? l.BedroomsTotal + ' bd · ' : ''}${!isLand && l.BathroomsTotalInteger ? l.BathroomsTotalInteger + ' ba · ' : ''}${l.LivingArea ? l.LivingArea.toLocaleString() + ' sqft' : ''}${l.DaysOnMarket != null ? ' · ' + l.DaysOnMarket + ' DOM' : ''}</div>
      </div>
    </div>`;
  }).join('');

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0a;font-family:'Segoe UI',Arial,sans-serif">
<div style="max-width:620px;margin:0 auto;padding:32px 20px">
  <div style="text-align:center;margin-bottom:28px">
    <div style="font-size:1.3rem;font-weight:700;color:#C9A84C">Rates & Realty</div>
    <div style="font-size:.82rem;color:#888;margin-top:4px">Your Listing Alert</div>
  </div>
  <div style="background:#111;border:1px solid #222;border-radius:14px;padding:28px">
    <h2 style="color:#fff;font-size:1.1rem;margin:0 0 6px">🏠 New Listings for: ${alertName}</h2>
    <p style="color:#888;font-size:.85rem;margin:0 0 20px">${listings.length} new listing${listings.length !== 1 ? 's' : ''} matching your search · ${freq === 'instant' ? 'Just listed' : freq === 'daily' ? 'Daily digest' : 'Weekly digest'}</p>
    ${listingsHtml}
    ${listings.length > 8 ? `<p style="text-align:center;color:#888;font-size:.82rem;margin-top:12px">...and ${listings.length - 8} more</p>` : ''}
    <div style="text-align:center;margin-top:24px">
      <a href="https://beta.ratesandrealty.com/public/search-homes.html" style="display:inline-block;background:#C9A84C;color:#000;text-decoration:none;padding:13px 32px;border-radius:10px;font-weight:700;font-size:.92rem">View All Listings →</a>
    </div>
  </div>
  <div style="text-align:center;margin-top:24px;color:#444;font-size:.72rem;line-height:1.8">
    <div>You're receiving this because you set up a listing alert with Rates & Realty.</div>
    <div>Questions? <a href="tel:7144728508" style="color:#C9A84C">714-472-8508</a> · Rene Duarte NMLS #1795044</div>
    <div style="margin-top:6px"><a href="https://beta.ratesandrealty.com/public/portal.html" style="color:#C9A84C;text-decoration:none">Manage your alerts in My Portal</a></div>
  </div>
</div></body></html>`;

  await fetch('https://connect.mailerlite.com/api/messages/email', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ML_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: { email: 'rene@ratesandrealty.com', name: 'Rene Duarte | Rates & Realty' },
      to: [{ email, name: firstName }],
      subject: `🏠 ${listings.length} New Listing${listings.length !== 1 ? 's' : ''} — ${alertName}`,
      html
    })
  });
}

async function processAlert(alert: any) {
  // Get recipient email
  let email = '', firstName = 'there';
  if (alert.portal_user_id) {
    const { data: u } = await sb.from('portal_users').select('email,first_name').eq('id', alert.portal_user_id).single();
    if (u) { email = u.email; firstName = u.first_name || 'there'; }
  } else if (alert.contact_id) {
    const { data: c } = await sb.from('contacts').select('email,first_name').eq('id', alert.contact_id).single();
    if (c) { email = c.email; firstName = c.first_name || 'there'; }
  }
  if (!email) return { skipped: true, reason: 'no email' };

  // Get already-sent listing keys for this alert
  const { data: sentRows } = await sb.from('alert_sent_listings').select('listing_key').eq('alert_id', alert.id);
  const sentKeys = new Set((sentRows || []).map((r: any) => r.listing_key));

  // Fetch matching listings from Trestle
  const filterStr = buildODataFilter(alert);
  const listings = await fetchListings(filterStr);

  // Filter to only NEW ones (not previously sent)
  const newListings = listings.filter((l: any) => !sentKeys.has(l.ListingKey));

  if (newListings.length === 0) {
    await sb.from('listing_alerts').update({ last_checked_at: new Date().toISOString(), last_listing_count: listings.length }).eq('id', alert.id);
    return { sent: false, reason: 'no new listings', total: listings.length };
  }

  // Send email
  await sendAlertEmail(email, firstName, alert.name, newListings, alert.frequency);

  // Mark listings as sent
  const sentInserts = newListings.map((l: any) => ({ alert_id: alert.id, listing_key: l.ListingKey }));
  await sb.from('alert_sent_listings').upsert(sentInserts, { onConflict: 'alert_id,listing_key', ignoreDuplicates: true });

  // Update alert stats
  await sb.from('listing_alerts').update({
    last_sent_at: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
    last_listing_count: listings.length,
    total_sent: (alert.total_sent || 0) + newListings.length
  }).eq('id', alert.id);

  return { sent: true, newCount: newListings.length, email };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const { action, alert_id, frequency } = body;

    // ACTION: run all due alerts
    if (action === 'run_due' || !action) {
      const now = new Date();
      const cutoffs: Record<string, Date> = {
        instant: new Date(now.getTime() - 30 * 60 * 1000),   // 30 min ago
        daily:   new Date(now.getTime() - 23 * 60 * 60 * 1000), // 23 hrs ago
        weekly:  new Date(now.getTime() - 6.5 * 24 * 60 * 60 * 1000) // 6.5 days ago
      }
      const freq = frequency || 'daily';
      const cutoff = cutoffs[freq] || cutoffs.daily;

      const { data: alerts } = await sb.from('listing_alerts')
        .select('*')
        .eq('is_active', true)
        .eq('frequency', freq)
        .or(`last_sent_at.is.null,last_sent_at.lt.${cutoff.toISOString()}`);

      const results = [];
      for (const alert of (alerts || [])) {
        const result = await processAlert(alert);
        results.push({ id: alert.id, name: alert.name, ...result });
      }
      return new Response(JSON.stringify({ processed: results.length, results }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // ACTION: run single alert
    if (action === 'run_single' && alert_id) {
      const { data: alert } = await sb.from('listing_alerts').select('*').eq('id', alert_id).single();
      if (!alert) return new Response(JSON.stringify({ error: 'Alert not found' }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } });
      const result = await processAlert(alert);
      return new Response(JSON.stringify(result), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // ACTION: preview listings for an alert criteria (no email sent)
    if (action === 'preview') {
      const alert = body.criteria;
      if (!alert) return new Response(JSON.stringify({ error: 'criteria required' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
      const filterStr = buildODataFilter(alert);
      const listings = await fetchListings(filterStr);
      return new Response(JSON.stringify({ count: listings.length, listings: listings.slice(0, 6) }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });

  } catch(e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});

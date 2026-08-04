import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const MS_KEY = Deno.env.get("MAILERSEND_API_KEY");
const TRESTLE_TOKEN_URL = "https://api.cotality.com/trestle/oidc/connect/token";
const TRESTLE_API_BASE = "https://api.cotality.com/trestle/odata";
const SMS_FN = Deno.env.get("SUPABASE_URL") + "/functions/v1/sms-service";
const SHORT_LINK_FN = Deno.env.get("SUPABASE_URL") + "/functions/v1/short-link";
const SITE = "https://homes.ratesandrealty.com";
const PHOTO_PROXY = "https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/trestle-proxy?photo=";
const SMS_DELAY_MS = 60 * 60 * 1000;

const STATUS_MAP: Record<string, string> = {
  'active': 'Active',
  'coming soon': 'ComingSoon',
  'comingsoon': 'ComingSoon',
  'active under contract': 'ActiveUnderContract',
  'activeundercontract': 'ActiveUnderContract',
  'pending': 'Pending',
  'hold': 'Hold',
  'withdrawn': 'Withdrawn',
  'closed': 'Closed',
  'expired': 'Expired',
  'canceled': 'Canceled',
  'cancelled': 'Canceled',
};
function normalizeStatus(s: string): string | null {
  const k = (s || '').trim().toLowerCase();
  return STATUS_MAP[k] || null;
}

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getTrestleToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  const id = Deno.env.get("TRESTLE_CLIENT_ID");
  const secret = Deno.env.get("TRESTLE_CLIENT_SECRET");
  if (!id || !secret) throw new Error("TRESTLE credentials not set");
  const res = await fetch(TRESTLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, scope: "api" }),
  });
  if (!res.ok) throw new Error(`Trestle auth ${res.status}: ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken!;
}

interface AlertRow {
  id: string; contact_id: string | null; portal_user_id: string | null;
  name: string; frequency: string; listing_type: string;
  listing_statuses: string[]; counties: string[]; cities: string[];
  min_price: any; max_price: any; min_beds: any; min_baths: any;
  property_types: string[]; min_sqft: any; max_sqft: any;
  min_year_built: any; max_dom: any; has_pool: boolean; has_garage: boolean;
  max_hoa: any; last_sent_at: string | null; last_checked_at: string | null; total_sent: number;
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v); return isNaN(n) ? null : n;
}

function buildODataFilter(a: AlertRow): string {
  const parts: string[] = [];

  const rawStatuses = a.listing_statuses?.length ? a.listing_statuses : ["Active"];
  const validStatuses = [...new Set(rawStatuses.map(normalizeStatus).filter(Boolean) as string[])];
  const statuses = validStatuses.length ? validStatuses : ['Active'];
  parts.push("(" + statuses.map(s => `StandardStatus eq '${s}'`).join(" or ") + ")");

  if (a.listing_type === 'rent') {
    parts.push("PropertyType eq 'ResidentialLease'");
  } else {
    const typeMap: Record<string, string> = {
      'Single Family': 'Residential', 'Condo': 'Residential',
      'Townhouse': 'Residential', 'Multi-Family': 'ResidentialIncome',
      'Land': 'Land', 'Commercial': 'CommercialSale',
    };
    const trestleTypes = a.property_types?.length
      ? [...new Set(a.property_types.map(t => typeMap[t] || 'Residential'))]
      : ['Residential'];
    parts.push("(" + trestleTypes.map(t => `PropertyType eq '${t}'`).join(" or ") + ")");
  }

  if (a.cities?.length) parts.push("(" + a.cities.map(c => `City eq '${c.replace(/'/g, "''")}'`).join(" or ") + ")");

  const minP = num(a.min_price), maxP = num(a.max_price);
  if (minP) parts.push(`ListPrice ge ${minP}`);
  if (maxP) parts.push(`ListPrice le ${maxP}`);

  const minBeds = num(a.min_beds), minBaths = num(a.min_baths);
  if (minBeds) parts.push(`BedroomsTotal ge ${minBeds}`);
  if (minBaths) parts.push(`BathroomsTotalInteger ge ${minBaths}`);

  const minSqft = num(a.min_sqft), maxSqft = num(a.max_sqft);
  if (minSqft) parts.push(`LivingArea ge ${minSqft}`);
  if (maxSqft) parts.push(`LivingArea le ${maxSqft}`);

  const minYr = num(a.min_year_built);
  if (minYr) parts.push(`YearBuilt ge ${minYr}`);

  return parts.join(" and ");
}

interface Listing {
  ListingKey: string; ListPrice: number; BedroomsTotal: number;
  BathroomsTotalInteger: number; LivingArea: number; UnparsedAddress: string;
  ModificationTimestamp?: string; City?: string; PublicRemarks?: string;
  Media?: { MediaURL?: string; Order?: number }[];
}

async function fetchMlsListings(alert: AlertRow): Promise<Listing[]> {
  const token = await getTrestleToken();
  const filter = buildODataFilter(alert);
  console.log(`[listing-alerts] Filter for "${alert.name}" (type=${alert.listing_type}): ${filter}`);
  const params = new URLSearchParams({
    $filter: filter, $top: "25",
    $orderby: "ModificationTimestamp desc",
    $expand: "Media",
    $select: "ListingKey,ListPrice,BedroomsTotal,BathroomsTotalInteger,LivingArea,UnparsedAddress,City,PublicRemarks,ModificationTimestamp,Media",
  });
  const res = await fetch(`${TRESTLE_API_BASE}/Property?${params}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  console.log(`[listing-alerts] MLS status: ${res.status} for "${alert.name}"`);
  if (!res.ok) {
    const errText = await res.text();
    console.error(`[listing-alerts] MLS error: ${errText.substring(0, 500)}`);
    const p2 = new URLSearchParams({
      $filter: filter, $top: "25", $orderby: "ModificationTimestamp desc",
      $select: "ListingKey,ListPrice,BedroomsTotal,BathroomsTotalInteger,LivingArea,UnparsedAddress,City,PublicRemarks,ModificationTimestamp",
    });
    const r2 = await fetch(`${TRESTLE_API_BASE}/Property?${p2}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    if (!r2.ok) {
      const e2 = await r2.text();
      console.error(`[listing-alerts] Retry MLS error: ${e2.substring(0, 500)}`);
      return [];
    }
    const d2 = await r2.json();
    return (d2.value || []).sort((a: Listing, b: Listing) => {
      const ta = a.ModificationTimestamp ? new Date(a.ModificationTimestamp).getTime() : 0;
      const tb = b.ModificationTimestamp ? new Date(b.ModificationTimestamp).getTime() : 0;
      return tb - ta;
    });
  }
  const data = await res.json();
  const listings: Listing[] = data.value || [];
  listings.sort((a, b) => {
    const ta = a.ModificationTimestamp ? new Date(a.ModificationTimestamp).getTime() : 0;
    const tb = b.ModificationTimestamp ? new Date(b.ModificationTimestamp).getTime() : 0;
    return tb - ta;
  });
  console.log(`[listing-alerts] ${listings.length} listings for "${alert.name}"`);
  return listings;
}

function getProxiedPhotoUrl(listing: Listing): string | null {
  if (!listing.Media?.length) return null;
  const sorted = [...listing.Media].sort((a, b) => (a.Order ?? 999) - (b.Order ?? 999));
  const rawUrl = sorted[0]?.MediaURL;
  if (!rawUrl) return null;
  return PHOTO_PROXY + encodeURIComponent(rawUrl);
}

async function makeShortLink(longUrl: string, contactId?: string): Promise<string> {
  try {
    const res = await fetch(SHORT_LINK_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') },
      body: JSON.stringify({ action: 'create', destination_url: longUrl, contact_id: contactId || null })
    });
    const data = await res.json();
    return data.short_url || longUrl;
  } catch { return longUrl; }
}

function buildSearchUrl(alert: AlertRow): string {
  const p = new URLSearchParams();
  if (alert.cities?.length) p.set('cities', alert.cities.join(','));
  if (alert.counties?.length) p.set('counties', alert.counties.join(','));
  const minP = num(alert.min_price), maxP = num(alert.max_price);
  if (minP) p.set('min_price', String(minP));
  if (maxP) p.set('max_price', String(maxP));
  if (num(alert.min_beds)) p.set('min_beds', String(num(alert.min_beds)));
  if (num(alert.min_baths)) p.set('min_baths', String(num(alert.min_baths)));
  if (alert.property_types?.length) p.set('property_types', alert.property_types.join(','));
  // Normalize statuses to canonical RESO form ("Coming Soon" -> "ComingSoon") so the
  // search-homes page filter matches what listings actually have.
  if (alert.listing_statuses?.length) {
    const normalized = [...new Set(alert.listing_statuses.map(normalizeStatus).filter(Boolean) as string[])];
    if (normalized.length) p.set('statuses', normalized.join(','));
  }
  if (num(alert.min_sqft)) p.set('min_sqft', String(num(alert.min_sqft)));
  if (num(alert.max_sqft)) p.set('max_sqft', String(num(alert.max_sqft)));
  if (alert.has_pool) p.set('has_pool', 'true');
  if (num(alert.max_hoa)) p.set('max_hoa', String(num(alert.max_hoa)));
  if (alert.listing_type) p.set('listing_type', alert.listing_type);
  p.set('alert_id', alert.id);
  return `${SITE}/public/search-homes.html?${p.toString()}`;
}

function buildListingUrl(alert: AlertRow, listingKey: string): string {
  return buildSearchUrl(alert) + '&highlight=' + encodeURIComponent(listingKey);
}

function buildCriteriaRows(a: AlertRow): string {
  const row = (label: string, value: string) =>
    `<div style="margin-bottom:4px;"><span style="color:#7A5820;font-size:12px;">${label}:</span> <span style="color:#F0EDE4;font-size:12px;">${value}</span></div>`;
  const rows: string[] = [];
  if (a.listing_type === 'rent') rows.push(row('Type', 'Rental'));
  if (a.cities?.length) rows.push(row('Cities', a.cities.join(', ')));
  if (a.counties?.length) rows.push(row('Counties', a.counties.join(', ')));
  const minP = num(a.min_price), maxP = num(a.max_price);
  if (minP || maxP) rows.push(row('Price', `${minP ? '$'+minP.toLocaleString() : 'Any'} \u2013 ${maxP ? '$'+maxP.toLocaleString() : 'Any'}/mo`));
  if (num(a.min_beds)) rows.push(row('Beds', `${num(a.min_beds)}+`));
  if (num(a.min_baths)) rows.push(row('Baths', `${num(a.min_baths)}+`));
  if (a.property_types?.length && a.listing_type !== 'rent') rows.push(row('Types', a.property_types.join(', ')));
  if (a.listing_statuses?.length) rows.push(row('Status', a.listing_statuses.join(', ')));
  rows.push(row('Frequency', a.frequency || 'Daily'));
  return rows.join('');
}

function buildEmail(firstName: string, alert: AlertRow, listings: Listing[]): string {
  const searchUrl = buildSearchUrl(alert);
  const shown = listings.slice(0, 5);
  const overflow = listings.length - shown.length;
  const n = listings.length;
  const isRental = alert.listing_type === 'rent';

  const cards = shown.map(l => {
    const listingUrl = buildListingUrl(alert, l.ListingKey);
    const proxyPhotoUrl = getProxiedPhotoUrl(l);
    const price = '$' + l.ListPrice.toLocaleString() + (isRental ? '/mo' : '');
    const details = [
      l.BedroomsTotal ? `${l.BedroomsTotal} bed` : '',
      l.BathroomsTotalInteger ? `${l.BathroomsTotalInteger} bath` : '',
      l.LivingArea ? `${Math.round(l.LivingArea).toLocaleString()} sqft` : ''
    ].filter(Boolean).join(' &middot; ');
    const address = l.UnparsedAddress || l.City || '';
    const remarks = (l.PublicRemarks || '').substring(0, 100);
    const isNew = l.ModificationTimestamp &&
      (Date.now() - new Date(l.ModificationTimestamp).getTime()) < 48 * 3600000;
    const photoCell = proxyPhotoUrl
      ? `<td width="160" style="padding:0;vertical-align:top;width:160px;position:relative;"><a href="${listingUrl}" style="display:block;">${isNew ? '<div style="position:absolute;top:8px;left:8px;background:#C9A84C;color:#111;font-size:9px;font-weight:800;padding:2px 7px;border-radius:4px;z-index:1;">NEW</div>' : ''}<img src="${proxyPhotoUrl}" width="160" height="120" style="display:block;width:160px;height:120px;object-fit:cover;border-radius:8px 0 0 8px;" alt="${address}"></a></td>`
      : `<td width="60" style="padding:0;vertical-align:top;width:60px;background:#2A1800;border-radius:8px 0 0 8px;text-align:center;"><a href="${listingUrl}" style="display:block;padding:36px 0;font-size:24px;text-decoration:none;">&#127968;</a></td>`;
    return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#1E1200;border:1px solid #3A2400;border-radius:8px;margin-bottom:12px;overflow:hidden;"><tr>
${photoCell}
<td style="padding:12px 14px;vertical-align:top;">
<div style="font-size:18px;font-weight:700;color:#C9A84C;margin-bottom:4px;">${price}</div>
<div style="font-size:12px;color:#A09070;margin-bottom:6px;">${details}</div>
<div style="font-size:13px;color:#E0DDD4;margin-bottom:6px;font-weight:500;">${address}</div>
${remarks ? `<div style="font-size:11px;color:#8A7060;line-height:1.5;margin-bottom:8px;">${remarks}&hellip;</div>` : ''}
<a href="${listingUrl}" style="display:inline-block;padding:6px 16px;background:#C9A84C;color:#1A0E00;border-radius:5px;font-size:12px;font-weight:700;text-decoration:none;">View ${isRental ? 'Rental' : 'Listing'} &rarr;</a>
</td></tr></table>`;
  }).join('');

  const typeLabel = isRental ? 'rental' : 'home';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#1A1200;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#1A1200;"><tr><td align="center" style="padding:24px 12px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;">
<tr><td style="background:#1A1200;padding:16px 24px;border-bottom:2px solid #C9A84C;">
<table width="100%" cellpadding="0" cellspacing="0"><tr>
<td><div style="font-size:20px;font-weight:800;color:#C9A84C;">Rates &amp; Realty</div><div style="font-size:10px;color:#5A4820;text-transform:uppercase;letter-spacing:.12em;margin-top:2px;">${isRental ? 'Rental Alert' : 'Listing Alert'}</div></td>
<td align="right"><div style="background:rgba(201,168,76,.15);border:1px solid rgba(201,168,76,.4);color:#C9A84C;font-size:12px;font-weight:800;padding:5px 14px;border-radius:20px;">${n} New Match${n===1?'':'es'}</div></td>
</tr></table></td></tr>
<tr><td style="background:#1A1200;padding:20px 24px 12px;">
<div style="font-size:18px;font-weight:700;color:#F0EDE4;">${firstName}, ${n} ${typeLabel}${n===1?'':'s'} match your &ldquo;${alert.name}&rdquo; alert!</div>
<div style="margin-top:10px;"><a href="${searchUrl}" style="display:inline-block;padding:8px 18px;background:rgba(201,168,76,.12);border:1px solid rgba(201,168,76,.4);color:#C9A84C;border-radius:6px;font-size:12px;font-weight:600;text-decoration:none;">&#128269; View All Results &rarr;</a></div>
</td></tr>
<tr><td style="padding:0 24px 16px;"><div style="background:#261800;border:1px solid #4A3000;border-radius:8px;padding:12px 16px;">
<div style="font-size:10px;font-weight:700;color:#7A5820;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;">Your Search Criteria</div>
<div style="font-weight:600;color:#F0EDE4;font-size:13px;margin-bottom:8px;">${alert.name}</div>
${buildCriteriaRows(alert)}
</div></td></tr>
<tr><td style="padding:0 24px;">${cards}${overflow > 0 ? `<div style="text-align:center;font-size:12px;color:#7A5820;padding:6px 0 10px;">&hellip;and ${overflow} more</div>` : ''}</td></tr>
<tr><td style="padding:16px 24px 20px;" align="center">
<a href="${searchUrl}" style="display:inline-block;background:linear-gradient(135deg,#C9A84C,#e8c96a);color:#1A0E00;text-decoration:none;padding:13px 30px;border-radius:8px;font-weight:800;font-size:14px;">&#127968; View All ${n} Match${n===1?'':'es'} &rarr;</a>
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #2A1800;">
<div style="font-size:11px;color:#4A4035;line-height:1.7;">Rene Duarte &middot; Rates &amp; Realty &middot; <a href="mailto:rene@ratesandrealty.com" style="color:#C9A84C;text-decoration:none;">rene@ratesandrealty.com</a> &middot; <a href="tel:7144728508" style="color:#C9A84C;text-decoration:none;">714-472-8508</a><br>NMLS #1795044 &middot; Equal Housing Lender</div>
</td></tr>
</table></td></tr></table></body></html>`;
}

async function sendEmail(to: string, name: string, subject: string, html: string) {
  if (!MS_KEY) return { sent: false, error: "No MAILERSEND_API_KEY" };
  const res = await fetch("https://api.mailersend.com/v1/email", {
    method: "POST",
    headers: { Authorization: `Bearer ${MS_KEY}`, "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({ from: { email: "rene@ratesandrealty.com", name: "Rene Duarte | Rates & Realty" }, to: [{ email: to, name }], subject, html }),
  });
  const txt = await res.text();
  console.log(`[listing-alerts] MailerSend ${res.status}: ${txt.substring(0,100)}`);
  return { sent: res.ok, error: res.ok ? undefined : `${res.status}: ${txt.substring(0,100)}` };
}

function isDue(a: AlertRow): boolean {
  if (!a.last_sent_at) return true;
  const elapsed = Date.now() - new Date(a.last_sent_at).getTime();
  const freq = (a.frequency || 'daily').toLowerCase();
  if (freq === 'instant') return true;
  if (freq === 'weekly') return elapsed > 6.5 * 24 * 3600000;
  return elapsed > 23 * 3600000;
}

async function processSmsQueue() {
  const { data: pending } = await sb.from('listing_alert_sms_queue')
    .select('*').is('sent_at', null).lte('send_after', new Date().toISOString()).limit(50);
  if (!pending?.length) return;
  for (const item of pending) {
    try {
      await fetch(SMS_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') },
        body: JSON.stringify({ trigger: 'custom', to_phone: item.phone, contact_id: item.contact_id || undefined, portal_user_id: item.portal_user_id || undefined, params: { message: item.message } })
      });
      await sb.from('listing_alert_sms_queue').update({ sent_at: new Date().toISOString() }).eq('id', item.id);
    } catch(e: any) { console.log(`[sms-queue] Failed:`, e.message); }
  }
}

Deno.serve(async (_req) => {
  const t0 = Date.now();
  try {
    await processSmsQueue();
    const { data: alerts, error } = await sb.from('listing_alerts').select('*').eq('is_active', true);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    if (!alerts?.length) return new Response(JSON.stringify({ processed: 0 }));

    let sent = 0, skipped = 0;
    const log: any[] = [];

    for (const alert of alerts as AlertRow[]) {
      const entry: any = { name: alert.name, id: alert.id.substring(0,8), listing_type: alert.listing_type };
      if (!isDue(alert)) { entry.status = 'not_due'; log.push(entry); skipped++; continue; }

      await sb.from('listing_alerts').update({ last_checked_at: new Date().toISOString() }).eq('id', alert.id);

      let listings: Listing[] = [];
      try {
        listings = await fetchMlsListings(alert);
        entry.mls_count = listings.length;
      } catch (e: any) { entry.status = 'trestle_error'; entry.error = e.message; log.push(entry); continue; }

      if (!listings.length) { entry.status = 'no_listings'; log.push(entry); continue; }

      const { data: sent_rows } = await sb.from('alert_sent_listings').select('listing_key').eq('alert_id', alert.id);
      const sentKeys = new Set((sent_rows || []).map((r: any) => r.listing_key));
      const newL = listings.filter(l => !sentKeys.has(l.ListingKey))
        .sort((a, b) => {
          const ta = a.ModificationTimestamp ? new Date(a.ModificationTimestamp).getTime() : 0;
          const tb = b.ModificationTimestamp ? new Date(b.ModificationTimestamp).getTime() : 0;
          return tb - ta;
        });

      entry.new_count = newL.length;
      if (!newL.length) { entry.status = 'all_sent'; log.push(entry); continue; }

      let email = '', firstName = 'there', phone = '';
      if (alert.contact_id) {
        const { data: c } = await sb.from('contacts').select('email,first_name,phone').eq('id', alert.contact_id).single();
        if (c) { email = c.email||''; firstName = c.first_name||'there'; phone = c.phone||''; }
      }
      if (!email && alert.portal_user_id) {
        const { data: pu } = await sb.from('portal_users').select('email,first_name,phone').eq('id', alert.portal_user_id).single();
        if (pu) { email = pu.email||''; firstName = pu.first_name||'there'; phone = phone||pu.phone||''; }
      }
      if (!email) { entry.status = 'no_email'; log.push(entry); continue; }

      const isRental = alert.listing_type === 'rent';
      const subject = `${isRental ? '\uD83C\uDFE0 Rental Alert' : '\uD83C\uDFE1'} ${newL.length} New ${isRental ? 'Rental' : 'Listing'}${newL.length===1?'':'s'} \u2014 ${alert.name}`;
      const html = buildEmail(firstName, alert, newL);
      const result = await sendEmail(email, firstName, subject, html);
      entry.email_sent = result.sent;
      if (!result.sent) { entry.status = 'email_failed'; entry.error = result.error; log.push(entry); continue; }

      await sb.from('alert_sent_listings').insert(newL.map(l => ({ alert_id: alert.id, listing_key: l.ListingKey, sent_at: new Date().toISOString() })));
      await sb.from('listing_alerts').update({ last_sent_at: new Date().toISOString(), total_sent: (alert.total_sent||0)+newL.length, updated_at: new Date().toISOString() }).eq('id', alert.id);

      if (alert.contact_id) {
        await sb.from('activity_events').insert({ contact_id: alert.contact_id, portal_user_id: alert.portal_user_id||null, type: 'email', channel: 'email', title: `Listing Alert: ${newL.length} matches for "${alert.name}"`, description: newL.slice(0,3).map(l=>l.UnparsedAddress).join('; '), status: 'sent', email_subject: subject, email_to: email, email_from: 'rene@ratesandrealty.com', created_at: new Date().toISOString() });
      }

      if (phone) {
        try {
          const longUrl = buildSearchUrl(alert);
          const shortUrl = await makeShortLink(longUrl, alert.contact_id || undefined);
          const smsMsg = `${isRental ? '\uD83C\uDFE0' : '\uD83C\uDFE1'} ${newL.length} new ${isRental ? 'rental' : 'home'}${newL.length===1?'':'s'} match your "${alert.name}" alert!\n\n${shortUrl}\n\n- Rene @ Rates & Realty`;
          const sendAfter = new Date(Date.now() + SMS_DELAY_MS).toISOString();
          await sb.from('listing_alert_sms_queue').insert({ alert_id: alert.id, contact_id: alert.contact_id || null, portal_user_id: alert.portal_user_id || null, phone, message: smsMsg, short_url: shortUrl, send_after: sendAfter });
        } catch(e: any) { console.log(`SMS queue err: ${e.message}`); }
      }

      entry.status = 'sent'; log.push(entry); sent++;
    }

    return new Response(JSON.stringify({ processed: alerts.length, sent, skipped, elapsed_ms: Date.now()-t0, debug: log }), { headers: { 'Content-Type': 'application/json' } });
  } catch(e: any) {
    console.error('send-listing-alerts error:', e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireStaff } from "../_shared/require-staff.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

// pull-comps v4
// RentCast AVM -> subject value + SOLD comps. Trestle pass adds photos, lot size, agent remarks,
// listing link + 2 Active and a combined 2 Withdrawn/Canceled comps nearest the subject.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RENTCAST_KEY = Deno.env.get('RENTCAST_API_KEY') || '';
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

const num = (v: any): number | null => { if (v == null || v === '') return null; const f = parseFloat(String(v)); return isNaN(f) ? null : f; };

const mapPropType = (t: any): string | null => {
  if (!t) return null;
  const v = String(t).toLowerCase().trim();
  if (v.includes('single') || v === 'sfr' || v === 'sfd' || v === 'detached') return 'Single Family';
  if (v.includes('condo')) return 'Condo';
  if (v.includes('town')) return 'Townhouse';
  if (v.includes('manufact') || v.includes('mobile')) return 'Manufactured';
  if (v.includes('duplex') || v.includes('triplex') || v.includes('fourplex') || v.includes('multi') || v.includes('plex') || v.includes('2-4') || v.includes('2 to 4')) return 'Multi-Family';
  if (v.includes('apart')) return 'Apartment';
  if (v.includes('land') || v.includes('lot')) return 'Land';
  const valid = ['Single Family','Condo','Townhouse','Manufactured','Multi-Family','Apartment','Land'];
  const match = valid.find(x => x.toLowerCase() === v);
  return match || null;
};

const TRESTLE_SUBTYPE: Record<string, string> = {
  'Single Family': 'SingleFamilyResidence',
  'Condo': 'Condominium',
  'Townhouse': 'Townhouse',
  'Manufactured': 'ManufacturedHome',
};

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8, toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

// \"1618 W 9th St, Santa Ana, CA\" -> \"1618 9TH\"
function normAddr(s: any): string {
  return String(s || '').split(',')[0].toUpperCase().replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\b(STREET|ST|AVENUE|AVE|DRIVE|DR|ROAD|RD|PLACE|PL|LANE|LN|COURT|CT|BOULEVARD|BLVD|WAY|TERRACE|TER|CIRCLE|CIR|PARKWAY|PKWY)\b/g, ' ')
    .replace(/\b(NORTH|SOUTH|EAST|WEST|N|S|E|W)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function streetNum(s: any): string | null { const m = String(s || '').match(/^\s*(\d+)/); return m ? m[1] : null; }

const TRESTLE_SEL = [
  'ListingKey','ListingId','StandardStatus','MlsStatus','PropertyType','PropertySubType',
  'ListPrice','ClosePrice','CloseDate','OnMarketDate','DaysOnMarket','BedroomsTotal',
  'BathroomsTotalInteger','LivingArea','LotSizeSquareFeet','LotSizeAcres','YearBuilt','PublicRemarks',
  'Latitude','Longitude','UnparsedAddress','City','StateOrProvince','PostalCode','StreetNumber','StreetName',
].join(',');

async function trestleProperty(filter: string, opts: { top?: number; media?: boolean; orderby?: string }, dbg: any[]): Promise<any[]> {
  const { top = 25, media = false, orderby } = opts || {};
  const enc = encodeURIComponent;
  const expand = media ? `&$expand=${enc('Media($select=MediaURL,Order;$orderby=Order;$top=1)')}` : '';
  const ob = orderby ? `&$orderby=${enc(orderby)}` : '';
  const rawFilter = `$filter=${enc(filter)}&$select=${enc(TRESTLE_SEL)}&$top=${top}${ob}${expand}`;
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/trestle-proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY },
      body: JSON.stringify({ endpoint: 'Property', rawFilter }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error || d['@odata.error']) {
      dbg.push({ filter: filter.slice(0, 120), status: r.status, error: d.error || d['@odata.error'] || d.detail || 'unknown', media });
      if (media) return await trestleProperty(filter, { top, media: false, orderby }, dbg);
      return [];
    }
    dbg.push({ filter: filter.slice(0, 120), status: r.status, count: d.value?.length ?? 0, media });
    return Array.isArray(d.value) ? d.value : [];
  } catch (e: any) {
    dbg.push({ filter: filter.slice(0, 120), exception: String(e?.message || e), media });
    if (media) return await trestleProperty(filter, { top, media: false, orderby }, dbg);
    return [];
  }
}

function proxyPhoto(mediaUrl: string | null): string | null {
  if (!mediaUrl || !/^https:\/\/api\.cotality\.com\/trestle\//i.test(mediaUrl)) return null;
  return `${SUPABASE_URL}/functions/v1/trestle-proxy?photo=${encodeURIComponent(mediaUrl)}`;
}
function firstMediaUrl(t: any): string | null {
  const media = Array.isArray(t.Media) ? t.Media : [];
  const sorted = media.filter((m: any) => m && m.MediaURL).sort((a: any, b: any) => (a.Order ?? 0) - (b.Order ?? 0));
  return sorted[0]?.MediaURL || null;
}
function trestleLot(t: any): number | null {
  const sf = num(t.LotSizeSquareFeet);
  if (sf != null) return Math.round(sf);
  const ac = num(t.LotSizeAcres);
  return ac != null ? Math.round(ac * 43560) : null;
}
function trestleAddr(t: any): string {
  return t.UnparsedAddress || [t.StreetNumber, t.StreetName, t.City, t.StateOrProvince, t.PostalCode].filter(Boolean).join(' ');
}
function trestleRemarks(t: any): string | null {
  const r = t.PublicRemarks;
  if (!r) return null;
  return String(r).replace(/\s+/g, ' ').trim().slice(0, 1200) || null;
}
function listingLink(addr: string, status?: string | null, city?: string | null, mls?: string | null): string | null {
  const base = 'https://beta.ratesandrealty.com/public';
  // Preferred: deep-link straight to the property's own detail page by MLS number.
  // property-detail.html resolves ?listing_id= against ListingId OR ListingKey.
  const id = String(mls || '').trim();
  if (id) return `${base}/property-detail.html?listing_id=${encodeURIComponent(id)}`;
  // Fallback (no MLS #): city + status scoped search on the agent's site.
  if (!addr) return null;
  const sold = /sold|closed|off-?market/i.test(String(status || ''));
  const p = new URLSearchParams();
  p.set('status', sold ? 'sold' : 'for_sale');
  let cy = String(city || '').trim();
  if (!cy) {
    const parts = String(addr).split(',').map((s) => s.trim());
    if (parts[1] && /[A-Za-z]/.test(parts[1]) && !/^[A-Z]{2}\b/.test(parts[1])) cy = parts[1];
  }
  if (cy) p.set('cities', cy);
  return `${base}/search-homes.html?${p.toString()}`;
}

function mapTrestle(t: any, statusLabel: string, sLat: number | null, sLng: number | null) {
  const sqft = num(t.LivingArea);
  const price = num(t.ClosePrice) ?? num(t.ListPrice);
  const lat = num(t.Latitude), lng = num(t.Longitude);
  const addr = trestleAddr(t);
  const mls = t.ListingId || null;
  return {
    id: t.ListingKey || null,
    address: addr,
    propertyType: t.PropertySubType || t.PropertyType || null,
    bedrooms: num(t.BedroomsTotal),
    bathrooms: num(t.BathroomsTotalInteger),
    squareFootage: sqft,
    lotSize: trestleLot(t),
    yearBuilt: num(t.YearBuilt),
    price,
    pricePerSqft: (price && sqft) ? Math.round(price / sqft) : null,
    distance: (sLat != null && sLng != null && lat != null && lng != null) ? haversine(sLat, sLng, lat, lng) : null,
    daysOnMarket: num(t.DaysOnMarket),
    listingType: null,
    listedDate: t.OnMarketDate || null,
    removedDate: t.CloseDate || null,
    lastSeenDate: null,
    correlation: null,
    latitude: lat,
    longitude: lng,
    mlsName: null,
    mlsNumber: mls,
    status: statusLabel,
    photoUrl: proxyPhoto(firstMediaUrl(t)),
    listingUrl: listingLink(addr, statusLabel, t.City, mls),
    description: trestleRemarks(t),
    source: 'trestle',
  };
}

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
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: cors });
  const err = (m: string, s = 400, extra: any = {}) => new Response(JSON.stringify({ error: m, ...extra }), { status: s, headers: cors });

  try {
    if (!RENTCAST_KEY) return err('RENTCAST_API_KEY is not configured as an edge function secret.', 500);

    const body = await req.json().catch(() => ({}));
    let address: string | null = body.address || null;
    const contact_id = body.contact_id || null;
    const debug = !!body.debug;

    if (!address && contact_id) {
      const { data } = await sb.from('mortgage_applications')
        .select('property_address_street,property_address_city,property_address_state,property_address_zip,number_of_units')
        .eq('contact_id', contact_id).order('created_at', { ascending: false }).limit(1);
      const s = data?.[0] || null;
      if (s) address = [s.property_address_street, s.property_address_city, s.property_address_state, s.property_address_zip].filter(Boolean).join(', ');
    }
    if (!address || !address.trim()) return err('An address (or a contact_id with a property address on file) is required.', 400);

    const radius = num(body.radius) ?? 1;
    const compCount = Math.min(Math.max(Math.round(num(body.compCount) ?? 10), 5), 25);
    const propertyType = mapPropType(body.propertyType);

    const qs = new URLSearchParams();
    qs.set('address', address.trim());
    qs.set('maxRadius', String(radius));
    qs.set('compCount', String(compCount));
    if (propertyType) qs.set('propertyType', propertyType);
    if (num(body.bedrooms) != null) qs.set('bedrooms', String(num(body.bedrooms)));
    if (num(body.bathrooms) != null) qs.set('bathrooms', String(num(body.bathrooms)));
    if (num(body.squareFootage) != null) qs.set('squareFootage', String(num(body.squareFootage)));
    if (num(body.daysOld) != null) qs.set('daysOld', String(num(body.daysOld)));

    const url = 'https://api.rentcast.io/v1/avm/value?' + qs.toString();
    const rc = await fetch(url, { headers: { 'X-Api-Key': RENTCAST_KEY, 'Accept': 'application/json' } });
    const rawTxt = await rc.text();
    let data: any = null;
    try { data = JSON.parse(rawTxt); } catch { /* non-json */ }

    if (!rc.ok) {
      const msg = (data && (data.message || data.error)) || rawTxt || ('RentCast returned ' + rc.status);
      if (rc.status === 404) return err('No comparable sales found for this address within the selected radius. Try widening the radius or check the address.', 404, { rentcast_status: 404 });
      if (rc.status === 401) return err('RentCast rejected the API key (401). Check the RENTCAST_API_KEY secret.', 502, { rentcast_status: 401 });
      return err('RentCast error: ' + msg, 502, { rentcast_status: rc.status });
    }

    const comparables = Array.isArray(data?.comparables) ? data.comparables : [];
    const comps = comparables.map((c: any) => {
      const sqft = num(c.squareFootage);
      const price = num(c.price);
      const addr2 = c.formattedAddress || [c.addressLine1, c.city, c.state, c.zipCode].filter(Boolean).join(', ');
      const mls = c.mlsNumber || null;
      return {
        id: c.id || null,
        address: addr2,
        propertyType: c.propertyType || null,
        bedrooms: num(c.bedrooms),
        bathrooms: num(c.bathrooms),
        squareFootage: sqft,
        lotSize: num(c.lotSize),
        yearBuilt: num(c.yearBuilt),
        price: price,
        pricePerSqft: (price && sqft) ? Math.round(price / sqft) : null,
        distance: num(c.distance),
        daysOnMarket: num(c.daysOnMarket),
        listingType: c.listingType || null,
        listedDate: c.listedDate || null,
        removedDate: c.removedDate || null,
        lastSeenDate: c.lastSeenDate || null,
        correlation: num(c.correlation),
        latitude: num(c.latitude),
        longitude: num(c.longitude),
        mlsName: c.mlsName || null,
        mlsNumber: mls,
        status: c.removedDate ? 'Sold / Off-market' : 'Active',
        photoUrl: null as string | null,
        listingUrl: listingLink(addr2, c.removedDate ? 'Sold / Off-market' : 'Active', c.city, mls),
        description: null as string | null,
        source: 'rentcast',
      };
    });

    const ppsf = comps.map((c) => c.pricePerSqft).filter((x: any) => x != null) as number[];
    const prices = comps.map((c) => c.price).filter((x: any) => x != null) as number[];
    const median = (arr: number[]) => { if (!arr.length) return null; const s = [...arr].sort((a,b)=>a-b); const m = Math.floor(s.length/2); return s.length%2 ? s[m] : Math.round((s[m-1]+s[m])/2); };

    const sLat = num(data?.latitude);
    const sLng = num(data?.longitude);
    const subjectSubtype = TRESTLE_SUBTYPE[propertyType || ''] || null;
    const trestleDbg: any[] = [];
    let added: any[] = [];
    let enriched = 0;

    // ── TRESTLE PASS ────────────────────────────────────────────────────────────────────
    try {
      if (sLat != null && sLng != null) {
        const boxFor = (r: number) => {
          const latD = r / 69, lonD = r / (69 * Math.max(0.2, Math.cos(sLat * Math.PI / 180)));
          return `Latitude ge ${(sLat - latD).toFixed(6)} and Latitude le ${(sLat + latD).toFixed(6)} and Longitude ge ${(sLng - lonD).toFixed(6)} and Longitude le ${(sLng + lonD).toFixed(6)}`;
        };
        const box = boxFor(radius + 0.3);
        const wcBox = boxFor(Math.max(radius * 2, 3));
        const seen = new Set<string>(comps.map((c) => normAddr(c.address)));

        const nearestUnique = (rows: any[], label: string, n: number) => {
          const out: any[] = [];
          const mapped = rows.map((t) => mapTrestle(t, label, sLat, sLng))
            .filter((c) => c.latitude != null && c.longitude != null)
            .sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
          for (const c of mapped) {
            const k = normAddr(c.address);
            if (!k || seen.has(k)) continue;
            seen.add(k); out.push(c);
            if (out.length >= n) break;
          }
          return out;
        };
        const applyEnrich = (c: any, t: any) => {
          if (!c.photoUrl) c.photoUrl = proxyPhoto(firstMediaUrl(t));
          if (c.lotSize == null) c.lotSize = trestleLot(t);
          if (c.latitude == null) c.latitude = num(t.Latitude);
          if (c.longitude == null) c.longitude = num(t.Longitude);
          if (c.yearBuilt == null) c.yearBuilt = num(t.YearBuilt);
          if (!c.description) c.description = trestleRemarks(t);
          if (!c.mlsNumber && t.ListingId) { c.mlsNumber = t.ListingId; c.listingUrl = listingLink(c.address, c.status, t.City, c.mlsNumber); }
        };

        // (a) Enrichment index from recent CLOSED + current ACTIVE listings in radius.
        const cutoff = new Date(Date.now() - 540 * 864e5).toISOString().slice(0, 10);
        const closedRows = await trestleProperty(`StandardStatus eq 'Closed' and ${box} and CloseDate ge ${cutoff}`, { top: 200, media: true, orderby: 'CloseDate desc' }, trestleDbg);
        const activeRows = await trestleProperty(`StandardStatus eq 'Active' and PropertyType eq 'Residential' and ${box}`, { top: 60, media: true }, trestleDbg);
        const idx: Record<string, any> = {};
        for (const t of [...closedRows, ...activeRows]) { const k = normAddr(t.UnparsedAddress || `${t.StreetNumber || ''} ${t.StreetName || ''}`); if (k && !idx[k]) idx[k] = t; }
        for (const c of comps) { const t = idx[normAddr(c.address)]; if (t) { enriched++; applyEnrich(c, t); } }

        // Targeted fallback for any comp still missing a photo (by street number), capped.
        let fb = 0;
        for (const c of comps) {
          if (c.photoUrl || fb >= 3) continue;
          const sn = streetNum(c.address); if (!sn) continue;
          const rows = await trestleProperty(`StreetNumber eq ${sn} and ${box}`, { top: 10, media: true }, trestleDbg);
          fb++;
          const t = rows.find((r) => normAddr(r.UnparsedAddress || `${r.StreetNumber || ''} ${r.StreetName || ''}`) === normAddr(c.address));
          if (t) { enriched++; applyEnrich(c, t); }
        }

        // (b) 2 Active nearest — prefer subject sub-type, then any Residential (reuse activeRows).
        const subtypeRows = subjectSubtype ? activeRows.filter((t) => t.PropertySubType === subjectSubtype) : [];
        let activeComps = nearestUnique(subtypeRows, 'Active', 2);
        if (activeComps.length < 2) activeComps = activeComps.concat(nearestUnique(activeRows, 'Active', 2 - activeComps.length));

        // (c) 2 Withdrawn/Canceled nearest — StandardStatus OR MlsStatus, wider radius; retry w/o type filter.
        const wcStatus = `(StandardStatus eq 'Withdrawn' or StandardStatus eq 'Canceled' or MlsStatus eq 'Withdrawn' or MlsStatus eq 'Cancelled' or MlsStatus eq 'Canceled')`;
        let wcRows = await trestleProperty(`${wcStatus} and PropertyType eq 'Residential' and ${wcBox}`, { top: 40, media: true }, trestleDbg);
        if (!wcRows.length) wcRows = await trestleProperty(`${wcStatus} and ${wcBox}`, { top: 40, media: true }, trestleDbg);
        const wcMapped = wcRows.map((t) => {
          const label = (t.StandardStatus === 'Canceled' || /cancel/i.test(t.MlsStatus || '')) ? 'Canceled' : 'Withdrawn';
          return mapTrestle(t, label, sLat, sLng);
        }).filter((c) => c.latitude != null && c.longitude != null).sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
        const wcComps: any[] = [];
        for (const c of wcMapped) { const k = normAddr(c.address); if (!k || seen.has(k)) continue; seen.add(k); wcComps.push(c); if (wcComps.length >= 2) break; }

        added = [...activeComps, ...wcComps];
      } else {
        trestleDbg.push({ note: 'subject lat/long missing from RentCast; skipped Trestle radius search' });
      }
    } catch (e: any) {
      trestleDbg.push({ fatal: String(e?.message || e) });
    }

    console.log('[pull-comps] trestle', JSON.stringify({ subj: { sLat, sLng, subtype: subjectSubtype }, enriched, added: added.map((a) => ({ a: a.address, s: a.status, pic: !!a.photoUrl })), q: trestleDbg }));

    // Estimated Monthly Rent (RentCast long-term rent AVM) -> available to seed the Deal Analyzer rent field.
    let rentEstimate: number|null = null, rentLow: number|null = null, rentHigh: number|null = null;
    try {
      const rq = new URLSearchParams();
      rq.set('address', address.trim());
      if (propertyType) rq.set('propertyType', propertyType);
      if (num(body.bedrooms) != null) rq.set('bedrooms', String(num(body.bedrooms)));
      if (num(body.bathrooms) != null) rq.set('bathrooms', String(num(body.bathrooms)));
      if (num(body.squareFootage) != null) rq.set('squareFootage', String(num(body.squareFootage)));
      rq.set('maxRadius', '5'); rq.set('compCount', '12');
      const rr = await fetch('https://api.rentcast.io/v1/avm/rent/long-term?' + rq.toString(), { headers: { 'X-Api-Key': RENTCAST_KEY, 'Accept': 'application/json' } });
      if (rr.ok) { const rd = await rr.json().catch(() => null); if (rd) { rentEstimate = num(rd.rent); rentLow = num(rd.rentRangeLow); rentHigh = num(rd.rentRangeHigh); } }
    } catch (_e) { /* rent estimate is best-effort; never blocks comps */ }

    const allComps = [...comps, ...added];
    const result: any = {
      success: true,
      subject: { address: address.trim(), propertyType: propertyType || null, bedrooms: num(body.bedrooms), bathrooms: num(body.bathrooms), squareFootage: num(body.squareFootage), latitude: sLat, longitude: sLng },
      value: { estimate: num(data?.price), low: num(data?.priceRangeLow), high: num(data?.priceRangeHigh) },
      rental: { estimate: rentEstimate, low: rentLow, high: rentHigh },
      stats: {
        compCount: allComps.length,
        soldCount: comps.length,
        addedCount: added.length,
        radiusMiles: radius,
        avgPricePerSqft: ppsf.length ? Math.round(ppsf.reduce((a,b)=>a+b,0)/ppsf.length) : null,
        medianPrice: median(prices),
        avgPrice: prices.length ? Math.round(prices.reduce((a,b)=>a+b,0)/prices.length) : null,
      },
      comps: allComps,
    };
    if (debug) { result._raw = data; result._trestle = trestleDbg; }
    return ok(result);
  } catch (e: any) {
    console.error('[pull-comps] Error:', e?.message || e);
    return err(e?.message || 'Server error', 500);
  }
});

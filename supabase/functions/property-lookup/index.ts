import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

// property-lookup v1
// Address -> RentCast property details + AVM value estimate (+ best-effort rent).
// Saves the latest estimate per contact in public.property_estimates and serves it back
// cheaply via mode:'get' (no RentCast call) so page loads don't burn API quota.

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

function mapDetails(rec: any) {
  if (!rec) return null;
  return {
    propertyType: rec.propertyType || null,
    bedrooms: num(rec.bedrooms),
    bathrooms: num(rec.bathrooms),
    squareFootage: num(rec.squareFootage),
    lotSize: num(rec.lotSize),
    yearBuilt: num(rec.yearBuilt),
    lastSalePrice: num(rec.lastSalePrice),
    lastSaleDate: rec.lastSaleDate || null,
    county: rec.county || null,
    subdivision: rec.subdivision || null,
    formattedAddress: rec.formattedAddress || null,
    ownerOccupied: typeof rec.ownerOccupied === 'boolean' ? rec.ownerOccupied : null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: cors });
  const err = (m: string, s = 400, extra: any = {}) => new Response(JSON.stringify({ error: m, ...extra }), { status: s, headers: cors });

  try {
    const body = await req.json().catch(() => ({}));
    const contact_id = body.contact_id || null;
    const mode = String(body.mode || 'fetch');

    // ── GET SAVED (no RentCast call) ──────────────────────────────────────────
    if (mode === 'get') {
      if (!contact_id) return err('contact_id required for mode=get', 400);
      const { data } = await sb.from('property_estimates').select('*').eq('contact_id', contact_id).maybeSingle();
      return ok({ success: true, saved: !!data, estimate: data || null });
    }

    if (!RENTCAST_KEY) return err('RENTCAST_API_KEY is not configured as an edge function secret.', 500);

    // ── RESOLVE ADDRESS ──────────────────────────────────────────────────────
    let address: string = String(body.address || '').trim();
    if (!address && contact_id) {
      const { data } = await sb.from('mortgage_applications')
        .select('property_address_street,property_address_city,property_address_state,property_address_zip')
        .eq('contact_id', contact_id).order('created_at', { ascending: false }).limit(1);
      const s = data?.[0];
      if (s) address = [s.property_address_street, s.property_address_city, s.property_address_state, s.property_address_zip].filter(Boolean).join(', ');
    }
    if (!address) return err('An address (or a contact_id with a property address on file) is required.', 400);

    const rcHeaders = { 'X-Api-Key': RENTCAST_KEY, 'Accept': 'application/json' };

    // ── PROPERTY DETAILS (RentCast /properties) ──────────────────────────────
    let details: any = null;
    try {
      const pr = await fetch('https://api.rentcast.io/v1/properties?address=' + encodeURIComponent(address), { headers: rcHeaders });
      if (pr.ok) {
        const pd = await pr.json().catch(() => null);
        const rec = Array.isArray(pd) ? pd[0] : (pd && Array.isArray(pd.data) ? pd.data[0] : pd);
        details = mapDetails(rec);
      }
    } catch (_e) { /* details are best-effort */ }

    // ── VALUE AVM (RentCast /avm/value), enriched with details for accuracy ──
    let value = { estimate: null as number | null, low: null as number | null, high: null as number | null };
    let value_error: string | null = null;
    try {
      const q = new URLSearchParams();
      q.set('address', address);
      if (details?.propertyType) q.set('propertyType', String(details.propertyType));
      if (details?.bedrooms != null) q.set('bedrooms', String(details.bedrooms));
      if (details?.bathrooms != null) q.set('bathrooms', String(details.bathrooms));
      if (details?.squareFootage != null) q.set('squareFootage', String(details.squareFootage));
      const vr = await fetch('https://api.rentcast.io/v1/avm/value?' + q.toString(), { headers: rcHeaders });
      if (vr.ok) {
        const vd = await vr.json().catch(() => null);
        if (vd) value = { estimate: num(vd.price), low: num(vd.priceRangeLow), high: num(vd.priceRangeHigh) };
      } else if (vr.status === 404) {
        value_error = 'No automated value estimate is available for this address.';
      } else if (vr.status === 401) {
        value_error = 'RentCast rejected the API key (401).';
      } else {
        value_error = 'Value service returned ' + vr.status + '.';
      }
    } catch (e: any) { value_error = String(e?.message || e); }

    // ── RENT AVM (best-effort) ──────────────────────────────────────────────
    let rent = { estimate: null as number | null, low: null as number | null, high: null as number | null };
    try {
      const rq = new URLSearchParams();
      rq.set('address', address);
      if (details?.propertyType) rq.set('propertyType', String(details.propertyType));
      if (details?.bedrooms != null) rq.set('bedrooms', String(details.bedrooms));
      if (details?.bathrooms != null) rq.set('bathrooms', String(details.bathrooms));
      if (details?.squareFootage != null) rq.set('squareFootage', String(details.squareFootage));
      const rr = await fetch('https://api.rentcast.io/v1/avm/rent/long-term?' + rq.toString(), { headers: rcHeaders });
      if (rr.ok) { const rd = await rr.json().catch(() => null); if (rd) rent = { estimate: num(rd.rent), low: num(rd.rentRangeLow), high: num(rd.rentRangeHigh) }; }
    } catch (_e) { /* rent is best-effort */ }

    const fetched_at = new Date().toISOString();
    if (!value.estimate && !details) {
      return err(value_error || 'No property data found for this address. Check the address and try again.', 404, { address });
    }

    // ── SAVE (upsert latest per contact) ─────────────────────────────────────
    if (contact_id && body.save !== false) {
      try {
        await sb.from('property_estimates').upsert({
          contact_id, address,
          estimated_value: value.estimate, value_low: value.low, value_high: value.high,
          rent_estimate: rent.estimate, rent_low: rent.low, rent_high: rent.high,
          details: details || {}, source: 'rentcast', fetched_at, updated_at: fetched_at,
        }, { onConflict: 'contact_id' });
      } catch (_e) { /* persistence best-effort; still return the data */ }
    }

    return ok({ success: true, address, value, rent, details, value_error, fetched_at });
  } catch (e: any) {
    return err(e?.message || 'Server error', 500);
  }
});

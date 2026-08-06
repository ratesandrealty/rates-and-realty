import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireStaff } from "../_shared/require-staff.ts";

// address-autocomplete — proxies Google Places Autocomplete (US addresses).
// Prefers a dedicated SERVER key (no HTTP-referrer restriction) over the browser maps key,
// since server-side calls send no referer and referrer-restricted keys are rejected by Google.

const KEY_SOURCES: [string, string][] = [
  ['GOOGLE_PLACES_SERVER_KEY', Deno.env.get('GOOGLE_PLACES_SERVER_KEY') || ''],
  ['GOOGLE_PLACES_API_KEY', Deno.env.get('GOOGLE_PLACES_API_KEY') || ''],
  ['GOOGLE_SERVER_API_KEY', Deno.env.get('GOOGLE_SERVER_API_KEY') || ''],
  ['GOOGLE_MAPS_API_KEY', Deno.env.get('GOOGLE_MAPS_API_KEY') || ''],
  ['GOOGLE_STATIC_MAPS_API_KEY', Deno.env.get('GOOGLE_STATIC_MAPS_API_KEY') || ''],
  ['GOOGLE_MAPS_STATIC_API_KEY', Deno.env.get('GOOGLE_MAPS_STATIC_API_KEY') || ''],
  ['GOOGLE_API_KEY', Deno.env.get('GOOGLE_API_KEY') || ''],
  ['GOOGLE_MAPS_KEY', Deno.env.get('GOOGLE_MAPS_KEY') || ''],
];
const KEY_ENTRY = KEY_SOURCES.find(([, v]) => v) || ['', ''];
const GKEY = KEY_ENTRY[1];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
  'Content-Type': 'application/json',
};

async function viaNew(q: string) {
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GKEY },
      body: JSON.stringify({ input: q, includedRegionCodes: ['us'] }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: 'NEW_' + r.status, error: d?.error?.message || null };
    const preds = (Array.isArray(d.suggestions) ? d.suggestions : [])
      .map((s: any) => s.placePrediction).filter(Boolean).slice(0, 6).map((p: any) => ({
        description: p.text?.text || '',
        place_id: p.placeId || '',
        main: p.structuredFormat?.mainText?.text || p.text?.text || '',
        secondary: p.structuredFormat?.secondaryText?.text || '',
      }));
    return { ok: true, predictions: preds, via: 'new' };
  } catch (e: any) { return { ok: false, status: 'NEW_EXCEPTION', error: String(e?.message || e) }; }
}

async function viaLegacy(q: string) {
  try {
    const url = 'https://maps.googleapis.com/maps/api/place/autocomplete/json'
      + `?input=${encodeURIComponent(q)}&types=address&components=country:us&key=${GKEY}`;
    const r = await fetch(url);
    const d = await r.json().catch(() => ({}));
    if (d.status && d.status !== 'OK' && d.status !== 'ZERO_RESULTS') return { ok: false, status: d.status, error: d.error_message || null };
    const preds = (Array.isArray(d.predictions) ? d.predictions : []).slice(0, 6).map((p: any) => ({
      description: p.description,
      place_id: p.place_id,
      main: p.structured_formatting?.main_text || p.description,
      secondary: p.structured_formatting?.secondary_text || '',
    }));
    return { ok: true, predictions: preds, via: 'legacy' };
  } catch (e: any) { return { ok: false, status: 'LEGACY_EXCEPTION', error: String(e?.message || e) }; }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  /* GUARD FIRST — before the body or query string is read, so an action
     added later is covered by default rather than by remembering.
     verify_jwt=true does NOT do this: the anon key is a project-signed JWT
     printed in every page's source. See docs/PINNED-NOT-GUARDED.md. */
  const _auth = await requireStaff(req);
  if (!_auth.ok) return new Response(JSON.stringify({ error: _auth.msg || 'not authorized' }),
    { status: _auth.status || 401, headers: { ...cors, 'Content-Type': 'application/json' } });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const input = String(body.input || '').trim();
    if (input.length < 3) return ok({ predictions: [] });
    if (!GKEY) return ok({ predictions: [], status: 'NO_KEY', error: 'Google key not configured in Supabase secrets' });

    const res = await viaNew(input);
    if (res.ok) return ok(res);
    const legacy = await viaLegacy(input);
    if (legacy.ok) return ok(legacy);
    return ok({ predictions: [], status: res.status, error: res.error, legacy_status: legacy.status, legacy_error: legacy.error });
  } catch (e: any) {
    return ok({ predictions: [], error: String(e?.message || e) });
  }
});

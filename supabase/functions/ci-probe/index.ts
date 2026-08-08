/* ci-probe — TEMPORARY, READ-ONLY. Delete after use.
 *
 * Answers one question that cannot be answered from the repo or from Postgres:
 * what is actually provisioned on the Twilio account for Conversational
 * Intelligence. The credentials live only as Supabase function secrets, so
 * something has to run inside a function to see them.
 *
 * Deliberately has NO INPUT. It performs a fixed list of GETs and returns what
 * they said. A probe that takes a caller-supplied path is an SSRF with the
 * Twilio account credential attached — the same trap get_recording documents at
 * twilio-voice/index.ts:838. There is nothing to point at anything here.
 *
 * GET only. It creates nothing, so running it cannot cost money or leave a
 * resource behind.
 *
 * Gated on CI_PROBE_KEY, a secret minted for this probe alone and unset with it.
 */
const ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
const AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
const PROBE_KEY = Deno.env.get('CI_PROBE_KEY') || '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-probe-key',
  'Content-Type': 'application/json',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const key = (req.headers.get('x-probe-key') || '').trim();
  if (!PROBE_KEY || key !== PROBE_KEY) {
    return new Response(JSON.stringify({ error: 'nope' }), { status: 403, headers: cors });
  }
  if (!ACCOUNT_SID || !AUTH_TOKEN) {
    return new Response(JSON.stringify({ error: 'Twilio not configured' }), { status: 500, headers: cors });
  }

  const auth = 'Basic ' + btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`);
  const get = async (label: string, url: string) => {
    try {
      const r = await fetch(url, { headers: { Authorization: auth } });
      const text = await r.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 400); }
      return { label, status: r.status, body };
    } catch (e) {
      return { label, status: 0, body: String(e) };
    }
  };

  const A = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}`;
  const results = await Promise.all([
    // Is Conversational Intelligence (classic) reachable, and are any Services provisioned?
    get('services', 'https://intelligence.twilio.com/v2/Services?PageSize=20'),
    // What Language Operators does this account have available / attached?
    get('operators', 'https://intelligence.twilio.com/v2/Operators?PageSize=50'),
    get('prebuilt_operators', 'https://intelligence.twilio.com/v2/PrebuiltOperators?PageSize=50'),
    // Has anything ever been transcribed here?
    get('transcripts', 'https://intelligence.twilio.com/v2/Transcripts?PageSize=5'),
    // The two recordings we intend to prove this on — do they exist, and are
    // they encrypted? Conversational Intelligence cannot read encrypted
    // recordings (Twilio error 95119), which would rule out source_sid entirely.
    get('rec_8d14969b', `${A}/Recordings/RE5e1965910cf300826d168a82c57723a7.json`),
    get('rec_0e2d8594', `${A}/Recordings/RE49dfdf06cf293d474b4a5c4dff112fc4.json`),
    // How many recordings exist in total, for scale.
    get('recordings_page', `${A}/Recordings.json?PageSize=1`),
  ]);

  return new Response(JSON.stringify({ account: ACCOUNT_SID, results }, null, 2), { headers: cors });
});

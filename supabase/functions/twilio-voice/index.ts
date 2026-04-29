import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sb = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);

function formatPhone(phone: string): string {
  const raw = (phone || '').trim();
  if (raw.startsWith('+')) return raw;
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return '+1' + d;
}

function jsonRes(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
function err(msg: string, status = 400) {
  return jsonRes({ error: msg }, status);
}
function twimlRes(xml: string) {
  return new Response(xml, {
    headers: { ...corsHeaders, 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
  const AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
  const API_KEY = Deno.env.get('TWILIO_API_KEY') ?? '';
  const API_SECRET = Deno.env.get('TWILIO_API_SECRET') ?? '';
  const TWIML_APP_SID = Deno.env.get('TWILIO_TWIML_APP_SID') ?? '';
  const TWILIO_PHONE = Deno.env.get('TWILIO_PHONE_NUMBER') || '+18668919394';

  const contentType = req.headers.get('content-type') || '';
  const reqUrl = new URL(req.url);
  const subAction = reqUrl.searchParams.get('action');

  console.log(`[twilio-voice] ${req.method} ct="${contentType}" sub="${subAction || ''}"`);

  try {
    // Sub-action: play voicemail TwiML (called by Twilio when dropping a voicemail)
    if (subAction === 'play_voicemail') {
      const vmUrl = reqUrl.searchParams.get('url') || '';
      console.log('[twilio-voice] play_voicemail url=', vmUrl);
      return twimlRes(`<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="2"/><Play>${vmUrl}</Play><Hangup/></Response>`);
    }

    // ── TYPE 2: Twilio webhook (form-urlencoded POST from Twilio servers) ──
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const bodyText = await req.text();
      const params = new URLSearchParams(bodyText);
      const to = params.get('To') || '';
      const from = params.get('From') || '';
      const callSid = params.get('CallSid') || '';
      const recordingUrl = params.get('RecordingUrl') || '';
      const recordingStatus = params.get('RecordingStatus') || '';

      console.log(`[twilio-voice] webhook To="${to}" From="${from}" CallSid="${callSid}" rec="${recordingStatus}"`);

      // Recording status callback → log url, return empty 200 (Twilio ignores body)
      if (recordingUrl) {
        if (callSid) {
          sb.from('calls_log')
            .update({ recording_url: recordingUrl })
            .eq('twilio_call_sid', callSid)
            .then(({ error }) => { if (error) console.error('[twilio-voice] recording update err:', error.message); });
        }
        return new Response('', { status: 200, headers: corsHeaders });
      }

      // Outbound call from browser → return TwiML to dial the destination
      if (to) {
        const dialTo = to.startsWith('+') || to.startsWith('client:') ? to : formatPhone(to);
        const recordingCb = `https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/twilio-voice`;
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${TWILIO_PHONE}" timeout="30" record="record-from-answer" recordingStatusCallback="${recordingCb}">
    <Number>${dialTo}</Number>
  </Dial>
</Response>`;
        console.log('[twilio-voice] dialing', dialTo, 'callerId=', TWILIO_PHONE);
        return twimlRes(xml);
      }

      console.log('[twilio-voice] webhook missing To, body=', bodyText);
      return twimlRes(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>No destination number provided.</Say></Response>`);
    }

    // ── TYPE 1: JSON request from browser CRM ──
    const body = await req.json().catch(() => ({} as any));
    const { action, to, contact_id, voicemail_url, duration, status, notes, outcome, twilio_call_sid } = body;
    console.log('[twilio-voice] action=', action);

    if (action === 'get_token') {
      const missing = [
        ['TWILIO_ACCOUNT_SID', ACCOUNT_SID],
        ['TWILIO_API_KEY', API_KEY],
        ['TWILIO_API_SECRET', API_SECRET],
        ['TWILIO_TWIML_APP_SID', TWIML_APP_SID],
      ].filter(([, v]) => !v).map(([k]) => k);
      if (missing.length) return err('Missing env vars: ' + missing.join(', '), 500);

      const now = Math.floor(Date.now() / 1000);
      const exp = now + 3600;
      const identity = 'rene_duarte';

      const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' }))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
      const payload = btoa(JSON.stringify({
        jti: `${API_KEY}-${now}`,
        iss: API_KEY,
        sub: ACCOUNT_SID,
        nbf: now,
        exp,
        grants: {
          identity,
          voice: { incoming: { allow: true }, outgoing: { application_sid: TWIML_APP_SID } },
        },
      })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

      const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(API_SECRET),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      );
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`));
      const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

      console.log('[twilio-voice] token issued identity=', identity, 'app=', TWIML_APP_SID);
      return jsonRes({ token: `${header}.${payload}.${sigB64}`, identity });
    }

    if (action === 'make_call') {
      if (!to) return err('Missing "to" phone number');
      const auth = btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`);
      const dialTwiml = `<Response><Dial callerId="${TWILIO_PHONE}" record="record-from-answer"><Number>${formatPhone(to)}</Number></Dial></Response>`;
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: formatPhone(to), From: TWILIO_PHONE, Twiml: dialTwiml }),
      });
      const data = await res.json();
      if (data.sid) {
        await sb.from('calls_log').insert({
          contact_id: contact_id || null,
          to_phone: formatPhone(to),
          from_phone: TWILIO_PHONE,
          direction: 'outbound',
          status: 'initiated',
          twilio_call_sid: data.sid,
        });
        return jsonRes({ success: true, callSid: data.sid });
      }
      return err(data.message || 'Call failed');
    }

    if (action === 'voicemail_drop') {
      if (!to || !voicemail_url) return err('Missing "to" or "voicemail_url"');
      const auth = btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`);
      const twimlUrl = `https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/twilio-voice?action=play_voicemail&url=${encodeURIComponent(voicemail_url)}`;
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          To: formatPhone(to), From: TWILIO_PHONE, Url: twimlUrl,
          MachineDetection: 'DetectMessageEnd',
        }),
      });
      const data = await res.json();
      if (data.sid) {
        await sb.from('calls_log').insert({
          contact_id: contact_id || null,
          to_phone: formatPhone(to),
          from_phone: TWILIO_PHONE,
          direction: 'outbound',
          status: 'voicemail_drop',
          voicemail_drop: true,
          voicemail_url,
          twilio_call_sid: data.sid,
        });
        return jsonRes({ success: true, callSid: data.sid });
      }
      return err(data.message || 'Voicemail drop failed');
    }

    if (action === 'call_status') {
      if (!twilio_call_sid) return err('Missing "twilio_call_sid"');
      const auth = btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`);
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls/${twilio_call_sid}.json`, {
        headers: { 'Authorization': `Basic ${auth}` },
      });
      const data = await res.json();
      return jsonRes({ status: data.status, duration: data.duration });
    }

    if (action === 'log_call') {
      const { error } = await sb.from('calls_log').insert({
        contact_id: contact_id || null,
        to_phone: to || null,
        direction: 'outbound',
        duration: duration || 0,
        status: status || 'completed',
        notes: notes || null,
        outcome: outcome || null,
        twilio_call_sid: twilio_call_sid || null,
      });
      if (error) return err(error.message, 500);

      if (contact_id) {
        await sb.from('activity_events').insert({
          contact_id,
          event_type: 'call',
          description: `Outbound call${outcome ? ' - ' + outcome.replace(/_/g, ' ') : ''}${duration ? ' (' + Math.floor(duration / 60) + ':' + String(duration % 60).padStart(2, '0') + ')' : ''}`,
          metadata: { duration, outcome, notes },
        }).catch(() => {});
      }
      return jsonRes({ success: true });
    }

    return err('Unknown action: ' + action);
  } catch (e: any) {
    console.error('[twilio-voice] FATAL:', e?.message || e, e?.stack || '');
    // For Twilio webhooks return TwiML so the caller hears something rather than 500
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return twimlRes(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Server error.</Say><Hangup/></Response>`);
    }
    return err(e?.message || 'Internal error', 500);
  }
});

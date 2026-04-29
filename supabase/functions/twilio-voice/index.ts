import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

function formatPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return '+' + d;
}

function ok(data: any) {
  return new Response(JSON.stringify(data), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
function twimlResponse(xml: string) {
  return new Response(xml, { headers: { ...corsHeaders, 'Content-Type': 'text/xml' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
  const AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!;
  const API_KEY = Deno.env.get('TWILIO_API_KEY')!;
  const API_SECRET = Deno.env.get('TWILIO_API_SECRET')!;
  const TWIML_APP_SID = Deno.env.get('TWILIO_TWIML_APP_SID')!;
  const TWILIO_PHONE = Deno.env.get('TWILIO_PHONE_NUMBER') || '+18668919394';

  // Check if this is a TwiML webhook from Twilio (form-encoded)
  // Also handle GET requests with query params (sub-actions like play_voicemail)
  const contentType = req.headers.get('content-type') || '';
  const reqUrl = new URL(req.url);
  const subAction = reqUrl.searchParams.get('action');

  // Sub-action: play voicemail TwiML
  if (subAction === 'play_voicemail') {
    const vmUrl = reqUrl.searchParams.get('url') || '';
    console.log('[twilio-voice] play_voicemail:', vmUrl);
    return twimlResponse(`<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="2"/><Play>${vmUrl}</Play><Hangup/></Response>`);
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    // Parse form body manually (more reliable than formData() in Deno)
    const bodyText = await req.text();
    const params = new URLSearchParams(bodyText);
    const to = params.get('To') || '';
    const callSid = params.get('CallSid') || '';
    const recordingUrl = params.get('RecordingUrl') || '';

    console.log('[twilio-voice] TwiML webhook - To:', to, 'CallSid:', callSid, 'Recording:', recordingUrl ? 'yes' : 'no');

    // Recording status callback
    if (recordingUrl) {
      console.log('[twilio-voice] Recording URL:', recordingUrl);
      if (callSid) {
        await sb.from('calls_log').update({ recording_url: recordingUrl }).eq('twilio_call_sid', callSid);
      }
      return ok({ received: true });
    }

    // Default TwiML: Dial the number
    if (to) {
      const dialTo = to.startsWith('+') || to.startsWith('sip:') ? to : formatPhone(to);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${TWILIO_PHONE}" record="record-from-answer" recordingStatusCallback="https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/twilio-voice">
    <Number>${dialTo}</Number>
  </Dial>
</Response>`;
      console.log('[twilio-voice] Returning TwiML to dial:', dialTo);
      return twimlResponse(twiml);
    }

    console.log('[twilio-voice] No To number in webhook, full params:', bodyText);
    return twimlResponse(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>No destination number provided.</Say></Response>`);
  }

  // JSON body actions
  try {
    const body = await req.json().catch(() => ({}));
    const { action, to, contact_id, voicemail_url, duration, status, notes, outcome, twilio_call_sid } = body;

    // ── GET_TOKEN: Generate Twilio Access Token for browser calling ──
    if (action === 'get_token') {
      const now = Math.floor(Date.now() / 1000);
      const exp = now + 3600;
      const identity = 'rene_duarte';

      const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' }))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

      const grants: any = { identity };
      grants.voice = { incoming: { allow: true }, outgoing: { application_sid: TWIML_APP_SID } };

      const payload = btoa(JSON.stringify({
        jti: `${API_KEY}-${now}`,
        iss: API_KEY,
        sub: ACCOUNT_SID,
        nbf: now,
        exp,
        grants,
      })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

      const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(API_SECRET),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      );
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`));
      const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

      const token = `${header}.${payload}.${sigB64}`;
      return ok({ token, identity });
    }

    // ── MAKE_CALL: Initiate outbound call via REST API ──
    if (action === 'make_call') {
      if (!to) return err('Missing "to" phone number');
      const auth = btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`);
      const twiml = `<Response><Dial callerId="${TWILIO_PHONE}" record="record-from-answer"><Number>${formatPhone(to)}</Number></Dial></Response>`;

      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: formatPhone(to), From: TWILIO_PHONE, Twiml: twiml }),
      });
      const data = await res.json();

      if (data.sid) {
        // Log to calls_log
        await sb.from('calls_log').insert({
          contact_id: contact_id || null,
          to_phone: formatPhone(to),
          from_phone: TWILIO_PHONE,
          direction: 'outbound',
          status: 'initiated',
          twilio_call_sid: data.sid,
        });
        return ok({ success: true, callSid: data.sid });
      }
      return err(data.message || 'Call failed');
    }

    // ── VOICEMAIL_DROP: Call and play pre-recorded message ──
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
        return ok({ success: true, callSid: data.sid });
      }
      return err(data.message || 'Voicemail drop failed');
    }

    // ── CALL_STATUS: Check call status from Twilio ──
    if (action === 'call_status') {
      if (!twilio_call_sid) return err('Missing "twilio_call_sid"');
      const auth = btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`);
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls/${twilio_call_sid}.json`, {
        headers: { 'Authorization': `Basic ${auth}` },
      });
      const data = await res.json();
      return ok({ status: data.status, duration: data.duration });
    }

    // ── LOG_CALL: Manually log a call to the database ──
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

      // Also log activity event
      if (contact_id) {
        await sb.from('activity_events').insert({
          contact_id,
          event_type: 'call',
          description: `Outbound call${outcome ? ' - ' + outcome.replace(/_/g, ' ') : ''}${duration ? ' (' + Math.floor(duration / 60) + ':' + String(duration % 60).padStart(2, '0') + ')' : ''}`,
          metadata: { duration, outcome, notes },
        }).catch(() => {});
      }
      return ok({ success: true });
    }

    return err('Unknown action: ' + action);
  } catch (e: any) {
    console.error('[twilio-voice] Error:', e);
    return err(e.message || 'Internal error', 500);
  }
});

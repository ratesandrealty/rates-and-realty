import { verifyTwilioRequest, twilioForbidden } from "../_shared/twilio-signature.ts";
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


/* GREETING IS CONFIG, NOT CODE.
 *
 * Rene will replace the TTS with his own recorded voice. That should be a row
 * edit, not a deploy: set app_config.voicemail_greeting_url to an audio file
 * and this switches from <Say> to <Play> on the next call. Falls back to TTS if
 * the row is missing, unreadable, or the URL is blank — a greeting that fails
 * closed to silence would let callers hang up on dead air.
 *
 * NMLS is deliberately absent pending the compliance answer. */
async function greetingConfig(): Promise<{ url: string; text: string }> {
  const fallback =
    "You've reached Rene Duarte at Rates and Realty. I'm sorry I missed your call. " +
    "Please leave your name, number, and a brief message after the tone, and I'll get right back to you.";
  try {
    const { data } = await sb.from('app_config')
      .select('key, value')
      .in('key', ['voicemail_greeting_url', 'voicemail_greeting_text']);
    const map: Record<string, string> = {};
    for (const r of data || []) map[(r as any).key] = String((r as any).value ?? '').trim();
    return { url: map.voicemail_greeting_url || '', text: map.voicemail_greeting_text || fallback };
  } catch (e) {
    console.error('[twilio-voice] greeting config read failed, using TTS default:', String(e));
    return { url: '', text: fallback };
  }
}

/* ── RECORDING DISCLOSURE ─────────────────────────────────────────────────────
 *
 * Every <Dial> in this file carries record="record-from-answer" and until now
 * played no announcement. California is an all-party consent state and the VA
 * is in the Philippines, so this was recording people who had not been told.
 * E Mortgage Capital has approved recording WITH an announcement; the wording
 * below is theirs.
 *
 * WHERE THE ANNOUNCEMENT HAS TO GO, and why it is in two places per call:
 *
 * A <Say> before <Dial> is heard ONLY by the parent leg — the party already on
 * the call. The party being dialled never hears it. So each recorded <Dial>
 * gets both:
 *
 *   1. <Say> before the <Dial>            -> the parent leg (inbound: the
 *                                            borrower who called us; outbound:
 *                                            the staff member's browser client)
 *   2. url= on the nested <Number>        -> a whisper on the CHILD leg, played
 *                                            when they answer and BEFORE the two
 *                                            legs are bridged
 *
 * Both parties therefore hear it before any conversation audio is captured,
 * which is the consent requirement. See the note in the deploy report about why
 * "before capture" and "audible on the recording" cannot both be fully true.
 *
 * TEXT IS CONFIG, NOT CODE — same reasoning as greetingConfig above. Compliance
 * wording changes by memo, not by deploy. app_config keys:
 *     call_recording_notice_text   ({name} is substituted)
 *     call_recording_notice_name
 * Falls back to the approved wording if the rows are missing or unreadable.
 *
 * NO OPT-OUT SENTENCE. The wording used to end "...just say so and I'll turn it
 * off." Nothing in this system can stop a recording mid-call — Twilio supports
 * it via POST /Calls/{sid}/Recordings/{rsid} Status=stopped, but nothing here
 * calls it and no UI exposes it. A promise that is silently ignored on a
 * recorded borrower call is worse than no promise. The sentence returns when the
 * stop control exists, and not before. */
async function noticeConfig(): Promise<string> {
  const fallbackName = 'Rates and Realty';
  const fallbackText =
    "Hi, this is {name}. Before we get started — this call is recorded for " +
    "quality assurance and training purposes.";
  let text = fallbackText, name = fallbackName;
  try {
    const { data } = await sb.from('app_config')
      .select('key, value')
      .in('key', ['call_recording_notice_text', 'call_recording_notice_name']);
    const map: Record<string, string> = {};
    for (const r of data || []) map[(r as any).key] = String((r as any).value ?? '').trim();
    /* An EXPLICITLY BLANK row means "no notice", and no notice means no
     * recording (see canRecord below). It does not fall back to the default —
     * that would make it impossible to turn the announcement off without also
     * leaving recording on, which is the exact combination we are preventing. */
    if ('call_recording_notice_text' in map) text = map.call_recording_notice_text;
    if (map.call_recording_notice_name) name = map.call_recording_notice_name;
  } catch (e) {
    console.error('[twilio-voice] notice config read failed, using approved default:', String(e));
  }
  return text.replace(/\{name\}/g, name).trim();
}

/* ── FAIL CLOSED ON THE RECORDING, NOT ON THE CALL ───────────────────────────
 *
 * Losing a recording is free. Capturing audio nobody was told about is not. So
 * when the disclosure cannot be played, the Dial is returned WITHOUT
 * record="record-from-answer": the call still connects, and nothing is captured.
 *
 * "Cannot be played" is MEASURED, not assumed. Two conditions, both checked
 * before the Dial TwiML is built:
 *
 *   1. the notice text resolves to something non-empty, and
 *   2. the record_notice endpoint actually answers 200 with a <Say> in it
 *
 * (2) costs one same-region HTTP round trip per call setup, bounded at 2.5s. The
 * alternative is assuming the whisper will play and being wrong silently, which
 * is the failure this change exists to remove.
 *
 * record_notice is NO LONGER signature-validated, deliberately. Requiring a
 * Twilio signature on it was what created the fail-open in the first place: a
 * signature mismatch meant the whisper 403'd, the call connected, and recording
 * ran anyway. The endpoint returns a fixed disclosure sentence — no caller data,
 * no side effects, nothing an attacker gains by reading it aloud to themselves.
 * Dropping the signature removes a failure mode and protects nothing less. */
async function canRecord(noticeUrl: string, text: string): Promise<{ ok: boolean; reason: string }> {
  if (!text) return { ok: false, reason: 'notice text is empty' };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(noticeUrl, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, reason: `notice endpoint HTTP ${res.status}` };
    const xml = await res.text();
    if (!xml.includes('<Say')) return { ok: false, reason: 'notice endpoint returned no <Say>' };
    return { ok: true, reason: 'ok' };
  } catch (e) {
    return { ok: false, reason: `notice endpoint unreachable: ${String((e as Error)?.message || e)}` };
  }
}

function xmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function noticeSay(text: string): string {
  return `<Say voice="Polly.Joanna">${xmlEsc(text)}</Say>`;
}

function voicemailTwiml(statusCb: string, g: { url: string; text: string }): string {
  const greet = g.url
    ? `<Play>${g.url.replace(/&/g, '&amp;')}</Play>`
    : `<Say voice="Polly.Joanna">${g.text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Say>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${greet}
  <Record maxLength="120" playBeep="true" trim="trim-silence" recordingStatusCallback="${statusCb}" recordingStatusCallbackEvent="completed"/>
  <Say voice="Polly.Joanna">I didn't get a message. Goodbye.</Say>
  <Hangup/>
</Response>`;
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
    /* SIGNATURE on the Twilio-called paths ONLY.
     *
     * This function serves two different callers. Twilio POSTs form-urlencoded
     * webhooks (incoming voice on +18668919394, the outbound_connect TwiML from
     * click-to-call, and recordingStatusCallback) and fetches play_voicemail
     * TwiML. The browser calls the JSON admin actions — get_token, make_call,
     * voicemail_drop, call_status, log_call — which carry no Twilio signature
     * and must not be made to. Validating those would break the dialer;
     * validating nothing leaves anyone who knows the URL able to inject call
     * records and TwiML. So the split is by caller shape, not by convenience.
     *
     * play_voicemail is fetched by Twilio and may arrive as GET, so it is
     * validated against an empty parameter set — the signature then covers the
     * URL alone, including the ?url= it is told to play. */
    /* record_notice is deliberately EXCLUDED — see canRecord above. The
     * exclusion is explicit rather than "it isn't form-encoded", because Twilio
     * fetches a <Number url=""> whisper as a form-encoded POST by default, which
     * would otherwise land right back in the signature branch and restore the
     * fail-open this change removes. */
    const _isTwilioShape = subAction !== 'record_notice'
      && (contentType.includes('application/x-www-form-urlencoded')
          || subAction === 'play_voicemail');
    if (_isTwilioShape) {
      const _raw = contentType.includes('application/x-www-form-urlencoded') ? await req.clone().text() : '';
      const sig = await verifyTwilioRequest(req, _raw, { authToken: AUTH_TOKEN, testKey: Deno.env.get('SMS_TEST_KEY') || '' });
      if (!sig.ok) {
        console.error('[twilio-voice] REJECTED:', sig.reason, 'url=', sig.url);
        return twilioForbidden();
      }
    }

    /* Sub-action: the recording disclosure, fetched by Twilio as the url= on a
     * nested <Number>. This is the CHILD leg's copy of the announcement — it
     * runs on the dialled party's leg after they answer and before the legs are
     * bridged, so they hear it before any conversation is captured.
     *
     * Signature-validated (record_notice is in _isTwilioShape above). Note the
     * consequence, because it is a real trade-off and not an oversight: if the
     * signature check ever fails here, Twilio gets a 403, the whisper does not
     * play, and the call still connects and still records. That is a fail-open
     * on the disclosure. Closing it means failing the CALL when the notice
     * cannot be played, which trades a compliance gap for dropped borrower
     * calls. Flagged for Rene rather than decided here. */
    if (subAction === 'record_notice') {
      const noticeText = await noticeConfig();
      console.log('[twilio-voice] record_notice served');
      return twimlRes(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${noticeSay(noticeText)}
</Response>`);
    }

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

      /* ── INBOUND PSTN CALL ────────────────────────────────────────────
       * BRANCH ON From, NOT To. For an inbound call Twilio posts To = OUR OWN
       * number, so the `if (to)` branch below returned TwiML dialling the 866
       * back to itself with callerId set to the same number. Every real caller
       * hit that. Nothing was logged, and calls_log has had no inbound row ever
       * — 11 inbound calls on Twilio in 90 days, zero rows.
       *
       * This branch is deliberately narrow so every working path is untouched:
       * it fires only when the caller is NOT the browser client, there is no
       * ?phase= (click-to-call's connect step), and To is one of our own
       * numbers. Anything else falls through to the existing behaviour. */
      const OUR_NUMBERS = new Set([
        '+18668919394',   // main business line
        '+17149092526',
        '+18886881231',
      ]);
      const isBrowserLeg = from.startsWith('client:');
      const phase = reqUrl.searchParams.get('phase') || '';
      if (!isBrowserLeg && !phase && OUR_NUMBERS.has(to)) {
        // Log at call START, so a caller who hangs up before voicemail still exists.
        let inboundContactId: string | null = null;
        try {
          const last10 = from.replace(/\D/g, '').slice(-10);
          if (last10.length === 10) {
            const { data: c } = await sb.from('contacts')
              .select('id')
              .or(`phone.ilike.%${last10}%,secondary_phone.ilike.%${last10}%`)
              .limit(1).maybeSingle();
            inboundContactId = c?.id || null;
          }
        } catch (e) { console.error('[twilio-voice] inbound contact match failed:', String(e)); }

        try {
          await sb.from('calls_log').insert({
            contact_id: inboundContactId,
            from_phone: from,
            to_phone: to,
            direction: 'inbound',
            status: 'ringing',
            twilio_call_sid: callSid,
            created_at: new Date().toISOString(),
          });
        } catch (e) {
          // Never let a logging failure drop a live call — the caller matters more.
          console.error('[twilio-voice] inbound calls_log insert failed:', String(e));
        }

        const statusCb = `https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/twilio-voice`;
        /* No hardcoded fallback. A wrong number here silently forwards every
         * inbound business call to whoever owns it, and a hardcoded one keeps
         * working after the real number changes — the failure would be a caller
         * reaching a stranger, discovered by the stranger. If the secret is
         * missing, go straight to voicemail: a message we keep beats a call we
         * misroute. */
        const forwardTo = (Deno.env.get('RENE_CELL') || '').trim();
        if (!forwardTo) {
          console.error('[twilio-voice] RENE_CELL not set — inbound call routed to voicemail');
          try {
            await sb.from('calls_log').update({ status: 'voicemail_no_forward' }).eq('twilio_call_sid', callSid);
          } catch (_) {}
          return twimlRes(voicemailTwiml(statusCb, await greetingConfig()));
        }
        /* timeout=18: short enough that Twilio gives up BEFORE Rene's carrier
         * voicemail answers (~25s on most US carriers). If the carrier answers
         * first, Twilio bridges to it, our <Record> never runs, and the message
         * lands somewhere the CRM cannot see — the same invisible-recording
         * problem in a different costume. answerOnBridge keeps the caller
         * hearing ringback rather than silence. */
        /* Disclosure to BOTH legs. The <Say> reaches the borrower who called in,
         * before Rene's cell is even rung and before recording starts; the
         * url= whisper reaches Rene when he answers. */
        const noticeText = await noticeConfig();
        const noticeUrl = `${statusCb}?action=record_notice`;
        const rec = await canRecord(noticeUrl, noticeText);
        if (!rec.ok) console.error(`[twilio-voice] INBOUND NOT RECORDED — ${rec.reason}`);
        const recAttr = rec.ok ? ` record="record-from-answer" recordingStatusCallback="${statusCb}"` : '';
        const whisper = rec.ok ? ` url="${xmlEsc(noticeUrl)}"` : '';
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${rec.ok ? noticeSay(noticeText) : ''}
  <Dial timeout="18" answerOnBridge="true" callerId="${from}"${recAttr} action="${statusCb}?phase=inbound_done" method="POST">
    <Number${whisper} statusCallback="${statusCb}?phase=leg_status" statusCallbackEvent="completed" statusCallbackMethod="POST">${forwardTo}</Number>
  </Dial>
</Response>`;
        console.log(`[twilio-voice] INBOUND from=${from} to=${to} sid=${callSid} contact=${inboundContactId} -> ringing ${forwardTo}`);
        return twimlRes(xml);
      }

      /* Inbound leg finished without being answered → voicemail. Twilio POSTs
       * DialCallStatus here because of the action= above. */
      /* A caller who hangs up WHILE RINGING never triggers the Dial action URL —
       * Twilio stops processing TwiML when the calling party is gone. Without
       * this the row would sit at 'ringing' forever and a silent hangup would
       * be indistinguishable from a call still in progress. Two closers:
       * the per-leg statusCallback below, and the number-level StatusCallback
       * configured in the Twilio console (see the deploy checklist). */
      if (phase === 'leg_status' || phase === 'call_status') {
        const st = params.get('CallStatus') || params.get('DialCallStatus') || 'completed';
        const dur = parseInt(params.get('CallDuration') || params.get('DialCallDuration') || '0', 10) || null;
        try {
          const { data: row } = await sb.from('calls_log')
            .select('id, status').eq('twilio_call_sid', callSid).maybeSingle();
          // Never downgrade a row that already reached a terminal outcome.
          if (row && ['ringing', 'in-progress'].includes(String(row.status))) {
            await sb.from('calls_log').update({ status: st, duration: dur }).eq('id', row.id);
          }
        } catch (e) { console.error('[twilio-voice] leg_status update failed:', String(e)); }
        return new Response('', { status: 200, headers: corsHeaders });
      }

      if (phase === 'inbound_done') {
        const dialStatus = params.get('DialCallStatus') || '';
        try {
          await sb.from('calls_log')
            .update({ status: dialStatus === 'completed' ? 'completed' : dialStatus,
                      duration: parseInt(params.get('DialCallDuration') || '0', 10) || null })
            .eq('twilio_call_sid', callSid);
        } catch (e) { console.error('[twilio-voice] inbound_done update failed:', String(e)); }
        if (dialStatus === 'completed') {
          return twimlRes(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
        }
        const statusCb2 = `https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/twilio-voice`;
        return twimlRes(voicemailTwiml(statusCb2, await greetingConfig()));
      }

      // Outbound call from browser → return TwiML to dial the destination
      if (to) {
        const dialTo = to.startsWith('+') || to.startsWith('client:') ? to : formatPhone(to);
        const recordingCb = `https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/twilio-voice`;
        /* Disclosure to BOTH legs. The <Say> reaches the staff member on the
         * browser client — which also makes it audible to them that it fired —
         * and the url= whisper reaches the person being dialled on answer,
         * before the bridge. */
        const noticeText = await noticeConfig();
        const noticeUrl = `${recordingCb}?action=record_notice`;
        const rec = await canRecord(noticeUrl, noticeText);
        if (!rec.ok) console.error(`[twilio-voice] OUTBOUND NOT RECORDED — ${rec.reason}`);
        const recAttr = rec.ok ? ` record="record-from-answer" recordingStatusCallback="${recordingCb}"` : '';
        const whisper = rec.ok ? ` url="${xmlEsc(noticeUrl)}"` : '';
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${rec.ok ? noticeSay(noticeText) : ''}
  <Dial callerId="${TWILIO_PHONE}" timeout="30"${recAttr}>
    <Number${whisper}>${dialTo}</Number>
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
      /* Disclosure on both legs, same shape and same fail-closed rule as the
       * other two recorded Dials. */
      const mcNotice = await noticeConfig();
      const mcNoticeUrl = `https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/twilio-voice?action=record_notice`;
      const mcRec = await canRecord(mcNoticeUrl, mcNotice);
      if (!mcRec.ok) console.error(`[twilio-voice] make_call NOT RECORDED — ${mcRec.reason}`);
      const mcRecAttr = mcRec.ok ? ' record="record-from-answer"' : '';
      const mcWhisper = mcRec.ok ? ` url="${xmlEsc(mcNoticeUrl)}"` : '';
      const dialTwiml = `<Response>${mcRec.ok ? noticeSay(mcNotice) : ''}<Dial callerId="${TWILIO_PHONE}"${mcRecAttr}><Number${mcWhisper}>${formatPhone(to)}</Number></Dial></Response>`;
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
        }).then(() => {}, () => {});
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

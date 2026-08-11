import { verifyTwilioRequest, twilioForbidden } from "../_shared/twilio-signature.ts";
import { requireStaff } from "../_shared/require-staff.ts";
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
 * Every <Dial> in this file is recorded (the two live paths dual-channel since
 * 2026-08-08, make_call still mono — same start trigger either way) and until now
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
/* ── WHO IS ANNOUNCED, AND WHY IT IS A SERVER-SIDE MAP ──────────────────────
 *
 * Keyed on the VERIFIED uid — the same identity get_token derives from the
 * session (`client:u_<uid>`), not on anything anyone types. There is
 * deliberately no per-user "announcement name" setting:
 *
 *   • processing@ is a SHARED, ROTATING login. A name entered there is not a
 *     claim about who is on the call, it is a claim about who set the field
 *     last, and it goes stale silently.
 *   • This wording is read aloud on an all-party-consent recording. A WRONG
 *     name on that recording is worse than no name — the company name is always
 *     true, an incorrect personal name is a false statement in the evidence.
 *
 * So: known uid → their wording. Everyone else, including every VA session and
 * anything with no identity at all → the company name, which is the current
 * behaviour and cannot be wrong. Adding a person is a deploy, on purpose. */
const NOTICE_NAME_BY_UID: Record<string, string> = {
  // Rene Duarte — uid with dashes stripped, matching the client:u_<uid> form.
  '59e012b08a204bd19b08b5e10f76eea2': 'Rene Duarte with Rates and Realty',
};

/** `client:u_59e0...` → `59e0...`. Anything else → '' (unknown identity). */
function uidFromClientIdentity(from: string): string {
  const m = String(from || '').match(/^client:u_([0-9a-f]{32})$/i);
  return m ? m[1].toLowerCase() : '';
}

/* ── GETTING THE RIGHT WORDING TO THE CHILD LEG WITHOUT SAYING WHO ──────────
 *
 * The whisper URL is fetched by Twilio and is deliberately UNAUTHENTICATED (see
 * canRecord: requiring a signature there is what created the fail-open). So it
 * must not carry a uid or a name — anyone probing that endpoint could then
 * enumerate staff identities out of it.
 *
 * Instead it carries an OPAQUE TAG: the first 12 hex of
 * HMAC-SHA256(TWILIO_AUTH_TOKEN, 'notice-variant:' + uid). The endpoint
 * recomputes the tag for each uid in the map above and compares. Properties:
 *
 *   • no uid and no name ever appears in the query string
 *   • the tag cannot be reversed to a uid, and cannot be produced without the
 *     account auth token, so it cannot be forged or enumerated
 *   • a probe with a missing or wrong tag gets the default company wording —
 *     the endpoint reveals nothing at all about who calls, or even that a
 *     personalised variant exists
 *   • stateless: nothing to store, expire or clean up
 *
 * What it does NOT defend against is someone who can already read the TwiML in
 * flight, i.e. Twilio and us. That is the same trust boundary the call itself
 * has, so there is nothing further to win there. */
async function noticeVariantTag(uid: string): Promise<string> {
  if (!uid) return '';
  /* Read from the environment directly: the AUTH_TOKEN const lives inside
   * Deno.serve and is not visible at module scope. check-functions caught this
   * as TS2304 — it would have been a ReferenceError thrown while building the
   * TwiML, i.e. a dead outbound dialer, on the first real call. */
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(Deno.env.get('TWILIO_AUTH_TOKEN') ?? ''),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('notice-variant:' + uid));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

/** Reverse the tag by trying every known uid. Constant, tiny map. */
async function nameForVariantTag(tag: string): Promise<string> {
  if (!tag) return '';
  for (const uid of Object.keys(NOTICE_NAME_BY_UID)) {
    if (await noticeVariantTag(uid) === tag) return NOTICE_NAME_BY_UID[uid];
  }
  return '';
}

async function noticeConfig(nameOverride?: string): Promise<string> {
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
  /* The per-caller name replaces the {name} slot only — the SENTENCE stays in
   * app_config, so compliance wording is still a row edit rather than a deploy.
   * An empty override falls through to the company name, which is why an
   * unknown caller cannot end up with a blank or wrong announcement. */
  if (nameOverride) name = nameOverride;
  return text.replace(/\{name\}/g, name).trim();
}

/* ── CALLING HOURS (TCPA) ────────────────────────────────────────────────────
 *
 * 8am–9pm in the CALLED party's local time, not ours. This is a legal limit on
 * outbound calls, and it became urgent the moment a dial pad existed: the VA
 * works UTC+8, which is roughly 5pm–2am Pacific, so their ordinary working
 * evening is the middle of the night for most US borrowers. Unrestricted, the
 * normal use of the tool is the violation.
 *
 * area_code_timezones has held 192 rows across 6 zones since it was created and
 * has never been wired to anything. This is the first consumer.
 *
 * ENFORCED SERVER-SIDE, in the TwiML branch that actually places the call, not
 * only in the browser. A client-side check is a courtesy message; this is the
 * control. The precheck action exists so the UI can refuse BEFORE anything
 * rings, but it is not what makes the rule true.
 *
 * UNKNOWN AREA CODE -> ALLOW, AND RECORD IT. Blocking on ignorance would make
 * the dialer randomly unusable for any code missing from a 192-row table, and
 * an agent who cannot call falls back to their personal phone, which is worse
 * than a call at a slightly wrong hour. Every unknown is written to audit_log
 * so the gap is a worklist rather than a silent default. */
const CALL_WINDOW_START = 8;    // inclusive, local
const CALL_WINDOW_END = 21;     // exclusive, local — 9pm

/* Enforcement switch for the voicemail_drop hours check ONLY. The dial path and
 * make_call have enforced hours for a long time and are NOT behind this — they
 * are proven and must not become switchable by adding a flag around them.
 * Off until both probes pass. Set VOICE_QUIET_HOURS=on to enable. */
const VOICE_QUIET_HOURS = (Deno.env.get('VOICE_QUIET_HOURS') || '').toLowerCase() === 'on';

type HoursVerdict = {
  allowed: boolean;
  areaCode: string | null;
  tz: string | null;
  localTime: string | null;
  known: boolean;
  reason: string;
};

async function callingHours(toPhone: string): Promise<HoursVerdict> {
  const digits = (toPhone || '').replace(/\D/g, '');
  const nat = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  const areaCode = nat.length >= 10 ? nat.slice(0, 3) : null;

  if (!areaCode) {
    return { allowed: true, areaCode: null, tz: null, localTime: null, known: false,
             reason: 'no area code could be read from the number' };
  }

  let tz: string | null = null;
  try {
    const { data } = await sb.from('area_code_timezones').select('tz').eq('area_code', areaCode).maybeSingle();
    tz = (data as any)?.tz || null;
  } catch (e) {
    /* A lookup failure must not become a block — see above. It is recorded as
     * unknown, which is honest: we do not know the zone. */
    console.error('[twilio-voice] area_code_timezones lookup failed:', String(e));
  }

  if (!tz) {
    console.warn(`[twilio-voice] CALLING HOURS: unknown area code ${areaCode} — allowing`);
    try {
      await sb.from('audit_log').insert({
        table_name: 'calling_hours', row_id: areaCode, operation: 'UNKNOWN_AREA_CODE',
        new_data: { area_code: areaCode, to: toPhone, allowed: true },
      });
    } catch (_) { /* the call still proceeds; this is a worklist, not a gate */ }
    return { allowed: true, areaCode, tz: null, localTime: null, known: false,
             reason: `area code ${areaCode} is not in area_code_timezones — allowed, and logged` };
  }

  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(now));
  const localTime = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(now);
  const allowed = hour >= CALL_WINDOW_START && hour < CALL_WINDOW_END;

  return {
    allowed, areaCode, tz, localTime, known: true,
    reason: allowed
      ? `${localTime} for area code ${areaCode} (${tz})`
      : `It is ${localTime} for the person you are calling (area code ${areaCode}, ${tz}). Calls are limited to 8:00 AM–9:00 PM in their local time.`,
  };
}

/* ── WHOSE NUMBER IS THIS ────────────────────────────────────────────────────
 *
 * A call placed from the FAB dial pad logged contact_id null even when the
 * number belonged to someone in the CRM, so it never appeared on that
 * borrower's record — the one place anyone would look for it.
 *
 * Matched on the LAST TEN DIGITS, because the same person is stored as
 * 7144728508, (714) 472-8508 and +17144728508 across this table.
 *
 * MORE THAN ONE MATCH -> DELIBERATELY DOES NOT GUESS. contact_id stays null and
 * the candidates are written into the row's notes, visibly. There is no tiebreak
 * that is safe: "most recently contacted" and "most recently created" both feel
 * reasonable and both silently attach a borrower's call to the wrong person's
 * file, where it becomes evidence about someone it was not about. An unattached
 * call is a small gap a human closes in seconds; a misattached one is wrong in a
 * way nobody goes looking for. 7 numbers in this table are currently shared by
 * 14 contacts, so this is not hypothetical.
 *
 * Zero matches -> null, which is honest: it really is an ad-hoc number. */
/* `matches` is ADDITIVE. contactId/note keep their exact meaning so the dial
 * path is byte-for-byte unchanged — it reads neither field. It exists so the
 * manual-attach UI can reuse THIS matcher rather than growing a second one that
 * drifts from the last-10 rule and the multi-match refusal above.
 *
 * It carries id + names ONLY. No phone, no email, not even partially: this
 * endpoint turns a phone number into a borrower identity, so anything extra in
 * the body is a disclosure the caller did not need to make the choice. The
 * disambiguator for two people with the same name is pipeline_status, never a
 * contact detail. */
type PhoneMatch = { id: string; first_name: string | null; last_name: string | null; pipeline_status: string | null };
async function resolveContactByPhone(
  toPhone: string,
): Promise<{ contactId: string | null; note: string | null; matches: PhoneMatch[] }> {
  const last10 = (toPhone || '').replace(/\D/g, '').slice(-10);
  if (last10.length !== 10) return { contactId: null, note: null, matches: [] };
  try {
    const { data } = await sb.from('contacts')
      .select('id, first_name, last_name, phone, pipeline_status')
      .or(`phone.ilike.%${last10}%,secondary_phone.ilike.%${last10}%`)
      /* READ FILTER: current roster only — a merged-away duplicate is not a
         person you can call, and attaching to one is worse than not attaching.
         This path was written after the merge filter swept the rosters and
         searches, and it missed it, so it became the FIRST ghost WRITE:
         calls_log a9eec719 (2026-08-11 17:21) landed on 93724c8a, the loser of
         the 08-08 Rene Duarte merge, and showed on no lead page.

         It caused BOTH symptoms, which is the part worth keeping. Survivor
         ce753903 and ghost 93724c8a BOTH carry 7144728508, so without this the
         resolver saw two exact matches and correctly refused to guess — the
         multi-match refusal below was never broken. The refusal then handed the
         choice to the attach panel, which offered two rows both reading "Rene
         Duarte" (pipeline_status is the only disambiguator, by design) and the
         ghost was picked. With the filter there is exactly ONE match and the
         call auto-attaches to the survivor, so the human is never shown a
         corpse to choose between.

         Belongs in the FILTER column of docs/CONTACT-MERGE-2026-08-08.md: it is
         a search that turns a number into an identity, not a by-id lookup of a
         contact the user already chose. */
      .is('merged_into_contact_id', null)
      .limit(10);
    const rows = (data as any[]) || [];
    /* ilike %digits% is a loose net — it also matches a longer number that
     * merely contains these ten. Narrow to an exact last-10 comparison. */
    const exact = rows.filter((r) => String(r.phone || '').replace(/\D/g, '').slice(-10) === last10);
    // Built by hand, not by spreading r — a spread would carry `phone` straight
    // into the response the moment the select above gains a column.
    const matches: PhoneMatch[] = exact.map((r) => ({
      id: r.id, first_name: r.first_name ?? null, last_name: r.last_name ?? null,
      pipeline_status: r.pipeline_status ?? null,
    }));
    if (exact.length === 1) return { contactId: exact[0].id, note: null, matches };
    if (exact.length > 1) {
      const names = exact
        .map((r) => `${[r.first_name, r.last_name].filter(Boolean).join(' ').trim() || 'unnamed'} (${r.id})`)
        .join('; ');
      console.warn(`[twilio-voice] ${exact.length} contacts share ${last10} — not attaching: ${names}`);
      return { contactId: null, note: `Not attached: ${exact.length} contacts share this number — ${names}`, matches };
    }
    return { contactId: null, note: null, matches };
  } catch (e) {
    console.error('[twilio-voice] contact resolve failed:', String(e));
    return { contactId: null, note: null, matches: [] };
  }
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
/* ── THE TOGGLE GATES canRecord ITSELF, NOT THE record= ATTRIBUTE ────────────
 *
 * Both call paths derive TWO things from one boolean:
 *     const recAttr = rec.ok ? ' record="record-from-answer-dual" …' : '';
 *     const whisper = rec.ok ? ' url="…"' : '';
 * …plus the parent-leg <Say>. So refusing here removes the disclosure and the
 * capture TOGETHER, by construction rather than by a second check somebody
 * could later forget to keep in step.
 *
 * That is the whole reason the toggle is applied at this function and not at
 * the TwiML. "Recording is off" and "the announcement does not play" must be
 * the same fact — a disclosure for a recording that is not happening is a false
 * statement, spoken on a call, and it would be the one sentence on the
 * transcript that nobody could explain afterwards.
 *
 * `wanted` false and canRecord failing are NOT the same outcome and are
 * reported differently on the row — see recording_disposition. */
async function canRecord(noticeUrl: string, text: string, expectName?: string, wanted = true): Promise<{ ok: boolean; reason: string }> {
  if (!wanted) return { ok: false, reason: 'recording turned OFF by the caller — no disclosure played, by design' };
  if (!text) return { ok: false, reason: 'notice text is empty' };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(noticeUrl, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, reason: `notice endpoint HTTP ${res.status}` };
    const xml = await res.text();
    if (!xml.includes('<Say')) return { ok: false, reason: 'notice endpoint returned no <Say>' };
    /* The preflight already has the whisper body in hand, so checking WHICH
       wording came back is free. Without this, a broken variant tag is
       invisible: the borrower hears the company name, the call records
       normally, and nothing anywhere reports that the personalisation stopped
       working.
       LOGGED, NOT FAIL-CLOSED. The fail-closed rule exists to stop us capturing
       audio nobody was told about; a correct disclosure carrying the wrong NAME
       is still a valid disclosure, and refusing to record over it would trade a
       real protection for a cosmetic one. */
    if (expectName && !xml.includes(expectName)) {
      console.error(`[twilio-voice] NOTICE VARIANT MISMATCH — expected "${expectName}" in the whisper, got the default. Recording proceeds with the company wording.`);
    }
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
      /* `v` is an opaque HMAC tag, never a uid or a name. Absent, wrong or
         forged -> nameForVariantTag returns '' -> the company wording. A prober
         cannot tell from any response that a personalised variant exists. */
      const variantName = await nameForVariantTag((reqUrl.searchParams.get('v') || '').trim());
      const noticeText = await noticeConfig(variantName);
      console.log(`[twilio-voice] record_notice served variant=${variantName ? 'named' : 'default'}`);
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
          /* AWAITED, and .select()ing the id back, because the transcription
           * kick-off below needs to know WHICH row this recording landed on.
           * The previous fire-and-forget .then() could not tell anyone. */
          const { data: updated, error: updErr } = await sb.from('calls_log')
            .update({ recording_url: recordingUrl })
            .eq('twilio_call_sid', callSid)
            .select('id');
          if (updErr) console.error('[twilio-voice] recording update err:', updErr.message);

          /* ── TRANSCRIPTION STARTS HERE ────────────────────────────────────
           * This is the first moment the recording is knowable, which is why
           * the kick-off lives here rather than on a timer.
           *
           * Service key in BOTH headers: esign→email-service proved that an
           * Authorization-only check 401s an internal caller that sends only
           * `apikey`, so senders send both and require-staff accepts either.
           *
           * FAILURE HERE IS NOT SILENT AND NOT FATAL. Twilio gets its 200
           * regardless — refusing to acknowledge a recording callback because
           * our own downstream hop failed would make Twilio retry the whole
           * thing and change nothing. The safety net is call-intelligence's
           * `sweep`, which picks up any recorded call that never got a
           * transcript_status at all, so a broken hop here delays transcription
           * to the next sweep instead of losing it. That is deliberate: every
           * outage in this project has been a callback that stopped arriving
           * with nothing reconciling behind it. */
          for (const r of (updated || []) as Array<{ id: string }>) {
            try {
              const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/call-intelligence`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
                  'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''}`,
                },
                body: JSON.stringify({ action: 'start', call_log_id: r.id }),
              });
              /* Look at what came back, not just that the call returned. */
              if (!res.ok) {
                console.error(`[twilio-voice] transcription kick-off for ${r.id} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
              } else {
                console.log(`[twilio-voice] transcription requested for calls_log ${r.id}`);
              }
            } catch (e) {
              console.error(`[twilio-voice] transcription kick-off threw for ${r.id}:`, String(e));
            }
          }
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
        /* No toggle on the inbound path, deliberately: the borrower rings in
           and there is nobody at a keyboard to have chosen. So inbound always
           WANTS recording, and its disposition is only ever 'recorded' or
           'unavailable' — never 'off', which would imply a decision no one made.
           The row was inserted above, before this check could resolve, so it is
           stamped here rather than guessed later. */
        const rec = await canRecord(noticeUrl, noticeText);
        if (!rec.ok) console.error(`[twilio-voice] INBOUND NOT RECORDED — ${rec.reason}`);
        if (callSid) {
          try {
            await sb.from('calls_log')
              .update({ recording_disposition: rec.ok ? 'recorded' : 'unavailable' })
              .eq('twilio_call_sid', callSid);
          } catch (e) { console.error('[twilio-voice] inbound disposition stamp failed:', String(e)); }
        }
        /* DUAL. Same start trigger as record-from-answer — Twilio documents both
         * as starting "as soon as the call is answered" — so the disclosure
         * ordering is untouched. Only the channel count changes: parent leg on
         * channel 1, child on channel 2.
         *
         * NOTE FOR WHOEVER READS THE TRANSCRIPT: on THIS path the parent leg is
         * the BORROWER who rang in, so channel 1 is the borrower, which is the
         * opposite of the outbound path and the opposite of what Conversational
         * Intelligence assumes by default. call-intelligence sends an explicit
         * participants mapping keyed off calls_log.direction to correct it. */
        const recAttr = rec.ok ? ` record="record-from-answer-dual" recordingStatusCallback="${statusCb}"` : '';
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
        /* ── PARENT FIRST. THIS IS THE SID MISMATCH. ────────────────────────
         * leg_status is reached from <Number statusCallback>, which is a CHILD
         * leg callback: its CallSid is the SID of the leg dialled out, while
         * calls_log holds the PARENT's. `.eq('twilio_call_sid', callSid)`
         * therefore matched NOTHING, and the backstop this handler exists to
         * be — the one for a caller who hangs up while it is still ringing,
         * which the Dial action never sees — had never once fired.
         *
         * Proven on row 2f9e67a8 rather than argued: it carries a RECORDING
         * and was still 'ringing' with a null duration. Both callbacks hang off
         * the same <Dial>, so this was never delivery. The recording callback
         * is Dial-level and fires on the parent — matched, recording_url
         * written. The status callback is <Number>-level and fires on the
         * child — same lookup, no row. One row, two callbacks, one matched.
         *
         * ParentCallSid is in that payload and was simply not read. Tried
         * first, CallSid second, so the parent-level phases (call_status, and
         * the inbound Dial action) are unchanged — they send no ParentCallSid
         * and fall straight through to the value they always used. */
        const parentSid = params.get('ParentCallSid') || '';
        const sidsToTry = parentSid && parentSid !== callSid ? [parentSid, callSid] : [callSid];
        try {
          let row: any = null;
          for (const sid of sidsToTry) {
            if (!sid) continue;
            const { data } = await sb.from('calls_log')
              .select('id, status').eq('twilio_call_sid', sid).maybeSingle();
            if (data) { row = data; break; }
          }
          if (!row) {
            console.warn(`[twilio-voice] ${phase}: no calls_log row for sid(s) ${sidsToTry.join(',')}`);
          }
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

        /* CALLING HOURS — enforced HERE because this is where the call is
         * actually placed. The browser gets a precheck for a decent message,
         * but this is the control: it covers the lead-detail dialer, the FAB
         * dial pad and anything added later, and it cannot be skipped by a
         * caller that simply does not ask. client: destinations are internal
         * legs, not borrowers, and are exempt. */
        if (!dialTo.startsWith('client:')) {
          const hours = await callingHours(dialTo);
          if (!hours.allowed) {
            console.error(`[twilio-voice] CALLING HOURS BLOCKED ${dialTo}: ${hours.reason}`);
            try {
              await sb.from('calls_log').insert({
                to_phone: dialTo, from_phone: TWILIO_PHONE, direction: 'outbound',
                status: 'blocked_calling_hours', twilio_call_sid: callSid,
                notes: hours.reason, created_at: new Date().toISOString(),
              });
            } catch (_) {}
            return twimlRes(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${xmlEsc(hours.reason)}</Say>
  <Hangup/>
</Response>`);
          }
        }

        /* LOG AT DIAL TIME, WITH THE SERVER'S OWN CallSid.
         *
         * Browser-dialer rows logged twilio_call_sid NULL, every time, so the
         * recording callback — which matches on twilio_call_sid — updated zero
         * rows, raised no error, and orphaned every recording in Twilio.
         *
         * The browser cannot supply the SID: by the time saveAndClose() runs,
         * conn.on('disconnect') has already nulled activeCall, and
         * window._currentCallSid is only ever assigned ''. But THIS request is
         * Twilio's signed webhook for the outbound leg and carries the real
         * parent CallSid, which is also the SID the recordingStatusCallback
         * will report. So the row is created here and the browser never sees a
         * SID at all — it only echoes back the opaque Ref it generated, so
         * log_call can find this row instead of inserting a second one.
         *
         * Mirrors what the inbound branch already does: log at call START, so a
         * call that ends before anyone presses Save still exists as a row. */
        /* Disclosure to BOTH legs. The <Say> reaches the staff member on the
         * browser client — which also makes it audible to them that it fired —
         * and the url= whisper reaches the person being dialled on answer,
         * before the bridge. */
        /* The caller's identity comes from `from`, which Twilio sets to the
           client identity the TOKEN was minted for — get_token derives that
           from the verified session, so it cannot be spoofed by the browser.
           Unknown identity yields '' and the company wording. */
        const callerUid = uidFromClientIdentity(from);
        const callerName = NOTICE_NAME_BY_UID[callerUid] || '';
        const noticeText = await noticeConfig(callerName);
        const variantTag = callerName ? await noticeVariantTag(callerUid) : '';
        const noticeUrl = `${recordingCb}?action=record_notice${variantTag ? `&v=${variantTag}` : ''}`;
        /* Record=off comes from the browser's Device.connect params, the same
           channel as Ref and ContactId. Anything other than an explicit 'off'
           means record: an unparseable or missing value must not silently
           disable the disclosure, because silence is exactly what nobody would
           notice. Default ON. */
        const recWanted = (params.get('Record') || '').trim().toLowerCase() !== 'off';
        const rec = await canRecord(noticeUrl, noticeText, callerName || undefined, recWanted);
        const disposition = rec.ok ? 'recorded' : (recWanted ? 'unavailable' : 'off');
        if (!rec.ok) console.error(`[twilio-voice] OUTBOUND NOT RECORDED (${disposition}) — ${rec.reason}`);
        /* DUAL. Identical start trigger to record-from-answer, so the notice
         * ordering below is unchanged. Here the parent leg is the staff
         * member's browser client, so channel 1 is staff — which does match
         * Conversational Intelligence's default. The mapping is still sent
         * explicitly rather than relied upon. */
        const clientRef = (params.get('Ref') || '').trim() || null;
        /* An ad-hoc pad call to a number we already know should attach to that
         * contact — otherwise the call is invisible on the borrower's own
         * record, which is where anyone would look for it. */
        const matched = await resolveContactByPhone(dialTo);
        if (callSid) {
          try {
            await sb.from('calls_log').insert({
              contact_id: params.get('ContactId') || matched.contactId || null,
              from_phone: TWILIO_PHONE,
              to_phone: dialTo,
              direction: 'outbound',
              status: 'ringing',
              twilio_call_sid: callSid,
              client_ref: clientRef,
              /* Written at DIAL time, from the same boolean that built the TwiML
                 — so the row cannot disagree with what the call actually did.
                 Deriving it later from "is there a recording?" would report a
                 deliberate 'off' and a failed capture identically. */
              recording_disposition: disposition,
              notes: matched.note,          // only set when the number is ambiguous
              created_at: new Date().toISOString(),
            });
          } catch (e) {
            // Never let a logging failure drop a live call.
            console.error('[twilio-voice] outbound calls_log insert failed:', String(e));
          }
        }
        const recAttr = rec.ok ? ` record="record-from-answer-dual" recordingStatusCallback="${recordingCb}"` : '';
        const whisper = rec.ok ? ` url="${xmlEsc(noticeUrl)}"` : '';
        /* RINGBACK — ringTone, not answerOnBridge alone.
         *
         * answerOnBridge was added first and did not fix it; Rene still heard
         * silence, and client_ref proved the new code was running, so it was not
         * caching. The reason is in Twilio's own wording: without ringTone,
         * "Twilio will play ringback or pass ringback from the carrier (if
         * provided)". The parent here is a WebRTC client leg that is already
         * in-progress by the time it reaches the TwiML app — there is no
         * upstream carrier supplying a tone to pass through, so "pass ringback
         * from the carrier" resolves to nothing and the caller gets dead air.
         * ringTone="us" makes Twilio GENERATE the tone instead of forwarding
         * one, which is the documented override for exactly this case.
         *
         * answerOnBridge is KEPT, and is doing a second job: per the <Number
         * url> docs, "if the answerOnBridge attribute is used on <Dial>, the
         * current caller will continue to hear ringing while the TwiML document
         * executes on the other end" — i.e. it is what keeps the ringback
         * playing during the compliance whisper instead of cutting to silence.
         * The two attributes are complementary; neither is sufficient alone.
         *
         * NEITHER TOUCHES THE DISCLOSURE ORDER. The <Say> runs to completion
         * before <Dial> starts, and the whisper still runs on the child leg
         * after it answers and before the bridge. ringTone only decides what
         * the caller hears DURING the dial. If anything the pair tightens the
         * ordering: the parent is not marked answered until the bridge, so
         * record-from-answer begins after the child has heard the notice.
         *
         * The inbound branch is deliberately left alone — its parent is a real
         * PSTN caller whose carrier does supply ringback, and it is not the
         * reported defect. */
        /* ── THE OUTBOUND LEG HAD NO STATUS CALLBACK AT ALL ──────────────────
         *
         * recordingStatusCallback above is about RECORDINGS and says nothing
         * about call status. There was no action= and no per-leg
         * statusCallback=, so `leg_status` and `inbound_done` were unreachable
         * from the browser dialer: the row was INSERTed 'ringing' and no code
         * path could ever update it. Five of the seven rows stuck at 'ringing'
         * over 30 days are this, and they were stuck by ABSENCE — not by the
         * SID mismatch that explains the other two.
         *
         * Both closers, matching the inbound branch:
         *   action=          fires on the PARENT when the Dial finishes. Its
         *                    CallSid is the row's own SID.
         *   <Number status=  fires on the CHILD leg, and carries ParentCallSid;
         *                    it is what closes a call the caller abandons while
         *                    it is still ringing, which the Dial action never
         *                    sees because Twilio stops processing TwiML once
         *                    the calling party is gone.
         *
         * phase=call_status rather than a new name: leg_status already handles
         * exactly this shape and never downgrades a row that reached a terminal
         * state. statusCallbackEvent="completed" only — 'initiated'/'ringing'
         * would post twice per call to write a status the row already has. */
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${rec.ok ? noticeSay(noticeText) : ''}
  <Dial callerId="${TWILIO_PHONE}" timeout="30" answerOnBridge="true" ringTone="us"${recAttr} action="${recordingCb}?phase=call_status" method="POST">
    <Number${whisper} statusCallback="${recordingCb}?phase=leg_status" statusCallbackEvent="completed" statusCallbackMethod="POST">${dialTo}</Number>
  </Dial>
</Response>`;
        console.log('[twilio-voice] dialing', dialTo, 'callerId=', TWILIO_PHONE, 'sid=', callSid, 'ref=', clientRef);
        return twimlRes(xml);
      }

      console.log('[twilio-voice] webhook missing To, body=', bodyText);
      return twimlRes(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>No destination number provided.</Say></Response>`);
    }

    /* ── TYPE 1: JSON request from browser CRM ────────────────────────────────
     *
     * GUARDED FROM HERE DOWN. Everything above this line is Twilio's, validated
     * by the signature check at the top; everything below is the browser's, and
     * until now had no authorization of ANY kind. verify_jwt = false, so the
     * gateway asked for nothing either: an unauthenticated POST reached this
     * dispatch and got the function's own 400.
     *
     * That mattered most for get_token, which minted a one-hour Twilio Voice
     * capability JWT to anyone who asked. Its holder can dial arbitrary numbers
     * from the business line, billed to the account and recorded — see
     * docs/OPEN-FINDINGS-2026-08-07.md §8.
     *
     * ONE CHECK COVERING ALL FIVE ACTIONS, placed before req.json() rather than
     * per-action, so an action added later is guarded by construction instead of
     * by whoever remembers. That is require-staff's own note 2.
     *
     * The webhook branch above is deliberately NOT covered: Twilio sends no JWT,
     * and its control is the request signature. verify_jwt stays as pinned
     * (false) for the same reason — flipping it would 401 every Twilio webhook
     * at the gateway before this function ever ran. */
    const staff = await requireStaff(req, { what: 'The dialer' });
    if (!staff.ok) {
      console.error('[twilio-voice] REJECTED json action:', staff.status, staff.msg);
      return err(staff.msg || 'unauthorized', staff.status || 403);
    }

    // ── TYPE 1 body ──
    const body = await req.json().catch(() => ({} as any));
    const { action, to, contact_id, voicemail_url, duration, status, notes, outcome, twilio_call_sid } = body;
    /* The verified caller. Identity for Twilio, attribution for calls_log.
     * `service` and `internal` callers have no user, so actorUid stays null and
     * those rows remain correctly unattributed. */
    const actorUid = staff.userId || null;
    console.log('[twilio-voice] action=', action, 'role=', staff.role, 'uid=', actorUid);

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
      /* REAL PER-USER IDENTITY, replacing a hardcoded 'rene_duarte' that made
       * every browser leg claim to be Rene no matter who was dialling — which is
       * why a VA call button was blocked on this change.
       *
       * The uid, not the email: stable across an address change, opaque so no
       * PII is read back by anything that renders an identity, and safe for
       * Twilio's identity charset once the dashes are stripped (alphanumeric,
       * underscore, hyphen and period only, ≤121 chars).
       *
       * There is no fallback to a shared identity. staff.userId is null only for
       * the service/internal paths, which do not reach get_token from a browser;
       * if it is somehow null here, minting a token that impersonates someone is
       * worse than refusing. */
      if (!actorUid) return err('No user identity on this session — cannot mint a voice token.', 403);
      const identity = 'u_' + String(actorUid).replace(/-/g, '');

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

    /* Advisory only — the TwiML branch above is what actually enforces. This
     * exists so the dial pad can refuse before anything rings, with the
     * recipient's local time in the message, rather than the caller hearing a
     * hangup and guessing. */
    if (action === 'dial_precheck') {
      if (!to) return err('Missing "to" phone number');
      const hours = await callingHours(formatPhone(to));
      return jsonRes(hours);
    }

    /* MANUAL ATTACH — resolve a number to candidate contacts so the dialer can
     * attach an ad-hoc call a human recognises.
     *
     * Reuses resolveContactByPhone rather than matching here, so the last-10
     * rule and the >1 refusal are the same code the automatic path uses. On more
     * than one match it returns BOTH names and attaches nothing: the automatic
     * path refuses because it cannot ask, and this one refuses to guess because
     * it CAN — the human picks.
     *
     * Guarded by the blanket requireStaff above, which runs before req.json()
     * and therefore covers this action by construction. That matters more here
     * than for the dial actions: this one converts a phone number into a
     * borrower's name, which is the enumeration shape people-admin had.
     *
     * RATE LIMITING — deliberately not added, and the reason is the caller set,
     * not the volume. requireStaff means every request is an authenticated
     * member of auth_user_roles, and there are TWO staff accounts on this
     * project. An enumeration run is not anonymous here; it is attributable to
     * one of two named people and shows up in this function's logs with
     * uid= on every line. A limiter would add state that can wedge in exchange
     * for slowing an attacker who already had to be handed a staff session — at
     * which point they can read contacts directly through PostgREST anyway, with
     * no limiter in front of it. If this endpoint ever loses requireStaff or the
     * staff set grows past a handful, revisit that reasoning rather than
     * inheriting this note. */
    if (action === 'find_by_phone') {
      if (!to) return err('Missing "to" phone number');
      const r = await resolveContactByPhone(String(to));
      /* Named fields only. No spread of the resolver's result — `note` embeds
       * contact ids and names for the SERVER LOG and is not for a browser. */
      return jsonRes({
        matches: r.matches,
        ambiguous: r.matches.length > 1,
      });
    }

    if (action === 'make_call') {
      if (!to) return err('Missing "to" phone number');
      const mcHours = await callingHours(formatPhone(to));
      if (!mcHours.allowed) return jsonRes({ success: false, blocked: 'calling_hours', ...mcHours }, 409);
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
          actor_user_id: actorUid,          // who dialled; null for non-user callers
        });
        return jsonRes({ success: true, callSid: data.sid });
      }
      return err(data.message || 'Call failed');
    }

    if (action === 'voicemail_drop') {
      if (!to || !voicemail_url) return err('Missing "to" or "voicemail_url"');

      /* QUIET HOURS (TCPA) — STAGED, OFF UNTIL PROVEN.
       *
       * voicemail_drop posts straight to Twilio Calls.json and has NEVER had an
       * hours check. make_call and the dial path both do; this one was missed,
       * so the only thing that ever stopped an after-hours drop was a confirm()
       * in power-dialer.html that a user can click past — and lead-detail's
       * voicemail picker has no dialog at all.
       *
       * Reuses this file's own callingHours(), not a second copy: same
       * area_code_timezones lookup, same 8am–9pm local window, same
       * allow-and-log on an unknown area code. A missing timezone row is our
       * gap, not the recipient's.
       *
       * The flag governs whether we ACT on the verdict, never whether we
       * compute it — the check runs and records either way, so what it would
       * have stopped is visible before it stops anything. Same contract as
       * sms-service's SMS_QUIET_HOURS.
       *
       * No bypass parameter. See the note below: no voicemail drop qualifies. */
      const vmHours = await callingHours(formatPhone(to));
      if (!vmHours.allowed) {
        try {
          await sb.from('audit_log').insert({
            table_name: 'quiet_hours', row_id: contact_id || null,
            operation: VOICE_QUIET_HOURS ? 'VOICEMAIL_BLOCKED' : 'VOICEMAIL_WOULD_BLOCK',
            new_data: {
              channel: 'voicemail_drop', enforced: VOICE_QUIET_HOURS, to: formatPhone(to),
              area_code: vmHours.areaCode, tz: vmHours.tz, local_time: vmHours.localTime,
              reason: vmHours.reason,
            },
            changed_by: actorUid,
          });
        } catch (_) { /* never let the logbook stop the decision */ }
        if (VOICE_QUIET_HOURS) {
          console.error(`[twilio-voice] VOICEMAIL BLOCKED ${formatPhone(to)}: ${vmHours.reason}`);
          return jsonRes({ success: false, blocked: 'calling_hours', ...vmHours }, 409);
        }
      }

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
          actor_user_id: actorUid,
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

    /* ── PLAY A RECORDING ─────────────────────────────────────────────────────
     *
     * recording_url is an api.twilio.com URL that needs account credentials, so
     * clicking it in a browser does nothing. This streams the bytes with the
     * credential held server-side.
     *
     * TAKES A calls_log.id, NEVER A URL. Accepting a caller-supplied URL and
     * fetching it would be a clean SSRF with the Twilio account credential
     * attached to the request — anything on the internet, or inside the
     * function's own network, fetched on demand with Basic auth. The row is the
     * only input, the URL comes out of the database, and it is asserted to be a
     * Twilio host before anything is fetched.
     *
     * ADMIN ONLY. Recordings are borrower NPI and the VA login is shared and
     * rotating, so this is narrower than the rest of the function — the dialer
     * is admin/va/agent/loa, this is admin. Widening it is one word; it should
     * be a decision rather than an inheritance. */
    /* ── BACKFILL ROWS THAT NEVER GOT A STATUS CALLBACK ──────────────────────
     *
     * The outbound leg carried no status callback until 2026-08-11, so rows
     * INSERTed 'ringing' could never be closed by anything. Twilio still knows
     * what happened to each — status and duration are on the Call resource, by
     * SID — so the history is recoverable rather than lost.
     *
     * READ-ONLY AT TWILIO. It fetches Calls/<sid>.json and writes only this
     * database. It cannot place, modify or end a call.
     *
     * NARROW BY CONSTRUCTION: only rows already in a non-terminal state, only
     * rows that HAVE a SID, and it never downgrades — the same rule
     * leg_status follows, so running it twice is a no-op and running it after
     * the callbacks start working cannot overwrite a real outcome.
     *
     * Kept rather than deleted after the one-off: the fix stops NEW rows
     * sticking, and if a callback is ever lost again this is how the row gets
     * its truth back. dry_run reports without writing. */
    if (action === 'backfill_call_status') {
      const admin = await requireStaff(req, { roles: ['admin'], what: 'Backfilling call status' });
      if (!admin.ok) return err(admin.msg || 'unauthorized', admin.status || 403);
      if (!ACCOUNT_SID || !AUTH_TOKEN) return err('Twilio not configured', 500);
      const dryRun = body.dry_run === true;
      const limit = Math.min(Number(body.limit) || 50, 200);

      const { data: rows, error: rErr } = await sb.from('calls_log')
        .select('id, twilio_call_sid, status, duration, created_at')
        .in('status', ['ringing', 'in-progress', 'initiated'])
        .not('twilio_call_sid', 'is', null)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (rErr) return err(rErr.message, 500);

      const auth = btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`);
      const out: any[] = [];
      for (const row of (rows || [])) {
        const sid = String((row as any).twilio_call_sid || '');
        if (!sid.startsWith('CA')) { out.push({ id: (row as any).id, skipped: 'not a call sid' }); continue; }
        try {
          const tw = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls/${sid}.json`,
            { headers: { 'Authorization': 'Basic ' + auth } });
          const tj = await tw.json().catch(() => ({}));
          if (!tw.ok) {
            /* A 404 is INFORMATION, not noise: Twilio keeps call records for a
               long time, so a missing one means the SID never belonged to a
               real call — which is itself the answer for that row. */
            out.push({ id: (row as any).id, sid, error: `HTTP ${tw.status}`, detail: tj?.message || null });
            continue;
          }
          const st = String(tj.status || '');
          const dur = parseInt(String(tj.duration || '0'), 10) || null;
          if (!st) { out.push({ id: (row as any).id, sid, error: 'no status in Twilio response' }); continue; }
          const terminal = ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(st);
          if (!terminal) { out.push({ id: (row as any).id, sid, twilio_status: st, skipped: 'still live at Twilio' }); continue; }
          if (!dryRun) {
            await sb.from('calls_log').update({ status: st, duration: dur }).eq('id', (row as any).id);
          }
          out.push({ id: (row as any).id, sid, from: (row as any).status, to: st, duration: dur, written: !dryRun });
        } catch (e) {
          out.push({ id: (row as any).id, sid, error: String((e as Error)?.message || e) });
        }
      }
      return jsonRes({ ok: true, dry_run: dryRun, examined: (rows || []).length, results: out });
    }

    if (action === 'get_recording') {
      const admin = await requireStaff(req, { roles: ['admin'], what: 'Call recordings' });
      if (!admin.ok) {
        console.error('[twilio-voice] get_recording REJECTED:', admin.status, admin.msg);
        return err(admin.msg || 'unauthorized', admin.status || 403);
      }
      const rowId = (body.call_log_id || body.id || '').toString().trim();
      if (!rowId) return err('call_log_id required');

      const { data: row, error: rowErr } = await sb.from('calls_log')
        .select('id, recording_url, contact_id, to_phone').eq('id', rowId).maybeSingle();
      if (rowErr) return err(rowErr.message, 500);
      if (!row) return err('No such call', 404);

      const url = String((row as any).recording_url || '');
      if (!url) return err('This call has no recording.', 404);
      if (!url.startsWith('https://api.twilio.com/')) {
        console.error('[twilio-voice] get_recording refused a non-Twilio URL on row', rowId, url.slice(0, 80));
        return err('Refusing to fetch a recording URL that is not on api.twilio.com.', 400);
      }

      if (!ACCOUNT_SID || !AUTH_TOKEN) return err('Twilio not configured', 500);
      /* Twilio serves the media when the .mp3 extension is present; the stored
       * URL is the resource, without one. */
      const mediaUrl = url.endsWith('.mp3') ? url : url + '.mp3';
      const tw = await fetch(mediaUrl, {
        headers: { 'Authorization': 'Basic ' + btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`) },
      });
      if (!tw.ok) {
        const t = await tw.text().catch(() => '');
        console.error('[twilio-voice] recording fetch failed', tw.status, t.slice(0, 200));
        return err(`Twilio returned ${tw.status} for this recording.`, tw.status === 404 ? 404 : 502);
      }

      console.log(`[twilio-voice] recording served row=${rowId} to=${admin.userId}`);
      return new Response(tw.body, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'audio/mpeg',
          /* Borrower audio must not be written to a shared or disk cache. */
          'Cache-Control': 'private, no-store',
        },
      });
    }

    if (action === 'log_call') {
      /* UPDATE the row the outbound TwiML webhook already created, matched on
       * the browser's correlation token. That row is the one carrying the real
       * twilio_call_sid, so overwriting it with a second INSERT would recreate
       * the orphaning this change exists to fix.
       *
       * Falls back to INSERT when nothing matches — no ref sent (an older cached
       * page), or the dial webhook never ran. Losing the SID is bad; losing the
       * call notes Rene just typed is worse.
       *
       * to_phone and twilio_call_sid are deliberately NOT in the update: the
       * webhook already stored the E.164 number it actually dialled and the SID
       * it was actually given. The browser's copies are the unformatted contact
       * field and an empty string. */
      const clientRef = (body.client_ref || '').toString().trim();
      let updated = false;
      if (clientRef) {
        const { data: rows, error: upErr } = await sb.from('calls_log')
          .update({
            duration: duration || 0,
            status: status || 'completed',
            notes: notes || null,
            outcome: outcome || null,
            contact_id: contact_id || null,
            actor_user_id: actorUid,        // the dial-time row is written by the
                                            // webhook, which has no user — this is
                                            // where the human gets attached
          })
          .eq('client_ref', clientRef)
          .select('id');
        if (upErr) console.error('[twilio-voice] log_call update failed:', upErr.message);
        updated = !!(rows && rows.length);
        if (!updated) console.warn('[twilio-voice] log_call ref matched no row, inserting:', clientRef);
      }
      if (!updated) {
        const { error } = await sb.from('calls_log').insert({
          contact_id: contact_id || null,
          to_phone: to || null,
          direction: 'outbound',
          duration: duration || 0,
          status: status || 'completed',
          notes: notes || null,
          outcome: outcome || null,
          twilio_call_sid: twilio_call_sid || null,
          client_ref: clientRef || null,
          actor_user_id: actorUid,
        });
        if (error) return err(error.message, 500);
      }

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

// video-chat — AI assistant on the public /v/<slug> landing page.
//
// UNAUTHENTICATED AND SPENDS MONEY PER MESSAGE. Everything below that looks
// defensive is load-bearing:
//   • Rate limited on BOTH the viewer IP and the video token, per hour and per
//     session. An open Anthropic endpoint with no cap is a billing incident
//     waiting to happen.
//   • The system prompt forbids quoting a rate, APR, payment, or approval odds.
//     This is a licensed mortgage context: an offhand "you'd probably get about
//     6.5%" from a chatbot is a compliance problem, not a UX quirk.
//   • Replies are plain text. The page renders them with textContent — there is
//     no HTML parse of model output at all.
//
// Called only by the Worker (same-origin /v/<slug>/chat). verify_jwt false.
//
// ── WHY THE BOT WAS DEAD ─────────────────────────────────────────────────────
// It asked for model `claude-sonnet-4-20250514`, which this account cannot see:
//   404 {"type":"error","error":{"type":"not_found_error",
//        "message":"model: claude-sonnet-4-20250514"}}
// The old code read `j.content[0].text` without ever checking r.ok or j.error, so
// a 404 became an empty string, the empty string became the friendly fallback,
// and nothing anywhere recorded that a paid endpoint had failed. Every visitor
// since launch got "I'm having trouble answering right now".
//
// Two changes, both load-bearing:
//   1. Model is claude-sonnet-4-6 — the id compose-ai already proves against this
//      account. Request shape stays model + max_tokens + system + messages
//      (+ tools), with no temperature/top_p/thinking, matching compose-ai v3.
//   2. Upstream failures are LOUD: the verbatim status and body go to the
//      function log with the slug and session id, and Rene gets a notification
//      through the existing app_notify_mentions path (throttled to one per hour
//      per video, so a sustained outage does not become a notification flood).

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info, x-viewer-ip, x-viewer-ua',
};
const J = { ...cors, 'Content-Type': 'application/json' };

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const sb = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

// Proven against this account by compose-ai. Do not "modernise" this to a dated
// id without calling /v1/messages with it first — that is exactly how this broke.
const MODEL = 'claude-sonnet-4-6';

// Caps. Deliberately low: this is a 1:1 follow-up chat, not a support desk.
const MAX_PER_IP_HOUR = 40;
const MAX_PER_SLUG_HOUR = 60;
const MAX_PER_SESSION = 25;
const MAX_CHARS = 1500;

/* The exact words the visitor agrees to. Stored verbatim on the contact: under
 * TCPA the provable artifact is the language shown, not a boolean someone set. */
const CONSENT_TEXT =
  'I agree that Rene Duarte / Rates & Realty may contact me by phone call and text ' +
  'message at the number I provided, including with an autodialer. Message and data ' +
  'rates may apply. Consent is not a condition of any purchase, and I can opt out at ' +
  'any time by replying STOP.';

const SYSTEM = `You are the assistant on a personal video page for Rene Duarte, a mortgage loan officer (NMLS #1795044) who operates under E Mortgage Capital, Inc. (Broker NMLS #1416824).

You help with GENERAL questions only:
- how the mortgage process works, and what happens at each stage
- what documents are typically needed and why
- what loan program types exist in general terms (conventional, FHA, VA, USDA, jumbo, non-QM, DSCR) and who they generally suit
- what the borrower can expect next, and how to reach Rene

HARD RULES — these are compliance limits, not style preferences:
- NEVER state, quote, estimate, or range a rate, APR, monthly payment, closing cost figure, or fee. Not even "around", "typically", "as low as", or a historical number.
- NEVER assess whether someone qualifies, is approved, is pre-approved, or their odds of approval.
- NEVER promise terms, timelines, or outcomes.
- Do not ask for a Social Security number, date of birth, or full account numbers. If someone volunteers one, do not repeat it back.
- If asked anything touching numbers, eligibility, or approval, say plainly that Rene has to look at the specifics and invite them to call 714-472-8508.

HOW TO HANDLE CONTACT DETAILS — follow this exactly:
1. ANSWER THE QUESTION FIRST, always. Never withhold or defer an answer to get contact information. Never say you need their details before you can help.
2. AFTER a genuinely helpful answer, you may ask for ONE thing. Ask for their FIRST NAME first — it is the smallest thing to give.
3. Once you have a name, you may ask for the best way to reach them. Accept EITHER a phone number OR an email, whichever they offer. Never ask for both, and never push for the other one.
4. If they decline, deflect, or ignore the ask twice, STOP ASKING for the rest of the conversation. Keep answering their questions warmly. Do not bring it up again.
5. Ask at most once per reply, and never in the same breath as a compliance redirect.

PHONE NUMBERS REQUIRE CONSENT. Before you record a phone number you must ask, in plain language, whether they agree to be contacted by call or text at that number, and get a clear yes. If they give you a number without agreeing yet, ask for that agreement in your next reply. If they say no to contact, do not record the phone — offer email instead. An email address needs no such agreement.

Use the capture_contact tool the moment you learn a name, phone, or email — including partial information (a name alone is worth recording). Set consent_given true ONLY when they have clearly agreed to calls or texts in this conversation. Never guess it. Call the tool at most once per reply.

YOU MUST ALSO CALL capture_contact WITH declined=true, with no other fields, whenever the visitor refuses to share details, deflects the question, says "no thanks", "later", "I'd rather not", or asks you to stop. This is not optional — it is how the system records that they said no, and without it they will be asked again.

STYLE: warm, brief, plain English. 2-4 sentences. No markdown, no bullet lists, no headings — your reply is rendered as plain text. When you record someone's details, thank them and tell them Rene will follow up personally.`;

const TOOLS = [{
  name: 'capture_contact',
  description:
    'Record contact details the visitor has volunteered in this conversation. Call it as soon as you learn any field, including just a name. Never invent, infer, or complete a value the visitor did not actually say.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: "The visitor's name exactly as they gave it. Omit if not stated." },
      phone: { type: 'string', description: 'Phone number exactly as stated. Omit if not stated.' },
      email: { type: 'string', description: 'Email address exactly as stated. Omit if not stated.' },
      consent_given: {
        type: 'boolean',
        description: 'True ONLY if the visitor explicitly agreed in this conversation to be contacted by phone call or text message. False or omitted otherwise. Never assume agreement from the mere fact they gave a number.',
      },
      declined: {
        type: 'boolean',
        description: 'True if the visitor declined to share contact details, changed the subject away from the ask, or asked not to be contacted.',
      },
    },
    required: [],
  },
}];

function ok(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: J }); }

/* Fixed-window counter. A sliding window would be nicer, but this is one row and
 * one round trip per message and the cap is generous enough that the boundary
 * reset does not matter. */
async function bump(key: string, max: number): Promise<boolean> {
  const now = new Date();
  const { data } = await sb.from('video_chat_limits').select('*').eq('bucket_key', key).maybeSingle();
  if (!data) {
    await sb.from('video_chat_limits').insert({ bucket_key: key, hits: 1, window_start: now.toISOString() });
    return true;
  }
  const started = new Date(data.window_start).getTime();
  if (now.getTime() - started > 3600_000) {
    await sb.from('video_chat_limits').update({ hits: 1, window_start: now.toISOString(), updated_at: now.toISOString() }).eq('bucket_key', key);
    return true;
  }
  if (data.hits >= max) return false;
  await sb.from('video_chat_limits').update({ hits: data.hits + 1, updated_at: now.toISOString() }).eq('bucket_key', key);
  return true;
}

/* ── VALIDATION ───────────────────────────────────────────────────────────────
 * The model reports what it heard; this decides what is allowed into the lead
 * list. A chat transcript is the noisiest possible input — typos, jokes, "555-
 * 1234", "test@test.com" — and a bad row costs more than a missed one, because
 * Rene calls it. */

// US/NANP → E.164. Rejects the structurally impossible before the merely odd.
function normalizePhone(raw: unknown): string | null {
  const s = String(raw == null ? '' : raw);
  const d = s.replace(/\D/g, '');
  let ten = '';
  if (d.length === 10) ten = d;
  else if (d.length === 11 && d[0] === '1') ten = d.slice(1);
  else return null;                                  // no country we serve is other lengths
  if (!/^[2-9]/.test(ten)) return null;              // NANP area code cannot start 0 or 1
  if (!/^[2-9]/.test(ten.slice(3, 4))) return null;  // nor can the exchange
  if (/^(\d)\1{9}$/.test(ten)) return null;          // 0000000000, 1111111111 …
  if (ten.slice(0, 3) === '555' || ten.slice(3, 6) === '555') return null; // directory-assistance / fiction
  if (ten === '1234567890' || ten === '9876543210') return null;
  return '+1' + ten;
}

function normalizeEmail(raw: unknown): string | null {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s || s.length > 254) return null;
  // Deliberately strict-ish: one @, no spaces, a real-looking TLD.
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/.test(s)) return null;
  const domain = s.split('@')[1];
  // Reserved / obviously-fake domains. These are typed by testers, not borrowers.
  if (/(^|\.)(example|test|invalid|localhost|local)$/.test(domain)) return null;
  if (['example.com', 'example.org', 'test.com', 'email.com', 'domain.com', 'asdf.com'].includes(domain)) return null;
  return s;
}

function normalizeName(raw: unknown): string | null {
  let s = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  s = s.slice(0, 80);
  if (s.length < 2) return null;
  if (/\d/.test(s)) return null;                       // names here should not carry digits
  if (!/^[\p{L}][\p{L}'’.\- ]*$/u.test(s)) return null; // letters, apostrophes, hyphens
  if (/^(test|testing|asdf|qwerty|none|na|n\/a|anon|anonymous|nobody|xxx+)$/i.test(s)) return null;
  return s;
}

/* Loud failure. The visitor keeps a friendly sentence; everyone who can DO
 * something about it gets the real thing. Throttled per video per hour through
 * the rate-limit table that already exists, so an outage cannot flood the bell. */
/* Relay a milestone to video-track. Everything the visitor-facing guards need
 * travels as headers, because video-track deliberately never reads
 * `authorization` for identity — the Worker overwrites it with the anon key.
 *
 * The service role here marks the call INTERNAL, which is what lets a contact_id
 * be trusted; a visitor's own relayed request carries the anon key and can never
 * assert one. */
async function trackEvent(
  event: string, sessionId: string, contactId: string | null,
  slug: string, ip: string, req: Request, note?: string,
) {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/video-track`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        'x-viewer-ip': ip,
        'x-viewer-ua': String(req.headers.get('x-viewer-ua') || 'Mozilla/5.0 (video-chat)'),
        // Forwarded so a staff member testing their own video is still suppressed.
        'x-viewer-staff': String(req.headers.get('x-viewer-staff') || ''),
        'x-viewer-jwt': String(req.headers.get('x-viewer-jwt') || ''),
      },
      body: JSON.stringify({ slug, event, session_id: sessionId, contact_id: contactId, note: note || '' }),
    });
    const t = await r.text();
    if (!r.ok) console.error('[video-chat] video-track', event, r.status, t.slice(0, 200));
    else console.log('[video-chat]', event, '->', t.slice(0, 200));
  } catch (e) { console.error('[video-chat] video-track call failed:', String(e)); }
}

async function reportFailure(slug: string, sessionId: string, detail: string, video: { id: string; created_by: string | null; contact_id: string | null } | null) {
  console.error(`[video-chat] UPSTREAM FAILURE slug=${slug} session=${sessionId} :: ${detail}`);
  try {
    if (!(await bump('err:' + slug, 1))) return;   // already reported this hour
    if (!video) return;
    // app_notify_system, not app_notify_mentions: this body has no @handle, so
    // the old call notified nobody while returning cleanly. See the note there.
    await sb.rpc('app_notify_system', {
      p_source_kind: 'video',
      p_source_id: video.id,
      p_body: `⚠️ The AI chat on video /v/${slug} is failing — visitors are getting the fallback message. ${detail.slice(0, 300)}`,
      p_actor_display: 'Video chat',
      p_contact_id: video.contact_id,
    });
  } catch (e) {
    console.error('[video-chat] failure notification itself failed:', String(e));
  }
}

type Session = {
  session_id: string; video_slug: string; contact_id: string | null;
  name: string | null; phone: string | null; email: string | null;
  consent_given: boolean; asks: number; declines: number; stop_asking: boolean;
  captured_at: string | null;
};

async function loadSession(sessionId: string, slug: string): Promise<Session> {
  const { data } = await sb.from('video_chat_sessions').select('*').eq('session_id', sessionId).maybeSingle();
  if (data) return data as Session;
  const row = { session_id: sessionId, video_slug: slug };
  await sb.from('video_chat_sessions').insert(row);
  return {
    session_id: sessionId, video_slug: slug, contact_id: null,
    name: null, phone: null, email: null, consent_given: false,
    asks: 0, declines: 0, stop_asking: false, captured_at: null,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return ok({ error: 'POST only' }, 405);

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const slug = String(body.slug || '').trim();
  const sessionId = String(body.session_id || '').slice(0, 64);
  const action = String(body.action || 'chat');
  const ip = String(req.headers.get('x-viewer-ip') || '').split(',')[0].trim() || 'unknown';

  /* Session rehydration for a page reload. Cheap, read-only, and outside the
   * spend limiter on purpose — refreshing a page must not burn a message. */
  if (action === 'history') {
    if (!slug || !sessionId) return ok({ messages: [], fields: {} });
    const { data: msgs } = await sb.from('video_chat_messages')
      .select('role,content').eq('session_id', sessionId).eq('video_slug', slug)
      .order('created_at', { ascending: true }).limit(40);
    const { data: s } = await sb.from('video_chat_sessions')
      .select('name,phone,email,consent_given').eq('session_id', sessionId).maybeSingle();
    return ok({ messages: msgs || [], fields: s || {} });
  }

  const message = String(body.message || '').trim().slice(0, MAX_CHARS);
  if (!slug || !message || !sessionId) return ok({ error: 'slug, session_id and message required' }, 400);

  // Rate limit BEFORE any spend.
  if (!(await bump('ip:' + ip, MAX_PER_IP_HOUR)) ||
      !(await bump('slug:' + slug, MAX_PER_SLUG_HOUR)) ||
      !(await bump('sess:' + sessionId, MAX_PER_SESSION))) {
    return ok({ reply: "I've hit my limit for now — please call Rene directly at 714-472-8508 and he'll pick this up personally.", limited: true });
  }

  const { data: vid } = await sb.from('videos').select('id,slug,title,contact_id,created_by').eq('slug', slug).maybeSingle();
  if (!vid) return ok({ error: 'not found' }, 404);

  const sess = await loadSession(sessionId, slug);

  // Prior turns for context, oldest first, capped. Fetched BEFORE this message is
  // stored so the current turn is not duplicated in the request.
  const { data: hist } = await sb.from('video_chat_messages')
    .select('role,content').eq('session_id', sessionId)
    .order('created_at', { ascending: true }).limit(12);

  /* contact_id is the session's MATCHED contact or nothing.
   *
   * It used to fall back to vid.contact_id, which means "who Rene SENT this to"
   * — not who is typing. A /v/ link gets forwarded, so the fallback filed a
   * stranger's words against the original recipient's record. Frank's six
   * messages all landed on Rene Duarte's own contact that way. Null until a real
   * match; the capture path backfills every row for the session once identity is
   * actually established (see the update after capture). */
  await sb.from('video_chat_messages').insert({
    video_slug: slug, session_id: sessionId, contact_id: sess.contact_id || null,
    role: 'user', content: message, ip_address: ip,
  });

  /* B6a — first inbound message. Rene wants to know someone reached out even if
   * they never give a name, which is the common case: Frank chatted for a minute
   * and left, and nothing anywhere recorded that a person had shown up.
   *
   * Keyed on the session by COUNTING this session's user turns rather than by a
   * flag column: after the insert above, a count of exactly 1 means the message
   * just stored was the first. A replay or a later turn counts higher and is
   * silently skipped, so no new state and no migration is needed to make it fire
   * once.
   *
   * Routed through video-track rather than notifying directly, so the bot and
   * self-view guards apply here exactly as to every other milestone — otherwise
   * every crawler that renders the page becomes a notification. */
  try {
    const { count: userTurns } = await sb.from('video_chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId).eq('role', 'user');
    if (userTurns === 1) await trackEvent('chat_started', sessionId, sess.contact_id || null, slug, ip, req, message);
  } catch (e) { console.error('[video-chat] first-message notify failed:', String(e)); }

  /* What the model still needs, expressed as instruction rather than left for it
   * to infer from the transcript. `stop_asking` is the two-declines rule and it is
   * enforced HERE, not trusted to the prompt alone. */
  const have: string[] = [];
  if (sess.name) have.push(`name (${sess.name})`);
  if (sess.phone) have.push('phone');
  if (sess.email) have.push('email');
  let stateNote = have.length
    ? `\n\nALREADY RECORDED for this visitor: ${have.join(', ')}. Do not ask for anything you already have.`
    : '\n\nNothing recorded for this visitor yet.';

  /* DETERMINISTIC BACKSTOP. The two-declines rule depends on the model reporting a
   * decline through the tool, and in testing it simply did not call the tool when
   * there was nothing to capture — it stopped asking on its own, correctly, but
   * the enforced counter never moved. A rule that only works when the model
   * volunteers the input is not enforcement. So: several turns in with nothing to
   * show for the asking is treated as a refusal, whether or not it was reported. */
  const priorUserTurns = (hist || []).filter((h: { role: string }) => h.role === 'user').length;
  const nothingGiven = !sess.name && !sess.phone && !sess.email;
  if (!sess.stop_asking && nothingGiven && priorUserTurns >= 4) {
    sess.stop_asking = true;
    await sb.from('video_chat_sessions').update({ stop_asking: true }).eq('session_id', sessionId);
    console.log(`[video-chat] stop_asking set by turn backstop slug=${slug} session=${sessionId}`);
  }

  if (sess.stop_asking) {
    stateNote += ' The visitor has declined to share contact details more than once. DO NOT ask for any contact information again in this conversation — just answer their questions.';
  } else if (sess.phone && !sess.consent_given) {
    stateNote += ' A phone number was offered but they have NOT yet agreed to calls or texts, so it is NOT stored. Ask for that agreement in plain language.';
  } else if (sess.name && !sess.phone && !sess.email) {
    stateNote += ' You have their name. After answering, you may ask for the best way to reach them — phone or email, whichever they prefer.';
  } else if (!sess.name) {
    stateNote += ' After answering their question helpfully, you may ask for their first name.';
  }

  const messages: Array<Record<string, unknown>> = [
    ...(hist || []).map((h: { role: string; content: string }) => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  async function callClaude(msgs: Array<Record<string, unknown>>) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        system: SYSTEM + stateNote,
        tools: TOOLS,
        messages: msgs,
      }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 400)}`);
    const j = JSON.parse(text);
    if (j.error) throw new Error(`api error ${JSON.stringify(j.error).slice(0, 400)}`);
    return j;
  }

  /* ── CAPTURE ──────────────────────────────────────────────────────────────
   * Runs BETWEEN the two model turns, not after them. The validators below are
   * the authority on what is stored, so the model must be told what actually
   * happened before it writes its reply — otherwise it thanks the visitor for a
   * number we rejected, which is worse than not capturing it at all. The
   * tool_result is that truth, in the model's own terms. */
  let captured = false;
  const fields = { name: sess.name, phone: sess.phone, email: sess.email, consent_given: sess.consent_given };

  async function applyCapture(toolInput: Record<string, unknown>): Promise<string> {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const stored: string[] = [];
    const rejected: string[] = [];

    const n = normalizeName(toolInput.name);
    const p = normalizePhone(toolInput.phone);
    const e = normalizeEmail(toolInput.email);
    const consent = toolInput.consent_given === true;
    const declined = toolInput.declined === true;

    if (toolInput.name != null && !n) rejected.push("that name did not look like a real name — ask them to spell it");
    if (toolInput.phone != null && !p) rejected.push("that phone number is not a valid US number — ask them to check the digits");
    if (toolInput.email != null && !e) rejected.push("that email address is not valid — ask them to repeat it");

    if (n && !sess.name) { patch.name = n; fields.name = n; stored.push('name'); }
    if (e && !sess.email) { patch.email = e; fields.email = e; stored.push('email'); }
    /* TCPA GATE: a phone is only ever written alongside affirmative consent.
     * Without it the number is not stored at all — not "stored pending" — so
     * there is no row anywhere that could be dialled without the record of
     * agreement sitting next to it. */
    if (p && (consent || sess.consent_given)) {
      patch.phone = p; fields.phone = p; stored.push('phone');
      if (consent && !sess.consent_given) {
        patch.consent_given = true;
        patch.consent_text = CONSENT_TEXT;
        patch.consent_at = new Date().toISOString();
        fields.consent_given = true;
      }
    } else if (p) {
      console.log(`[video-chat] phone offered without consent slug=${slug} session=${sessionId} — not stored`);
      rejected.push('the phone number was NOT recorded because they have not yet agreed to calls or texts — ask for that agreement in plain language');
    }
    if (declined && !sess.stop_asking) {
      const d = (sess.declines || 0) + 1;
      patch.declines = d;
      // Two declines is the stated limit; after that the ask never returns.
      if (d >= 2) patch.stop_asking = true;
    }
    if (Object.keys(patch).length > 1) {
      await sb.from('video_chat_sessions').update(patch).eq('session_id', sessionId);
    }

    /* A lead is worth writing once we have a name AND a usable channel — a stored
     * phone (which by definition carries consent) or an email. */
    const haveName = (patch.name as string) || sess.name;
    const havePhone = (patch.phone as string) || sess.phone;
    const haveEmail = (patch.email as string) || sess.email;

    /* Runs on EVERY turn that produced a usable field, not only the first. A
     * visitor who gives an email, gets captured, then agrees to calls and gives a
     * number two turns later must have that number land on the contact — gating
     * this whole block on "not captured yet" left the phone and its consent
     * stranded in the session row, which is the one place nobody looks. */
    const alreadyCaptured = !!sess.captured_at;
    if (haveName && (havePhone || haveEmail)) {
      /* DEDUPE, in the order asked for: phone, then email, then the contact the
       * video was sent to. The page may have been FORWARDED, so the video's own
       * contact is the weakest signal and must come last — matching it first would
       * overwrite the original recipient with the forwardee's details. */
      let contactId: string | null = alreadyCaptured ? sess.contact_id : null;
      let matchedBy = alreadyCaptured ? 'session' : 'new';
      if (!contactId && havePhone) {
        const { data } = await sb.from('contacts').select('id').eq('phone', havePhone).limit(1);
        if (data && data.length) { contactId = data[0].id; matchedBy = 'phone'; }
      }
      if (!contactId && haveEmail) {
        const { data } = await sb.from('contacts').select('id').ilike('email', haveEmail).limit(1);
        if (data && data.length) { contactId = data[0].id; matchedBy = 'email'; }
      }
      /* Fallback to the person the video was SENT to — but only when the visitor's
       * own details do not contradict that person. A shared link is chatted by
       * someone who is not the recipient, and without this check the second
       * visitor's details land on the first person's record: two real people
       * merged into one contact, with a phone number that belongs to neither of
       * the emails on file. Observed in testing, not hypothesised. */
      if (!contactId && !alreadyCaptured && vid.contact_id) {
        const { data: rec } = await sb.from('contacts').select('id,email,phone').eq('id', vid.contact_id).maybeSingle();
        const emailConflict = !!(haveEmail && rec?.email && String(rec.email).toLowerCase() !== haveEmail);
        const phoneConflict = !!(havePhone && rec?.phone && String(rec.phone) !== havePhone);
        if (rec && !emailConflict && !phoneConflict) { contactId = rec.id; matchedBy = 'video_recipient'; }
        else if (rec) console.log(`[video-chat] not merging into video recipient slug=${slug} — visitor details differ`);
      }

      /* The consent record travels WITH the phone or not at all. sms_opt_in on
       * contacts DEFAULTS TO TRUE, so an insert that merely omits it produces a
       * contact that looks opted-in with nothing backing it — it is set
       * explicitly here in both directions for exactly that reason. */
      const hasConsent = !!(patch.consent_given || sess.consent_given) && !!havePhone;
      const consentPatch = hasConsent ? {
        sms_opt_in: true,
        sms_consent_text: CONSENT_TEXT,
        sms_consent_at: (patch.consent_at as string) || new Date().toISOString(),
        sms_consent_source: `video_chat /v/${slug}`,
      } : {};

      if (contactId) {
        /* Fill blanks only. An existing borrower's record is authoritative — a
         * chatbot must not overwrite a name or number Rene already has. */
        const { data: cur } = await sb.from('contacts').select('id,first_name,last_name,email,phone').eq('id', contactId).maybeSingle();
        const upd: Record<string, unknown> = { ...consentPatch };
        if (cur && !cur.phone && havePhone) upd.phone = havePhone;
        if (cur && !cur.email && haveEmail) upd.email = haveEmail;
        if (cur && !cur.first_name && haveName) {
          upd.first_name = haveName.split(/\s+/)[0];
          const rest = haveName.split(/\s+/).slice(1).join(' ');
          if (rest && !cur.last_name) upd.last_name = rest;
        }
        if (Object.keys(upd).length) await sb.from('contacts').update(upd).eq('id', contactId);
      } else {
        const { data: created, error: cErr } = await sb.from('contacts').insert({
          first_name: haveName.split(/\s+/)[0] || haveName,
          last_name: haveName.split(/\s+/).slice(1).join(' ') || null,
          email: haveEmail || null,
          phone: havePhone || null,
          source: 'video_chat',
          notes: `Captured by the AI assistant on video page /v/${slug} (“${vid.title || 'video'}”)`,
          // Explicit, never defaulted — see the consent note above.
          sms_opt_in: hasConsent,
          ...consentPatch,
        }).select('id').single();
        if (cErr) console.error('[video-chat] contact insert failed:', cErr.message);
        contactId = created?.id || null;
      }

      // First capture only: session bookkeeping, video attribution, and the
      // downstream transcript + scoring event that capturedContactId drives.
      if (contactId && !alreadyCaptured) {
        await sb.from('video_chat_sessions')
          .update({ contact_id: contactId, captured_at: new Date().toISOString() })
          .eq('session_id', sessionId);
        /* videos.contact_id is deliberately NOT written back. It means "who Rene
         * sent this to", and stamping the first chatter onto an unattributed video
         * makes that video belong to them — after which every later visitor on the
         * same link falls through the dedupe chain into their record. Attribution
         * to the video already lives on the transcript and the activity event. */
        capturedContactId = contactId;
        capturedMatchedBy = matchedBy;
      }
    }

    if (stored.length && !rejected.length) return `Recorded: ${stored.join(', ')}. Thank them naturally and do not ask for anything else you already have.`;
    if (stored.length) return `Recorded: ${stored.join(', ')}. However — ${rejected.join('; ')}.`;
    if (rejected.length) return `Nothing was recorded. ${rejected.join('; ')}.`;
    return 'Nothing new to record.';
  }

  let reply = '';
  let degraded = false;
  let capturedContactId: string | null = null;
  let capturedMatchedBy = 'new';

  try {
    let j = await callClaude(messages);
    const collect = (m: any) => {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const t = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').trim();
      const tu = blocks.find((b: any) => b.type === 'tool_use' && b.name === 'capture_contact');
      return { t, tu };
    };
    let { t, tu } = collect(j);
    if (tu) {
      // Validate and persist FIRST, then hand the model the real outcome.
      let toolResult = 'Nothing new to record.';
      try { toolResult = await applyCapture((tu.input || {}) as Record<string, unknown>); }
      catch (e) { console.error(`[video-chat] capture failed slug=${slug} session=${sessionId}:`, String(e)); }
      messages.push({ role: 'assistant', content: j.content });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: toolResult }] });
      j = await callClaude(messages);
      const second = collect(j);
      t = [t, second.t].filter(Boolean).join(' ').trim();
    }
    reply = t;
    if (!reply) throw new Error(`empty reply, stop_reason=${j.stop_reason} content=${JSON.stringify(j.content).slice(0, 200)}`);
  } catch (e) {
    degraded = true;
    await reportFailure(slug, sessionId, String((e && (e as Error).message) || e), vid);
  }
  if (!reply) reply = "I'm having trouble answering right now — Rene can help directly at 714-472-8508.";

  await sb.from('video_chat_messages').insert({
    video_slug: slug, session_id: sessionId, contact_id: capturedContactId || sess.contact_id || vid.contact_id || null,
    role: 'assistant', content: reply, ip_address: ip,
  });

  /* Post-reply bookkeeping. Deliberately after the assistant turn is stored so the
   * transcript Rene reads includes the last thing the visitor was told. Failures
   * here are logged, never surfaced — the visitor already has their answer. */
  if (capturedContactId) {
    captured = true;
    try {
      await sb.from('video_chat_messages').update({ contact_id: capturedContactId }).eq('session_id', sessionId);

      /* B8 — the transcript, on the lead, as a `note`: the type the timeline
       * already renders, so Rene reads it where he reads everything else. */
      const { data: full } = await sb.from('video_chat_messages')
        .select('role,content').eq('session_id', sessionId).order('created_at', { ascending: true }).limit(60);
      const transcript = (full || [])
        .map((m: { role: string; content: string }) => (m.role === 'user' ? 'Them: ' : 'Assistant: ') + m.content)
        .join('\n\n');
      await sb.from('activity_events').insert({
        contact_id: capturedContactId, type: 'note', channel: 'video',
        title: `Video chat transcript — “${vid.title || 'video'}”`,
        description: transcript.slice(0, 8000),
        metadata: { video_slug: slug, video_id: vid.id, session_id: sessionId, matched_by: capturedMatchedBy, source: 'video_chat' },
      });
    } catch (e) { console.error('[video-chat] transcript write failed:', String(e)); }

    /* B5 — the scoring event, emitted through video-track so the self-view, bot
     * and depth guards apply here exactly as they do to every other milestone.
     * video-track also owns the "worth a call" notification, so B6 needs nothing
     * new built. */
    await trackEvent('chat_lead_captured', sessionId, capturedContactId, slug, ip, req);
  }

  return ok({ reply, captured, degraded, fields });
});

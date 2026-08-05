// video-track — engagement events for the /v/<slug> landing page.
//
// Called ONLY by the Cloudflare Worker (same-origin /v/<slug>/track), so the
// supabase.co host never reaches a recipient. verify_jwt must be false: viewers
// are anonymous borrowers.
//
// ── ANTI-INFLATION ───────────────────────────────────────────────────────────
// Rene's contact record already reads 20/20 engagement off his own test emails.
// Guards so video does not repeat that:
//   1. SELF-VIEWS are suppressed — a real STAFF session, a staff browser marker,
//      or an explicit preview flag all mark the view as self and write nothing.
//   2. BOTS are suppressed — scanner/headless user agents.
//   3. PLAY GATE — nothing above the weakest tier is accepted without a play
//      first, so a link preview fetch cannot manufacture a watch.
//   4. DEPTH CAP keyed on (contact_id, video_slug, milestone) — the first time a
//      milestone is reached FOR THAT VIDEO it is emitted under its scoring type;
//      every later occurrence is emitted as `video_rewatch`, which is
//      deliberately absent from lead_score_config.engagement_events. The key
//      includes video_slug, so a milestone on one video never suppresses the
//      same milestone on a different video.
//
// ── WHY THE JWT ARRIVES AS x-viewer-jwt ──────────────────────────────────────
// `Authorization` on this request is ALWAYS the Supabase anon key: the Worker
// must send it to invoke the function at all, and doing so overwrites whatever
// the viewer's browser sent. Reading `authorization` here therefore only ever
// saw the anon key — sb.auth.getUser(anonKey) yields no user, so the staff
// signal never once fired. The viewer's own session now travels under our own
// header name instead, which the Worker sets and a client cannot forge.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info, x-forwarded-for, x-viewer-ip, x-viewer-ua, x-viewer-jwt, x-viewer-staff',
};
const J = { ...cors, 'Content-Type': 'application/json' };

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// Internal roles (auth_user_roles.role). A borrower with a portal login is
// authenticated but is NOT staff, and must still score normally.
const STAFF_ROLES = ['admin', 'agent', 'loa', 'va', 'staff'];

/* Milestone → activity_events type + a reason template. The template carries the
 * video title so lead_score_history reads as a sentence rather than a type name:
 *   watched “Rate update” to 100% (1st view) */
const EVENTS: Record<string, {
  type: string; reason: (t: string) => string; minPct?: number; gated: boolean;
}> = {
  page_opened:        { type: 'video_page_opened',        reason: (t) => `opened “${t}”`,                       gated: false },
  play_started:       { type: 'video_play_started',       reason: (t) => `started watching “${t}”`,             gated: true },
  watched_50:         { type: 'video_watched_50',         reason: (t) => `watched “${t}” to 50%`,  minPct: 50,  gated: true },
  watched_75:         { type: 'video_watched_75',         reason: (t) => `watched “${t}” to 75%`,  minPct: 75,  gated: true },
  completed:          { type: 'video_completed',          reason: (t) => `watched “${t}” to 100%`, minPct: 90,  gated: true },
  cta_clicked:        { type: 'video_cta_clicked',        reason: (t) => `clicked a call-to-action on “${t}”`,  gated: true },
  chat_started:       { type: 'video_chat_started',       reason: (t) => `opened the chat on “${t}”`,           gated: false },
  chat_lead_captured: { type: 'video_chat_lead_captured', reason: (t) => `left contact details on “${t}”`,      gated: false },
};
const MILESTONES = Object.values(EVENTS).map((e) => e.type);

const BOT_RE = /bot|crawler|spider|slurp|bingpreview|facebookexternalhit|whatsapp|telegram|slackbot|discordbot|preview|scanner|curl|wget|python-requests|headless|phantomjs|lighthouse|pingdom|uptime|monitor|gptbot|claudebot|ahrefs|semrush|proofpoint|barracuda|mimecast|microsoft office|outlook/i;

function ok(d: unknown) { return new Response(JSON.stringify(d), { headers: J }); }

function ord(n: number) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* A real staff session? getUser validates the signature against auth, then the
 * role table decides — an authenticated BORROWER must still score. */
async function isStaffJwt(jwt: string): Promise<boolean> {
  if (!jwt || jwt.split('.').length !== 3) return false;
  try {
    // The anon/service keys are well-formed JWTs too; neither has a user.
    const claims = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!claims?.sub || claims.role === 'anon' || claims.role === 'service_role') return false;
  } catch (_) { return false; }
  try {
    const { data, error } = await sb.auth.getUser(jwt);
    if (error || !data?.user) return false;
    const { data: r } = await sb.from('auth_user_roles')
      .select('role').eq('user_id', data.user.id).maybeSingle();
    return !!r && STAFF_ROLES.includes(String(r.role));
  } catch (_) { return false; }
}

/* Is this the sender (or any staff member) watching their own video? */
async function selfViewReason(opts: { jwt: string; staffCookie: boolean; preview: boolean }) {
  if (opts.preview) return 'preview_flag';
  // Cross-subdomain marker: the CRM runs on admin.ratesandrealty.com but these
  // links open on the apex, where the admin session's localStorage is not
  // readable. auth-guard.js drops a non-secret cookie on .ratesandrealty.com so
  // the staff BROWSER is still recognisable on the public host.
  if (opts.staffCookie) return 'staff_browser';
  if (await isStaffJwt(opts.jwt)) return 'staff_session';
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return ok({ ok: false, error: 'POST only' });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const slug = String(body.slug || '').trim();
  const evKey = String(body.event || '').trim();
  const sessionId = String(body.session_id || '').slice(0, 64);
  const pct = Number(body.percent || 0);
  const ev = EVENTS[evKey];
  if (!slug || !ev) return ok({ ok: false, error: 'unknown event' });

  // The Worker forwards the real viewer IP/UA/session; header names are ours,
  // not client-set. `authorization` is deliberately NOT read — see header note.
  const ip = String(req.headers.get('x-viewer-ip') || '').split(',')[0].trim();
  const ua = String(req.headers.get('x-viewer-ua') || '');
  const jwt = String(req.headers.get('x-viewer-jwt') || '').replace(/^Bearer\s+/i, '').trim();
  const staffCookie = req.headers.get('x-viewer-staff') === '1';

  /* INTERNAL CALLER. video-chat captures a lead whose contact is known only to it:
   * videos.contact_id means "who Rene SENT this to" and is deliberately not
   * rewritten when a stranger on a forwarded link leaves their details. Without a
   * contact on the event, trigger_score_recalc() returns early (it skips null
   * contact_id) and the capture scores nothing.
   *
   * Trusted ONLY on an exact service-role key match. Public traffic reaches this
   * function through the Worker, which always sets Authorization to the ANON key,
   * so a visitor can never assert a contact_id and attribute events to a stranger. */
  const authTok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const isInternal = !!authTok && authTok === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  const { data: vid } = await sb.from('videos')
    .select('id,slug,title,contact_id,created_by,view_count').eq('slug', slug).maybeSingle();
  if (!vid) return ok({ ok: false, error: 'not found' });

  // ── guard 2: bots ────────────────────────────────────────────────────────
  if (!ua || BOT_RE.test(ua)) return ok({ ok: true, suppressed: 'bot' });

  // ── guard 1: self-views ──────────────────────────────────────────────────
  const self = await selfViewReason({ jwt, staffCookie, preview: !!body.preview });
  if (self) return ok({ ok: true, suppressed: 'self:' + self });

  const claimed = isInternal && typeof body.contact_id === 'string' ? body.contact_id.trim() : '';
  const contactId: string | null = claimed || vid.contact_id || null;

  /* Prior milestones for THIS video. Keyed on video_slug, and read from
   * metadata->>milestone rather than the `type` column: a repeat is stored as
   * type='video_rewatch', so `type` loses which milestone it was — which also
   * made the view counter stick at 2. Scoped to the contact when the video is
   * attributed to one, otherwise to this browser session so one anonymous
   * viewer cannot suppress another's milestones. */
  const priorQ = sb.from('activity_events')
    .select('metadata')
    .filter('metadata->>video_slug', 'eq', vid.slug)
    .limit(1000);
  if (contactId) priorQ.eq('contact_id', contactId);
  else priorQ.filter('metadata->>session_id', 'eq', sessionId);
  const { data: prior } = await priorQ;
  const seenList = (prior || [])
    .map((r: { metadata: Record<string, unknown> | null }) => String(r.metadata?.milestone || ''))
    .filter(Boolean);
  const seen = new Set(seenList);

  // ── guard 3: play gate ───────────────────────────────────────────────────
  // Anything above the weakest tier needs a real play from THIS session first.
  if (ev.gated && ev.type !== 'video_play_started') {
    const { data: played } = await sb.from('activity_events')
      .select('id')
      .filter('metadata->>milestone', 'eq', 'video_play_started')
      .filter('metadata->>video_slug', 'eq', vid.slug)
      .filter('metadata->>session_id', 'eq', sessionId)
      .limit(1);
    if (!played || !played.length) return ok({ ok: true, suppressed: 'no_play_in_session' });
  }
  if (ev.minPct && pct && pct < ev.minPct) return ok({ ok: true, suppressed: 'below_threshold' });

  // ── guard 4: depth cap on (contact_id, video_slug, milestone) ────────────
  // Emit the scoring type only the first time THIS milestone is reached on THIS
  // video. Later occurrences become video_rewatch, which is not in
  // engagement_events and therefore scores nothing. A deeper watch of the same
  // video is a milestone this video has not seen yet, so it still scores.
  const opens = seenList.filter((m) => m === 'video_page_opened').length;
  const viewNumber = evKey === 'page_opened' ? opens + 1 : Math.max(1, opens);
  const outType = seen.has(ev.type) ? 'video_rewatch' : ev.type;

  // A human-readable reason, carried to lead_score_history via
  // activity_events.description (trigger_score_recalc forwards it).
  const reason = `${ev.reason(vid.title || 'video')} (${ord(viewNumber)} view)`;

  const { error: insErr } = await sb.from('activity_events').insert({
    contact_id: contactId,
    type: outType,
    title: `Video ${outType === 'video_rewatch' ? 'rewatch' : 'engagement'}`,
    description: reason,
    channel: 'video',
    status: outType === 'video_rewatch' ? 'rewatch' : 'new',
    ip_address: ip || null,
    user_agent: ua || null,
    session_id: sessionId || null,
    metadata: {
      video_id: vid.id, video_slug: vid.slug, video_title: vid.title,
      milestone: ev.type, percent: pct || null, session_id: sessionId,
      view_number: viewNumber, scored: outType !== 'video_rewatch', reason,
    },
  });
  if (insErr) return ok({ ok: false, error: insErr.message });

  if (evKey === 'page_opened') {
    await sb.from('videos').update({ view_count: (vid.view_count || 0) + 1 }).eq('id', vid.id);
  }

  /* The moment to call.
   *
   * This used to call app_notify_mentions and had NEVER delivered anything.
   * That function is not a general notifier despite the name: it scans p_body
   * for @handles, and this body has none, so it iterated zero times, returned 0
   * and inserted nothing. Zero notifications with source_kind='video' exist,
   * ever. app_notify_system inserts by ROLE instead and returns a count.
   *
   * Two deliberate differences from the old condition:
   *
   * - contactId is no longer required. An anonymous stranger chatting on a
   *   forwarded link is exactly the person Rene most wants to hear about, and
   *   requiring a contact meant silence for precisely that case.
   * - chat milestones notify even when outType is video_rewatch. The depth cap
   *   is a SCORING control: a second visitor on the same video is a rewatch for
   *   scoring, and still news. Watch milestones keep the old behaviour, so a
   *   rewatch does not re-alert. */
  const CHAT_ALWAYS = ['video_chat_started', 'video_chat_lead_captured'];
  const notifyType = CHAT_ALWAYS.includes(ev.type) ? ev.type : outType;
  const shouldNotify = CHAT_ALWAYS.includes(ev.type)
    ? true
    : (!!contactId && outType !== 'video_rewatch' &&
       ['video_completed', 'video_cta_clicked'].includes(outType));

  if (shouldNotify) {
    try {
      const note = String(body.note || '').slice(0, 240);
      const who = contactId ? '' : ' (not yet identified)';
      /* Where the row should OPEN. The producer decides, because only the
       * producer knows: a chat session whose visitor never left contact details
       * has no lead page to go to, and the bell's contact_id-only rule made it a
       * dead click. It has a session and /admin/video-chats can read it. */
      const link = contactId
        ? `/admin/lead-detail?contact_id=${contactId}`
        : (CHAT_ALWAYS.includes(ev.type) && sessionId
            ? `/admin/video-chats?session=${encodeURIComponent(sessionId)}`
            : null);
      const n = await sb.rpc('app_notify_system', {
        p_source_kind: 'video',
        p_source_id: vid.id,
        p_link: link,
        p_body: notifyType === 'video_chat_started'
          ? `💬 Someone started chatting on “${vid.title || 'your video'}”${who}${note ? ` — “${note}”` : ''}`
          : notifyType === 'video_chat_lead_captured'
            ? `🎯 ${reason}${who} — contact details left on the video chat.`
            : `🎥 ${reason} — warm right now, worth a call.`,
        p_actor_display: 'Video engagement',
        p_contact_id: contactId,
      });
      console.log('[video-track] notified', JSON.stringify(n.data ?? n), 'for', notifyType);
    } catch (e) { console.error('[video-track] notify failed:', String(e)); }
  }

  return ok({ ok: true, type: outType, milestone: ev.type, reason, scored: outType !== 'video_rewatch' });
});

// video-track — engagement events for the /v/<slug> landing page.
//
// Called ONLY by the Cloudflare Worker (same-origin /v/<slug>/track), so the
// supabase.co host never reaches a recipient. verify_jwt must be false: viewers
// are anonymous borrowers.
//
// ── ANTI-INFLATION (Part 5c) ─────────────────────────────────────────────────
// Rene's contact record already reads 20/20 engagement off his own test emails.
// Four independent guards exist so video does not repeat that:
//   1. SELF-VIEWS are suppressed — a staff JWT, an IP the sender used recently,
//      or an explicit preview flag all mark the view as self and write nothing.
//   2. BOTS are suppressed — scanner/headless user agents, and any "view" that
//      never produced a play event.
//   3. PLAY GATE — nothing above the weakest tier is accepted without a play
//      first, so a link preview fetch cannot manufacture a watch.
//   4. DEPTH CAP per (contact, video) — the first time a milestone is reached it
//      is emitted under its scoring type; every later occurrence is emitted as
//      `video_rewatch`, which is deliberately absent from
//      lead_score_config.engagement_events. Rewatching is recorded for the
//      timeline and adds exactly zero score. The dedupe happens HERE at emission
//      rather than inside lead-scorer, because the instruction was to wire into
//      the existing engine, not to modify its scoring path.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info, x-forwarded-for, x-viewer-ip, x-viewer-ua',
};
const J = { ...cors, 'Content-Type': 'application/json' };

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// Milestone → activity_events type. page_opened/chat_started are 0-point but are
// in the trigger allowlist so the timeline stays real time.
const EVENTS: Record<string, { type: string; label: string; minPct?: number; gated: boolean }> = {
  page_opened:       { type: 'video_page_opened',       label: 'opened',            gated: false },
  play_started:      { type: 'video_play_started',      label: 'started watching',  gated: true },
  watched_50:        { type: 'video_watched_50',        label: 'watched to 50%',    minPct: 50,  gated: true },
  watched_75:        { type: 'video_watched_75',        label: 'watched to 75%',    minPct: 75,  gated: true },
  completed:         { type: 'video_completed',         label: 'watched to 100%',   minPct: 90,  gated: true },
  cta_clicked:       { type: 'video_cta_clicked',       label: 'clicked a call-to-action', gated: true },
  chat_started:      { type: 'video_chat_started',      label: 'opened the chat',   gated: false },
  chat_lead_captured:{ type: 'video_chat_lead_captured',label: 'left contact details', gated: false },
};
// Depth order for the per-(contact,video) cap. Higher wins.
const DEPTH: Record<string, number> = {
  video_page_opened: 0, video_chat_started: 0,
  video_play_started: 1, video_watched_50: 2, video_watched_75: 3,
  video_completed: 4, video_cta_clicked: 5, video_chat_lead_captured: 6,
};

const BOT_RE = /bot|crawler|spider|slurp|bingpreview|facebookexternalhit|whatsapp|telegram|slackbot|discordbot|preview|scanner|curl|wget|python-requests|headless|phantomjs|lighthouse|pingdom|uptime|monitor|gptbot|claudebot|ahrefs|semrush|proofpoint|barracuda|mimecast|microsoft office|outlook/i;

function ok(d: unknown) { return new Response(JSON.stringify(d), { headers: J }); }

/* Is this the sender (or any staff member) watching their own video?
 * Three independent signals — any one is enough. */
async function isSelfView(opts: { jwt: string; ip: string; creator: string | null; preview: boolean }) {
  if (opts.preview) return 'preview_flag';
  // A valid staff session watching = Rene or a VA checking their own send.
  if (opts.jwt) {
    try {
      const { data } = await sb.auth.getUser(opts.jwt);
      if (data?.user) return 'staff_session';
    } catch (_) { /* not a session token; fall through */ }
  }
  // Same IP the sender has been using in the CRM recently.
  if (opts.ip && opts.creator) {
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const { data } = await sb.from('activity_events')
      .select('id').eq('created_by', opts.creator).eq('ip_address', opts.ip)
      .gte('created_at', since).limit(1);
    if (data && data.length) return 'sender_ip';
  }
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

  // The Worker forwards the real viewer IP/UA; header names are ours, not client-set.
  const ip = String(req.headers.get('x-viewer-ip') || '').split(',')[0].trim();
  const ua = String(req.headers.get('x-viewer-ua') || '');
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();

  const { data: vid } = await sb.from('videos')
    .select('id,slug,title,contact_id,created_by,view_count').eq('slug', slug).maybeSingle();
  if (!vid) return ok({ ok: false, error: 'not found' });

  // ── guard 2: bots ────────────────────────────────────────────────────────
  if (!ua || BOT_RE.test(ua)) return ok({ ok: true, suppressed: 'bot' });

  // ── guard 1: self-views ──────────────────────────────────────────────────
  const self = await isSelfView({ jwt, ip, creator: vid.created_by, preview: !!body.preview });
  if (self) return ok({ ok: true, suppressed: 'self:' + self });

  // ── guard 3: play gate ───────────────────────────────────────────────────
  // Anything above the weakest tier needs a real play from THIS session first.
  if (ev.gated) {
    const { data: played } = await sb.from('activity_events')
      .select('id').eq('type', 'video_play_started')
      .contains('metadata', { video_id: vid.id, session_id: sessionId }).limit(1);
    const isPlayItself = ev.type === 'video_play_started';
    if (!isPlayItself && (!played || !played.length)) {
      return ok({ ok: true, suppressed: 'no_play_in_session' });
    }
  }
  if (ev.minPct && pct && pct < ev.minPct) return ok({ ok: true, suppressed: 'below_threshold' });

  const contactId: string | null = vid.contact_id || null;

  // ── guard 4: depth cap per (contact, video) ──────────────────────────────
  // Emit the scoring type only the first time this depth is reached for this
  // lead+video. Later occurrences become video_rewatch, which is not in
  // engagement_events and therefore scores nothing.
  let outType = ev.type;
  let viewNumber = 1;
  if (contactId) {
    const { data: prior } = await sb.from('activity_events')
      .select('type').eq('contact_id', contactId)
      .contains('metadata', { video_id: vid.id })
      .in('type', Object.keys(DEPTH));
    const seen = (prior || []).map((r: { type: string }) => r.type);
    viewNumber = seen.filter((t) => t === 'video_page_opened').length + (evKey === 'page_opened' ? 1 : 0);
    if (seen.includes(ev.type)) outType = 'video_rewatch';
  }

  const ord = viewNumber > 1 ? ` (${viewNumber}${viewNumber === 2 ? 'nd' : viewNumber === 3 ? 'rd' : 'th'} view)` : '';
  // 5e: a human-readable reason, so lead_score_history explains itself.
  const reason = `${ev.label} “${vid.title || 'video'}”${ord}`;

  await sb.from('activity_events').insert({
    contact_id: contactId,
    type: outType,
    title: `Video ${ev.label}`,
    description: reason,
    channel: 'video',
    status: outType === 'video_rewatch' ? 'rewatch' : 'new',
    ip_address: ip || null,
    user_agent: ua || null,
    session_id: sessionId || null,
    metadata: {
      video_id: vid.id, video_slug: vid.slug, video_title: vid.title,
      milestone: ev.type, percent: pct || null, session_id: sessionId,
      view_number: viewNumber, scored: outType !== 'video_rewatch',
    },
  });

  if (evKey === 'page_opened') {
    await sb.from('videos').update({ view_count: (vid.view_count || 0) + 1 }).eq('id', vid.id);
  }

  /* 5f: the moment to call. Uses the EXISTING notification path
   * (app_notify_mentions → notifications, surfaced by notifications_list and the
   * bell). Nothing new was built for this. */
  if (contactId && outType !== 'video_rewatch' &&
      ['video_completed', 'video_cta_clicked', 'video_chat_lead_captured'].includes(outType)) {
    try {
      await sb.rpc('app_notify_mentions', {
        p_source_kind: 'video',
        p_source_id: vid.id,
        p_body: `🎥 ${reason} — warm right now, worth a call.`,
        p_actor_user_id: vid.created_by,
        p_actor_display: 'Video engagement',
        p_contact_id: contactId,
      });
    } catch (_) { /* notification failure must not lose the event */ }
  }

  return ok({ ok: true, type: outType, scored: outType !== 'video_rewatch' });
});

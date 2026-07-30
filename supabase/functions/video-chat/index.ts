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
//   • Replies are plain text. The page renders them through the same DOMPurify
//     path as everything else — there is no second sanitize path.
//
// Called only by the Worker (same-origin /v/<slug>/chat). verify_jwt false.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info, x-viewer-ip, x-viewer-ua',
};
const J = { ...cors, 'Content-Type': 'application/json' };

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

// Caps. Deliberately low: this is a 1:1 follow-up chat, not a support desk.
const MAX_PER_IP_HOUR = 40;
const MAX_PER_SLUG_HOUR = 60;
const MAX_PER_SESSION = 25;
const MAX_CHARS = 1500;

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
- If asked anything touching numbers, eligibility, or approval, say plainly that Rene has to look at the specifics and invite them to call 714-472-8508 or leave their name and number here.

STYLE: warm, brief, plain English. 2-4 sentences. No markdown, no bullet lists, no headings — your reply is rendered as plain text. If they give a name and a phone or email, thank them and tell them Rene will follow up personally.`;

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

// Deliberately conservative: only a clear "name + reachable contact" counts.
function extractLead(text: string) {
  const email = (text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0] || null;
  const phoneRaw = (text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/) || [])[0] || null;
  const phone = phoneRaw ? phoneRaw.replace(/\D/g, '').slice(-10) : null;
  let name: string | null = null;
  const m = text.match(/\b(?:i'?m|i am|my name is|this is|it'?s)\s+([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?)/i);
  if (m) name = m[1].trim();
  return { name, email, phone };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return ok({ error: 'POST only' }, 405);

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const slug = String(body.slug || '').trim();
  const sessionId = String(body.session_id || '').slice(0, 64);
  const message = String(body.message || '').trim().slice(0, MAX_CHARS);
  if (!slug || !message || !sessionId) return ok({ error: 'slug, session_id and message required' }, 400);

  const ip = String(req.headers.get('x-viewer-ip') || '').split(',')[0].trim() || 'unknown';

  // Rate limit BEFORE any spend.
  if (!(await bump('ip:' + ip, MAX_PER_IP_HOUR)) ||
      !(await bump('slug:' + slug, MAX_PER_SLUG_HOUR)) ||
      !(await bump('sess:' + sessionId, MAX_PER_SESSION))) {
    return ok({ reply: "I've hit my limit for now — please call Rene directly at 714-472-8508 and he'll pick this up personally.", limited: true });
  }

  const { data: vid } = await sb.from('videos').select('id,slug,title,contact_id,created_by').eq('slug', slug).maybeSingle();
  if (!vid) return ok({ error: 'not found' }, 404);

  // Prior turns for context, oldest first, capped.
  const { data: hist } = await sb.from('video_chat_messages')
    .select('role,content').eq('session_id', sessionId).order('created_at', { ascending: true }).limit(12);

  await sb.from('video_chat_messages').insert({
    video_slug: slug, session_id: sessionId, contact_id: vid.contact_id || null,
    role: 'user', content: message, ip_address: ip,
  });

  let reply = '';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        system: SYSTEM,
        messages: [...(hist || []).map((h: { role: string; content: string }) => ({ role: h.role, content: h.content })),
                   { role: 'user', content: message }],
      }),
    });
    const j = await r.json();
    reply = j?.content?.[0]?.text || '';
  } catch (_) { /* fall through to the generic reply below */ }
  if (!reply) reply = "I'm having trouble answering right now — Rene can help directly at 714-472-8508.";

  await sb.from('video_chat_messages').insert({
    video_slug: slug, session_id: sessionId, contact_id: vid.contact_id || null,
    role: 'assistant', content: reply, ip_address: ip,
  });

  /* Lead capture. Only fires on a real name + reachable contact. Attributed to
   * this video token so it links back to whoever was sent the link. */
  const lead = extractLead(message);
  let captured = false;
  if ((lead.email || lead.phone) && lead.name) {
    try {
      let contactId = vid.contact_id as string | null;
      if (!contactId) {
        const orParts = [lead.email ? `email.ilike.${lead.email}` : '', lead.phone ? `phone.eq.${lead.phone}` : ''].filter(Boolean).join(',');
        const { data: existing } = orParts
          ? await sb.from('contacts').select('id').or(orParts).limit(1) : { data: null };
        if (existing && existing.length) contactId = existing[0].id;
        else {
          const { data: created } = await sb.from('contacts').insert({
            first_name: lead.name.split(/\s+/)[0] || lead.name,
            last_name: lead.name.split(/\s+/).slice(1).join(' ') || null,
            email: lead.email, phone: lead.phone,
            source: 'video_page',
            notes: `Captured from video page /v/${slug} (“${vid.title || 'video'}”)`,
          }).select('id').single();
          contactId = created?.id || null;
        }
        if (contactId) await sb.from('videos').update({ contact_id: contactId }).eq('id', vid.id);
      }
      if (contactId) {
        await sb.from('video_chat_messages').update({ contact_id: contactId }).eq('session_id', sessionId);
        captured = true;
        // Strongest signal in the taxonomy — emitted through the same tracker so
        // the self-view/bot/depth guards apply here too.
        await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/video-track`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-viewer-ip': ip,
            'x-viewer-ua': String(req.headers.get('x-viewer-ua') || 'video-chat'),
          },
          body: JSON.stringify({ slug, event: 'chat_lead_captured', session_id: sessionId }),
        }).catch(() => {});
      }
    } catch (_) { /* never fail the reply because bookkeeping failed */ }
  }

  return ok({ reply, captured });
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info'
};

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY');

// ── Temperature scoring ──────────────────────────────────────────────────────
function calcTemperature(data: any): { score: number; label: string } {
  let score = 0;
  const now = Date.now();
  const day = 86400000;

  // Portal logins (up to 20 pts)
  const recentLogins = (data.activity || []).filter((a: any) =>
    a.type === 'page_view' && (now - new Date(a.created_at).getTime()) < 7 * day
  ).length;
  score += Math.min(recentLogins * 4, 20);

  // SMS recency (up to 20 pts)
  const lastSms = data.sms?.length ? new Date(data.sms[0].created_at).getTime() : 0;
  if (lastSms) {
    const daysAgo = (now - lastSms) / day;
    if (daysAgo < 1) score += 20;
    else if (daysAgo < 3) score += 15;
    else if (daysAgo < 7) score += 10;
    else if (daysAgo < 14) score += 5;
  }

  // Email opens (up to 15 pts)
  const recentOpens = (data.emailOpens || []).filter((e: any) =>
    (now - new Date(e.opened_at).getTime()) < 14 * day
  ).length;
  score += Math.min(recentOpens * 5, 15);

  // Showings scheduled (up to 20 pts)
  score += Math.min((data.showings?.length || 0) * 5, 20);

  // Documents uploaded (up to 10 pts)
  const docUploads = (data.activity || []).filter((a: any) => a.type === 'document_uploaded').length;
  score += Math.min(docUploads * 5, 10);

  // 1003 started (15 pts)
  const has1003 = (data.activity || []).some((a: any) =>
    a.title?.toLowerCase().includes('1003') || a.title?.toLowerCase().includes('application')
  );
  if (has1003) score += 15;

  const label = score >= 60 ? 'hot' : score >= 30 ? 'warm' : 'cold';
  return { score, label };
}

// ── Next best action ─────────────────────────────────────────────────────────
function calcNextAction(data: any, contact: any): { action: string; reason: string } {
  const now = Date.now();
  const day = 86400000;

  const lastContactMs = data.sms?.length
    ? now - new Date(data.sms[0].created_at).getTime()
    : Infinity;
  const has1003 = data.application?.length > 0;
  const hasDrip = data.drip?.length > 0;
  const recentLogins = (data.activity || []).filter((a: any) =>
    a.type === 'page_view' && (now - new Date(a.created_at).getTime()) < 3 * day
  ).length;
  const pendingShowings = (data.showings || []).filter((s: any) => s.status === 'pending').length;
  const hasListing = (data.activity || []).some((a: any) => a.type === 'email' && a.title?.includes('Listing Alert'));

  if (pendingShowings > 0)
    return { action: `Confirm ${pendingShowings} pending showing${pendingShowings > 1 ? 's' : ''}`, reason: `${pendingShowings} showing request${pendingShowings > 1 ? 's' : ''} waiting on confirmation` };

  if (recentLogins >= 3 && !has1003)
    return { action: 'Send pre-app link now', reason: `${contact.first_name} logged into portal ${recentLogins}x in last 3 days but hasn't started a 1003 — high intent signal` };

  if (hasListing && !has1003)
    return { action: 'Follow up on listings + pre-approval', reason: 'Receiving listing alerts but no application started — ready to convert' };

  if (!hasDrip)
    return { action: 'Enroll in drip campaign', reason: 'Not enrolled in any nurture sequence — risk of going cold' };

  if (lastContactMs > 7 * day)
    return { action: 'Send a check-in text', reason: `No contact in ${Math.floor(lastContactMs / day)} days — re-engage before going cold` };

  if (lastContactMs > 3 * day)
    return { action: 'Schedule a call', reason: 'Good engagement recently — strike while warm' };

  return { action: 'Review activity and follow up', reason: 'Active lead — keep momentum going' };
}

// ── AI summary via Claude ─────────────────────────────────────────────────────
async function generateAiSummary(contact: any, data: any, temp: any, nextAction: any): Promise<string> {
  if (!ANTHROPIC_KEY) return buildFallbackSummary(contact, data, temp, nextAction);

  const recentActivity = (data.activity || []).slice(0, 15).map((a: any) =>
    `${new Date(a.created_at).toLocaleDateString()} — ${a.type}: ${a.title}`
  ).join('\n');

  const prompt = `You are a mortgage loan officer assistant. Write a 2-3 sentence briefing about this lead for Rene Duarte (MLO) to read before contacting them. Be specific, use numbers, sound professional but conversational. Do NOT use bullet points.

Lead: ${contact.first_name} ${contact.last_name}, ${contact.email}, ${contact.phone || 'no phone'}
Lead score: ${temp.score}/100 (${temp.label.toUpperCase()})
SMS sent: ${data.sms?.length || 0} | Emails: ${data.emails?.length || 0} | Showings: ${data.showings?.length || 0} | Portal logins (7d): ${(data.activity||[]).filter((a:any)=>a.type==='page_view'&&Date.now()-new Date(a.created_at).getTime()<604800000).length}
Next action recommended: ${nextAction.action}

Recent activity:
${recentActivity}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const d = await res.json();
    return d.content?.[0]?.text || buildFallbackSummary(contact, data, temp, nextAction);
  } catch (e) {
    return buildFallbackSummary(contact, data, temp, nextAction);
  }
}

function buildFallbackSummary(contact: any, data: any, temp: any, nextAction: any): string {
  const logins7d = (data.activity||[]).filter((a:any)=>a.type==='page_view'&&Date.now()-new Date(a.created_at).getTime()<604800000).length;
  return `${contact.first_name} is a ${temp.label.toUpperCase()} lead (score ${temp.score}/100) with ${data.sms?.length||0} SMS sent, ${data.showings?.length||0} showings scheduled, and ${logins7d} portal login${logins7d!==1?'s':''} in the last 7 days. Recommended next step: ${nextAction.action}.`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const url = new URL(req.url);

    // ── Email open tracking pixel ────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname.includes('/pixel')) {
      const pixelId = url.searchParams.get('p');
      if (pixelId) {
        // Find email log entry
        const { data: emailEntry } = await sb.from('email_log')
          .select('id, contact_id, portal_user_id, subject')
          .eq('tracking_pixel_id', pixelId)
          .single();
        if (emailEntry) {
          const now = new Date().toISOString();
          // Record open event
          await sb.from('email_open_events').insert({
            contact_id: emailEntry.contact_id,
            portal_user_id: emailEntry.portal_user_id || null,
            email_log_id: emailEntry.id,
            subject: emailEntry.subject,
            ip_address: req.headers.get('x-forwarded-for') || '',
            user_agent: req.headers.get('user-agent') || ''
          });
          // Update open count on email_log
          await sb.rpc('increment_email_open', { email_id: emailEntry.id }).catch(() => {});
          await sb.from('email_log').update({
            open_count: sb.rpc('increment', { row_id: emailEntry.id }),
            first_opened_at: now,
            last_opened_at: now
          }).eq('id', emailEntry.id).is('first_opened_at', null);
          await sb.from('email_log').update({ last_opened_at: now })
            .eq('id', emailEntry.id);
          // Log to activity_events
          if (emailEntry.contact_id) {
            await sb.from('activity_events').insert({
              contact_id: emailEntry.contact_id,
              type: 'email_open',
              channel: 'email',
              title: `Email opened: ${emailEntry.subject || 'unknown'}`,
              status: 'delivered',
              created_at: now
            });
          }
        }
      }
      // Return 1x1 transparent GIF
      const gif = new Uint8Array([71,73,70,56,57,97,1,0,1,0,128,0,0,255,255,255,0,0,0,33,249,4,0,0,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59]);
      return new Response(gif, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-cache, no-store' } });
    }

    // ── POST: get or refresh intelligence for a contact ──────────────────────
    let body: any = {};
    try { body = await req.json(); } catch(_) {}

    const { contact_id, force_refresh } = body;
    if (!contact_id) return err('contact_id required');

    // Check cache (refresh if >1 hour old or forced)
    if (!force_refresh) {
      const { data: cached } = await sb.from('contact_intelligence')
        .select('*').eq('contact_id', contact_id).single();
      if (cached) {
        const age = Date.now() - new Date(cached.last_calculated_at).getTime();
        if (age < 3600000) return ok({ ...cached, from_cache: true });
      }
    }

    // Fetch all data in parallel
    const [contact, sms, emails, activity, showings, drip, application, emailOpens] = await Promise.all([
      sb.from('contacts').select('*').eq('id', contact_id).single().then(r => r.data),
      sb.from('sms_log').select('*').eq('contact_id', contact_id).order('created_at', { ascending: false }).limit(50).then(r => r.data || []),
      sb.from('email_log').select('*').eq('contact_id', contact_id).order('created_at', { ascending: false }).limit(20).then(r => r.data || []),
      sb.from('activity_events').select('*').eq('contact_id', contact_id).order('created_at', { ascending: false }).limit(50).then(r => r.data || []),
      sb.from('showings').select('*').eq('contact_id', contact_id).order('created_at', { ascending: false }).then(r => r.data || []),
      sb.from('drip_enrollments').select('*').eq('contact_id', contact_id).then(r => r.data || []),
      sb.from('mortgage_applications').select('id,created_at,status').eq('contact_id', contact_id).then(r => r.data || []),
      sb.from('email_open_events').select('*').eq('contact_id', contact_id).order('opened_at', { ascending: false }).limit(20).then(r => r.data || []),
    ]);

    if (!contact) return err('Contact not found', 404);

    const data = { sms, emails, activity, showings, drip, application, emailOpens };
    const temp = calcTemperature(data);
    const nextAction = calcNextAction(data, contact);
    const aiSummary = await generateAiSummary(contact, data, temp, nextAction);

    // Upsert to cache
    const intelligence = {
      contact_id,
      ai_summary: aiSummary,
      next_best_action: nextAction.action,
      action_reason: nextAction.reason,
      temperature: temp.label,
      temperature_score: temp.score,
      last_calculated_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await sb.from('contact_intelligence').upsert(intelligence, { onConflict: 'contact_id' });

    return ok({ ...intelligence, from_cache: false });

  } catch(e: any) {
    console.error('[contact-intelligence]', e);
    return err(e.message || 'Server error', 500);
  }
});

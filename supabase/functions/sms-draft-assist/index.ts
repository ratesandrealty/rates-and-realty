// sms-draft-assist v3 — AI helper that drafts an SMS for the composer.
// Input: { contact_id, instruction? }  (instruction optional. May request a language,
//         e.g. 'follow up in Spanish' -> the drafts MUST be in that language.)
// Pulls contact context + recent SMS thread, asks Claude for 2-3 short draft options.
// Returns { ok, drafts:[...], contact_name }. Does NOT send. verify_jwt=false, CORS-safe.
// v3: honor language requested in the instruction (Spanish etc.).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-region, x-requested-with' };
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok  = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type':'application/json' } });
  const bad = (m: string, detail?: string) => new Response(JSON.stringify({ ok:false, error:m, detail }), { headers: { ...cors, 'Content-Type':'application/json' } });

  try {
    if (!ANTHROPIC_KEY) return bad('AI key not configured');
    const body = await req.json().catch(() => ({}));
    const contactId = body.contact_id;
    const instruction = (body.instruction || '').toString().slice(0, 500);
    const tone = (body.tone || 'warm, professional, concise').toString().slice(0,120);
    if (!contactId) return bad('contact_id required');

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: c, error: cErr } = await sb.from('contacts')
      .select('first_name,last_name,loan_type,loan_purpose,temperature,lead_source,tags,notes')
      .eq('id', contactId).maybeSingle();
    if (cErr) console.error('contact select error:', cErr.message);
    const name = (c ? `${c.first_name||''} ${c.last_name||''}`.trim() : '') || 'there';
    const firstName = (c?.first_name || '').trim();
    const tagsArr = Array.isArray(c?.tags) ? c.tags.map((t:any)=>String(t).toLowerCase()) : [];
    const spanishHint = tagsArr.includes('spanish speaker') || tagsArr.includes('spanish');

    let thread: any[] = [];
    try {
      const { data: t } = await sb.rpc('sms_thread', { p_contact_id: contactId });
      if (Array.isArray(t)) thread = t.slice(-10);
    } catch (_e) { /* thread optional */ }

    const convo = thread.map((m: any) => {
      const who = (m.direction === 'inbound' || m.dir === 'in') ? 'Lead' : 'Rene';
      const txt = (m.body || m.message || '').toString().slice(0, 200);
      return txt ? `${who}: ${txt}` : '';
    }).filter(Boolean).join('\n');

    const ctx = [
      firstName ? `First name: ${firstName}` : '',
      c?.loan_purpose ? `Loan purpose: ${c.loan_purpose}` : '',
      c?.loan_type ? `Loan type: ${c.loan_type}` : '',
      c?.temperature ? `Lead temperature: ${c.temperature}` : '',
      c?.lead_source ? `Lead source: ${c.lead_source}` : '',
      tagsArr.length ? `Tags: ${tagsArr.join(', ')}` : '',
      c?.notes ? `Notes: ${String(c.notes).slice(0,300)}` : '',
    ].filter(Boolean).join('\n');

    const sys = `You are Rene Duarte, a warm, professional mortgage loan officer at Rates & Realty, drafting an SMS text to a lead. Rules:
- LANGUAGE: If the draft request specifies a language (e.g. "in Spanish", "en español"), write the ENTIRE draft in that language. Otherwise write in English${spanishHint ? ' (NOTE: this lead is tagged as a Spanish speaker — if the request does not specify a language, still default to English unless asked, but Spanish is likely welcome)' : ''}. Match the language of the request precisely.
- Tone: ${tone}. Sound like a real person, not a template. No emojis unless natural.
- Keep it SHORT — ideally under 300 characters, SMS-appropriate. One clear ask or point.
- Address the lead by first name when known${firstName ? ` (their first name is ${firstName})` : ''}. Sign off as "- Rene" only if it reads naturally.
- Never invent facts (rates, numbers, approvals) not present in the context.
- If there's a prior conversation, make the draft a natural continuation.
Return ONLY a JSON array of 2-3 distinct draft strings (different angles/wordings), no markdown, no keys — e.g. ["draft one", "draft two"]. If a language was requested, ALL drafts must be in that language.`;

    const user = `LEAD CONTEXT:\n${ctx || '(minimal context)'}\n\nRECENT CONVERSATION:\n${convo || '(no prior messages)'}\n\nDRAFT REQUEST: ${instruction || 'Write a helpful, natural follow-up text to re-engage or move this lead forward based on the context and conversation.'}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version':'2023-06-01', 'content-type':'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 900,
        system: sys,
        messages: [{ role:'user', content: user }]
      })
    });
    if (!res.ok) { const t = await res.text(); console.error('Claude error:', t); return bad('AI request failed', t.slice(0,300)); }
    const out = await res.json();
    const text = out?.content?.find((b: any)=>b.type==='text')?.text || out?.content?.[0]?.text || '[]';
    let drafts: string[] = [];
    try {
      const parsed = JSON.parse(text.replace(/```json|```/g,'').trim());
      if (Array.isArray(parsed)) drafts = parsed.map((s:any)=>String(s).trim()).filter(Boolean).slice(0,3);
    } catch (_e) {
      const t = text.replace(/```json|```/g,'').trim();
      if (t) drafts = [t.slice(0, 600)];
    }
    if (!drafts.length) return bad('No draft produced — try again or add an instruction.');
    return ok({ ok:true, drafts, contact_name: name });
  } catch (e: any) {
    console.error('sms-draft-assist error:', e);
    return bad(e?.message || 'Server error');
  }
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey,x-client-info' };
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY');

function stripMarkdownFences(text: string): string {
  return (text || '')
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

// ── SEND EMAIL via MailerSend ────────────────────────────────────────────────
async function sendEmail(p: {to:string;from?:string;subject:string;html:string;cc?:string;replyTo?:string}) {
  const MAILERSEND_KEY = Deno.env.get('MAILERSEND_API_KEY');
  if (!MAILERSEND_KEY) return { sent: false, error: 'MAILERSEND_API_KEY not set' };
  const body: any = {
    from: { email: p.from || 'rene@ratesandrealty.com', name: 'Rene Duarte' },
    to: [{ email: p.to }],
    subject: p.subject,
    html: p.html,
    text: p.html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g,' ').trim()
  };
  if (p.cc) body.cc = [{ email: p.cc }];
  if (p.replyTo) body.reply_to = { email: p.replyTo };
  try {
    const res = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + MAILERSEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (res.ok) return { sent: true, message_id: res.headers.get('x-message-id') || null };
    return { sent: false, error: text };
  } catch(e: any) { return { sent: false, error: e.message }; }
}

// ── AI COMPOSE EMAIL ─────────────────────────────────────────────────────────
async function aiComposeEmail(prompt: string, contactName: string): Promise<string> {
  if (!ANTHROPIC_KEY) return '';
  const system = 'You are Rene Duarte, a licensed mortgage loan officer at Rates & Realty (NMLS #1795044) in Huntington Beach, CA. Write a professional, warm email. Use proper HTML formatting with <p>, <br>, <strong>, <ul>, <li> tags as needed. Sign off with your full name and title. Return ONLY the HTML email body — no subject line, no explanation, no markdown code fences, no backticks, no ```html wrappers. Start directly with HTML tags.';
  const user = (prompt || 'Write a professional follow-up email') + (contactName ? ` The recipient is ${contactName}.` : '');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 800, messages: [{ role: 'user', content: system + '\n\n' + user }] })
  });
  const data = await res.json();
  const rawText = data.content?.[0]?.text?.trim() || '';
  return stripMarkdownFences(rawText);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const { action } = body;

    // ── SEND ──────────────────────────────────────────────────────────────────
    if (action === 'send') {
      const { to_email, subject, cc, contact_id, crm_id } = body;
      const html = stripMarkdownFences(body.html || '');
      if (!to_email || !subject || !html) return err('to_email, subject, html required');

      const result = await sendEmail({ to: to_email, subject, html, cc });

      // Log to email_log
      const { data: emailLog } = await sb.from('email_log').insert({
        contact_id: contact_id || null,
        direction: 'outbound',
        from_email: 'rene@ratesandrealty.com',
        to_email,
        cc_email: cc || null,
        subject,
        body_html: html,
        status: result.sent ? 'sent' : 'failed',
        created_at: new Date().toISOString()
      }).select('id').single();

      // Log to activity_events
      if (contact_id) {
        await sb.from('activity_events').insert({
          contact_id,
          crm_id: crm_id || null,
          type: 'email',
          channel: 'email',
          direction: 'outbound',
          title: `Email sent: ${subject}`,
          description: html.replace(/<[^>]*>/g,'').substring(0, 200),
          email_subject: subject,
          email_to: to_email,
          email_from: 'rene@ratesandrealty.com',
          email_html: html,
          email_cc: cc || null,
          status: result.sent ? 'sent' : 'failed',
          metadata: JSON.stringify({ message_id: result.message_id, error: result.error }),
          created_at: new Date().toISOString()
        });
        // Update last contact date
        await sb.from('contacts').update({ last_contact_date: new Date().toISOString() }).eq('id', contact_id);
      }

      return ok({ success: result.sent, message_id: result.message_id, error: result.error });
    }

    // ── SAVE DRAFT / SCHEDULE ────────────────────────────────────────────────
    if (action === 'save_draft') {
      const { contact_id, to, subject, scheduled_at, status } = body;
      const cleanHtml = stripMarkdownFences(body.body_html || '');
      const cleanText = stripMarkdownFences(body.body_text || '');

      const toArray = Array.isArray(to) ? to : (to ? [to] : []);
      const insertData: Record<string, any> = {
        contact_id: contact_id || null,
        direction: 'outbound',
        from_email: 'rene@ratesandrealty.com',
        to_email: toArray[0] || null,
        to_emails: toArray,
        subject: subject || '',
        body_html: cleanHtml,
        body_text: cleanText,
        status: status || 'draft',
        scheduled_at: scheduled_at || null,
        created_at: new Date().toISOString(),
      };

      const { data: saved, error: insertErr } = await sb
        .from('email_log')
        .insert(insertData)
        .select('id')
        .single();

      if (insertErr) {
        console.error('save_draft insert error:', insertErr);
        return err(insertErr.message, 400);
      }

      return ok({ success: true, id: saved?.id });
    }

    // ── AI COMPOSE ────────────────────────────────────────────────────────────
    if (action === 'ai_compose') {
      const { prompt, contact_name } = body;
      const html = await aiComposeEmail(prompt || '', contact_name || '');
      return ok({ success: true, html });
    }

    // ── GET EMAIL HISTORY ─────────────────────────────────────────────────────
    if (action === 'get_history') {
      const { contact_id, limit = 30 } = body;
      if (!contact_id) return err('contact_id required');
      const { data } = await sb.from('email_log')
        .select('*')
        .eq('contact_id', contact_id)
        .order('created_at', { ascending: false })
        .limit(limit);
      return ok({ emails: data || [] });
    }

    return err('Unknown action');
  } catch(e: any) {
    console.error('email-service error:', e);
    return err(e.message || 'Server error', 500);
  }
});

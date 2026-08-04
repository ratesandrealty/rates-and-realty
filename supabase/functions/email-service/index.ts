// email-service v56: unsubscribe link -> public ratesandrealty.com/unsubscribe (leads click it,
//   so it lives on the public site, NOT admin/beta). guessLinkLabel still recognizes the domain.
//   v55: correct email_from in activity log; from_name derived; reply_to comma-list takes first.
//   v54: htmlToText readable activity descriptions. v53: attachments. bcc supported.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey,x-client-info' };
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY');

const TRACK_BASE = `${SUPABASE_URL}/functions/v1/track-event`;

function htmlToText(html: string): string {
  if (!html) return '';
  let t = html
    .replace(/<\s*(head|style|script)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, '\n')
    .replace(/<\s*(td|th)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, '\u2014')
    .replace(/&rsquo;/gi, '\u2019')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t;
}

function summarize(html: string, max = 220): string {
  const t = htmlToText(html).replace(/\n+/g, ' \u00b7 ');
  return t.length > max ? t.slice(0, max - 1).trim() + '\u2026' : t;
}

function stripMarkdownFences(text: string): string {
  return (text || '')
    .replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

function parseEmailList(raw: any): Array<{email: string}> | undefined {
  if (!raw) return undefined;
  let list: string[] = [];
  if (Array.isArray(raw)) { list = raw; }
  else if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); list = Array.isArray(p) ? p : [p]; }
    catch { list = raw.split(',').map((e: string) => e.trim()); }
  }
  const valid = list.map((e: any) => typeof e === 'object' && e?.email ? e.email : String(e)).filter((e: string) => e && e.includes('@') && e.length > 3);
  return valid.length > 0 ? valid.map((e: string) => ({ email: e.trim() })) : undefined;
}

function parseAttachments(raw: any): Array<{content:string;filename:string;disposition:string}> | undefined {
  if (!raw) return undefined;
  let arr: any[] = Array.isArray(raw) ? raw : [raw];
  const out: Array<{content:string;filename:string;disposition:string}> = [];
  for (const a of arr) {
    if (!a) continue;
    let content = a.content ?? a.base64 ?? a.pdf ?? a.data ?? '';
    if (typeof content !== 'string' || content.length < 10) continue;
    const comma = content.indexOf(',');
    if (content.startsWith('data:') && comma !== -1) content = content.slice(comma + 1);
    const filename = (a.filename || a.name || 'attachment.pdf').toString();
    out.push({ content, filename, disposition: (a.disposition || 'attachment').toString() });
  }
  return out.length ? out : undefined;
}

async function loadProcessingVars(contactId: string): Promise<any | null> {
  try {
    const { data: c } = await sb.from('contacts')
      .select('first_name,last_name,date_of_birth,property_address,purchase_price')
      .eq('id', contactId).maybeSingle();
    if (!c) return null;
    const { data: cob } = await sb.from('contacts')
      .select('first_name,last_name,date_of_birth')
      .eq('primary_borrower_contact_id', contactId);
    const fmtName = (p: any) => [p?.first_name, p?.last_name].filter(Boolean).join(' ').trim();
    const fmtDob = (d: any) => {
      if (!d) return null;
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return null;
      return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}/${dt.getUTCFullYear()}`;
    };
    const people = [c, ...((cob as any[]) || [])];
    const names = people.map(fmtName).filter(Boolean);
    const dobs = people.map((p: any) => fmtDob(p.date_of_birth)).filter(Boolean);
    const price = (c.purchase_price !== null && c.purchase_price !== undefined && c.purchase_price !== '')
      ? '$' + Number(c.purchase_price).toLocaleString('en-US')
      : '';
    return {
      borrower_name: fmtName(c),
      borrowers: names.join(' and '),
      birthdates: dobs.join(', '),
      property_address: c.property_address || '',
      purchase_price: price,
    };
  } catch (e) {
    console.warn('loadProcessingVars failed', e);
    return null;
  }
}

function renderMergeTags(text: string, recipient: any, settings: any = {}, proc: any = null): string {
  if (!text) return text;
  const unsub = `https://ratesandrealty.com/unsubscribe?email=${encodeURIComponent(recipient.email || "")}`;
  let out = text
    .replace(/\{\{\s*first_name\s*\}\}/gi, recipient.first_name || "there")
    .replace(/\{\{\s*last_name\s*\}\}/gi, recipient.last_name || "")
    .replace(/\{\{\s*hoi_first_name\s*\}\}/gi, recipient.first_name || "there")
    .replace(/\{\{\s*property_city\s*\}\}/gi, recipient.city || recipient.property_city || "your area")
    .replace(/\{\{\s*loan_type\s*\}\}/gi, recipient.loan_type || "mortgage")
    .replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, unsub)
    .replace(/\{\{\s*booking_url\s*\}\}/gi, settings.booking_url || "https://cal.com/rene-duarte-rates-realty")
    .replace(/\{\{\s*booking_intro\s*\}\}/gi, settings.booking_url_intro || settings.booking_url || "https://cal.com/rene-duarte-rates-realty")
    .replace(/\{\{\s*booking_strategy\s*\}\}/gi, settings.booking_url_strategy || settings.booking_url || "https://cal.com/rene-duarte-rates-realty")
    .replace(/\{\{\s*booking_application\s*\}\}/gi, settings.booking_url_application || settings.booking_url || "https://cal.com/rene-duarte-rates-realty")
    .replace(/\{\{\s*signature_phone\s*\}\}/gi, settings.signature_phone || "714-472-8508")
    .replace(/\{\{\s*signature_email\s*\}\}/gi, settings.signature_email || "rene@ratesandrealty.com");
  if (proc) {
    out = out
      .replace(/\{\{\s*borrower_name\s*\}\}/gi, proc.borrower_name || "")
      .replace(/\{\{\s*borrowers\s*\}\}/gi, proc.borrowers || proc.borrower_name || "")
      .replace(/\{\{\s*birthdates\s*\}\}/gi, proc.birthdates || "")
      .replace(/\{\{\s*property_address\s*\}\}/gi, proc.property_address || "")
      .replace(/\{\{\s*purchase_price\s*\}\}/gi, proc.purchase_price || "");
  }
  return out;
}

async function getSettings() {
  const { data } = await sb.from('email_settings').select('*').eq('lo_id', 'rene').maybeSingle();
  return data || {};
}

function shortId(len = 8): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = ""; for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function guessLinkLabel(url: string): string {
  const u = url.toLowerCase();
  if (u.includes('cal.com')) return 'book_call';
  if (u.includes('search-homes') || u.includes('/listing')) return 'property_search';
  if (u.includes('calc')) return 'calculator';
  if (u.includes('unsubscribe')) return 'unsubscribe';
  if (u.includes('ratesandrealty.com')) return 'website';
  return 'link';
}

async function injectTracking(html: string, emailLogId: string, contactId: string | null): Promise<string> {
  if (!html) return html;

  const linkRegex = /<a\s+([^>]*?)href=(["'])([^"']+)\2([^>]*)>/gi;
  const matches = Array.from(html.matchAll(linkRegex));
  const replacements = new Map<string, string>();

  for (const m of matches) {
    const original = m[3];
    if (
      original.startsWith('mailto:') ||
      original.startsWith('tel:') ||
      original.startsWith('#') ||
      original.includes('/unsubscribe') ||
      original.includes('/track-event/')
    ) continue;
    if (replacements.has(original)) continue;

    const id = shortId(8);
    try {
      await sb.from("tracked_links").insert({
        id,
        destination_url: original,
        contact_id: contactId,
        source: "email",
        source_id: emailLogId,
        label: guessLinkLabel(original),
      });
      replacements.set(original, `${TRACK_BASE}/click/${id}`);
    } catch (e) {
      console.warn('tracked_links insert failed for', original, e);
    }
  }

  let out = html.replace(linkRegex, (whole, before, q, href, after) => {
    const replaced = replacements.get(href);
    return replaced ? `<a ${before}href=${q}${replaced}${q}${after}>` : whole;
  });

  const pixel = `<img src="${TRACK_BASE}/pixel?e=${emailLogId}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`;
  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${pixel}</body>`);
  } else {
    out = out + pixel;
  }
  return out;
}

async function sendEmail(p: {to:string;from?:string;fromName?:string;subject:string;html:string;cc?:any;bcc?:any;replyTo?:string;attachments?:any}) {
  const MAILERSEND_KEY = Deno.env.get('MAILERSEND_API_KEY');
  if (!MAILERSEND_KEY) return { sent: false, error: 'MAILERSEND_API_KEY not set' };
  const payload: any = {
    from: { email: p.from || 'rene@ratesandrealty.com', name: p.fromName || 'Rene Duarte' },
    to: [{ email: p.to }],
    subject: p.subject,
    html: p.html,
    text: htmlToText(p.html)
  };
  const ccList = parseEmailList(p.cc);
  const bccList = parseEmailList(p.bcc);
  if (ccList) payload.cc = ccList;
  if (bccList) payload.bcc = bccList;
  const attachList = parseAttachments(p.attachments);
  if (attachList) payload.attachments = attachList;
  if (p.replyTo && p.replyTo.includes('@')) {
    const firstReply = p.replyTo.split(',')[0].trim();
    payload.reply_to = { email: firstReply };
  }
  try {
    const res = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + MAILERSEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    if (res.ok) return { sent: true, message_id: res.headers.get('x-message-id') || null };
    return { sent: false, error: text };
  } catch(e: any) { return { sent: false, error: e.message }; }
}

async function aiComposeEmail(prompt: string, contactName: string): Promise<string> {
  if (!ANTHROPIC_KEY) return '';
  const system = 'You are Rene Duarte, a licensed mortgage loan officer at Rates & Realty (NMLS #1795044) in Huntington Beach, CA. Write a professional, warm email. Use proper HTML formatting with <p>, <br>, <strong>, <ul>, <li> tags as needed. Sign off with your full name and title. Return ONLY the HTML email body \u2014 no subject line, no explanation, no markdown code fences, no backticks, no ```html wrappers. Start directly with HTML tags.';
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

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const rawAction = (body.action || body.type || body.mode || '').toString().toLowerCase();
    const action = ({
      'send_blast': 'bulk_send', 'send_bulk': 'bulk_send', 'mass_send': 'bulk_send',
      'send_to_all': 'bulk_send', 'send_marketing': 'bulk_send', 'send_now': 'bulk_send',
      'broadcast': 'bulk_send', 'send_campaign': 'bulk_send', 'send_immediately': 'bulk_send',
      'send_email': 'send', 'send_one': 'send', 'compose': 'ai_compose', 'draft': 'save_draft',
      'history': 'get_history', 'schedule': 'bulk_schedule', 'schedule_blast': 'bulk_schedule',
      'schedule_send': 'bulk_schedule', 'settings': 'get_settings',
    } as Record<string, string>)[rawAction] || rawAction;

    if (action === 'get_settings') {
      const settings = await getSettings();
      return ok({
        success: true,
        booking_url: settings.booking_url, booking_url_intro: settings.booking_url_intro,
        booking_url_strategy: settings.booking_url_strategy, booking_url_application: settings.booking_url_application,
        booking_provider: settings.booking_provider, signature_name: settings.signature_name,
        signature_title: settings.signature_title, signature_phone: settings.signature_phone,
        signature_email: settings.signature_email, signature_nmls: settings.signature_nmls,
        signature_dre: settings.signature_dre, signature_website: settings.signature_website,
        signature_html: settings.signature_custom_html, default_from: settings.default_from,
        merge_tags_available: [
          { tag: '{{first_name}}', desc: 'Recipient first name' },
          { tag: '{{last_name}}', desc: 'Recipient last name' },
          { tag: '{{property_city}}', desc: 'Their city' },
          { tag: '{{loan_type}}', desc: 'Their loan type (FHA/VA/etc)' },
          { tag: '{{booking_url}}', desc: 'General Cal.com link' },
          { tag: '{{booking_intro}}', desc: '15-min intro call link' },
          { tag: '{{booking_strategy}}', desc: '30-min strategy call link' },
          { tag: '{{booking_application}}', desc: '60-min application call link' },
          { tag: '{{signature_phone}}', desc: 'Your phone' },
          { tag: '{{signature_email}}', desc: 'Your email' },
          { tag: '{{unsubscribe_url}}', desc: 'Unsubscribe link' },
          { tag: '{{borrower_name}}', desc: 'Primary borrower full name (processing)' },
          { tag: '{{borrowers}}', desc: 'All borrowers, e.g. "A and B" (processing)' },
          { tag: '{{birthdates}}', desc: 'Borrower birth dates (processing)' },
          { tag: '{{property_address}}', desc: 'Subject property address (processing)' },
          { tag: '{{purchase_price}}', desc: 'Purchase price (processing)' },
          { tag: '{{hoi_first_name}}', desc: 'Recipient (HOI agent) first name' },
        ],
      });
    }

    if (action === 'send') {
      const settings = await getSettings();
      const { subject: rawSubject, contact_id, crm_id } = body;
      const ccRaw = body.cc_email || body.cc;
      const bccRaw = body.bcc_email || body.bcc;
      const attachmentsRaw = body.attachments || body.attachment;
      const toEmail = body.to_email || (Array.isArray(body.to) ? body.to[0] : body.to) || (Array.isArray(body.to_emails) ? body.to_emails[0] : null);
      const rawHtml = stripMarkdownFences(body.html || body.body_html || '');
      if (!toEmail || !rawSubject || !rawHtml) return err('to_email, subject, html required');

      const fromEmail = body.from_email || body.from || 'rene@ratesandrealty.com';
      const fromName = body.from_name || (fromEmail.startsWith('processing@') ? 'Rates & Realty Processing' : 'Rene Duarte');

      const toName = body.to_name || '';
      const [firstFromName, ...lastParts] = toName.split(' ');
      const recipient = {
        email: toEmail,
        first_name: body.first_name || firstFromName || '',
        last_name: body.last_name || lastParts.join(' ') || '',
      };
      const proc = contact_id ? await loadProcessingVars(contact_id) : null;
      const subject = renderMergeTags(rawSubject, recipient, settings, proc);
      const mergedHtml = renderMergeTags(rawHtml, recipient, settings, proc);

      const ccParsed = parseEmailList(ccRaw);
      const ccForDb = ccParsed ? ccParsed.map((c: {email:string}) => c.email).join(',') : null;
      const attachList = parseAttachments(attachmentsRaw);
      const { data: logRow } = await sb.from('email_log').insert({
        contact_id: contact_id || null,
        direction: 'outbound',
        from_email: fromEmail,
        to_email: toEmail, cc_email: ccForDb,
        subject, body_html: mergedHtml,
        status: 'pending',
        created_at: new Date().toISOString()
      }).select('id').single();

      const trackedHtml = await injectTracking(mergedHtml, logRow!.id, contact_id || null);

      const result = await sendEmail({ to: toEmail, from: fromEmail, fromName, subject, html: trackedHtml, cc: ccRaw, bcc: bccRaw, attachments: attachmentsRaw, replyTo: body.reply_to });

      await sb.from('email_log').update({
        body_html: trackedHtml,
        status: result.sent ? 'sent' : 'failed',
        sent_at: result.sent ? new Date().toISOString() : null,
      }).eq('id', logRow!.id);

      if (contact_id) {
        const attachNames = attachList ? attachList.map(a => a.filename).join(', ') : null;
        const desc = (typeof body.activity_summary === 'string' && body.activity_summary.trim())
          ? body.activity_summary.trim().slice(0, 240)
          : summarize(mergedHtml, 240);
        await sb.from('activity_events').insert({
          contact_id, crm_id: crm_id || null,
          type: 'email', channel: 'email', direction: 'outbound',
          title: body.activity_title || `Email sent: ${subject}`,
          description: desc,
          email_subject: subject, email_to: toEmail, email_from: fromEmail,
          email_body_html: trackedHtml, email_cc: ccForDb,
          status: result.sent ? 'sent' : 'failed',
          metadata: JSON.stringify({ message_id: result.message_id, error: result.error, email_log_id: logRow!.id, tracked: true, attachments: attachNames, from: fromEmail }),
          created_at: new Date().toISOString()
        });
        await sb.from('contacts').update({ last_contact_date: new Date().toISOString() }).eq('id', contact_id);
      }

      return ok({ success: result.sent, message_id: result.message_id, error: result.error, rendered_subject: subject, email_log_id: logRow!.id, attached: attachList ? attachList.length : 0 });
    }

    if (action === 'bulk_send') {
      const settings = await getSettings();
      const subject = body.subject;
      const html = stripMarkdownFences(body.html || body.body_html || '');
      let recipients: any[] = [];
      if (Array.isArray(body.recipients)) recipients = body.recipients;
      else if (Array.isArray(body.contact_ids)) {
        const { data } = await sb.from('contacts')
          .select('id, first_name, last_name, email, phone, city, loan_type')
          .in('id', body.contact_ids);
        recipients = (data || []).filter((c: any) => c.email);
      } else if (Array.isArray(body.to_emails)) {
        recipients = body.to_emails.map((e: any) => typeof e === 'string' ? { email: e } : e);
      } else if (body.to_email) recipients = [{ email: body.to_email }];

      if (!recipients.length) return err('No recipients provided');
      if (!subject || !html) return err('subject and html required');

      let sent = 0, failed = 0;
      const errors: any[] = [];
      const results: any[] = [];
      for (const r of recipients) {
        const toEmail = r.email || r.to_email;
        if (!toEmail || !toEmail.includes('@')) { failed++; errors.push({ to: toEmail, error: 'invalid email' }); continue; }

        const personalizedSubject = renderMergeTags(subject, r, settings);
        const personalizedHtml = renderMergeTags(html, r, settings);
        const cid = r.id || r.contact_id || null;

        const { data: logRow } = await sb.from('email_log').insert({
          contact_id: cid, direction: 'outbound',
          from_email: 'rene@ratesandrealty.com', to_email: toEmail,
          to_name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
          subject: personalizedSubject, body_html: personalizedHtml,
          status: 'pending', template: 'email_marketing_bulk',
          created_at: new Date().toISOString()
        }).select('id').single();

        const trackedHtml = await injectTracking(personalizedHtml, logRow!.id, cid);
        const result = await sendEmail({ to: toEmail, subject: personalizedSubject, html: trackedHtml });

        await sb.from('email_log').update({
          body_html: trackedHtml,
          status: result.sent ? 'sent' : 'failed',
          sent_at: result.sent ? new Date().toISOString() : null,
        }).eq('id', logRow!.id);

        if (cid) {
          await sb.from('activity_events').insert({
            contact_id: cid, type: 'email', channel: 'email', direction: 'outbound',
            title: `Marketing email: ${personalizedSubject}`,
            description: summarize(personalizedHtml, 240),
            email_subject: personalizedSubject, email_to: toEmail,
            email_from: 'rene@ratesandrealty.com', email_body_html: trackedHtml,
            status: result.sent ? 'sent' : 'failed',
            metadata: JSON.stringify({ message_id: result.message_id, bulk: true, email_log_id: logRow!.id, tracked: true }),
            created_at: new Date().toISOString()
          /* .then(ok, err), not .catch(). A PostgrestFilterBuilder is a thenable,
           * not a Promise: it defines then() and no catch(), so `.catch(...)`
           * threw "sb.from(...).insert(...).catch is not a function" — and threw
           * on the BUILDER, before the insert was ever executed. bulk_send has
           * therefore never completed a run: email_log held exactly 1
           * email_marketing_bulk row (2026-05-02) and no activity_events row
           * carried bulk:true until this fix was verified on 2026-08-04.
           * Note when checking that yourself: metadata is JSON.stringify'd into a
           * jsonb column, so it stores as a jsonb STRING scalar and the quotes are
           * escaped. `metadata::text ilike '%"bulk":true%'` silently matches
           * nothing; unwrap with `metadata #>> '{}'` first.
           * The send and the email_log update happen before this line, so a
           * campaign mailed recipients up to the first contact-matched one and
           * then returned 500 with no counts. */
          }).then(() => {}, () => {});
        }

        if (result.sent) sent++; else { failed++; errors.push({ to: toEmail, error: result.error }); }
        results.push({ to: toEmail, sent: result.sent, error: result.error });
        await sleep(150);
      }

      return ok({ success: failed === 0, sent, failed, total: recipients.length, errors: errors.slice(0, 10), results });
    }

    if (action === 'bulk_schedule') {
      const settings = await getSettings();
      const subject = body.subject;
      const html = stripMarkdownFences(body.html || body.body_html || '');
      const scheduledAt = body.scheduled_at || body.send_at;
      if (!scheduledAt) return err('scheduled_at required (ISO 8601 timestamp)');
      const scheduledDate = new Date(scheduledAt);
      if (isNaN(scheduledDate.getTime())) return err('invalid scheduled_at format');
      if (scheduledDate.getTime() < Date.now() - 60000) return err('scheduled_at must be in the future');

      let recipients: any[] = [];
      if (Array.isArray(body.recipients)) recipients = body.recipients;
      else if (Array.isArray(body.contact_ids)) {
        const { data } = await sb.from('contacts')
          .select('id, first_name, last_name, email, phone, city, loan_type')
          .in('id', body.contact_ids);
        recipients = (data || []).filter((c: any) => c.email);
      } else if (Array.isArray(body.to_emails)) {
        recipients = body.to_emails.map((e: any) => typeof e === 'string' ? { email: e } : e);
      }

      if (!recipients.length) return err('No recipients provided');
      if (!subject || !html) return err('subject and html required');

      let queued = 0;
      for (const r of recipients) {
        const toEmail = r.email || r.to_email;
        if (!toEmail || !toEmail.includes('@')) continue;
        const personalizedSubject = renderMergeTags(subject, r, settings);
        const personalizedHtml = renderMergeTags(html, r, settings);
        const { error: insErr } = await sb.from('email_log').insert({
          contact_id: r.id || r.contact_id || null,
          direction: 'outbound',
          from_email: 'rene@ratesandrealty.com',
          to_email: toEmail,
          to_name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
          subject: personalizedSubject,
          body_html: personalizedHtml,
          status: 'scheduled',
          template: 'email_marketing_scheduled',
          scheduled_at: scheduledDate.toISOString(),
          created_at: new Date().toISOString()
        });
        if (!insErr) queued++;
      }

      return ok({ success: true, queued, total: recipients.length, scheduled_at: scheduledDate.toISOString() });
    }

    if (action === 'save_draft') {
      const { contact_id, to, subject, scheduled_at, status } = body;
      const cleanHtml = stripMarkdownFences(body.body_html || body.html || '');
      const cleanText = stripMarkdownFences(body.body_text || '');
      const toArray = Array.isArray(to) ? to : (to ? [to] : []);
      const { data: saved, error: insertErr } = await sb.from('email_log').insert({
        contact_id: contact_id || null, direction: 'outbound',
        from_email: 'rene@ratesandrealty.com',
        to_email: toArray[0] || null, to_emails: toArray,
        subject: subject || '', body_html: cleanHtml, body_text: cleanText,
        status: status || 'draft', scheduled_at: scheduled_at || null,
        created_at: new Date().toISOString(),
      }).select('id').single();
      if (insertErr) return err(insertErr.message, 400);
      return ok({ success: true, id: saved?.id });
    }

    if (action === 'ai_compose') {
      const { prompt, contact_name } = body;
      const html = await aiComposeEmail(prompt || '', contact_name || '');
      return ok({ success: true, html });
    }

    if (action === 'get_history') {
      const { contact_id, limit = 30 } = body;
      if (!contact_id) return err('contact_id required');
      const { data } = await sb.from('email_log').select('*').eq('contact_id', contact_id).order('created_at', { ascending: false }).limit(limit);
      return ok({ emails: data || [] });
    }

    if (action === 'send_test') {
      const settings = await getSettings();
      const subject = '[TEST] ' + renderMergeTags(body.subject || 'Test email', { first_name: 'Rene', last_name: 'Duarte', email: 'rene@ratesandrealty.com' }, settings);
      const mergedHtml = renderMergeTags(stripMarkdownFences(body.html || body.body_html || ''), { first_name: 'Rene', last_name: 'Duarte', email: 'rene@ratesandrealty.com', city: 'Huntington Beach', loan_type: 'FHA' }, settings);
      if (!mergedHtml) return err('html required');
      const testTo = body.test_to || 'rene@ratesandrealty.com';
      const { data: logRow } = await sb.from('email_log').insert({
        contact_id: null, direction: 'outbound',
        from_email: 'rene@ratesandrealty.com', to_email: testTo,
        subject, body_html: mergedHtml, status: 'pending', template: 'send_test',
        created_at: new Date().toISOString()
      }).select('id').single();
      const trackedHtml = await injectTracking(mergedHtml, logRow!.id, null);
      const result = await sendEmail({ to: testTo, subject, html: trackedHtml });
      await sb.from('email_log').update({
        body_html: trackedHtml,
        status: result.sent ? 'sent' : 'failed',
        sent_at: result.sent ? new Date().toISOString() : null,
      }).eq('id', logRow!.id);
      return ok({ success: result.sent, message_id: result.message_id, error: result.error, sent_to: testTo, email_log_id: logRow!.id });
    }

    if (action === 'preview') {
      const settings = await getSettings();
      let sample: any = body.sample_recipient || { first_name: 'Sarah', last_name: 'Chen', email: 'sarah@example.com', city: 'Anaheim', loan_type: 'FHA' };
      const procContactId = body.proc_contact_id || (Array.isArray(body.contact_ids) && body.contact_ids.length ? body.contact_ids[0] : null);
      if (!body.sample_recipient && Array.isArray(body.contact_ids) && body.contact_ids.length) {
        const { data } = await sb.from('contacts').select('id, first_name, last_name, email, city, loan_type').eq('id', body.contact_ids[0]).maybeSingle();
        if (data) sample = data;
      }
      const proc = procContactId ? await loadProcessingVars(procContactId) : null;
      return ok({
        success: true, sample, proc,
        rendered_subject: renderMergeTags(body.subject || '', sample, settings, proc),
        rendered_html: renderMergeTags(stripMarkdownFences(body.html || body.body_html || ''), sample, settings, proc),
      });
    }

    return err(`Unknown action: "${rawAction}"`);
  } catch(e: any) {
    console.error('email-service error:', e);
    return err(e.message || 'Server error', 500);
  }
});

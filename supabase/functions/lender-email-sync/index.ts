import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * lender-email-sync
 * 
 * Scans Gmail for emails from/to lenders and:
 * 1. Saves them to lender_emails table in Supabase
 * 2. Posts them as comments on the lender's ClickUp task card
 * 3. Matches by: rep_email, contact_email, email_domains, tracked_emails
 * 
 * Set up cron-job.org to POST to this URL every 15 minutes:
 * https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/lender-email-sync
 */

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey,x-client-info' };
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CLICKUP_TOKEN = Deno.env.get('CLICKUP_API_TOKEN')!;
const sb = createClient(SB_URL, SB_KEY);

// ── Gmail token refresh ──
async function getGmailToken(): Promise<string | null> {
  const { data } = await sb.from('google_calendar_tokens').select('*').eq('id','rene').single();
  if (!data) return null;
  if (new Date(data.expires_at) < new Date()) {
    const CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!;
    const CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({ client_id:CLIENT_ID, client_secret:CLIENT_SECRET, refresh_token:data.refresh_token, grant_type:'refresh_token' })
    });
    const t = await res.json();
    if (t.access_token) {
      await sb.from('google_calendar_tokens').update({ access_token:t.access_token, expires_at: new Date(Date.now()+t.expires_in*1000).toISOString(), updated_at:new Date().toISOString() }).eq('id','rene');
      return t.access_token;
    }
    return null;
  }
  return data.access_token;
}

// ── Fetch Gmail messages ──
async function fetchGmailMessages(token: string, query: string, maxResults = 20): Promise<any[]> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
  const res = await fetch(url, { headers:{ Authorization:`Bearer ${token}` } });
  const data = await res.json();
  return data.messages || [];
}

async function getMessageDetail(token: string, msgId: string): Promise<any> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`, { headers:{ Authorization:`Bearer ${token}` } });
  return res.json();
}

function extractHeader(headers: any[], name: string): string {
  return headers.find((h:any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function extractBody(payload: any): string {
  if (!payload) return '';
  // Try plain text first, then HTML
  const tryDecode = (data: string) => {
    try { return atob(data.replace(/-/g,'+').replace(/_/g,'/')); } catch { return ''; }
  };
  if (payload.body?.data) return tryDecode(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) return tryDecode(part.body.data);
      if (part.parts) {
        for (const sub of part.parts) {
          if (sub.mimeType === 'text/plain' && sub.body?.data) return tryDecode(sub.body.data);
        }
      }
    }
    // Fallback to HTML
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) return tryDecode(part.body.data);
    }
  }
  return '';
}

function categorizeEmail(subject: string, body: string): string {
  const s = (subject + ' ' + body).toLowerCase();
  if (s.includes('rate sheet') || s.includes('rate update') || s.includes('pricing')) return 'rate_sheet';
  if (s.includes('approval') || s.includes('approved') || s.includes('conditional')) return 'approval';
  if (s.includes('condition') || s.includes('pti') || s.includes('suspense') || s.includes('exception')) return 'conditions';
  if (s.includes('promo') || s.includes('special offer') || s.includes('incentive')) return 'promo';
  return 'general';
}

// ── Post comment to ClickUp task ──
async function postClickUpComment(taskId: string, commentText: string): Promise<string | null> {
  if (!CLICKUP_TOKEN || !taskId) return null;
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
    method:'POST',
    headers:{ 'Authorization':CLICKUP_TOKEN, 'Content-Type':'application/json' },
    body: JSON.stringify({ comment_text: commentText, notify_all: false })
  });
  const data = await res.json();
  return data.id || null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null,{status:204,headers:cors});
  const respond = (d:any,s=200) => new Response(JSON.stringify(d),{status:s,headers:{...cors,'Content-Type':'application/json'}});

  try {
    const body = req.method === 'POST' ? await req.json().catch(()=>({})) : {};
    const dryRun = body.dry_run === true;

    // ── Get Gmail token ──
    const token = await getGmailToken();
    if (!token) return respond({ error:'Gmail not authorized. Visit /functions/v1/google-calendar-auth' }, 401);

    // ── Load all lenders with email data ──
    const { data: lenders } = await sb.from('lenders')
      .select('id,name,clickup_task_id,rep_email,contact_email,website,email_domains,tracked_emails')
      .eq('is_active', true)
      .not('clickup_task_id', 'is', null);

    if (!lenders?.length) return respond({ error:'No active lenders with ClickUp task IDs found' });

    // Build domain → lender map
    const domainMap: Record<string, any> = {};
    const emailMap: Record<string, any> = {};

    for (const lender of lenders) {
      // Extract domain from website
      if (lender.website) {
        try {
          const domain = new URL(lender.website.startsWith('http') ? lender.website : 'https://'+lender.website).hostname.replace('www.','');
          domainMap[domain] = lender;
        } catch {}
      }
      // Map specific emails
      for (const email of [lender.rep_email, lender.contact_email, ...(lender.tracked_emails||[])].filter(Boolean)) {
        emailMap[email.toLowerCase()] = lender;
      }
      // Map email_domains array
      for (const d of (lender.email_domains||[])) {
        domainMap[d.toLowerCase()] = lender;
      }
    }

    // ── Search Gmail for lender emails (last 3 days) ──
    const since = Math.floor((Date.now() - 3*24*60*60*1000) / 1000);
    const query = `after:${since} (${Object.keys({...domainMap,...emailMap}).slice(0,20).join(' OR ')})`;
    
    let gmailMessages: any[] = [];
    try {
      gmailMessages = await fetchGmailMessages(token, query, 50);
    } catch(e) {
      console.error('Gmail fetch error:', e);
    }

    const results: any[] = [];
    let newCount = 0;
    let syncedCount = 0;

    for (const msg of gmailMessages) {
      try {
        // Check if already processed
        const { data: existing } = await sb.from('lender_emails').select('id').eq('gmail_message_id', msg.id).maybeSingle();
        if (existing) continue;

        const detail = await getMessageDetail(token, msg.id);
        const headers = detail.payload?.headers || [];
        const from = extractHeader(headers, 'From');
        const to = extractHeader(headers, 'To');
        const subject = extractHeader(headers, 'Subject') || '(no subject)';
        const dateStr = extractHeader(headers, 'Date');
        const threadId = detail.threadId;

        // Extract email addresses
        const fromEmailMatch = from.match(/<(.+?)>/) || from.match(/([\w.+-]+@[\w.-]+\.[a-z]+)/i);
        const fromEmail = fromEmailMatch?.[1]?.toLowerCase() || from.toLowerCase();
        const fromDomain = fromEmail.split('@')[1] || '';
        const fromName = from.replace(/<.*>/, '').replace(/"/g,'').trim() || fromEmail;

        // Match to lender
        let matchedLender = emailMap[fromEmail] || domainMap[fromDomain];
        if (!matchedLender) {
          // Check TO field for outbound
          const toEmailMatch = to.match(/<(.+?)>/) || to.match(/([\w.+-]+@[\w.-]+\.[a-z]+)/i);
          const toEmail = toEmailMatch?.[1]?.toLowerCase() || '';
          const toDomain = toEmail.split('@')[1] || '';
          matchedLender = emailMap[toEmail] || domainMap[toDomain];
        }
        if (!matchedLender) continue;

        const body = extractBody(detail.payload);
        const preview = body.replace(/<[^>]+>/g,'').trim().substring(0, 300);
        const category = categorizeEmail(subject, preview);
        const direction = fromEmail.includes('ratesandrealty') || fromEmail.includes('emortgagecapital') ? 'outbound' : 'inbound';
        const receivedAt = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();

        newCount++;
        results.push({ lender: matchedLender.name, subject, from: fromEmail, category, direction });

        if (dryRun) continue;

        // ── Format ClickUp comment ──
        const categoryEmoji: Record<string,string> = { rate_sheet:'📊', approval:'✅', conditions:'📋', promo:'📣', general:'📧' };
        const dirArrow = direction === 'inbound' ? '⬇️ RECEIVED' : '⬆️ SENT';
        const commentText = [
          `${categoryEmoji[category]} **${dirArrow} — ${category.replace('_',' ').toUpperCase()}**`,
          ``,
          `**Subject:** ${subject}`,
          `**From:** ${fromName} <${fromEmail}>`,
          `**Date:** ${new Date(receivedAt).toLocaleString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'})} PT`,
          ``,
          `**Preview:**`,
          preview.substring(0,500) + (preview.length > 500 ? '...' : ''),
          ``,
          `---`,
          `_Auto-logged by Rates & Realty CRM_`
        ].join('\n');

        // ── Post to ClickUp ──
        let clickupCommentId: string | null = null;
        if (matchedLender.clickup_task_id) {
          clickupCommentId = await postClickUpComment(matchedLender.clickup_task_id, commentText);
          if (clickupCommentId) syncedCount++;
        }

        // ── Save to Supabase ──
        await sb.from('lender_emails').insert({
          lender_id: matchedLender.id,
          lender_name: matchedLender.name,
          clickup_task_id: matchedLender.clickup_task_id,
          gmail_message_id: msg.id,
          gmail_thread_id: threadId,
          subject,
          from_email: fromEmail,
          from_name: fromName,
          to_email: to,
          body_preview: preview,
          received_at: receivedAt,
          direction,
          category,
          clickup_comment_id: clickupCommentId,
          synced_to_clickup: !!clickupCommentId
        });

      } catch(e) {
        console.error('Error processing message:', msg.id, e);
      }
    }

    return respond({
      success: true,
      dry_run: dryRun,
      gmail_messages_checked: gmailMessages.length,
      new_lender_emails: newCount,
      synced_to_clickup: syncedCount,
      lenders_monitored: lenders.length,
      domains_tracked: Object.keys(domainMap).length,
      emails_tracked: Object.keys(emailMap).length,
      sample_results: results.slice(0, 10)
    });

  } catch(e:any) {
    console.error('lender-email-sync error:', e);
    return respond({ error: e.message }, 500);
  }
});

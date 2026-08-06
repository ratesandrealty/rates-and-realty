import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey,x-client-info' };
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID');
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');
const TWILIO_FROM = Deno.env.get('TWILIO_PHONE_NUMBER') || '+17144728508';
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const RENE_PHONE = '7144728508';

function formatPhone(phone: string): string {
  const d = phone.replace(/\D/g,'');
  if (d.startsWith('1') && d.length===11) return `+${d}`;
  if (d.length===10) return `+1${d}`;
  return `+${d}`;
}

/* fromOverride is optional and defaults to TWILIO_FROM, so every existing
 * caller is unchanged. It exists because internal alerts should arrive in the
 * thread Rene already reads (the assistant number) rather than on the public
 * business line borrowers text — see gdrive-health-monitor. */
async function sendTwilioSMS(to: string, body: string, mediaUrl?: string, fromOverride?: string): Promise<{sent:boolean;sid?:string;error?:string}> {
  if (!TWILIO_SID || !TWILIO_TOKEN) return { sent:false, error:'Twilio not configured' };
  try {
    const params: Record<string,string> = {To:formatPhone(to),From:(fromOverride||'').trim()||TWILIO_FROM,Body:body};
    if (mediaUrl) params.MediaUrl = mediaUrl;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,{
      method:'POST',
      headers:{'Authorization':'Basic '+btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams(params)
    });
    const data = await res.json();
    return res.ok && data.sid ? {sent:true,sid:data.sid} : {sent:false,error:data.message||data.code||'Twilio error'};
  } catch(e:any){return{sent:false,error:e.message};}
}

/* WHO ASKED. sms_log had no staff-user column at all before 2026-08-05 — only
 * portal_user_id, which is the BORROWER's portal id, not the sender. 422 rows
 * with no way to tell who sent any of them.
 *
 * Set per request from the caller's JWT; stays null for automations, cron and
 * inbound, which is correct — those have no human behind them. DELIBERATELY
 * OPTIONAL: a send never fails for want of it, so this cannot break the SMS
 * path. Attribution, not a guard.
 *
 * sms-service is still an open relay (docs/PINNED-NOT-GUARDED.md). Resolving
 * the identity here makes a real guard a small change — deliberately NOT made
 * in this pass. */
let _actorUid: string | null = null;

async function callerUid(req:Request): Promise<string|null> {
  const raw = (req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'').trim();
  if (!raw || raw.split('.').length !== 3) return null;
  try {
    // The anon and service keys are well-formed JWTs too; neither has a user.
    const c = JSON.parse(atob(raw.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
    if (!c?.sub || c.role === 'anon' || c.role === 'service_role') return null;
  } catch(_) { return null; }
  try {
    const { data, error } = await sb.auth.getUser(raw);
    return (!error && data?.user?.id) ? data.user.id : null;
  } catch(_) { return null; }
}

async function logSMS(p:{to_phone:string;to_name?:string;body:string;trigger_type:string;trigger_id?:string;contact_id?:string;portal_user_id?:string;borrower_id?:string;twilio_sid?:string;status:string;error_message?:string;media_url?:string}) {
  try { await sb.from('sms_log').insert({...p,actor_user_id:_actorUid,created_at:new Date().toISOString()}); } catch(e){console.error('logSMS:',e);}
}

async function logActivity(p:{contact_id?:string;portal_user_id?:string;crm_id?:string;title:string;description?:string;status:string;sms_body?:string;sms_to?:string;metadata?:any}) {
  try {
    await sb.from('activity_events').insert({
      contact_id:p.contact_id||null,portal_user_id:p.portal_user_id||null,crm_id:p.crm_id||null,
      type:'sms',channel:'sms',direction:'outbound',title:p.title,description:p.description||null,created_by:_actorUid,
      status:p.status,sms_body:p.sms_body||null,sms_to:p.sms_to||null,
      metadata:p.metadata?JSON.stringify(p.metadata):null,created_at:new Date().toISOString()
    });
  } catch(e){console.error('logActivity:',e);}
}

const T: Record<string,(p:any)=>string> = {
  portal_signup: p => `Hi ${p.firstName}! Welcome to Rates & Realty. Your borrower portal is ready at homes.ratesandrealty.com. Your ID: ${p.borrowerId}. Questions? Call/text Rene at (714) 472-8508. Reply STOP to opt out.`,
  showing_request: p => `Hi ${p.firstName}! Got your showing request for ${p.homeCount} home${p.homeCount!==1?'s':''} on ${p.date||'your requested date'}. I'll confirm within a few hours. - Rene (714) 472-8508. Reply STOP to opt out.`,
  showing_confirm: p => `Hi ${p.firstName}! Your home tour is CONFIRMED for ${p.date} at ${p.time}. ${p.homeCount} home${p.homeCount!==1?'s':''} to visit. Check your email for the full route map. - Rene (714) 472-8508. Reply STOP to opt out.`,
  listing_alert_created: p => `Hi ${p.firstName}! Your "${p.alertName}" listing alert is active. I'll text + email you the moment a matching home hits the market. - Rene (714) 472-8508. Reply STOP to opt out.`,
  alert_match: p => `New listing alert! ${p.beds?p.beds+'BD ':''} ${p.baths?p.baths+'BA ':''}in ${p.city}${p.price?' for $'+Number(p.price).toLocaleString():''}. ${p.address||''}. Portal: homes.ratesandrealty.com - Rene (714) 472-8508. Reply STOP to opt out.`,
  reminder: p => `Reminder: Your home tour is TOMORROW ${p.date} at ${p.time}! ${p.homeCount} home${p.homeCount!==1?'s':''} lined up. Reply CONFIRM or call (714) 472-8508. - Rene | Reply STOP to opt out.`,
  custom: p => p.message,
  manual: p => p.message,
};

/* OPT-OUT GATE for every message this function originates.
 *
 * Nothing here consulted contacts.sms_opt_in, so a person who replied STOP still
 * got tour reminders, alert matches and manual customs. It sits inside
 * handleSingleSMS rather than at each call site because that is the single choke
 * point every outbound trigger already passes through — reminders, custom/manual,
 * portal_signup, showing_request, alerts. (Staff alerts to RENE_PHONE call
 * sendTwilioSMS directly and are deliberately not gated: they are to us.)
 *
 * Matches the named contact first, then the last 10 digits — an opt-out belongs
 * to a PERSON, and a call that omits contact_id must not be a way around it.
 * Blocks IS FALSE only: an explicit opt-out, never an absence of recorded consent.
 * A lookup failure blocks rather than sends. */
async function isOptedOut(to_phone:string, contact_id?:string): Promise<boolean> {
  try {
    /* One predicate, shared with sms_schedule / sms_blast / send-scheduled-sms /
     * showing-actions. It covers BOTH lists — contacts.sms_opt_in = false and the
     * contact-independent sms_suppressions table — so a STOP from a number that
     * was never a contact is honoured here too. Keeping the logic in one SQL
     * function is the point: five copies of a phone-matching rule is five chances
     * for one of them to drift. */
    const { data, error } = await sb.rpc('is_phone_suppressed', { p_phone: to_phone, p_contact_id: contact_id || null });
    if (error) { console.error('[sms-service] suppression check failed:', error.message); return true; }
    return data === true;
  } catch (e) { console.error('[sms-service] suppression check threw:', String(e)); return true; }
}

async function handleSingleSMS(trigger:string,to_phone:string,params:any,ids:{contact_id?:string;portal_user_id?:string;borrower_id?:string;trigger_id?:string},mediaUrl?:string,fromOverride?:string) {
  const effectiveTrigger = trigger === 'manual' ? 'custom' : trigger;
  const msg = T[effectiveTrigger](params);
  if (await isOptedOut(to_phone, ids.contact_id)) {
    // Logged, not silently dropped: a suppressed message must still be visible.
    await logSMS({to_phone,to_name:params.firstName,body:msg,trigger_type:effectiveTrigger,trigger_id:ids.trigger_id,contact_id:ids.contact_id,portal_user_id:ids.portal_user_id,borrower_id:ids.borrower_id,status:'blocked',error_message:'recipient has opted out of SMS',media_url:mediaUrl});
    return { sent:false, error:'recipient has opted out of SMS', blocked:true };
  }
  const result = await sendTwilioSMS(to_phone, msg, mediaUrl, fromOverride);
  await logSMS({to_phone,to_name:params.firstName,body:msg,trigger_type:effectiveTrigger,trigger_id:ids.trigger_id,contact_id:ids.contact_id,portal_user_id:ids.portal_user_id,borrower_id:ids.borrower_id,twilio_sid:result.sid,status:result.sent?'sent':'failed',error_message:result.error,media_url:mediaUrl});
  await logActivity({contact_id:ids.contact_id,portal_user_id:ids.portal_user_id,crm_id:ids.borrower_id,title:`SMS: ${effectiveTrigger.replace(/_/g,' ')} to ${to_phone}`,description:msg.substring(0,120),status:result.sent?'sent':'failed',sms_body:msg,sms_to:to_phone,metadata:{trigger:effectiveTrigger,sid:result.sid,error:result.error,has_media:!!mediaUrl}});
  return result;
}

Deno.serve(async (req:Request) => {
  if (req.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  const ok=(d:any)=>new Response(JSON.stringify(d),{headers:{...cors,'Content-Type':'application/json'}});
  const err=(m:string,s=400)=>new Response(JSON.stringify({error:m}),{status:s,headers:{...cors,'Content-Type':'application/json'}});

  _actorUid = await callerUid(req);   // null unless a real user session was sent

  try {
    const body = await req.json();
    const {trigger, to_phone, params={}, contact_id, portal_user_id, borrower_id, trigger_id, media_url} = body;
    if (!trigger) return err('trigger required');

    // ── AI COMPOSE ────────────────────────────────────────────────────────────
    if (trigger === 'ai_compose') {
      const { prompt, contact_name, tone, context: ctx } = body;
      if (!ANTHROPIC_KEY) return err('ANTHROPIC_API_KEY not configured', 500);
      const toneMap: Record<string,string> = {
        professional: 'professional and concise',
        friendly: 'warm, friendly and conversational',
        urgent: 'urgent but respectful',
        followup: 'a gentle, non-pushy follow-up',
        congratulations: 'celebratory and enthusiastic'
      };
      const toneDesc = toneMap[tone] || 'professional, warm, and conversational';
      const systemMsg = `You are Rene Duarte, a licensed mortgage loan officer at Rates & Realty (NMLS #1795044) based in Huntington Beach, CA. Write a ${toneDesc} SMS message. Never use asterisks, markdown, or quotation marks. Keep it natural and human, under 160 characters when possible. Always sign off as - Rene. Return ONLY the SMS text, nothing else.`;
      const userMsg = (prompt || 'Write a friendly follow-up SMS') 
        + (contact_name ? ` The contact's name is ${contact_name}.` : '')
        + (ctx ? ` Context: ${ctx}` : '');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 300, messages: [{ role: 'user', content: systemMsg + '\n\n' + userMsg }] })
      });
      if (!res.ok) return err('AI error: ' + await res.text(), 500);
      const data = await res.json();
      const message = data.content?.[0]?.text?.trim() || '';
      return ok({ success: true, message });
    }

    // ── AI SUGGEST (multiple options) ─────────────────────────────────────────
    if (trigger === 'ai_suggest') {
      const { contact_name, situation } = body;
      if (!ANTHROPIC_KEY) return err('ANTHROPIC_API_KEY not configured', 500);
      const systemMsg = 'You are Rene Duarte, a licensed mortgage loan officer at Rates & Realty (NMLS #1795044). Generate 3 different SMS message options for the given situation. Return ONLY a JSON array of 3 strings, each a complete SMS message signed "- Rene". No markdown, no explanation, just the JSON array.';
      const userMsg = `Contact: ${contact_name || 'the borrower'}. Situation: ${situation || 'general follow-up'}. Generate 3 SMS options ranging from brief to detailed.`;
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 500, messages: [{ role: 'user', content: systemMsg + '\n\n' + userMsg }] })
      });
      if (!res.ok) return err('AI error', 500);
      const data = await res.json();
      let suggestions: string[] = [];
      try { suggestions = JSON.parse(data.content?.[0]?.text?.trim() || '[]'); } catch { suggestions = [data.content?.[0]?.text?.trim() || '']; }
      return ok({ success: true, suggestions });
    }

    // ── RUN_REMINDERS ─────────────────────────────────────────────────────────
    if (trigger === 'run_reminders') {
      const now = new Date();
      const ptOffset = -7;
      const ptNow = new Date(now.getTime() + ptOffset * 60 * 60 * 1000);
      const tomorrow = new Date(ptNow);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];
      const { data: batches, error: batchErr } = await sb.from('showings').select('batch_id, name, email, phone, preferred_date, preferred_time, exact_time, contact_id, portal_user_id, borrower_id').eq('preferred_date', tomorrowStr).eq('status', 'confirmed').is('deleted_at', null);
      if (batchErr) return err(batchErr.message, 500);
      if (!batches?.length) return ok({success:true, message:`No confirmed showings for ${tomorrowStr}`, reminders_sent:0});
      const seen = new Set<string>();
      const uniqueBatches = batches.filter(b => { if (!b.batch_id || seen.has(b.batch_id)) return false; seen.add(b.batch_id); return true; });
      let sent = 0, skipped = 0;
      const results: any[] = [];
      for (const batch of uniqueBatches) {
        if (!batch.phone) { skipped++; results.push({batch_id:batch.batch_id,skipped:true,reason:'no phone'}); continue; }
        const todayStr = ptNow.toISOString().split('T')[0];
        const { data: alreadySent } = await sb.from('sms_log').select('id').eq('trigger_id', batch.batch_id).eq('trigger_type', 'reminder').gte('created_at', todayStr + 'T00:00:00Z').limit(1);
        if (alreadySent?.length) { skipped++; results.push({batch_id:batch.batch_id,skipped:true,reason:'already sent today'}); continue; }
        const { count: homeCount } = await sb.from('showings').select('id', {count:'exact',head:true}).eq('batch_id', batch.batch_id).is('deleted_at', null);
        const firstName = batch.name?.split(' ')[0] || 'there';
        const displayTime = batch.exact_time || batch.preferred_time || 'your scheduled time';
        const dateFormatted = new Date(tomorrowStr + 'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
        const result = await handleSingleSMS('reminder', batch.phone, { firstName, date: dateFormatted, time: displayTime, homeCount: homeCount || 1 }, { contact_id: batch.contact_id, portal_user_id: batch.portal_user_id, borrower_id: batch.borrower_id, trigger_id: batch.batch_id });
        if (result.sent) sent++;
        results.push({batch_id:batch.batch_id,name:batch.name,phone:batch.phone,sent:result.sent,sid:result.sid,error:result.error});
      }
      if (sent > 0) await sendTwilioSMS(RENE_PHONE, `Reminder SMS: Sent ${sent} tour reminder${sent!==1?'s':''} for tomorrow ${tomorrowStr}. ${skipped} skipped.`);
      return ok({success:true, date:tomorrowStr, reminders_sent:sent, skipped, results});
    }

    // ── SINGLE TRIGGERS (including manual alias) ───────────────────────────────
    if (!to_phone) return err('to_phone required');
    const validTriggers = ['portal_signup','showing_request','showing_confirm','listing_alert_created','alert_match','reminder','custom','manual'];
    if (validTriggers.includes(trigger)) {
      const effectiveTrigger = trigger === 'manual' ? 'custom' : trigger;
      if (effectiveTrigger === 'custom' && !params.message) return err('params.message required for custom trigger');
      /* from_phone is opt-in and only honoured for 'custom'/'manual' — the
       * templated borrower-facing triggers must keep the business line, or a
       * caller could quietly send borrower mail from an internal number. */
      const fromOverride = (effectiveTrigger === 'custom' && typeof body.from_phone === 'string') ? body.from_phone : undefined;
      const result = await handleSingleSMS(trigger, to_phone, params, {contact_id, portal_user_id, borrower_id, trigger_id}, media_url, fromOverride);
      if (trigger === 'portal_signup') await sendTwilioSMS(RENE_PHONE, `New portal signup: ${params.firstName} ${params.lastName||''} (${params.email||to_phone}). ID: ${params.borrowerId||'—'}. Check CRM.`);
      if (trigger === 'showing_request') await sendTwilioSMS(RENE_PHONE, `New showing request from ${params.firstName}: ${params.homeCount} home${params.homeCount!==1?'s':''} on ${params.date||'TBD'}. Check CRM showings.`);
      return ok({success:true, sent:result.sent, sid:result.sid, error:result.error});
    }

    // ── GET SMS LOG ───────────────────────────────────────────────────────────
    if (trigger === 'get_log') {
      const {contact_id:cid, portal_user_id:puid, limit=50} = body;
      let q = sb.from('sms_log').select('*').order('created_at',{ascending:false}).limit(limit);
      if (cid) q = q.eq('contact_id',cid);
      else if (puid) q = q.eq('portal_user_id',puid);
      const {data} = await q;
      return ok({messages:data||[]});
    }

    return err('Unknown trigger: '+trigger);
  } catch(e:any) {
    console.error('sms-service error:',e);
    return err(e.message||'Server error',500);
  }
});

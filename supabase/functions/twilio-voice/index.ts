import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey,x-client-info' };
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID');
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');
const TWILIO_FROM = Deno.env.get('TWILIO_PHONE_NUMBER') || '+17144728508';

function formatPhone(phone: string): string {
  const d = phone.replace(/\D/g,'');
  if (d.startsWith('1') && d.length===11) return `+${d}`;
  if (d.length===10) return `+1${d}`;
  return `+${d}`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

async function twilioCall(to: string, twiml: string, from?: string): Promise<{success:boolean; callSid?:string; error?:string}> {
  if (!TWILIO_SID || !TWILIO_TOKEN) return { success: false, error: 'Twilio not configured' };
  const fromNumber = from ? formatPhone(from) : TWILIO_FROM;
  const params = new URLSearchParams({
    To: formatPhone(to),
    From: fromNumber,
    Twiml: twiml,
    Record: 'true',
  });
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const data = await res.json();
    if (data.sid) return { success: true, callSid: data.sid };
    return { success: false, error: data.message || data.code || 'Call failed' };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

async function logCall(p: {
  contact_id?: string;
  to_phone: string;
  from_phone?: string;
  duration?: number;
  status: string;
  notes?: string;
  outcome?: string;
  recording_url?: string;
  twilio_call_sid?: string;
  voicemail_drop?: boolean;
}) {
  try {
    await sb.from('calls_log').insert({
      contact_id: p.contact_id || null,
      to_phone: p.to_phone,
      from_phone: p.from_phone || TWILIO_FROM,
      duration: p.duration || null,
      status: p.status,
      notes: p.notes || null,
      outcome: p.outcome || null,
      recording_url: p.recording_url || null,
      twilio_call_sid: p.twilio_call_sid || null,
      voicemail_drop: p.voicemail_drop || false,
      created_at: new Date().toISOString()
    });
  } catch (e) { console.error('logCall:', e); }
}

async function logActivity(p: {
  contact_id?: string;
  title: string;
  description?: string;
  status: string;
  metadata?: any;
}) {
  try {
    await sb.from('activity_events').insert({
      contact_id: p.contact_id || null,
      type: 'call',
      channel: 'phone',
      direction: 'outbound',
      title: p.title,
      description: p.description || null,
      status: p.status,
      metadata: p.metadata ? JSON.stringify(p.metadata) : null,
      created_at: new Date().toISOString()
    });
  } catch (e) { console.error('logActivity:', e); }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const { action } = body;
    if (!action) return err('action required');

    // ── MAKE_CALL ──────────────────────────────────────────────────────────────
    if (action === 'make_call') {
      const { to, contact_id, from } = body;
      if (!to) return err('to (phone number) required');

      const fromNumber = from ? formatPhone(from) : TWILIO_FROM;
      const twiml = `<Response><Dial callerId="${escapeXml(fromNumber)}">${escapeXml(formatPhone(to))}</Dial></Response>`;
      const result = await twilioCall(to, twiml, from);

      if (result.success) {
        await logCall({
          contact_id,
          to_phone: formatPhone(to),
          from_phone: fromNumber,
          status: 'initiated',
          twilio_call_sid: result.callSid,
        });
        await logActivity({
          contact_id,
          title: `Outbound call to ${formatPhone(to)}`,
          status: 'initiated',
          metadata: { callSid: result.callSid, from: fromNumber },
        });
      }

      return ok({ success: result.success, callSid: result.callSid, error: result.error });
    }

    // ── VOICEMAIL_DROP ─────────────────────────────────────────────────────────
    if (action === 'voicemail_drop') {
      const { to, voicemail_url, contact_id } = body;
      if (!to) return err('to (phone number) required');
      if (!voicemail_url) return err('voicemail_url required');

      const twiml = `<Response><Pause length="2"/><Play>${escapeXml(voicemail_url)}</Play><Hangup/></Response>`;
      const result = await twilioCall(to, twiml);

      if (result.success) {
        await logCall({
          contact_id,
          to_phone: formatPhone(to),
          status: 'initiated',
          twilio_call_sid: result.callSid,
          voicemail_drop: true,
        });
        await logActivity({
          contact_id,
          title: `Voicemail drop to ${formatPhone(to)}`,
          description: `Audio: ${voicemail_url}`,
          status: 'initiated',
          metadata: { callSid: result.callSid, voicemail_url, voicemail_drop: true },
        });
      }

      return ok({ success: result.success, callSid: result.callSid, error: result.error });
    }

    // ── CALL_STATUS ────────────────────────────────────────────────────────────
    if (action === 'call_status') {
      const { callSid } = body;
      if (!callSid) return err('callSid required');
      if (!TWILIO_SID || !TWILIO_TOKEN) return err('Twilio not configured', 500);

      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls/${callSid}.json`, {
        headers: { 'Authorization': 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`) }
      });
      if (!res.ok) return err('Failed to fetch call status', res.status);
      const data = await res.json();
      return ok({ status: data.status, duration: data.duration });
    }

    // ── LOG_CALL ───────────────────────────────────────────────────────────────
    if (action === 'log_call') {
      const { contact_id, to_phone, duration, status, notes, outcome, recording_url, twilio_call_sid } = body;
      if (!to_phone) return err('to_phone required');

      await logCall({
        contact_id,
        to_phone: formatPhone(to_phone),
        duration,
        status: status || 'completed',
        notes,
        outcome,
        recording_url,
        twilio_call_sid,
      });

      await logActivity({
        contact_id,
        title: `Call logged — ${formatPhone(to_phone)}${outcome ? ' (' + outcome + ')' : ''}`,
        description: notes ? notes.substring(0, 200) : undefined,
        status: status || 'completed',
        metadata: { twilio_call_sid, duration, outcome, recording_url },
      });

      return ok({ success: true });
    }

    return err('Unknown action: ' + action);
  } catch (e: any) {
    console.error('twilio-voice error:', e);
    return err(e.message || 'Server error', 500);
  }
});

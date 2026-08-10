// click-to-call v1: outbound click-to-call for CRM Call buttons.
// Flow: frontend POSTs { contact_id?, to_phone } -> we create a Twilio call that rings RENE'S
// CELL first (From = 866 business number), and when he answers, TwiML <Dial>s the lead. The
// call is recorded; a recordingStatusCallback + status callback hit twilio-voice phases to log
// it to call_log + activity_events (reusing the inbound logging path, marked outbound).
//
// Why ring Rene first: so HE is connected via his own cell but the lead sees the 866 caller ID,
// and Rene doesn't have to dial — clicking the button places the call for him.
//
// verify_jwt=false here is acceptable because the function only initiates a call to Rene's own
// cell + a CRM-provided number; no sensitive data is returned. (Frontend calls it with the
// anon key + the user's session; we additionally re-check the contact exists.)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { requireStaff } from '../_shared/require-staff.ts';

const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,apikey,x-client-info' };
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const sb = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID');
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');
const BIZ_NUMBER = Deno.env.get('TWILIO_PHONE_NUMBER') || '+18668919394';
const RENE_CELL = Deno.env.get('RENE_CELL') || '+17144728508';
const SELF_VOICE = `${SUPABASE_URL}/functions/v1/twilio-voice`;

function fmt(p: string): string {
  const d = (p||'').replace(/\D/g,'');
  if (d.startsWith('1') && d.length===11) return `+${d}`;
  if (d.length===10) return `+1${d}`;
  return `+${d}`;
}
function esc(s: string){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type':'application/json' } });
  const err = (m: string, s=400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type':'application/json' } });

  /* GUARD — BEFORE req.json().
   *
   * This function places a REAL CALL on Rene's licensed line and bills his
   * Twilio account. It had no authorization: probed with the public anon key it
   * returned 400 'valid to_phone or contact_id required', so a payload check was
   * all that stood between an anonymous caller and outbound dialling.
   *
   * Its only browser caller is crmCall in admin/js/crm-comms.js, which already
   * sends the signed-in user's session token through fnFetch — the anon-key
   * version was retired when email-service was guarded. power-dialer's bridge
   * button calls twilio-voice bridge_call, not this, and is already guarded.
   * So no frontend change is needed for this one. */
  const staff = await requireStaff(req, { what: 'Placing a call' });
  if (!staff.ok) {
    console.error('[click-to-call] REJECTED:', staff.status, staff.msg);
    return new Response(JSON.stringify({ success: false, error: staff.msg || 'unauthorized' }),
      { status: staff.status || 403, headers: { ...cors, 'Content-Type':'application/json' } });
  }
  const actorUid = staff.userId || null;

  try {
    if (!TWILIO_SID || !TWILIO_TOKEN) return err('Twilio not configured', 500);
    const body = await req.json();
    const contactId = body.contact_id || null;
    let toPhone = body.to_phone || body.phone || '';

    // If only a contact_id is given, look up its phone.
    if ((!toPhone || toPhone.length < 7) && contactId) {
      const { data } = await sb.from('contacts').select('phone').eq('id', contactId).maybeSingle();
      toPhone = data?.phone || '';
    }
    if (!toPhone || toPhone.replace(/\D/g,'').length < 10) return err('valid to_phone or contact_id required');

    const leadE164 = fmt(toPhone);
    // TwiML that runs once Rene answers his cell: announce + dial the lead, record, log via status.
    const connectUrl = `${SELF_VOICE}?phase=outbound_connect&lead=${encodeURIComponent(leadE164)}${contactId?`&cid=${contactId}`:''}`;

    const params = new URLSearchParams({
      To: RENE_CELL,                 // ring Rene's cell first
      From: BIZ_NUMBER,              // business 866 as caller id
      Url: connectUrl,               // when Rene answers, this TwiML dials the lead
      Method: 'POST',
      Timeout: '20',
    });

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const data = await res.json();
    if (!res.ok || !data.sid) return err(data.message || 'Twilio call failed', 502);

    // Pre-log the outbound call as initiated (status callback will finalize)
    try {
      await sb.from('call_log').insert({
        contact_id: contactId, direction: 'outbound',
        from_phone: BIZ_NUMBER, to_phone: leadE164,
        status: 'initiated', outcome: 'Click-to-call placed',
        twilio_sid: data.sid,
        notes: 'Outbound click-to-call from CRM',
        created_at: new Date().toISOString(),
      });
    } catch (e) { console.error('prelog', e); }

    return ok({ success: true, call_sid: data.sid, ringing: RENE_CELL, will_connect: leadE164 });
  } catch (e: any) {
    console.error('click-to-call error', e);
    return err(e.message || 'Server error', 500);
  }
});

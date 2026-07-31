// calcom-webhook v55: same as v54 PLUS auto-rejects bookings from blocked
// emails/domains (via contact_blocklist) and from bookings whose payload
// contains suspicious URL patterns (fake "drive" subdomains).
//
// Defensive: a blocked booking is still logged to activity_events so Rene
// can see it happened, but no contact is created and the appointment is
// marked status='blocked_phishing' instead of 'scheduled'.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CAL_WEBHOOK_SECRET = Deno.env.get('CAL_WEBHOOK_SECRET') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---------- Signature verification (unchanged from v54) ----------
async function verifySignature(body: string, signature: string | null): Promise<boolean> {
  if (!CAL_WEBHOOK_SECRET || !signature) return !CAL_WEBHOOK_SECRET;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(CAL_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const sigBytes = hexToBytes(signature.replace('sha256=', ''));
  return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(body));
}
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// ---------- New: phishing pattern detection ----------
// These patterns are common social-engineering indicators in booking
// metadata: fake "drive" / "docs" subdomains designed to look like Google
// but on lookalike domains.
const SUSPICIOUS_URL_PATTERNS = [
  /drive\.worksplace\.online/i,
  /\b(drive|docs|sheets|gdrive)\.[a-z0-9-]+\.(online|site|info|xyz|click|link|cc|tk|ml|ga|cf)\b/i,
  /bit\.ly\/[a-z0-9-]+\.(docx|pdf|exe|zip)$/i,
  /\.(scr|exe|hta|js|vbs)$/i,
];

function findSuspiciousUrls(payload: any): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  function walk(v: any) {
    if (v == null) return;
    if (typeof v === 'string') {
      for (const re of SUSPICIOUS_URL_PATTERNS) {
        const m = v.match(re);
        if (m && !seen.has(m[0])) {
          seen.add(m[0]);
          found.push(m[0]);
        }
      }
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (typeof v === 'object') {
      for (const k of Object.keys(v)) walk(v[k]);
    }
  }
  walk(payload);
  return found;
}

async function isOnBlocklist(email: string, phone: string, name: string): Promise<{ blocked: boolean; reason?: string }> {
  const { data, error } = await supabase.rpc('is_contact_blocked', {
    p_email: email || null,
    p_phone: phone || null,
    p_name: name || null,
  });
  if (error) {
    console.warn('blocklist check error:', error.message);
    return { blocked: false };
  }
  if (data === true) return { blocked: true, reason: 'contact_blocklist match' };
  return { blocked: false };
}

// ---------- Main handler ----------
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const rawBody = await req.text();
  const signature = req.headers.get('x-cal-signature-256');

  if (!(await verifySignature(rawBody, signature))) {
    console.error('Invalid Cal.com webhook signature');
    return new Response('Unauthorized', { status: 401 });
  }

  let payload: any;
  try { payload = JSON.parse(rawBody); }
  catch { return new Response('Invalid JSON', { status: 400 }); }

  const triggerEvent: string = payload.triggerEvent ?? '';
  const booking = payload.payload ?? {};

  console.log(`Cal.com webhook: ${triggerEvent} uid=${booking.uid}`);

  try {
    switch (triggerEvent) {
      case 'BOOKING_CREATED':
      case 'BOOKING_RESCHEDULED':
        await handleBooking(booking, triggerEvent);
        break;
      case 'BOOKING_CANCELLED':
        await handleCancellation(booking);
        break;
      default:
        console.log(`Unhandled event type: ${triggerEvent}`);
    }
  } catch (err) {
    console.error('Cal.com webhook error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
});

async function handleBooking(booking: any, triggerEvent: string) {
  const attendee = booking.attendees?.[0] ?? {};
  const attendeeName: string = attendee.name ?? booking.responses?.name?.value ?? '';
  const attendeeEmail: string = (attendee.email ?? booking.responses?.email?.value ?? '').toLowerCase();
  const attendeePhone: string = booking.responses?.phone?.value ?? '';

  const startTime = booking.startTime ? new Date(booking.startTime) : null;
  const endTime = booking.endTime ? new Date(booking.endTime) : null;
  const durationMinutes = startTime && endTime
    ? Math.round((endTime.getTime() - startTime.getTime()) / 60000)
    : null;

  // --- SECURITY GATE: blocklist + phishing URL scan ---
  const blockCheck = await isOnBlocklist(attendeeEmail, attendeePhone, attendeeName);
  const suspiciousUrls = findSuspiciousUrls(booking);
  const isBlocked = blockCheck.blocked || suspiciousUrls.length > 0;

  if (isBlocked) {
    const reason = blockCheck.blocked
      ? `Blocklist match: ${blockCheck.reason}`
      : `Suspicious URL(s) in booking: ${suspiciousUrls.join(', ')}`;
    console.warn(`[SECURITY] Blocked booking from ${attendeeEmail}: ${reason}`);

    // Log it but don't create a contact and don't put it on the active calendar
    await supabase.from('appointments').upsert(
      {
        cal_booking_uid: booking.uid,
        title: `[BLOCKED] ${booking.title ?? 'Suspicious booking'}`,
        cal_event_type: booking.eventType?.slug ?? null,
        appointment_time: startTime?.toISOString() ?? null,
        scheduled_at: startTime?.toISOString() ?? null,
        notes: `[AUTO-BLOCKED ${new Date().toISOString()}] ${reason}`,
        status: 'blocked_phishing',
        type: 'cal.com',
        attendee_name: attendeeName,
        attendee_email: attendeeEmail,
        attendee_phone: attendeePhone || null,
        duration_minutes: durationMinutes,
        meeting_url: null,
        raw_payload: booking,
        contact_id: null,
      },
      { onConflict: 'cal_booking_uid' }
    );

    await supabase.from('activity_events').insert({
      type: 'system',
      channel: 'system',
      title: `\ud83d\udeab Auto-blocked Cal.com booking from ${attendeeEmail || attendeeName || 'unknown'}`,
      description: reason + (suspiciousUrls.length ? ` | URLs: ${suspiciousUrls.join(', ')}` : ''),
      status: 'flagged',
      metadata: JSON.stringify({
        booking_uid: booking.uid,
        attendee_email: attendeeEmail,
        attendee_name: attendeeName,
        suspicious_urls: suspiciousUrls,
        blocklist_match: blockCheck.blocked,
      }),
      created_at: new Date().toISOString(),
    });

    // Also notify Rene by SMS so he can manually cancel in Cal.com if needed
    try {
      await fetch(`${SUPABASE_URL}/functions/v1/sms-service`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
        body: JSON.stringify({
          trigger: 'custom',
          to_phone: '+17144728508',
          params: {
            message: `\u26a0\ufe0f Auto-blocked suspicious Cal.com booking from ${attendeeEmail || attendeeName}. Reason: ${reason.substring(0, 100)}. Cancel in Cal.com manually.`
          }
        })
      });
    } catch (e) { console.warn('SMS notify failed:', e); }

    return;
  }

  // --- Normal flow (unchanged) ---
  let contactId: string | null = null;
  if (attendeeEmail) {
    const nameParts = attendeeName.trim().split(' ');
    const firstName = nameParts[0] ?? '';
    const lastName = nameParts.slice(1).join(' ') || '';

    const { data: contact, error: contactErr } = await supabase
      .from('contacts')
      .upsert(
        {
          email: attendeeEmail,
          first_name: firstName,
          last_name: lastName,
          phone: attendeePhone || null,
          source: 'cal.com',
          funnel_source: 'cal.com_booking',
          updated_at: new Date().toISOString()
        },
        { onConflict: 'email', ignoreDuplicates: false }
      )
      .select('id')
      .single();

    if (contactErr) console.error('Contact upsert error:', contactErr);
    else contactId = contact?.id ?? null;
  }

  const isReschedule = triggerEvent === 'BOOKING_RESCHEDULED';
  const appointmentData: any = {
    cal_booking_uid: booking.uid,
    title: booking.title ?? booking.eventType?.title ?? 'Consultation',
    cal_event_type: booking.eventType?.slug ?? booking.eventTypeId?.toString() ?? null,
    appointment_time: startTime?.toISOString() ?? null,
    scheduled_at: startTime?.toISOString() ?? null,
    notes: booking.description ?? null,
    status: 'scheduled',
    type: 'cal.com',
    attendee_name: attendeeName,
    attendee_email: attendeeEmail,
    attendee_phone: attendeePhone || null,
    duration_minutes: durationMinutes,
    meeting_url: booking.metadata?.videoCallUrl ?? booking.location ?? null,
    raw_payload: booking,
    contact_id: contactId
  };
  if (isReschedule) {
    appointmentData.rescheduled_from = booking.previousBooking?.startTime
      ? new Date(booking.previousBooking.startTime).toISOString()
      : null;
  }

  const { error: apptErr } = await supabase
    .from('appointments')
    .upsert(appointmentData, { onConflict: 'cal_booking_uid' });
  if (apptErr) console.error('Appointment upsert error:', apptErr);

  await supabase
    .from('calendar_events')
    .upsert(
      {
        cal_booking_uid: booking.uid,
        title: booking.title ?? 'Consultation',
        event_type: 'cal.com_booking',
        start_time: startTime?.toISOString() ?? null,
        end_time: endTime?.toISOString() ?? null,
        google_meet_link: booking.metadata?.videoCallUrl ?? null,
        meeting_url: booking.metadata?.videoCallUrl ?? booking.location ?? null,
        notes: booking.description ?? null,
        status: 'scheduled',
        attendee_email: attendeeEmail,
        contact_id: contactId
      },
      { onConflict: 'cal_booking_uid' }
    );

  if (contactId) {
    const action = isReschedule ? 'rescheduled' : 'booked';
    await supabase.from('activity_events').insert({
      contact_id: contactId,
      type: 'appointment',
      title: `Appointment ${action} via Cal.com`,
      description: `${attendeeName} ${action} a ${booking.title ?? 'consultation'} for ${startTime?.toLocaleDateString('en-US') ?? 'TBD'}`
    });
  }

  console.log(`Booking ${triggerEvent} processed. Contact: ${contactId}, UID: ${booking.uid}`);
}

async function handleCancellation(booking: any) {
  await supabase.from('appointments')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('cal_booking_uid', booking.uid);
  await supabase.from('calendar_events')
    .update({ status: 'cancelled' })
    .eq('cal_booking_uid', booking.uid);

  const { data: appt } = await supabase
    .from('appointments')
    .select('contact_id, attendee_name, title')
    .eq('cal_booking_uid', booking.uid)
    .single();

  if (appt?.contact_id) {
    await supabase.from('activity_events').insert({
      contact_id: appt.contact_id,
      type: 'appointment',
      title: 'Appointment cancelled',
      description: `${appt.attendee_name ?? 'Contact'} cancelled their ${appt.title ?? 'appointment'}`
    });
  }
  console.log(`Booking cancelled: ${booking.uid}`);
}

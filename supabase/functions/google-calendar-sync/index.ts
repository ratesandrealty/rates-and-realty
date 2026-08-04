import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const EXPIRY_BUFFER_MS = 5 * 60 * 1000

async function getValidAccessToken(supabase: any): Promise<string | null> {
  const { data } = await supabase
    .from('google_calendar_tokens')
    .select('*')
    .eq('id', 'rene')
    .single()

  if (!data) return null

  const expiresAt = new Date(data.expires_at).getTime()
  const needsRefresh = expiresAt - Date.now() < EXPIRY_BUFFER_MS

  if (needsRefresh) {
    if (!data.refresh_token) {
      console.error('[google-calendar-sync] token expired and no refresh_token present')
      return null
    }
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: data.refresh_token,
        grant_type: 'refresh_token',
      }),
    })
    const tokens = await res.json()
    if (!tokens.access_token) {
      console.error('[google-calendar-sync] refresh failed:', JSON.stringify(tokens))
      return null
    }
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    const updateData: Record<string, string> = {
      access_token: tokens.access_token,
      expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    }
    if (tokens.refresh_token) updateData.refresh_token = tokens.refresh_token
    await supabase.from('google_calendar_tokens').update(updateData).eq('id', 'rene')
    return tokens.access_token
  }

  return data.access_token
}

serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  const accessToken = await getValidAccessToken(supabase)

  if (!accessToken) {
    return new Response(JSON.stringify({ error: 'Not authenticated with Google Calendar. Visit /functions/v1/google-calendar-auth to connect.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    })
  }

  const body = await req.json().catch(() => ({}))
  const { appointment_id, tour_id, action, include_past } = body

  // ───────── APPOINTMENT SYNC (existing, unchanged) ─────────
  async function syncAppointment(apt: any) {
    const start = new Date(apt.scheduled_at || apt.appointment_time)
    const end = new Date(start.getTime() + (apt.duration_minutes || 60) * 60000)

    const contactName = apt.contacts
      ? `${apt.contacts.first_name || ''} ${apt.contacts.last_name || ''}`.trim()
      : apt.attendee_name || ''
    const contactPhone = apt.contacts?.phone || apt.attendee_phone || ''
    const contactEmail = apt.contacts?.email || apt.attendee_email || ''

    const eventBody: any = {
      summary: apt.title || apt.type || 'CRM Appointment',
      description: [
        contactName ? `Client: ${contactName}` : '',
        contactPhone ? `Phone: ${contactPhone}` : '',
        contactEmail ? `Email: ${contactEmail}` : '',
        apt.meeting_url ? `Meeting: ${apt.meeting_url}` : '',
        apt.notes ? `Notes: ${apt.notes}` : '',
        '\n--- Created by Rates & Realty CRM ---'
      ].filter(Boolean).join('\n'),
      start: { dateTime: start.toISOString(), timeZone: 'America/Los_Angeles' },
      end: { dateTime: end.toISOString(), timeZone: 'America/Los_Angeles' },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 60 },
          { method: 'popup', minutes: 15 }
        ]
      },
      extendedProperties: { private: { crm_appointment_id: apt.id } }
    }
    if (contactEmail) {
      eventBody.attendees = [{ email: contactEmail, displayName: contactName }]
    }

    /* sendUpdates=none, stated rather than inherited.
     *
     * When the appointment has a contact with an email, eventBody.attendees above
     * puts that borrower on the event. Google's default for events.insert/update
     * is not to mail attendees, so no invitation goes out today — but that is a
     * DEFAULT, not a decision, and it is one line away from becoming
     * sendUpdates=all in a future edit meant to "fix invitations". Every borrower
     * attached to an event would then be mailed at once, retroactively on the
     * next sync_all.
     *
     * NOTE this does not stop the attendee entry itself: a Google-account
     * borrower can still see the event on their own calendar, because Google
     * surfaces invitations without mailing them. Whether attaching a lead should
     * add an attendee at all is a separate, open decision. */
    let method = 'POST'
    let endpoint = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none'
    if (apt.google_event_id) {
      method = 'PUT'
      endpoint = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${apt.google_event_id}?sendUpdates=none`
    }
    const r = await fetch(endpoint, {
      method,
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody),
    })
    const ev = await r.json()
    if (!ev.id) throw new Error('Google Calendar error: ' + JSON.stringify(ev))
    await supabase.from('appointments').update({
      google_event_id: ev.id,
      synced_to_google_at: new Date().toISOString(),
    }).eq('id', apt.id)
    return { google_event_id: ev.id, google_event_link: ev.htmlLink }
  }

  // ───────── TOUR SYNC (NEW) ─────────
  // Push a showing_batches row to Google Calendar. The event description
  // includes the full stop list so Rene can read the route from his phone
  // even without opening the CRM. End time = start + (stops × 45min).
  async function syncTour(tour: any) {
    if (!tour.scheduled_start) {
      throw new Error(`Tour ${tour.id} has no scheduled_start`)
    }
    const start = new Date(tour.scheduled_start)

    // Fetch stops in order so the event description shows them in route order
    const { data: stops } = await supabase
      .from('showings')
      .select('order_index, property_address, property_city, property_state, property_zip, mls_number, arrival_time, duration_minutes, agent_notes')
      .eq('batch_id', tour.id)
      .is('deleted_at', null)
      .order('order_index', { ascending: true })

    const stopCount = (stops || []).length
    const totalMinutes = (stops || []).reduce((s: number, st: any) => s + (st.duration_minutes || 30), 0) || stopCount * 45
    const end = new Date(start.getTime() + totalMinutes * 60000)

    const contactName = tour.contacts
      ? `${tour.contacts.first_name || ''} ${tour.contacts.last_name || ''}`.trim()
      : 'Lead'
    const contactPhone = tour.contacts?.phone || ''
    const publicUrl = tour.share_token ? `https://beta.ratesandrealty.com/tour/${tour.share_token}` : ''

    const stopsList = (stops || []).map((st: any, i: number) => {
      const addr = [st.property_address, st.property_city, st.property_state, st.property_zip].filter(Boolean).join(', ')
      const time = st.arrival_time ? ` (arrive ${st.arrival_time})` : ''
      const dur = st.duration_minutes ? ` — ${st.duration_minutes}min` : ''
      const notes = st.agent_notes ? `\n   Notes: ${st.agent_notes}` : ''
      return `${i + 1}. ${addr}${time}${dur}${notes}`
    }).join('\n')

    const description = [
      `Showing tour with ${contactName}`,
      contactPhone ? `Phone: ${contactPhone}` : '',
      `${stopCount} ${stopCount === 1 ? 'stop' : 'stops'} · ~${Math.round(totalMinutes / 60 * 10) / 10}hr total`,
      '',
      'ROUTE:',
      stopsList || '(no stops yet)',
      '',
      publicUrl ? `Lead-facing itinerary: ${publicUrl}` : '',
      `CRM tour builder: https://beta.ratesandrealty.com/admin/tour-builder.html?batch_id=${tour.id}`,
      '',
      '--- Created by Rates & Realty CRM ---'
    ].filter(Boolean).join('\n')

    const firstStop = stops?.[0]
    const location = firstStop
      ? [firstStop.property_address, firstStop.property_city, firstStop.property_state].filter(Boolean).join(', ')
      : ''

    const eventBody: any = {
      summary: `🏠 Tour: ${contactName}${stopCount > 0 ? ` (${stopCount} ${stopCount === 1 ? 'stop' : 'stops'})` : ''}`,
      description,
      location,
      start: { dateTime: start.toISOString(), timeZone: 'America/Los_Angeles' },
      end: { dateTime: end.toISOString(), timeZone: 'America/Los_Angeles' },
      colorId: '5', // banana yellow — matches CRM gold theme
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 120 },
          { method: 'popup', minutes: 30 }
        ]
      },
      extendedProperties: { private: { crm_tour_id: tour.id, crm_share_token: tour.share_token || '' } }
    }

    let method = 'POST'
    // No attendees are set on tours today; explicit anyway, so adding one later
    // cannot silently inherit Google's notification default.
    let endpoint = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none'
    if (tour.google_event_id) {
      method = 'PUT'
      endpoint = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${tour.google_event_id}?sendUpdates=none`
    }
    const r = await fetch(endpoint, {
      method,
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody),
    })
    const ev = await r.json()
    if (!ev.id) throw new Error('Google Calendar error (tour): ' + JSON.stringify(ev))
    await supabase.from('showing_batches').update({
      google_event_id: ev.id,
      synced_to_google_at: new Date().toISOString(),
    }).eq('id', tour.id)
    return { google_event_id: ev.id, google_event_link: ev.htmlLink, stops: stopCount }
  }

  // ───────── sync_all: APPOINTMENTS + TOURS, with optional include_past ─────────
  if (action === 'sync_all') {
    const cutoff = include_past ? new Date(0) : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d })()

    const { data: appts } = await supabase
      .from('appointments')
      .select('*, contacts(first_name, last_name, phone, email)')
      .gte('scheduled_at', cutoff.toISOString())
      .neq('status', 'canceled')
      .order('scheduled_at', { ascending: true })

    const { data: tours } = await supabase
      .from('showing_batches')
      .select('id, contact_id, title, scheduled_start, status, share_token, google_event_id, contacts(first_name, last_name, phone)')
      .gte('scheduled_start', cutoff.toISOString())
      .not('scheduled_start', 'is', null)
      .in('status', ['sent', 'confirmed', 'in_progress', 'completed'])
      .order('scheduled_start', { ascending: true })

    let apptSynced = 0, apptFailed = 0, tourSynced = 0, tourFailed = 0
    const errors: string[] = []

    for (const apt of (appts || [])) {
      try { await syncAppointment(apt); apptSynced++ }
      catch (e: any) { apptFailed++; errors.push(`appt ${apt.id}: ${e.message || e}`) }
    }
    for (const tour of (tours || [])) {
      try { await syncTour(tour); tourSynced++ }
      catch (e: any) { tourFailed++; errors.push(`tour ${tour.id}: ${e.message || e}`) }
    }

    return new Response(JSON.stringify({
      success: true,
      appointments: { synced: apptSynced, failed: apptFailed, total: (appts || []).length },
      tours: { synced: tourSynced, failed: tourFailed, total: (tours || []).length },
      // Legacy keys for backward compat with existing frontend button
      synced: apptSynced + tourSynced,
      failed: apptFailed + tourFailed,
      total: (appts || []).length + (tours || []).length,
      errors,
      include_past: !!include_past,
    }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    })
  }

  // ───────── Single tour sync (called by tours-admin send_to_lead) ─────────
  if (tour_id) {
    const { data: tour, error } = await supabase
      .from('showing_batches')
      .select('id, contact_id, title, scheduled_start, status, share_token, google_event_id, contacts(first_name, last_name, phone)')
      .eq('id', tour_id)
      .single()
    if (error || !tour) {
      return new Response(JSON.stringify({ error: 'Tour not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      })
    }
    try {
      const result = await syncTour(tour)
      return new Response(JSON.stringify({ success: true, ...result }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      })
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message || 'Tour sync failed' }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      })
    }
  }

  // ───────── Single appointment sync (existing default behavior) ─────────
  if (!appointment_id) {
    return new Response(JSON.stringify({ error: 'appointment_id, tour_id, or action:sync_all required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    })
  }

  const { data: apt, error: aptErr } = await supabase
    .from('appointments')
    .select('*, contacts(first_name, last_name, phone, email)')
    .eq('id', appointment_id)
    .single()

  if (aptErr || !apt) {
    return new Response(JSON.stringify({ error: 'Appointment not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    })
  }

  try {
    const result = await syncAppointment(apt)
    return new Response(JSON.stringify({ success: true, ...result }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message || 'Sync failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    })
  }
})

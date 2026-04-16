import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Refresh the token if it expires within this many ms. Five minutes is enough
// to guarantee the Calendar API call that follows will complete before expiry,
// even on slow networks, while still using cached tokens most of the time.
const EXPIRY_BUFFER_MS = 5 * 60 * 1000

async function getValidAccessToken(supabase: any): Promise<string | null> {
  const { data } = await supabase
    .from('google_calendar_tokens')
    .select('*')
    .eq('id', 'rene')
    .single()

  if (!data) return null

  // Proactive refresh: if the token is already expired OR will expire within
  // the buffer window, swap it for a fresh one. Previously this check only
  // refreshed AFTER expiry, which left a race window where a token expiring
  // in <60s would be handed back and fail mid-API-call.
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
    // Preserve the stored refresh_token unless Google rotated it (rare)
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
  const { appointment_id, action } = body

  // Push a single appointment to Google Calendar. Creates a new event or
  // updates an existing one (when apt.google_event_id is set). Returns the
  // resulting event id/link or throws on failure.
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
      }
    }
    if (contactEmail) {
      eventBody.attendees = [{ email: contactEmail, displayName: contactName }]
    }

    let method = 'POST'
    let endpoint = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
    if (apt.google_event_id) {
      method = 'PUT'
      endpoint = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${apt.google_event_id}`
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

  // ── sync_all: push every upcoming appointment from today forward. Used
  // by the calendar "Sync Google Cal" button. Reports per-appointment results
  // so partial failures don't block the rest.
  if (action === 'sync_all') {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const { data: appts, error } = await supabase
      .from('appointments')
      .select('*, contacts(first_name, last_name, phone, email)')
      .gte('scheduled_at', today.toISOString())
      .order('scheduled_at', { ascending: true })
    if (error) {
      return new Response(JSON.stringify({ error: 'Fetch appointments failed: ' + error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      })
    }
    let synced = 0, failed = 0
    const errors: string[] = []
    for (const apt of (appts || [])) {
      try { await syncAppointment(apt); synced++ }
      catch (e: any) { failed++; errors.push(`${apt.id}: ${e.message || e}`) }
    }
    return new Response(JSON.stringify({ success: true, synced, failed, total: (appts || []).length, errors }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    })
  }

  // ── single-appointment sync (legacy default behavior) ──
  if (!appointment_id) {
    return new Response(JSON.stringify({ error: 'appointment_id or action:sync_all required' }), {
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

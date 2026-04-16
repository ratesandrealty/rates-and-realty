import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!
const REDIRECT_URI = 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/google-calendar-auth'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

serve(async (req) => {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  if (!code && !error) {
    // Request BOTH Calendar AND Drive scopes.
    // access_type=offline + prompt=consent together guarantee a refresh_token
    // on first authorization. prompt=consent forces Google to re-issue a
    // refresh_token even if the user has previously consented — without it,
    // Google only returns a refresh_token on the very first consent ever.
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authUrl.searchParams.set('client_id', CLIENT_ID)
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive.file',
    ].join(' '))
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('prompt', 'consent')
    return Response.redirect(authUrl.toString(), 302)
  }

  if (error) return new Response(`OAuth error: ${error}`, { status: 400 })

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: code!,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  })

  const tokens = await tokenRes.json()
  if (!tokens.access_token) {
    return new Response(`Token error: ${JSON.stringify(tokens)}`, { status: 400 })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // Don't clobber an existing refresh_token with null/undefined.
  // Google may omit refresh_token on subsequent consents; if so, we want to
  // keep whatever is already stored so the background refresh cycle keeps
  // working. Only set refresh_token in the upsert when we actually have one.
  const row: Record<string, unknown> = {
    id: 'rene',
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }
  if (tokens.refresh_token) row.refresh_token = tokens.refresh_token

  await supabase.from('google_calendar_tokens').upsert([row])

  return new Response(`
    <html><body style="font-family:sans-serif;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">
      <div style="text-align:center;padding:40px;background:#1a1a1a;border:1px solid rgba(201,168,76,0.3);border-radius:16px;">
        <div style="font-size:48px;margin-bottom:16px;">&#x2705;</div>
        <h2 style="color:#c9a84c;margin-bottom:8px;">Google Connected!</h2>
        <p style="color:rgba(255,255,255,0.6);">Calendar + Drive access granted for rene@ratesandrealty.com</p>
        <a href="https://beta.ratesandrealty.com/admin/contacts.html" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#c9a84c;color:#111;border-radius:8px;text-decoration:none;font-weight:700;">Back to CRM &#x2192;</a>
      </div>
    </body></html>
  `, { headers: { 'Content-Type': 'text/html', ...corsHeaders } })
})

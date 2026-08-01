// google-calendar-auth v59
//   v59: confirmation page moved off this origin — Supabase rewrites HTML from
//        functions to text/plain, so the page rendered as raw markup.
//   v58: add gmail.readonly scope (VOE Phase 2 inbound Gmail polling).
//        No other change to the OAuth flow.
//
// What this does:
//   GET / (no params)         → redirect to Google's OAuth consent screen
//   GET /?code=...            → exchange code for tokens, save to DB, then
//                                302 to admin.ratesandrealty.com for the
//                                confirmation page (see confirmRedirect below)
//   GET /?error=...           → 302 to the same page with ?error=
//   GET /?iss=...&code=...    → same as code path (Google sometimes adds
//                                an `iss` param after consent)

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!
const REDIRECT_URI = 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/google-calendar-auth'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/* CONFIRMATION IS SERVED FROM OUR OWN ORIGIN, NOT FROM HERE.
 *
 * This function used to render the confirmation page itself. It set
 * 'Content-Type: text/html; charset=utf-8' correctly and the browser still
 * received text/plain with 'Content-Security-Policy: default-src none; sandbox'
 * bolted on, so Rene saw raw markup instead of a page. That rewrite is
 * Supabase's anti-phishing control on *.supabase.co/functions/v1/*: HTML from a
 * functions origin is deliberately neutered, while application/json from the
 * same gateway passes through untouched (verified both ways). No header set
 * here can win that argument, so the page moved to admin.ratesandrealty.com
 * where the Worker serves HTML as HTML.
 *
 * 302 rather than 303: the callback is a GET already, so there is no method to
 * downgrade. */
const CONFIRM_URL = 'https://admin.ratesandrealty.com/admin/google-connected.html';

function confirmRedirect(error?: string): Response {
  const to = error ? `${CONFIRM_URL}?error=${encodeURIComponent(error)}` : CONFIRM_URL;
  return new Response(null, {
    status: 302,
    headers: { Location: to, 'Cache-Control': 'no-store', ...corsHeaders },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')

  if (!code && !error) {
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authUrl.searchParams.set('client_id', CLIENT_ID)
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
    authUrl.searchParams.set('response_type', 'code')
    /* FULL drive, not drive.file.
     *
     * drive.file only grants access to files THIS app created or the user
     * explicitly picked. gdrive-sync has to write into borrower folders created
     * by the n8n foldering workflow under different credentials — a parent
     * drive.file cannot see. That is why the mirror needs the restricted scope.
     *
     * Because this ADDS a scope to an existing grant, prompt=consent below is
     * mandatory: without it Google treats the re-consent as already-granted and
     * returns no refresh token at all, which is a silent no-op that looks like
     * success. */
    authUrl.searchParams.set('scope', [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/gmail.readonly',
    ].join(' '))
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('prompt', 'consent')
    return Response.redirect(authUrl.toString(), 302)
  }

  if (error) {
    return confirmRedirect(error)
  }

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
    /* Only Google's error CODE travels to the browser. The previous version
     * rendered JSON.stringify(tokens) into the page, and this branch is reached
     * whenever access_token is absent — including responses that still carry an
     * id_token or a refresh_token alongside the error. Now that the confirmation
     * is a redirect, that payload would have gone into a URL: logged by the
     * Worker, kept in history, and sent as a Referer. The detail goes to the
     * function log instead, where it is already privileged. */
    console.error('[google-calendar-auth] token exchange failed:',
                  JSON.stringify({ error: tokens.error, description: tokens.error_description }))
    return confirmRedirect(String(tokens.error || 'token_exchange_failed'))
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  const row: Record<string, unknown> = {
    id: 'rene',
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }
  if (tokens.refresh_token) row.refresh_token = tokens.refresh_token

  await supabase.from('google_calendar_tokens').upsert([row])

  return confirmRedirect()

})

// google-calendar-auth v58
//   v58: add gmail.readonly scope (VOE Phase 2 inbound Gmail polling).
//        No other change to the OAuth flow.
//
// What this does:
//   GET / (no params)         → redirect to Google's OAuth consent screen
//   GET /?code=...            → exchange code for tokens, save to DB,
//                                show success HTML page
//   GET /?error=...           → show error message
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

const htmlHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  ...corsHeaders,
}

function htmlPage(title: string, bodyInner: string, status = 200): Response {
  const body = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
</head>
<body style="font-family:sans-serif;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">
  <div style="text-align:center;padding:40px;background:#1a1a1a;border:1px solid rgba(201,168,76,0.3);border-radius:16px;max-width:520px;">
    ${bodyInner}
  </div>
</body>
</html>`
  return new Response(body, { status, headers: htmlHeaders })
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
    authUrl.searchParams.set('scope', [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/gmail.readonly',
    ].join(' '))
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('prompt', 'consent')
    return Response.redirect(authUrl.toString(), 302)
  }

  if (error) {
    return htmlPage(
      'OAuth Error',
      `
        <div style="font-size:48px;margin-bottom:16px;">&#x274C;</div>
        <h2 style="color:#ff6b6b;margin-bottom:8px;">OAuth Error</h2>
        <p style="color:rgba(255,255,255,0.7);word-break:break-word;">
          ${escapeHtml(error)}
        </p>
        <p style="color:rgba(255,255,255,0.5);font-size:13px;margin-top:24px;">
          Try again from the original link, or contact support if this persists.
        </p>
      `,
      400,
    )
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
    return htmlPage(
      'Token Exchange Failed',
      `
        <div style="font-size:48px;margin-bottom:16px;">&#x274C;</div>
        <h2 style="color:#ff6b6b;margin-bottom:8px;">Token Exchange Failed</h2>
        <pre style="color:rgba(255,255,255,0.7);text-align:left;background:#0a0a0a;padding:12px;border-radius:6px;font-size:12px;overflow:auto;max-height:300px;">${escapeHtml(JSON.stringify(tokens, null, 2))}</pre>
      `,
      400,
    )
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

  return htmlPage(
    'Google Connected',
    `
      <div style="font-size:48px;margin-bottom:16px;">&#x2705;</div>
      <h2 style="color:#c9a84c;margin-bottom:8px;">Google Connected!</h2>
      <p style="color:rgba(255,255,255,0.6);">Calendar + Drive + Gmail access granted for rene@ratesandrealty.com</p>
      <a href="https://admin.ratesandrealty.com/admin/contacts.html" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#c9a84c;color:#111;border-radius:8px;text-decoration:none;font-weight:700;">Back to CRM &#x2192;</a>
    `,
  )
})

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

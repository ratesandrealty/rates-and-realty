import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info'
};

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!;
const CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!;
const sb = createClient(SB_URL, SB_KEY);

// Cron-ping this function every 45 minutes from cron-job.org to keep the
// Google OAuth token permanently fresh. It refreshes when the stored token
// has fewer than 10 minutes of life remaining and preserves the existing
// refresh_token unless Google rotates it (rare).
async function refreshGoogleToken(): Promise<{ success: boolean; message: string; expires_at?: string; was_expired?: boolean }> {
  const { data: tokenRow, error } = await sb.from('google_calendar_tokens').select('*').eq('id', 'rene').single();
  if (error || !tokenRow) return { success: false, message: 'No token found. Visit /functions/v1/google-calendar-auth to authorize.' };
  if (!tokenRow.refresh_token) return { success: false, message: 'No refresh_token. Re-authorize via /functions/v1/google-calendar-auth.' };

  const isExpired = new Date(tokenRow.expires_at) < new Date();
  const expiresInMinutes = Math.round((new Date(tokenRow.expires_at).getTime() - Date.now()) / 60000);

  if (!isExpired && expiresInMinutes > 10) {
    return { success: true, message: 'Token valid for ' + expiresInMinutes + ' more minutes. No refresh needed.', expires_at: tokenRow.expires_at, was_expired: false };
  }

  const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: tokenRow.refresh_token, grant_type: 'refresh_token' })
  });
  const newTokens = await refreshRes.json();

  if (!newTokens.access_token) {
    const errMsg = newTokens.error === 'invalid_grant'
      ? 'Refresh token revoked. Re-authorize: https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/google-calendar-auth'
      : 'Refresh failed: ' + JSON.stringify(newTokens);
    return { success: false, message: errMsg };
  }

  const newExpiresAt = new Date(Date.now() + newTokens.expires_in * 1000).toISOString();
  const updateData: Record<string, string> = {
    access_token: newTokens.access_token,
    expires_at: newExpiresAt,
    updated_at: new Date().toISOString()
  };
  if (newTokens.refresh_token) updateData.refresh_token = newTokens.refresh_token;

  await sb.from('google_calendar_tokens').update(updateData).eq('id', 'rene');

  return { success: true, message: 'Token refreshed. Valid for 1 hour.', expires_at: newExpiresAt, was_expired: isExpired };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const result = await refreshGoogleToken();
    if (req.method === 'GET') {
      const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0a;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="max-width:480px;width:100%;padding:32px 20px">
  <div style="text-align:center;margin-bottom:20px"><div style="font-size:1.2rem;font-weight:700;color:#C9A84C">Rates &amp; Realty</div><div style="font-size:.72rem;color:#555">Google Token Manager</div></div>
  <div style="background:#111;border:1px solid #222;border-radius:12px;padding:24px">
    <div style="font-size:2rem;text-align:center;margin-bottom:10px">${result.success ? '\u2705' : '\u274c'}</div>
    <h2 style="color:${result.success ? '#22c55e' : '#ef4444'};font-size:.95rem;margin:0 0 10px;text-align:center">${result.success ? 'Google Auth Active' : 'Auth Error'}</h2>
    <p style="color:#aaa;font-size:.82rem;line-height:1.7;margin:0 0 14px">${result.message}</p>
    ${result.expires_at ? '<div style="background:#1a1a1a;border-radius:8px;padding:10px 12px;font-size:.76rem;color:#888"><div>Next expiry: <strong style="color:#C9A84C">' + new Date(result.expires_at).toLocaleString('en-US',{timeZone:'America/Los_Angeles'}) + ' PT</strong></div><div style="margin-top:3px">Refreshed this call: <strong style="color:' + (result.was_expired ? '#22c55e' : '#666') + '">' + (result.was_expired ? 'Yes' : 'No (still valid)') + '</strong></div></div>' : ''}
    ${!result.success ? '<a href="https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/google-calendar-auth" style="display:block;text-align:center;background:#C9A84C;color:#000;text-decoration:none;padding:11px;border-radius:8px;font-weight:700;margin-top:14px;font-size:.85rem">Re-Authorize Google &rarr;</a>' : ''}
  </div>
  <div style="background:#111;border:1px solid #1a1a1a;border-radius:10px;padding:16px;margin-top:14px">
    <div style="font-size:.7rem;font-weight:700;color:#C9A84C;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Cron Setup (cron-job.org)</div>
    <div style="font-size:.72rem;color:#666;line-height:1.9">
      <div>URL: <code style="color:#C9A84C;font-size:.7rem">https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/google-token-refresh</code></div>
      <div>Method: <strong style="color:#aaa">POST</strong></div>
      <div>Schedule: <strong style="color:#aaa">Every 45 minutes</strong></div>
      <div style="margin-top:6px;color:#444">This keeps your Google auth token permanently refreshed so you never need to re-authorize.</div>
    </div>
  </div>
</div></body></html>`;
      return new Response(html, { headers: { ...cors, 'Content-Type': 'text/html' } });
    }
    return new Response(JSON.stringify(result), { status: result.success ? 200 : 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, message: e.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});

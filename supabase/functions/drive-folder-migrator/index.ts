// drive-folder-migrator v1 (one-off)
// Moves every contacts.gdrive_folder_id into the Borrowers parent folder
// (11OLUA6Fu3tNrzWP8O1v_pFjl-UGbzos6). Idempotent: skips folders already there.
// Auth: x-cron-secret header (shared secret reused from proactive-followups cron).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const PARENT_ID = '11OLUA6Fu3tNrzWP8O1v_pFjl-UGbzos6'
const SHARED_SECRET = 'rr-cron-2026-x7k3m9pq2r5tw8z4y6h8b3n1'
const GOOGLE_TOKEN_ROW_ID = 'rene'

async function getDriveAccessToken(sb: any): Promise<string | null> {
  // Try env var first (gdrive-sync compatibility), fall back to google_calendar_tokens.
  const refreshToken = Deno.env.get('GOOGLE_DRIVE_REFRESH_TOKEN')
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID') || ''
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET') || ''
  if (refreshToken && clientId && clientSecret) {
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret })
      })
      const d = await r.json()
      if (r.ok && d.access_token) return d.access_token
    } catch { /* fall through */ }
  }
  // Calendar token fallback (drive.file scope)
  const { data } = await sb.from('google_calendar_tokens').select('access_token, refresh_token, expires_at').eq('id', GOOGLE_TOKEN_ROW_ID).maybeSingle()
  if (!data) return null
  const access = data.access_token, refresh = data.refresh_token, exp = data.expires_at
  if (access && exp && (new Date(exp).getTime() - Date.now()) > 60000) return access
  if (!refresh || !clientId || !clientSecret) return null
  const r2 = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: 'refresh_token' })
  })
  if (!r2.ok) return null
  const t2 = await r2.json()
  if (!t2.access_token) return null
  await sb.from('google_calendar_tokens').update({ access_token: t2.access_token, expires_at: new Date(Date.now() + (t2.expires_in || 3600) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq('id', GOOGLE_TOKEN_ROW_ID)
  return t2.access_token
}

serve(async (req) => {
  const url = new URL(req.url)
  const secret = req.headers.get('x-cron-secret') || url.searchParams.get('secret') || ''
  if (secret !== SHARED_SECRET) return new Response('Forbidden', { status: 403 })
  const dryRun = url.searchParams.get('dry_run') === 'true'
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const token = await getDriveAccessToken(sb)
  if (!token) return Response.json({ error: 'no_drive_token' }, { status: 500 })

  const { data: contacts, error } = await sb.from('contacts').select('id, first_name, last_name, gdrive_folder_id').not('gdrive_folder_id', 'is', null)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  if (!contacts || contacts.length === 0) return Response.json({ total: 0, results: [] })

  const results: any[] = []
  for (const c of contacts) {
    const name = `${c.first_name || ''} ${c.last_name || ''}`.trim()
    const fid = c.gdrive_folder_id
    // 1) Read current parents
    const gp = await fetch(`https://www.googleapis.com/drive/v3/files/${fid}?fields=parents,name&supportsAllDrives=true`, { headers: { 'Authorization': `Bearer ${token}` } })
    if (!gp.ok) { results.push({ name, folder_id: fid, status: 'fetch_failed', code: gp.status, body: (await gp.text().catch(() => '')).slice(0, 160) }); continue }
    const meta = await gp.json()
    const currentParents: string[] = Array.isArray(meta.parents) ? meta.parents : []
    if (currentParents.includes(PARENT_ID)) { results.push({ name, folder_id: fid, status: 'already_in_parent', parents: currentParents }); continue }
    if (dryRun) { results.push({ name, folder_id: fid, status: 'would_move', from_parents: currentParents, to: PARENT_ID }); continue }
    // 2) Move (addParents + removeParents)
    const removeStr = currentParents.length > 0 ? `&removeParents=${currentParents.join(',')}` : ''
    const mv = await fetch(`https://www.googleapis.com/drive/v3/files/${fid}?addParents=${PARENT_ID}${removeStr}&supportsAllDrives=true&fields=id,parents`, { method: 'PATCH', headers: { 'Authorization': `Bearer ${token}` } })
    if (!mv.ok) { results.push({ name, folder_id: fid, status: 'move_failed', code: mv.status, body: (await mv.text().catch(() => '')).slice(0, 200), from_parents: currentParents }); continue }
    const moved = await mv.json()
    results.push({ name, folder_id: fid, status: 'moved', from_parents: currentParents, new_parents: moved.parents })
  }

  return Response.json({ total: contacts.length, parent: PARENT_ID, dry_run: dryRun, results })
})

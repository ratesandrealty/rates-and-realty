import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey'
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GOOGLE_CLIENT_ID     = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const BUCKET = 'borrower-documents';
const USER_TOKEN_ID = 'rene';

function mimeFromName(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain',
  };
  return map[ext] || 'application/octet-stream';
}

// ── User OAuth access token (refresh_token flow) ─────────────────
async function getUserAccessToken(): Promise<string | null> {
  try {
    const refreshToken = Deno.env.get('GOOGLE_DRIVE_REFRESH_TOKEN');
    const clientId     = Deno.env.get('GOOGLE_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');

    if (!refreshToken || !clientId || !clientSecret) {
      console.error('[drive-auth] Missing GOOGLE_DRIVE_REFRESH_TOKEN, GOOGLE_CLIENT_ID, or GOOGLE_CLIENT_SECRET');
      return null;
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
        client_id:     clientId,
        client_secret: clientSecret,
      })
    });

    const data = await res.json();
    if (!res.ok || !data.access_token) {
      console.error('[drive-auth] Token refresh failed:', JSON.stringify(data));
      return null;
    }
    return data.access_token;
  } catch (e: any) {
    console.error('[drive-auth] getUserAccessToken error:', e.message);
    return null;
  }
}

// ── Upload file bytes directly to Google Drive using user OAuth token ─────
async function uploadFileToDrive(
  token: string,
  fileName: string,
  mimeType: string,
  fileBytes: Uint8Array,
  folderId: string
): Promise<{ id: string; webViewLink: string } | null> {
  const boundary = 'boundary_' + crypto.randomUUID();
  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      metadata + `\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
  );
  const tail = encoder.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + fileBytes.length + tail.length);
  body.set(head, 0);
  body.set(fileBytes, head.length);
  body.set(tail, head.length + fileBytes.length);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  const data = await res.json();
  if (data.error) {
    console.error('[gdrive-sync] Drive upload error:', JSON.stringify(data));
    return null;
  }
  if (data.id) return { id: data.id, webViewLink: data.webViewLink };
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok  = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const { action } = body;
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // ── sync_document: upload a Supabase Storage doc to Drive ────────────
    if (action === 'sync_document') {
      const { document_id, contact_id } = body;
      if (!document_id || !contact_id) return err('document_id, contact_id required');

      const { data: contact } = await sb.from('contacts')
        .select('gdrive_folder_id, first_name, last_name')
        .eq('id', contact_id).single();

      if (!contact?.gdrive_folder_id) {
        return ok({ success: false, skipped: true, reason: 'No Drive folder linked to this contact' });
      }

      const { data: doc } = await sb.from('uploaded_documents')
        .select('gdrive_file_id, gdrive_file_url, file_path, file_name')
        .eq('id', document_id).single();
      if (doc?.gdrive_file_id) {
        return ok({ success: true, already_synced: true, gdrive_file_id: doc.gdrive_file_id });
      }
      if (!doc?.file_path) return err('file_path not set on document');

      const { data: fileData, error: dlErr } = await sb.storage
        .from(BUCKET)
        .download(doc.file_path);
      if (dlErr || !fileData) return err('Failed to download from storage: ' + (dlErr?.message || 'unknown'));

      const fileBytes = new Uint8Array(await fileData.arrayBuffer());
      const fileName  = doc.file_name || doc.file_path.split('/').pop()!;
      const mimeType  = fileData.type || mimeFromName(fileName);

      const token = await getUserAccessToken();
      if (!token) return err('OAuth token fetch failed (check GOOGLE_DRIVE_REFRESH_TOKEN / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)', 500);
      const driveResult = await uploadFileToDrive(token, fileName, mimeType, fileBytes, contact.gdrive_folder_id);
      if (!driveResult) return err('Drive upload failed');

      await sb.from('uploaded_documents').update({
        gdrive_file_id: driveResult.id,
        gdrive_file_url: driveResult.webViewLink,
      }).eq('id', document_id);

      console.log(`[gdrive-sync] Synced ${fileName} → Drive ${driveResult.id}`);
      return ok({ success: true, gdrive_file_id: driveResult.id, gdrive_file_url: driveResult.webViewLink });
    }

    // ── sync_all_pending: backfill existing docs that haven't been synced ─
    if (action === 'sync_all_pending') {
      const { contact_id } = body;

      let q = sb.from('uploaded_documents')
        .select('id, contact_id, file_path, file_name')
        .is('gdrive_file_id', null)
        .not('file_path', 'is', null);
      if (contact_id) q = q.eq('contact_id', contact_id);

      const { data: docs } = await q.limit(50);
      if (!docs?.length) return ok({ success: true, synced: 0, message: 'No pending docs' });

      const contactIds = [...new Set(docs.map((d: any) => d.contact_id).filter(Boolean))];
      const { data: contacts } = await sb.from('contacts')
        .select('id, gdrive_folder_id').in('id', contactIds);
      const folderMap: Record<string, string> = {};
      (contacts || []).forEach((c: any) => { if (c.gdrive_folder_id) folderMap[c.id] = c.gdrive_folder_id; });

      const token = await getUserAccessToken();
      if (!token) return err('OAuth token fetch failed (check GOOGLE_DRIVE_REFRESH_TOKEN / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)', 500);

      // Remaining pending after this batch: pending docs (any contact) - synced-ness
      const { count: pendingCount } = await sb.from('uploaded_documents')
        .select('id', { count: 'exact', head: true })
        .is('gdrive_file_id', null)
        .not('file_path', 'is', null);

      let synced = 0; let skipped = 0;
      const errors: any[] = [];
      for (const doc of docs) {
        const folderId = folderMap[doc.contact_id];
        if (!folderId) { skipped++; errors.push({ id: doc.id, reason: 'no_folder' }); continue; }
        const { data: fileData } = await sb.storage.from(BUCKET).download(doc.file_path).catch(() => ({ data: null, error: null }));
        if (!fileData) { skipped++; errors.push({ id: doc.id, reason: 'download_failed', path: doc.file_path }); continue; }
        const fileBytes = new Uint8Array(await fileData.arrayBuffer());
        const fileName  = doc.file_name || doc.file_path.split('/').pop()!;
        const mimeType  = fileData.type || mimeFromName(fileName);
        const result = await uploadFileToDrive(token, fileName, mimeType, fileBytes, folderId);
        if (result) {
          await sb.from('uploaded_documents').update({ gdrive_file_id: result.id, gdrive_file_url: result.webViewLink }).eq('id', doc.id);
          synced++;
        } else { skipped++; errors.push({ id: doc.id, reason: 'upload_failed' }); }
      }

      return ok({
        success: true,
        synced,
        skipped,
        total: docs.length,
        pending_before: pendingCount ?? null,
        remaining: Math.max(0, (pendingCount ?? 0) - synced),
        errors,
      });
    }

    return err('Unknown action. Use: sync_document, sync_all_pending');
  } catch (e: any) {
    console.error('gdrive-sync error:', e);
    return err(e.message, 500);
  }
});

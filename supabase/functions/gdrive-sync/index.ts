import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey'
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SA_JSON_RAW  = Deno.env.get('GDRIVE_SERVICE_ACCOUNT_JSON') || '';

// ── JWT for Google Service Account ───────────────────────────────────────────
async function getAccessToken(): Promise<string | null> {
  if (!SA_JSON_RAW) {
    console.warn('GDRIVE_SERVICE_ACCOUNT_JSON not set');
    return null;
  }
  try {
    const sa = JSON.parse(SA_JSON_RAW);
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/drive',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };
    const enc = (obj: any) => btoa(JSON.stringify(obj)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    const unsigned = `${enc(header)}.${enc(payload)}`;

    // Import private key
    const pemBody = sa.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
    const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8', keyData.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['sign']
    );
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    const jwt = `${unsigned}.${sigB64}`;

    // Exchange JWT for access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    });
    const tokenData = await tokenRes.json();
    return tokenData.access_token || null;
  } catch (e: any) {
    console.error('getAccessToken error:', e.message);
    return null;
  }
}

// ── Upload file bytes to Google Drive folder ──────────────────────────────────
async function uploadToDrive(
  token: string,
  fileName: string,
  mimeType: string,
  fileBytes: Uint8Array,
  parentFolderId: string
): Promise<{ id: string; webViewLink: string } | null> {
  const metadata = JSON.stringify({
    name: fileName,
    parents: [parentFolderId]
  });
  const boundary = '-------314159265358979323846';
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    'Content-Transfer-Encoding: base64',
    '',
    btoa(String.fromCharCode(...fileBytes)),
    `--${boundary}--`
  ].join('\r\n');

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary="${boundary}"`,
    },
    body
  });
  const data = await res.json();
  if (data.id) return { id: data.id, webViewLink: data.webViewLink };
  console.error('Drive upload error:', JSON.stringify(data));
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const ok  = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const { action } = body;

    // ── sync_document: upload a Supabase Storage doc to Drive ────────────
    if (action === 'sync_document') {
      const { document_id, contact_id, storage_path, file_name, file_type } = body;
      if (!document_id || !contact_id || !storage_path) return err('document_id, contact_id, storage_path required');

      const sb = createClient(SUPABASE_URL, SERVICE_KEY);

      // 1. Get the contact's linked Drive folder
      const { data: contact } = await sb.from('contacts')
        .select('gdrive_folder_id, first_name, last_name')
        .eq('id', contact_id).single();

      if (!contact?.gdrive_folder_id) {
        return ok({ success: false, skipped: true, reason: 'No Drive folder linked to this contact' });
      }

      // 2. Check if already synced
      const { data: doc } = await sb.from('uploaded_documents')
        .select('gdrive_file_id, gdrive_file_url')
        .eq('id', document_id).single();
      if (doc?.gdrive_file_id) {
        return ok({ success: true, already_synced: true, gdrive_file_id: doc.gdrive_file_id });
      }

      // 3. Download file from Supabase Storage
      const { data: fileData, error: dlErr } = await sb.storage
        .from('documents')
        .download(storage_path);
      if (dlErr || !fileData) return err('Failed to download from storage: ' + (dlErr?.message || 'unknown'));

      const fileBytes = new Uint8Array(await fileData.arrayBuffer());
      const mimeType = file_type === 'pdf' ? 'application/pdf' : (fileData.type || 'application/octet-stream');

      // 4. Get Drive access token
      const token = await getAccessToken();
      if (!token) return ok({ success: false, skipped: true, reason: 'Google Drive not configured (service account missing)' });

      // 5. Upload to Drive
      const driveResult = await uploadToDrive(token, file_name || storage_path.split('/').pop(), mimeType, fileBytes, contact.gdrive_folder_id);
      if (!driveResult) return err('Drive upload failed');

      // 6. Save Drive file ID back to uploaded_documents
      await sb.from('uploaded_documents').update({
        gdrive_file_id: driveResult.id,
        gdrive_file_url: driveResult.webViewLink,
        updated_at: new Date().toISOString()
      }).eq('id', document_id);

      console.log(`[gdrive-sync] Synced ${file_name} → Drive ${driveResult.id}`);
      return ok({ success: true, gdrive_file_id: driveResult.id, gdrive_file_url: driveResult.webViewLink });
    }

    // ── sync_all_pending: backfill existing docs that haven't been synced ─
    if (action === 'sync_all_pending') {
      const { contact_id } = body;
      const sb = createClient(SUPABASE_URL, SERVICE_KEY);

      let q = sb.from('uploaded_documents')
        .select('id, contact_id, storage_path, file_name, file_type')
        .is('gdrive_file_id', null)
        .not('storage_path', 'is', null);
      if (contact_id) q = q.eq('contact_id', contact_id);

      const { data: docs } = await q.limit(50);
      if (!docs?.length) return ok({ success: true, synced: 0, message: 'No pending docs' });

      const token = await getAccessToken();
      if (!token) return ok({ success: false, reason: 'Service account not configured' });

      // Get all unique contacts with Drive folders
      const contactIds = [...new Set(docs.map((d: any) => d.contact_id).filter(Boolean))];
      const { data: contacts } = await sb.from('contacts')
        .select('id, gdrive_folder_id').in('id', contactIds);
      const folderMap: Record<string, string> = {};
      (contacts || []).forEach((c: any) => { if (c.gdrive_folder_id) folderMap[c.id] = c.gdrive_folder_id; });

      let synced = 0; let skipped = 0;
      for (const doc of docs) {
        const folderId = folderMap[doc.contact_id];
        if (!folderId) { skipped++; continue; }
        const { data: fileData } = await sb.storage.from('documents').download(doc.storage_path).catch(() => ({ data: null, error: null }));
        if (!fileData) { skipped++; continue; }
        const fileBytes = new Uint8Array(await fileData.arrayBuffer());
        const mimeType = doc.file_type === 'pdf' ? 'application/pdf' : (fileData.type || 'application/octet-stream');
        const result = await uploadToDrive(token, doc.file_name || doc.storage_path.split('/').pop(), mimeType, fileBytes, folderId);
        if (result) {
          await sb.from('uploaded_documents').update({ gdrive_file_id: result.id, gdrive_file_url: result.webViewLink }).eq('id', doc.id);
          synced++;
        } else { skipped++; }
      }

      return ok({ success: true, synced, skipped, total: docs.length });
    }

    return err('Unknown action. Use: sync_document, sync_all_pending');
  } catch (e: any) {
    console.error('gdrive-sync error:', e);
    return err(e.message, 500);
  }
});

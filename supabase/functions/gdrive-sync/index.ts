import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';
/* THIS IMPORT WAS MISSING. getUserAccessToken() called getDriveAccessToken()
 * with nothing importing it and a module-scope `sb` that does not exist, so
 * every call threw ReferenceError, was swallowed by the try/catch, and returned
 * null — which the callers report as "OAuth token fetch failed". Deployed as
 * v82 on 2026-08-01 07:23 UTC; from that moment no borrower document reached
 * Drive. It went unnoticed for two and a half days because it only fires when
 * there is something to sync, and the next upload was Rene's live MMS test.
 * `deno check` catches both errors in one second. */
import { getDriveAccessToken } from '../_shared/google-user-token.ts';

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

// ── User OAuth access token ───────────────────────────────────────────────
/* Resolves through _shared/google-user-token.ts: the google_calendar_tokens row
 * first, GOOGLE_DRIVE_REFRESH_TOKEN only as a fallback. Previously this read the
 * secret exclusively, so re-authorising via google-calendar-auth updated a row
 * this function never looked at — two credentials for one Google account, one of
 * them un-refreshable and dead. Returns null on failure, as before, so callers
 * are unchanged. */
/* THE CATCH IS WHAT COST US THE AFTERNOON, not the missing import.
 *
 * A ReferenceError from a missing import was caught here, flattened to null,
 * and reported by both callers as "OAuth token fetch failed (check
 * GOOGLE_DRIVE_REFRESH_TOKEN / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)". That
 * message is a diagnosis, and it was the WRONG diagnosis: it named three
 * healthy secrets and sent everyone to look at a credential that was fine. A
 * catch that rewrites an exception into a plausible cause is worse than no
 * catch, because a crash would at least have carried a stack.
 *
 * So: keep returning null (callers are unchanged), but carry the real error
 * class and message out with it, and say plainly when the failure is NOT a
 * credential problem. A ReferenceError/TypeError here is a code defect and
 * naming it as one is the whole point. */
let lastTokenError: string | null = null;

async function getUserAccessToken(sbClient: SupabaseClient): Promise<string | null> {
  try {
    const { accessToken, source } = await getDriveAccessToken(sbClient);
    console.log(`[drive-auth] token ok (source=${source})`);
    lastTokenError = null;
    return accessToken;
  } catch (e) {
    const cls = (e as any)?.constructor?.name || typeof e;
    const msg = (e as any)?.message || String(e);
    const isCodeDefect = e instanceof ReferenceError || e instanceof TypeError || e instanceof SyntaxError;
    lastTokenError = isCodeDefect
      ? `${cls}: ${msg} — this is a CODE DEFECT in gdrive-sync, not a credential problem. Do not go looking at GOOGLE_* secrets.`
      : `${cls}: ${msg}`;
    console.error('[drive-auth] token resolution failed:', lastTokenError, (e as any)?.stack || '');
    return null;
  }
}

/* The message the callers return. Never invents a cause. */
function tokenErrorDetail(): string {
  return lastTokenError
    ? `Drive token resolution failed — ${lastTokenError}`
    : 'Drive token resolution failed and recorded no error, which should be impossible; check the function logs.';
}


/* Resolve the destination subfolder via gdrive-proxy — the SAME resolver the
 * admin uploader uses. Files used to land at the folder ROOT, which is why 79
 * loose copies sit there and none in the subfolders.
 *
 * Hoisted to module scope so BOTH entry points use it. It lived inside
 * sync_all_pending, so the cron path filed correctly while sync_document — the
 * one a human triggers from the CRM — still dumped at the root. Half a fix is
 * indistinguishable from no fix to whoever goes looking for the file. */
const DEFAULT_FOLDER = 'Initial Loan Submission';
async function resolveSub(parentId: string, name: string): Promise<string> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/gdrive-proxy?action=resolve-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ parentId, name }),
    });
    const d = await r.json();
    if (r.ok && d.id) return d.id;
    console.error('[gdrive-sync] resolve-folder failed, using root:', d?.error);
  } catch (e) { console.error('[gdrive-sync] resolve-folder threw, using root:', String(e)); }
  return parentId;   // a wrong folder is recoverable; a lost file is not
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
        .select('gdrive_file_id, gdrive_file_url, file_path, file_name, drive_folder')
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

      const token = await getUserAccessToken(sb);
      if (!token) return err(tokenErrorDetail(), 500);
      const targetFolder = await resolveSub(contact.gdrive_folder_id, (doc as any).drive_folder || DEFAULT_FOLDER);
      const driveResult = await uploadFileToDrive(token, fileName, mimeType, fileBytes, targetFolder);
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

      /* CLAIM, then upload. The old code selected rows where gdrive_file_id was
       * null, uploaded, and only then wrote the id back. Two runs overlapping in
       * that window — the 10-minute cron and a manual backfill — both saw the
       * same unclaimed rows and both uploaded, which is how Marlon ended up with
       * three copies of every SMS file and Santana with five of one PDF, all
       * stamped within the same few seconds.
       *
       * claim_pending_gdrive_syncs uses FOR UPDATE SKIP LOCKED so concurrent
       * callers get disjoint sets, and stamps gdrive_sync_claimed_at so the
       * exclusion survives past the transaction. Claims older than 10 minutes
       * are reclaimable, so a run that dies mid-upload strands nothing. */

      const { data: docs, error: claimErr } = await sb.rpc('claim_pending_gdrive_syncs', {
        p_limit: 50,
        p_contact: contact_id || null,
      });
      if (claimErr) return err('claim failed: ' + claimErr.message, 500);
      if (!docs?.length) return ok({ success: true, synced: 0, message: 'No pending docs' });

      const contactIds = [...new Set(docs.map((d: any) => d.contact_id).filter(Boolean))];
      const { data: contacts } = await sb.from('contacts')
        .select('id, gdrive_folder_id').in('id', contactIds);
      const folderMap: Record<string, string> = {};
      (contacts || []).forEach((c: any) => { if (c.gdrive_folder_id) folderMap[c.id] = c.gdrive_folder_id; });

      const token = await getUserAccessToken(sb);
      if (!token) return err(tokenErrorDetail(), 500);

      // Remaining pending after this batch: pending docs (any contact) - synced-ness
      const { count: pendingCount } = await sb.from('uploaded_documents')
        .select('id', { count: 'exact', head: true })
        .is('gdrive_file_id', null)
        .not('file_path', 'is', null);

      let synced = 0; let skipped = 0;
      const errors: any[] = [];
      for (const doc of docs) {
        const rootId = folderMap[doc.contact_id];
        if (!rootId) { skipped++; errors.push({ id: doc.id, reason: 'no_folder' }); continue; }
        const folderId = await resolveSub(rootId, (doc as any).drive_folder || DEFAULT_FOLDER);
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

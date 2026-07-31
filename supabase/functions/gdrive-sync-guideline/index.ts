// gdrive-sync-guideline v4: per-lender subfolders + "Agency Guidelines" subfolder for
// regulator/GSE PDFs (FHA/VA/USDA/Fannie/Freddie) that don't have a lender_id.
// Reads OAuth refresh_token from google_calendar_tokens DB row.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LENDERS_PARENT_FOLDER_ID = "1Pg6GkbwzgiIp3PfZqP4oXycw7tLKUN8p";
const AGENCY_FOLDER_NAME = "Agency Guidelines";

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

async function getUserAccessToken(): Promise<string | null> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;

  const { data: tok } = await sb.from("google_calendar_tokens")
    .select("refresh_token, access_token, expires_at")
    .eq("id", "rene").single();
  if (!tok?.refresh_token) return null;

  if (tok.access_token && tok.expires_at) {
    const expMs = new Date(tok.expires_at).getTime();
    if (expMs - Date.now() > 5 * 60 * 1000) return tok.access_token;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tok.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) return null;

  await sb.from("google_calendar_tokens").update({
    access_token: data.access_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", "rene");
  return data.access_token;
}

async function findFolderByName(token: string, parentId: string, name: string): Promise<string | null> {
  const q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) return null;
  return data.files?.[0]?.id || null;
}

async function createFolder(token: string, parentId: string, name: string): Promise<{ id: string; webViewLink: string } | null> {
  const res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink&supportsAllDrives=true", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) return null;
  return { id: data.id, webViewLink: data.webViewLink };
}

// Cached agency folder id (per cold start). On first lookup we find/create it.
let cachedAgencyFolderId: string | null = null;
async function getAgencyFolder(token: string): Promise<string | null> {
  if (cachedAgencyFolderId) return cachedAgencyFolderId;
  let id = await findFolderByName(token, LENDERS_PARENT_FOLDER_ID, AGENCY_FOLDER_NAME);
  if (!id) {
    const created = await createFolder(token, LENDERS_PARENT_FOLDER_ID, AGENCY_FOLDER_NAME);
    if (!created) return null;
    id = created.id;
  }
  cachedAgencyFolderId = id;
  return id;
}

async function ensureLenderFolder(token: string, lenderId: string, lenderName: string): Promise<string | null> {
  const { data: lender } = await sb.from("lenders")
    .select("gdrive_folder_id, name").eq("id", lenderId).single();
  if (lender?.gdrive_folder_id) return lender.gdrive_folder_id;

  const safeName = (lenderName || "Unknown Lender").replace(/[\\/:*?"<>|]/g, "-").trim().substring(0, 120);
  let folderId = await findFolderByName(token, LENDERS_PARENT_FOLDER_ID, safeName);
  let folderUrl: string | null = null;
  if (!folderId) {
    const created = await createFolder(token, LENDERS_PARENT_FOLDER_ID, safeName);
    if (!created) return null;
    folderId = created.id;
    folderUrl = created.webViewLink;
  }
  if (!folderUrl) folderUrl = `https://drive.google.com/drive/folders/${folderId}`;
  await sb.from("lenders").update({
    gdrive_folder_id: folderId,
    gdrive_folder_url: folderUrl,
  }).eq("id", lenderId);
  return folderId;
}

async function uploadFileToDrive(
  token: string, fileName: string, mimeType: string,
  fileBytes: Uint8Array, folderId: string
): Promise<{ id: string; webViewLink: string } | null> {
  const boundary = "boundary_" + crypto.randomUUID();
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
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  const data = await res.json();
  if (!res.ok || data.error) {
    console.error("[gdrive-guideline] upload error:", JSON.stringify(data).substring(0, 400));
    return null;
  }
  return { id: data.id, webViewLink: data.webViewLink };
}

function sanitize(s: string): string {
  return (s || "").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().substring(0, 150);
}

async function syncOneGuideline(guidelineId: string, token: string): Promise<any> {
  const { data: g, error: gErr } = await sb
    .from("lender_guidelines")
    .select("id, lender_id, title, file_url, file_name, gdrive_file_id, source_type")
    .eq("id", guidelineId).single();
  if (gErr || !g) return { error: "guideline not found" };
  if (g.gdrive_file_id) return { skipped: true, reason: "already synced", gdrive_file_id: g.gdrive_file_id };
  if (!g.file_url) return { error: "no file_url" };

  let folderId: string | null = null;
  let folderLabel = "";

  if (g.lender_id) {
    const { data: lender } = await sb.from("lenders").select("name").eq("id", g.lender_id).single();
    const lenderName = lender?.name || "Unknown Lender";
    folderId = await ensureLenderFolder(token, g.lender_id, lenderName);
    folderLabel = lenderName;
  } else {
    // Agency / GSE / regulator PDF (no specific lender)
    folderId = await getAgencyFolder(token);
    folderLabel = AGENCY_FOLDER_NAME;
  }

  if (!folderId) return { error: "could not get/create destination folder" };

  const fileRes = await fetch(g.file_url);
  if (!fileRes.ok) return { error: `download ${fileRes.status}` };
  const bytes = new Uint8Array(await fileRes.arrayBuffer());

  const niceName = `${sanitize(g.title || g.file_name || "guideline")}.pdf`;
  const result = await uploadFileToDrive(token, niceName, "application/pdf", bytes, folderId);
  if (!result) return { error: "drive upload failed" };

  await sb.from("lender_guidelines").update({
    gdrive_file_id: result.id,
    gdrive_file_url: result.webViewLink,
    gdrive_synced_at: new Date().toISOString(),
  }).eq("id", guidelineId);

  return {
    success: true,
    guideline_id: guidelineId,
    destination: folderLabel,
    name: niceName,
    gdrive_file_id: result.id,
    gdrive_file_url: result.webViewLink,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const body = await req.json().catch(() => ({}));
    const { action } = body;

    if (action === "status") {
      const { count: total } = await sb.from("lender_guidelines")
        .select("*", { count: "exact", head: true })
        .eq("is_active", true).not("file_url", "is", null);
      const { count: synced } = await sb.from("lender_guidelines")
        .select("*", { count: "exact", head: true })
        .eq("is_active", true).not("gdrive_file_id", "is", null);
      const { count: lendersWithFolders } = await sb.from("lenders")
        .select("*", { count: "exact", head: true })
        .not("gdrive_folder_id", "is", null);
      const token = await getUserAccessToken();
      return ok({
        total_active: total || 0,
        synced_to_drive: synced || 0,
        pending: (total || 0) - (synced || 0),
        lenders_with_folders: lendersWithFolders || 0,
        oauth_ok: !!token,
        parent_folder: `https://drive.google.com/drive/folders/${LENDERS_PARENT_FOLDER_ID}`,
        reauth_url: `https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/google-calendar-auth`,
      });
    }

    if (action === "sync_one") {
      const { guideline_id } = body;
      if (!guideline_id) return err("guideline_id required");
      const token = await getUserAccessToken();
      if (!token) return err("OAuth token unavailable. Re-authorize at /functions/v1/google-calendar-auth", 500);
      return ok(await syncOneGuideline(guideline_id, token));
    }

    if (action === "sync_all_pending") {
      const limit = Math.min(parseInt(body.limit) || 25, 50);
      const { data: pending, error: pErr } = await sb
        .from("lender_guidelines")
        .select("id, title")
        .eq("is_active", true)
        .not("file_url", "is", null)
        .is("gdrive_file_id", null)
        .limit(limit);
      if (pErr) return err(pErr.message, 500);
      if (!pending?.length) return ok({ synced: 0, message: "No pending guidelines" });

      const token = await getUserAccessToken();
      if (!token) return err("OAuth token unavailable", 500);

      const results: any[] = [];
      let synced = 0, failed = 0;
      for (const p of pending) {
        try {
          const r = await syncOneGuideline(p.id, token);
          if (r.success) synced++;
          else if (!r.skipped) failed++;
          results.push({ id: p.id, title: p.title, ...r });
        } catch (e: any) {
          failed++;
          results.push({ id: p.id, title: p.title, error: e.message });
        }
      }
      return ok({ synced, failed, attempted: pending.length, results });
    }

    return err("Unknown action");
  } catch (e: any) {
    console.error("[gdrive-sync-guideline] FATAL:", e);
    return err(e.message || String(e), 500);
  }
});

// supabase/functions/gdrive-proxy/index.ts
//
// Google Drive proxy.  Actions:
//   GET  ?action=list-folders&parentId=FOLDER_ID
//   GET  ?action=get-folder&folderId=FOLDER_ID
//   GET  ?action=list-files&folderId=FOLDER_ID
//   GET  ?action=download&fileId=FILE_ID[&download=1]   -> streams bytes (auth as app acct)
//   POST ?action=create-folder    body: { parentId, name }
//   POST ?action=upload-file      body: multipart/form-data { folderId, file }
//   POST ?action=rename           body: { fileId, name }
// Auth: folder ops + reads = service account; file writes (upload/rename) = user OAuth
// token (google_calendar_tokens id='rene'). Deploy with --no-verify-jwt.

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID     = Deno.env.get("GOOGLE_CLIENT_ID") || "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
const USER_TOKEN_ID = "rene";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function err(message: string, status = 500): Response { return json({ error: message }, status); }

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64); const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}
function base64UrlEncode(data: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof data === "string") bytes = new TextEncoder().encode(data);
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else bytes = data;
  let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

let cachedSaToken: { token: string; exp: number } | null = null;
async function getAccessToken(): Promise<string> {
  if (cachedSaToken && cachedSaToken.exp > Date.now() + 60_000) return cachedSaToken.token;
  const rawJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!rawJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  let sa: { client_email: string; private_key: string };
  try { sa = JSON.parse(rawJson); } catch (_e) { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON"); }
  if (!sa.client_email || !sa.private_key) throw new Error("Service account JSON missing client_email or private_key");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive", aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${base64UrlEncode(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedSaToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function getUserAccessToken(): Promise<string | null> {
  try {
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: row } = await sb.from('google_calendar_tokens').select('access_token, refresh_token, expires_at').eq('id', USER_TOKEN_ID).maybeSingle();
    if (!row) { console.error('[drive-auth] no google_calendar_tokens row'); return null; }
    if (new Date(row.expires_at).getTime() > Date.now() + 60000) return row.access_token;
    if (!row.refresh_token || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return row.access_token || null;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET })
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) { console.error('[drive-auth] refresh failed:', JSON.stringify(data)); return row.access_token || null; }
    await sb.from('google_calendar_tokens').update({ access_token: data.access_token, expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(), updated_at: new Date().toISOString() }).eq('id', USER_TOKEN_ID);
    return data.access_token;
  } catch (e: any) { console.error('[drive-auth] error:', e.message); return null; }
}

function withSharedDrives(path: string): string { const sep = path.includes("?") ? "&" : "?"; return `${path}${sep}supportsAllDrives=true&includeItemsFromAllDrives=true`; }
async function driveFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init?.headers); headers.set("Authorization", `Bearer ${token}`);
  return await fetch(`https://www.googleapis.com/drive/v3${withSharedDrives(path)}`, { ...init, headers });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "";

    if (req.method === "GET") {
      if (action === "list-folders") {
        const parentId = url.searchParams.get("parentId");
        if (!parentId) return err("parentId required", 400);
        const q = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
        const r = await driveFetch(`/files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink,createdTime)&pageSize=200&orderBy=name`);
        return json(await r.json(), r.status);
      }
      if (action === "get-folder") {
        const folderId = url.searchParams.get("folderId");
        if (!folderId) return err("folderId required", 400);
        const r = await driveFetch(`/files/${folderId}?fields=id,name,webViewLink,mimeType,parents`);
        return json(await r.json(), r.status);
      }
      if (action === "list-files") {
        const folderId = url.searchParams.get("folderId");
        if (!folderId) return err("folderId required", 400);
        const q = `'${folderId}' in parents and trashed = false`;
        const r = await driveFetch(`/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,webViewLink,webContentLink,size,createdTime,modifiedTime,iconLink,thumbnailLink)&pageSize=500&orderBy=name`);
        return json(await r.json(), r.status);
      }
      if (action === "download") {
        const fileId = url.searchParams.get("fileId") || url.searchParams.get("id");
        if (!fileId) return err("fileId required", 400);
        const metaRes = await driveFetch(`/files/${fileId}?fields=name,mimeType,size`);
        if (!metaRes.ok) return json(await metaRes.json().catch(() => ({})), metaRes.status);
        const meta = await metaRes.json();
        const token = await getAccessToken();
        const media = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
        if (!media.ok) { const t = await media.text(); return err(`Drive download failed: ${media.status} ${t.slice(0,200)}`, media.status); }
        const disp = url.searchParams.get("download") ? "attachment" : "inline";
        const rawName = (meta.name || "file").replace(/"/g, "");
        // HTTP headers must be ASCII (ByteString). Strip non-ASCII for the plain filename,
        // and provide the real UTF-8 name via RFC 5987 filename*.
        const asciiName = rawName.replace(/[^\x20-\x7E]/g, "_");
        const encName = encodeURIComponent(rawName);
        return new Response(media.body, {
          status: 200,
          headers: { ...CORS, "Content-Type": meta.mimeType || "application/octet-stream", "Content-Disposition": `${disp}; filename="${asciiName}"; filename*=UTF-8''${encName}` },
        });
      }
    }

    if (req.method === "POST" && action === "create-folder") {
      let body: { parentId?: string; name?: string };
      try { body = await req.json(); } catch (_e) { return err("Invalid JSON body", 400); }
      const { parentId, name } = body;
      if (!parentId || !name) return err("parentId and name required", 400);
      const r = await driveFetch("/files?fields=id,name,webViewLink,parents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }) });
      return json(await r.json(), r.status);
    }

    if (req.method === "POST" && action === "rename") {
      let body: { fileId?: string; name?: string };
      try { body = await req.json(); } catch (_e) { return err("Invalid JSON body", 400); }
      const { fileId, name } = body;
      if (!fileId || !name || !String(name).trim()) return err("fileId and name required", 400);
      const token = await getUserAccessToken();
      if (!token) return err("User OAuth token fetch failed", 500);
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true&fields=id,name,modifiedTime`, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: String(name).trim() }) });
      return json(await r.json(), r.status);
    }

    if (req.method === "POST" && action === "upload-file") {
      let form: FormData;
      try { form = await req.formData(); } catch (_e) { return err("Expected multipart/form-data body", 400); }
      const folderId = form.get("folderId"); const file = form.get("file");
      if (!folderId || typeof folderId !== "string") return err("folderId field required", 400);
      if (!(file instanceof File)) return err("file field required (must be a File)", 400);
      const token = await getUserAccessToken();
      if (!token) return err("User OAuth token fetch failed", 500);
      const boundary = "boundary_" + crypto.randomUUID();
      const metadata = JSON.stringify({ name: file.name, parents: [folderId] });
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      const encoder = new TextEncoder();
      const head = encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${file.type || "application/octet-stream"}\r\n\r\n`);
      const tail = encoder.encode(`\r\n--${boundary}--`);
      const body = new Uint8Array(head.length + fileBytes.length + tail.length);
      body.set(head, 0); body.set(fileBytes, head.length); body.set(tail, head.length + fileBytes.length);
      const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,mimeType,size,modifiedTime", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body });
      return json(await r.json(), r.status);
    }

    return err(`Unknown action: ${action || "(none)"}`, 400);
  } catch (e) {
    console.error("[gdrive-proxy]", e);
    return err((e as Error).message || String(e), 500);
  }
});

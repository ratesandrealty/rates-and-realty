// supabase/functions/gdrive-proxy/index.ts
//
// Google Drive proxy — authenticates via the GOOGLE_SERVICE_ACCOUNT_JSON
// secret (service account), mints an RS256 JWT, exchanges it for an OAuth2
// access token, then proxies a handful of Drive v3 operations.
//
// Supported actions:
//   GET  ?action=list-folders&parentId=FOLDER_ID
//   GET  ?action=get-folder&folderId=FOLDER_ID
//   GET  ?action=list-files&folderId=FOLDER_ID
//   POST ?action=create-folder    body: { parentId, name }
//   POST ?action=upload-file      body: multipart/form-data { folderId, file }
//
// Deploy with --no-verify-jwt so browser clients can call it directly.

const CORS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function err(message: string, status = 500): Response {
  return json({ error: message }, status);
}

// ── PEM → CryptoKey ──────────────────────────────────────────────
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64UrlEncode(data: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof data === "string") bytes = new TextEncoder().encode(data);
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else bytes = data;
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// ── OAuth2 token cache (per-isolate) ─────────────────────────────
let cachedToken: { token: string; exp: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const rawJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!rawJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");

  let sa: { client_email: string; private_key: string };
  try {
    sa = JSON.parse(rawJson);
  } catch (_e) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error("Service account JSON missing client_email or private_key");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encHeader = base64UrlEncode(JSON.stringify(header));
  const encPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encHeader}.${encPayload}`;

  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${base64UrlEncode(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${txt}`);
  }
  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    exp: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

async function driveFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return await fetch(`https://www.googleapis.com/drive/v3${path}`, {
    ...init,
    headers,
  });
}

// ── Main handler ─────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "";

    if (req.method === "GET") {
      if (action === "list-folders") {
        const parentId = url.searchParams.get("parentId");
        if (!parentId) return err("parentId required", 400);
        const q =
          `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
        const r = await driveFetch(
          `/files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink,createdTime)&pageSize=200&orderBy=name`,
        );
        return json(await r.json(), r.status);
      }

      if (action === "get-folder") {
        const folderId = url.searchParams.get("folderId");
        if (!folderId) return err("folderId required", 400);
        const r = await driveFetch(
          `/files/${folderId}?fields=id,name,webViewLink,mimeType,parents`,
        );
        return json(await r.json(), r.status);
      }

      if (action === "list-files") {
        const folderId = url.searchParams.get("folderId");
        if (!folderId) return err("folderId required", 400);
        const q = `'${folderId}' in parents and trashed = false`;
        const r = await driveFetch(
          `/files?q=${
            encodeURIComponent(q)
          }&fields=files(id,name,mimeType,webViewLink,webContentLink,size,createdTime,modifiedTime,iconLink,thumbnailLink)&pageSize=500&orderBy=name`,
        );
        return json(await r.json(), r.status);
      }
    }

    if (req.method === "POST" && action === "create-folder") {
      let body: { parentId?: string; name?: string };
      try {
        body = await req.json();
      } catch (_e) {
        return err("Invalid JSON body", 400);
      }
      const { parentId, name } = body;
      if (!parentId || !name) return err("parentId and name required", 400);

      const r = await driveFetch("/files?fields=id,name,webViewLink,parents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentId],
        }),
      });
      return json(await r.json(), r.status);
    }

    if (req.method === "POST" && action === "upload-file") {
      let form: FormData;
      try {
        form = await req.formData();
      } catch (_e) {
        return err("Expected multipart/form-data body", 400);
      }
      const folderId = form.get("folderId");
      const file = form.get("file");
      if (!folderId || typeof folderId !== "string") {
        return err("folderId field required", 400);
      }
      if (!(file instanceof File)) {
        return err("file field required (must be a File)", 400);
      }

      // Build a multipart/related body by hand. Drive's /upload endpoint
      // expects: metadata part (JSON) + media part (file bytes) separated
      // by a unique boundary string.
      const token = await getAccessToken();
      const boundary = "boundary_" + crypto.randomUUID();
      const metadata = JSON.stringify({
        name: file.name,
        parents: [folderId],
      });
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      const encoder = new TextEncoder();
      const head = encoder.encode(
        `--${boundary}\r\n` +
          `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
          metadata + `\r\n` +
          `--${boundary}\r\n` +
          `Content-Type: ${file.type || "application/octet-stream"}\r\n\r\n`,
      );
      const tail = encoder.encode(`\r\n--${boundary}--`);
      const body = new Uint8Array(head.length + fileBytes.length + tail.length);
      body.set(head, 0);
      body.set(fileBytes, head.length);
      body.set(tail, head.length + fileBytes.length);

      const r = await fetch(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,mimeType,size,modifiedTime",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
          body,
        },
      );
      return json(await r.json(), r.status);
    }

    return err(`Unknown action: ${action || "(none)"}`, 400);
  } catch (e) {
    console.error("[gdrive-proxy]", e);
    return err((e as Error).message || String(e), 500);
  }
});

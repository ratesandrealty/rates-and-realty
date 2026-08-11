// supabase/functions/gdrive-proxy/index.ts
//
// Google Drive proxy.  Actions:
//   GET  ?action=list-folders&parentId=FOLDER_ID
//   GET  ?action=get-folder&folderId=FOLDER_ID
//   GET  ?action=list-files&folderId=FOLDER_ID
//   GET  ?action=download&fileId=FILE_ID[&download=1]   -> streams bytes (auth as app acct)
//   POST ?action=create-borrower-folder  body: { contact_id }
// EVERY action requires a staff session or the service key (requireStaff).
//   POST ?action=create-folder    body: { parentId, name }
//   POST ?action=upload-file      body: multipart/form-data { folderId, file }
//   POST ?action=rename           body: { fileId, name }
// Auth: folder ops + reads = service account; file writes (upload/rename) = user OAuth
// token (google_calendar_tokens id='rene').
// verify_jwt stays FALSE and is not the control — requireStaff() in-function is.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireStaff } from "../_shared/require-staff.ts";

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

/* BORROWERS_ROOT (11OLUA6Fu3tNrzWP8O1v_pFjl-UGbzos6) used to live here, as the
 * parent create-borrower-folder hung new folders from. It is gone with the
 * bare-folder path: Borrower Stage Foldering parents them under
 * Borrowers/{Stage}/{Partner or Rene's Clients} from its own stage map, and a
 * second copy of a Drive id nothing reads is how the two drift apart. */

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "";

    /* ── CALLER AUTHENTICATION FOR EVERY ACTION ───────────────────────────
     *
     * Until 2026-08-11 this function had none at all, with verify_jwt = false,
     * and its writes use rene@'s USER OAuth token — so an unauthenticated
     * caller could create, rename, upload and trash files in his Drive.
     *
     * `download` WAS exempt until 2026-08-11 and no longer is. Two call sites
     * handed the URL to the browser as an <a href>, and a navigation cannot
     * carry an Authorization header — that, and only that, kept it open. Both
     * now use _gpDownloadFile() in lead-detail.html: authenticated fetch, blob,
     * synthetic <a download>. The same pattern the file already used three
     * times, so no signed URL and no second credential type were needed.
     * Frontend shipped first and was confirmed working before this line changed.
     *
     * Everything else was already sending the session token, which is why this
     * needed no frontend-first staging. Verified caller by caller before
     * writing it:
     *   lead-detail.html   13 fetch sites, all authenticated (several via the
     *                      `gp` header object, one of which is a function
     *                      PARAMETER — an earlier count that grepped for a
     *                      literal "Authorization" missed those and wrongly
     *                      reported 10 unauthenticated sites)
     *   admin-dashboard.js create-borrower-folder, session token
     *   gdrive-sync        resolve-folder, Bearer SERVICE_KEY
     *   n8n Lender Folder Creator  create-folder, service_role credential
     *
     * No allowInternal: nothing reaches this from Postgres. The one server
     * caller presents the service key, which requireStaff already accepts.
     *
     * trash-file keeps its own check below as well — it was guarded first, on
     * its own, and a destructive action should not depend on a shared gate
     * staying correct. */
    const _a = await requireStaff(req, { what: "Drive access" });
    if (!_a.ok) return err(_a.msg || "not authorized", _a.status || 401);

    /* ── create-borrower-folder ────────────────────────────────────────────
     *
     * Replaces the n8n "Contact Folder Creator" workflow, which was:
     *   unauthenticated webhook -> gdrive-proxy create-folder -> PATCH contacts
     *
     * Removing the n8n hop removes the problem rather than guarding it. That
     * webhook took no credentials, and it could not be fixed with a header
     * because both callers are browsers — a header they can send is public.
     * Here the caller presents its SESSION and the server does the rest.
     *
     * BOTH GUARDS LIVE HERE NOW, and the second is new:
     *
     * 1. The is.null guard, carried over from the workflow draft published
     *    2026-08-11 (proven by execution 6690). The PATCH only fills a folder
     *    id that is still empty, so a second call can never overwrite one and
     *    strand the folder it replaced — with borrower documents in it.
     *
     * 2. DO NOT CREATE WHEN ONE ALREADY EXISTS. The workflow lacked this: it
     *    created a folder and then declined to record it, so every re-click
     *    left an orphan nobody points at (execution 6690 made one). Checking
     *    first means the wasted folder never exists. Guard 1 stays anyway —
     *    it is the race backstop when two callers pass the check together.
     *
     * verify_jwt is false on this function and the OTHER actions are still
     * unguarded — see the note in config.toml. This action is guarded from
     * birth, which is why it needs no frontend-first staging: it has no
     * existing callers to break. */
    if (req.method === "POST" && action === "create-borrower-folder") {
      const auth = await requireStaff(req, { what: "Creating a borrower folder" });
      if (!auth.ok) return err(auth.msg || "not authorized", auth.status || 401);

      let body: { contact_id?: string };
      try { body = await req.json(); } catch (_e) { return err("Invalid JSON body", 400); }
      const contactId = String(body.contact_id || "").trim();
      if (!contactId) return err("contact_id required", 400);

      const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      const { data: contact, error: cErr } = await db.from("contacts")
        .select("id, first_name, last_name, gdrive_folder_id, gdrive_folder_url")
        .eq("id", contactId).maybeSingle();
      if (cErr) return err(`contact lookup failed: ${cErr.message}`, 500);
      if (!contact) return err("contact not found", 404);

      // GUARD 2 — already has one. Nothing is created, so nothing is stranded.
      if (contact.gdrive_folder_id) {
        return json({
          ok: true, already_existed: true,
          folder_id: contact.gdrive_folder_id, folder_url: contact.gdrive_folder_url,
        }, 200);
      }

      /* ── THE BUTTON HANDS OFF TO BORROWER STAGE FOLDERING ─────────────────
       *
       * It used to create ONE bare folder at BORROWERS_ROOT and stamp
       * gdrive_folder_id itself. That did not merely do half the job — IT
       * PERMANENTLY PREVENTED THE OTHER HALF.
       *
       * Workflow 3MgNXjZrcCm7c8gy branches on "Borrower Folder Exists?", which
       * is true whenever contacts.gdrive_folder_id is set. The true branch is
       * Get Current Parents -> Move Borrower Folder and it ENDS there. The
       * eleven subfolders hang off the FALSE branch only. So the moment this
       * endpoint stamped the id, the only branch that ever creates subfolders
       * could never run for that borrower again, and no later stage change
       * repaired it — each one just moved the empty folder to a new stage.
       * The folder was also parented at BORROWERS_ROOT rather than
       * Borrowers/{Stage}/{Partner or Rene's Clients}, and the PATCH fired
       * neither foldering trigger (they watch pipeline_status and
       * referral_partner_id, not this column).
       *
       * So the button now POSTs the SAME webhook the DB trigger posts, with
       * the same {record: <contact row>} shape, and lets one path build
       * partner folder + borrower folder + subfolders in the right place.
       * The subfolder list stays in exactly one place — that workflow — and is
       * deliberately NOT copied here.
       *
       * THE CREDENTIAL IS WHY THIS IS THE RIGHT HAND-OFF, not just the tidy
       * one. The workflow's Drive nodes use googleDriveOAuth2Api — rene@'s user
       * OAuth through n8n's client. Building the same tree here would use the
       * service account (driveFetch -> getAccessToken mints an SA JWT), and
       * CLAUDE.md records that SA-created structure silently guts the Drive
       * write health probe, because a token holding only drive.file can still
       * write into folders it created.
       *
       * The n8n webhook takes no credentials, which is what the retired
       * "Contact Folder Creator" hop was criticised for. That is unchanged and
       * is not reintroduced here: the browser still cannot reach it. It calls
       * THIS endpoint, which is behind requireStaff, and the webhook is only
       * ever posted server-side — same as the DB trigger already does. */
      const { data: full, error: fErr } = await db.from("contacts")
        .select("*").eq("id", contactId).maybeSingle();
      if (fErr || !full) return err(`contact reload failed: ${fErr?.message || "not found"}`, 500);

      /* responseMode:lastNode — the webhook does not answer until the workflow
       * finishes, which is what makes the writeback readable below. Measured at
       * ~12s for the create path, so the timeout is generous but bounded: a
       * hung n8n must not hold the request open until the platform kills it. */
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 45_000);
      let hookStatus = 0;
      try {
        /* Same URL and same body shape as notify_borrower_foldering(). If one
         * moves, move both — they are the two callers of this webhook. */
        const hook = await fetch("https://ratesandrealty.app.n8n.cloud/webhook/borrower-stage-foldering", {
          method: "POST", signal: ctl.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ record: full }),
        });
        hookStatus = hook.status;
        await hook.text().catch(() => "");
      } catch (e) {
        clearTimeout(timer);
        return err(`foldering webhook did not answer: ${String((e as Error)?.message || e)}`, 504);
      }
      clearTimeout(timer);

      /* THE WORKFLOW OWNS THE WRITEBACK — "Save Folder Id To Contact" PATCHes
       * gdrive_folder_id itself. So this endpoint no longer writes that column
       * at all, which also retires the old is.null race guard: there is only
       * one writer again. Read the row back rather than trusting the 200, the
       * same reason CLAUDE.md gives for reading n8n execution data instead of
       * the tool's echo. */
      const { data: after } = await db.from("contacts")
        .select("gdrive_folder_id, gdrive_folder_url, pipeline_status")
        .eq("id", contactId).maybeSingle();

      if (!after?.gdrive_folder_id) {
        /* THE WRITEBACK IS THE SIGNAL, NOT THE STATUS CODE — measured, not
         * assumed. Route By Stage returns [] for any pipeline_status outside
         * its map, and the workflow then does nothing, SUCCESSFULLY: execution
         * 6717 is recorded `success` while the webhook answered HTTP 500,
         * because responseMode:lastNode with responseData:firstEntryJson has no
         * item to serialise. So a 500 here routinely means "nothing to do", and
         * treating it as a failure would report an unmapped stage as an outage.
         * Hence the status is reported for diagnosis and never branched on.
         *
         * The stage is named rather than the stage map being duplicated here —
         * the map lives in the workflow, with the subfolder list. */
        return err(
          `Borrower Stage Foldering ran (webhook answered HTTP ${hookStatus}) but filed nothing. `
          + `This contact's pipeline status is "${after?.pipeline_status ?? "unknown"}" — `
          + `only the stages that workflow maps get a folder. Move the lead to a mapped stage and try again.`,
          409,
        );
      }

      return json({
        ok: true, created: true,
        folder_id: after.gdrive_folder_id,
        folder_url: after.gdrive_folder_url || `https://drive.google.com/drive/folders/${after.gdrive_folder_id}`,
        // Says what was built, so the caller can tell this apart from the old
        // single-folder behaviour without inspecting Drive.
        foldered_by: "borrower-stage-foldering",
        subfolders: true,
      }, 200);
    }

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

    /* resolve-folder: find a named subfolder under a parent, create it if absent.
     *
     * This logic used to live only in lpSectionUpload (admin/lead-detail.html),
     * which is why the admin uploader files into "Initial Loan Submission" while
     * gdrive-sync dumps portal and SMS uploads at the folder root — two callers,
     * one of which simply did not have the resolver. It lives here now so both
     * use the same one. Matching is case-insensitive on the trimmed name; the
     * folder is created with the caller's exact casing when it does not exist. */
    if (req.method === "POST" && action === "resolve-folder") {
      const body = await req.json().catch(() => ({}));
      const parentId = String(body.parentId || "");
      const name = String(body.name || "").trim();
      if (!parentId || !name) return err("parentId and name required", 400);
      const q = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
      const lr = await driveFetch(`/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=200`);
      const ld = await lr.json();
      const want = name.toLowerCase();
      const hit = (ld.files || []).find((f: any) => String(f.name || "").trim().toLowerCase() === want);
      if (hit) return json({ id: hit.id, name: hit.name, created: false });
      const cr = await driveFetch(`/files?fields=id,name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
      });
      const cd = await cr.json();
      if (!cr.ok || !cd.id) return err(cd?.error?.message || `create-folder HTTP ${cr.status}`, 500);
      return json({ id: cd.id, name: cd.name, created: true });
    }

    /* trash-file: move a Drive item the SERVICE ACCOUNT OWNS to the trash.
     *
     * Deliberately trash, not delete — Drive keeps it ~30 days, so a wrong id is
     * recoverable. The SA cannot touch files owned by rene@ (a PATCH there
     * returns 403), so the blast radius is limited to things this app created,
     * which is the correct boundary for an endpoint reachable with a service
     * key. */
    if (req.method === "POST" && action === "trash-file") {
      /* ── WHO may ask, as distinct from WHAT may be trashed ────────────────
       *
       * The two guards below constrain the TARGET and are good. They never
       * constrained the CALLER: until 2026-08-11 this function had no auth of
       * any kind and verify_jwt = false, so anyone who knew the URL could ask
       * to trash a file. The target guards limited the blast radius; they did
       * not make the endpoint anybody's to invoke.
       *
       * Guarded on its own, ahead of the other actions, because the usual
       * frontend-first staging does not apply: trash-file has NO caller
       * anywhere — not in this repo, not in any of the 11 n8n workflows, not in
       * any of the 45 cron jobs. There is no legitimate traffic to break, and
       * it is the one action with no undo. A trashed Drive item sits in the bin
       * for 30 days and nothing here restores it.
       *
       * No allowInternal: nothing reaches this from Postgres, and widening the
       * guard for a caller that does not exist is how a check meant for one
       * path ends up covering a destructive one. This IS the destructive one. */
      const _auth = await requireStaff(req, { what: "Trashing a Drive file" });
      if (!_auth.ok) return err(_auth.msg || "not authorized", _auth.status || 401);

      /* Two explicit guards, checked BEFORE the PATCH.
       *
       * The original version relied on Google returning 403 for anything the
       * service account does not own. That is a guard we neither wrote nor
       * control: one sharing change, one ownership transfer, one shift in
       * Google's permission model, and a delete endpoint reachable with a
       * service key becomes unguarded — and nobody would notice until something
       * was gone. The constraint has to be ours and it has to be stated.
       *
       * Guard 1: the SA must OWN the target. Ownership is asserted from the
       * metadata, not inferred from an error we hope to receive.
       * Guard 2: the target must not sit anywhere inside a borrower's folder
       * tree, EVEN IF the SA owns it — which is exactly the case that occurred:
       * a health-check folder created by the SA inside a real borrower's Drive
       * folder was SA-owned and therefore trashable under guard 1 alone.
       */
      const body = await req.json().catch(() => ({}));
      const fileId = String(body.fileId || "");
      if (!fileId) return err("fileId required", 400);

      const caller = req.headers.get("x-client-info") || req.headers.get("user-agent") || "unknown";
      console.log(`[gdrive-proxy] trash-file REQUESTED id=${fileId} caller=${caller}`);

      /* ── The fixture exemption ────────────────────────────────────────────
       *
       * The two guards below are written for borrower folders, and they refuse
       * the ZZ-TEST fixture's folder for the same reasons they refuse a real
       * one: files written there by the production upload path are owned by
       * rene@ rather than the service account, and the fixture is a contact
       * row, so its folder is inside "a borrower's tree" as far as guard 2 can
       * tell. The result was a dedicated test location that could be written to
       * and never cleaned up — which is how litter ends up somewhere worse.
       *
       * The exemption is keyed to the fixture identity CLAUDE.md prescribes:
       * first_name 'ZZ-TEST' AND lead_source 'automated-test'. Renaming a real
       * contact to ZZ-TEST is not enough to unlock it. Nothing widens for any
       * other contact — for every real borrower both guards apply unchanged.
       *
       * It also has to trash with the USER token, not the service account: the
       * SA cannot modify a file it does not own, so routing this through
       * driveFetch would fail even with the guards satisfied. */
      const sbFix = createClient(SUPABASE_URL, SERVICE_KEY);
      const { data: fixture } = await sbFix.from("contacts")
        .select("id, gdrive_folder_id")
        .eq("first_name", "ZZ-TEST").eq("lead_source", "automated-test")
        .not("gdrive_folder_id", "is", null).maybeSingle();

      if (fixture?.gdrive_folder_id) {
        const fixtureRoot = String(fixture.gdrive_folder_id);
        const fm = await driveFetch(`/files/${encodeURIComponent(fileId)}?fields=id,name,parents&supportsAllDrives=true`);
        if (fm.ok) {
          const fmd = await fm.json();
          let cur: string[] = fmd.parents || [];
          let inFixture = false;
          for (let depth = 0; depth < 4 && cur.length && !inFixture; depth++) {
            if (cur.includes(fixtureRoot)) { inFixture = true; break; }
            const nxt: string[] = [];
            for (const pid of cur) {
              const pr = await driveFetch(`/files/${encodeURIComponent(pid)}?fields=parents&supportsAllDrives=true`);
              if (!pr.ok) continue;
              const pd = await pr.json();
              for (const gp of pd.parents || []) nxt.push(gp);
            }
            cur = nxt;
          }
          if (inFixture) {
            const utok = await getUserAccessToken();
            if (!utok) return err("fixture cleanup: user OAuth token fetch failed", 500);
            const tr = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
              method: "PATCH",
              headers: { Authorization: `Bearer ${utok}`, "Content-Type": "application/json" },
              body: JSON.stringify({ trashed: true }),
            });
            const td = await tr.json().catch(() => ({}));
            if (!tr.ok) return err(td?.error?.message || `fixture trash HTTP ${tr.status}`, tr.status);
            console.log(`[gdrive-proxy] trash-file DONE (fixture) id=${fileId} name=${fmd.name} caller=${caller}`);
            return json({ id: fileId, name: fmd.name, trashed: true, via: "fixture-exemption" });
          }
        }
      }

      const mr = await driveFetch(`/files/${encodeURIComponent(fileId)}?fields=id,name,owners(emailAddress),parents,trashed&supportsAllDrives=true`);
      const meta = await mr.json();
      if (!mr.ok) return err(meta?.error?.message || `metadata HTTP ${mr.status}`, mr.status);

      // ── Guard 1: SA ownership ──
      const saEmail = (() => {
        try { return JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") || "{}").client_email || ""; }
        catch { return ""; }
      })();
      const owners: string[] = (meta.owners || []).map((o: any) => String(o.emailAddress || ""));
      if (!saEmail || !owners.includes(saEmail)) {
        console.error(`[gdrive-proxy] trash-file REFUSED (not SA-owned) id=${fileId} owners=${owners.join(",")} caller=${caller}`);
        return err(`Refused: ${meta.name} is not owned by the service account (owners: ${owners.join(", ") || "unknown"})`, 403);
      }

      // ── Guard 2: never inside a borrower folder tree ──
      const sbClient = createClient(SUPABASE_URL, SERVICE_KEY);
      const { data: folders } = await sbClient.from("contacts")
        .select("id, gdrive_folder_id").not("gdrive_folder_id", "is", null);
      const borrowerRoots = new Map<string, string>();
      for (const f of folders || []) borrowerRoots.set(String((f as any).gdrive_folder_id), String((f as any).id));

      let cursor: string[] = meta.parents || [];
      for (let depth = 0; depth < 8 && cursor.length; depth++) {
        for (const pid of cursor) {
          if (borrowerRoots.has(pid)) {
            console.error(`[gdrive-proxy] trash-file REFUSED (inside borrower folder ${pid}) id=${fileId} caller=${caller}`);
            return err(`Refused: ${meta.name} is inside a borrower's Drive folder (contact ${borrowerRoots.get(pid)}). Nothing under a borrower folder may be trashed through this endpoint.`, 403);
          }
        }
        const next: string[] = [];
        for (const pid of cursor) {
          const pr = await driveFetch(`/files/${encodeURIComponent(pid)}?fields=parents&supportsAllDrives=true`);
          if (!pr.ok) continue;
          const pd = await pr.json();
          for (const gp of pd.parents || []) next.push(gp);
        }
        cursor = next;
      }

      const r = await driveFetch(`/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trashed: true }),
      });
      const d = await r.json();
      if (!r.ok) return err(d?.error?.message || `trash HTTP ${r.status}`, r.status);
      console.log(`[gdrive-proxy] trash-file DONE id=${fileId} name=${d.name} caller=${caller}`);
      return json({ id: d.id, name: d.name, trashed: d.trashed });
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

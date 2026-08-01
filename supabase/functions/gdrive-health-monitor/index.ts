// gdrive-health-monitor v3: SMS link rendering fixed — iOS Messages was visually
// word-wrapping the long supabase.co URL by inserting a soft hyphen mid-domain
// (rendering as 'su-pabase.co'). Fix is to put the URL on its own line with
// surrounding blank lines so iOS does not try to break it inside a paragraph.
// Also added explicit 'Link:' label so users know to copy the whole next line.
//
// Runs every 6h via pg_cron. Sends SMS to Rene with diagnostic + remediation.
// 12h cooldown per alert key to prevent spam.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { reconcileStorage } from "../_shared/storage-reconcile.ts";
import { getDriveRefreshToken } from "../_shared/google-user-token.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_PHONE = "+17144728508";
const REAUTH_URL = "https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/google-calendar-auth";
const SUPABASE_SECRETS_URL = "https://supabase.com/dashboard/project/ljywhvbmsibwnssxpesh/settings/functions";
const ALERT_COOLDOWN_HOURS = 12;
/* Alert prefix. This was emitted as a bare ${RED} by the script that generated
 * the alert branches, with no such constant in scope — so the monitor threw
 * "RED is not defined" as soon as one of those branches was selected, and
 * returned NO alert at all. It went unnoticed because the branch that was
 * previously selected used a literal emoji; the reconciliation check going
 * unhealthy is what finally routed execution through a broken one.
 *
 * A monitor that throws is worse than a monitor that reports a problem: the
 * cron discards the 500 and nobody hears anything. */
const RED = "\uD83D\uDD34";

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

interface OAuthCheck {
  ok: boolean;
  reason?: string;
  failure_kind?: "missing_secrets" | "no_refresh_token" | "invalid_grant" | "revoked" | "network" | "unknown";
}

async function checkOAuth(): Promise<OAuthCheck> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      failure_kind: "missing_secrets",
      reason: "GOOGLE_CLIENT_ID/SECRET missing in Supabase secrets",
    };
  }

  const { data: tok } = await sb.from("google_calendar_tokens")
    .select("refresh_token, expires_at")
    .eq("id", "rene").single();
  if (!tok?.refresh_token) {
    return {
      ok: false,
      failure_kind: "no_refresh_token",
      reason: "No refresh_token saved",
    };
  }

  try {
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
    if (res.ok && data.access_token) return { ok: true };

    const errCode = (data.error || "").toLowerCase();
    const errDesc = (data.error_description || "").toLowerCase();
    const reasonRaw = `${data.error || `HTTP ${res.status}`}${data.error_description ? ": " + data.error_description : ""}`.substring(0, 200);

    let kind: OAuthCheck["failure_kind"] = "unknown";
    if (errCode === "invalid_grant") {
      // invalid_grant from Google = token was revoked, expired, or password changed
      kind = errDesc.includes("expired") ? "invalid_grant" : "revoked";
    } else if (errCode === "invalid_client") {
      kind = "missing_secrets";
    }
    return { ok: false, failure_kind: kind, reason: reasonRaw };
  } catch (e: any) {
    return { ok: false, failure_kind: "network", reason: `Network error: ${e.message}` };
  }
}

interface SyncCheck {
  ok: boolean;
  pending: number;
  oldest_age_hours?: number;
}

async function checkPendingSyncs(): Promise<SyncCheck> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: pending } = await sb
    .from("lender_guidelines")
    .select("id, created_at")
    .eq("is_active", true)
    .not("file_url", "is", null)
    .is("gdrive_file_id", null)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(50);
  const count = pending?.length || 0;
  if (!count) return { ok: true, pending: 0 };
  const oldest = pending![0].created_at;
  const ageHours = (Date.now() - new Date(oldest).getTime()) / 3600000;
  return { ok: false, pending: count, oldest_age_hours: Math.round(ageHours) };
}

/* INDEXING HEALTH — a guideline the AI cannot read must not sit silently.
 *
 * Two states, both of which produced an invisible document before:
 *   done + 0 chunks  — the row says indexed, the corpus has nothing. A search
 *                      returns no hit and there is no way to tell that from
 *                      "this guideline doesn't cover it".
 *   running > 6h     — the auto-resume cron runs every 5 minutes, so anything
 *                      still running after six hours is not progressing, it is
 *                      stuck. USDA HB-1-3560 sat in a terminal state for three
 *                      months and nothing retried or reported it; that is the
 *                      failure this check exists to make loud.
 *
 * skipped_oversize is included too: it should no longer be reachable now that
 * chunk-guidelines hands off instead of skipping, so seeing one means the
 * handoff regressed. */
type IndexCheck = { ok: boolean; done_no_chunks: any[]; stuck_running: any[]; skipped: any[] };

async function checkIndexingHealth(): Promise<IndexCheck> {
  const stuckCutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { data: rows } = await sb
    .from("lender_guidelines")
    .select("id, title, chunk_status, chunk_count, updated_at, last_page_processed, ocr_page_count")
    .eq("is_active", true)
    .not("file_url", "is", null)
    .limit(500);
  const all = rows || [];
  const doneNoChunks = all.filter((r: any) => r.chunk_status === "done" && !(r.chunk_count > 0));
  const stuckRunning = all.filter((r: any) => r.chunk_status === "running" && (r.updated_at || "") < stuckCutoff);
  const skipped = all.filter((r: any) => r.chunk_status === "skipped_oversize");
  return {
    ok: !doneNoChunks.length && !stuckRunning.length && !skipped.length,
    done_no_chunks: doneNoChunks, stuck_running: stuckRunning, skipped,
  };
}

function buildIndexingAlert(c: IndexCheck): { key: string; message: string } {
  const name = (r: any) => `${r.title || r.id}${r.ocr_page_count ? ` (${r.ocr_page_count}p)` : ""}`;
  const lines: string[] = ["\u26a0\ufe0f Lender guidelines the AI cannot read", ""];
  if (c.done_no_chunks.length) {
    lines.push(`${c.done_no_chunks.length} marked INDEXED but hold zero chunks:`);
    for (const r of c.done_no_chunks.slice(0, 8)) lines.push(`  \u2022 ${name(r)}`);
    lines.push("");
  }
  if (c.stuck_running.length) {
    lines.push(`${c.stuck_running.length} stuck INDEXING for over 6h (cron runs every 5 min):`);
    for (const r of c.stuck_running.slice(0, 8)) {
      lines.push(`  \u2022 ${name(r)} — page ${r.last_page_processed ?? 0} of ${r.ocr_page_count ?? "?"}`);
    }
    lines.push("");
  }
  if (c.skipped.length) {
    lines.push(`${c.skipped.length} SKIPPED as oversize — this should be unreachable, the handoff has regressed:`);
    for (const r of c.skipped.slice(0, 8)) lines.push(`  \u2022 ${name(r)}`);
    lines.push("");
  }
  lines.push("These documents look present in the guidelines list but return nothing in AI search.");
  lines.push("");
  lines.push("To retry one:");
  lines.push(...urlBlock(`${SUPABASE_URL}/functions/v1/chunk-guidelines-large`));
  lines.push('   with body: {"guideline_id":"<id>"}');
  return { key: "guidelines_unindexed", message: lines.join("\n") };
}

/* THE DRIVE *WRITE* CREDENTIAL — a different credential from checkOAuth's.
 *
 * checkOAuth exercises google_calendar_tokens.refresh_token (row id='rene').
 * gdrive-sync and gdrive-proxy's upload path use the GOOGLE_DRIVE_REFRESH_TOKEN
 * *secret*. Those are two different grants, and this monitor was only ever
 * testing the first one — which is why it reported oauth_ok:true for hours
 * while every document mirror was failing with invalid_grant.
 *
 * It also has to run REGARDLESS OF BACKLOG. gdrive-sync returns
 * {"synced":0,"message":"No pending docs"} and never reaches the token call
 * when nothing is queued, so the pipeline reports healthy precisely when it is
 * idle — and then fails on the first real upload. Health has to be measured by
 * doing the thing, not by the absence of complaints.
 *
 * Two steps, because they fail differently: exchange the refresh token (catches
 * expiry/revocation), then make a trivial authenticated Drive call (catches a
 * token that mints fine but has lost its scopes). */
type CredCheck = { ok: boolean; stage?: string; reason?: string; user?: string; scopes?: string[]; wrote?: string };

async function checkDriveWriteCredential(): Promise<CredCheck> {
  /* Resolve exactly as gdrive-sync does. Probing the secret while the mirror
   * reads the row would recreate the original bug in mirror image: a monitor
   * confidently reporting on a credential nothing uses. */
  const { token: refresh, source: tokenSource } = await getDriveRefreshToken(sb);
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!refresh || !clientId || !clientSecret) {
    return { ok: false, stage: "config", reason: `no refresh token (source=${tokenSource}) or CLIENT_ID/SECRET unset` };
  }

  // ── 1. exchange ──
  let access = "";
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId, client_secret: clientSecret }),
    });
    const d = await r.json();
    if (!r.ok || !d.access_token) {
      return { ok: false, stage: "token_exchange",
               reason: `${d.error || `HTTP ${r.status}`}${d.error_description ? ": " + d.error_description : ""}`.slice(0, 200) };
    }
    access = d.access_token;
  } catch (e) {
    return { ok: false, stage: "token_exchange", reason: String(e).slice(0, 200) };
  }

  /* ── 2. SCOPE. A token minted with drive.file exchanges cleanly and reads
   * /about perfectly well while being unable to write into any folder the app
   * did not create — which is every borrower folder, since n8n makes those.
   * That is precisely the gap that hid for months, so the scope is asserted
   * rather than assumed. */
  let scopes: string[] = [];
  try {
    const ti = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(access)}`);
    const td = await ti.json();
    scopes = String(td.scope || "").split(/\s+/).filter(Boolean);
  } catch (e) {
    return { ok: false, stage: "tokeninfo", reason: String(e).slice(0, 200) };
  }
  const FULL_DRIVE = "https://www.googleapis.com/auth/drive";
  if (!scopes.includes(FULL_DRIVE)) {
    return { ok: false, stage: "scope",
             reason: `token lacks ${FULL_DRIVE} — has [${scopes.join(", ")}]. drive.file cannot write into borrower folders created by n8n. Re-authorise at /functions/v1/google-calendar-auth`,
             scopes };
  }

  // ── 3. read ──
  let user = "";
  try {
    const r = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
      headers: { Authorization: `Bearer ${access}` } });
    const d = await r.json();
    if (!r.ok) return { ok: false, stage: "drive_call", reason: `${d?.error?.message || r.status}`.slice(0, 200), scopes };
    user = d?.user?.emailAddress || "";
  } catch (e) {
    return { ok: false, stage: "drive_call", reason: String(e).slice(0, 200), scopes };
  }

  /* ── 4. A REAL WRITE into a real borrower-shaped folder.
   * The whole point: create a file inside a folder this app did NOT create.
   * Target is the ZZ-TEST fixture contact's folder — never a real borrower's,
   * per CLAUDE.md. If the fixture has no folder yet the probe reports that
   * rather than silently skipping, because a skipped write test is the same as
   * no write test. Cleaned up immediately whether or not the write succeeds. */
  const { data: fx } = await sb.from("contacts")
    .select("id, gdrive_folder_id").eq("first_name", "ZZ-TEST").maybeSingle();
  if (!fx?.gdrive_folder_id) {
    return { ok: false, stage: "write_test_unavailable", scopes, user,
             reason: "ZZ-TEST fixture contact has no gdrive_folder_id — cannot prove a write into a borrower folder. Recreate the fixture (see CLAUDE.md)." };
  }
  try {
    const cr = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `_probe_${Date.now()}.txt`, mimeType: "text/plain", parents: [fx.gdrive_folder_id] }),
    });
    const cd = await cr.json();
    if (!cr.ok || !cd.id) {
      return { ok: false, stage: "borrower_folder_write", scopes, user,
               reason: `cannot create in a borrower folder: ${cd?.error?.message || cr.status}`.slice(0, 220) };
    }
    await fetch(`https://www.googleapis.com/drive/v3/files/${cd.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    }).catch(() => {});
    return { ok: true, user: `${user} (token from ${tokenSource})`, scopes, wrote: cd.id };
  } catch (e) {
    return { ok: false, stage: "borrower_folder_write", scopes, user, reason: String(e).slice(0, 200) };
  }
}


function buildCredentialAlert(c: CredCheck): { key: string; message: string } {
  return {
    key: "drive_write_credential",
    message: [
      "\ud83d\udd34 Google Drive WRITE credential is broken",
      "",
      `Failed at: ${c.stage} — ${c.reason}`,
      "",
      "Every document mirror is failing while this is broken:",
      "  \u2022 borrower uploads (portal, SMS, admin) reach Supabase Storage but never Drive",
      "  \u2022 the Documents tab reads Drive, so those documents are INVISIBLE in the CRM",
      "  \u2022 nothing else reports this \u2014 gdrive-sync says \"No pending docs\" when idle",
      "",
      "FIX: re-authorize Google Drive OAuth, then update the",
      "GOOGLE_DRIVE_REFRESH_TOKEN secret:",
      ...urlBlock(REAUTH_URL),
    ].join("\n"),
  };
}

/* Alert on the in-CRM mention feed as well as SMS. SMS rides the toll-free
 * numbers that are still failing verification (~18% undelivered), so an alert
 * about a broken pipeline must not depend on the least reliable channel. */
async function notifyMentions(body: string) {
  try {
    await sb.rpc("app_notify_mentions", {
      p_source_kind: "system",
      p_source_id: null,
      p_body: body,
      p_actor_user_id: null,
      p_actor_display: "Drive health monitor",
      p_contact_id: null,
    });
    return true;
  } catch (e) {
    console.error("[gdrive-health] app_notify_mentions failed:", String(e));
    return false;
  }
}

/* STATIC KEYS — the ones that do not expire but do get revoked.
 *
 * None of these has a natural lifetime, which is exactly why nothing noticed
 * they were unmonitored: there is no expiry date to put in a calendar. They die
 * on rotation, revocation, or a billing lapse, and the first symptom is a
 * feature quietly not working. OPENAI is the sharpest: chunk-guidelines throws
 * on an embed failure and marks the row 'failed', so a dead key does not
 * corrupt data — but it does stop every new guideline from being searchable,
 * and the only signal is a status nobody reads.
 *
 * Each check is the cheapest authenticated call the provider offers. A 401/403
 * means the key is dead; a 429 or 5xx means the provider is having a moment and
 * is NOT reported as a credential failure — alerting on someone else's outage
 * teaches people to ignore the alert.
 */
type KeyCheck = { name: string; ok: boolean; detail?: string };

async function probe(name: string, run: () => Promise<Response>): Promise<KeyCheck> {
  try {
    const r = await run();
    if (r.ok) return { name, ok: true };
    if (r.status === 429 || r.status >= 500) return { name, ok: true, detail: `provider ${r.status} (not a credential failure)` };
    const body = (await r.text().catch(() => "")).slice(0, 160);
    return { name, ok: false, detail: `HTTP ${r.status} ${body}` };
  } catch (e) {
    return { name, ok: false, detail: String(e).slice(0, 160) };
  }
}

async function checkStaticKeys(): Promise<{ ok: boolean; results: KeyCheck[] }> {
  const results: KeyCheck[] = [];

  const anthropic = Deno.env.get("ANTHROPIC_API_KEY") || "";
  results.push(anthropic
    ? await probe("ANTHROPIC_API_KEY", () => fetch("https://api.anthropic.com/v1/models?limit=1", {
        headers: { "x-api-key": anthropic, "anthropic-version": "2023-06-01" } }))
    : { name: "ANTHROPIC_API_KEY", ok: false, detail: "not set" });

  const openai = Deno.env.get("OPENAI_API_KEY") || "";
  results.push(openai
    ? await probe("OPENAI_API_KEY", () => fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${openai}` } }))
    : { name: "OPENAI_API_KEY", ok: false, detail: "not set" });

  const tsid = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
  const ttok = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
  results.push(tsid && ttok
    ? await probe("TWILIO_AUTH_TOKEN", () => fetch(`https://api.twilio.com/2010-04-01/Accounts/${tsid}.json`, {
        headers: { Authorization: `Basic ${btoa(`${tsid}:${ttok}`)}` } }))
    : { name: "TWILIO_AUTH_TOKEN", ok: false, detail: "not set" });

  /* Gmail domain-wide delegation. Minting the token IS the test: it exercises
   * the service-account key, the JWT signature and the DWD grant in one call,
   * which is the whole chain gmail-inbox depends on. */
  results.push(await probe("GOOGLE_SA_KEY (Gmail DWD)", async () => {
    const raw = Deno.env.get("GOOGLE_SA_KEY") || "";
    if (!raw) throw new Error("not set");
    const sa = JSON.parse(raw);
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const head = b64({ alg: "RS256", typ: "JWT" });
    const claim = b64({
      iss: sa.client_email,
      /* gmail.modify — the EXACT scope granted in the Workspace admin console
       * and the one _shared/gmail-dwd.ts requests. DWD authorisation is
       * per-scope: probing with gmail.readonly returns unauthorized_client even
       * when the key is perfectly healthy, which is a false alarm about the very
       * thing this monitor exists to get right. Check the scope in use. */
      scope: "https://www.googleapis.com/auth/gmail.modify",
      aud: "https://oauth2.googleapis.com/token",
      sub: Deno.env.get("GMAIL_IMPERSONATE") || "rene@ratesandrealty.com",
      exp: now + 3600, iat: now,
    });
    const pem = String(sa.private_key).replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
    const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
    const k = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k, new TextEncoder().encode(`${head}.${claim}`));
    const jwt = `${head}.${claim}.` + btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
    });
  }));

  /* SERVICE ACCOUNT WRITE — a separate fact from "the SA authenticates".
   *
   * Measured today: the SA reads shared Drive content fine and mints tokens
   * fine, but a PATCH against a file rene@ owns returns 403. It CAN create —
   * it owns what it makes — which is what gdrive-proxy's resolve-folder and
   * upload paths rely on. So "auth works" would have been a green light over a
   * capability that does not exist for the operation being attempted.
   *
   * Creates and immediately trashes a folder in the SA's OWN Drive root — never
   * in a borrower's folder, so a health check can never leave litter where Rene
   * will find it. */
  results.push(await probe("GOOGLE_SA (Drive write)", async () => {
    const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") || "";
    if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
    const sa = JSON.parse(raw);
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const head = b64({ alg: "RS256", typ: "JWT" });
    const claim = b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive",
                        aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now });
    const pem = String(sa.private_key).replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
    const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
    const k = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k, new TextEncoder().encode(`${head}.${claim}`));
    const jwt = `${head}.${claim}.` + btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const tr = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
    });
    const td = await tr.json();
    if (!td.access_token) throw new Error("token: " + JSON.stringify(td).slice(0, 120));
    const auth = { Authorization: `Bearer ${td.access_token}`, "Content-Type": "application/json" };

    const cr = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST", headers: auth,
      body: JSON.stringify({ name: "_rr_healthcheck", mimeType: "application/vnd.google-apps.folder" }),
    });
    if (!cr.ok) return cr;                       // the failure we want reported
    const { id } = await cr.json();
    // Clean up after ourselves; a leaked probe folder every hour is its own bug.
    await fetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
      method: "PATCH", headers: auth, body: JSON.stringify({ trashed: true }),
    }).catch(() => {});
    return cr;
  }));

  return { ok: results.every((r) => r.ok), results };
}

/* EMBEDDINGS INTEGRITY. A chunk row with a null embedding is invisible to
 * vector search while its guideline reads 'done' — indexed to every human
 * looking at the list, absent from every answer the assistant gives. Both
 * chunkers embed BEFORE inserting and throw on failure, so this should be
 * structurally impossible; the check exists because "should be impossible" is
 * what the sidecar cache was too. */
async function checkEmbeddings(): Promise<{ ok: boolean; null_chunks: number; guidelines: number }> {
  const { count } = await sb.from("guideline_chunks")
    .select("id", { count: "exact", head: true }).is("embedding", null);
  const n = count || 0;
  if (!n) return { ok: true, null_chunks: 0, guidelines: 0 };
  const { data } = await sb.from("guideline_chunks")
    .select("guideline_id").is("embedding", null).limit(500);
  return { ok: false, null_chunks: n, guidelines: new Set((data || []).map((r: any) => r.guideline_id)).size };
}

/* BACKUP FRESHNESS. Reads backup:last_verified — a marker weekly-backup writes
 * only after every file has been read back from Drive at the expected size.
 * Deliberately NOT backup_logs: that table already said "success" for a run
 * whose Drive writes were never checked, and then said nothing at all for
 * months because a fatal error returned a 500 that pg_cron discards.
 *
 * 8 days, not 7: the job is weekly, so 7 would alert on ordinary jitter. 8
 * means a run has actually been missed. */
async function checkBackupFreshness(): Promise<{ ok: boolean; last?: string; age_days?: number }> {
  const { data } = await sb.from("system_state").select("value, updated_at")
    .eq("key", "backup:last_verified").maybeSingle();
  if (!data?.updated_at) return { ok: false };
  const ageDays = (Date.now() - new Date(data.updated_at).getTime()) / 86400000;
  return { ok: ageDays <= 8, last: (data.value as any)?.date || data.updated_at, age_days: Math.round(ageDays) };
}

/* Per-key cooldown. The Drive write credential gets 3 hours, not 12: while it
 * is down every borrower upload is invisible in the CRM, so a repeat alert
 * costs far less than a quiet gap. Everything else stays at 12, where the
 * failure is either slow-moving or already visible elsewhere. */
function cooldownFor(alertKey: string): number {
  return alertKey === "drive_write_credential" ? 3 : ALERT_COOLDOWN_HOURS;
}

async function shouldAlert(alertKey: string): Promise<boolean> {
  const stateKey = `gdrive_alert:${alertKey}`;
  const { data } = await sb.from("system_state")
    .select("value, updated_at").eq("key", stateKey).single();
  if (!data?.updated_at) return true;
  const ageHours = (Date.now() - new Date(data.updated_at).getTime()) / 3600000;
  return ageHours >= cooldownFor(alertKey);
}

/* ── THE MONITOR'S OWN HEALTH ────────────────────────────────────────────────
 *
 * A monitor that throws is silent by construction. pg_cron fires this over
 * net.http_post, records the response in net._http_response, and looks at it
 * never — so when a generated `${RED}` with no constant in scope made every
 * alert branch throw, the function returned 500 on every run for hours and the
 * only symptom was the absence of messages. Absence is not a signal anybody
 * notices.
 *
 * Two layers, because the obvious one is not enough:
 *
 *   1. heartbeat() below, called from ok() so EVERY completed run stamps it,
 *      healthy or not. A run that throws never reaches ok(), so the stamp
 *      simply stops advancing. Nothing to remember, no branch to get wrong.
 *
 *   2. A pg_cron job in pure SQL that alerts when the stamp goes stale — see
 *      supabase/sql/monitor_deadman.sql. That one lives OUTSIDE this file on
 *      purpose. A catch block that reports its own failure is still JavaScript
 *      in the same module: the same typo class that broke the alert branches
 *      could equally break the reporting, and then the silence is total. The
 *      dead-man's switch has no template literals, no constants, and no
 *      dependency on this function loading at all.
 *
 * The catch block does still try to report — belt as well as braces — but it is
 * the SQL switch that makes the guarantee. */
async function heartbeat(status: string, detail?: any) {
  try {
    await sb.from("system_state").upsert({
      key: "monitor:gdrive_health",
      value: { status, at: new Date().toISOString(), detail: detail ?? null },
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[gdrive-health] heartbeat write failed:", String(e));
  }
}

async function markAlertSent(alertKey: string, summary: string) {
  const stateKey = `gdrive_alert:${alertKey}`;
  await sb.from("system_state").upsert({
    key: stateKey,
    value: { summary, sent_at: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  });
}

async function sendSms(message: string): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/sms-service`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({
        trigger: "custom",
        to_phone: ADMIN_PHONE,
        params: { message },
      }),
    });
    return res.ok;
  } catch (e) {
    console.error("[gdrive-health] sms send failed:", e);
    return false;
  }
}

// Format URL block for SMS — iOS Messages can visually word-wrap a long URL
// in the middle of the domain, inserting what looks like a hyphen (e.g.
// "supabase.co" rendering as "su-pabase.co"). To avoid this, surround the URL
// with blank lines so iOS treats it as its own paragraph and does not break
// it mid-domain. Also prefix with "Link:" so the user knows to copy the line.
function urlBlock(url: string): string[] {
  return ["", "Link (copy entire line):", url, ""];
}

function buildOAuthAlert(check: OAuthCheck): { key: string; message: string } {
  const k = check.failure_kind;
  if (k === "missing_secrets") {
    return {
      key: "oauth_missing_secrets",
      message: [
        "\u26a0\ufe0f Drive sync OAuth keys missing",
        "",
        `Reason: ${check.reason}`,
        "",
        "FIX (5 min):",
        "1. Open Supabase Edge Function Secrets at the link below",
        ...urlBlock(SUPABASE_SECRETS_URL),
        "2. Confirm GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set",
        "3. If not, copy from Google Cloud > APIs > Credentials > OAuth client",
      ].join("\n"),
    };
  }
  if (k === "no_refresh_token" || k === "revoked" || k === "invalid_grant") {
    const headline = k === "revoked"
      ? "\u26a0\ufe0f Drive sync access revoked"
      : "\u26a0\ufe0f Drive sync token expired";
    return {
      key: "oauth_reauth_needed",
      message: [
        headline,
        "",
        `Reason: ${check.reason || "refresh_token rejected by Google"}`,
        "",
        "FIX (1 min):",
        "1. Open the link below in Chrome (signed in as rene@ratesandrealty.com)",
        ...urlBlock(REAUTH_URL),
        "2. Click Allow on Calendar + Drive access",
        "3. Done. Monitor will re-check in 6h.",
        "",
        "If this keeps happening every ~7 days, your Google Cloud OAuth client is in Testing mode. Set publishing status to \"In production\" at console.cloud.google.com/apis/credentials/consent",
      ].join("\n"),
    };
  }
  if (k === "network") {
    return {
      key: "oauth_network",
      message: [
        "\u26a0\ufe0f Drive sync: network error reaching Google",
        "",
        `Reason: ${check.reason}`,
        "",
        "FIX:",
        "Usually transient. Wait 1h and check again. If persistent, check status.cloud.google.com",
      ].join("\n"),
    };
  }
  return {
    key: "oauth_unknown",
    message: [
      "\u26a0\ufe0f Drive sync OAuth failed",
      "",
      `Reason: ${check.reason || "unknown"}`,
      "",
      "FIX (try in order):",
      "1. Re-authorize via the link below",
      ...urlBlock(REAUTH_URL),
      "2. If that fails, check Google Cloud Console for the OAuth client status",
      "3. Reply to this text and Rene's CRM AI will help",
    ].join("\n"),
  };
}

function buildSyncStalledAlert(check: SyncCheck): { key: string; message: string } {
  return {
    key: "sync_stalled",
    message: [
      "\u26a0\ufe0f Drive sync stalled",
      "",
      `${check.pending} guideline(s) waiting, oldest ~${check.oldest_age_hours}h ago`,
      "",
      "FIX (most cases auto-resolve overnight):",
      "1. Wait — nightly cron at 8:30 PM PT retries everything",
      "2. To force-retry now, POST to:",
      ...urlBlock(`${SUPABASE_URL}/functions/v1/gdrive-sync-guideline`),
      "   with body: {\"action\":\"sync_all_pending\"}",
      "3. If still stuck, OAuth may have just broken. Re-auth via:",
      ...urlBlock(REAUTH_URL),
    ].join("\n"),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  /* Every completed run stamps the heartbeat, healthy or unhealthy — the point
   * is "this function ran to the end", not "everything is fine". Deliberately
   * not awaited into the response path: a heartbeat write that hangs must not
   * turn a working monitor into a timing-out one. */
  const ok = (d: any) => {
    heartbeat(d?.status || "unknown", { alert_sent: d?.alert_sent ?? false, skipped: d?.alert_skipped_reason });
    return new Response(JSON.stringify(d, null, 2), { headers: { ...cors, "Content-Type": "application/json" } });
  };

  try {
    const url = new URL(req.url);
    let force = url.searchParams.get("force") === "1";
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body.force) force = true;
    }

    const oauth = await checkOAuth();
    const driveCred = await checkDriveWriteCredential();
    const staticKeys = await checkStaticKeys();
    const embeddings = await checkEmbeddings();
    const syncStatus = await checkPendingSyncs();
    const indexing = await checkIndexingHealth();
    const backup = await checkBackupFreshness();
    /* Rows vs objects. Runs every hour AND is the mandatory post-restore gate —
     * a restore is exactly when direction A goes from zero to many. */
    const recon = await reconcileStorage(sb);
    const allOk = oauth.ok && driveCred.ok && staticKeys.ok && embeddings.ok
      && syncStatus.ok && indexing.ok && backup.ok && recon.ok;

    const result: any = {
      checked_at: new Date().toISOString(),
      /* calendar_oauth_ok, NOT oauth_ok. This checks google_calendar_tokens —
       * a different grant from the Drive write credential below. Reading as a
       * global all-clear while the mirror was dead is the exact failure this
       * monitor was supposed to catch. Nothing parses this JSON (the cron fires
       * it and discards the body), so the rename breaks no consumer. */
      calendar_oauth_ok: oauth.ok,
      calendar_oauth_reason: oauth.reason,
      calendar_oauth_failure_kind: oauth.failure_kind,
      drive_write_credential_ok: driveCred.ok,
      drive_write_credential_stage: driveCred.stage,
      drive_write_credential_reason: driveCred.reason,
      drive_write_credential_user: driveCred.user,
      drive_write_credential_scopes: driveCred.scopes,
      drive_write_credential_wrote: driveCred.wrote,
      static_keys_ok: staticKeys.ok,
      static_keys: staticKeys.results,
      embeddings_ok: embeddings.ok,
      embeddings_null_chunks: embeddings.null_chunks,
      backup_ok: backup.ok,
      backup_last_verified: backup.last || null,
      backup_age_days: backup.age_days ?? null,
      reconcile_ok: recon.ok,
      reconcile_dangling: recon.dangling,
      reconcile_orphans: recon.orphans,
      sync_ok: syncStatus.ok,
      pending_count: syncStatus.pending,
      pending_oldest_hours: syncStatus.oldest_age_hours,
      indexing_ok: indexing.ok,
      indexing_done_no_chunks: indexing.done_no_chunks.map((r: any) => r.title || r.id),
      indexing_stuck_running: indexing.stuck_running.map((r: any) => r.title || r.id),
      indexing_skipped: indexing.skipped.map((r: any) => r.title || r.id),
      alert_sent: false,
      alert_skipped_reason: null,
    };

    if (allOk) {
      await sb.from("system_state").upsert({
        key: "gdrive_alert:last_ok",
        value: { checked_at: result.checked_at },
        updated_at: new Date().toISOString(),
      });
      return ok({ ...result, status: "healthy" });
    }

    // OAuth issues take priority — they cause sync issues, not the other way around
    let alert: { key: string; message: string };
    /* OAuth first — it causes sync failures, not the other way round. Indexing
     * is independent of both, so it is reported when the Drive side is healthy
     * rather than being masked by it. */
    if (!driveCred.ok) {
      /* First, deliberately. This one silently breaks every document mirror,
       * and a stalled-sync alert is a symptom of it rather than a separate
       * problem. */
      alert = buildCredentialAlert(driveCred);
    } else if (!recon.ok && recon.dangling.some((d) => d.count !== 0)) {
      alert = {
        key: "storage_dangling",
        message: [
          `${RED} Documents referenced by the CRM are MISSING from storage`,
          "",
          ...recon.dangling.filter((d) => d.count !== 0).flatMap((d) => [
            `  ${d.entry}: ${d.count === -1 ? "check failed" : d.count + " row(s)"}`,
            ...d.samples.map((x) => `      ${x}`),
          ]),
          "",
          "Each of these is a row the CRM will show as a document on someone's",
          "file, whose bytes are not there. If this appeared after a database",
          "restore, that is expected: Supabase physical backups do not include",
          "storage objects, so restoring revives rows for files deleted since.",
        ].join("\n"),
      };
    } else if (!recon.ok) {
      const over = recon.orphans.filter((o) => o.over > 0);
      alert = {
        key: "storage_orphans:" + over.map((o) => o.bucket).join(","),
        message: [
          `${RED} New orphaned storage objects`,
          "",
          ...over.map((o) => `  ${o.bucket}: ${o.count} objects, baseline ${o.baseline} (+${o.over} new)`),
          "",
          "Bytes in the bucket that no database row references. They are",
          "invisible in every CRM surface — not broken, just unreachable.",
          "Usually a write that stored the object and failed to write its row.",
        ].join("\n"),
      };
    } else if (!staticKeys.ok) {
      const dead = staticKeys.results.filter((r) => !r.ok);
      alert = {
        key: "static_keys:" + dead.map((d) => d.name).join(","),
        message: [
          "\ud83d\udd34 API credential(s) failing",
          "",
          ...dead.map((d) => `  \u2022 ${d.name} — ${d.detail}`),
          "",
          "What stops working:",
          "  \u2022 OPENAI — new guidelines chunk but produce no embeddings, so they",
          "    never appear in AI search even though the row says indexed",
          "  \u2022 ANTHROPIC — SMS assistant, document typing, guideline summaries",
          "  \u2022 TWILIO — all SMS and voice, inbound and outbound",
          "  \u2022 GOOGLE_SA_KEY — the Gmail inbox",
        ].join("\n"),
      };
    } else if (!backup.ok) {
      alert = {
        key: "backup_stale",
        message: [
          `${RED} CRM backup is stale`,
          "",
          backup.last
            ? `Last VERIFIED backup: ${backup.last} (${backup.age_days} days ago).`
            : "No verified backup has ever been recorded.",
          "",
          "The weekly job runs Sundays 08:00 UTC. Verified means every file was",
          "read back from Drive at the expected size — not merely that the upload",
          "call returned 200.",
          "",
          "If the Drive credential is also failing, fix that first: the backup",
          "cannot authenticate without it.",
        ].join("\n"),
      };
    } else if (!embeddings.ok) {
      alert = {
        key: "embeddings_null",
        message: [
          "\ud83d\udd34 Guideline chunks with NO embedding",
          "",
          `${embeddings.null_chunks} chunk(s) across ${embeddings.guidelines} guideline(s).`,
          "",
          "These are invisible to AI search while their guideline reads 'indexed'.",
          "Both chunkers embed before inserting, so this means something wrote",
          "chunks by another path — investigate before re-chunking.",
        ].join("\n"),
      };
    } else if (!oauth.ok) {
      alert = buildOAuthAlert(oauth);
    } else if (!syncStatus.ok) {
      alert = buildSyncStalledAlert(syncStatus);
    } else {
      alert = buildIndexingAlert(indexing);
    }

    if (!force) {
      const can = await shouldAlert(alert.key);
      if (!can) {
        result.alert_skipped_reason = "cooldown";
        return ok({ ...result, status: "unhealthy_silent", would_send: alert.message });
      }
    }

    const mentioned = await notifyMentions(alert.message);
    const sent = await sendSms(alert.message);
    result.alert_mentioned = mentioned;
    if (sent || mentioned) {
      result.alert_sent = true;
      await markAlertSent(alert.key, alert.message);
    } else {
      result.alert_skipped_reason = "sms_send_failed_and_mention_failed";
    }

    return ok({ ...result, status: "unhealthy", message: alert.message });
  } catch (e: any) {
    /* Report the monitor's own crash. Everything here is best-effort and
     * individually guarded, because the one thing worse than a monitor that
     * throws is a monitor whose error handler throws on top of it. The
     * heartbeat is deliberately NOT stamped — a crashed run must look stale to
     * the dead-man's switch, which is the layer that actually guarantees
     * someone hears about this. */
    const msg = e?.message || String(e);
    const stack = String(e?.stack || "").split("\n").slice(0, 4).join("\n");
    console.error("[gdrive-health] FATAL:", e);
    try {
      await sb.from("system_state").upsert({
        key: "monitor:gdrive_health_error",
        value: { error: msg, stack, at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      });
    } catch (_) { /* ignore */ }
    try {
      const last = await sb.from("system_state").select("value")
        .eq("key", "gdrive_alert:monitor_crash").maybeSingle();
      const sentAt = last?.data?.value?.sent_at ? Date.parse(last.data.value.sent_at) : 0;
      if (Date.now() - sentAt > 3 * 3600 * 1000) {
        await sendSms([
          `${RED} The health monitor itself crashed`,
          "",
          msg.slice(0, 300),
          "",
          "Every check it performs is unreported until this is fixed — the",
          "credential, backup, storage and indexing alerts are all downstream",
          "of this function running to completion.",
        ].join("\n"));
        await markAlertSent("monitor_crash", msg.slice(0, 300));
      }
    } catch (_) { /* ignore */ }
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});

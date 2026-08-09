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
const ASSISTANT_FROM = Deno.env.get("TWILIO_ASSISTANT_NUMBER") || "+18886881231";
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
  /* ── THE TARGET IS A PINNED PROBE FOLDER, NOT THE FIXTURE CONTACT ──────────
   *
   * This used to read ZZ-TEST's gdrive_folder_id, and that coupling broke the
   * check TWICE: once when the fixture was deleted (2026-08-04) and again when
   * trg_borrower_foldering_ins gained
   * WHEN (NEW.lead_source IS DISTINCT FROM 'automated-test'), after which a
   * recreated fixture never gets a folder at all. The probe was dark from
   * 2026-08-06 17:07Z until this change.
   *
   * The folder is now permanent and pinned in app_config. It was created by the
   * SAME path that creates borrower folders — the n8n "Borrower Stage
   * Foldering" workflow, whose Drive nodes use googleDriveOAuth2Api, i.e.
   * rene@'s user OAuth through n8n's OAuth client.
   *
   * That provenance is the whole point and is easy to destroy by "simplifying"
   * this later: a folder created by the SERVICE ACCOUNT, or by our own OAuth
   * client, would still be writable by a token holding only drive.file — so the
   * probe would go green in exactly the scope-downgrade scenario it exists to
   * catch. If this folder ever has to be recreated, recreate it through the
   * same workflow. */
  const { data: cfg } = await sb.from("app_config")
    .select("value").eq("key", "gdrive_probe_folder_id").maybeSingle();
  const probeFolderId = String((cfg as any)?.value || "").trim();
  if (!probeFolderId) {
    return { ok: false, stage: "write_test_unavailable", scopes, user,
             reason: "app_config.gdrive_probe_folder_id is unset — there is no probe folder to write into. See CLAUDE.md → Dedicated test locations." };
  }
  try {
    const cr = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `_probe_${Date.now()}.txt`, mimeType: "text/plain", parents: [probeFolderId] }),
    });
    const cd = await cr.json();
    if (!cr.ok || !cd.id) {
      const msg = `${cd?.error?.message || cr.status}`;
      /* A MISSING PROBE FOLDER IS A CONFIG FAULT, NOT A CREDENTIAL FAULT.
       * 404 means the pinned id points at nothing — deleted, trashed, or
       * mistyped. The credential was never exercised, so reporting "WRITE
       * credential is broken" would be the same cry-wolf that made the
       * 2026-08-04 alert wrong. Anything else (403, quota, 5xx) DID exercise the
       * credential and stays a real failure. */
      if (cr.status === 404) {
        return { ok: false, stage: "write_test_unavailable", scopes, user,
                 reason: `probe folder ${probeFolderId} not found (${msg}) — app_config.gdrive_probe_folder_id points at nothing. The folder is named "RR HEALTH PROBE - DO NOT DELETE" and must not be deleted.`.slice(0, 300) };
      }
      return { ok: false, stage: "borrower_folder_write", scopes, user,
               reason: `cannot create in the probe folder: ${msg}`.slice(0, 220) };
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


/* TWO DIFFERENT FACTS, TWO DIFFERENT ALERTS.
 *
 * "the Drive credential is broken" and "the probe could not run" are not the
 * same claim, and until 2026-08-04 both produced the identical red
 * "WRITE credential is broken" message. Every drive_write_credential alert this
 * monitor has EVER sent — exactly one, at 2026-08-04T22:07Z — was actually
 * write_test_unavailable: the ZZ-TEST fixture had been deleted 29 minutes
 * earlier, so the probe had no borrower folder to write into. The credential was
 * fine; last_ok was recorded an hour before.
 *
 * An alert that says "broken" when it means "untested" is how a real one stops
 * being believed. */
const PROBE_UNRUNNABLE_STAGES = new Set(["write_test_unavailable"]);

function buildProbeUnrunnableAlert(c: CredCheck): { key: string; message: string } {
  return {
    key: "drive_write_probe_unrunnable",
    message: [
      "⚠️ Drive write check could NOT RUN — the credential is not implicated",
      "",
      `Blocked at: ${c.stage} — ${c.reason}`,
      "",
      "What this does and does not mean:",
      "  • NOT a credential failure — OAuth and the Drive API were not exercised",
      "  • the write path is UNVERIFIED, not known-broken",
      "  • borrower uploads may be working normally; nothing here says otherwise",
      "",
      "FIX: the probe writes into a permanent Drive folder named",
      '"RR HEALTH PROBE - DO NOT DELETE", pinned in',
      "app_config.gdrive_probe_folder_id. Either that key is unset or the folder",
      "was deleted. If it must be recreated, create it through the n8n",
      '"Borrower Stage Foldering" workflow — NOT by hand and NOT with the',
      "service account, or the probe stops proving anything (see CLAUDE.md).",
    ].join("\n"),
  };
}

function buildCredentialAlert(c: CredCheck): { key: string; message: string } {
  // stage is optional on CredCheck; an absent stage is not an unrunnable probe.
  if (c.stage && PROBE_UNRUNNABLE_STAGES.has(c.stage)) return buildProbeUnrunnableAlert(c);
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

/* Second delivery leg, alongside SMS, so an alert about a broken pipeline does
 * not depend on one channel.
 *
 * THIS USED TO CALL app_notify_mentions AND NEVER DELIVERED ANYTHING. That
 * function is a MENTION FAN-OUT: it scans the body for `@handle`, looks each
 * one up in auth_user_roles, and inserts one app_notifications row per match.
 * A monitor alert contains no @handle, so the loop never ran, the function
 * returned 0, and not one row was ever written. It did not error — there was
 * nothing to error about — so the caller's `return true` was accurate about the
 * call and wrong about the outcome. Every alert_mentioned: true this function
 * has ever reported was measuring that a call completed.
 *
 * Now it inserts directly, for every admin in auth_user_roles, and returns the
 * row ids it actually created. No rows, no success.
 *
 * KNOWN GAP, deliberately not papered over: nothing in this repo reads
 * app_notifications. The rows are real and queryable, but until a UI renders
 * them this leg reaches a table, not a person. Treat SMS as the only channel
 * that currently reaches anyone. */
async function notifyInCrm(body: string): Promise<{ ok: boolean; ids: string[]; error: string | null }> {
  try {
    const { data: admins, error: rErr } = await sb
      .from("auth_user_roles").select("user_id").eq("role", "admin");
    if (rErr) return { ok: false, ids: [], error: `admin lookup: ${rErr.message}` };
    const rows = (admins || []).map((a: any) => ({
      recipient_user_id: a.user_id,
      actor_user_id: null,
      actor_display: "Drive health monitor",
      kind: "system",
      source_kind: "monitor",
      source_id: null,
      contact_id: null,
      preview: body.replace(/\s+/g, " ").slice(0, 180),
    }));
    if (!rows.length) return { ok: false, ids: [], error: "no admin recipients in auth_user_roles" };
    /* .select() so the ids come back — the receipt IS the proof. An insert
     * whose result is discarded is the same optimism in a new place. */
    const { data, error } = await sb.from("app_notifications").insert(rows).select("id");
    if (error) return { ok: false, ids: [], error: error.message };
    const ids = (data || []).map((r: any) => String(r.id));
    return { ok: ids.length > 0, ids, error: ids.length ? null : "insert returned no rows" };
  } catch (e) {
    console.error("[gdrive-health] in-CRM notify failed:", String(e));
    return { ok: false, ids: [], error: String(e) };
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

/* DOES THE MIRROR ACTUALLY MIRROR?
 *
 * drive_write_credential_ok read TRUE for the entire two and a half days that
 * no borrower document reached Drive. It was not lying: it exchanges a token
 * and writes a probe file into the fixture folder, and both worked. What it
 * does not do is execute one line of gdrive-sync, which is where the defect
 * was — a missing import that threw before the credential was ever used.
 *
 * A credential probe cannot see this. The only thing that can is the OUTCOME:
 * rows that have been sitting with a storage path and no gdrive_file_id for
 * longer than the sync interval. The cron runs every 10 minutes, so 30 gives
 * it three attempts before anyone is woken.
 *
 * This is the check that would have caught it 18 minutes after it shipped
 * instead of when a borrower's ID went missing. */
/* ── DID THE COMPLETION RECORD PDF ACTUALLY GET WRITTEN? ─────────────────────
 *
 * The other half of the storage reconcile. Reconcile catches an object nothing
 * points at; this catches the reverse gap that reconcile structurally cannot
 * see — a completed signature whose record PDF was never written at all. There
 * is no object and no pointer, so nothing is inconsistent; there is simply
 * nothing there, and nothing to notice it.
 *
 * esign now writes a `record_failed` signature_events row when generation
 * fails, which is honest but only visible to somebody already looking at that
 * envelope. This is what sweeps for it.
 *
 * WHY A DATE AND NOT AN ID LIST. Eight completed requests from June–August have
 * no record PDF, and correctly never will: generation-on-completion did not
 * exist when they completed, and they are deliberately not being backfilled.
 * Excluding them by uuid would work today and rot into eight magic constants
 * nobody dares touch. The date says the actual reason — "completed before the
 * behaviour existed, so no PDF was ever expected" — and the excluded set is
 * closed and shrinking in relevance, while every new request is on the alerting
 * side of the line by construction. The newest of the eight completed
 * 2026-08-06 05:42Z; generation shipped 2026-08-09 ~06:30Z. */
const RECORD_PDF_SINCE = "2026-08-09T06:00:00Z";
/* Generation takes ~2.6s. Fifteen minutes is not a timeout, it is room for a
 * retry and a slow render before waking anyone. */
const RECORD_PDF_GRACE_MINUTES = 15;

type RecordCheck = { ok: boolean; ran: boolean; reason?: string; missing: string[]; failed: string[] };

async function checkSignatureRecords(): Promise<RecordCheck> {
  try {
    const cutoff = new Date(Date.now() - RECORD_PDF_GRACE_MINUTES * 60_000).toISOString();
    const { data: miss, error: e1 } = await sb.from("signature_requests")
      .select("id, document_title, completed_at")
      .eq("status", "completed").is("final_pdf_path", null)
      .gt("completed_at", RECORD_PDF_SINCE).lt("completed_at", cutoff)
      .order("completed_at").limit(50);
    /* A check that cannot run must not read as a pass — same rule the Drive
     * write probe learned on 2026-08-04. ran:false is reported separately from
     * ok:false and never silently returns healthy. */
    if (e1) return { ok: false, ran: false, reason: `signature_requests query failed: ${e1.message}`, missing: [], failed: [] };

    /* A record_failed in the last hour alerts regardless of age: it can land on
     * an envelope completed long ago (a re-run), and the grace window above
     * would never surface it. */
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { data: fails, error: e2 } = await sb.from("signature_events")
      .select("request_id, occurred_at, detail")
      .eq("event_type", "record_failed").gt("occurred_at", hourAgo).limit(50);
    if (e2) return { ok: false, ran: false, reason: `signature_events query failed: ${e2.message}`, missing: [], failed: [] };

    const missing = (miss || []).map((r: any) => `${r.id} — ${r.document_title || "(untitled)"} (completed ${r.completed_at})`);
    const failed = (fails || []).map((r: any) => `${r.request_id} — ${r.detail?.error || "no reason recorded"}`.slice(0, 180));
    return { ok: missing.length === 0 && failed.length === 0, ran: true, missing, failed };
  } catch (e) {
    return { ok: false, ran: false, reason: String(e).slice(0, 200), missing: [], failed: [] };
  }
}

const MIRROR_STALE_MINUTES = 30;

async function checkDocumentMirror(): Promise<{ ok: boolean; stranded: number; oldest_minutes: number | null; samples: string[] }> {
  try {
    const cutoff = new Date(Date.now() - MIRROR_STALE_MINUTES * 60_000).toISOString();
    const { data, error } = await sb.from("uploaded_documents")
      .select("id, contact_id, file_name, uploaded_at")
      .is("gdrive_file_id", null)
      .not("file_path", "is", null)
      .lt("uploaded_at", cutoff)
      .order("uploaded_at", { ascending: true })
      .limit(50);
    if (error) {
      console.error("[monitor] mirror check failed:", error.message);
      // A check that cannot run must not read as healthy.
      return { ok: false, stranded: -1, oldest_minutes: null, samples: [`check failed: ${error.message}`] };
    }
    const rows = data || [];
    if (!rows.length) return { ok: true, stranded: 0, oldest_minutes: null, samples: [] };
    const oldest = rows[0] as any;
    const mins = oldest.uploaded_at
      ? Math.round((Date.now() - new Date(oldest.uploaded_at).getTime()) / 60_000)
      : null;
    return {
      ok: false,
      stranded: rows.length,
      oldest_minutes: mins,
      samples: rows.slice(0, 5).map((r: any) => `${r.file_name || r.id} (contact ${r.contact_id || "none"})`),
    };
  } catch (e) {
    console.error("[monitor] mirror check threw:", String(e));
    return { ok: false, stranded: -1, oldest_minutes: null, samples: [`check threw: ${String(e)}`] };
  }
}

/* BACKUP HEALTH. Two independent conditions, because age alone was not enough.
 *
 *   STALE  — backup:last_verified has not moved in over 8 days. The marker is
 *            written only after every file has been read back from Drive at the
 *            expected size. Deliberately NOT backup_logs: that table already
 *            said "success" for a run whose Drive writes were never checked,
 *            and then said nothing at all for months because a fatal error
 *            returned a 500 that pg_cron discards.
 *            8 days, not 7: the job is weekly, so 7 would alert on jitter.
 *
 *   FAILED — the newest backup_logs row says 'failed'. This is checked
 *            INDEPENDENTLY OF AGE. The failed-section gate in weekly-backup
 *            correctly withholds the marker when any export throws, but
 *            withholding a marker is a silence, and staleness only notices a
 *            silence eight days later. A run that failed this morning was
 *            invisible until next week. Now it alerts on the next hourly pass.
 *
 * The staleness half can be suppressed; the failure half CANNOT. A suppression
 * is only honoured with a syntactically valid future `until` date — a row with
 * no expiry, a malformed one, or a past one suppresses nothing and the check
 * resumes on its own. There is deliberately no way to mute this indefinitely. */
const BACKUP_SUPPRESS_KEY = "backup:stale_check_suppressed_until";

type BackupHealth = {
  ok: boolean;
  last?: string;
  age_days?: number;
  stale: boolean;
  suppressed_until: string | null;
  suppression_reason: string | null;
  failed_run: { date: string; sections: string[] } | null;
};

async function checkBackupHealth(): Promise<BackupHealth> {
  const { data } = await sb.from("system_state").select("value, updated_at")
    .eq("key", "backup:last_verified").maybeSingle();

  const ageDays = data?.updated_at
    ? (Date.now() - new Date(data.updated_at).getTime()) / 86400000
    : null;
  // No marker at all is stale by definition — nothing has ever been verified.
  const stale = ageDays === null ? true : ageDays > 8;

  /* Bounded suppression. `until` must be YYYY-MM-DD and still in the future;
   * anything else is ignored, so a suppression cannot outlive its own date. */
  let suppressedUntil: string | null = null;
  let suppressionReason: string | null = null;
  try {
    const { data: sup } = await sb.from("system_state").select("value")
      .eq("key", BACKUP_SUPPRESS_KEY).maybeSingle();
    const until = String((sup?.value as any)?.until || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(until) && new Date(`${until}T23:59:59Z`).getTime() > Date.now()) {
      suppressedUntil = until;
      suppressionReason = String((sup?.value as any)?.reason || "").trim() || null;
    }
  } catch (e) {
    // A suppression we cannot read is not a suppression. Fail towards alerting.
    console.error("[monitor] backup suppression read failed:", String(e));
  }

  /* The newest run, whatever its date. Not filtered to recent days on purpose:
   * if the last thing that happened was a failure, that is the current state
   * however long ago it was. */
  let failedRun: BackupHealth["failed_run"] = null;
  try {
    const { data: newest } = await sb.from("backup_logs")
      .select("backup_date, status, results")
      .order("backup_date", { ascending: false }).limit(1).maybeSingle();
    if (newest && String((newest as any).status) === "failed") {
      const results = ((newest as any).results || {}) as Record<string, any>;
      const sections: string[] = [];
      for (const [name, r] of Object.entries(results)) {
        if (name === "website") {
          const list = (r as any)?.error_list;
          if (Array.isArray(list) && list.length) sections.push(`website: ${list.join("; ")}`);
          continue;
        }
        if (r && typeof r === "object" && "error" in (r as any)) sections.push(`${name}: ${(r as any).error}`);
      }
      // A fatal run records results = { error: ... } with no per-table keys.
      if (!sections.length && typeof (results as any).error === "string") sections.push((results as any).error);
      failedRun = { date: String((newest as any).backup_date), sections };
    }
  } catch (e) {
    console.error("[monitor] backup_logs read failed:", String(e));
  }

  const staleCounts = stale && !suppressedUntil;
  return {
    ok: !staleCounts && !failedRun,
    last: (data?.value as any)?.date || data?.updated_at,
    age_days: ageDays === null ? undefined : Math.round(ageDays),
    stale,
    suppressed_until: suppressedUntil,
    suppression_reason: suppressionReason,
    failed_run: failedRun,
  };
}

/* Per-key cooldown. The Drive write credential gets 3 hours, not 12: while it
 * is down every borrower upload is invisible in the CRM, so a repeat alert
 * costs far less than a quiet gap. Everything else stays at 12, where the
 * failure is either slow-moving or already visible elsewhere. */
/* Urgency is a property of WHAT is red, not of the key's spelling. Under digest
 * keys the old `alertKey === "drive_write_credential"` string match could never
 * fire again, so the caller passes the fact instead: a genuinely BROKEN Drive
 * write credential (not merely unrunnable) keeps the 3-hour cadence, because
 * while it is down every borrower upload is invisible in the CRM. An unrunnable
 * probe stays at 12 — a 3-hourly "could not check" is exactly the noise that
 * trains people to ignore the key that matters. */
function cooldownFor(urgent: boolean): number {
  return urgent ? 3 : ALERT_COOLDOWN_HOURS;
}

async function shouldAlert(alertKey: string, urgent = false): Promise<boolean> {
  const stateKey = `gdrive_alert:${alertKey}`;
  const { data } = await sb.from("system_state")
    .select("value, updated_at").eq("key", stateKey).maybeSingle();
  if (!data?.updated_at) return true;
  const ageHours = (Date.now() - new Date(data.updated_at).getTime()) / 3600000;
  return ageHours >= cooldownFor(urgent);
}

/* ── PER-RUN HISTORY ────────────────────────────────────────────────────────
 *
 * Never throws: a monitor that dies because it could not write its own logbook
 * is worse than one with a gap in the logbook.
 *
 * Retention is trimmed here rather than by a separate cron, so the table cannot
 * outlive the thing that maintains it — a cleanup job that gets disabled is how
 * pg_cron job 2 stopped producing backups without anyone noticing. */
const MONITOR_RUN_RETENTION_DAYS = 30;
async function recordRun(
  result: any, status: string, redKeys: string[], unrunnableKeys: string[],
  alertKey: string | null, alertSent: boolean, skippedReason: string | null,
) {
  try {
    await sb.from("monitor_runs").insert({
      monitor: "gdrive_health",
      status,
      red_keys: redKeys,
      unrunnable_keys: unrunnableKeys,
      alert_key: alertKey,
      alert_sent: alertSent,
      skipped_reason: skippedReason,
      detail: {
        sms_delivered: result?.sms_delivered ?? null,
        crm_notified: result?.crm_notified ?? null,
        checked_at: result?.checked_at ?? null,
      },
    });
    const cutoff = new Date(Date.now() - MONITOR_RUN_RETENTION_DAYS * 864e5).toISOString();
    await sb.from("monitor_runs").delete().lt("ran_at", cutoff);
  } catch (e) {
    console.error("[gdrive-health] could not record run history:", String(e));
  }
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

/* ── SMS IS A HEADLINE, NOT THE REPORT ───────────────────────────────────────
 *
 * The alerts were going out at NINE segments. Not because they were long —
 * because of one character. A single emoji forces the whole body from GSM-7
 * into UCS-2, and a segment shrinks from 153 characters to 67. So the red
 * circle at the top was costing nine times the money and nine times the
 * chance of being truncated or dropped mid-alert, on the channel whose entire
 * job is reporting that things are broken.
 *
 * CORRECTED 2026-08-07. This comment used to justify itself with "the
 * toll-free deliverability problem". There is no such problem: toll-free
 * verification on +18668919394 has been APPROVED since 2023-12-05 (Twilio
 * console, Regulatory Information), and approved toll-free numbers have no
 * sending caps. A companion claim that ~18% of outbound SMS fails for that
 * reason had no source anywhere in this repo's history and was simply untrue.
 *
 * The change itself stands on its own and is unaffected: nine segments really
 * is nine times the cost and nine times the surface for a partial delivery,
 * and multi-segment reassembly is the one thing that genuinely does fail. Only
 * the stated reason was wrong. See docs/OPEN-FINDINGS-2026-08-07.md §8 — which
 * also records that we have NO delivery data at all, because sms-service sets
 * no StatusCallback and nothing consumes Twilio message-status webhooks.
 *
 * The SMS now carries the headline and one line of reason. The full text still
 * goes to the CRM notification, which has no length limit and no per-segment
 * cost. Anything not representable in GSM-7 is stripped rather than allowed to
 * silently re-encode the message. */
const GSM_SUBST: Array<[RegExp, string]> = [
  [/[—–]/g, "-"],      // em/en dash
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
  [/…/g, "..."],
  [/•/g, "*"],
  [/→/g, "->"],
];
function gsmSafe(s: string): string {
  let out = s;
  for (const [re, v] of GSM_SUBST) out = out.replace(re, v);
  // Whatever is left outside printable ASCII would drag the body into UCS-2.
  return out.replace(/[^\x20-\x7E\n]/g, "").replace(/[ \t]+/g, " ");
}

/* Two GSM-7 segments are 306 characters. Leave room for the tail. */
const SMS_TAIL = " Full detail in the CRM bell.";
const SMS_MAX = 306 - SMS_TAIL.length;

function smsDigest(full: string): string {
  const lines = gsmSafe(full).split("\n").map((l) => l.trim()).filter(Boolean);
  const headline = lines[0] || "CRM health alert";
  /* Prefer a bullet: in every one of these alerts the bullets are the actual
   * failures, while the first prose line tends to be a restatement of the
   * headline. Fall back to the first line that says something. */
  const body = lines.slice(1);
  const reason = (
    body.find((l) => /^[*\-]\s/.test(l)) ||
    body.find((l) => l.replace(/^[*\-\s]+/, "").length > 8) ||
    ""
  ).replace(/^[*\-\s]+/, "");
  let out = reason ? `${headline}: ${reason}` : headline;
  if (out.length > SMS_MAX) out = out.slice(0, SMS_MAX - 3).trimEnd() + "...";
  return out + SMS_TAIL;
}

/* Prefer the secret over the constant. ADMIN_PHONE is hardcoded, and a
 * hardcoded number keeps working after the real one changes — the same trap
 * twilio-voice removed from RENE_CELL. Unlike a call route, an alert with no
 * destination is worse than one sent to a stale number, so the constant stays
 * as a fallback rather than failing closed to silence. Which one was used is
 * reported, so drift is visible instead of assumed. */
function adminPhone(): { to: string; source: "RENE_CELL" | "hardcoded" } {
  const env = (Deno.env.get("RENE_CELL") || "").trim();
  return env ? { to: env, source: "RENE_CELL" } : { to: ADMIN_PHONE, source: "hardcoded" };
}

/* RETURNS A RECEIPT, NOT A MOOD.
 *
 * This used to `return res.ok` — the HTTP status of the call to sms-service.
 * sms-service answers 200 with `{sent:false, error:"..."}` when Twilio rejects
 * the message, so res.ok was true for a send that never happened. The only
 * honest evidence a message exists is a Twilio message SID, so that is what
 * comes back and what gets reported. */
async function sendSms(message: string): Promise<{ ok: boolean; sid: string | null; error: string | null; to: string; to_source: string }> {
  const { to, source } = adminPhone();
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/sms-service`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({
        trigger: "custom",
        to_phone: to,
        /* The digest, not the report. The full text is in the CRM row. */
        params: { message: smsDigest(message) },
        /* SEND FROM THE ASSISTANT NUMBER, not the business line. Two reasons:
         * the 888 is the thread the daily digest and loan nudges already
         * arrive in, so an alert lands where Rene is looking; and the 866 is
         * the public line borrowers call and text, where a reply to an alert
         * would drop into customer flow via twilio-inbound. Same env var
         * loan-date-nudges uses, so there is one answer to "which number is
         * ours". */
        from_phone: ASSISTANT_FROM,
      }),
    });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* non-JSON body is itself the error */ }
    if (!res.ok) {
      return { ok: false, sid: null, error: `sms-service HTTP ${res.status}: ${text.slice(0, 200)}`, to, to_source: source };
    }
    const sid = data?.sid ? String(data.sid) : null;
    const ok = data?.sent === true && !!sid;
    return {
      ok, sid,
      error: ok ? null : String(data?.error || "sms-service reported no send and returned no SID"),
      to, to_source: source,
    };
  } catch (e) {
    console.error("[gdrive-health] sms send failed:", e);
    return { ok: false, sid: null, error: String(e), to, to_source: source };
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
    const backup = await checkBackupHealth();
    const mirror = await checkDocumentMirror();
    /* Rows vs objects. Runs every hour AND is the mandatory post-restore gate —
     * a restore is exactly when direction A goes from zero to many. */
    const recon = await reconcileStorage(sb);
    const sigRec = await checkSignatureRecords();
    const allOk = oauth.ok && driveCred.ok && staticKeys.ok && embeddings.ok
      && syncStatus.ok && indexing.ok && backup.ok && recon.ok && mirror.ok && sigRec.ok;

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
      /* Reported even while suppressed, so a muted check is still visible to
       * anyone reading this JSON rather than looking like a healthy one. */
      backup_stale: backup.stale,
      backup_stale_suppressed_until: backup.suppressed_until,
      backup_stale_suppression_reason: backup.suppression_reason,
      backup_failed_run: backup.failed_run,
      mirror_ok: mirror.ok,
      mirror_stranded: mirror.stranded,
      mirror_oldest_minutes: mirror.oldest_minutes,
      reconcile_ok: recon.ok,
      reconcile_dangling: recon.dangling,
      reconcile_orphans: recon.orphans,
      signature_records_ok: sigRec.ok,
      signature_records_ran: sigRec.ran,
      signature_records_reason: sigRec.reason ?? null,
      signature_records_missing: sigRec.missing,
      signature_records_failed: sigRec.failed,
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
      /* Green runs are recorded too. "Nothing was red at 04:00" is exactly the
       * fact you need to bound when something started, and it is the fact the
       * overwritten system_state row could never supply. */
      await recordRun(result, "healthy", [], [], null, false, null);
      return ok({ ...result, status: "healthy" });
    }

    /* ── THE RED SET ─────────────────────────────────────────────────────────
     *
     * Every failing check, in severity order. The chain below still picks which
     * one gets the full explanatory body — that ordering is real and worth
     * keeping — but nothing is invisible any more, because every entry here
     * appears in the digest header.
     *
     * KEYS ARE IDENTITY, NEVER CONTENT. This is the one deliberate rule
     * replacing three accidents: `storage_orphans:<buckets>`,
     * `static_keys:<names>` and `signature_record_missing:<count>` each baked
     * their own payload into the alert key, so an orphan count moving 1→2
     * minted a new key and re-alerted while a steady 1 stayed silent for 12
     * hours. Now the key is the check's name and nothing else, and the DIGEST
     * key is the sorted set of red check names.
     *
     * The consequence is deliberate and worth stating: a change WITHIN an
     * already-reported check (orphans 1→2, a second failing API key) no longer
     * re-alerts during the cooldown window. What always re-alerts is a check
     * that was not red before, because that changes the set. "Something new
     * broke" is the event worth interrupting someone for; "the thing you were
     * already told about got slightly worse" is not.
     *
     * `ran: false` is carried separately all the way into the summary line, so
     * a check that could not run never reads as either a pass or a failure —
     * the distinction that found the Drive probe in the first place. */
    type CheckRow = { key: string; label: string; ok: boolean; ran: boolean };
    const CHECKS: CheckRow[] = [
      { key: "drive_write", label: "Drive write credential", ok: driveCred.ok,
        ran: !(driveCred.stage && PROBE_UNRUNNABLE_STAGES.has(driveCred.stage)) },
      { key: "mirror", label: "Documents reaching Drive", ok: mirror.ok, ran: true },
      { key: "storage_dangling", label: "Dangling references", ok: !recon.dangling.some((d) => d.count !== 0), ran: true },
      { key: "signature_records", label: "Signed record PDFs", ok: sigRec.ok, ran: sigRec.ran },
      { key: "storage_orphans", label: "Orphaned storage objects", ok: !recon.orphans.some((o) => o.over > 0), ran: true },
      { key: "static_keys", label: "API credentials", ok: staticKeys.ok, ran: true },
      { key: "backup", label: "CRM backup", ok: backup.ok && !backup.failed_run, ran: true },
      { key: "embeddings", label: "Guideline embeddings", ok: embeddings.ok, ran: true },
      { key: "oauth", label: "Google OAuth", ok: oauth.ok, ran: true },
      { key: "sync", label: "Drive sync queue", ok: syncStatus.ok, ran: true },
      { key: "indexing", label: "Guideline indexing", ok: indexing.ok, ran: true },
    ];
    const redChecks = CHECKS.filter((c) => !c.ok);
    const unrunnable = redChecks.filter((c) => !c.ran);
    /* Sorted so the key depends on WHICH checks are red, never on the order
     * they happen to be evaluated in. */
    const digestKey = "digest:" + redChecks.map((c) => c.key).sort().join("+");
    result.red_checks = redChecks.map((c) => c.key);
    result.unrunnable_checks = unrunnable.map((c) => c.key);

    /* Phone-first. Count on line one, then one line per red check in severity
     * order. No wrapping, no detail — the body underneath carries that. */
    const digestHeader = [
      `${redChecks.some((c) => c.ran) ? RED : "⚠️"} ${redChecks.length} check${redChecks.length === 1 ? "" : "s"} red` +
        (unrunnable.length ? ` (${unrunnable.length} could NOT run)` : ""),
      "",
      ...redChecks.map((c) => `  ${c.ran ? RED : "⚠️"} ${c.label} — ${c.ran ? "FAILED" : "COULD NOT RUN"}`),
      "",
      "─".repeat(28),
      "",
    ];

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
    } else if (!mirror.ok) {
      /* Ahead of the storage checks: a document stuck in the bucket is a
       * document the CRM shows on a borrower's file and Drive does not have.
       * That is the same broken promise as a dangling reference, arriving from
       * the other direction. */
      alert = {
        key: "mirror_backlog",
        message: [
          `${RED} Borrower documents are NOT reaching Drive`,
          "",
          mirror.stranded === -1
            ? "The mirror check itself failed — see the details below."
            : `${mirror.stranded} document(s) stored ${MIRROR_STALE_MINUTES}+ minutes ago still have no Drive file.` +
              (mirror.oldest_minutes ? ` Oldest: ${mirror.oldest_minutes} minutes.` : ""),
          "",
          ...mirror.samples.map((s) => `  • ${s}`),
          "",
          "The Drive WRITE credential can be healthy while this is broken — it",
          "was, for two and a half days in August, because the defect was in",
          "gdrive-sync's own code and threw before the credential was used.",
          "Call gdrive-sync sync_all_pending and READ THE ERROR IT RETURNS.",
        ].join("\n"),
      };
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
    /* ABOVE the orphan branch, deliberately. A completed signature with no
       legal record outranks a count of known template files sitting in a
       bucket. It is also the ordering that stops a persistent, accepted orphan
       count from indefinitely holding the channel against a live failure —
       which is exactly what happened the moment this check shipped: the
       voe-forms orphan masked it on its first run.
       That fixes THIS pair. It does not fix the general shape: one alert per
       run means whatever is highest and persistently red still masks
       everything below it. See the masking report. */
    } else if (!sigRec.ok) {
      /* Two different claims, two different alerts — the distinction the Drive
         probe had to learn. "could not run" must never read as either a pass
         or a failure. */
      alert = !sigRec.ran
        ? {
            key: "signature_record_check_unrunnable",
            message: [
              "⚠️ Signed-record check could NOT RUN",
              "",
              `Blocked at: ${sigRec.reason}`,
              "",
              "This says NOTHING about whether record PDFs are being written.",
              "The check itself did not complete — treat record generation as",
              "UNVERIFIED, not as broken and not as healthy.",
            ].join("\n"),
          }
        : {
            key: "signature_record_missing:" + [...sigRec.missing, ...sigRec.failed].length,
            message: [
              `${RED} Completed signature(s) with NO record PDF`,
              "",
              ...(sigRec.failed.length
                ? ["Generation FAILED in the last hour:", ...sigRec.failed.map((f) => "  • " + f), ""]
                : []),
              ...(sigRec.missing.length
                ? [`Completed over ${RECORD_PDF_GRACE_MINUTES} min ago with no final_pdf_path:`,
                   ...sigRec.missing.map((m) => "  • " + m), ""]
                : []),
              "The signature itself is intact — signature_events, signature_signers",
              "and document_hash are all durable, and the completion email carries",
              "the signed document and certificate inline. What is missing is the",
              "PDF record of it.",
              "",
              "Look for a record_failed event on the envelope; its detail carries",
              "the storage error. Eight requests completed before 2026-08-09 are",
              "excluded by design and will never appear here.",
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
    } else if (backup.failed_run) {
      /* Ahead of staleness deliberately. A failed run is a fact about the last
       * thing that actually happened; staleness is an inference from silence.
       * When both are true the failure is the more actionable of the two. */
      alert = {
        key: "backup_failed",
        message: [
          `${RED} CRM backup RUN FAILED`,
          "",
          `Newest backup_logs row: ${backup.failed_run.date} — status 'failed'.`,
          "",
          ...(backup.failed_run.sections.length
            ? ["Sections that failed:", ...backup.failed_run.sections.map((s) => `  • ${s}`)]
            : ["No per-section detail was recorded."]),
          "",
          "backup:last_verified was deliberately NOT advanced, so the last",
          "verified backup is still whatever it was before this run. Do not",
          "treat the folder for this date as a usable backup: some sections",
          "uploaded and some did not.",
          "",
          backup.last
            ? `Last VERIFIED backup: ${backup.last}${backup.age_days !== undefined ? ` (${backup.age_days} days ago)` : ""}.`
            : "No verified backup has ever been recorded.",
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
          "Check first whether pg_cron job 'weekly-crm-backup' is still enabled —",
          "it has been disabled before, and a disabled job produces exactly this",
          "symptom while looking like nothing is wrong.",
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

    /* The digest replaces the single-alert key. `alert` still supplies the
     * detailed body for the MOST SEVERE red check — that is the one with an
     * actionable fix — but the header above lists every one of them, and the
     * cooldown is now keyed on the whole set.
     *
     * Why this removes masking rather than moving it: there is no longer a
     * branch that "wins". Under the old chain a cooldown on the top red check
     * returned early and silenced the entire run, so a lower check could be red
     * for days and never be mentioned. storage_orphans spent 32 hours that way
     * under drive_write_probe_unrunnable. Now a set containing a new member is
     * a different key, so it is never suppressed by an older member's
     * cooldown. */
    const digestMessage = [...digestHeader, alert.message].join("\n");
    alert = { key: digestKey, message: digestMessage };

    if (!force) {
      const can = await shouldAlert(alert.key, redChecks.some((c) => c.key === "drive_write" && c.ran));
      if (!can) {
        result.alert_skipped_reason = "cooldown";
        await recordRun(result, "unhealthy_silent", redChecks.map((c) => c.key), unrunnable.map((c) => c.key), digestKey, false, "cooldown");
        return ok({ ...result, status: "unhealthy_silent", would_send: alert.message });
      }
    }

    const crm = await notifyInCrm(alert.message);
    const sent = await sendSms(alert.message);

    /* Receipts, per leg. alert_sent used to be `sent || mentioned` where both
     * inputs were optimistic — one measured an HTTP status from a wrapper that
     * answers 200 on failure, the other measured that a call returned. It was
     * true whether or not anything was delivered, which is how an alert nobody
     * received was reported as sent for a whole session. */
    /* TWO SEPARATE FIELDS, so one working leg cannot mask a broken one. That
     * masking is what hid a channel that had never delivered anything: SMS
     * worked, the OR was true, and nobody looked at the other half.
     *
     * sms_delivered means Twilio ACCEPTED the message and issued a SID. It is
     * not carrier confirmation — that only exists minutes later, and only from
     * the Twilio API against the SID recorded here. The name is Rene's; the
     * limit is written down so it cannot quietly become the next optimistic
     * boolean. */
    result.sms_delivered = sent.ok;
    result.alert_sms_sid = sent.sid;
    result.alert_sms_error = sent.error;
    result.alert_sms_to = sent.to;
    result.alert_sms_to_source = sent.to_source;
    result.crm_notified = crm.ok;
    result.alert_notification_ids = crm.ids;
    result.alert_notification_error = crm.error;
    /* Kept, but now derived from the two above rather than being the only
     * thing reported. A caller that reads alert_sent alone still learns
     * "something got through", never "everything worked". */
    if (sent.ok !== crm.ok) {
      console.warn(`[gdrive-health] PARTIAL DELIVERY sms=${sent.ok} crm=${crm.ok} sms_err=${sent.error} crm_err=${crm.error}`);
    }

    if (sent.ok || crm.ok) {
      result.alert_sent = true;
      /* Only now. Marking a failed alert as sent mutes the retry for 12 hours,
       * so a delivery outage would silence exactly the alerts that prove it. */
      await markAlertSent(alert.key, alert.message);
    } else {
      result.alert_skipped_reason = `all_delivery_legs_failed: sms=${sent.error}; crm=${crm.error}`;
    }

    await recordRun(result, "unhealthy", redChecks.map((c) => c.key), unrunnable.map((c) => c.key),
                    digestKey, !!result.alert_sent, result.alert_skipped_reason ?? null);
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

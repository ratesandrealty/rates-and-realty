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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_PHONE = "+17144728508";
const REAUTH_URL = "https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/google-calendar-auth";
const SUPABASE_SECRETS_URL = "https://supabase.com/dashboard/project/ljywhvbmsibwnssxpesh/settings/functions";
const ALERT_COOLDOWN_HOURS = 12;

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

async function shouldAlert(alertKey: string): Promise<boolean> {
  const stateKey = `gdrive_alert:${alertKey}`;
  const { data } = await sb.from("system_state")
    .select("value, updated_at").eq("key", stateKey).single();
  if (!data?.updated_at) return true;
  const ageHours = (Date.now() - new Date(data.updated_at).getTime()) / 3600000;
  return ageHours >= ALERT_COOLDOWN_HOURS;
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
  const ok = (d: any) => new Response(JSON.stringify(d, null, 2), { headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const url = new URL(req.url);
    let force = url.searchParams.get("force") === "1";
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body.force) force = true;
    }

    const oauth = await checkOAuth();
    const syncStatus = await checkPendingSyncs();
    const indexing = await checkIndexingHealth();
    const allOk = oauth.ok && syncStatus.ok && indexing.ok;

    const result: any = {
      checked_at: new Date().toISOString(),
      oauth_ok: oauth.ok,
      oauth_reason: oauth.reason,
      oauth_failure_kind: oauth.failure_kind,
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
    if (!oauth.ok) {
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

    const sent = await sendSms(alert.message);
    if (sent) {
      result.alert_sent = true;
      await markAlertSent(alert.key, alert.message);
    } else {
      result.alert_skipped_reason = "sms_send_failed";
    }

    return ok({ ...result, status: "unhealthy", message: alert.message });
  } catch (e: any) {
    console.error("[gdrive-health] FATAL:", e);
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});

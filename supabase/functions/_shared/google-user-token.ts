/* ONE resolver for the user's Google OAuth token.
 *
 * WHY THIS EXISTS
 * There were two credentials for the same Google account, and only one of them
 * was being kept alive:
 *
 *   google_calendar_tokens (id='rene')  — a row, refreshed every 30 minutes by
 *                                          the google-token-refresh cron, and
 *                                          re-mintable by visiting
 *                                          google-calendar-auth. Healthy.
 *   GOOGLE_DRIVE_REFRESH_TOKEN (secret) — set by hand once, refreshed by
 *                                          nothing, re-auth-able by nobody.
 *                                          Dead since ~2026-07-31 20:40.
 *
 * gdrive-proxy read the row. gdrive-sync and weekly-backup read the secret. So
 * the calendar half of the same Google account stayed green while every
 * document mirror failed with invalid_grant — and the health monitor, reading
 * the secret, could not tell anyone which of the two it meant.
 *
 * The row is the source of truth now. A human re-authorises in one click and
 * everything that talks to Drive picks it up, because they all come here.
 * The secret remains a fallback ONLY so this change cannot make a working
 * deployment worse; once the row is proven good it should be deleted, like
 * GOOGLE_DRIVE_ACCESS_TOKEN was.
 */

export const USER_TOKEN_ID = "rene";

export type TokenSource = "table" | "secret" | "none";

export async function getDriveRefreshToken(
  sb: any,
): Promise<{ token: string | null; source: TokenSource }> {
  try {
    const { data } = await sb.from("google_calendar_tokens")
      .select("refresh_token").eq("id", USER_TOKEN_ID).maybeSingle();
    if (data?.refresh_token) return { token: data.refresh_token, source: "table" };
  } catch (e) {
    console.error("[google-user-token] table read failed:", String(e));
  }
  const secret = Deno.env.get("GOOGLE_DRIVE_REFRESH_TOKEN") || "";
  if (secret) return { token: secret, source: "secret" };
  return { token: null, source: "none" };
}

/** Mint an access token. Throws with the provider's own words — an auth failure
 *  that reads "something went wrong" is how this went unnoticed for a day. */
export async function getDriveAccessToken(
  sb: any,
): Promise<{ accessToken: string; source: TokenSource }> {
  const { token, source } = await getDriveRefreshToken(sb);
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
  if (!token) throw new Error("No Google refresh token: google_calendar_tokens row is empty and GOOGLE_DRIVE_REFRESH_TOKEN is unset");
  if (!clientId || !clientSecret) throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set");

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: token,
      client_id: clientId, client_secret: clientSecret,
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) {
    throw new Error(`Google token refresh failed (source=${source}): ${d.error || r.status}${d.error_description ? ": " + d.error_description : ""}`);
  }
  return { accessToken: d.access_token, source };
}

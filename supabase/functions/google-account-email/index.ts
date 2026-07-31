// google-account-email — returns the email address that owns the OAuth token
// Used by the frontend to pin Drive folder URLs to the correct account, eliminating
// the "Choose an account" picker dialog when clicking 'View Drive Folder'.
//
// Strategy:
//   1. Check google_calendar_tokens.email — if present, return it (fast path)
//   2. Otherwise refresh the access token, hit Google's userinfo endpoint, store + return

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

async function getValidAccessToken(): Promise<string | null> {
  const { data } = await sb.from("google_calendar_tokens").select("*").eq("id", "rene").maybeSingle();
  if (!data) return null;
  const expiresAt = new Date(data.expires_at).getTime();
  if (expiresAt - Date.now() > 5 * 60 * 1000) return data.access_token;
  if (!data.refresh_token) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: data.refresh_token, grant_type: "refresh_token",
    }),
  });
  const tokens = await res.json();
  if (!tokens.access_token) return null;
  await sb.from("google_calendar_tokens").update({
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", "rene");
  return tokens.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  try {
    // Fast path: cached email
    const { data: row } = await sb.from("google_calendar_tokens").select("email").eq("id", "rene").maybeSingle();
    if (row?.email) {
      return new Response(JSON.stringify({ email: row.email, source: "cache" }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    // Slow path: query Google
    const token = await getValidAccessToken();
    if (!token) {
      return new Response(JSON.stringify({ error: "no_token" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!userInfoRes.ok) {
      const txt = await userInfoRes.text();
      return new Response(JSON.stringify({ error: "userinfo_failed", detail: txt }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const info = await userInfoRes.json();
    if (info.email) {
      await sb.from("google_calendar_tokens").update({ email: info.email }).eq("id", "rene");
      // Also cache in app_config so other surfaces can read it without an edge function call
      await sb.from("app_config").upsert({ key: "google_drive_account_email", value: JSON.stringify(info.email) });
    }
    return new Response(JSON.stringify({ email: info.email, source: "google" }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});

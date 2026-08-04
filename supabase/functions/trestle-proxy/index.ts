import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TRESTLE_TOKEN_URL = "https://api.cotality.com/trestle/oidc/connect/token";
const TRESTLE_API_BASE = "https://api.cotality.com/trestle/odata";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

async function getTrestleToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  const clientId = Deno.env.get("TRESTLE_CLIENT_ID");
  const clientSecret = Deno.env.get("TRESTLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("TRESTLE credentials not configured");
  const res = await fetch(TRESTLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope: "api" }),
  });
  if (!res.ok) throw new Error(`Trestle auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken!;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  // ── PHOTO PROXY (GET ?photo=URL) ───────────────────────────────────────────
  // Email clients can't send auth headers, so we proxy photos through here.
  // Usage: GET /trestle-proxy?photo=https://api.cotality.com/trestle/Media/...
  if (req.method === "GET") {
    const url = new URL(req.url);
    const photoUrl = url.searchParams.get("photo");
    if (!photoUrl) {
      return new Response(JSON.stringify({ error: "photo param required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    // Validate it's a Trestle URL to prevent open redirect
    if (!photoUrl.startsWith("https://api.cotality.com/trestle/")) {
      return new Response(JSON.stringify({ error: "Invalid photo URL" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    try {
      const token = await getTrestleToken();
      const imgRes = await fetch(photoUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: "image/*" }
      });
      if (!imgRes.ok) {
        return new Response(null, { status: imgRes.status, headers: corsHeaders });
      }
      const contentType = imgRes.headers.get("Content-Type") || "image/jpeg";
      const imageBytes = await imgRes.arrayBuffer();
      return new Response(imageBytes, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=86400", // Cache for 24h
        }
      });
    } catch (e: any) {
      console.error("[trestle-proxy] Photo proxy error:", e.message);
      return new Response(null, { status: 500, headers: corsHeaders });
    }
  }

  // ── DATA PROXY (POST) ─────────────────────────────────────────────────────
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    const { endpoint, params, rawFilter } = await req.json();
    if (!endpoint) {
      return new Response(JSON.stringify({ error: "endpoint is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    const token = await getTrestleToken();
    let queryString = "";
    if (rawFilter) queryString = "?" + rawFilter;
    else if (params) queryString = "?" + new URLSearchParams(params).toString();
    const url = `${TRESTLE_API_BASE}/${endpoint}${queryString}`;
    console.log("[trestle-proxy] URL:", url.substring(0, 300));
    const mlsRes = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    console.log("[trestle-proxy] Status:", mlsRes.status);
    if (!mlsRes.ok) {
      const errText = await mlsRes.text();
      console.log("[trestle-proxy] Error:", errText.substring(0, 300));
      return new Response(JSON.stringify({ error: `Trestle API error: ${mlsRes.status}`, detail: errText }), {
        status: mlsRes.status, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    const mlsData = await mlsRes.json();
    return new Response(JSON.stringify(mlsData), {
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});

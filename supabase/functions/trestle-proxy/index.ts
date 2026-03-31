import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TRESTLE_TOKEN_URL = "https://replication.trestle.us/connect/token";
const TRESTLE_API_BASE = "https://api.bridgedataoutput.com/api/v2/OData/trestle";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

async function getTrestleToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const clientId = Deno.env.get("TRESTLE_CLIENT_ID");
  const clientSecret = Deno.env.get("TRESTLE_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new Error("TRESTLE_CLIENT_ID or TRESTLE_CLIENT_SECRET not configured");
  }

  const res = await fetch(TRESTLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "api",
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Trestle auth failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // Expire 60s early to avoid edge cases
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken!;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { endpoint, params } = await req.json();

    if (!endpoint) {
      return new Response(JSON.stringify({ error: "endpoint is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = await getTrestleToken();

    // Build query string from params
    const queryString = params
      ? "?" + new URLSearchParams(params).toString()
      : "";
    const url = `${TRESTLE_API_BASE}/${endpoint}${queryString}`;

    const mlsRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!mlsRes.ok) {
      const errText = await mlsRes.text();
      return new Response(
        JSON.stringify({ error: `Trestle API error: ${mlsRes.status}`, detail: errText }),
        {
          status: mlsRes.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const mlsData = await mlsRes.json();
    return new Response(JSON.stringify(mlsData), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e.message || "Internal error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

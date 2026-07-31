// portal-profile v1 — service-key safe access to portal_users
// Exists so the browser never needs anon access to portal_users (which exposes
// password_hash / reset tokens). Returns ONLY non-secret fields.
// verify_jwt=false: called from the borrower portal + admin with the anon key,
// same posture as portal-auth/portal-data; all DB access uses the service key.
//
// POST body:
//   { action: 'update', user_id, first_name, last_name, phone }  -> update own profile
//   { action: 'lookup_email', email }                            -> admin lookup by email
//   { action: 'get', user_id }                                   -> fetch one profile

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// Non-secret columns only. NEVER include password_hash, temp_password,
// verification_token, reset_token, reset_token_expires.
const SAFE = "id, email, first_name, last_name, phone, email_verified, contact_id";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};
function j(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return j({ error: "POST only" }, 405);
  try {
    const body = await req.json();
    const action = body.action;

    if (action === "update") {
      if (!body.user_id) return j({ error: "user_id required" }, 400);
      const first = (body.first_name ?? "").toString().trim();
      if (!first) return j({ error: "first_name required" }, 400);
      const patch: Record<string, any> = {
        first_name: first,
        last_name: (body.last_name ?? "").toString().trim(),
        phone: (body.phone ?? "").toString().trim(),
      };
      const { data, error } = await sb.from("portal_users")
        .update(patch).eq("id", body.user_id).select(SAFE).maybeSingle();
      if (error) return j({ error: error.message }, 500);
      if (!data) return j({ error: "not found" }, 404);
      return j({ user: data });
    }

    if (action === "get") {
      if (!body.user_id) return j({ error: "user_id required" }, 400);
      const { data, error } = await sb.from("portal_users")
        .select(SAFE).eq("id", body.user_id).maybeSingle();
      if (error) return j({ error: error.message }, 500);
      return j({ user: data || null });
    }

    if (action === "lookup_email") {
      const email = (body.email ?? "").toString().trim();
      if (!email) return j({ error: "email required" }, 400);
      const { data, error } = await sb.from("portal_users")
        .select(SAFE).ilike("email", email).limit(5);
      if (error) return j({ error: error.message }, 500);
      return j({ users: data || [] });
    }

    return j({ error: "unknown action" }, 400);
  } catch (e: any) {
    return j({ error: e?.message || String(e) }, 500);
  }
});

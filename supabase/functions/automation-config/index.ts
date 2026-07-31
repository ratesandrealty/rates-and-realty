// automation-config v1 — service-key CRUD for clickup_automation_config
// The admin dashboard has no Supabase auth session, and the table's RLS only allows
// authenticated UPDATE (no INSERT/DELETE policy), so all writes route through here.
// verify_jwt=false: callable with the anon key, same posture as clickup-bridge.
//
// Routes:
//   GET  /automation-config            -> { configs: [...] }
//   POST /automation-config/save       -> upsert one rule (id present = update, else insert)
//   POST /automation-config/delete     -> { id } delete one rule

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEFAULT_LIST = Deno.env.get("CLICKUP_LIST_ID_TODO") || "901708416155";
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function j(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

const FIELDS = [
  "trigger_type", "display_name", "enabled", "default_priority",
  "due_offset_days", "due_offset_hours", "list_id",
  "title_template", "description_template", "description", "display_order",
];

function slugify(s: string): string {
  return String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").substring(0, 40);
}

async function listConfigs() {
  const { data, error } = await sb.from("clickup_automation_config").select("*")
    .order("display_order", { ascending: true }).order("trigger_type", { ascending: true });
  if (error) throw new Error(error.message);
  return { configs: data || [] };
}

async function saveConfig(body: any) {
  const row: Record<string, any> = {};
  for (const k of FIELDS) if (body[k] !== undefined) row[k] = body[k];

  if (body.id) {
    row.updated_at = new Date().toISOString();
    const { data, error } = await sb.from("clickup_automation_config")
      .update(row).eq("id", body.id).select("*").maybeSingle();
    if (error) throw new Error(error.message);
    return { config: data };
  }

  // INSERT (new rule)
  if (!row.title_template) throw new Error("title_template required");
  // Custom rules get an auto trigger_type if none supplied.
  if (!row.trigger_type) {
    row.trigger_type = "custom_" + (slugify(row.display_name || row.title_template) || Date.now().toString(36));
  }
  if (!row.list_id) row.list_id = DEFAULT_LIST;
  if (row.enabled === undefined) row.enabled = true;
  if (row.default_priority === undefined) row.default_priority = "normal";
  if (row.due_offset_days === undefined) row.due_offset_days = 1;
  if (row.display_order === undefined) row.display_order = 200;
  const { data, error } = await sb.from("clickup_automation_config")
    .insert(row).select("*").maybeSingle();
  if (error) throw new Error(error.message);
  return { config: data };
}

async function deleteConfig(body: any) {
  if (!body.id) throw new Error("id required");
  const { error } = await sb.from("clickup_automation_config").delete().eq("id", body.id);
  if (error) throw new Error(error.message);
  return { success: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);
  const path = url.pathname.split("/").filter(Boolean);
  const sub = path[1] || "";
  try {
    if (req.method === "GET") return j(await listConfigs());
    if (req.method === "POST" && sub === "save") return j(await saveConfig(await req.json()));
    if (req.method === "POST" && sub === "delete") return j(await deleteConfig(await req.json()));
    return j({ name: "automation-config", routes: ["GET /", "POST /save", "POST /delete"] });
  } catch (e: any) {
    console.error("automation-config error:", e);
    return j({ error: e?.message || String(e) }, 500);
  }
});

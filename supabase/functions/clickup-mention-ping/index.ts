// clickup-mention-ping — creates an assigned ClickUp task when someone is @-mentioned in the CRM.
// Isolated from clickup-bridge on purpose (zero blast radius). Reuses the project's CLICKUP_API_TOKEN.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CLICKUP_TOKEN = Deno.env.get("CLICKUP_API_TOKEN") || "";
const DEFAULT_LIST = Deno.env.get("CLICKUP_LIST_ID_TODO") || "901708416155";
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
    if (!CLICKUP_TOKEN) return j({ error: "CLICKUP_API_TOKEN not set" });
    const b = await req.json();
    if (!b.title) return j({ error: "title required" });

    const payload: any = { name: String(b.title) };
    if (b.description) payload.description = String(b.description);
    if (b.priority) {
      const map: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };
      payload.priority = map[String(b.priority)] || 3;
    }
    if (Array.isArray(b.assignees) && b.assignees.length) {
      payload.assignees = b.assignees.map((a: any) => Number(a)).filter((n: number) => !Number.isNaN(n));
    }
    const listId = b.list_id || DEFAULT_LIST;

    const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, {
      method: "POST",
      headers: { "Authorization": CLICKUP_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return j({ error: `ClickUp ${res.status}`, detail: data });
    return j({ success: true, clickup_task_id: data.id, url: data.url });
  } catch (e: any) {
    return j({ error: e?.message || String(e) });
  }
});

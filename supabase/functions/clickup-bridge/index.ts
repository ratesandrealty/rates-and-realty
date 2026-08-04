// clickup-bridge v7 — createTask persists assigned_to/assigned_by and creates the CRM tasks
// row when assigned_to is present even without a contact (enables VA "assign to Rene").
// v6: POST /task/comment. v5: resolve-contacts. v4: prune deleted on sync.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLICKUP_TOKEN = Deno.env.get("CLICKUP_API_TOKEN") || "";
const CLICKUP_TODO_LIST_ID = Deno.env.get("CLICKUP_LIST_ID_TODO") || "901708416155";
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function j(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function isDeletedErr(e: any): boolean {
  const m = (e && e.message ? e.message : "").toLowerCase();
  return m.includes(" 404") || m.includes("item_013") || m.includes("not found");
}

/* Target list, configurable. app_config wins over the env default so the capture
 * widget can be pointed at a different list without a redeploy. Falls back to the
 * env var, then the historical hardcoded id, so nothing that works today breaks. */
async function resolveListId(explicit?: string): Promise<string> {
  if (explicit) return String(explicit);
  try {
    const { data } = await sb.from("app_config").select("value").eq("key", "clickup_capture_list_id").maybeSingle();
    const v = data && typeof data.value === "string" ? data.value.replace(/^"|"$/g, "").trim() : "";
    if (v) return v;
  } catch (_) { /* config unreadable → env default */ }
  return CLICKUP_TODO_LIST_ID;
}

/* Attach BYTES to a ClickUp task, not a URL.
 *
 * A Supabase signed URL would expire and leave a dead link in ClickUp forever;
 * a public URL would mean a public bucket, which is exactly what the private
 * task-screenshots bucket exists to avoid. ClickUp stores its own copy.
 *
 * multipart/form-data, so Content-Type must NOT be set by hand — the boundary
 * comes from FormData. And the token goes in raw: ClickUp v2 personal tokens are
 * NOT Bearer, which is the same mistake that was 401ing sms-assistant before its
 * v33 fix. clickupFetch() is deliberately not reused here because it forces
 * application/json. */
async function attachToClickup(taskId: string, bytes: Uint8Array, contentType: string, filename: string) {
  if (!CLICKUP_TOKEN) throw new Error("CLICKUP_API_TOKEN not set");
  const fd = new FormData();
  fd.append("attachment", new Blob([bytes as unknown as BlobPart], { type: contentType || "application/octet-stream" }), filename);
  const res = await fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}/attachment`, {
    method: "POST",
    headers: { "Authorization": CLICKUP_TOKEN },
    body: fd,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`ClickUp attach ${res.status}: ${t.substring(0, 200)}`);
  }
  return await res.json().catch(() => ({}));
}

function b64ToBytes(b64: string): Uint8Array {
  const clean = String(b64 || "").replace(/^data:[^;]+;base64,/, "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = clean.length % 4 ? "=".repeat(4 - (clean.length % 4)) : "";
  const bin = atob(clean + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pruneCacheRow(id: string) {
  await sb.from("clickup_task_cache").delete().eq("clickup_task_id", id);
  await sb.from("tasks").update({ status: "completed", updated_at: new Date().toISOString() }).eq("clickup_task_id", id);
}

async function clickupFetch(path: string, init: RequestInit = {}): Promise<any> {
  if (!CLICKUP_TOKEN) throw new Error("CLICKUP_API_TOKEN not set");
  const url = path.startsWith("http") ? path : `https://api.clickup.com/api/v2${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { "Authorization": CLICKUP_TOKEN, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`ClickUp ${res.status}: ${txt.substring(0, 300)}`);
  }
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

async function fetchAllTasksFromList(listId: string): Promise<any[]> {
  const all: any[] = [];
  let page = 0;
  const maxPages = 10;
  while (page < maxPages) {
    const data = await clickupFetch(`/list/${listId}/task?archived=false&include_closed=true&subtasks=true&page=${page}`);
    const tasks = data.tasks || [];
    if (tasks.length === 0) break;
    all.push(...tasks);
    if (tasks.length < 100) break;
    page++;
  }
  return all;
}

function matchContactInTitle(title: string, contacts: any[]): string | null {
  const titleLower = (title || "").toLowerCase();
  for (const c of contacts) {
    const fn = (c.first_name || "").toLowerCase();
    const ln = (c.last_name || "").toLowerCase();
    if ((ln.length >= 4 && titleLower.includes(ln)) || (fn.length >= 4 && titleLower.includes(fn))) {
      return c.id;
    }
  }
  return null;
}

async function syncPull() {
  const listIds = [CLICKUP_TODO_LIST_ID];
  const { data: contacts } = await sb.from("contacts").select("id, first_name, last_name");
  let upserted = 0;
  let pruned = 0;
  const errors: any[] = [];
  for (const listId of listIds) {
    try {
      const tasks = await fetchAllTasksFromList(listId);
      const liveIds = new Set(tasks.map((t: any) => t.id));
      for (const t of tasks) {
        const due = t.due_date ? new Date(parseInt(t.due_date)).toISOString() : null;
        const assignee = t.assignees?.[0]?.username || null;
        const { data: existing } = await sb.from("clickup_task_cache")
          .select("contact_id").eq("clickup_task_id", t.id).maybeSingle();
        const contactId = existing?.contact_id || matchContactInTitle(t.name || "", contacts || []);
        const { error } = await sb.from("clickup_task_cache").upsert({
          clickup_task_id: t.id, contact_id: contactId, list_id: listId,
          list_name: t.list?.name || "Todo", title: t.name,
          status: t.status?.status || "to do", priority: t.priority?.priority || null,
          due_date: due, url: t.url, assignee_username: assignee,
          fetched_at: new Date().toISOString(), raw: t,
        }, { onConflict: "clickup_task_id" });
        if (!error) upserted++; else errors.push({ task: t.id, error: error.message });
      }
      const { data: cachedRows } = await sb.from("clickup_task_cache").select("clickup_task_id").eq("list_id", listId);
      const stale = (cachedRows || []).map((r: any) => r.clickup_task_id).filter((id: string) => !liveIds.has(id));
      if (stale.length > 0) {
        await sb.from("clickup_task_cache").delete().in("clickup_task_id", stale);
        await sb.from("tasks").update({ status: "completed", updated_at: new Date().toISOString() }).in("clickup_task_id", stale);
        pruned += stale.length;
      }
    } catch (e: any) { errors.push({ listId, error: e.message }); }
  }
  return { synced: upserted, pruned, lists: listIds.length, errors };
}

async function listTasks(url: URL) {
  const contactId = url.searchParams.get("contact_id");
  const status = url.searchParams.get("status");
  const search = (url.searchParams.get("q") || "").trim();
  const priority = url.searchParams.get("priority");
  const due = url.searchParams.get("due");
  const includeContact = url.searchParams.get("include_contact") !== "0";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);

  let q = sb.from("clickup_task_cache").select("*").order("due_date", { ascending: true, nullsFirst: false }).limit(limit);
  if (contactId === "unlinked") q = q.is("contact_id", null);
  else if (contactId) q = q.eq("contact_id", contactId);
  if (status === "open") q = q.not("status", "in", "(complete,closed,done)");
  else if (status === "complete") q = q.in("status", ["complete", "closed", "done"]);
  if (priority) q = q.eq("priority", priority);
  if (search) q = q.ilike("title", `%${search}%`);
  if (due === "overdue") q = q.lt("due_date", new Date().toISOString()).not("due_date", "is", null);
  else if (due === "today") {
    const start = new Date(); start.setHours(0,0,0,0);
    const end = new Date(); end.setHours(23,59,59,999);
    q = q.gte("due_date", start.toISOString()).lte("due_date", end.toISOString());
  } else if (due === "week") {
    const start = new Date(); start.setHours(0,0,0,0);
    const end = new Date(start.getTime() + 7 * 86400000);
    q = q.gte("due_date", start.toISOString()).lte("due_date", end.toISOString());
  }

  const { data, error } = await q;
  if (error) throw error;

  if (includeContact && data && data.length > 0) {
    const contactIds = [...new Set(data.map((t: any) => t.contact_id).filter(Boolean))];
    if (contactIds.length > 0) {
      const { data: contacts } = await sb.from("contacts").select("id, first_name, last_name, phone, email").in("id", contactIds);
      const contactMap = new Map((contacts || []).map((c: any) => [c.id, c]));
      for (const t of data) {
        if (t.contact_id) {
          const c = contactMap.get(t.contact_id);
          if (c) (t as any).contact = { id: c.id, name: `${c.first_name || ""} ${c.last_name || ""}`.trim(), phone: c.phone, email: c.email };
        }
      }
    }
  }

  const all = data || [];
  const counts = {
    total: all.length,
    open: all.filter((t: any) => !['complete','closed','done'].includes(t.status)).length,
    overdue: all.filter((t: any) => t.due_date && new Date(t.due_date) < new Date() && !['complete','closed','done'].includes(t.status)).length,
    today: all.filter((t: any) => t.due_date && new Date(t.due_date).toDateString() === new Date().toDateString()).length,
    unlinked: all.filter((t: any) => !t.contact_id).length,
    by_priority: {
      urgent: all.filter((t: any) => t.priority === 'urgent').length,
      high: all.filter((t: any) => t.priority === 'high').length,
      normal: all.filter((t: any) => t.priority === 'normal').length,
      low: all.filter((t: any) => t.priority === 'low').length,
    },
  };

  /* This endpoint serves clickup_task_cache, NOT live ClickUp. The cache is only
   * as fresh as the last successful sync-pull (cron jobid 15), and that job spent
   * from 2026-07-31 to 2026-08-04 returning 401 at the gateway while this endpoint
   * went on answering 200 with day-old rows. A caller cannot tell a current answer
   * from a stale one unless the answer says so, and the SMS assistant reads this
   * to tell Rene what is due TODAY — a confident, wrong, error-free answer.
   * Report age; let the caller decide what is too old. */
  const freshest = all.reduce((m: any, t: any) => (t.fetched_at && (!m || t.fetched_at > m) ? t.fetched_at : m), null as any);
  const ageMinutes = freshest ? Math.round((Date.now() - new Date(freshest).getTime()) / 60000) : null;
  return {
    tasks: all, count: all.length, counts,
    cache: {
      source: 'clickup_task_cache',
      last_synced_at: freshest,
      age_minutes: ageMinutes,
      // sync-pull runs every 15 minutes; an hour means at least three missed runs.
      stale: ageMinutes === null || ageMinutes > 60,
    },
  };
}

async function listContactsWithTasks() {
  const { data } = await sb.from("clickup_task_cache")
    .select("contact_id")
    .not("contact_id", "is", null);
  const ids = [...new Set((data || []).map((r: any) => r.contact_id))];
  if (ids.length === 0) return { contacts: [] };
  const { data: contacts } = await sb.from("contacts").select("id, first_name, last_name").in("id", ids).order("first_name");
  return { contacts: (contacts || []).map((c: any) => ({ id: c.id, name: `${c.first_name || ""} ${c.last_name || ""}`.trim() })) };
}

async function resolveContacts(body: any) {
  const ids = Array.isArray(body?.ids) ? body.ids.filter(Boolean) : [];
  if (!ids.length) return { contacts: {} };
  const { data } = await sb.from("contacts")
    .select("id, first_name, last_name, phone, email, pipeline_status, lead_status")
    .in("id", ids);
  const out: Record<string, any> = {};
  for (const c of (data || [])) {
    const full = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
    const name = full || c.email || c.phone || ("Contact " + String(c.id).slice(0, 6));
    out[c.id] = {
      name,
      phone: c.phone || "",
      email: c.email || "",
      stage: c.pipeline_status || c.lead_status || "",
    };
  }
  return { contacts: out };
}

async function createTask(body: any) {
  if (!body.title) throw new Error("title required");
  const listId = await resolveListId(body.list_id);
  const payload: any = { name: body.title };
  if (body.description) payload.description = body.description;
  if (body.due_date) payload.due_date = new Date(body.due_date).getTime();
  if (body.priority) {
    const map: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };
    payload.priority = map[body.priority] || 3;
  }
  if (body.contact_id) {
    const { data: contact } = await sb.from("contacts").select("first_name, last_name").eq("id", body.contact_id).maybeSingle();
    if (contact) {
      const tag = `${contact.first_name || ""} ${contact.last_name || ""}`.trim();
      if (tag) payload.tags = [tag.toLowerCase().replace(/\s+/g, "-")];
    }
  }
  const created = await clickupFetch(`/list/${listId}/task`, { method: "POST", body: JSON.stringify(payload) });
  await sb.from("clickup_task_cache").upsert({
    clickup_task_id: created.id, contact_id: body.contact_id || null,
    list_id: listId, list_name: created.list?.name || "Todo",
    title: created.name, status: created.status?.status || "to do",
    priority: created.priority?.priority || null,
    due_date: created.due_date ? new Date(parseInt(created.due_date)).toISOString() : null,
    url: created.url, fetched_at: new Date().toISOString(), raw: created,
  }, { onConflict: "clickup_task_id" });
  // Create the linked CRM tasks row when there is a contact OR an assignee.
  // assigned_to/assigned_by let the VA "assign to Rene" (and vice versa) surface in the
  // assignee's daily-tasks view. Inserted via service_role, so set assigned_by explicitly
  // (the auth.uid() trigger can't stamp it here).
  if (body.contact_id || body.assigned_to) {
    await sb.from("tasks").insert({
      title: body.title, description: body.description || null,
      contact_id: body.contact_id || null, due_date: body.due_date || null,
      priority: body.priority || "normal", status: "open",
      assigned_to: body.assigned_to || null, assigned_by: body.assigned_by || null,
      clickup_task_id: created.id, clickup_url: created.url,
      clickup_list_id: listId, clickup_synced_at: new Date().toISOString(),
    });
  }
  return { success: true, clickup_task_id: created.id, url: created.url };
}

/* Screenshot → ClickUp. Called after the task exists, so a failed attachment
 * never costs the task itself — the caller reports it separately. */
async function attachTask(body: any) {
  if (!body.clickup_task_id) throw new Error("clickup_task_id required");
  if (!body.data_b64) throw new Error("data_b64 required");
  const bytes = b64ToBytes(body.data_b64);
  const MAX = 10 * 1024 * 1024;
  if (bytes.length > MAX) throw new Error(`screenshot is ${(bytes.length / 1024 / 1024).toFixed(1)}MB, over the ${MAX / 1024 / 1024}MB limit`);
  const r = await attachToClickup(
    String(body.clickup_task_id),
    bytes,
    String(body.content_type || "image/png"),
    String(body.filename || "screenshot.png"),
  );
  return { success: true, attachment_id: r?.id || null, url: r?.url || null, bytes: bytes.length };
}

async function commentTask(body: any) {
  if (!body.clickup_task_id) throw new Error("clickup_task_id required");
  if (!body.comment_text) throw new Error("comment_text required");
  try {
    const res = await clickupFetch(`/task/${body.clickup_task_id}/comment`, {
      method: "POST",
      body: JSON.stringify({ comment_text: body.comment_text, notify_all: body.notify_all !== false }),
    });
    return { success: true, comment_id: res.id || null };
  } catch (e: any) {
    if (isDeletedErr(e)) { await pruneCacheRow(body.clickup_task_id); return { success: false, removed: true, note: "Task no longer in ClickUp." }; }
    throw e;
  }
}

async function updateTask(body: any) {
  if (!body.clickup_task_id) throw new Error("clickup_task_id required");
  const payload: any = {};
  if (body.title !== undefined) payload.name = body.title;
  if (body.description !== undefined) payload.description = body.description;
  if (body.due_date !== undefined) {
    payload.due_date = body.due_date ? new Date(body.due_date).getTime() : null;
  }
  if (body.priority !== undefined) {
    const map: Record<string, number | null> = { urgent: 1, high: 2, normal: 3, low: 4, none: null };
    payload.priority = body.priority === null || body.priority === 'none' ? null : (map[body.priority] || 3);
  }
  try {
    await clickupFetch(`/task/${body.clickup_task_id}`, { method: "PUT", body: JSON.stringify(payload) });
  } catch (e: any) {
    if (isDeletedErr(e)) { await pruneCacheRow(body.clickup_task_id); return { success: true, removed: true, note: "Task no longer in ClickUp; removed from CRM." }; }
    throw e;
  }
  const cacheUpdate: any = { fetched_at: new Date().toISOString() };
  if (body.title !== undefined) cacheUpdate.title = body.title;
  if (body.due_date !== undefined) cacheUpdate.due_date = body.due_date ? new Date(body.due_date).toISOString() : null;
  if (body.priority !== undefined) cacheUpdate.priority = body.priority === 'none' ? null : body.priority;
  await sb.from("clickup_task_cache").update(cacheUpdate).eq("clickup_task_id", body.clickup_task_id);
  return { success: true };
}

async function completeTask(body: any) {
  if (!body.clickup_task_id) throw new Error("clickup_task_id required");
  try {
    await clickupFetch(`/task/${body.clickup_task_id}`, {
      method: "PUT", body: JSON.stringify({ status: "complete" }),
    });
  } catch (e: any) {
    if (isDeletedErr(e)) { await pruneCacheRow(body.clickup_task_id); return { success: true, removed: true, note: "Task was already deleted in ClickUp; removed from your calendar." }; }
    throw e;
  }
  await sb.from("clickup_task_cache").update({
    status: "complete", fetched_at: new Date().toISOString(),
  }).eq("clickup_task_id", body.clickup_task_id);
  await sb.from("tasks").update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("clickup_task_id", body.clickup_task_id);
  return { success: true };
}

async function reopenTask(body: any) {
  if (!body.clickup_task_id) throw new Error("clickup_task_id required");
  try {
    await clickupFetch(`/task/${body.clickup_task_id}`, {
      method: "PUT", body: JSON.stringify({ status: "to do" }),
    });
  } catch (e: any) {
    if (isDeletedErr(e)) { await pruneCacheRow(body.clickup_task_id); return { success: true, removed: true, note: "Task no longer in ClickUp; removed from CRM." }; }
    throw e;
  }
  await sb.from("clickup_task_cache").update({
    status: "to do", fetched_at: new Date().toISOString(),
  }).eq("clickup_task_id", body.clickup_task_id);
  await sb.from("tasks").update({ status: "open", updated_at: new Date().toISOString() })
    .eq("clickup_task_id", body.clickup_task_id);
  return { success: true };
}

async function deleteTask(body: any) {
  if (!body.clickup_task_id) throw new Error("clickup_task_id required");
  try {
    await clickupFetch(`/task/${body.clickup_task_id}`, { method: "DELETE" });
  } catch (e: any) {
    if (!isDeletedErr(e)) throw e;
  }
  await sb.from("clickup_task_cache").delete().eq("clickup_task_id", body.clickup_task_id);
  await sb.from("tasks").delete().eq("clickup_task_id", body.clickup_task_id);
  return { success: true };
}

async function relinkTask(body: any) {
  if (!body.clickup_task_id) throw new Error("clickup_task_id required");
  await sb.from("clickup_task_cache").update({
    contact_id: body.contact_id || null,
  }).eq("clickup_task_id", body.clickup_task_id);
  await sb.from("tasks").update({ contact_id: body.contact_id || null })
    .eq("clickup_task_id", body.clickup_task_id);
  return { success: true, contact_id: body.contact_id || null };
}

async function autoLinkContacts() {
  const { data: unlinked } = await sb.from("clickup_task_cache").select("clickup_task_id, title").is("contact_id", null);
  if (!unlinked || unlinked.length === 0) return { linked: 0, scanned: 0 };
  const { data: contacts } = await sb.from("contacts").select("id, first_name, last_name");
  let linked = 0;
  for (const t of unlinked) {
    const cid = matchContactInTitle(t.title || "", contacts || []);
    if (cid) {
      await sb.from("clickup_task_cache").update({ contact_id: cid }).eq("clickup_task_id", t.clickup_task_id);
      linked++;
    }
  }
  return { linked, scanned: unlinked.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);
  const path = url.pathname.split("/").filter(Boolean);
  const action = path[1] || "";
  const sub = path[2] || "";

  try {
    if (req.method === "GET" && (action === "" || action === "tasks")) {
      return j(await listTasks(url));
    }
    if (req.method === "GET" && action === "contacts") {
      return j(await listContactsWithTasks());
    }
    if (req.method === "POST" && action === "resolve-contacts") {
      const body = await req.json();
      return j(await resolveContacts(body));
    }
    if (req.method === "POST" && action === "sync-pull") {
      return j(await syncPull());
    }
    if (req.method === "POST" && action === "task") {
      const body = await req.json();
      if (sub === "update") return j(await updateTask(body));
      if (sub === "complete") return j(await completeTask(body));
      if (sub === "reopen") return j(await reopenTask(body));
      if (sub === "delete") return j(await deleteTask(body));
      if (sub === "relink") return j(await relinkTask(body));
      if (sub === "comment") return j(await commentTask(body));
      if (sub === "attach") return j(await attachTask(body));
      return j(await createTask(body));
    }
    if (req.method === "POST" && action === "auto-link-contacts") {
      return j(await autoLinkContacts());
    }
    return j({
      name: "clickup-bridge", version: "v7",
      routes: [
        "GET /tasks?status=&contact_id=&q=&priority=&due=&include_contact=",
        "GET /contacts",
        "POST /resolve-contacts",
        "POST /sync-pull",
        "POST /task           (create; accepts assigned_to, assigned_by)",
        "POST /task/update",
        "POST /task/complete",
        "POST /task/reopen",
        "POST /task/delete",
        "POST /task/relink",
        "POST /task/comment   (clickup_task_id, comment_text)",
        "POST /auto-link-contacts",
      ],
    });
  } catch (e: any) {
    console.error("clickup-bridge error:", e);
    return j({ error: e.message }, 500);
  }
});

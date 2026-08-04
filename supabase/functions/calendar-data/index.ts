// calendar-data v5 — delete now also removes the linked Google Calendar event,
// and supports deleting plain Google events (type 'google'). v4 logic otherwise intact.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function j(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function getGoogleAccessToken(): Promise<string | null> {
  // Token row id is 'rene' (matches existing google-calendar-sync convention)
  const { data: row } = await sb.from("google_calendar_tokens")
    .select("access_token, refresh_token, expires_at")
    .eq("id", "rene")
    .maybeSingle();
  if (!row) return null;
  const expiresAt = new Date(row.expires_at).getTime();
  if (expiresAt > Date.now() + 60000) return row.access_token;
  try {
    const refreshRes = await fetch(`${SUPABASE_URL}/functions/v1/google-token-refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
    });
    if (!refreshRes.ok) return null;
    const fresh = await sb.from("google_calendar_tokens")
      .select("access_token").eq("id", "rene").maybeSingle();
    return fresh.data?.access_token || null;
  } catch (e) { return null; }
}

async function deleteGoogleEvent(eventId: string): Promise<boolean> {
  if (!eventId) return false;
  const token = await getGoogleAccessToken();
  if (!token) return false;
  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
    );
    // 204 deleted; 404/410 already gone — treat all as success
    return res.ok || res.status === 404 || res.status === 410;
  } catch (e) { return false; }
}

/* Google returns at most maxResults per call and hands back a nextPageToken when
 * there is more. Without the loop, a range holding more than 250 events silently
 * returned the first 250 and the caller could not tell — no error, no flag, just
 * a short calendar. The agenda view asks for 30 days and month asks for ~2, so
 * this bites first on a busy month and would bite immediately on a year view.
 *
 * The `warning` return is the other half. This used to `return []` on any failure
 * — an expired token, a 500, a network blip — which renders as "no events" and is
 * indistinguishable from an empty calendar. A calendar that is empty because the
 * fetch failed must not look like a calendar that is empty. */
const GOOGLE_PAGE_SIZE = 250;
const GOOGLE_MAX_PAGES = 20;   // 5,000 events; a real year is far below this
async function fetchGoogleEvents(start: string, end: string): Promise<{ events: any[]; warning: string | null }> {
  const token = await getGoogleAccessToken();
  if (!token) return { events: [], warning: "Google Calendar is not connected — no Google events are shown." };
  const out: any[] = [];
  let pageToken: string | undefined;
  try {
    for (let page = 0; page < GOOGLE_MAX_PAGES; page++) {
      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events`
        + `?timeMin=${encodeURIComponent(start)}&timeMax=${encodeURIComponent(end)}`
        + `&singleEvents=true&orderBy=startTime&maxResults=${GOOGLE_PAGE_SIZE}`
        + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return { events: out, warning: `Google Calendar returned ${res.status}; showing ${out.length} event(s) fetched before the failure.${detail ? " " + detail.slice(0, 120) : ""}` };
      }
      const body = await res.json();
      for (const ev of body.items || []) out.push(normalizeGoogleEvent(ev));
      pageToken = body.nextPageToken || undefined;
      if (!pageToken) return { events: out, warning: null };
    }
    // Ran out of pages rather than out of events — say so instead of truncating quietly.
    return { events: out, warning: `More than ${GOOGLE_PAGE_SIZE * GOOGLE_MAX_PAGES} Google events in this range; the list is truncated. Narrow the range.` };
  } catch (e) {
    return { events: out, warning: `Google Calendar fetch failed: ${(e as Error)?.message || String(e)}. Showing ${out.length} event(s).` };
  }
}

function normalizeGoogleEvent(ev: any) {
  const allDay = !!ev.start?.date;
  const start = ev.start?.dateTime || ev.start?.date;
  const end = ev.end?.dateTime || ev.end?.date;
  const ext = ev.extendedProperties?.private || {};
  const isCrmAppt = !!ext.crm_appointment_id;
  const isCrmTour = !!ext.crm_tour_id;
  const isCrmSourced = isCrmAppt || isCrmTour || (ev.description || "").includes("Created by Rates & Realty CRM");
  return {
    id: `google:${ev.id}`,
    source: isCrmSourced ? "google_synced" : "google",
    title: ev.summary || "(No title)",
    start, end, all_day: allDay,
    color: isCrmSourced ? "#C9A84C" : "#6ca5ff",
    location: ev.location || null,
    description: ev.description || null,
    contact_id: ext.contact_id || null,
    contact_name: null,
    link: ev.htmlLink || null,
    editable: !isCrmSourced,
    metadata: {
      google_event_id: ev.id,
      crm_appointment_id: ext.crm_appointment_id || null,
      crm_tour_id: ext.crm_tour_id || null,
      attendees: ev.attendees || []
    },
  };
}

/* Explicit caps. None of these had one, so the row count came from PostgREST's
 * default max-rows — a value set outside this repo that nobody here chose, and
 * which truncates without saying so. A year view multiplies every range by ~12,
 * so the cap becomes reachable rather than theoretical. Stated here so the number
 * is a decision. Current table sizes: appointments 10, tours 19, tasks 194,
 * clickup_task_cache 282. */
const DB_ROW_LIMIT = 2000;

async function fetchAppointments(start: string, end: string) {
  const { data } = await sb.from("appointments")
    .select("id, contact_id, title, type, scheduled_at, duration_minutes, status, notes, attendee_name, meeting_url, google_event_id")
    .gte("scheduled_at", start).lte("scheduled_at", end)
    .neq("status", "canceled").order("scheduled_at", { ascending: true }).limit(DB_ROW_LIMIT);
  if (!data) return [];
  const contactIds = [...new Set(data.map(a => a.contact_id).filter(Boolean))];
  const contactMap = new Map();
  if (contactIds.length > 0) {
    const { data: contacts } = await sb.from("contacts").select("id, first_name, last_name, phone, email").in("id", contactIds);
    (contacts || []).forEach(c => contactMap.set(c.id, c));
  }
  return data.map(a => {
    const contact = a.contact_id ? contactMap.get(a.contact_id) : null;
    const contactName = contact ? `${contact.first_name || ""} ${contact.last_name || ""}`.trim() : null;
    const startD = new Date(a.scheduled_at);
    const endD = new Date(startD.getTime() + (a.duration_minutes || 30) * 60000);
    const colors: Record<string, string> = { showing_tour: "#C9A84C", consultation: "#6ed47e", closing: "#a967d4", lender_call: "#ff8888", followup: "#6ca5ff" };
    return {
      id: `appt:${a.id}`, source: "appointment",
      title: a.title || (contactName ? `${a.type || "Appointment"} \u2014 ${contactName}` : a.type || "Appointment"),
      start: startD.toISOString(), end: endD.toISOString(), all_day: false,
      color: colors[a.type || ""] || "#C9A84C",
      location: a.meeting_url || null, description: a.notes || null,
      contact_id: a.contact_id, contact_name: contactName,
      contact_phone: contact?.phone || null, contact_email: contact?.email || null,
      link: a.contact_id ? `/admin/lead-detail.html?contact_id=${a.contact_id}` : null,
      editable: true,
      synced_to_google: !!a.google_event_id,
      metadata: { appointment_id: a.id, type: a.type, status: a.status, google_event_id: a.google_event_id },
    };
  });
}

async function fetchTours(start: string, end: string) {
  const { data } = await sb.from("showing_batches")
    .select("id, contact_id, title, scheduled_start, status, share_token, google_event_id, synced_to_google_at")
    .gte("scheduled_start", start).lte("scheduled_start", end)
    .not("scheduled_start", "is", null).neq("status", "canceled")
    .order("scheduled_start", { ascending: true }).limit(DB_ROW_LIMIT);
  if (!data) return [];
  const contactIds = [...new Set(data.map(b => b.contact_id).filter(Boolean))];
  const contactMap = new Map();
  const stopsCounts: Record<string, number> = {};
  if (contactIds.length > 0) {
    const { data: contacts } = await sb.from("contacts").select("id, first_name, last_name").in("id", contactIds);
    (contacts || []).forEach(c => contactMap.set(c.id, c));
  }
  const batchIds = data.map(b => b.id);
  if (batchIds.length > 0) {
    const { data: stops } = await sb.from("showings").select("batch_id").in("batch_id", batchIds).is("deleted_at", null);
    (stops || []).forEach(s => { stopsCounts[s.batch_id] = (stopsCounts[s.batch_id] || 0) + 1; });
  }
  return data.map(b => {
    const contact = b.contact_id ? contactMap.get(b.contact_id) : null;
    const contactName = contact ? `${contact.first_name || ""} ${contact.last_name || ""}`.trim() : "Lead";
    const stopCount = stopsCounts[b.id] || 0;
    const startD = new Date(b.scheduled_start);
    const endD = new Date(startD.getTime() + Math.max(stopCount, 1) * 45 * 60000);
    return {
      id: `tour:${b.id}`, source: "tour",
      title: `\ud83c\udfe0 Tour: ${contactName} (${stopCount} ${stopCount === 1 ? "stop" : "stops"})`,
      start: startD.toISOString(), end: endD.toISOString(), all_day: false, color: "#C9A84C",
      location: null, description: b.title || null,
      contact_id: b.contact_id, contact_name: contactName,
      link: `/admin/tour-builder.html?batch_id=${b.id}`,
      lead_facing_link: `https://beta.ratesandrealty.com/tour/${b.share_token}`,
      editable: false,
      synced_to_google: !!b.google_event_id,
      metadata: { batch_id: b.id, status: b.status, stop_count: stopCount, google_event_id: b.google_event_id },
    };
  });
}

async function fetchCrmTasks(start: string, end: string) {
  try {
    const { data, error } = await sb.from("tasks")
      .select("id, title, due_date, contact_id, status, priority, description")
      .gte("due_date", start).lte("due_date", end)
      .neq("status", "completed").order("due_date", { ascending: true }).limit(DB_ROW_LIMIT);
    if (error || !data) return [];
    const contactIds = [...new Set(data.map(t => t.contact_id).filter(Boolean))];
    const contactMap = new Map();
    if (contactIds.length > 0) {
      const { data: contacts } = await sb.from("contacts").select("id, first_name, last_name").in("id", contactIds);
      (contacts || []).forEach(c => contactMap.set(c.id, c));
    }
    return data.map(t => {
      const contact = t.contact_id ? contactMap.get(t.contact_id) : null;
      const contactName = contact ? `${contact.first_name || ""} ${contact.last_name || ""}`.trim() : null;
      const priorityColors: Record<string, string> = { urgent: "#ff8888", high: "#C9A84C", normal: "#888", low: "#666" };
      return {
        id: `task:${t.id}`, source: "task",
        title: `\u2713 ${t.title}${contactName ? " \u2014 " + contactName : ""}`,
        start: t.due_date, end: t.due_date, all_day: true,
        color: priorityColors[t.priority || "normal"] || "#888",
        location: null, description: t.description || null,
        contact_id: t.contact_id, contact_name: contactName,
        link: t.contact_id ? `/admin/lead-detail.html?contact_id=${t.contact_id}` : null,
        editable: true,
        metadata: { task_id: t.id, priority: t.priority, status: t.status },
      };
    });
  } catch (e) { return []; }
}

async function fetchClickupTasks(start: string, end: string) {
  try {
    const { data, error } = await sb.from("clickup_task_cache")
      .select("clickup_task_id, contact_id, title, status, priority, due_date, url, assignee_username")
      .gte("due_date", start).lte("due_date", end)
      .not("due_date", "is", null)
      .not("status", "in", "(complete,closed,done)")
      .order("due_date", { ascending: true }).limit(DB_ROW_LIMIT);
    if (error || !data) return [];
    const contactIds = [...new Set(data.map(t => t.contact_id).filter(Boolean))];
    const contactMap = new Map();
    if (contactIds.length > 0) {
      const { data: contacts } = await sb.from("contacts").select("id, first_name, last_name, phone, email").in("id", contactIds);
      (contacts || []).forEach(c => contactMap.set(c.id, c));
    }
    return data.map(t => {
      const contact = t.contact_id ? contactMap.get(t.contact_id) : null;
      const contactName = contact ? `${contact.first_name || ""} ${contact.last_name || ""}`.trim() : null;
      const priorityColors: Record<string, string> = { urgent: "#ff8888", high: "#ff9933", normal: "#a78bfa", low: "#666" };
      return {
        id: `clickup:${t.clickup_task_id}`,
        source: "clickup",
        title: `\ud83d\udccb ${t.title}${contactName ? " \u2014 " + contactName : ""}`,
        start: t.due_date, end: t.due_date, all_day: true,
        color: priorityColors[t.priority || "normal"] || "#a78bfa",
        location: null, description: null,
        contact_id: t.contact_id, contact_name: contactName,
        contact_phone: contact?.phone || null, contact_email: contact?.email || null,
        link: t.contact_id ? `/admin/lead-detail.html?contact_id=${t.contact_id}` : null,
        external_link: t.url,
        editable: false,
        metadata: { clickup_task_id: t.clickup_task_id, status: t.status, priority: t.priority, assignee: t.assignee_username },
      };
    });
  } catch (e) { return []; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "";
  try {
    if (req.method === "GET") {
      const start = url.searchParams.get("start") || new Date(Date.now() - 7 * 86400000).toISOString();
      const end = url.searchParams.get("end") || new Date(Date.now() + 60 * 86400000).toISOString();
      const sourcesParam = url.searchParams.get("sources") || "google,appts,tours,tasks,clickup";
      const sources = new Set(sourcesParam.split(","));

      const promises: Promise<any>[] = [];   // heterogeneous: google returns {events,warning}, the rest return arrays
      promises.push(sources.has("google") ? fetchGoogleEvents(start, end) : Promise.resolve({ events: [], warning: null }));
      promises.push(sources.has("appts") ? fetchAppointments(start, end) : Promise.resolve([]));
      promises.push(sources.has("tours") ? fetchTours(start, end) : Promise.resolve([]));
      promises.push(sources.has("tasks") ? fetchCrmTasks(start, end) : Promise.resolve([]));
      promises.push(sources.has("clickup") ? fetchClickupTasks(start, end) : Promise.resolve([]));

      const [googleResult, appointments, tours, tasks, clickupTasks] = await Promise.all(promises);
      const googleEvents = googleResult.events || [];
      const googleWarning = googleResult.warning || null;

      // Dedupe: collapse Google events whose extendedProperties point at a CRM appointment OR tour we're also returning
      const crmApptGoogleIds = new Set(appointments.map((a: any) => a.metadata?.google_event_id).filter(Boolean));
      const crmTourGoogleIds = new Set(tours.map((t: any) => t.metadata?.google_event_id).filter(Boolean));
      const filteredGoogle = googleEvents.filter((g: any) => {
        const gid = g.metadata?.google_event_id;
        return !crmApptGoogleIds.has(gid) && !crmTourGoogleIds.has(gid);
      });

      const allEvents = [...filteredGoogle, ...appointments, ...tours, ...tasks, ...clickupTasks].sort(
        (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
      );
      const counts = {
        google: filteredGoogle.length,
        appointment: appointments.length,
        tour: tours.length,
        task: tasks.length,
        clickup: clickupTasks.length,
        total: allEvents.length,
      };
      return j({
        events: allEvents, counts, range: { start, end },
        /* Present ONLY when something went wrong or was truncated. A caller that
         * ignores it is no worse off than before; a caller that shows it can tell
         * "no events" from "we could not read them". */
        ...(googleWarning ? { warnings: { google: googleWarning } } : {}),
        generated_at: new Date().toISOString(),
      });
    }

    if (req.method === "POST" && (last === "event" || last === "calendar-data")) {
      const body = await req.json();
      if (!body.title || !body.start) return j({ error: "title and start required" }, 400);
      const startD = new Date(body.start);
      const endD = body.end ? new Date(body.end) : new Date(startD.getTime() + 60 * 60000);
      const durationMin = Math.round((endD.getTime() - startD.getTime()) / 60000);
      const { data, error } = await sb.from("appointments").insert({
        title: body.title, type: body.type || "event",
        scheduled_at: startD.toISOString(), appointment_time: startD.toISOString(),
        duration_minutes: durationMin, contact_id: body.contact_id || null,
        notes: body.description || null, meeting_url: body.location || null,
        attendee_name: body.attendee_name || null, attendee_email: body.attendee_email || null,
        attendee_phone: body.attendee_phone || null, status: "confirmed",
      }).select("id").single();
      if (error || !data) return j({ error: error?.message || "create failed" }, 500);
      fetch(`${SUPABASE_URL}/functions/v1/google-calendar-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({ appointment_id: data.id }),
      }).catch(() => {});
      return j({ success: true, appointment_id: data.id });
    }

    if (req.method === "DELETE" && segments.includes("event")) {
      const id = segments[segments.length - 1];
      const sep = id.indexOf(":");
      const type = sep >= 0 ? id.slice(0, sep) : id;
      const realId = sep >= 0 ? id.slice(sep + 1) : "";
      if (type === "appt") {
        const { data: appt } = await sb.from("appointments").select("google_event_id").eq("id", realId).maybeSingle();
        await sb.from("appointments").update({ status: "canceled", cancelled_at: new Date().toISOString() }).eq("id", realId);
        if (appt?.google_event_id) { await deleteGoogleEvent(appt.google_event_id).catch(() => {}); }
        return j({ success: true, google_removed: !!appt?.google_event_id });
      }
      if (type === "google") {
        const ok = await deleteGoogleEvent(realId);
        return ok ? j({ success: true }) : j({ error: "google delete failed (token or event missing)" }, 502);
      }
      return j({ error: "unsupported delete type: " + type }, 400);
    }

    return j({ name: "calendar-data", version: "v5", sources: ["google", "appts", "tours", "tasks", "clickup"] });
  } catch (e: any) {
    return j({ error: e.message || "unknown" }, 500);
  }
});

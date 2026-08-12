// tours-admin v5 — send_to_lead now also auto-syncs the tour to Google Calendar
//
// CHANGELOG:
//   v5: send_to_lead also pushes the tour to Google Calendar so it appears on Rene's phone.
//       update_tour reschedule pushes update to Google. cancel deletes Google event.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireStaff } from "../_shared/require-staff.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

async function safeWrite<T>(promise: PromiseLike<T>): Promise<void> {
  try { await promise; } catch { /* swallow */ }
}

async function getPublicTourBase(): Promise<string> {
  const { data } = await sb.from("app_config").select("value").eq("key", "tour_public_base_url").maybeSingle();
  if (typeof data?.value === "string" && data.value.length > 0) return data.value.replace(/[\"'`]/g, "").replace(/\/$/, "");
  return "https://beta.ratesandrealty.com/tour";
}

function toIsoOrNull(v: any): string | null {
  if (!v) return null;
  try { const d = new Date(v); if (isNaN(d.getTime())) return null; return d.toISOString(); } catch { return null; }
}

/* ── When a tour link should stop working ───────────────────────────────────
 *
 * SCHEDULED_END + 7 DAYS, not a fixed window from creation. A tour is a dated
 * event, unlike a fee sheet (90 days, has to survive to closing) or a CMA
 * (30 days, comps go stale) — so a fixed N-days is the wrong shape here.
 *
 * The 7-day tail is load-bearing rather than padding: reminder_post_tour_enabled
 * fires AFTER the showing and asks for feedback, and the feedback action goes
 * through the same token. Expiring at the tour itself would silently kill the
 * link the reminder points at.
 *
 * A tour with no date yet gets 30 days from now — a draft that is never
 * scheduled should not mint a permanent link.
 */
function tourExpiry(batch: any): string {
  const end = batch?.scheduled_end || batch?.scheduled_start;
  const base = end ? new Date(end).getTime() : NaN;
  if (!isNaN(base)) return new Date(base + 7 * 864e5).toISOString();
  return new Date(Date.now() + 30 * 864e5).toISOString();
}

async function mintShortLink(destinationUrl: string, contactId: string | null, batchId: string): Promise<{ id: string; pretty_url: string } | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/track-event/create_link`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ destination_url: destinationUrl, contact_id: contactId, source: "showing_tour", source_id: batchId, label: "showing_tour" }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return { id: data.tracking_id, pretty_url: data.pretty_url || data.short_url };
  } catch { return null; }
}

async function fireScorer(contactId: string, trigger: string) {
  if (!contactId) return;
  fetch(`${SUPABASE_URL}/functions/v1/lead-scorer`, {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ action: "score_contact", contact_id: contactId, trigger }),
  }).catch(() => {});
}

// NEW v5: fire-and-forget Google Calendar sync for a tour
function fireGoogleSyncTour(tourId: string) {
  fetch(`${SUPABASE_URL}/functions/v1/google-calendar-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ tour_id: tourId }),
  }).catch((e) => console.error("[tours-admin] google sync fire failed:", e));
}

function formatDateForSMS(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric" });
}
function formatTimeForSMS(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", hour12: true });
}

function ptDateAt(baseDate: Date, hourPT: number): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = fmt.formatToParts(baseDate);
  const ymd: Record<string, string> = {};
  for (const p of parts) ymd[p.type] = p.value;
  const ptStr = `${ymd.year}-${ymd.month}-${ymd.day}T${String(hourPT).padStart(2, "0")}:00:00`;
  const sample = new Date(ptStr + "Z");
  const offsetFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false });
  const sampleHour = parseInt(offsetFmt.format(sample));
  const offsetHours = hourPT - sampleHour;
  return new Date(sample.getTime() + offsetHours * 3600000);
}

async function queueRemindersForBatch(batch: any) {
  if (!batch.scheduled_start) return [];
  const start = new Date(batch.scheduled_start);
  const messages: any[] = [];
  const channels = batch.reminder_channels || ["sms", "email"];
  if (batch.reminder_day_before_enabled) {
    const at = ptDateAt(new Date(start.getTime() - 86400000), 17);
    if (at.getTime() > Date.now()) for (const channel of channels) messages.push({ trigger: "reminder_day_before", channel, scheduled_for: at.toISOString() });
  }
  if (batch.reminder_morning_of_enabled) {
    const at = ptDateAt(start, 8);
    if (at.getTime() > Date.now() && at < start) for (const channel of channels) messages.push({ trigger: "reminder_morning_of", channel, scheduled_for: at.toISOString() });
  }
  if (batch.reminder_post_tour_enabled) {
    const at = ptDateAt(new Date(start.getTime() + 86400000), 9);
    for (const channel of channels) if (channel === "sms") messages.push({ trigger: "post_tour_followup", channel, scheduled_for: at.toISOString() });
  }
  return messages;
}

async function insertReminderRows(batch: any, contact: any, messages: any[]) {
  if (!messages.length) return;
  const rows = messages.map(m => ({
    batch_id: batch.id, contact_id: batch.contact_id,
    channel: m.channel, trigger: m.trigger,
    recipient_phone: m.channel === "sms" ? contact?.phone : null,
    recipient_email: m.channel === "email" ? contact?.email : null,
    scheduled_for: m.scheduled_for, status: "queued",
  }));
  await sb.from("showing_messages").insert(rows);
}

async function buildItineraryEmailHtml(batch: any, contact: any, publicUrl: string): Promise<string> {
  const { data: stops } = await sb.from("showings").select("*").eq("batch_id", batch.id).is("deleted_at", null).order("sort_order", { ascending: true });
  const dateStr = batch.scheduled_start ? formatDateForSMS(batch.scheduled_start) : "TBD";
  const timeStr = batch.scheduled_start ? formatTimeForSMS(batch.scheduled_start) : "";
  const stopsHtml = (stops || []).map((s: any, i: number) => {
    const photo = s.property_photo ? `<img src="${s.property_photo}" alt="Stop ${i + 1}" width="180" style="display:block;border-radius:8px;"/>` : `<div style="width:180px;height:120px;background:#222;border-radius:8px;"></div>`;
    const arrival = s.arrival_time ? formatTimeForSMS(s.arrival_time) : (s.exact_time || "");
    return `<tr><td style="padding:14px 0;border-bottom:1px solid #2a2a2a;"><table cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" style="padding-right:14px;">${photo}</td><td valign="top" style="color:#e8e8e8;"><div style="font-size:13px;color:#C9A84C;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Stop ${i + 1}${arrival ? " \u00b7 " + arrival : ""}</div><div style="font-size:18px;font-weight:600;margin:4px 0;">${s.property_address || ""}</div><div style="font-size:14px;color:#999;">${[s.property_city, s.state, s.zip].filter(Boolean).join(", ")}</div>${s.property_price ? `<div style="font-size:16px;color:#C9A84C;margin-top:6px;">$${Number(s.property_price).toLocaleString()}</div>` : ""}<div style="font-size:13px;color:#bbb;margin-top:4px;">${[s.property_beds ? s.property_beds + " bd" : "", s.property_baths ? s.property_baths + " ba" : "", s.property_sqft ? Number(s.property_sqft).toLocaleString() + " sqft" : ""].filter(Boolean).join(" \u00b7 ")}</div>${s.agent_notes_for_lead ? `<div style="font-size:13px;color:#aaa;margin-top:8px;font-style:italic;">\u201c${s.agent_notes_for_lead}\u201d \u2014 Rene</div>` : ""}</td></tr></table></td></tr>`;
  }).join("");
  return `<!DOCTYPE html><html><body style="margin:0;background:#0a0a0a;font-family:-apple-system,sans-serif;color:#e8e8e8;"><table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0a0a;padding:24px 0;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#141414;border:1px solid #2a2a2a;border-radius:12px;"><tr><td style="padding:28px 28px 16px;"><div style="font-size:13px;color:#C9A84C;text-transform:uppercase;letter-spacing:2px;font-weight:600;">Rates &amp; Realty Home Tour</div><h1 style="font-size:26px;color:#fff;margin:8px 0 4px;">Hi ${contact.first_name || "there"},</h1><div style="font-size:16px;color:#bbb;">Here's your tour for <strong style="color:#fff;">${dateStr}${timeStr ? " at " + timeStr : ""}</strong>.</div><a href="${publicUrl}" style="display:inline-block;margin-top:16px;padding:12px 22px;background:#C9A84C;color:#0a0a0a;text-decoration:none;border-radius:6px;font-weight:600;">View &amp; confirm tour \u2192</a></td></tr>${batch.notes_for_lead ? `<tr><td style="padding:0 28px 8px;"><div style="background:#1a1a1a;border-left:3px solid #C9A84C;padding:12px 16px;border-radius:4px;font-size:14px;color:#ddd;">${batch.notes_for_lead}</div></td></tr>` : ""}<tr><td style="padding:8px 28px;"><table cellpadding="0" cellspacing="0" border="0" width="100%">${stopsHtml}</table></td></tr><tr><td style="padding:18px 28px 28px;"><a href="${publicUrl}" style="display:inline-block;padding:10px 18px;background:transparent;color:#C9A84C;text-decoration:none;border:1px solid #C9A84C;border-radius:6px;font-weight:500;">Open full itinerary</a><div style="font-size:13px;color:#888;margin-top:18px;">Questions? Just reply to this email or text me at <strong>(714) 472-8508</strong>.<br/>\u2014 Rene Duarte, Rates &amp; Realty (NMLS #1795044)</div></td></tr></table></td></tr></table></body></html>`;
}

async function sendInitialShare(batch: any, contact: any, channels: string[]) {
  const tourBase = await getPublicTourBase();
  const tourPublicUrl = `${tourBase}/${batch.share_token}`;
  const short = await mintShortLink(tourPublicUrl, contact.id, batch.id);
  const linkForSms = short?.pretty_url || tourPublicUrl;
  const shortLinkId = short?.id || null;
  if (shortLinkId) await sb.from("showing_batches").update({ short_link_id: shortLinkId }).eq("id", batch.id);
  const dateStr = batch.scheduled_start ? formatDateForSMS(batch.scheduled_start) : "TBD";
  const timeStr = batch.scheduled_start ? formatTimeForSMS(batch.scheduled_start) : "";
  const { count: stopCount } = await sb.from("showings").select("id", { count: "exact", head: true }).eq("batch_id", batch.id).is("deleted_at", null);
  const stopsStr = `${stopCount || 0} ${stopCount === 1 ? "home" : "homes"}`;
  const results: any[] = [];
  if (channels.includes("sms") && contact.phone) {
    const smsBody = `Hi ${contact.first_name || "there"} \u2014 here's your home tour itinerary for ${dateStr} ${timeStr ? "at " + timeStr : ""}:\n\n${linkForSms}\n\n${stopsStr} lined up. Tap to view, confirm, or message me with questions.\n\n\u2014 Rene\nReply STOP to opt out`;
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/sms-service`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` }, body: JSON.stringify({ trigger: "custom", quiet_hours_bypass: "user_initiated", to_phone: contact.phone, params: { message: smsBody }, contact_id: contact.id, trigger_id: batch.id }) });
      const d = await res.json();
      const okFlag = res.ok && (d.sid || d.success);
      await sb.from("showing_messages").insert({ batch_id: batch.id, contact_id: contact.id, channel: "sms", trigger: "initial_share", recipient_phone: contact.phone, body_text: smsBody, status: okFlag ? "sent" : "failed", scheduled_for: new Date().toISOString(), sent_at: okFlag ? new Date().toISOString() : null, sms_log_id: d.sms_log_id || null, failure_reason: okFlag ? null : (d.error || "unknown") });
      results.push({ channel: "sms", ok: okFlag, error: okFlag ? null : d.error });
    } catch (e: any) { results.push({ channel: "sms", ok: false, error: e.message }); }
  }
  if (channels.includes("email") && contact.email) {
    const emailHtml = await buildItineraryEmailHtml(batch, contact, tourPublicUrl);
    const subject = `Your home tour for ${dateStr}${timeStr ? " at " + timeStr : ""} \u2014 ${stopsStr}`;
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/email-service`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` }, body: JSON.stringify({ action: "send", to_email: contact.email, to_name: `${contact.first_name || ""} ${contact.last_name || ""}`.trim(), first_name: contact.first_name, last_name: contact.last_name, contact_id: contact.id, subject, html: emailHtml }) });
      const d = await res.json();
      const okFlag = res.ok && d.success;
      await sb.from("showing_messages").insert({ batch_id: batch.id, contact_id: contact.id, channel: "email", trigger: "initial_share", recipient_email: contact.email, subject, body_text: emailHtml.substring(0, 2000), status: okFlag ? "sent" : "failed", scheduled_for: new Date().toISOString(), sent_at: okFlag ? new Date().toISOString() : null, email_log_id: d.email_log_id || null, failure_reason: okFlag ? null : (d.error || "unknown") });
      results.push({ channel: "email", ok: okFlag, error: okFlag ? null : d.error });
    } catch (e: any) { results.push({ channel: "email", ok: false, error: e.message }); }
  }
  return { results, share_token: batch.share_token, short_url: linkForSms, public_url: tourPublicUrl };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

  /* ── GUARD ────────────────────────────────────────────────────────────────
   *
   * Widest blast radius of the remaining senders, because it is the only one
   * where the CALLER picks the recipient. `send_to_lead` and `cancel` text
   * contact.phone for whatever contact_id the body names, using the service key,
   * passing quiet_hours_bypass:"user_initiated" — so an anonymous caller could
   * text any borrower in the CRM, at any hour, straight past the quiet-hours
   * guard. Everything else here (create_tour, add_stop, …) writes borrower rows.
   *
   * NO allowInternal: every caller is a browser. All three were sending the ANON
   * KEY, which is printed in the page and identifies nobody; they now send the
   * signed-in user's session token and shipped FIRST, so a token mistake showed
   * as a page that still worked rather than an outage.
   *
   * tour-builder.js is also loaded by two PUBLIC pages, but never mounted there
   * — detectAdmin() only adds a CSS class and the UI is tb-admin-only, so every
   * path that reaches this function belongs to a signed-in admin. Checked before
   * writing this, because guarding it otherwise would have broken the public
   * site.
   *
   * BEFORE req.json(). */
  const _auth = await requireStaff(req, { what: "Tours" });
  if (!_auth.ok) return err(_auth.msg || "not authorized", _auth.status || 401);

  try {
    const body = await req.json();
    const action = (body.action || "").toLowerCase();

    if (action === "create_tour") {
      if (!body.contact_id) return err("contact_id required");
      const { data: batch, error } = await sb.from("showing_batches").insert({
        contact_id: body.contact_id, agent_id: body.agent_id || "rene", title: body.title || null,
        scheduled_start: toIsoOrNull(body.scheduled_start), scheduled_end: toIsoOrNull(body.scheduled_end),
        notes_internal: body.notes_internal || null, notes_for_lead: body.notes_for_lead || null,
        reminder_day_before_enabled: body.reminder_day_before_enabled ?? true,
        reminder_morning_of_enabled: body.reminder_morning_of_enabled ?? true,
        reminder_post_tour_enabled: body.reminder_post_tour_enabled ?? true,
        reminder_channels: body.reminder_channels || ["sms", "email"], status: "draft",
      }).select("*").single();
      if (error) return err(error.message, 500);
      const { data: contact } = await sb.from("contacts").select("first_name, last_name, email, phone").eq("id", body.contact_id).maybeSingle();
      if (Array.isArray(body.stops) && body.stops.length > 0) {
        const rows = body.stops.map((s: any, i: number) => ({
          batch_id: batch.id, contact_id: body.contact_id,
          name: `${contact?.first_name || ""} ${contact?.last_name || ""}`.trim() || "Lead",
          email: contact?.email, phone: contact?.phone, sort_order: s.sort_order ?? (i + 1),
          mls_number: s.mls_number || null, listing_key: s.listing_key || null,
          property_address: s.address || "(new stop)", property_city: s.city || null,
          state: s.state || "CA", zip: s.zip || null, latitude: s.latitude || null, longitude: s.longitude || null,
          listing_url: s.listing_url || null, property_photo: s.photo_url || s.property_photo || null,
          property_price: s.price || null, property_beds: s.beds || null, property_baths: s.baths || null,
          property_sqft: s.sqft || null, property_type: s.property_type || null, year_built: s.year_built || null,
          listing_agent_name: s.listing_agent_name || null, listing_agent_phone: s.listing_agent_phone || null,
          listing_agent_email: s.listing_agent_email || null, listing_agent_office: s.listing_agent_office || null,
          arrival_time: toIsoOrNull(s.arrival_time), duration_minutes: s.duration_minutes || 30,
          agent_notes_for_lead: s.agent_notes_for_lead || s.agent_notes || null,
          agent_internal_notes: s.agent_internal_notes || null, status: "new",
          preferred_date: batch.scheduled_start ? new Date(batch.scheduled_start).toISOString().split("T")[0] : null, preferred_time: "Custom",
        }));
        await sb.from("showings").insert(rows);
      }
      await safeWrite(sb.from("activity_events").insert({ contact_id: body.contact_id, type: "system", channel: "system", direction: "internal", title: `\ud83d\uddd3\ufe0f Tour drafted: ${batch.title || batch.share_token}`, description: `${body.stops?.length || 0} stops, status: draft`, metadata: { batch_id: batch.id, share_token: batch.share_token }, created_at: new Date().toISOString() }));
      const { data: batchFull } = await sb.from("showing_batches").select("*").eq("id", batch.id).single();
      return ok({ success: true, tour: batchFull });
    }

    if (action === "update_tour") {
      if (!body.batch_id) return err("batch_id required");
      const updates: any = {};
      const fields = ["title", "scheduled_start", "scheduled_end", "notes_internal", "notes_for_lead", "reminder_day_before_enabled", "reminder_morning_of_enabled", "reminder_post_tour_enabled", "reminder_channels", "status"];
      for (const f of fields) if (body[f] !== undefined) updates[f] = body[f];
      if (updates.scheduled_start) updates.scheduled_start = toIsoOrNull(updates.scheduled_start);
      if (updates.scheduled_end) updates.scheduled_end = toIsoOrNull(updates.scheduled_end);
      const { data, error } = await sb.from("showing_batches").update(updates).eq("id", body.batch_id).select("*").single();
      if (error) return err(error.message, 500);
      // v5: if reschedule + already synced, push update to Google
      if (updates.scheduled_start && data.google_event_id) fireGoogleSyncTour(body.batch_id);
      return ok({ success: true, tour: data });
    }

    if (action === "add_stop") {
      if (!body.batch_id) return err("batch_id required");
      const stopAddress = (typeof body.address === "string" && body.address.trim().length > 0) ? body.address.trim() : "(new stop)";
      const { data: batch } = await sb.from("showing_batches").select("contact_id").eq("id", body.batch_id).maybeSingle();
      if (!batch) return err("batch not found", 404);
      const { data: contact } = batch?.contact_id ? await sb.from("contacts").select("first_name, last_name, email, phone").eq("id", batch.contact_id).maybeSingle() : { data: null };
      const { count } = await sb.from("showings").select("id", { count: "exact", head: true }).eq("batch_id", body.batch_id).is("deleted_at", null);
      const { data, error } = await sb.from("showings").insert({
        batch_id: body.batch_id, contact_id: batch?.contact_id || null,
        name: contact ? `${contact.first_name || ""} ${contact.last_name || ""}`.trim() : "Lead",
        email: contact?.email, phone: contact?.phone, sort_order: body.sort_order ?? ((count || 0) + 1),
        mls_number: body.mls_number || null, listing_key: body.listing_key || null,
        property_address: stopAddress, property_city: body.city || null, state: body.state || "CA", zip: body.zip || null,
        latitude: body.latitude || null, longitude: body.longitude || null,
        listing_url: body.listing_url || null, property_photo: body.photo_url || body.property_photo || null,
        property_price: body.price || null, property_beds: body.beds || null, property_baths: body.baths || null,
        property_sqft: body.sqft || null, property_type: body.property_type || null, year_built: body.year_built || null,
        listing_agent_name: body.listing_agent_name || null, listing_agent_phone: body.listing_agent_phone || null,
        listing_agent_email: body.listing_agent_email || null, listing_agent_office: body.listing_agent_office || null,
        arrival_time: toIsoOrNull(body.arrival_time), duration_minutes: body.duration_minutes || 30,
        agent_notes_for_lead: body.agent_notes_for_lead || body.agent_notes || null,
        agent_internal_notes: body.agent_internal_notes || null, status: "new", preferred_time: "Custom",
      }).select("*").single();
      if (error) return err(error.message, 500);
      return ok({ success: true, stop: data });
    }

    if (action === "update_stop") {
      if (!body.showing_id) return err("showing_id required");
      const updates: any = {};
      const fields = ["sort_order", "mls_number", "property_address", "property_city", "state", "zip", "latitude", "longitude", "listing_url", "property_photo", "property_price", "property_beds", "property_baths", "property_sqft", "property_type", "year_built", "listing_agent_name", "listing_agent_phone", "listing_agent_email", "listing_agent_office", "arrival_time", "duration_minutes", "agent_notes_for_lead", "agent_internal_notes", "lead_feedback", "lead_rating", "status"];
      for (const f of fields) if (body[f] !== undefined) updates[f] = body[f];
      if (updates.arrival_time) updates.arrival_time = toIsoOrNull(updates.arrival_time);
      updates.updated_at = new Date().toISOString();
      const { data, error } = await sb.from("showings").update(updates).eq("id", body.showing_id).select("*").single();
      if (error) return err(error.message, 500);
      return ok({ success: true, stop: data });
    }

    if (action === "reorder_stops") {
      if (!body.batch_id || !Array.isArray(body.showing_ids)) return err("batch_id and showing_ids[] required");
      for (let i = 0; i < body.showing_ids.length; i++) await sb.from("showings").update({ sort_order: i + 1 }).eq("id", body.showing_ids[i]).eq("batch_id", body.batch_id);
      return ok({ success: true, reordered: body.showing_ids.length });
    }

    if (action === "remove_stop") {
      if (!body.showing_id) return err("showing_id required");
      const { error } = await sb.from("showings").update({ deleted_at: new Date().toISOString() }).eq("id", body.showing_id);
      if (error) return err(error.message, 500);
      return ok({ success: true });
    }

    if (action === "schedule") {
      if (!body.batch_id || !body.scheduled_start) return err("batch_id and scheduled_start required");
      const start = toIsoOrNull(body.scheduled_start)!;
      let end = toIsoOrNull(body.scheduled_end);
      if (!end) {
        const { data: stops } = await sb.from("showings").select("duration_minutes").eq("batch_id", body.batch_id).is("deleted_at", null);
        const totalMins = (stops || []).reduce((acc: number, s: any) => acc + (s.duration_minutes || 30) + 15, 0);
        end = new Date(new Date(start).getTime() + totalMins * 60000).toISOString();
      }
      /* Rescheduling moves the expiry with the tour — but only for a link that
         already has one. A NULL stays NULL so a pre-2026-08-12 tour is not
         retroactively given an expiry by being rescheduled. */
      const { data: prior } = await sb.from("showing_batches").select("expires_at").eq("id", body.batch_id).maybeSingle();
      const patch: any = { scheduled_start: start, scheduled_end: end, status: "scheduled" };
      if (prior?.expires_at) patch.expires_at = tourExpiry({ scheduled_end: end, scheduled_start: start });
      const { data, error } = await sb.from("showing_batches").update(patch).eq("id", body.batch_id).select("*").single();
      if (error) return err(error.message, 500);
      return ok({ success: true, tour: data });
    }

    if (action === "send_to_lead") {
      if (!body.batch_id) return err("batch_id required");
      const channels = body.channels || ["sms", "email"];
      const { data: batch } = await sb.from("showing_batches").select("*").eq("id", body.batch_id).single();
      if (!batch) return err("tour not found", 404);
      const { data: contact } = await sb.from("contacts").select("*").eq("id", batch.contact_id).single();
      if (!contact) return err("contact not found", 404);
      const sendResult = await sendInitialShare(batch, contact, channels);
      /* Stamp expiry when the link actually starts circulating. Existing rows
         keep expires_at NULL and go on working — no backfill. */
      await sb.from("showing_batches").update({
        status: "sent", sent_at: new Date().toISOString(), expires_at: tourExpiry(batch),
      }).eq("id", body.batch_id);
      const { data: batchUpdated } = await sb.from("showing_batches").select("*").eq("id", body.batch_id).single();
      const reminders = await queueRemindersForBatch(batchUpdated);
      await insertReminderRows(batchUpdated, contact, reminders);
      // v5: push tour to Google Calendar (fire and forget)
      if (batchUpdated.scheduled_start) fireGoogleSyncTour(body.batch_id);
      await safeWrite(sb.from("activity_events").insert({ contact_id: batch.contact_id, type: "system", channel: "system", direction: "outbound", title: `\ud83d\udce8 Tour sent: ${batch.title || "Showing tour"}`, description: `Sent via ${channels.join(", ")}, ${reminders.length} reminders queued, synced to Google`, metadata: { batch_id: batch.id, channels, reminders_scheduled: reminders.length }, created_at: new Date().toISOString() }));
      fireScorer(batch.contact_id, "tour_sent");
      return ok({ success: true, ...sendResult, reminders_queued: reminders.length });
    }

    if (action === "cancel") {
      if (!body.batch_id) return err("batch_id required");
      const { data: batch } = await sb.from("showing_batches").select("*").eq("id", body.batch_id).single();
      if (!batch) return err("tour not found", 404);
      await sb.from("showing_messages").update({ status: "canceled" }).eq("batch_id", body.batch_id).eq("status", "queued");
      if (batch.status === "sent" || batch.status === "confirmed") {
        const { data: contact } = await sb.from("contacts").select("*").eq("id", batch.contact_id).single();
        if (contact?.phone) {
          const dateStr = batch.scheduled_start ? formatDateForSMS(batch.scheduled_start) : "";
          const cancelBody = `Hi ${contact.first_name || ""} \u2014 unfortunately I need to cancel our tour ${dateStr ? "on " + dateStr : ""}.${body.reason ? " Reason: " + body.reason : ""} Let's reschedule \u2014 reply with a few times that work. \u2014 Rene\nReply STOP to opt out`;
          fetch(`${SUPABASE_URL}/functions/v1/sms-service`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` }, body: JSON.stringify({ trigger: "custom", quiet_hours_bypass: "user_initiated", to_phone: contact.phone, params: { message: cancelBody }, contact_id: contact.id, trigger_id: batch.id }) }).catch(() => {});
          await sb.from("showing_messages").insert({ batch_id: batch.id, contact_id: contact.id, channel: "sms", trigger: "cancel_notice", recipient_phone: contact.phone, body_text: cancelBody, status: "sent", scheduled_for: new Date().toISOString(), sent_at: new Date().toISOString() });
        }
      }
      await sb.from("showing_batches").update({ status: "canceled", canceled_at: new Date().toISOString(), cancel_reason: body.reason || null }).eq("id", body.batch_id);
      // v5: delete Google Calendar event if synced
      if (batch.google_event_id) {
        sb.from("google_calendar_tokens").select("access_token").eq("id", "rene").maybeSingle().then(({ data: tokRow }) => {
          if (tokRow?.access_token) {
            fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${batch.google_event_id}`, { method: "DELETE", headers: { Authorization: `Bearer ${tokRow.access_token}` } }).catch(() => {});
          }
        });
      }
      await safeWrite(sb.from("activity_events").insert({ contact_id: batch.contact_id, type: "system", channel: "system", direction: "internal", title: `\u274c Tour canceled${body.reason ? ": " + body.reason : ""}`, metadata: { batch_id: batch.id }, created_at: new Date().toISOString() }));
      return ok({ success: true });
    }

    if (action === "mark_complete") {
      if (!body.batch_id) return err("batch_id required");
      const { data: batch } = await sb.from("showing_batches").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", body.batch_id).select("*").single();
      fireScorer(batch.contact_id, "tour_completed");
      await safeWrite(sb.from("activity_events").insert({ contact_id: batch.contact_id, type: "system", channel: "system", direction: "internal", title: `\u2705 Tour completed: ${batch.title || batch.share_token}`, metadata: { batch_id: batch.id }, created_at: new Date().toISOString() }));
      return ok({ success: true, tour: batch });
    }

    /* THE VOID ACTION. Mirrors revoke_cma_snapshot / revoke_fee_sheet_snapshot:
       reversible, and the public side refuses BEFORE it counts a view or fires
       the scorer. Kept separate from `cancel` on purpose — canceling a tour is a
       fact about the showing that the lead should still be able to read;
       revoking is withdrawing the link itself. */
    if (action === "revoke_link") {
      if (!body.batch_id) return err("batch_id required");
      const revoke = body.revoke !== false;
      const { data, error } = await sb.from("showing_batches").update({
        revoked_at: revoke ? new Date().toISOString() : null,
        revoked_by: revoke ? (_auth.userId || null) : null,
      }).eq("id", body.batch_id).select("id, share_token, revoked_at, expires_at").single();
      if (error) return err(error.message, 500);
      return ok({ success: true, batch_id: data.id, share_token: data.share_token, revoked: !!data.revoked_at });
    }

    if (action === "list_tours_for_contact") {
      if (!body.contact_id) return err("contact_id required");
      let q = sb.from("v_showing_tours").select("*").eq("contact_id", body.contact_id);
      if (body.status) q = q.eq("status", body.status);
      q = q.order("scheduled_start", { ascending: false, nullsFirst: false }).limit(body.limit || 50);
      const { data } = await q;
      return ok({ success: true, tours: data || [] });
    }

    if (action === "list_all_tours") {
      let q = sb.from("v_showing_tours").select("*");
      if (body.status) q = q.eq("status", body.status);
      if (body.q) q = q.or(`contact_first_name.ilike.%${body.q}%,contact_last_name.ilike.%${body.q}%,contact_email.ilike.%${body.q}%,title.ilike.%${body.q}%`);
      q = q.order("scheduled_start", { ascending: false, nullsFirst: false }).limit(body.limit || 100).range(body.offset || 0, (body.offset || 0) + (body.limit || 100) - 1);
      const { data } = await q;
      return ok({ success: true, tours: data || [] });
    }

    if (action === "get_tour") {
      if (!body.batch_id && !body.share_token) return err("batch_id or share_token required");
      const q = body.batch_id ? sb.from("showing_batches").select("*").eq("id", body.batch_id) : sb.from("showing_batches").select("*").eq("share_token", body.share_token);
      const { data: batch } = await q.maybeSingle();
      if (!batch) return err("tour not found", 404);
      const { data: stops } = await sb.from("showings").select("*").eq("batch_id", batch.id).is("deleted_at", null).order("sort_order", { ascending: true });
      const { data: messages } = await sb.from("showing_messages").select("*").eq("batch_id", batch.id).order("scheduled_for", { ascending: false });
      const { data: views } = await sb.from("showing_views").select("*").eq("batch_id", batch.id).order("created_at", { ascending: false }).limit(50);
      return ok({ success: true, tour: batch, stops: stops || [], messages: messages || [], views: views || [] });
    }

    return err(`Unknown action: ${action}`);
  } catch (e: any) {
    console.error("[tours-admin] error:", e);
    return err(e?.message || String(e), 500);
  }
});

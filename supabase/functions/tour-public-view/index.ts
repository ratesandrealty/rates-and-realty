// tour-public-view v9 — route URL uses addresses, not coordinates
//
// CHANGELOG v8 -> v9:
//   - buildRouteMapUrl() and the embed iframe both now prefer the full street
//     address over lat/lng. MLS feeds (CRMLS via Trestle) occasionally return
//     wrong coordinates — e.g. 5021 Vauxhall Rd Westminster came back as
//     -118.04 (Seal Beach) instead of -117.98 (correct Westminster). Google's
//     geocoder resolves "5021 Vauxhall Road, Westminster, CA 92683" correctly
//     even when MLS lat/lng is wrong, so we send addresses as the source of truth.
//   - Falls back to lat/lng only when the property_address is missing.
//
// All v8 features preserved (rich confirm/cancel/feedback emails, route map preview,
// GPS-aware directions, calendar sync, activity events).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const RENE_PHONE = "+17144728508";
const RENE_EMAIL = "rene@ratesandrealty.com";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

async function safeWrite<T>(promise: PromiseLike<T>): Promise<void> {
  try { await promise; } catch { /* swallow */ }
}

function esc(s: any): string {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#039;");
}
function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}
function formatTimeOnly(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", hour12: true });
}

// NEW v9: build a clean address string for use in Google Maps URLs.
// Format: "5021 Vauxhall Road, Westminster, CA 92683"
// Falls back to coordinates only if address is missing entirely.
function stopToAddressString(s: any): string | null {
  const parts = [s.property_address, s.property_city, s.state, s.zip].filter(Boolean);
  if (parts.length >= 2) return parts.join(", ");
  // No usable address — fall back to lat/lng
  if (s.latitude && s.longitude) return `${s.latitude},${s.longitude}`;
  return null;
}

async function fireScorer(contactId: string, trigger: string) {
  if (!contactId) return;
  fetch(`${SUPABASE_URL}/functions/v1/lead-scorer`, {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ action: "score_contact", contact_id: contactId, trigger }),
  }).catch(() => {});
}

async function logView(batchId: string, eventType: string, req: Request, showingId: string | null = null) {
  try {
    const ua = req.headers.get("user-agent") || "";
    const ipRaw = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    const ip = ipRaw && /^[0-9a-fA-F:.]+$/.test(ipRaw) ? ipRaw : null;
    const referrer = req.headers.get("referer") || null;
    await sb.from("showing_views").insert({
      batch_id: batchId, showing_id: showingId, event_type: eventType,
      ip_address: ip, user_agent: ua, referrer,
    });
  } catch (e) {
    console.error("logView error:", e);
  }
}

async function notifyAgent(subject: string, smsBody: string, htmlBody: string) {
  fetch(`${SUPABASE_URL}/functions/v1/sms-service`, {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({
      trigger: "custom", to_phone: RENE_PHONE, quiet_hours_bypass: "staff_alert",
      params: { message: smsBody },
    }),
  }).catch(() => {});
  fetch(`${SUPABASE_URL}/functions/v1/email-service`, {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({
      action: "send", to_email: RENE_EMAIL,
      to_name: "Rene Duarte", first_name: "Rene",
      subject, html: htmlBody,
    }),
  }).catch(() => {});
}

// CHANGED v9: prefer addresses over coordinates so Google Maps geocodes from
// the canonical street address (more accurate than MLS lat/lng).
function buildRouteMapUrl(stops: any[]): string {
  const usable = stops.filter((s: any) => stopToAddressString(s) !== null);
  if (usable.length === 0) return "";
  if (usable.length === 1) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(stopToAddressString(usable[0])!)}&travelmode=driving`;
  }
  const destination = usable[usable.length - 1];
  const waypoints = usable.slice(0, -1);
  const waypointsStr = waypoints.map((s: any) => encodeURIComponent(stopToAddressString(s)!)).join("%7C");
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(stopToAddressString(destination)!)}&waypoints=${waypointsStr}&travelmode=driving`;
}

function renderItineraryEmailBlock(stops: any[]): string {
  if (!stops || stops.length === 0) return "";
  const stopsHtml = stops.map((s: any, i: number) => {
    const photoUrl = s.property_photo;
    const photoCell = photoUrl
      ? `<td style="width:120px;vertical-align:top;padding:0;"><img src="${esc(photoUrl)}" alt="Stop ${i + 1}" width="120" height="90" style="display:block;width:120px;height:90px;object-fit:cover;border-radius:6px;border:1px solid #2a2a2a;"/></td>`
      : `<td style="width:120px;vertical-align:top;padding:0;"><div style="width:120px;height:90px;background:#1a1a1a;border-radius:6px;border:1px solid #2a2a2a;text-align:center;line-height:90px;color:#555;font-size:12px;">No photo</div></td>`;
    const arrival = s.arrival_time ? formatTimeOnly(s.arrival_time) : "";
    const priceStr = s.property_price ? `$${Number(s.property_price).toLocaleString()}` : "";
    const specs = [
      s.property_beds ? `${s.property_beds} bd` : null,
      s.property_baths ? `${s.property_baths} ba` : null,
      s.property_sqft ? `${Number(s.property_sqft).toLocaleString()} sqft` : null,
    ].filter(Boolean).join(" \u00b7 ");
    const cleanPhone = s.listing_agent_phone ? s.listing_agent_phone.replace(/[^0-9+]/g, "") : "";
    const agentLine = s.listing_agent_name
      ? `<div style="font-size:11px;color:#888;margin-top:6px;line-height:1.4;">LA: <strong style="color:#ddd;">${esc(s.listing_agent_name)}</strong>${s.listing_agent_office ? " \u00b7 " + esc(s.listing_agent_office) : ""}${s.listing_agent_phone ? `<br/>\ud83d\udcde <a href="tel:${esc(cleanPhone)}" style="color:#C9A84C;text-decoration:none;">${esc(s.listing_agent_phone)}</a>` : ""}${s.listing_agent_email ? ` &nbsp;\u2709 <a href="mailto:${esc(s.listing_agent_email)}" style="color:#C9A84C;text-decoration:none;">${esc(s.listing_agent_email)}</a>` : ""}</div>`
      : "";

    return `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 12px;background:#141414;border:1px solid #2a2a2a;border-radius:8px;"><tr>
      <td style="padding:12px;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          ${photoCell}
          <td style="vertical-align:top;padding-left:12px;">
            <div style="font-size:11px;color:#C9A84C;text-transform:uppercase;letter-spacing:1.2px;font-weight:700;margin-bottom:4px;">Stop ${i + 1}${arrival ? " \u00b7 " + esc(arrival) : ""}${s.mls_number ? " \u00b7 MLS #" + esc(s.mls_number) : ""}</div>
            <div style="font-size:15px;color:#fff;font-weight:600;line-height:1.3;">${esc(s.property_address || "")}</div>
            <div style="font-size:13px;color:#888;margin-top:1px;">${esc([s.property_city, s.state, s.zip].filter(Boolean).join(", "))}</div>
            ${priceStr ? `<div style="font-size:14px;color:#C9A84C;font-weight:700;margin-top:4px;">${esc(priceStr)}</div>` : ""}
            ${specs ? `<div style="font-size:12px;color:#aaa;margin-top:2px;">${esc(specs)}</div>` : ""}
            ${agentLine}
          </td>
        </tr></table>
      </td>
    </tr></table>`;
  }).join("");

  return stopsHtml;
}

async function upsertAppointmentAndSync(batch: any, contact: any, stops: any[]): Promise<string | null> {
  if (!batch.scheduled_start) return null;
  try {
    const totalMins = (stops || []).reduce((acc: number, s: any) => acc + (s.duration_minutes || 30) + 15, 0) || 60;
    const stopsList = (stops || []).map((s: any, i: number) =>
      `${i + 1}. ${s.property_address || ""}${s.property_city ? ", " + s.property_city : ""}${s.mls_number ? " (MLS #" + s.mls_number + ")" : ""}${s.property_price ? " \u2014 $" + Number(s.property_price).toLocaleString() : ""}`
    ).join("\n");
    const notes = [
      "Stops:",
      stopsList,
      "",
      `Itinerary: https://beta.ratesandrealty.com/tour/${batch.share_token}`,
      batch.notes_internal ? `\nInternal notes: ${batch.notes_internal}` : "",
    ].filter(Boolean).join("\n");

    const leadName = `${contact?.first_name || ""} ${contact?.last_name || ""}`.trim() || "Lead";
    const title = `Home tour: ${leadName} (${stops?.length || 0} ${stops?.length === 1 ? "stop" : "stops"})`;

    let appointmentId = batch.appointment_id;
    if (appointmentId) {
      await sb.from("appointments").update({
        scheduled_at: batch.scheduled_start,
        appointment_time: batch.scheduled_start,
        title, notes,
        duration_minutes: totalMins,
        status: "confirmed",
      }).eq("id", appointmentId);
    } else {
      const { data: created, error } = await sb.from("appointments").insert({
        contact_id: batch.contact_id,
        scheduled_at: batch.scheduled_start,
        appointment_time: batch.scheduled_start,
        type: "showing_tour",
        title, notes,
        status: "confirmed",
        duration_minutes: totalMins,
        attendee_name: leadName,
        attendee_email: contact?.email || null,
        attendee_phone: contact?.phone || null,
      }).select("id").single();
      if (error || !created) {
        console.error("appointment insert failed:", error);
        return null;
      }
      appointmentId = created.id;
      await safeWrite(sb.from("showing_batches").update({ appointment_id: appointmentId }).eq("id", batch.id));
    }

    fetch(`${SUPABASE_URL}/functions/v1/google-calendar-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ appointment_id: appointmentId }),
    }).catch((e) => console.error("calendar sync trigger failed:", e));

    return appointmentId;
  } catch (e) {
    console.error("upsertAppointmentAndSync error:", e);
    return null;
  }
}

function renderHtml(batch: any, stops: any[], contact: any): string {
  const dateStr = formatDateTime(batch.scheduled_start);
  const stopsHtml = stops.map((s, i) => {
    const photoInner = s.property_photo
      ? `<img src="${esc(s.property_photo)}" alt="Stop ${i + 1}" loading="lazy"/>`
      : `<div class="no-photo">No photo available</div>`;
    const photo = s.listing_url
      ? `<a href="${esc(s.listing_url)}" target="_blank" rel="noopener" class="stop-photo-link" aria-label="View listing">${photoInner}</a>`
      : photoInner;
    const arrival = s.arrival_time ? formatTimeOnly(s.arrival_time) : (s.exact_time || "");
    const priceLine = s.property_price ? `$${Number(s.property_price).toLocaleString()}` : "";
    const specs = [s.property_beds ? s.property_beds + " bd" : "", s.property_baths ? s.property_baths + " ba" : "", s.property_sqft ? Number(s.property_sqft).toLocaleString() + " sqft" : ""].filter(Boolean).join(" \u00b7 ");
    // CHANGED v9: per-stop directions URL also uses address first
    const stopAddrStr = stopToAddressString(s);
    const directionsUrl = stopAddrStr
      ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(stopAddrStr)}&travelmode=driving`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.property_address || "")}`;

    const ratingButtons = [1,2,3,4,5].map(r => `<button class="rating-btn" data-stop-id="${esc(s.id)}" data-rating="${r}" aria-label="Rate ${r} stars">${"\u2605".repeat(r)}</button>`).join("");

    return `<article class="stop" id="stop-${esc(s.id)}">
      <div class="stop-num">Stop ${i + 1}${arrival ? ' \u00b7 ' + esc(arrival) : ''}${s.mls_number ? ' \u00b7 MLS #' + esc(s.mls_number) : ''}</div>
      <div class="stop-photo">${photo}</div>
      <div class="stop-body">
        <h2>${esc(s.property_address || "")}</h2>
        <div class="stop-loc">${esc([s.property_city, s.state, s.zip].filter(Boolean).join(", "))}</div>
        ${priceLine ? `<div class="stop-price">${esc(priceLine)}</div>` : ""}
        ${specs ? `<div class="stop-specs">${esc(specs)}</div>` : ""}
        ${s.agent_notes_for_lead ? `<div class="stop-notes"><span class="notes-label">Rene's note</span>${esc(s.agent_notes_for_lead)}</div>` : ""}
        <div class="stop-actions">
          <a class="btn btn-secondary" href="${esc(directionsUrl)}" target="_blank" rel="noopener">Get directions \u2192</a>
          ${s.listing_url ? `<a class="btn btn-tertiary" href="${esc(s.listing_url)}" target="_blank" rel="noopener">View listing</a>` : ""}
        </div>
        <div class="stop-feedback" data-stop-id="${esc(s.id)}">
          <div class="feedback-label">How'd you feel about this one?</div>
          <div class="rating-row">${ratingButtons}</div>
          <textarea class="feedback-text" placeholder="Optional: anything stand out?" data-stop-id="${esc(s.id)}">${esc(s.lead_feedback || "")}</textarea>
          <button class="btn btn-feedback-save" data-stop-id="${esc(s.id)}">Save feedback</button>
          <div class="feedback-saved" data-stop-id="${esc(s.id)}" hidden>\u2713 Saved</div>
        </div>
      </div>
    </article>`;
  }).join("");

  const isCanceled = batch.status === "canceled";
  const isConfirmed = ["confirmed", "in_progress", "completed"].includes(batch.status);
  const showActionsBar = !isCanceled && !isConfirmed;

  // CHANGED v9: route map embed iframe also uses addresses
  const usableStops = stops.filter(s => stopToAddressString(s) !== null);
  let routeMapHtml = "";
  if (usableStops.length > 0) {
    const fullRouteUrl = buildRouteMapUrl(stops);
    let embedSrc;
    if (usableStops.length === 1) {
      embedSrc = `https://maps.google.com/maps?q=${encodeURIComponent(stopToAddressString(usableStops[0])!)}&z=15&output=embed`;
    } else {
      const allAddrs = usableStops.map(s => stopToAddressString(s)!);
      const saddr = allAddrs[0];
      const daddr = allAddrs.slice(1).join("+to:");
      embedSrc = `https://maps.google.com/maps?saddr=${encodeURIComponent(saddr)}&daddr=${encodeURIComponent(daddr)}&output=embed`;
    }

    const stopListHtml = usableStops.map((s, i) =>
      `<li><span class="map-stop-num">${i + 1}</span><span class="map-stop-addr">${esc(s.property_address || "")}<br/><span style="color:#888;font-size:12px">${esc([s.property_city, s.state, s.zip].filter(Boolean).join(", "))}</span></span></li>`
    ).join("");

    routeMapHtml = `<section class="route-map">
      <div class="route-map-header">
        <h3>Route map</h3>
        <span class="route-map-count">${usableStops.length} ${usableStops.length === 1 ? "stop" : "stops"}</span>
      </div>
      <div class="route-map-preview">
        <iframe src="${esc(embedSrc)}" width="100%" height="260" frameborder="0" loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade" title="Route map preview"></iframe>
      </div>
      <ol class="route-stop-list">${stopListHtml}</ol>
      <a class="btn btn-primary route-open-btn" href="${esc(fullRouteUrl)}" target="_blank" rel="noopener">Start route from my location \u2192</a>
      <div class="route-map-hint">Driving directions will start from wherever you are when you tap the button.</div>
    </section>`;
  }

  const headerHtml = `<header class="header">
      <div class="brand">Rates &amp; Realty Home Tour</div>
      <h1>Hi ${esc(contact?.first_name || "there")},</h1>
      <p class="subtitle">${dateStr ? `Your tour is set for <strong style="color:#fff">${esc(dateStr)}</strong>` : "Your tour itinerary"}</p>
      ${isCanceled ? '<span class="pill pill-canceled">Canceled</span>' : isConfirmed ? '<span class="pill pill-confirmed">Confirmed</span>' : '<span class="pill pill-pending">Awaiting your confirmation</span>'}
    </header>`;

  const noteHtml = batch.notes_for_lead ? `<div class="lead-note">${esc(batch.notes_for_lead)}</div>` : "";

  let actionsHtml = "";
  if (showActionsBar) {
    actionsHtml = `<div class="actions-bar">
      <button class="btn btn-primary" id="btn-confirm" style="flex:1;">\u2713 Confirm I will be there</button>
      <button class="btn btn-danger" id="btn-cancel">Can\u2019t make it</button>
    </div>`;
  } else if (!isCanceled) {
    actionsHtml = `<div class="actions-bar">
      <a class="btn btn-secondary" style="flex:1;" href="sms:+17144728508">Text Rene</a>
      <button class="btn btn-danger" id="btn-cancel">Need to cancel</button>
    </div>`;
  }

  const css = `*,*::before,*::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #0a0a0a; color: #e8e8e8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
    body { padding: 16px; }
    .wrap { max-width: 640px; margin: 0 auto; }
    .header { padding: 24px 4px 12px; }
    .brand { font-size: 12px; color: #C9A84C; text-transform: uppercase; letter-spacing: 2px; font-weight: 700; }
    h1 { font-size: 28px; line-height: 1.15; margin: 8px 0 4px; color: #fff; font-weight: 700; letter-spacing: -0.02em; }
    .subtitle { font-size: 16px; color: #a8a8a8; margin: 0; }
    .pill { display: inline-block; padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 12px; }
    .pill-confirmed { background: rgba(80, 200, 120, 0.15); color: #6ed47e; border: 1px solid rgba(80, 200, 120, 0.4); }
    .pill-canceled { background: rgba(240, 80, 80, 0.15); color: #ff8888; border: 1px solid rgba(240, 80, 80, 0.4); }
    .pill-pending { background: rgba(201, 168, 76, 0.15); color: #C9A84C; border: 1px solid rgba(201, 168, 76, 0.4); }
    .actions-bar { display: flex; gap: 8px; flex-wrap: wrap; padding: 16px 4px; border-top: 1px solid #222; border-bottom: 1px solid #222; margin: 16px 0; }
    .btn { display: inline-flex; align-items: center; justify-content: center; padding: 11px 18px; border-radius: 8px; font-size: 14px; font-weight: 600; text-decoration: none; cursor: pointer; border: none; transition: all 0.15s; -webkit-tap-highlight-color: transparent; }
    .btn-primary { background: #C9A84C; color: #0a0a0a; }
    .btn-primary:hover { background: #E0BD60; }
    .btn-primary:disabled { background: #444; color: #888; cursor: not-allowed; }
    .btn-secondary { background: rgba(201, 168, 76, 0.12); color: #C9A84C; border: 1px solid rgba(201, 168, 76, 0.4); }
    .btn-secondary:hover { background: rgba(201, 168, 76, 0.2); }
    .btn-tertiary { background: transparent; color: #999; border: 1px solid #333; }
    .btn-tertiary:hover { color: #ccc; border-color: #555; }
    .btn-danger { background: transparent; color: #ff8888; border: 1px solid rgba(240, 80, 80, 0.4); }
    .btn-danger:hover { background: rgba(240, 80, 80, 0.1); }
    .lead-note { background: #141414; border-left: 3px solid #C9A84C; padding: 14px 16px; border-radius: 6px; margin: 16px 0; font-size: 14px; color: #ddd; line-height: 1.5; }
    .stops { display: flex; flex-direction: column; gap: 14px; padding-bottom: 24px; }
    .stop { background: #141414; border: 1px solid #2a2a2a; border-radius: 12px; overflow: hidden; }
    .stop-num { padding: 12px 16px 0; font-size: 11px; color: #C9A84C; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 700; }
    .stop-photo img, .stop-photo .no-photo { width: 100%; height: 220px; object-fit: cover; display: block; }
    .stop-photo .no-photo { background: #222; display: flex; align-items: center; justify-content: center; color: #666; font-size: 14px; }
    .stop-photo-link { display: block; cursor: pointer; transition: opacity 0.15s; position: relative; }
    .stop-photo-link:hover { opacity: 0.92; }
    .stop-photo-link::after { content: '\u2197 View listing'; position: absolute; top: 12px; right: 12px; background: rgba(10,10,10,0.8); color: #C9A84C; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 600; opacity: 0; transition: opacity 0.15s; backdrop-filter: blur(4px); }
    .stop-photo-link:hover::after { opacity: 1; }
    .stop-body { padding: 14px 16px 18px; }
    .stop-body h2 { font-size: 18px; margin: 0 0 4px; color: #fff; font-weight: 600; }
    .stop-loc { font-size: 14px; color: #888; margin-bottom: 8px; }
    .stop-price { font-size: 20px; color: #C9A84C; font-weight: 700; margin: 4px 0; }
    .stop-specs { font-size: 13px; color: #aaa; margin-bottom: 12px; }
    .stop-notes { background: #0d0d0d; border-radius: 6px; padding: 10px 12px; font-size: 13px; color: #ccc; margin: 10px 0; line-height: 1.5; }
    .notes-label { display: block; font-size: 10px; color: #C9A84C; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; font-weight: 700; }
    .stop-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
    .stop-feedback { padding: 12px 0 0; border-top: 1px solid #2a2a2a; margin-top: 12px; }
    .feedback-label { font-size: 12px; color: #999; margin-bottom: 8px; }
    .rating-row { display: flex; gap: 4px; margin-bottom: 10px; }
    .rating-btn { background: #1a1a1a; border: 1px solid #333; color: #555; border-radius: 6px; padding: 6px 8px; font-size: 12px; cursor: pointer; flex: 1; transition: all 0.1s; }
    .rating-btn:hover, .rating-btn.selected { background: rgba(201, 168, 76, 0.15); border-color: #C9A84C; color: #C9A84C; }
    .feedback-text { width: 100%; min-height: 60px; padding: 10px 12px; background: #0d0d0d; border: 1px solid #2a2a2a; border-radius: 6px; color: #e8e8e8; font-family: inherit; font-size: 14px; resize: vertical; margin-bottom: 8px; }
    .feedback-text:focus { outline: none; border-color: #C9A84C; }
    .btn-feedback-save { background: rgba(201, 168, 76, 0.12); color: #C9A84C; border: 1px solid rgba(201, 168, 76, 0.4); padding: 8px 14px; font-size: 13px; border-radius: 6px; cursor: pointer; }
    .feedback-saved { color: #6ed47e; font-size: 13px; margin-top: 8px; }
    .route-map { background: #141414; border: 1px solid #2a2a2a; border-radius: 12px; padding: 18px; margin: 24px 0; }
    .route-map-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; }
    .route-map-header h3 { font-size: 14px; color: #C9A84C; text-transform: uppercase; letter-spacing: 1.5px; margin: 0; font-weight: 700; }
    .route-map-count { font-size: 12px; color: #888; }
    .route-map-preview { border-radius: 8px; overflow: hidden; margin-bottom: 16px; border: 1px solid #2a2a2a; background: #1a1a1a; }
    .route-map-preview iframe { display: block; width: 100%; }
    .route-stop-list { list-style: none; padding: 0; margin: 0 0 16px; }
    .route-stop-list li { display: flex; align-items: flex-start; gap: 12px; padding: 10px 0; border-bottom: 1px solid #222; }
    .route-stop-list li:last-child { border-bottom: none; }
    .map-stop-num { background: #C9A84C; color: #0a0a0a; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; flex-shrink: 0; }
    .map-stop-addr { font-size: 14px; color: #e8e8e8; line-height: 1.4; }
    .route-open-btn { width: 100%; }
    .route-map-hint { font-size: 11px; color: #888; text-align: center; margin-top: 8px; }
    .footer { text-align: center; padding: 32px 16px 16px; font-size: 13px; color: #666; line-height: 1.6; }
    .footer a { color: #C9A84C; text-decoration: none; }
    .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #C9A84C; color: #0a0a0a; padding: 12px 20px; border-radius: 8px; font-weight: 600; font-size: 14px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); opacity: 0; transition: opacity 0.2s; pointer-events: none; z-index: 1000; }
    .toast.show { opacity: 1; }
    @media (min-width: 720px) { h1 { font-size: 34px; } .stop-photo img, .stop-photo .no-photo { height: 280px; } }`;

  const jsCode = `
    var TOUR_TOKEN = ${JSON.stringify(batch.share_token)};
    var API_BASE = ${JSON.stringify(SUPABASE_URL + "/functions/v1/tour-public-view")};
    function showToast(msg) { var t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(function(){ t.classList.remove('show'); }, 2400); }
    function api(path, body) { return fetch(API_BASE + path, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(Object.assign({share_token: TOUR_TOKEN}, body || {})) }).then(function(r){ return r.json(); }); }
    var btnConfirm = document.getElementById('btn-confirm');
    if (btnConfirm) btnConfirm.addEventListener('click', function() { btnConfirm.disabled = true; btnConfirm.textContent = 'Confirming...'; api('/confirm').then(function(r){ if (r.success) { showToast('Tour confirmed'); setTimeout(function(){ location.reload(); }, 1500); } else { btnConfirm.disabled = false; btnConfirm.textContent = '\u2713 Confirm I will be there'; showToast('Failed: ' + (r.error || 'unknown')); } }).catch(function(e){ btnConfirm.disabled = false; btnConfirm.textContent = '\u2713 Confirm I will be there'; showToast('Network error'); }); });
    var btnCancel = document.getElementById('btn-cancel');
    if (btnCancel) btnCancel.addEventListener('click', function() { var reason = prompt('Optional: let Rene know why?', ''); if (reason === null) return; btnCancel.disabled = true; btnCancel.textContent = 'Canceling...'; api('/cancel', {reason: reason}).then(function(r){ if (r.success) { showToast('Canceled. Rene has been notified.'); setTimeout(function(){ location.reload(); }, 1500); } else { btnCancel.disabled = false; showToast('Failed: ' + (r.error || 'unknown')); } }).catch(function(e){ btnCancel.disabled = false; showToast('Network error'); }); });
    var ratingState = {};
    document.querySelectorAll('.rating-btn').forEach(function(btn){ btn.addEventListener('click', function(){ var stopId = btn.dataset.stopId; var rating = parseInt(btn.dataset.rating); ratingState[stopId] = rating; document.querySelectorAll('.rating-btn[data-stop-id="' + stopId + '"]').forEach(function(b){ if (parseInt(b.dataset.rating) <= rating) b.classList.add('selected'); else b.classList.remove('selected'); }); }); });
    document.querySelectorAll('.btn-feedback-save').forEach(function(btn){ btn.addEventListener('click', function(){ var stopId = btn.dataset.stopId; var textEl = document.querySelector('.feedback-text[data-stop-id="' + stopId + '"]'); var feedback = textEl ? textEl.value.trim() : ''; var rating = ratingState[stopId] || null; if (!feedback && !rating) { showToast('Pick a rating or write something first'); return; } btn.disabled = true; btn.textContent = 'Saving...'; api('/feedback', {showing_id: stopId, rating: rating, feedback: feedback}).then(function(r){ if (r.success) { var saved = document.querySelector('.feedback-saved[data-stop-id="' + stopId + '"]'); if (saved) saved.hidden = false; btn.textContent = 'Update feedback'; btn.disabled = false; } else { btn.disabled = false; showToast('Failed: ' + (r.error || 'unknown')); } }); }); });
  `;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Your home tour \u00b7 Rates &amp; Realty</title><style>${css}</style></head>
<body><div class="wrap">${headerHtml}${noteHtml}${actionsHtml}<main class="stops">${stopsHtml}</main>${routeMapHtml}<footer class="footer">Questions? Text Rene at <a href="sms:+17144728508">714-472-8508</a><br/>Rene Duarte \u00b7 Rates &amp; Realty \u00b7 NMLS #1795044</footer></div><div class="toast" id="toast"></div><script>${jsCode}</script></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const fnIndex = segments.findIndex(s => s === "tour-public-view");
  const tail = fnIndex >= 0 ? segments.slice(fnIndex + 1) : segments;
  const last = tail[tail.length - 1] || "";

  if (req.method === "POST" && last === "confirm") {
    try {
      const body = await req.json();
      const token = body.share_token;
      if (!token) return new Response(JSON.stringify({ error: "share_token required" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
      const { data: batch } = await sb.from("showing_batches").select("*").eq("share_token", token).maybeSingle();
      if (!batch) return new Response(JSON.stringify({ error: "tour not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
      if (batch.status === "canceled") return new Response(JSON.stringify({ error: "tour was canceled" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

      await sb.from("showing_batches").update({ status: "confirmed", confirmed_at: new Date().toISOString() }).eq("id", batch.id);

      const { data: contact } = batch.contact_id ? await sb.from("contacts").select("*").eq("id", batch.contact_id).maybeSingle() : { data: null };
      const { data: stops } = await sb.from("showings").select("*").eq("batch_id", batch.id).is("deleted_at", null).order("sort_order", { ascending: true });

      if (batch.contact_id) {
        const { data: c } = await sb.from("contacts").select("pipeline_status").eq("id", batch.contact_id).maybeSingle();
        const earlyStages = ["New", "Contacted", "Qualified", "Nurturing", null, undefined, ""];
        if (c && earlyStages.includes(c.pipeline_status)) {
          await sb.from("contacts").update({ pipeline_status: "Touring" }).eq("id", batch.contact_id);
        }
        fireScorer(batch.contact_id, "tour_confirmed");
      }

      await safeWrite(sb.from("activity_events").insert({
        contact_id: batch.contact_id, type: "system", channel: "system", direction: "inbound",
        title: `\u2705 Lead confirmed tour: ${batch.title || batch.share_token}`,
        description: `${stops?.length || 0} stops on the itinerary`,
        metadata: { batch_id: batch.id }, created_at: new Date().toISOString(),
      }));

      const dateStr = batch.scheduled_start ? formatDateTime(batch.scheduled_start) : "TBD";
      const leadName = `${contact?.first_name || ""} ${contact?.last_name || ""}`.trim() || "Lead";
      const stopsCount = stops?.length || 0;
      const tourUrl = `https://beta.ratesandrealty.com/tour/${batch.share_token}`;
      const itineraryHtml = renderItineraryEmailBlock(stops || []);
      const routeUrl = buildRouteMapUrl(stops || []);

      notifyAgent(
        `\u2705 ${leadName} confirmed tour for ${dateStr}`,
        `\u2705 Tour CONFIRMED by ${leadName}\n${dateStr}\n${stopsCount} ${stopsCount === 1 ? "home" : "homes"}\n${tourUrl}`,
        `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#0a0a0a;color:#e8e8e8;padding:24px;max-width:640px;margin:0 auto;">
          <h2 style="color:#6ed47e;margin:0 0 8px;font-size:22px;">\u2705 Tour confirmed</h2>
          <p style="font-size:16px;color:#ddd;margin:0 0 4px;line-height:1.4;"><strong>${esc(leadName)}</strong> confirmed the tour for</p>
          <p style="font-size:18px;color:#fff;margin:0 0 16px;font-weight:600;">${esc(dateStr)}</p>
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#141414;border:1px solid #2a2a2a;border-radius:8px;margin:0 0 20px;"><tr><td style="padding:14px 16px;">
            <div style="font-size:11px;color:#C9A84C;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:6px;">Lead contact</div>
            <div style="font-size:15px;color:#fff;font-weight:600;">${esc(leadName)}</div>
            ${contact?.phone ? `<div style="margin-top:6px;">\ud83d\udcde <a href="tel:${esc(contact.phone)}" style="color:#C9A84C;text-decoration:none;font-size:14px;">${esc(contact.phone)}</a></div>` : ""}
            ${contact?.email ? `<div style="margin-top:4px;">\u2709 <a href="mailto:${esc(contact.email)}" style="color:#C9A84C;text-decoration:none;font-size:14px;">${esc(contact.email)}</a></div>` : ""}
          </td></tr></table>
          <div style="font-size:13px;color:#C9A84C;text-transform:uppercase;letter-spacing:1.2px;font-weight:700;margin:20px 0 10px;">Itinerary \u00b7 ${stopsCount} ${stopsCount === 1 ? "home" : "homes"}</div>
          ${itineraryHtml}
          ${routeUrl ? `<div style="text-align:center;margin:18px 0;"><a href="${esc(routeUrl)}" target="_blank" style="display:inline-block;padding:11px 20px;background:#C9A84C;color:#0a0a0a;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">\ud83d\uddfa Open route in Google Maps \u2192</a></div>` : ""}
          <div style="text-align:center;margin:14px 0;"><a href="${esc(tourUrl)}" target="_blank" style="display:inline-block;padding:9px 16px;background:transparent;color:#C9A84C;text-decoration:none;border:1px solid rgba(201,168,76,0.4);border-radius:6px;font-weight:500;font-size:13px;">View full itinerary page</a></div>
          <p style="color:#666;font-size:12px;margin-top:24px;border-top:1px solid #222;padding-top:14px;">Pipeline updated. Calendar event syncing now. CRM activity logged.</p>
        </div>`
      );

      upsertAppointmentAndSync(batch, contact, stops || []).catch((e) => console.error("appointment+calendar create failed:", e));

      await logView(batch.id, "confirm", req);
      return new Response(JSON.stringify({ success: true, status: "confirmed" }), { headers: { ...cors, "Content-Type": "application/json" } });
    } catch (e: any) {
      console.error("confirm error:", e);
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
    }
  }

  if (req.method === "POST" && last === "cancel") {
    try {
      const body = await req.json();
      const token = body.share_token;
      if (!token) return new Response(JSON.stringify({ error: "share_token required" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
      const { data: batch } = await sb.from("showing_batches").select("*").eq("share_token", token).maybeSingle();
      if (!batch) return new Response(JSON.stringify({ error: "tour not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });

      await sb.from("showing_messages").update({ status: "canceled" }).eq("batch_id", batch.id).eq("status", "queued");
      await sb.from("showing_batches").update({
        status: "canceled", canceled_at: new Date().toISOString(),
        cancel_reason: body.reason || "Lead canceled via tour page",
      }).eq("id", batch.id);

      const { data: contact } = batch.contact_id ? await sb.from("contacts").select("*").eq("id", batch.contact_id).maybeSingle() : { data: null };
      const { data: stops } = await sb.from("showings").select("*").eq("batch_id", batch.id).is("deleted_at", null).order("sort_order", { ascending: true });
      const leadName = `${contact?.first_name || ""} ${contact?.last_name || ""}`.trim() || "Lead";

      await safeWrite(sb.from("activity_events").insert({
        contact_id: batch.contact_id, type: "system", channel: "system", direction: "inbound",
        title: `\u274c Lead canceled tour${body.reason ? ": " + body.reason : ""}`,
        metadata: { batch_id: batch.id, reason: body.reason || null }, created_at: new Date().toISOString(),
      }));

      if (batch.appointment_id) {
        await safeWrite(sb.from("appointments").update({
          status: "canceled", cancelled_at: new Date().toISOString(),
        }).eq("id", batch.appointment_id));
      }

      const dateStr = batch.scheduled_start ? formatDateTime(batch.scheduled_start) : "TBD";
      const stopsCount = stops?.length || 0;
      const tourUrl = `https://beta.ratesandrealty.com/tour/${batch.share_token}`;
      const itineraryHtml = renderItineraryEmailBlock(stops || []);
      const routeUrl = buildRouteMapUrl(stops || []);

      notifyAgent(
        `\u274c ${leadName} canceled tour for ${dateStr}`,
        `\u274c Tour CANCELED by ${leadName}\n${dateStr}\n${stopsCount} ${stopsCount === 1 ? "home" : "homes"}${body.reason ? "\nReason: " + body.reason : ""}\n${tourUrl}`,
        `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#0a0a0a;color:#e8e8e8;padding:24px;max-width:640px;margin:0 auto;">
          <h2 style="color:#ff8888;margin:0 0 8px;font-size:22px;">\u274c Tour canceled</h2>
          <p style="font-size:16px;color:#ddd;margin:0 0 4px;line-height:1.4;"><strong>${esc(leadName)}</strong> canceled the tour scheduled for</p>
          <p style="font-size:18px;color:#fff;margin:0 0 8px;font-weight:600;">${esc(dateStr)}</p>
          ${body.reason ? `<div style="background:rgba(240,80,80,0.08);border-left:3px solid #ff8888;padding:10px 14px;border-radius:4px;margin:12px 0;font-size:14px;color:#ffaaaa;"><strong>Reason:</strong> ${esc(body.reason)}</div>` : ""}
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#141414;border:1px solid #2a2a2a;border-radius:8px;margin:14px 0 20px;"><tr><td style="padding:14px 16px;">
            <div style="font-size:11px;color:#C9A84C;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:6px;">Lead contact</div>
            <div style="font-size:15px;color:#fff;font-weight:600;">${esc(leadName)}</div>
            ${contact?.phone ? `<div style="margin-top:6px;">\ud83d\udcde <a href="tel:${esc(contact.phone)}" style="color:#C9A84C;text-decoration:none;font-size:14px;">${esc(contact.phone)}</a></div>` : ""}
            ${contact?.email ? `<div style="margin-top:4px;">\u2709 <a href="mailto:${esc(contact.email)}" style="color:#C9A84C;text-decoration:none;font-size:14px;">${esc(contact.email)}</a></div>` : ""}
          </td></tr></table>
          <div style="background:rgba(201,168,76,0.06);border:1px solid rgba(201,168,76,0.3);border-radius:6px;padding:12px 14px;margin:14px 0 18px;font-size:13px;color:#C9A84C;line-height:1.5;">\u26a0\ufe0f <strong>Action needed:</strong> Reach out to the listing agents below to cancel today's showings.</div>
          <div style="font-size:13px;color:#C9A84C;text-transform:uppercase;letter-spacing:1.2px;font-weight:700;margin:20px 0 10px;">Itinerary that was canceled \u00b7 ${stopsCount} ${stopsCount === 1 ? "home" : "homes"}</div>
          ${itineraryHtml}
          ${routeUrl ? `<div style="text-align:center;margin:18px 0;"><a href="${esc(routeUrl)}" target="_blank" style="display:inline-block;padding:10px 18px;background:transparent;color:#C9A84C;text-decoration:none;border:1px solid rgba(201,168,76,0.4);border-radius:6px;font-weight:500;font-size:13px;">\ud83d\uddfa Route map (for reference)</a></div>` : ""}
          <div style="text-align:center;margin:14px 0;"><a href="${esc(tourUrl)}" target="_blank" style="display:inline-block;padding:9px 16px;background:transparent;color:#888;text-decoration:none;border:1px solid #333;border-radius:6px;font-weight:500;font-size:13px;">View full itinerary page</a></div>
          <p style="color:#666;font-size:12px;margin-top:24px;border-top:1px solid #222;padding-top:14px;">Reminders for this tour have been canceled. Calendar event canceled. CRM activity logged. Lead is still in pipeline.</p>
        </div>`
      );

      await logView(batch.id, "cancel", req);
      return new Response(JSON.stringify({ success: true, status: "canceled" }), { headers: { ...cors, "Content-Type": "application/json" } });
    } catch (e: any) {
      console.error("cancel error:", e);
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
    }
  }

  if (req.method === "POST" && last === "feedback") {
    try {
      const body = await req.json();
      const token = body.share_token;
      if (!token || !body.showing_id) return new Response(JSON.stringify({ error: "share_token and showing_id required" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
      const { data: batch } = await sb.from("showing_batches").select("id, contact_id, share_token, title").eq("share_token", token).maybeSingle();
      if (!batch) return new Response(JSON.stringify({ error: "tour not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });

      const updates: any = { updated_at: new Date().toISOString(), feedback_at: new Date().toISOString() };
      if (body.rating != null && body.rating >= 1 && body.rating <= 5) updates.lead_rating = body.rating;
      if (typeof body.feedback === "string") updates.lead_feedback = body.feedback.substring(0, 2000);

      await sb.from("showings").update(updates).eq("id", body.showing_id).eq("batch_id", batch.id);

      const { data: stop } = await sb.from("showings").select("*").eq("id", body.showing_id).maybeSingle();
      const { data: contact } = batch.contact_id ? await sb.from("contacts").select("first_name, last_name, phone, email").eq("id", batch.contact_id).maybeSingle() : { data: null };

      await safeWrite(sb.from("activity_events").insert({
        contact_id: batch.contact_id, type: "system", channel: "system", direction: "inbound",
        title: `\u2728 Lead left feedback (${body.rating || ""}\u2605) on ${stop?.property_address || "a stop"}`,
        description: (body.feedback || "").substring(0, 200),
        metadata: { batch_id: batch.id, showing_id: body.showing_id, rating: body.rating, feedback: body.feedback, property_address: stop?.property_address, mls_number: stop?.mls_number },
        created_at: new Date().toISOString(),
      }));

      const leadName = `${contact?.first_name || ""} ${contact?.last_name || ""}`.trim() || "Lead";
      const ratingStars = body.rating ? "\u2b50".repeat(body.rating) : "";
      const propAddress = stop?.property_address || "a property";
      const tourUrl = `https://beta.ratesandrealty.com/tour/${batch.share_token}`;
      const subject = `\u2728 ${leadName} rated ${propAddress} ${body.rating || "?"}/5${body.rating ? "\u2b50" : ""}`;
      const smsBody = `\u2728 ${leadName} left feedback on ${propAddress}\n${ratingStars} (${body.rating || "?"}/5)${body.feedback ? "\n\"" + body.feedback.substring(0, 120) + (body.feedback.length > 120 ? "..." : "") + "\"" : ""}`;
      const htmlBody = `<div style="font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e8e8e8;padding:24px;">
        <h2 style="color:#C9A84C;margin:0 0 8px;">\u2728 New tour feedback</h2>
        <p style="font-size:16px;color:#ddd;margin:0 0 4px;"><strong>${esc(leadName)}</strong> rated <strong>${esc(propAddress)}</strong></p>
        ${stop?.property_city ? `<p style="color:#888;font-size:13px;margin:0 0 14px;">${esc([stop.property_city, stop.state, stop.zip].filter(Boolean).join(", "))}${stop.mls_number ? " \u00b7 MLS #" + esc(stop.mls_number) : ""}</p>` : ""}
        ${body.rating ? `<div style="font-size:24px;color:#C9A84C;margin:8px 0;">${ratingStars} <span style="color:#888;font-size:14px;">(${body.rating}/5)</span></div>` : ""}
        ${body.feedback ? `<div style="background:#141414;border-left:3px solid #C9A84C;padding:14px 16px;border-radius:6px;margin:12px 0;"><div style="font-size:11px;color:#C9A84C;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-weight:600;">Their note</div><div style="font-size:14px;color:#ddd;line-height:1.5;">${esc(body.feedback)}</div></div>` : ""}
        ${contact?.phone ? `<p style="color:#aaa;font-size:13px;margin-top:14px;">Phone: <a href="tel:${esc(contact.phone)}" style="color:#C9A84C">${esc(contact.phone)}</a></p>` : ""}
        ${contact?.email ? `<p style="color:#aaa;font-size:13px;">Email: <a href="mailto:${esc(contact.email)}" style="color:#C9A84C">${esc(contact.email)}</a></p>` : ""}
        <a href="${esc(tourUrl)}" style="display:inline-block;margin-top:16px;padding:10px 18px;background:#C9A84C;color:#0a0a0a;text-decoration:none;border-radius:6px;font-weight:600;">View tour itinerary \u2192</a>
        <p style="color:#666;font-size:12px;margin-top:24px;">Saved to the contact's activity timeline. Lead score updated.</p>
      </div>`;
      notifyAgent(subject, smsBody, htmlBody);

      await safeWrite(sb.from("showings").update({ feedback_emailed_to_agent_at: new Date().toISOString() }).eq("id", body.showing_id));

      if (batch.contact_id) fireScorer(batch.contact_id, "tour_feedback");
      await logView(batch.id, "feedback", req, body.showing_id);
      return new Response(JSON.stringify({ success: true }), { headers: { ...cors, "Content-Type": "application/json" } });
    } catch (e: any) {
      console.error("feedback error:", e);
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
    }
  }

  if (req.method === "GET" && tail.length >= 1) {
    try {
      const token = tail[tail.length - 1];
      if (!token || token === "tour-public-view") {
        return new Response("<!DOCTYPE html><html><body style='background:#0a0a0a;color:#fff;font-family:sans-serif;padding:40px;text-align:center'><h2>Tour link required</h2></body></html>", {
          status: 404, headers: { ...cors, "Content-Type": "text/html; charset=utf-8" },
        });
      }
      const { data: batch } = await sb.from("showing_batches").select("*").eq("share_token", token).maybeSingle();
      if (!batch) {
        return new Response("<!DOCTYPE html><html><body style='background:#0a0a0a;color:#fff;font-family:sans-serif;padding:40px;text-align:center'><h2>Tour not found</h2><p style='color:#888'>This link may have expired or been canceled.</p></body></html>", {
          status: 404, headers: { ...cors, "Content-Type": "text/html; charset=utf-8" },
        });
      }
      const { data: stops } = await sb.from("showings").select("*").eq("batch_id", batch.id).is("deleted_at", null).order("sort_order", { ascending: true });
      let contact: any = null;
      if (batch.contact_id) {
        const { data: c } = await sb.from("contacts").select("id, first_name, last_name, email, phone, pipeline_status").eq("id", batch.contact_id).maybeSingle();
        contact = c;
      }

      sb.from("showing_batches").update({
        view_count: (batch.view_count || 0) + 1,
        first_viewed_at: batch.first_viewed_at || new Date().toISOString(),
        last_viewed_at: new Date().toISOString(),
      }).eq("id", batch.id).then();

      logView(batch.id, "view", req);
      if (contact?.id) fireScorer(contact.id, "tour_viewed");

      const html = renderHtml(batch, stops || [], contact);
      return new Response(html, { headers: { ...cors, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    } catch (e: any) {
      console.error("GET render error:", e);
      return new Response(`<!DOCTYPE html><html><body style='background:#0a0a0a;color:#fff;font-family:sans-serif;padding:40px;text-align:center'><h2>Page error</h2><p style='color:#888'>${esc(e.message || "unknown")}</p></body></html>`, {
        status: 500, headers: { ...cors, "Content-Type": "text/html; charset=utf-8" },
      });
    }
  }

  return new Response(JSON.stringify({
    name: "tour-public-view", version: "v9",
    routes: ["GET /{share_token}", "POST /confirm", "POST /cancel", "POST /feedback"],
  }), { headers: { ...cors, "Content-Type": "application/json" } });
});

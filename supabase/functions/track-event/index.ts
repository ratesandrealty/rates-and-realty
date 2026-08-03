// track-event v4: /create_link now returns pretty_url (beta.ratesandrealty.com/r/{id})
// in addition to short_url. Callers prefer pretty_url for SMS/email body.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const PIXEL_GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff, 0xff,
  0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

function shortId(len = 8): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = ""; for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function sanitize(s: string): string {
  if (!s) return "";
  let out = String(s).trim().replace(/^["'`<\s]+|["'`>\s]+$/g, "").replace(/["'`]/g, "");
  if (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

async function getShortLinkBase(): Promise<string> {
  const { data } = await sb.from("app_config").select("value").eq("key", "short_link_base_url").maybeSingle();
  if (typeof data?.value === "string" && data.value.length > 0) return sanitize(data.value);
  return "https://beta.ratesandrealty.com/r";  // fallback
}

async function fireScorer(contactId: string, trigger: string) {
  if (!contactId) return;
  fetch(`${SUPABASE_URL}/functions/v1/lead-scorer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ action: "score_contact", contact_id: contactId, trigger }),
  }).catch(() => {});
}

async function handlePixel(emailId: string) {
  if (!emailId) return;
  try {
    const { data: row } = await sb.from("email_log").select("id, contact_id, opened_at, open_count").eq("id", emailId).maybeSingle();
    if (!row) return;
    const now = new Date().toISOString();
    await sb.from("email_log").update({
      opened_at: row.opened_at || now,
      first_opened_at: row.opened_at || now,
      last_opened_at: now,
      open_count: (row.open_count || 0) + 1,
      status: row.opened_at ? undefined : "opened",
    }).eq("id", emailId);
    if (row.contact_id) {
      await sb.from("activity_events").insert({
        contact_id: row.contact_id,
        type: "email", channel: "email", direction: "inbound",
        title: "\ud83d\udcec Email opened",
        metadata: { event: "open", email_log_id: emailId, opened: true },
        created_at: now,
      }).then(() => {}, () => {});
      const { data: c } = await sb.from("contacts").select("email_opens").eq("id", row.contact_id).maybeSingle();
      await sb.from("contacts").update({ email_opens: (c?.email_opens || 0) + 1 }).eq("id", row.contact_id);
      fireScorer(row.contact_id, "email_opened");
    }
  } catch (e) { console.error("pixel handler error:", e); }
}

async function handleClick(trackingId: string, req: Request): Promise<Response> {
  const { data: link, error: lookupErr } = await sb.from("tracked_links").select("*").eq("id", trackingId).maybeSingle();
  if (lookupErr) {
    console.error("tracked_links lookup error:", lookupErr);
    return new Response("Lookup error: " + lookupErr.message, { status: 500, headers: cors });
  }
  if (!link) return new Response("Link not found", { status: 404, headers: cors });

  const now = new Date().toISOString();
  const ua = req.headers.get("user-agent") || "";
  const ipRaw = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = ipRaw && /^[0-9a-fA-F:.]+$/.test(ipRaw) ? ipRaw : null;

  const updErr = await sb.from("tracked_links").update({
    click_count: (link.click_count || 0) + 1,
    first_clicked_at: link.first_clicked_at || now,
    last_clicked_at: now,
  }).eq("id", trackingId);
  if (updErr.error) console.error("tracked_links update err:", updErr.error);

  if (link.source === "email" && link.source_id) {
    try {
      const r = await sb.from("email_link_clicks").insert({
        email_log_id: link.source_id, contact_id: link.contact_id,
        tracking_id: trackingId, destination_url: link.destination_url,
        link_label: link.label, user_agent: ua, ip_address: ip, clicked_at: now,
      });
      if (r.error) console.error("email_link_clicks insert err:", r.error);
    } catch (e) { console.error("email_link_clicks throw:", e); }

    try {
      const { data: el } = await sb.from("email_log").select("click_count, first_clicked_at").eq("id", link.source_id).maybeSingle();
      await sb.from("email_log").update({
        click_count: (el?.click_count || 0) + 1,
        first_clicked_at: el?.first_clicked_at || now,
        last_clicked_at: now,
      }).eq("id", link.source_id);
    } catch (e) { console.error("email_log click count err:", e); }

    if (link.contact_id) {
      try {
        const r = await sb.from("activity_events").insert({
          contact_id: link.contact_id,
          type: "email", channel: "email", direction: "inbound",
          title: `\ud83d\udd17 Email link clicked: ${link.label || "link"}`,
          description: link.destination_url.substring(0, 200),
          metadata: { event: "click", clicked: true, label: link.label, url: link.destination_url, email_log_id: link.source_id },
          created_at: now,
        });
        if (r.error) console.error("activity_events email click err:", r.error);
      } catch (e) { console.error("activity_events email click throw:", e); }
    }
  } else {
    try {
      const r = await sb.from("web_events").insert({
        contact_id: link.contact_id,
        event_type: link.label === "property_search" ? "sms_link_click_search" : `${link.source}_link_click`,
        page_url: link.destination_url, source: link.source, source_campaign: link.source_id,
        properties: { label: link.label, tracking_id: trackingId },
        user_agent: ua, ip_address: ip, created_at: now,
      });
      if (r.error) console.error("web_events insert err:", r.error);
    } catch (e) { console.error("web_events throw:", e); }

    if (link.contact_id) {
      try {
        const r = await sb.from("activity_events").insert({
          contact_id: link.contact_id,
          type: "link_click", channel: link.source || "web", direction: "inbound",
          title: `\ud83d\udd17 ${link.label || "Link"} clicked from ${link.source || "web"}`,
          description: link.destination_url.substring(0, 200),
          metadata: { tracking_id: trackingId, label: link.label, url: link.destination_url },
          created_at: now,
        });
        if (r.error) console.error("activity_events link_click err:", r.error);
      } catch (e) { console.error("activity_events link_click throw:", e); }
    }
  }

  if (link.contact_id) fireScorer(link.contact_id, "link_click");

  return new Response(null, {
    status: 302,
    headers: { ...cors, "Location": link.destination_url, "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "";
  const secondToLast = segments[segments.length - 2] || "";

  if (req.method === "GET" && last === "pixel") {
    const emailId = url.searchParams.get("e") || url.searchParams.get("id") || "";
    handlePixel(emailId).catch(() => {});
    return new Response(PIXEL_GIF, {
      status: 200,
      headers: {
        "Content-Type": "image/gif",
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
        "Pragma": "no-cache", "Expires": "0", ...cors,
      },
    });
  }

  if (req.method === "GET" && (secondToLast === "click" || secondToLast === "t")) {
    try { return await handleClick(last, req); }
    catch (e: any) {
      console.error("click handler unhandled:", e?.message || e, e?.stack);
      return new Response("Error: " + (e?.message || "unknown"), { status: 500, headers: cors });
    }
  }

  if (req.method === "POST" && last === "event") {
    try {
      const body = await req.json();
      const ua = req.headers.get("user-agent") || "";
      const ipRaw = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
      const ip = ipRaw && /^[0-9a-fA-F:.]+$/.test(ipRaw) ? ipRaw : null;
      let eventType = body.event_type || "page_view";
      const url2 = (body.page_url || "").toLowerCase();
      if (eventType === "page_view") {
        if (url2.includes("search-homes") || url2.includes("/listing/")) eventType = "listing_view";
        else if (url2.includes("calc")) eventType = "calculator_used";
      }
      let contactId = body.contact_id || null;
      if (!contactId && body.session_id) {
        const { data: prior } = await sb.from("web_events")
          .select("contact_id").eq("session_id", body.session_id)
          .not("contact_id", "is", null)
          .order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (prior?.contact_id) contactId = prior.contact_id;
      }
      const { data: ev } = await sb.from("web_events").insert({
        contact_id: contactId, session_id: body.session_id || null,
        event_type: eventType, page_url: body.page_url || null,
        page_title: body.page_title || null, referrer: body.referrer || null,
        source: body.source || null, source_campaign: body.source_campaign || null,
        properties: body.properties || {}, user_agent: ua, ip_address: ip,
        created_at: new Date().toISOString(),
      }).select("id").single();
      if (contactId) {
        await sb.from("activity_events").insert({
          contact_id: contactId, type: "page_view", channel: "web", direction: "inbound",
          title: eventType === "listing_view" ? "\ud83c\udfe0 Viewed property listings" :
                 eventType === "calculator_used" ? "\ud83e\uddee Used mortgage calculator" :
                 `\ud83d\udcc4 Viewed ${body.page_title || body.page_url || "page"}`,
          metadata: { url: body.page_url, path: body.page_url, page_title: body.page_title, referrer: body.referrer, ...body.properties },
          created_at: new Date().toISOString(),
        }).catch(() => {});
        fireScorer(contactId, eventType);
      }
      return new Response(JSON.stringify({ success: true, event_id: ev?.id, contact_id: contactId }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e?.message || String(e) }), {
        status: 500, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  }

  if (req.method === "POST") {
    try {
      const body = await req.json();
      const action = (body.action || "").toLowerCase();
      if (last === "create_link" || action === "create_link") {
        if (!body.destination_url) {
          return new Response(JSON.stringify({ error: "destination_url required" }), {
            status: 400, headers: { ...cors, "Content-Type": "application/json" },
          });
        }
        const id = body.id || shortId(8);
        await sb.from("tracked_links").insert({
          id, destination_url: body.destination_url,
          contact_id: body.contact_id || null,
          source: body.source || "unknown",
          source_id: body.source_id || null,
          label: body.label || null,
        });
        const shortBase = await getShortLinkBase();
        const prettyUrl = `${shortBase}/${id}`;
        return new Response(JSON.stringify({
          success: true,
          tracking_id: id,
          pretty_url: prettyUrl,                                                           // ← NEW: short branded URL for SMS/email
          short_url: `${SUPABASE_URL}/functions/v1/track-event/t/${id}`,                    // legacy raw URL (fallback if Worker is down)
          click_url: `${SUPABASE_URL}/functions/v1/track-event/click/${id}`,
        }), { headers: { ...cors, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "Unknown action" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e?.message || String(e) }), {
        status: 500, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify({
    name: "track-event", version: "v4",
    routes: ["GET /pixel?e={id}", "GET /click/{id}", "GET /t/{id}", "POST /event", "POST /create_link"],
  }), { headers: { ...cors, "Content-Type": "application/json" } });
});

// ai-sms-bot v10: prefer pretty_url (beta.ratesandrealty.com/r/{id}) over raw supabase URL
// for cleaner SMS. All other v9 features preserved.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireStaff } from "../_shared/require-staff.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function normalizePhone(p: string): string {
  const d = (p || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  return d ? `+${d}` : "";
}
function last10(p: string): string { return (p || "").replace(/\D/g, "").slice(-10); }

function sanitizeBaseUrl(raw: string): string {
  if (!raw) return "https://beta.ratesandrealty.com/public/search-homes.html";
  let s = String(raw).trim();
  s = s.replace(/^["'`<\s]+|["'`>\s]+$/g, "");
  s = s.replace(/["'`]/g, "");
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

async function getBotSettings() {
  const { data, error } = await sb.from("bot_settings").select("*").eq("id", "default").single();
  if (error) throw new Error(`bot_settings: ${error.message}`);
  return data!;
}

async function getPropertySearchBaseUrl(): Promise<string> {
  const { data } = await sb.from("app_config").select("value").eq("key", "property_search_base_url").maybeSingle();
  if (typeof data?.value === "string") return sanitizeBaseUrl(data.value);
  return "https://beta.ratesandrealty.com/public/search-homes.html";
}

async function getOrCreateConversation(phone: string, contactId: string | null) {
  const normalized = normalizePhone(phone);
  const { data: existing } = await sb.from("bot_conversations").select("*").eq("phone", normalized).maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await sb.from("bot_conversations").insert({
    phone: normalized, contact_id: contactId, status: "active", ai_enabled: true,
    discovery_state: {},
  }).select("*").single();
  if (error) throw new Error(`conv insert: ${error.message}`);
  return created!;
}

async function getConversationHistory(phoneE164: string, limit = 10) {
  const l10 = last10(phoneE164);
  if (!l10) return [];
  const [inbound, outbound] = await Promise.all([
    sb.from("sms_log").select("direction, body, created_at").eq("direction", "inbound").ilike("from_phone", `%${l10}%`).order("created_at", { ascending: false }).limit(limit),
    sb.from("sms_log").select("direction, body, created_at").eq("direction", "outbound").ilike("to_phone", `%${l10}%`).order("created_at", { ascending: false }).limit(limit),
  ]);
  return [...(inbound.data || []), ...(outbound.data || [])]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(-limit);
}

async function getContactContext(contactId: string | null) {
  if (!contactId) return null;
  const { data } = await sb.from("contacts")
    .select("id, first_name, last_name, email, phone, city, loan_type, pipeline_status, lead_status, lead_temperature, score_tier, tags, notes, last_contact_date, sms_opt_in, source, target_purchase_price, target_loan_amount, fico_band")
    .eq("id", contactId).maybeSingle();
  return data;
}

async function getRecentAppointments(contactId: string | null) {
  if (!contactId) return [];
  const { data } = await sb.from("appointments")
    .select("title, appointment_time, status")
    .eq("contact_id", contactId)
    .gte("appointment_time", new Date(Date.now() - 30 * 86400000).toISOString())
    .order("appointment_time", { ascending: false }).limit(3);
  return data || [];
}

async function getBookingUrls() {
  const { data } = await sb.from("email_settings").select("booking_url, booking_url_intro, booking_url_strategy, booking_url_application").eq("lo_id", "rene").maybeSingle();
  return data || {};
}

async function checkRateLimit(phoneE164: string, settings: any) {
  const l10 = last10(phoneE164);
  const now = Date.now();
  const cooldownAgo = new Date(now - settings.cooldown_seconds_between_replies * 1000).toISOString();
  const { data: recent } = await sb.from("sms_log").select("id").eq("direction", "outbound").ilike("to_phone", `%${l10}%`).gte("created_at", cooldownAgo).limit(1);
  if ((recent || []).length > 0) return { allowed: false, reason: "cooldown" };
  const oneHourAgo = new Date(now - 3600 * 1000).toISOString();
  const { count: hourCount } = await sb.from("sms_log").select("id", { count: "exact", head: true }).eq("direction", "outbound").eq("trigger_type", "ai_bot_reply").ilike("to_phone", `%${l10}%`).gte("created_at", oneHourAgo);
  if ((hourCount || 0) >= settings.max_replies_per_hour) return { allowed: false, reason: "hourly_cap" };
  const oneDayAgo = new Date(now - 86400 * 1000).toISOString();
  const { count: dayCount } = await sb.from("sms_log").select("id", { count: "exact", head: true }).eq("direction", "outbound").eq("trigger_type", "ai_bot_reply").ilike("to_phone", `%${l10}%`).gte("created_at", oneDayAgo);
  if ((dayCount || 0) >= settings.max_replies_per_day) return { allowed: false, reason: "daily_cap" };
  return { allowed: true };
}

function getCurrentPTMinutes(): { weekday: number; minutes: number } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", weekday: "short", hour12: false });
  const parts = fmt.formatToParts(now);
  const wd = parts.find(p => p.type === "weekday")?.value || "";
  const h = parts.find(p => p.type === "hour")?.value || "0";
  const m = parts.find(p => p.type === "minute")?.value || "0";
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { weekday: dayMap[wd] ?? 1, minutes: parseInt(h) * 60 + parseInt(m) };
}

function parseHHMM(s: string): { h: number; m: number } {
  const [h, m] = (s || "00:00").split(":").map((x: string) => parseInt(x));
  return { h: h || 0, m: m || 0 };
}

function isInQuietHours(settings: any): boolean {
  if (!settings.quiet_hours_enabled) return false;
  const { h: sh, m: sm } = parseHHMM(settings.quiet_hours_start || "22:00");
  const { h: eh, m: em } = parseHHMM(settings.quiet_hours_end || "08:00");
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  const { minutes } = getCurrentPTMinutes();
  if (startMin < endMin) return minutes >= startMin && minutes < endMin;
  return minutes >= startMin || minutes < endMin;
}

function nextQuietEndUTC(settings: any): Date {
  const { h: eh, m: em } = parseHHMM(settings.quiet_hours_end || "08:00");
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "numeric", second: "numeric", hour12: false });
  const parts = fmt.formatToParts(now);
  const ymd: Record<string, string> = {};
  for (const p of parts) ymd[p.type] = p.value;
  const utcNow = now.getTime();
  const ptNowApprox = new Date(`${ymd.year}-${ymd.month}-${ymd.day}T${ymd.hour.padStart(2, "0")}:${ymd.minute.padStart(2, "0")}:${ymd.second.padStart(2, "0")}Z`).getTime();
  const ptOffsetMs = utcNow - ptNowApprox;
  const todayEndPT_asUTC_iso = `${ymd.year}-${ymd.month}-${ymd.day}T${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}:00Z`;
  let todayEndUTC = new Date(todayEndPT_asUTC_iso).getTime() + ptOffsetMs;
  if (todayEndUTC <= utcNow) todayEndUTC += 86400000;
  return new Date(todayEndUTC);
}

function isInBusinessHours(settings: any) {
  const { weekday, minutes } = getCurrentPTMinutes();
  const businessDays = settings.business_days || [1, 2, 3, 4, 5, 6];
  if (!businessDays.includes(weekday)) return { in_hours: false, note: "weekend" };
  const sm = parseInt((settings.business_hours_start || "08:00:00").split(":")[0]) * 60;
  const em = parseInt((settings.business_hours_end || "20:00:00").split(":")[0]) * 60;
  if (minutes < sm || minutes >= em) return { in_hours: false, note: "after hours" };
  return { in_hours: true, note: "" };
}

// ===== v10: prefer pretty_url over short_url =====
async function mintTrackedLink(destinationUrl: string, contactId: string | null, conversationId: string, label: string): Promise<string> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/track-event/create_link`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({
        destination_url: destinationUrl,
        contact_id: contactId,
        source: "ai_sms_bot",
        source_id: conversationId,
        label,
      }),
    });
    if (!r.ok) return destinationUrl;
    const data = await r.json();
    // Prefer pretty (beta.ratesandrealty.com/r/abc) over raw supabase URL for SMS friendliness
    return data.pretty_url || data.short_url || destinationUrl;
  } catch {
    return destinationUrl;
  }
}

const TOOLS = [
  { name: "calculate_mortgage", description: "Calculate real mortgage numbers. action='payment'/'affordability'/'compare'/'rent_vs_buy'. ALWAYS use this for any payment/affordability/rent-vs-buy/comparison question. Returns exact figures \u2014 use them directly, do not estimate.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["payment", "affordability", "compare", "rent_vs_buy"] }, purchase_price: { type: "number" }, monthly_income: { type: "number" }, monthly_debts: { type: "number" }, monthly_rent: { type: "number" }, years_horizon: { type: "number" }, program: { type: "string", enum: ["conventional", "fha", "va", "usda", "jumbo"] }, programs: { type: "array", items: { type: "string" } }, down_payment_pct: { type: "number" }, down_payment_amount: { type: "number" }, fico: { type: "number" }, county: { type: "string" }, hoa_monthly: { type: "number" }, term_years: { type: "number" } }, required: ["action"] } },
  { name: "search_guidelines", description: "FHA/Fannie/Freddie/USDA handbook lookup.", input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
  { name: "lookup_dpa_programs", description: "CA DPA programs.", input_schema: { type: "object", properties: { keyword: { type: "string" } } } },
  { name: "list_loan_programs", description: "Rates & Realty's loan program catalog.", input_schema: { type: "object", properties: { category: { type: "string", enum: ["standard", "non_qm", "commercial", "second_lien", "special", "all"] }, keyword: { type: "string" } } } },
  { name: "get_loan_limits", description: "2026 conforming + FHA limits by CA county.", input_schema: { type: "object", properties: { county: { type: "string" } }, required: ["county"] } },
  { name: "generate_search_link", description: "Build property search URL. ALL prices must be PASSED AS WHOLE DOLLAR INTEGERS \u2014 e.g. for '$900k' or '900k' or 'under nine hundred thousand', pass max_price=900000. NEVER pass 900 or '900k' as a string.", input_schema: { type: "object", properties: { cities: { type: "array", items: { type: "string" } }, min_price: { type: "number", description: "Whole dollars, e.g. 600000" }, max_price: { type: "number", description: "Whole dollars, e.g. 900000" }, min_beds: { type: "number" }, min_baths: { type: "number" }, listing_type: { type: "string", enum: ["for_sale", "for_rent"] } } } },
  { name: "recommend_listings", description: "Pull live listings. Same price rule as generate_search_link \u2014 prices are whole-dollar integers.", input_schema: { type: "object", properties: { cities: { type: "array", items: { type: "string" } }, max_price: { type: "number" }, min_price: { type: "number" }, min_beds: { type: "number" }, listing_type: { type: "string", enum: ["for_sale", "for_rent"] } } } },
  { name: "capture_contact_info", description: "Save info silently. target_purchase_price MUST be whole dollars (e.g. 900000 not 900 or '$900k').", input_schema: { type: "object", properties: { first_name: { type: "string" }, last_name: { type: "string" }, email: { type: "string" }, city: { type: "string" }, intent: { type: "string", enum: ["buy", "refi", "sell", "buy_and_sell", "investor", "info_only"] }, target_purchase_price: { type: "number" }, target_loan_amount: { type: "number" }, fico_band: { type: "string", enum: ["excellent_740_plus", "good_680_739", "fair_620_679", "building_under_620"] }, loan_type_interest: { type: "string" }, timeline: { type: "string" }, is_first_time_buyer: { type: "boolean" }, property_use: { type: "string", enum: ["primary", "second_home", "investment"] }, income_type: { type: "string", enum: ["w2", "self_employed", "1099", "investor", "retired", "mixed"] }, notes_to_add: { type: "string" } } } },
  { name: "save_property_search", description: "Save criteria after name+email captured.", input_schema: { type: "object", properties: { cities: { type: "array", items: { type: "string" } }, min_price: { type: "number" }, max_price: { type: "number" }, min_beds: { type: "number" }, min_baths: { type: "number" }, listing_type: { type: "string", enum: ["for_sale", "for_rent"] }, property_types: { type: "array", items: { type: "string" } }, name: { type: "string" } }, required: ["cities"] } },
];

async function executeTool(name: string, input: any, ctx: { conversation: any; phone: string; baseUrl: string }): Promise<string> {
  const cleanBase = sanitizeBaseUrl(ctx.baseUrl);
  try {
    if (name === "calculate_mortgage") {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/mortgage-calc`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` }, body: JSON.stringify(input) });
      return JSON.stringify(await res.json()).substring(0, 4000);
    }
    if (name === "search_guidelines") {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/guideline-ai`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` }, body: JSON.stringify({ question: input.question }) });
      const data = await res.json();
      return JSON.stringify({ answer: (data.reply || data.answer || "").substring(0, 2500), chunks_found: data.chunks_found || 0 });
    }
    if (name === "lookup_dpa_programs") {
      const kw = (input.keyword || "").toLowerCase();
      let q = sb.from("dpa_programs").select("name, sponsor, max_assistance_amount, eligibility_summary, geographic_scope, status").eq("status", "active").limit(8);
      if (kw) q = q.or(`name.ilike.%${kw}%,sponsor.ilike.%${kw}%,eligibility_summary.ilike.%${kw}%`);
      const { data } = await q;
      return JSON.stringify({ programs: data || [], count: (data || []).length });
    }
    if (name === "list_loan_programs") {
      const category = (input.category || "all").toLowerCase();
      const kw = (input.keyword || "").toLowerCase();
      let q = sb.from("loan_program_catalog").select("id, category, name, short_pitch, best_for, min_down_payment_pct, min_fico, max_dti_pct, income_docs_required, unique_features, typical_use_cases, rate_premium_vs_conv").eq("active", true).order("display_order");
      if (category !== "all") q = q.eq("category", category);
      if (kw) q = q.or(`name.ilike.%${kw}%,short_pitch.ilike.%${kw}%,best_for.ilike.%${kw}%,unique_features.ilike.%${kw}%`);
      const { data } = await q.limit(10);
      return JSON.stringify({ programs: data || [], count: (data || []).length });
    }
    if (name === "get_loan_limits") {
      const county = (input.county || "orange").toLowerCase();
      const { data } = await sb.from("loan_limits").select("*").eq("county", county).eq("year", 2026).maybeSingle();
      if (!data) return JSON.stringify({ error: `No loan limits for county: ${county}` });
      return JSON.stringify({ county: data.county, year: data.year, high_cost_area: data.high_cost_area, conforming_1unit: data.conforming_1unit, fha_1unit: data.fha_1unit });
    }
    if (name === "generate_search_link") {
      const params = new URLSearchParams();
      if (input.cities?.length) params.set("cities", input.cities.join(","));
      if (input.min_price) params.set("min_price", String(input.min_price));
      if (input.max_price) params.set("max_price", String(input.max_price));
      if (input.min_beds) params.set("min_beds", String(input.min_beds));
      if (input.min_baths) params.set("baths", String(input.min_baths));
      if (input.listing_type) params.set("listing_type", input.listing_type);
      const rawUrl = `${cleanBase}?${params.toString()}`;
      const trackedUrl = await mintTrackedLink(rawUrl, ctx.conversation.contact_id, ctx.conversation.id, "property_search");
      return JSON.stringify({ search_url: trackedUrl, criteria_applied: { cities: input.cities, max_price: input.max_price, min_price: input.min_price, min_beds: input.min_beds, listing_type: input.listing_type } });
    }
    if (name === "recommend_listings") {
      const params = new URLSearchParams();
      if (input.cities?.length) params.set("cities", input.cities.join(","));
      if (input.max_price) params.set("max_price", String(input.max_price));
      if (input.min_price) params.set("min_price", String(input.min_price));
      if (input.min_beds) params.set("min_beds", String(input.min_beds));
      if (input.listing_type) params.set("listing_type", input.listing_type);
      const rawUrl = `${cleanBase}?${params.toString()}`;
      const trackedUrl = await mintTrackedLink(rawUrl, ctx.conversation.contact_id, ctx.conversation.id, "property_search");
      return JSON.stringify({ listings: [], count: 0, full_search_url: trackedUrl, criteria_applied: { cities: input.cities, max_price: input.max_price, min_beds: input.min_beds, listing_type: input.listing_type }, note: "Send the user the full_search_url \u2014 our search page renders live MLS results." });
    }
    if (name === "capture_contact_info") {
      const newState = { ...(ctx.conversation.discovery_state || {}), ...input };
      await sb.from("bot_conversations").update({ discovery_state: newState }).eq("id", ctx.conversation.id);
      let contactId = ctx.conversation.contact_id;
      const fullPhone = normalizePhone(ctx.phone);
      if (!contactId) {
        const last7 = last10(ctx.phone).slice(-7);
        let found: any = null;
        if (input.email) {
          const { data } = await sb.from("contacts").select("id").ilike("email", input.email).maybeSingle();
          found = data;
        }
        if (!found && last7) {
          const { data } = await sb.from("contacts").select("id").ilike("phone", `%${last7}%`).maybeSingle();
          found = data;
        }
        if (found) {
          contactId = found.id;
        } else if (input.first_name || input.email) {
          const { data: created } = await sb.from("contacts").insert({
            first_name: input.first_name || "Unknown", last_name: input.last_name || null,
            email: input.email || null, phone: fullPhone, city: input.city || null,
            loan_type: input.loan_type_interest || null,
            target_purchase_price: input.target_purchase_price || null,
            target_loan_amount: input.target_loan_amount || null,
            fico_band: input.fico_band || null, source: "ai_sms_bot",
            funnel_source: "sms_inbound_chatbot", lead_status: "new",
            pipeline_status: "new_lead", sms_opt_in: true, tags: ["sms_bot_captured"],
          }).select("id").single();
          contactId = created?.id || null;
        }
        if (contactId) {
          await sb.from("bot_conversations").update({ contact_id: contactId, lead_captured_at: new Date().toISOString() }).eq("id", ctx.conversation.id);
          await sb.from("activity_events").insert({
            contact_id: contactId, type: "system", channel: "sms", direction: "internal",
            title: "\ud83e\udd16 AI bot captured new lead via SMS",
            description: `Captured: ${Object.entries(input).filter(([k, v]) => v && k !== "notes_to_add").map(([k, v]) => `${k}=${v}`).join(", ")}`,
            status: "completed", metadata: { phone: fullPhone, captured_fields: input },
            created_at: new Date().toISOString(),
          });
        }
      } else {
        const updates: any = {};
        if (input.first_name) updates.first_name = input.first_name;
        if (input.last_name) updates.last_name = input.last_name;
        if (input.email) updates.email = input.email;
        if (input.city) updates.city = input.city;
        if (input.target_purchase_price) updates.target_purchase_price = input.target_purchase_price;
        if (input.target_loan_amount) updates.target_loan_amount = input.target_loan_amount;
        if (input.fico_band) updates.fico_band = input.fico_band;
        if (input.loan_type_interest) updates.loan_type = input.loan_type_interest;
        if (Object.keys(updates).length) {
          updates.updated_at = new Date().toISOString();
          await sb.from("contacts").update(updates).eq("id", contactId);
        }
      }
      return JSON.stringify({ success: true, contact_id: contactId, captured: input });
    }
    if (name === "save_property_search") {
      const cities = input.cities || [];
      const params = new URLSearchParams();
      if (cities.length) params.set("cities", cities.join(","));
      if (input.min_price) params.set("min_price", String(input.min_price));
      if (input.max_price) params.set("max_price", String(input.max_price));
      if (input.min_beds) params.set("min_beds", String(input.min_beds));
      if (input.min_baths) params.set("baths", String(input.min_baths));
      if (input.listing_type) params.set("listing_type", input.listing_type);
      const url = `${cleanBase}?${params.toString()}`;
      const friendlyName = input.name || `${cities.join(", ") || "Search"}${input.min_beds ? ` ${input.min_beds}+br` : ""}${input.max_price ? ` under $${(input.max_price / 1000).toFixed(0)}k` : ""}`;
      const { data: saved, error: insErr } = await sb.from("saved_searches").insert({
        contact_id: ctx.conversation.contact_id || null, bot_conversation_id: ctx.conversation.id,
        source: "ai_sms_bot", name: friendlyName,
        criteria: { cities, min_price: input.min_price, max_price: input.max_price, min_beds: input.min_beds, min_baths: input.min_baths, listing_type: input.listing_type || "for_sale", property_types: input.property_types },
        search_url: url, active: true,
      }).select("id").single();
      if (insErr) return JSON.stringify({ error: insErr.message, saved: false });
      if (ctx.conversation.contact_id) {
        await sb.from("activity_events").insert({
          contact_id: ctx.conversation.contact_id, type: "system", channel: "system", direction: "internal",
          title: `\ud83d\udd0d AI bot saved search: ${friendlyName}`,
          description: `URL: ${url}`, status: "completed",
          metadata: { saved_search_id: saved?.id, criteria: input },
          created_at: new Date().toISOString(),
        }).then(() => {}, () => {});
      }
      return JSON.stringify({ success: true, saved_search_id: saved?.id, search_url: url, friendly_name: friendlyName });
    }
    return JSON.stringify({ error: `unknown tool: ${name}` });
  } catch (e: any) {
    return JSON.stringify({ error: e?.message || String(e) });
  }
}

/* actor: the verified human who asked, or null for an internal caller.
 * NULL HERE IS NOT "UNKNOWN" — see the sms_log.actor_user_id note. */
async function sendBotReply(phone: string, body: string, contactId: string | null, conversationId: string, triggerType = "ai_bot_reply", actor: string | null = null, actorRole: string | null = null) {
  const safe = body.trim().substring(0, 480);
  if (!safe) return { ok: false, error: "empty" };
  try {
    /* AUDIT BEFORE THE SEND, and refuse the send if it fails.
     *
     * Same ordering as delete-contacts, bulk_update and click-to-call: the text
     * goes out under Rene's NMLS and cannot be recalled, so a post-hoc audit
     * that fails would leave a sent message with no record of what asked for it.
     *
     * actor is null for bot-process-queue and twilio-inbound, which reach this
     * with the SERVICE KEY. That is correct and permanent: an inbound text
     * triggering a bot reply is genuinely nobody's action, and inventing an
     * actor would be worse than recording none. actor_role distinguishes the
     * two cases — 'service' means internal, a role name means a human. */
    const { error: auditErr } = await sb.from("audit_log").insert({
      table_name: "sms_log",
      row_id: contactId,
      operation: "ai_bot_send",
      old_data: null,
      new_data: {
        via: "ai-sms-bot",
        actor_role: actorRole,
        internal: actorRole === "service",
        trigger_type: triggerType,
        to_phone: phone,
        contact_id: contactId,
        conversation_id: conversationId,
        body_preview: safe.slice(0, 160),
      },
      changed_by: actor,
    });
    if (auditErr) {
      console.error("[ai-sms-bot] REFUSED — audit write failed:", auditErr.message);
      return { ok: false, error: "Refusing to send: the audit record could not be written (" + auditErr.message + ")" };
    }

    const res = await fetch(`${SUPABASE_URL}/functions/v1/sms-service`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ trigger: "custom", to_phone: phone, params: { message: safe }, contact_id: contactId || undefined, trigger_id: conversationId }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    /* Stamp the actor onto the sms_log row itself, not only into audit_log, so
       "what was sent" and "who asked" are ONE lookup rather than a join. */
    if (data.sid) await sb.from("sms_log").update({ trigger_type: triggerType, actor_user_id: actor }).eq("twilio_sid", data.sid).then(() => {}, () => {});
    return { ok: true, sid: data.sid };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function notifyRene(message: string) {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/sms-service`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ trigger: "custom", to_phone: "+17144728508", params: { message } }),
    });
  } catch {}
}

async function runAiTurn(args: {
  message_body: string; intent: string; intent_confidence: string;
  contact: any; conversation: any; history: any[]; appointments: any[];
  bookingUrls: any; baseUrl: string; settings: any; isFirstReply: boolean; phaseLog: string[];
}): Promise<{ text: string; toolsUsed: string[]; tokensIn: number; tokensOut: number }> {
  const { in_hours, note: hoursNote } = isInBusinessHours(args.settings);
  const discovery = args.conversation.discovery_state || {};

  const contactBlock = args.contact ? `CONTACT IN CRM:
- Name: ${args.contact.first_name || ""} ${args.contact.last_name || ""}
- City: ${args.contact.city || "unknown"}
- Loan interest: ${args.contact.loan_type || "unknown"}
- Pipeline: ${args.contact.pipeline_status || "unknown"}
- Lead temp: ${args.contact.lead_temperature || "unknown"}
- Target price: ${args.contact.target_purchase_price ? "$" + args.contact.target_purchase_price : "unknown"}
- FICO band: ${args.contact.fico_band || "unknown"}
- Source: ${args.contact.source || "unknown"}` : `CONTACT: \u26a0\ufe0f UNKNOWN NUMBER \u2014 NO CRM RECORD YET. Capture name + email when natural.`;

  const discoveryBlock = Object.keys(discovery).length
    ? "\n\nDISCOVERY STATE (gathered so far):\n" + JSON.stringify(discovery, null, 2)
    : "\n\nDISCOVERY STATE: empty";
  const historyBlock = args.history.length
    ? "\n\nRECENT TEXT THREAD (oldest first):\n" + args.history.map(h => `[${h.direction === "inbound" ? "THEM" : "YOU"}] ${(h.body || "").substring(0, 180)}`).join("\n")
    : "";
  const apptBlock = args.appointments.length
    ? "\n\nRECENT APPOINTMENTS:\n" + args.appointments.map(a => `- ${a.title} on ${new Date(a.appointment_time).toLocaleDateString()} (${a.status})`).join("\n")
    : "";
  const hoursBlock = in_hours ? "" : `\n\nNOTE: Currently ${hoursNote} (PT). For callback offers, mention "morning around 9am PT".`;
  const bookUrl = args.bookingUrls.booking_url || "https://cal.com/rene-duarte-rates-realty";

  const systemPrompt = `You are Rene Duarte's AI assistant texting borrowers. Rene is a SENIOR mortgage LO + real estate professional at Rates & Realty (NMLS #1795044, Huntington Beach CA, Orange County focus, licensed CA-wide).

SUBJECT MATTER EXPERT IN:
- Residential: conventional, FHA, VA, USDA, jumbo
- Non-QM: bank statement, DSCR (investor), ITIN, asset depletion
- Commercial: 5+ unit multifamily, mixed-use, retail, office, bridge
- Second liens: HELOC, HELOAN
- First-time buyer + CA DPA programs
- Real estate purchase + listing process
- OC/SoCal market
- Rent vs buy analysis
- Refi, cash-out, FHA streamline, VA IRRRL
- Self-employed underwriting, gift funds, reserves, seasoning

${contactBlock}${discoveryBlock}${historyBlock}${apptBlock}${hoursBlock}

IF SUGGESTING A CALL: Use ONLY ${bookUrl}. Never invent any other URL.
For PROPERTY SEARCH LINKS, ALWAYS use the generate_search_link tool \u2014 don't make up URLs. The tool returns a tracked short URL \u2014 use that URL EXACTLY as returned, don't strip or modify it.

=== \ud83d\udcb0 PRICE & NUMBER SLANG \u2014 INTERPRET CAREFULLY \ud83d\udcb0 ===
Borrowers text in casual, abbreviated, slangy language. You MUST translate it into precise whole-dollar integers before calling any tool.

ABBREVIATIONS:
- "k" / "K" = thousand. "$900k" = 900000. "600k" = 600000. "850k" = 850000.
- "m" / "M" / "mil" / "million" = million. "$1.2M" = 1200000. "1.5 mil" = 1500000. "two million" = 2000000.
- "b" / "B" / "bil" = billion (rare for residential, but possible for commercial).
- Bare numbers like "900" or "1200" in a price context almost always mean thousands. "under 900" = 900000. "around 1200" = 1200000.

WORDS:
- "half a mil" / "half a million" / "half mil" = 500000
- "a mill" / "a milli" = 1000000
- "hundred grand" = 100000
- "500 grand" = 500000
- "five hundred thousand" = 500000
- "nine hundred thousand" = 900000
- "under nine hundred thousand" / "under $900k" / "under 900" = max_price 900000
- "between 700 and 900" = min_price 700000, max_price 900000
- "top end is 1.2" / "max 1.2M" = max_price 1200000

INCOME / DEBT (same rules):
- "I make 150k" \u2192 monthly_income 12500 (annual 150000 / 12)
- "180k a year" \u2192 monthly_income 15000
- "clearing 8k a month" \u2192 monthly_income 8000
- "my rent is 3k" \u2192 monthly_rent 3000
- "car payment 600, student loan 400" \u2192 monthly_debts 1000

DOWN PAYMENT:
- "50k down" \u2192 down_payment_amount 50000
- "10% down" \u2192 down_payment_pct 10
- "twenty percent" \u2192 down_payment_pct 20
- "fha minimum" \u2192 down_payment_pct 3.5
- "zero down" / "no money down" \u2192 down_payment_pct 0

FICO:
- "720" / "720s" \u2192 fico 720
- "low 700s" \u2192 fico 710
- "mid 600s" \u2192 fico 650 (band fair_620_679)
- "high 700s" \u2192 fico 780 (band excellent_740_plus)

WHEN A USER SAYS "$900,000" OR "$900k" OR "900k" OR "under nine hundred thousand" \u2014 ALL OF THESE MEAN max_price=900000.
When a user says "send me homes for sale in Garden Grove under $900,000" \u2014 you MUST call generate_search_link with cities=["Garden Grove"], max_price=900000, listing_type="for_sale". Do NOT call it with empty params.

=== \ud83d\udea8 ANTI-HALLUCINATION RULES \u2014 ABSOLUTELY CRITICAL \ud83d\udea8 ===
You MUST NOT invent or estimate numbers. For ANY dollar figure (payment, equity, savings, rent, breakeven, cash-to-close, total interest, future home value, etc.) you MUST call calculate_mortgage and use the EXACT numbers it returns. After calling the tool, READ the JSON output carefully. Quote specific keys. If you don't have enough info to call the calculator, ASK ONE clarifying question first. For rent_vs_buy: you NEED purchase_price AND monthly_rent to call the tool. Reality check: 5-year equity gain is typically 15-30% of purchase price.

=== TOOLS \u2014 USE AGGRESSIVELY ===
- calculate_mortgage \u2014 ANY dollar figure question
- search_guidelines \u2014 specific qualifying questions
- lookup_dpa_programs \u2014 first-time buyer / DPA topics
- list_loan_programs \u2014 "what programs", investor / ITIN / commercial / bank statement
- get_loan_limits \u2014 jumbo cutoffs, max FHA loan questions
- generate_search_link \u2014 ALWAYS when borrower mentions city / price / beds. PASS ALL CRITERIA THEY GAVE YOU.
- recommend_listings \u2014 "show me homes", "what's available"
- capture_contact_info \u2014 SAVE info silently anytime they share name/email/city/price/intent
- save_property_search \u2014 ONLY after name+email AND criteria captured

=== HOME-SHOPPING DISCOVERY FLOW ===
1. First reply: ONE clarifying question. EXCEPTION: if they already gave you city + price (e.g. "Garden Grove under $900k"), SKIP the clarifying question and go straight to generate_search_link with everything they gave you.
2. Once you have city + budget OR city + beds: generate_search_link, send the tracked URL it returns, ask one more refining question
3. Then ask for EMAIL: "Want me to set up a saved search so I can ping you when new ones hit? Just need your name and email."
4. After name+email: capture_contact_info AND save_property_search, confirm: "Locked in. I'll send the latest matches by email."

=== WELCOME / FIRST INBOUND ===
${args.isFirstReply ? `THIS IS THEIR FIRST MESSAGE. After answering, end with ONE smooth capability hint. One line, casual.` : `Not a first reply \u2014 don't repeat capability hints.`}

=== VOICE & RULES ===
- Sound like Rene: warm, direct, knowledgeable, OC-savvy, never pushy
- SMS length: 1-3 short sentences, under 400 chars
- ONE good question per reply if info missing
- ALWAYS sign off with "\u2014 Rene"
- ALWAYS include "Reply STOP to opt out" at the end

RESPOND WITH ONLY THE SMS TEXT. No commentary. No markdown.`;

  const messages: any[] = [{ role: "user", content: args.message_body }];
  let finalText = "";
  let tokensIn = 0, tokensOut = 0;
  const toolsUsed: string[] = [];

  for (let i = 0; i < 6; i++) {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: args.settings.ai_model || "claude-sonnet-4-5",
        max_tokens: 1500, system: systemPrompt, tools: TOOLS, messages,
      }),
    });
    args.phaseLog.push(`ai_iter_${i}_${aiRes.status}`);
    if (!aiRes.ok) {
      const errTxt = await aiRes.text();
      throw new Error(`Anthropic ${aiRes.status}: ${errTxt.substring(0, 200)}`);
    }
    const aiData = await aiRes.json();
    tokensIn += aiData.usage?.input_tokens || 0;
    tokensOut += aiData.usage?.output_tokens || 0;
    const stopReason = aiData.stop_reason;
    const blocks = aiData.content || [];
    if (stopReason === "tool_use") {
      messages.push({ role: "assistant", content: blocks });
      const toolResults: any[] = [];
      for (const block of blocks) {
        if (block.type === "tool_use") {
          toolsUsed.push(block.name);
          args.phaseLog.push(`tool_${block.name}`);
          const result = await executeTool(block.name, block.input, { conversation: args.conversation, phone: args.conversation.phone, baseUrl: args.baseUrl });
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }
    finalText = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").trim();
    break;
  }
  return { text: finalText, toolsUsed, tokensIn, tokensOut };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string, s = 400, extra: any = {}) => new Response(JSON.stringify({ error: m, ...extra }), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method !== "POST") return err("Method not allowed", 405);

  /* GUARD — BEFORE req.json().
   *
   * This function SENDS AN SMS from the business line, under Rene's NMLS. It
   * had no authorization: probed with the public anon key it returned 400
   * "phone and message_body required", so authorization was not what stopped an
   * anonymous caller from texting an arbitrary number in Rene's name.
   *
   * The two internal callers survive unchanged, and were checked before this
   * landed rather than after: bot-process-queue and twilio-inbound both send
   * `Authorization: Bearer ${SERVICE_KEY}`, and requireStaff accepts the service
   * key in either header. There is NO browser caller — the only frontend
   * mention is a comment in admin/js/rr-time.js. So this guard has no
   * frontend-first dependency, which is why it can land in the same commit. */
  const staff = await requireStaff(req, { what: "The SMS bot" });
  if (!staff.ok) {
    console.error("[ai-sms-bot] REJECTED:", staff.status, staff.msg);
    return new Response(JSON.stringify({ error: staff.msg || "unauthorized" }),
      { status: staff.status || 403, headers: { ...cors, "Content-Type": "application/json" } });
  }
  const actorUid = staff.userId || null;
  const actorRole = staff.role || null;

  let phaseLog: string[] = [];
  let conversationId: string | null = null;
  let action = "unknown";
  let decisionReason = "";
  let replyBody = "";
  let replyOk = false;
  let replySid: string | null = null;
  let toolsUsed: string[] = [];
  let aiTokensIn = 0, aiTokensOut = 0;
  let notifyMsg: string | null = null;

  try {
    const body = await req.json();
    const { contact_id, phone, message_body, intent, intent_confidence, sms_log_id, processing_queued = false } = body;
    if (!phone || !message_body) return err("phone and message_body required");
    phaseLog.push("input_ok");

    const settings = await getBotSettings();
    const baseUrl = await getPropertySearchBaseUrl();
    const conversation = await getOrCreateConversation(phone, contact_id || null);
    conversationId = conversation.id;

    const isFirstInbound = !processing_queued && (conversation.total_messages_in || 0) === 0;

    if (!processing_queued) {
      await sb.from("bot_conversations").update({
        total_messages_in: (conversation.total_messages_in || 0) + 1,
        last_inbound_at: new Date().toISOString(),
        last_intent: intent,
        contact_id: contact_id || conversation.contact_id,
      }).eq("id", conversation.id);
    }

    const lowerMsg = (message_body as string).toLowerCase();

    if (!settings.enabled) {
      action = "disabled"; decisionReason = "Bot disabled";
    } else if (conversation.ai_enabled === false || conversation.status === "paused" || conversation.status === "escalated") {
      action = "disabled"; decisionReason = `Conv status: ${conversation.status}`;
    } else if (intent === "opt_out") {
      action = "opt_out_processed"; decisionReason = "STOP";
    } else if (intent === "acknowledgement") {
      action = "no_reply"; decisionReason = "Acknowledgement";
    } else if (!processing_queued && isInQuietHours(settings)) {
      const fireAt = nextQuietEndUTC(settings);
      await sb.from("bot_queued_replies").insert({
        conversation_id: conversation.id, contact_id: conversation.contact_id,
        phone: normalizePhone(phone), inbound_body: message_body,
        inbound_intent: intent || null, inbound_intent_confidence: intent_confidence || null,
        sms_log_id: sms_log_id || null,
        queued_reason: `quiet_hours ${settings.quiet_hours_start}-${settings.quiet_hours_end} PT`,
        scheduled_for: fireAt.toISOString(), status: "pending",
      });
      phaseLog.push(`queued_for_${fireAt.toISOString()}`);
      if (settings.quiet_hours_autoreply_enabled) {
        const lastAutoreply = conversation.last_quiet_hours_autoreply_at ? new Date(conversation.last_quiet_hours_autoreply_at).getTime() : 0;
        const hoursSince = (Date.now() - lastAutoreply) / 3600000;
        const sendOnce = settings.quiet_hours_autoreply_once_per_night;
        if (!sendOnce || hoursSince >= 12) {
          const autoreplyText = settings.quiet_hours_autoreply_text || "Got your message \u2014 Rene's system is offline overnight. I'll have an answer for you first thing in the morning. Reply STOP to opt out.";
          const r = await sendBotReply(phone, autoreplyText, conversation.contact_id, conversation.id, "ai_bot_quiet_autoreply", actorUid, actorRole);
          replyOk = r.ok; replySid = r.sid || null; replyBody = autoreplyText;
          if (r.ok) {
            await sb.from("bot_conversations").update({
              last_quiet_hours_autoreply_at: new Date().toISOString(),
              total_messages_out: (conversation.total_messages_out || 0) + 1,
              last_outbound_at: new Date().toISOString(),
            }).eq("id", conversation.id);
          }
          action = "quiet_hours_autoreply";
          decisionReason = `Autoreply sent + queued for ${fireAt.toISOString()}`;
        } else {
          action = "quiet_hours_queued";
          decisionReason = `Already autoreplied tonight; just queued for ${fireAt.toISOString()}`;
        }
      } else {
        action = "quiet_hours_queued";
        decisionReason = `Queued silently for ${fireAt.toISOString()}`;
      }
    } else {
      const matched = (settings.escalate_on_keywords || []).find((k: string) => lowerMsg.includes(k.toLowerCase()));
      if (matched) {
        action = "escalate"; decisionReason = `Keyword: ${matched}`;
        notifyMsg = `\ud83d\udea8 ESCALATION: ${conversation.phone} mentioned "${matched}". Msg: "${message_body.substring(0, 140)}"`;
      } else if ((conversation.ai_replies_sent || 0) >= settings.escalate_after_messages) {
        action = "escalate"; decisionReason = `${conversation.ai_replies_sent} replies, capping`;
        notifyMsg = `\ud83d\udd17 ${conversation.phone} hit reply cap. Hand off.`;
      } else {
        const rl = await checkRateLimit(phone, settings);
        if (!rl.allowed) {
          action = "rate_limited"; decisionReason = rl.reason || "rate_limited";
        } else {
          phaseLog.push("ai_start");
          const [bookingUrls, contact, history, appointments] = await Promise.all([
            getBookingUrls(),
            getContactContext(contact_id || conversation.contact_id),
            getConversationHistory(phone, 10),
            getRecentAppointments(contact_id || conversation.contact_id),
          ]);
          const isFirstReply = isFirstInbound || (history.filter(h => h.direction === "outbound").length === 0);

          const result = await runAiTurn({
            message_body, intent: intent || "general", intent_confidence: intent_confidence || "low",
            contact, conversation, history, appointments, bookingUrls, baseUrl, settings,
            isFirstReply, phaseLog,
          });
          aiTokensIn = result.tokensIn; aiTokensOut = result.tokensOut;
          toolsUsed = result.toolsUsed;
          let finalText = result.text;

          if (!finalText) {
            action = "no_reply"; decisionReason = "AI returned no text";
          } else {
            if (finalText.length > settings.max_reply_length) {
              finalText = finalText.substring(0, settings.max_reply_length - 30) + "... \u2014 Rene | Reply STOP";
            }
            if (!/STOP/i.test(finalText)) finalText = finalText + "\nReply STOP to opt out.";
            replyBody = finalText;
            action = "ai_reply";
            decisionReason = `${intent} \u2192 AI replied${toolsUsed.length ? " (tools: " + [...new Set(toolsUsed)].join(",") + ")" : ""}`;
            const isHotSignal = intent === "hot_lead" || intent === "scheduling" || toolsUsed.includes("calculate_mortgage") || toolsUsed.includes("recommend_listings") || toolsUsed.includes("save_property_search");
            if (isHotSignal) {
              notifyMsg = `\ud83d\udd25 ${contact?.first_name || phone}: "${message_body.substring(0, 100)}" \u2192 [${[...new Set(toolsUsed)].join(",")}]`;
            }
          }
        }
      }
    }

    if (action === "ai_reply" && replyBody) {
      const r = await sendBotReply(phone, replyBody, conversation.contact_id, conversation.id, "ai_bot_reply", actorUid, actorRole);
      replyOk = r.ok; replySid = r.sid || null;
      if (r.ok) {
        await sb.from("bot_conversations").update({
          ai_replies_sent: (conversation.ai_replies_sent || 0) + 1,
          total_messages_out: (conversation.total_messages_out || 0) + 1,
          last_outbound_at: new Date().toISOString(),
          last_ai_reply_at: new Date().toISOString(),
          welcome_sent_at: isFirstInbound ? new Date().toISOString() : conversation.welcome_sent_at,
        }).eq("id", conversation.id);
      }
    }

    if (action === "escalate") {
      await sb.from("bot_conversations").update({
        status: "escalated", ai_enabled: false, needs_human: true,
        escalation_reason: decisionReason, escalated_at: new Date().toISOString(),
      }).eq("id", conversation.id);
    }

    if (notifyMsg) await notifyRene(notifyMsg);

    await sb.from("bot_decisions").insert({
      conversation_id: conversation.id,
      contact_id: conversation.contact_id,
      inbound_sms_log_id: sms_log_id || null,
      inbound_body: message_body, inbound_intent: intent, inbound_intent_confidence: intent_confidence,
      action, decision_reason: decisionReason,
      reply_body: replyBody || null,
      reply_sent_at: replyOk ? new Date().toISOString() : null,
      ai_model: action === "ai_reply" && replyBody ? settings.ai_model : null,
      ai_tokens_in: aiTokensIn || null, ai_tokens_out: aiTokensOut || null,
      tools_called: [...new Set(toolsUsed)],
      metadata: { reply_ok: replyOk, twilio_sid: replySid, phases: phaseLog, processing_queued },
    });

    return ok({
      success: true, decision: action, reason: decisionReason,
      reply_sent: replyOk, reply_preview: replyBody.substring(0, 300) || null,
      tools_used: [...new Set(toolsUsed)], conversation_id: conversation.id, phases: phaseLog,
    });
  } catch (e: any) {
    console.error("[ai-sms-bot] FATAL:", e?.message || e);
    if (conversationId) {
      await sb.from("bot_decisions").insert({
        conversation_id: conversationId, action: "escalate",
        decision_reason: `Crash: ${e?.message || String(e)}`,
        metadata: { phases: phaseLog, fatal: true },
      }).then(() => {}, () => {});
    }
    return err(e?.message || String(e), 500, { phases: phaseLog });
  }
});

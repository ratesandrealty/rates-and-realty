// lead-scorer v6: lead_score_history.reason now carries the emitter's own
// human-readable sentence when one is supplied.
//
// v5 wrote `reason: trigger === "manual" ? "Manual recalculate" : trigger`, so
// every automatic row read as a bare type name ("video_completed") and the
// readable string video-track had already composed was dropped on the floor.
// trigger_score_recalc() now forwards activity_events.description as `reason`;
// scoreContact takes it through and stores it. Callers that send no reason are
// unchanged.
//
// v5 behaviour retained: total_score is clamped to 0 minimum so leads can't go
// negative. Staleness penalty still applies internally (visible in
// breakdown.staleness.score) but total stored on contacts.lead_score is floored at 0.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireStaff } from "../_shared/require-staff.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

async function getConfig(key: string, fallback: any) {
  const { data } = await sb.from("lead_score_config").select("value").eq("key", key).maybeSingle();
  return data?.value ?? fallback;
}

function pl_has(status: any, terms: string[]) {
  const s = (status || "").toLowerCase();
  return terms.some(t => s.includes(t));
}

function safeJson(s: string) { try { return JSON.parse(s); } catch { return {}; } }

function tierFor(total: number, thresholds: any): string {
  const t = thresholds || { hot: 75, warm: 40, cold: 0 };
  if (total >= t.hot) return "hot";
  if (total >= t.warm) return "warm";
  return "cold";
}

function computeIntentScore(c: any, max = 25): { score: number; reasons: string[] } {
  let pts = 0;
  const reasons: string[] = [];
  const tl = (c.timeline || "").toLowerCase();
  if (tl.includes("now") || tl.includes("asap") || tl.includes("0-30") || tl.includes("ready")) { pts += 12; reasons.push("+12 ready now"); }
  else if (tl.includes("30") || tl.includes("1-3") || tl.includes("1–3")) { pts += 9; reasons.push("+9 within 30-90d"); }
  else if (tl.includes("3-6") || tl.includes("3–6")) { pts += 6; reasons.push("+6 3-6 months"); }
  else if (tl.includes("6") || tl.includes("12")) { pts += 3; reasons.push("+3 6-12 months"); }
  else if (tl) { pts += 1; reasons.push("+1 timeline given"); }
  if (c.property_address || c.property_city) { pts += 5; reasons.push("+5 property in mind"); }
  if (c.purchase_price || c.requested_loan_amount) { pts += 4; reasons.push("+4 target price set"); }
  if (pl_has(c.pipeline_status, ["pre-approved", "approved", "under contract", "processing", "submitted"])) {
    pts += 4; reasons.push("+4 pipeline stage active");
  }
  if (pl_has(c.pipeline_status, ["closed"])) { pts = max; reasons.push("=25 closed deal"); }
  return { score: Math.min(pts, max), reasons };
}

function computeFinancialScore(c: any, max = 25): { score: number; reasons: string[] } {
  let pts = 0;
  const reasons: string[] = [];
  const fico = c.credit_score || 0;
  const band = (c.credit_score_range || "").toLowerCase();
  if (fico >= 740 || band.includes("740") || band.includes("excellent")) { pts += 10; reasons.push("+10 740+ FICO"); }
  else if (fico >= 680 || band.includes("680") || band.includes("good")) { pts += 8; reasons.push("+8 680-739 FICO"); }
  else if (fico >= 620 || band.includes("620") || band.includes("fair")) { pts += 5; reasons.push("+5 620-679 FICO"); }
  else if (fico > 0 || band) { pts += 2; reasons.push("+2 FICO known"); }
  if (c.monthly_income || c.annual_income) { pts += 4; reasons.push("+4 income captured"); }
  if (c.down_payment || c.down_payment_percent) { pts += 4; reasons.push("+4 down payment set"); }
  if (c.linked_application_id) { pts += 7; reasons.push("+7 1003 application started"); }
  else if (pl_has(c.pipeline_status, ["pre-approved", "submitted", "approved", "processing", "under contract", "closed"])) {
    pts += 5; reasons.push("+5 active pipeline stage");
  }
  return { score: Math.min(pts, max), reasons };
}

async function computeEngagementScore(c: any, eventPoints: any, decayDays: number, windowDays: number, max = 20): Promise<{ score: number; reasons: string[]; raw: number; mostRecent?: string }> {
  const reasons: string[] = [];
  let raw = 0;
  let mostRecent: Date | null = null;
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();

  const { data: events } = await sb.from("activity_events")
    .select("type, channel, created_at, metadata")
    .eq("contact_id", c.id)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);

  for (const ev of events || []) {
    let key: any = ev.type;
    if (ev.type === "page_view") {
      const md = typeof ev.metadata === "string" ? safeJson(ev.metadata) : (ev.metadata || {});
      const url = (md?.url || md?.path || "").toLowerCase();
      if (url.includes("listing") || url.includes("home") || url.includes("search-homes")) key = "page_view_listing";
      else if (url.includes("calculator") || url.includes("calc")) key = "page_view_calculator";
      else key = "page_view";
    } else if (ev.type === "sms" && ev.channel === "sms") {
      const md = typeof ev.metadata === "string" ? safeJson(ev.metadata) : (ev.metadata || {});
      key = md?.direction === "inbound" ? "sms_inbound" : null;
    } else if (ev.type === "email") {
      const md = typeof ev.metadata === "string" ? safeJson(ev.metadata) : (ev.metadata || {});
      if (md?.event === "open" || md?.opened) key = "email_open";
      else if (md?.event === "click" || md?.clicked) key = "email_click";
      else key = null;
    }
    if (!key || eventPoints[key] === undefined) continue;
    raw += eventPoints[key];
    const ts = new Date(ev.created_at);
    if (!mostRecent || ts > mostRecent) mostRecent = ts;
  }

  const { count: smsInbound } = await sb.from("sms_log")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", c.id).eq("direction", "inbound")
    .gte("created_at", since);
  if (smsInbound && smsInbound > 0) {
    raw += smsInbound * (eventPoints.sms_inbound || 4);
    reasons.push(`+${smsInbound * (eventPoints.sms_inbound || 4)} for ${smsInbound} SMS replies`);
  }

  if (typeof c.email_opens === "number" && c.email_opens > 0) {
    const pts = Math.min(c.email_opens, 10) * (eventPoints.email_open || 1);
    raw += pts; reasons.push(`+${pts} for ${c.email_opens} email opens`);
  }
  if (typeof c.email_clicks === "number" && c.email_clicks > 0) {
    const pts = Math.min(c.email_clicks, 5) * (eventPoints.email_click || 3);
    raw += pts; reasons.push(`+${pts} for ${c.email_clicks} email clicks`);
  }
  if (typeof c.calls_answered === "number" && c.calls_answered > 0) {
    const pts = Math.min(c.calls_answered, 5) * (eventPoints.call_answered || 6);
    raw += pts; reasons.push(`+${pts} for ${c.calls_answered} calls answered`);
  }
  if (typeof c.calls_missed === "number" && c.calls_missed > 0) {
    const pts = Math.min(c.calls_missed, 5) * (eventPoints.call_missed || -1);
    raw += pts; reasons.push(`${pts} for ${c.calls_missed} missed calls`);
  }
  if (c.appointment_set) {
    raw += eventPoints.appointment_set || 10;
    reasons.push(`+${eventPoints.appointment_set || 10} appointment booked`);
  }

  raw = Math.min(raw, max * 1.5);
  let score = raw;
  if (mostRecent) {
    const daysIdle = (Date.now() - mostRecent.getTime()) / 86400000;
    if (daysIdle > decayDays) {
      const halflives = (daysIdle - decayDays) / decayDays;
      score = raw * Math.pow(0.5, halflives);
      reasons.push(`Decay applied: idle ${Math.round(daysIdle)}d`);
    }
  }
  return { score: Math.round(Math.min(score, max)), reasons, raw: Math.round(raw), mostRecent: mostRecent?.toISOString() };
}

function computePropertyScore(c: any, max = 15): { score: number; reasons: string[] } {
  let pts = 0;
  const reasons: string[] = [];
  if (c.property_address) { pts += 8; reasons.push("+8 specific property"); }
  else if (c.property_city) { pts += 4; reasons.push("+4 target city"); }
  if (c.property_value || c.purchase_price) { pts += 3; reasons.push("+3 price set"); }
  if (c.property_type) { pts += 2; reasons.push("+2 property type set"); }
  if (c.occupancy_type) { pts += 2; reasons.push("+2 occupancy set"); }
  if (pl_has(c.pipeline_status, ["under contract", "closed"])) { pts = max; reasons.push("=15 under contract / closed"); }
  return { score: Math.min(pts, max), reasons };
}

function computeSourceScore(c: any, sourceMap: any, max = 10): { score: number; reasons: string[] } {
  const src = c.source || c.lead_source || "";
  if (sourceMap[src] !== undefined) {
    return { score: Math.min(sourceMap[src], max), reasons: [`+${sourceMap[src]} source: ${src}`] };
  }
  if (c.referred_by || c.referred_by_contact_id) return { score: max, reasons: [`+${max} has referrer—treated as referral`] };
  if (c.utm_source) {
    const u = c.utm_source.toLowerCase();
    if (u.includes("google") || u.includes("facebook")) return { score: 6, reasons: [`+6 paid ad (${c.utm_source})`] };
    if (u.includes("organic")) return { score: 8, reasons: ["+8 organic"] };
  }
  return { score: 3, reasons: ["+3 default unknown source"] };
}

async function computeResponsivenessScore(c: any, max = 5): Promise<{ score: number; reasons: string[] }> {
  const reasons: string[] = [];
  let pts = 0;
  if (typeof c.response_rate === "number" && c.response_rate > 0) {
    pts += Math.min(Math.round(c.response_rate * max), max);
    reasons.push(`+${pts} response rate ${(c.response_rate * 100).toFixed(0)}%`);
  } else {
    const { count: outbound } = await sb.from("sms_log").select("id", { count: "exact", head: true }).eq("contact_id", c.id).eq("direction", "outbound");
    const { count: inbound } = await sb.from("sms_log").select("id", { count: "exact", head: true }).eq("contact_id", c.id).eq("direction", "inbound");
    if (outbound && outbound > 0) {
      const rate = (inbound || 0) / outbound;
      pts = Math.min(Math.round(rate * max), max);
      reasons.push(`+${pts} reply rate ${Math.round(rate * 100)}% (${inbound}/${outbound})`);
    } else if (inbound && inbound > 0) {
      pts = Math.round(max * 0.6);
      reasons.push(`+${pts} no outbound yet, ${inbound} inbound`);
    }
  }
  return { score: Math.min(pts, max), reasons };
}

async function computeStalenessPenalty(
  contactId: string,
  signals: string[],
  thresholds: { d30?: number; d60?: number; d90?: number; d180?: number }
): Promise<{ penalty: number; reasons: string[]; lastMeaningfulAt: string | null }> {
  const reasons: string[] = [];
  if (!Array.isArray(signals) || signals.length === 0) {
    return { penalty: 0, reasons: ["staleness signals not configured"], lastMeaningfulAt: null };
  }

  const { data, error } = await sb.from("activity_events")
    .select("type, created_at")
    .eq("contact_id", contactId)
    .in("type", signals)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    reasons.push(`staleness lookup error: ${error.message}`);
    return { penalty: 0, reasons, lastMeaningfulAt: null };
  }

  if (!data || !data.created_at) {
    const deepest = thresholds.d180 ?? thresholds.d90 ?? thresholds.d60 ?? thresholds.d30 ?? 0;
    if (deepest < 0) reasons.push(`${deepest} no meaningful activity recorded`);
    return { penalty: deepest, reasons, lastMeaningfulAt: null };
  }

  const lastTs = new Date(data.created_at);
  const daysIdle = (Date.now() - lastTs.getTime()) / 86400000;

  let penalty = 0;
  if (daysIdle >= 180 && thresholds.d180 !== undefined) penalty = thresholds.d180;
  else if (daysIdle >= 90 && thresholds.d90 !== undefined) penalty = thresholds.d90;
  else if (daysIdle >= 60 && thresholds.d60 !== undefined) penalty = thresholds.d60;
  else if (daysIdle >= 30 && thresholds.d30 !== undefined) penalty = thresholds.d30;

  if (penalty < 0) {
    reasons.push(`${penalty} idle ${Math.round(daysIdle)}d since last meaningful activity (${data.type})`);
  } else {
    reasons.push(`active: last meaningful activity ${Math.round(daysIdle)}d ago (${data.type})`);
  }

  return { penalty, reasons, lastMeaningfulAt: lastTs.toISOString() };
}

async function scoreContact(contactId: string, trigger = "manual", reason?: string | null): Promise<any> {
  const { data: c, error } = await sb.from("contacts").select("*").eq("id", contactId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!c) throw new Error(`Contact ${contactId} not found`);

  const [weights, eventPoints, sourceMap, decayDays, windowDays, thresholds, stalenessThresholds, stalenessSignals] = await Promise.all([
    getConfig("weights", { intent: 25, financial: 25, engagement: 20, property: 15, source: 10, responsiveness: 5 }),
    getConfig("engagement_events", {}),
    getConfig("source_scores", {}),
    getConfig("engagement_decay_days", 14),
    getConfig("engagement_window_days", 90),
    getConfig("tier_thresholds", { hot: 75, warm: 40, cold: 0 }),
    getConfig("staleness_thresholds", { d30: -3, d60: -6, d90: -10, d180: -15 }),
    getConfig("staleness_signals", []),
  ]);

  const intent = computeIntentScore(c, weights.intent);
  const financial = computeFinancialScore(c, weights.financial);
  const engagement = await computeEngagementScore(c, eventPoints, Number(decayDays) || 14, Number(windowDays) || 90, weights.engagement);
  const property = computePropertyScore(c, weights.property);
  const source = computeSourceScore(c, sourceMap, weights.source);
  const responsiveness = await computeResponsivenessScore(c, weights.responsiveness);
  const staleness = await computeStalenessPenalty(c.id, stalenessSignals, stalenessThresholds);

  const subtotal = intent.score + financial.score + engagement.score + property.score + source.score + responsiveness.score;
  // v5: clamp to 0 minimum. The staleness penalty is still tracked in the breakdown for visibility,
  // but the persisted lead_score never goes negative.
  const total = Math.max(0, subtotal + staleness.penalty);
  const tier = tierFor(total, thresholds);
  const previous = c.total_score || c.lead_score || 0;
  const delta = total - previous;

  await sb.from("contacts").update({
    intent_score: intent.score,
    financial_score: financial.score,
    engagement_score: engagement.score,
    property_score: property.score,
    source_score: source.score,
    responsiveness_score: responsiveness.score,
    staleness_penalty: staleness.penalty,
    last_meaningful_activity_at: staleness.lastMeaningfulAt,
    total_score: total,
    lead_score: total,
    score_tier: tier,
    last_scored_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", contactId);

  /* v6: prefer the caller's sentence. trigger_score_recalc() passes
   * activity_events.description, which for video reads e.g.
   *   watched "Rate update" to 100% (1st view)
   * Falling back to the trigger name keeps every existing caller unchanged. */
  const historyReason = (typeof reason === "string" && reason.trim())
    ? reason.trim().slice(0, 500)
    : (trigger === "manual" ? "Manual recalculate" : trigger);

  await sb.from("lead_score_history").insert({
    contact_id: contactId,
    total_score: total,
    intent_score: intent.score, financial_score: financial.score,
    engagement_score: engagement.score, property_score: property.score,
    source_score: source.score, responsiveness_score: responsiveness.score,
    trigger, delta,
    reason: historyReason,
  });

  return {
    contact_id: contactId, total, tier, delta, reason: historyReason,
    breakdown: {
      intent: { ...intent, max: weights.intent },
      financial: { ...financial, max: weights.financial },
      engagement: { ...engagement, max: weights.engagement },
      property: { ...property, max: weights.property },
      source: { ...source, max: weights.source },
      responsiveness: { ...responsiveness, max: weights.responsiveness },
      staleness: { score: staleness.penalty, reasons: staleness.reasons, max: 0, last_meaningful_at: staleness.lastMeaningfulAt },
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

  /* STAFF OR SERVICE ONLY, BEFORE req.json(). Added 2026-08-19.
   *
   * This authenticated nothing while reading contacts, activity_events and
   * sms_log and writing activity_events and lead_score_history with the service
   * role. Measured open: an anonymous POST reached the dispatcher.
   *
   * STAFF_ROLES rather than admin-only, deliberately and unlike bot-admin. Its
   * browser callers live on admin/lead-detail.html, which is a shared staff page
   * — a va working a lead records score events and reads the panel — so
   * narrowing to admin here would take a working surface away from her to close
   * an endpoint. bot-admin went the other way because ITS only page is gated to
   * one email. Match the guard to the page, in both directions.
   *
   * FOUR INTERNAL CALLERS all send the service key, which requireStaff accepts
   * from either header: generate-preapproval, tour-public-view, tours-admin and
   * track-event.
   *
   * FRONTEND FIRST: both browser call sites in lead-detail sent the anon key —
   * the deal-analysis record_event and scorerApi — and were moved to fnFetch and
   * deployed on their own before this landed. Confirmed against a live session
   * by the render-check spec "lead-scorer panel calls scorerApi as the user",
   * which drives the PAGE'S OWN function rather than the helper. */
  const auth = await requireStaff(req, { what: 'Lead scoring' });
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.msg }), {
      status: auth.status || 401, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const action = (body.action || "").toLowerCase();

    if (action === "score_contact") {
      if (!body.contact_id) return err("contact_id required");
      const result = await scoreContact(body.contact_id, body.trigger || "manual", body.reason);
      return ok({ success: true, ...result });
    }
    if (action === "get_breakdown") {
      if (!body.contact_id) return err("contact_id required");
      const fresh = await scoreContact(body.contact_id, body.trigger || "view", body.reason);
      const { data: history } = await sb.from("lead_score_history")
        .select("total_score, scored_at, trigger, delta, reason")
        .eq("contact_id", body.contact_id)
        .order("scored_at", { ascending: false }).limit(30);
      return ok({ success: true, ...fresh, history: (history || []).reverse() });
    }
    if (action === "score_all") {
      /* READ FILTER: score_all had NO predicate, so every merged-away duplicate
         was re-scored and re-written on every run. */

      /* ORDER, added 2026-08-11 — the fix that actually matters.
         There was no ORDER BY, so PostgREST returned rows in whatever order
         Postgres supplied and each run scored an arbitrary subset. Contacts
         missed by one run were not preferred by the next, so a contact could go
         unscored indefinitely: 243 of 1043 had NEVER been scored, and the oldest
         surviving score was from 2026-06-15.

         Stalest first, never-scored before everything, turns that into a
         rotation with bounded staleness. */

      /* LIMIT, sized from measurement rather than taste. A run with limit 5000
         was killed by the edge runtime at 89s having scored 339:
           546 WORKER_RESOURCE_LIMIT — "not having enough compute resources"
         Throughput was flat at ~3.7/sec throughout, so it did not slow down, it
         hit a ceiling. 200 is ~59% of that observed ceiling. The headroom is
         deliberate and it is not padding: per-contact cost varies with how many
         activity_events, sms_log and history rows a contact has, so 339 is one
         sample of a moving number, and a batch that is killed writes no response
         at all. 200 that returns 200-OK beats 320 that sometimes returns 546.

         CLAMPED, not defaulted. The cron job body says limit 5000; a default
         would leave that untouched and the job would go on dying. The clamp
         binds every caller, including ones added later. */
      const MAX_BATCH = 200;
      const batch = Math.max(1, Math.min(Number(body.limit) || MAX_BATCH, MAX_BATCH));

      const { data: ids } = await sb.from("contacts").select("id")
        .is("merged_into_contact_id", null)
        .order("last_scored_at", { ascending: true, nullsFirst: true })
        .limit(batch);
      const results = [];
      for (const row of ids || []) {
        try {
          const r = await scoreContact(row.id, "nightly_batch");
          results.push({ id: row.id, total: r.total, tier: r.tier, delta: r.delta });
        } catch (e: any) { results.push({ id: row.id, error: e?.message || String(e) }); }
      }
      /* Report coverage, not just work done. `scored` alone reads like success
         while most of the book goes untouched — which is how this stayed
         invisible. requested_limit surfaces the clamp instead of silently
         ignoring what the caller asked for. */
      const { count: liveTotal } = await sb.from("contacts")
        .select("id", { count: "exact", head: true }).is("merged_into_contact_id", null);
      const { count: neverScored } = await sb.from("contacts")
        .select("id", { count: "exact", head: true })
        .is("merged_into_contact_id", null).is("last_scored_at", null);
      return ok({
        success: true, scored: results.length, batch_size: batch,
        requested_limit: body.limit ?? null,
        live_contacts: liveTotal ?? null, never_scored_remaining: neverScored ?? null,
        errors: results.filter((r: any) => r.error).length,
        sample: results.slice(0, 10),
      });
    }
    if (action === "recalculate_visible") {
      if (!Array.isArray(body.contact_ids)) return err("contact_ids array required");
      const results = [];
      for (const id of body.contact_ids.slice(0, 100)) {
        try { const r = await scoreContact(id, "bulk_recalc"); results.push({ id, total: r.total, tier: r.tier }); }
        catch (e: any) { results.push({ id, error: e?.message || String(e) }); }
      }
      return ok({ success: true, scored: results.length, results });
    }
    if (action === "record_event") {
      const { contact_id, event_type, metadata } = body;
      if (!contact_id || !event_type) return err("contact_id and event_type required");
      await sb.from("activity_events").insert({
        contact_id, type: event_type, channel: metadata?.channel || "system",
        title: metadata?.title || event_type, metadata: metadata || {},
        created_at: new Date().toISOString(),
      });
      const r = await scoreContact(contact_id, event_type, body.reason);
      return ok({ success: true, total: r.total, tier: r.tier, delta: r.delta });
    }
    if (action === "get_config") {
      const { data } = await sb.from("lead_score_config").select("*");
      return ok({ success: true, config: data || [] });
    }
    if (action === "update_config") {
      if (!body.key || body.value === undefined) return err("key and value required");
      await sb.from("lead_score_config").upsert({
        key: body.key, value: body.value, description: body.description, updated_at: new Date().toISOString(),
      });
      return ok({ success: true });
    }
    return err(`Unknown action: ${action}`);
  } catch (e: any) {
    console.error("[lead-scorer] error:", e);
    return err(e?.message || String(e), 500);
  }
});

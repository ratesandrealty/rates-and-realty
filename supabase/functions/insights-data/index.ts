// insights-data v1 — unified BI endpoint for Rates & Realty CRM
// Replaces /reports.html and /analytics.html with a single comprehensive data source.
//
// Routes:
//   GET /insights-data?report=overview      — top KPI strip (revenue, pipeline, tours, activity)
//   GET /insights-data?report=money         — revenue MTD/YTD, pipeline $, lost deals
//   GET /insights-data?report=funnel        — lead source ROI, conversion, score correlation
//   GET /insights-data?report=real_estate   — tour stats, top properties, conversion
//   GET /insights-data?report=marketing     — email/sms perf, page views, UTM
//   GET /insights-data?report=activity      — calls/texts/tours/follow-ups by week
//
// Optional ?range=30d|90d|ytd|all  (default 90d for most reports)
//
// Response shape (consistent across all reports):
// { kpis: [{label, value, sub, trend?}], series: [{name, title, type, data}], tables: [{name, title, rows, columns}] }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function j(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "private, max-age=120" },
  });
}

function startOfMonth(d = new Date()): string {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}
function startOfYear(d = new Date()): string {
  return new Date(d.getFullYear(), 0, 1).toISOString();
}
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}
function rangeToSince(r: string | null): string {
  if (r === "30d") return daysAgo(30);
  if (r === "90d") return daysAgo(90);
  if (r === "ytd") return startOfYear();
  if (r === "all") return new Date(0).toISOString();
  return daysAgo(90);
}

// ============ OVERVIEW ============
async function reportOverview() {
  const d30 = daysAgo(30);
  const d7 = daysAgo(7);

  const [contactsTotal, contactsNew30, contactsNew7, pipelineCount, closedDeals, lostDeals, showingBatches30, confirmedTours, apps, emails30, sms30, hotLeads] = await Promise.all([
    sb.from("contacts").select("id", { count: "exact", head: true }),
    sb.from("contacts").select("id", { count: "exact", head: true }).gte("created_at", d30),
    sb.from("contacts").select("id", { count: "exact", head: true }).gte("created_at", d7),
    sb.from("contacts").select("id", { count: "exact", head: true }).in("pipeline_status", ["New","Contacted","Qualified","Nurturing","Touring","PreApp","Application","Processing","CTC"]),
    sb.from("closed_deals").select("loan_amount, commission_earned").eq("outcome", "won"),
    sb.from("closed_deals").select("loan_amount").eq("outcome", "lost"),
    sb.from("showing_batches").select("id", { count: "exact", head: true }).gte("created_at", d30),
    sb.from("showing_batches").select("id", { count: "exact", head: true }).eq("status", "confirmed"),
    sb.from("mortgage_applications").select("id", { count: "exact", head: true }),
    sb.from("email_log").select("id", { count: "exact", head: true }).gte("created_at", d30),
    sb.from("sms_log").select("id", { count: "exact", head: true }).gte("created_at", d30),
    sb.from("contacts").select("id", { count: "exact", head: true }).eq("lead_temperature", "Hot"),
  ]);

  const totalCommission = (closedDeals.data || []).reduce((s, r: any) => s + Number(r.commission_earned || 0), 0);
  const totalLoanVolume = (closedDeals.data || []).reduce((s, r: any) => s + Number(r.loan_amount || 0), 0);
  const lostVolume = (lostDeals.data || []).reduce((s, r: any) => s + Number(r.loan_amount || 0), 0);

  return {
    kpis: [
      { label: "Total Commission", value: `$${totalCommission.toLocaleString("en-US",{maximumFractionDigits:0})}`, sub: `Loan vol: $${(totalLoanVolume/1_000_000).toFixed(2)}M`, accent: "gold" },
      { label: "Contacts", value: contactsTotal.count || 0, sub: `+${contactsNew30.count || 0} (30d) · +${contactsNew7.count || 0} (7d)` },
      { label: "In Pipeline", value: pipelineCount.count || 0, sub: `${hotLeads.count || 0} hot leads`, accent: "green" },
      { label: "Tours (30d)", value: showingBatches30.count || 0, sub: `${confirmedTours.count || 0} confirmed total` },
      { label: "Apps", value: apps.count || 0, sub: "All-time" },
      { label: "Touch (30d)", value: (emails30.count || 0) + (sms30.count || 0), sub: `${emails30.count || 0}✉ · ${sms30.count || 0}💬` },
      { label: "Closed Deals", value: (closedDeals.data || []).length, sub: `Lost: ${(lostDeals.data || []).length}` },
      { label: "Money Left on Table", value: `$${lostVolume.toLocaleString()}`, sub: "Lost deal volume", accent: "red" },
    ],
    series: [],
    tables: [],
  };
}

// ============ MONEY ============
async function reportMoney(range: string | null) {
  const since = rangeToSince(range);
  const mtd = startOfMonth();
  const ytd = startOfYear();

  const [wonAll, wonMtd, wonYtd, wonBy12mo, lostByReason, pipelineByStage] = await Promise.all([
    sb.from("closed_deals").select("loan_amount, commission_earned, close_date, loan_type").eq("outcome", "won"),
    sb.from("closed_deals").select("commission_earned").eq("outcome", "won").gte("close_date", mtd),
    sb.from("closed_deals").select("commission_earned").eq("outcome", "won").gte("close_date", ytd),
    sb.from("closed_deals").select("close_date, commission_earned, loan_amount").eq("outcome", "won").gte("close_date", daysAgo(365)),
    sb.from("closed_deals").select("lost_reason, loan_amount").eq("outcome", "lost").not("lost_reason", "is", null),
    sb.from("contacts").select("pipeline_status, requested_loan_amount, loan_amount").not("pipeline_status", "is", null),
  ]);

  const sum = (rows: any[], field: string) => (rows || []).reduce((s, r) => s + Number(r[field] || 0), 0);
  const mtdRev = sum(wonMtd.data || [], "commission_earned");
  const ytdRev = sum(wonYtd.data || [], "commission_earned");
  const allRev = sum(wonAll.data || [], "commission_earned");
  const allVol = sum(wonAll.data || [], "loan_amount");
  const cnt = (wonAll.data || []).length;
  const avgLoan = cnt > 0 ? allVol / cnt : 0;
  const avgCommish = cnt > 0 ? allRev / cnt : 0;
  const avgPct = allVol > 0 ? (allRev / allVol) * 100 : 0;

  // Monthly commission series for chart (last 12 mo)
  const monthlyMap: Record<string, number> = {};
  // Pre-fill 12 months with zero
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthlyMap[key] = 0;
  }
  (wonBy12mo.data || []).forEach((r: any) => {
    if (!r.close_date) return;
    const key = r.close_date.substring(0, 7);
    if (key in monthlyMap) monthlyMap[key] += Number(r.commission_earned || 0);
  });
  const monthlySeries = Object.entries(monthlyMap).map(([month, value]) => ({ label: month, value }));

  // Lost reasons table
  const lostAgg: Record<string, { count: number; volume: number }> = {};
  (lostByReason.data || []).forEach((r: any) => {
    const key = r.lost_reason || "Unknown";
    if (!lostAgg[key]) lostAgg[key] = { count: 0, volume: 0 };
    lostAgg[key].count++;
    lostAgg[key].volume += Number(r.loan_amount || 0);
  });
  const lostTable = Object.entries(lostAgg).sort((a, b) => b[1].volume - a[1].volume).map(([reason, s]) => ({ reason, count: s.count, volume: `$${s.volume.toLocaleString()}` }));

  // Pipeline $ by stage
  const pipelineAgg: Record<string, { count: number; volume: number }> = {};
  (pipelineByStage.data || []).forEach((r: any) => {
    const key = r.pipeline_status || "Unknown";
    if (!pipelineAgg[key]) pipelineAgg[key] = { count: 0, volume: 0 };
    pipelineAgg[key].count++;
    pipelineAgg[key].volume += Number(r.requested_loan_amount || r.loan_amount || 0);
  });
  const stageOrder = ["New","Contacted","Qualified","Nurturing","Touring","PreApp","Application","Processing","CTC","Closed","Lost"];
  const pipelineTable = stageOrder.filter(s => pipelineAgg[s]).map(stage => ({ stage, count: pipelineAgg[stage].count, volume: `$${pipelineAgg[stage].volume.toLocaleString()}` }));
  Object.keys(pipelineAgg).filter(k => !stageOrder.includes(k)).forEach(stage => {
    pipelineTable.push({ stage, count: pipelineAgg[stage].count, volume: `$${pipelineAgg[stage].volume.toLocaleString()}` });
  });

  return {
    kpis: [
      { label: "Revenue MTD", value: `$${mtdRev.toLocaleString()}`, sub: "This month", accent: "gold" },
      { label: "Revenue YTD", value: `$${ytdRev.toLocaleString()}`, sub: "Year-to-date", accent: "gold" },
      { label: "All-time Revenue", value: `$${allRev.toLocaleString()}`, sub: `${cnt} deals` },
      { label: "Avg Loan Size", value: `$${Math.round(avgLoan).toLocaleString()}`, sub: `Avg commish: $${Math.round(avgCommish).toLocaleString()}` },
      { label: "Avg Commission %", value: `${avgPct.toFixed(2)}%`, sub: "Of loan volume" },
      { label: "Pipeline Volume", value: `$${(pipelineTable.reduce((s, r) => s + Number(String(r.volume).replace(/[^0-9]/g, "")), 0) / 1_000_000).toFixed(2)}M`, sub: `${pipelineTable.reduce((s, r) => s + r.count, 0)} active leads` },
    ],
    series: [
      { name: "commission_by_month", title: "Commission Earned (Last 12 Months)", type: "bar", data: monthlySeries, format: "currency" },
    ],
    tables: [
      { name: "pipeline_by_stage", title: "Pipeline $ by Stage", rows: pipelineTable, columns: ["stage","count","volume"] },
      { name: "lost_deals", title: "Lost Deals — Money Left on Table", rows: lostTable, columns: ["reason","count","volume"] },
    ],
  };
}

// ============ FUNNEL ============
async function reportFunnel(range: string | null) {
  const since = rangeToSince(range);
  const [allContacts, leadSources, temperatures, scoreVsClosed] = await Promise.all([
    sb.from("contacts").select("pipeline_status, lead_source, source, lead_temperature, total_score, created_at, deal_outcome").gte("created_at", since),
    sb.from("contacts").select("lead_source, source, deal_outcome"),
    sb.from("contacts").select("lead_temperature").not("lead_temperature", "is", null),
    sb.from("contacts").select("total_score, deal_outcome").not("total_score", "is", null),
  ]);

  const stageOrder = ["New","Contacted","Qualified","Nurturing","Touring","PreApp","Application","Processing","Closed"];
  const funnelCounts: Record<string, number> = {};
  stageOrder.forEach(s => funnelCounts[s] = 0);
  (allContacts.data || []).forEach((c: any) => {
    const stage = c.pipeline_status || "New";
    if (funnelCounts[stage] !== undefined) funnelCounts[stage]++;
  });
  const funnelSeries = stageOrder.map(stage => ({ label: stage, value: funnelCounts[stage] }));

  const sourceAgg: Record<string, { total: number; won: number; lost: number }> = {};
  (leadSources.data || []).forEach((c: any) => {
    const key = c.lead_source || c.source || "Unknown";
    if (!sourceAgg[key]) sourceAgg[key] = { total: 0, won: 0, lost: 0 };
    sourceAgg[key].total++;
    if (c.deal_outcome === "won") sourceAgg[key].won++;
    if (c.deal_outcome === "lost") sourceAgg[key].lost++;
  });
  const sourceTable = Object.entries(sourceAgg).sort((a, b) => b[1].total - a[1].total).map(([source, s]) => ({
    source, total: s.total, won: s.won, lost: s.lost,
    conversion: s.total > 0 ? ((s.won / s.total) * 100).toFixed(1) + "%" : "0%",
  }));

  const tempAgg: Record<string, number> = {};
  (temperatures.data || []).forEach((c: any) => {
    const key = c.lead_temperature || "Cold";
    tempAgg[key] = (tempAgg[key] || 0) + 1;
  });
  const tempSeries = ["Hot","Warm","Cool","Cold"].map(t => ({ label: t, value: tempAgg[t] || 0 }));

  const scoreBuckets: Record<string, { total: number; won: number }> = { "0-25": { total: 0, won: 0 }, "26-50": { total: 0, won: 0 }, "51-75": { total: 0, won: 0 }, "76-100": { total: 0, won: 0 } };
  (scoreVsClosed.data || []).forEach((c: any) => {
    const s = Number(c.total_score || 0);
    let bucket: string;
    if (s <= 25) bucket = "0-25"; else if (s <= 50) bucket = "26-50"; else if (s <= 75) bucket = "51-75"; else bucket = "76-100";
    scoreBuckets[bucket].total++;
    if (c.deal_outcome === "won") scoreBuckets[bucket].won++;
  });
  const scoreTable = Object.entries(scoreBuckets).map(([range, s]) => ({
    score_range: range, total: s.total, won: s.won,
    conversion: s.total > 0 ? ((s.won / s.total) * 100).toFixed(1) + "%" : "—",
  }));

  return {
    kpis: [
      { label: `New Leads (${range || "90d"})`, value: (allContacts.data || []).length, sub: "In selected range" },
      { label: "Top Source", value: sourceTable[0]?.source || "—", sub: sourceTable[0] ? `${sourceTable[0].conversion} conv` : "" },
      { label: "Hot Leads", value: tempAgg["Hot"] || 0, sub: `Warm: ${tempAgg["Warm"] || 0} · Cold: ${tempAgg["Cold"] || 0}`, accent: "red" },
      { label: "Funnel Conversion", value: (allContacts.data || []).length > 0 ? `${((funnelCounts["Closed"] / (allContacts.data || []).length) * 100).toFixed(1)}%` : "—", sub: "Lead → Closed" },
    ],
    series: [
      { name: "funnel", title: "Pipeline Funnel", type: "bar", data: funnelSeries },
      { name: "temperature", title: "Lead Temperature", type: "bar", data: tempSeries },
    ],
    tables: [
      { name: "sources", title: "Lead Source ROI", rows: sourceTable, columns: ["source","total","won","lost","conversion"] },
      { name: "score", title: "Lead Score → Closing Correlation", rows: scoreTable, columns: ["score_range","total","won","conversion"] },
    ],
  };
}

// ============ REAL ESTATE ============
async function reportRealEstate(range: string | null) {
  const since = rangeToSince(range);
  const [batches, allShowings] = await Promise.all([
    sb.from("showing_batches").select("status, view_count, created_at").gte("created_at", since),
    sb.from("showings").select("property_address, property_city, property_price, mls_number, lead_rating, batch_id").is("deleted_at", null),
  ]);

  const statusAgg: Record<string, number> = {};
  (batches.data || []).forEach((b: any) => { statusAgg[b.status || "draft"] = (statusAgg[b.status || "draft"] || 0) + 1; });
  const sent = (statusAgg["sent"] || 0) + (statusAgg["confirmed"] || 0) + (statusAgg["completed"] || 0) + (statusAgg["in_progress"] || 0);
  const confirmed = (statusAgg["confirmed"] || 0) + (statusAgg["completed"] || 0) + (statusAgg["in_progress"] || 0);
  const completed = statusAgg["completed"] || 0;
  const canceled = statusAgg["canceled"] || 0;
  const tourFunnel = [
    { label: "Created", value: (batches.data || []).length },
    { label: "Sent", value: sent },
    { label: "Confirmed", value: confirmed },
    { label: "Completed", value: completed },
    { label: "Canceled", value: canceled },
  ];

  const stopsPerTour: Record<string, number> = {};
  (allShowings.data || []).forEach((s: any) => { if (s.batch_id) stopsPerTour[s.batch_id] = (stopsPerTour[s.batch_id] || 0) + 1; });
  const stopCounts = Object.values(stopsPerTour);
  const avgStops = stopCounts.length > 0 ? stopCounts.reduce((s, n) => s + n, 0) / stopCounts.length : 0;

  const propAgg: Record<string, { count: number; address: string; city: string; price: number; ratings: number[] }> = {};
  (allShowings.data || []).forEach((s: any) => {
    const key = s.mls_number || s.property_address;
    if (!key) return;
    if (!propAgg[key]) propAgg[key] = { count: 0, address: s.property_address, city: s.property_city, price: s.property_price, ratings: [] };
    propAgg[key].count++;
    if (s.lead_rating) propAgg[key].ratings.push(s.lead_rating);
  });
  const topProperties = Object.values(propAgg).sort((a, b) => b.count - a.count).slice(0, 10).map(p => ({
    address: p.address || "—",
    city: p.city || "—",
    price: p.price ? `$${Number(p.price).toLocaleString()}` : "—",
    tours: p.count,
    avg_rating: p.ratings.length > 0 ? (p.ratings.reduce((s, n) => s + n, 0) / p.ratings.length).toFixed(1) + "⭐" : "—",
  }));

  return {
    kpis: [
      { label: "Tours Created", value: (batches.data || []).length, sub: `${sent} sent to leads` },
      { label: "Confirmation Rate", value: sent > 0 ? `${((confirmed/sent)*100).toFixed(1)}%` : "0%", sub: `${confirmed} of ${sent}`, accent: "green" },
      { label: "Cancel Rate", value: sent > 0 ? `${((canceled/sent)*100).toFixed(1)}%` : "0%", sub: `${canceled} canceled`, accent: "red" },
      { label: "Avg Stops/Tour", value: avgStops.toFixed(1), sub: `${stopCounts.length} tours analyzed` },
      { label: "Total Showings", value: (allShowings.data || []).length, sub: "All-time" },
      { label: "Completed", value: completed, sub: `${completed > 0 && sent > 0 ? ((completed/sent)*100).toFixed(0) + "%" : ""} completion` },
    ],
    series: [
      { name: "tour_funnel", title: "Tour Funnel", type: "bar", data: tourFunnel },
    ],
    tables: [
      { name: "top_properties", title: "Most-Toured Properties", rows: topProperties, columns: ["address","city","price","tours","avg_rating"] },
    ],
  };
}

// ============ MARKETING ============
async function reportMarketing(range: string | null) {
  const since = rangeToSince(range);
  const [emails, sms, pageViews, utmStats] = await Promise.all([
    sb.from("email_log").select("direction, opened_at, sent_at, open_count, click_count, template, created_at").gte("created_at", since),
    sb.from("sms_log").select("direction, status, trigger_type, created_at").gte("created_at", since),
    sb.from("page_views").select("page_url, page_title, created_at").gte("created_at", since),
    sb.from("contacts").select("utm_source, utm_medium, utm_campaign, deal_outcome").not("utm_source", "is", null),
  ]);

  const emailsSent = (emails.data || []).filter((e: any) => e.direction === "outbound" || !e.direction).length;
  const emailsOpened = (emails.data || []).filter((e: any) => e.opened_at || (e.open_count && e.open_count > 0)).length;
  const emailsClicked = (emails.data || []).filter((e: any) => e.click_count && e.click_count > 0).length;
  const openRate = emailsSent > 0 ? ((emailsOpened/emailsSent)*100).toFixed(1) : "0";
  const clickRate = emailsSent > 0 ? ((emailsClicked/emailsSent)*100).toFixed(1) : "0";

  const smsOut = (sms.data || []).filter((s: any) => s.direction === "outbound" || !s.direction).length;
  const smsIn = (sms.data || []).filter((s: any) => s.direction === "inbound").length;
  const smsReplyRate = smsOut > 0 ? ((smsIn/smsOut)*100).toFixed(1) : "0";

  const utmAgg: Record<string, { total: number; won: number }> = {};
  (utmStats.data || []).forEach((c: any) => {
    const key = c.utm_source || "direct";
    if (!utmAgg[key]) utmAgg[key] = { total: 0, won: 0 };
    utmAgg[key].total++;
    if (c.deal_outcome === "won") utmAgg[key].won++;
  });
  const utmTable = Object.entries(utmAgg).sort((a, b) => b[1].total - a[1].total).map(([source, s]) => ({
    source, total: s.total, won: s.won,
    conversion: s.total > 0 ? ((s.won/s.total)*100).toFixed(1) + "%" : "0%",
  }));

  const pageAgg: Record<string, number> = {};
  (pageViews.data || []).forEach((v: any) => {
    let url = v.page_url || "unknown";
    try { url = new URL(url).pathname; } catch { /* keep as-is */ }
    pageAgg[url] = (pageAgg[url] || 0) + 1;
  });
  const pageTable = Object.entries(pageAgg).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([page, views]) => ({ page, views }));

  return {
    kpis: [
      { label: "Emails Sent", value: emailsSent, sub: "In selected range" },
      { label: "Open Rate", value: `${openRate}%`, sub: `${emailsOpened} opens`, accent: Number(openRate) > 25 ? "green" : Number(openRate) < 10 ? "red" : undefined },
      { label: "Click Rate", value: `${clickRate}%`, sub: `${emailsClicked} clicks` },
      { label: "SMS Sent", value: smsOut, sub: "Outbound" },
      { label: "SMS Reply Rate", value: `${smsReplyRate}%`, sub: `${smsIn} inbound`, accent: Number(smsReplyRate) > 30 ? "green" : undefined },
      { label: "Page Views", value: (pageViews.data || []).length, sub: `${Object.keys(pageAgg).length} unique pages` },
    ],
    series: [],
    tables: [
      { name: "utm_attribution", title: "UTM Source Attribution", rows: utmTable, columns: ["source","total","won","conversion"] },
      { name: "top_pages", title: "Most-Viewed Pages", rows: pageTable, columns: ["page","views"] },
    ],
  };
}

// ============ ACTIVITY ============
async function reportActivity(range: string | null) {
  const since = rangeToSince(range);
  const d7 = daysAgo(7);

  const [smsRange, emailRange, toursRange, sms7, email7, tours7, eventsRange] = await Promise.all([
    sb.from("sms_log").select("id, created_at, direction").gte("created_at", since),
    sb.from("email_log").select("id, created_at, direction").gte("created_at", since),
    sb.from("showing_batches").select("id, created_at").gte("created_at", since),
    sb.from("sms_log").select("id", { count: "exact", head: true }).gte("created_at", d7),
    sb.from("email_log").select("id", { count: "exact", head: true }).gte("created_at", d7),
    sb.from("showing_batches").select("id", { count: "exact", head: true }).gte("created_at", d7),
    sb.from("activity_events").select("type, channel, direction, created_at").gte("created_at", since),
  ]);

  // Daily activity series — combine SMS + email + tours by day
  const dailyMap: Record<string, { sms: number; email: number; tours: number; events: number }> = {};
  const fillDay = (d: Date) => {
    const key = d.toISOString().substring(0, 10);
    if (!dailyMap[key]) dailyMap[key] = { sms: 0, email: 0, tours: 0, events: 0 };
    return key;
  };
  (smsRange.data || []).forEach((r: any) => {
    const k = fillDay(new Date(r.created_at));
    dailyMap[k].sms++;
  });
  (emailRange.data || []).forEach((r: any) => {
    const k = fillDay(new Date(r.created_at));
    dailyMap[k].email++;
  });
  (toursRange.data || []).forEach((r: any) => {
    const k = fillDay(new Date(r.created_at));
    dailyMap[k].tours++;
  });
  (eventsRange.data || []).forEach((r: any) => {
    const k = fillDay(new Date(r.created_at));
    dailyMap[k].events++;
  });
  const dailySeries = Object.entries(dailyMap).sort((a, b) => a[0].localeCompare(b[0])).map(([day, v]) => ({
    label: day.substring(5), // MM-DD for chart compactness
    value: v.sms + v.email + v.tours,
    breakdown: v,
  }));

  // Channel breakdown
  const channelTotals = { sms: (smsRange.data || []).length, email: (emailRange.data || []).length, tours: (toursRange.data || []).length };
  const channelSeries = [
    { label: "SMS", value: channelTotals.sms },
    { label: "Email", value: channelTotals.email },
    { label: "Tours", value: channelTotals.tours },
  ];

  return {
    kpis: [
      { label: "SMS (7d)", value: sms7.count || 0, sub: `${channelTotals.sms} in range` },
      { label: "Email (7d)", value: email7.count || 0, sub: `${channelTotals.email} in range` },
      { label: "Tours (7d)", value: tours7.count || 0, sub: `${channelTotals.tours} in range` },
      { label: "Total Touch (7d)", value: (sms7.count || 0) + (email7.count || 0), sub: "SMS + Email" },
      { label: "Activity Events", value: (eventsRange.data || []).length, sub: "All channels in range" },
      { label: "Avg/Day", value: dailySeries.length > 0 ? Math.round(dailySeries.reduce((s, d) => s + d.value, 0) / dailySeries.length) : 0, sub: "Touchpoints/day" },
    ],
    series: [
      { name: "daily_activity", title: "Daily Activity", type: "line", data: dailySeries },
      { name: "channel_mix", title: "Channel Mix", type: "bar", data: channelSeries },
    ],
    tables: [],
  };
}

// ============ ROUTER ============
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return j({ error: "GET only" }, 405);

  try {
    const url = new URL(req.url);
    const report = url.searchParams.get("report") || "overview";
    const range = url.searchParams.get("range");

    let data;
    switch (report) {
      case "overview": data = await reportOverview(); break;
      case "money": data = await reportMoney(range); break;
      case "funnel": data = await reportFunnel(range); break;
      case "real_estate": data = await reportRealEstate(range); break;
      case "marketing": data = await reportMarketing(range); break;
      case "activity": data = await reportActivity(range); break;
      default: return j({ error: `unknown report: ${report}`, valid: ["overview","money","funnel","real_estate","marketing","activity"] }, 400);
    }

    return j({ report, range: range || "default", generated_at: new Date().toISOString(), ...data });
  } catch (e: any) {
    console.error("insights-data error:", e);
    return j({ error: e.message || "unknown", stack: e.stack }, 500);
  }
});

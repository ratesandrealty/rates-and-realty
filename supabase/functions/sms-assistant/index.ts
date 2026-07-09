// SMS AI Assistant (staff ops line) — v32
// Rebuilt 2026-07-09 from a recovered spec after the deployed v31 was overwritten with a placeholder
// stub. This is the STAFF assistant on the 888 line (authorized senders only), NOT the lead bot.
// Scaffold mirrors ai-sms-bot (raw Anthropic tool-loop, per-turn logging) but: parses the raw Twilio
// webhook directly, replies via DIRECT Twilio REST from SMS_ASSISTANT_FROM_NUMBER (the 888 line —
// sms-service is the 866 lead lane), gates on sms_authorized_phones (is_active) with AUTHORIZED_PHONES
// env fallback, and logs every turn to sms_assistant_log. Implements 9 tools + MMS->ClickUp /
// voice-memo(whisper-1) / document-image pre-loop handlers, with a pending_clarifications flow.
// Model: claude-sonnet-4-6 (fallback claude-sonnet-4-5).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || SERVICE_KEY;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
const SMS_ASSISTANT_FROM_NUMBER = Deno.env.get("SMS_ASSISTANT_FROM_NUMBER") || Deno.env.get("TWILIO_PHONE_NUMBER") || "";
const CLICKUP_API_TOKEN = Deno.env.get("CLICKUP_API_TOKEN") || "";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") || "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";

const CLAUDE_MODEL = "claude-sonnet-4-6";
const CLAUDE_MAX_TOKENS = 1024;
const MAX_TOOL_ITERATIONS = 5;
const RATE_LIMIT_PER_HOUR = 30;
const MEMORY_WINDOW_MIN = 15;
const MEMORY_MAX_EXCHANGES = 4;
const WHISPER_MODEL = "whisper-1";
const VOICE_TRANSCRIPT_REPLY_MAX = 320;
const SMS_MAX_LENGTH = 1500;
const PENDING_EXPIRY_MIN = 60;
const STORAGE_BUCKET = "borrower-documents";
const GOOGLE_CALENDAR_ID = "primary";
const GOOGLE_TIMEZONE = "America/Los_Angeles";
const GOOGLE_TOKEN_ROW_ID = "rene";
const ADMIN_LEAD_URL_BASE = "https://beta.ratesandrealty.com/admin/lead-detail.html?cid=";
const OCR_CRON_SECRET = "rr-cron-2026-x7k3m9pq2r5tw8z4y6h8b3n1";
const OCR_DOC_TYPES = ["Pay Stubs", "W-2", "Bank Statements"]; // only these trigger ocr-mms-upload
const CLICKUP_TODO_LIST_ID = Deno.env.get("CLICKUP_LIST_ID_TODO") || "901708416155";

const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,apikey,x-client-info",
};

// ── Small helpers ─────────────────────────────────────────────────────────────
const last10 = (p: string) => (p || "").replace(/\D/g, "").slice(-10);
const fullName = (c: any) => [c?.first_name, c?.last_name].filter(Boolean).join(" ").trim() || (c?.name || "Unknown");
function friendly(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: GOOGLE_TIMEZONE, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch { return iso; }
}
function nowPT(): string {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: GOOGLE_TIMEZONE, weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date()); }
  catch { return new Date().toISOString(); }
}
function tierFromScore(s: any): string | null {
  if (s == null) return null;
  const n = Number(s);
  if (isNaN(n)) return null;
  if (n >= 80) return "A"; if (n >= 60) return "B"; if (n >= 40) return "C"; return "D";
}
function relAge(ts: any): string {
  if (!ts) return "";
  const days = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
  if (isNaN(days)) return "";
  if (days <= 0) return "today"; if (days === 1) return "1 day"; if (days < 30) return `${days} days`;
  const mo = Math.floor(days / 30); return mo === 1 ? "1 month" : `${mo} months`;
}
function extFromType(ct: string): string {
  const t = (ct || "").toLowerCase();
  if (t.includes("png")) return "png";
  if (t.includes("jpeg") || t.includes("jpg")) return "jpg";
  if (t.includes("pdf")) return "pdf";
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
  if (t.includes("ogg")) return "ogg";
  if (t.includes("amr")) return "amr";
  if (t.includes("wav")) return "wav";
  if (t.includes("mp4") || t.includes("m4a")) return "m4a";
  return "bin";
}
function parseWhen(s: any): string | null {
  if (!s) return null;
  const d = new Date(String(s));
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function twiml(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { status: 200, headers: { ...cors, "Content-Type": "text/xml" } });
}

// ── Inbound parse (raw Twilio webhook; JSON also accepted for testing) ─────────
async function parseInbound(req: Request) {
  const ct = req.headers.get("content-type") || "";
  let p: URLSearchParams;
  if (ct.includes("application/json")) {
    const j = await req.json().catch(() => ({} as any));
    p = new URLSearchParams();
    for (const k of Object.keys(j || {})) p.set(k, String((j as any)[k] ?? ""));
  } else {
    const raw = await req.text();
    p = new URLSearchParams(raw);
  }
  const num = parseInt(p.get("NumMedia") || "0", 10) || 0;
  const media: { url: string; contentType: string }[] = [];
  for (let i = 0; i < num; i++) {
    const u = p.get("MediaUrl" + i);
    const c = p.get("MediaContentType" + i) || "";
    if (u) media.push({ url: u, contentType: c });
  }
  return { from: p.get("From") || "", to: p.get("To") || "", body: p.get("Body") || "", sid: p.get("MessageSid") || "", media };
}

// ── Auth / rate limit / memory / logging ──────────────────────────────────────
async function isAuthorized(fromPhone: string): Promise<{ ok: boolean; source: string | null; label: string | null }> {
  const l10 = last10(fromPhone);
  try {
    const { data } = await sb.from("sms_authorized_phones").select("phone,label,is_active").eq("is_active", true);
    for (const r of data || []) if (last10(r.phone) === l10) return { ok: true, source: "db", label: r.label || null };
  } catch (e) { console.error("[auth] db lookup failed", e); }
  const env = (Deno.env.get("AUTHORIZED_PHONES") || "").split(",").map((s) => last10(s.trim())).filter(Boolean);
  if (l10 && env.includes(l10)) return { ok: true, source: "env", label: null };
  return { ok: false, source: null, label: null };
}
async function overRateLimit(fromPhone: string): Promise<boolean> {
  const since = new Date(Date.now() - 3600000).toISOString();
  const { count } = await sb.from("sms_assistant_log").select("id", { count: "exact", head: true }).eq("from_phone", fromPhone).gte("created_at", since);
  return (count || 0) >= RATE_LIMIT_PER_HOUR;
}
async function getMemory(fromPhone: string) {
  const since = new Date(Date.now() - MEMORY_WINDOW_MIN * 60000).toISOString();
  const { data } = await sb.from("sms_assistant_log").select("inbound_text,outbound_text,created_at")
    .eq("from_phone", fromPhone).eq("authorized", true).gte("created_at", since)
    .order("created_at", { ascending: false }).limit(MEMORY_MAX_EXCHANGES);
  return (data || []).filter((r: any) => r.inbound_text && r.outbound_text).reverse();
}
async function logTurn(row: any) {
  try { await sb.from("sms_assistant_log").insert(row); } catch (e) { console.error("[log] insert failed", e); }
}

// ── Direct Twilio send (from the 888 staff line) + media fetch ─────────────────
async function sendSms(to: string, body: string): Promise<{ sid?: string; error?: string }> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return { error: "Twilio not configured" };
  const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const params = new URLSearchParams({ To: to, From: SMS_ASSISTANT_FROM_NUMBER, Body: (body || "").substring(0, SMS_MAX_LENGTH) });
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST", headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, body: params,
    });
    const data = await res.json().catch(() => ({} as any));
    if (res.ok && data.sid) return { sid: data.sid };
    return { error: data.message || data.code || `Twilio ${res.status}` };
  } catch (e: any) { return { error: e?.message || String(e) }; }
}
async function fetchTwilioMedia(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const res = await fetch(url, { headers: { "Authorization": `Basic ${auth}` } });
  if (!res.ok) throw new Error(`media fetch ${res.status}`);
  const ct = res.headers.get("content-type") || "application/octet-stream";
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: ct };
}

// ── Contact resolution ─────────────────────────────────────────────────────────
const CONTACT_COLS = "id,first_name,last_name,email,phone,pipeline_status,lead_status,lead_temperature,lead_score,is_co_borrower,employer_name,job_title,monthly_income,annual_income,loan_amount,loan_type,property_value,property_address,purchase_price,ai_summary,created_at,last_contact_date,next_follow_up,linked_application_id,primary_borrower_contact_id";
async function findContacts(name: string): Promise<any[]> {
  const q = (name || "").trim();
  if (!q) return [];
  const toks = q.split(/\s+/).filter(Boolean);
  const ors: string[] = [];
  for (const t of toks) { ors.push(`first_name.ilike.%${t}%`); ors.push(`last_name.ilike.%${t}%`); }
  ors.push(`email.ilike.%${q}%`); ors.push(`phone.ilike.%${last10(q) || q}%`);
  const { data } = await sb.from("contacts").select(CONTACT_COLS).or(ors.join(",")).limit(40);
  const rows = data || [];
  if (toks.length > 1) {
    const strong = rows.filter((c: any) => {
      const full = `${c.first_name || ""} ${c.last_name || ""}`.toLowerCase();
      return toks.every((t) => full.includes(t.toLowerCase()));
    });
    if (strong.length) return strong;
  }
  return rows;
}
async function buildBorrowerMatch(c: any) {
  let app: any = null;
  if (c.linked_application_id) {
    const { data } = await sb.from("mortgage_applications").select("id,loan_type,loan_amount,requested_loan_amount,loan_purpose,status,property_address,property_value,purchase_price,total_monthly_income,employer_name").eq("id", c.linked_application_id).maybeSingle();
    app = data || null;
  }
  if (!app) {
    const { data } = await sb.from("mortgage_applications").select("id,loan_type,loan_amount,requested_loan_amount,loan_purpose,status,property_address,property_value,purchase_price,total_monthly_income,employer_name").eq("contact_id", c.id).order("created_at", { ascending: false }).limit(1);
    app = (data && data[0]) || null;
  }
  const { data: notes } = await sb.from("contact_notes").select("note_text,source,author_display,created_at").eq("contact_id", c.id).order("created_at", { ascending: false }).limit(5);
  const { data: cobs } = await sb.from("contacts").select("id,first_name,last_name").eq("primary_borrower_contact_id", c.id).limit(5);
  return {
    contact_id: c.id, name: fullName(c), email: c.email, phone: c.phone,
    pipeline_status: c.pipeline_status, lead_status: c.lead_status, lead_temperature: c.lead_temperature,
    lead_score: c.lead_score, score_tier: tierFromScore(c.lead_score), is_co_borrower: !!c.is_co_borrower,
    employer: c.employer_name, job_title: c.job_title, monthly_income: c.monthly_income, annual_income: c.annual_income,
    loan_amount: c.loan_amount, loan_type: c.loan_type, property_value: c.property_value, property_address: c.property_address, purchase_price: c.purchase_price,
    ai_summary: c.ai_summary, created_at: c.created_at, last_contact_date: c.last_contact_date, next_follow_up: c.next_follow_up,
    application: app ? { id: app.id, loan_type: app.loan_type, loan_amount: app.loan_amount || app.requested_loan_amount, loan_purpose: app.loan_purpose, status: app.status, property_address: app.property_address, property_value: app.property_value, purchase_price: app.purchase_price, total_monthly_income: app.total_monthly_income } : null,
    co_borrowers: (cobs || []).map((x: any) => ({ contact_id: x.id, name: fullName(x) })),
    recent_notes: (notes || []).map((n: any) => ({ note: n.note_text, source: n.source, author: n.author_display, created_at: n.created_at })),
  };
}

// ── pending_clarifications ─────────────────────────────────────────────────────
async function getPending(fromPhone: string) {
  const { data } = await sb.from("pending_clarifications").select("*").eq("from_phone", fromPhone)
    .is("resolved_at", null).gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false }).limit(1);
  return data && data[0] ? data[0] : null;
}
async function writePending(fromPhone: string, kind: string, payload: any, candidates: any[]) {
  const { data } = await sb.from("pending_clarifications").insert({
    from_phone: fromPhone, kind, payload, candidates,
    expires_at: new Date(Date.now() + PENDING_EXPIRY_MIN * 60000).toISOString(),
  }).select("id").single();
  return data?.id || null;
}
async function resolvePending(id: string, resolvedWith: any) {
  await sb.from("pending_clarifications").update({ resolved_at: new Date().toISOString(), resolved_with: resolvedWith }).eq("id", id);
}
function matchCandidate(body: string, cands: any[]): any | null {
  const b = (body || "").trim().toLowerCase();
  if (!b || !cands?.length) return null;
  const n = parseInt(b, 10);
  if (!isNaN(n) && n >= 1 && n <= cands.length) return cands[n - 1];
  for (const c of cands) {
    const nm = String(c.name || "").toLowerCase();
    if (nm && (nm.includes(b) || b.includes(nm) || nm.split(/\s+/).some((t: string) => t && b.includes(t)))) return c;
  }
  return null;
}

// ── Tools (9) ──────────────────────────────────────────────────────────────────
async function toolCreateTask(input: any) {
  const name = (input.name || "").trim();
  if (!name) return { success: false, message: "name required" };
  const res = await fetch(`${SUPABASE_URL}/functions/v1/clickup-bridge/task`, {
    method: "POST", headers: { "Content-Type": "application/json", "apikey": ANON_KEY, "Authorization": `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ title: name, due_date: input.due_date || undefined }),
  });
  const j = await res.json().catch(() => ({} as any));
  if (!res.ok || !j.success) return { success: false, message: "clickup create failed: " + (j.error || res.status) };
  return { success: true, task_id: j.clickup_task_id, name, url: j.url };
}
async function toolQueryCrmBorrower(input: any, ctx: any) {
  const name = (input.name || "").trim();
  const found = await findContacts(name);
  const matches = [];
  for (const c of found.slice(0, 5)) matches.push(await buildBorrowerMatch(c));
  const count = matches.length;
  const ambiguous = count > 1;
  if (ambiguous) await writePending(ctx.fromPhone, "crm_disambiguation", { query: name }, matches.map((m) => ({ contact_id: m.contact_id, name: m.name })));
  return { success: count > 0, query: name, count, ambiguous, matches, needs_disambiguation: ambiguous };
}
async function toolQueryLoanIncome(input: any) {
  const name = (input.name || "").trim();
  const found = await findContacts(name);
  if (!found.length) return { success: false, query: name, matched_contact: null, application_id: null, income_by_owner: [] };
  const c = found[0];
  const { data: snap } = await sb.from("borrower_qualifying_snapshot").select("*").eq("contact_id", c.id).maybeSingle();
  if (!snap) return { success: true, query: name, matched_contact: { contact_id: c.id, name: fullName(c) }, application_id: null, income_by_owner: [] };
  const tot = Number(snap.total_documented_monthly || 0);
  const income_by_owner = tot > 0 ? [{
    owner: snap.name || fullName(c),
    base_salary_monthly: snap.base_salary_monthly, variable_monthly: snap.variable_monthly, self_employed_monthly: snap.self_employed_monthly,
    rental_monthly: snap.rental_monthly, investment_monthly: snap.investment_monthly, retirement_monthly: snap.retirement_monthly,
    support_monthly: snap.support_monthly, other_monthly: snap.other_monthly, total_documented_monthly: snap.total_documented_monthly,
    preliminary_qualifying_monthly: snap.preliminary_qualifying_monthly, agency_qualifying_monthly: snap.agency_qualifying_monthly,
    max_back_end_piti_at_43_dti: snap.max_back_end_piti_at_43_dti, max_back_end_piti_at_50_dti: snap.max_back_end_piti_at_50_dti,
  }] : [];
  return { success: true, query: name, matched_contact: { contact_id: c.id, name: snap.name || fullName(c) }, application_id: snap.application_id || null, income_by_owner };
}
async function toolListDocs(input: any) {
  const name = (input.name || "").trim();
  const found = await findContacts(name);
  if (!found.length) return { success: false, query: name, count: 0, documents: [] };
  const c = found[0];
  const { data: docs } = await sb.from("uploaded_documents").select("document_type,type,file_name,file_size,file_url,gdrive_file_url,created_at,uploaded_at").eq("contact_id", c.id).order("created_at", { ascending: false }).limit(50);
  const documents = (docs || []).map((d: any) => ({
    type: d.document_type || d.type || "Document", file_name: d.file_name,
    size_kb: d.file_size ? Math.round(d.file_size / 1024) : null, age: relAge(d.uploaded_at || d.created_at),
    drive: !!d.gdrive_file_url, drive_url: d.gdrive_file_url || d.file_url || null,
  }));
  return { success: true, contact_id: c.id, contact_name: fullName(c), count: documents.length, documents, admin_url: ADMIN_LEAD_URL_BASE + c.id };
}
async function getGoogleAccessToken(): Promise<string> {
  const { data: row } = await sb.from("google_calendar_tokens").select("access_token,refresh_token,expires_at").eq("id", GOOGLE_TOKEN_ROW_ID).maybeSingle();
  if (!row) throw new Error("no google token row");
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (row.access_token && exp - Date.now() > 60000) return row.access_token;
  const body = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: row.refresh_token, grant_type: "refresh_token" });
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const j = await res.json().catch(() => ({} as any));
  if (!res.ok || !j.access_token) throw new Error("google refresh failed: " + (j.error || res.status));
  const newExp = new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString();
  await sb.from("google_calendar_tokens").update({ access_token: j.access_token, expires_at: newExp, updated_at: new Date().toISOString() }).eq("id", GOOGLE_TOKEN_ROW_ID);
  return j.access_token;
}
async function toolCreateCalendarEvent(input: any) {
  const startISO = parseWhen(input.start);
  if (!startISO) return { success: false, message: "could not parse start time (pass ISO 8601)" };
  const endISO = input.end ? parseWhen(input.end) : new Date(new Date(startISO).getTime() + 3600000).toISOString();
  const token = await getGoogleAccessToken();
  const event: any = { summary: input.title, start: { dateTime: startISO, timeZone: GOOGLE_TIMEZONE }, end: { dateTime: endISO, timeZone: GOOGLE_TIMEZONE } };
  if (Array.isArray(input.attendees) && input.attendees.length) event.attendees = input.attendees.map((e: string) => ({ email: e }));
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events`, {
    method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(event),
  });
  const j = await res.json().catch(() => ({} as any));
  if (!res.ok) return { success: false, message: "calendar error: " + (j.error?.message || res.status) };
  return { success: true, event_id: j.id, html_link: j.htmlLink, start_iso: startISO, end_iso: endISO, start_friendly: friendly(startISO), end_friendly: friendly(endISO!), message: `Event created: ${input.title}` };
}
async function toolAddNote(input: any, ctx: any) {
  const name = (input.name || "").trim();
  const note = (input.note || "").trim();
  if (!note) return { success: false, message: "note text required" };
  const found = await findContacts(name);
  if (!found.length) return { success: false, query: name, message: "no borrower matched" };
  if (found.length > 1) {
    await writePending(ctx.fromPhone, "crm_disambiguation", { intent: "add_note", note }, found.slice(0, 5).map((c: any) => ({ contact_id: c.id, name: fullName(c) })));
    return { success: false, ambiguous: true, message: "multiple borrowers matched; ask which one", candidates: found.slice(0, 5).map((c: any) => fullName(c)) };
  }
  const c = found[0];
  const { data: ins, error } = await sb.from("contact_notes").insert({ contact_id: c.id, note_text: note, source: "sms", author_display: `SMS from ${ctx.fromPhone}`, author_user_id: null, tags: ["sms"] }).select("id").single();
  if (error) return { success: false, message: "note insert failed: " + error.message };
  return { success: true, contact_id: c.id, contact_name: fullName(c), note_id: ins?.id || null };
}
async function toolRecentLeads(input: any) {
  const limit = Math.min(Math.max(parseInt(input.limit) || 10, 1), 25);
  let q = sb.from("contacts").select("id,first_name,last_name,phone,email,pipeline_status,lead_status,lead_temperature,lead_score,created_at").order("created_at", { ascending: false }).limit(limit);
  if (input.days) q = q.gte("created_at", new Date(Date.now() - Number(input.days) * 86400000).toISOString());
  const { data } = await q;
  return { success: true, count: (data || []).length, leads: (data || []).map((c: any) => ({ contact_id: c.id, name: fullName(c), phone: c.phone, pipeline_status: c.pipeline_status, lead_status: c.lead_status, lead_temperature: c.lead_temperature, lead_score: c.lead_score, created_at: c.created_at })) };
}
async function toolSearchHistory(input: any) {
  const name = (input.name || "").trim();
  const query = (input.query || "").trim();
  let contact: any = null;
  if (name) { const f = await findContacts(name); if (f.length) contact = f[0]; }
  let notesQ = sb.from("contact_notes").select("contact_id,note_text,source,author_display,created_at").order("created_at", { ascending: false }).limit(25);
  if (contact) notesQ = notesQ.eq("contact_id", contact.id);
  if (query) notesQ = notesQ.ilike("note_text", `%${query}%`);
  const { data: notes } = await notesQ;
  let activity: any[] = [];
  try {
    let aQ = sb.from("activity_events").select("contact_id,type,title,created_at").order("created_at", { ascending: false }).limit(25);
    if (contact) aQ = aQ.eq("contact_id", contact.id);
    if (query) aQ = aQ.ilike("title", `%${query}%`);
    const { data: a } = await aQ; activity = a || [];
  } catch (_) { /* activity_events schema varies — best-effort */ }
  return { success: true, contact: contact ? { contact_id: contact.id, name: fullName(contact) } : null, query, notes: (notes || []).map((n: any) => ({ note: n.note_text, source: n.source, author: n.author_display, created_at: n.created_at })), activity };
}
async function toolTasksToday() {
  const url = `${SUPABASE_URL}/functions/v1/clickup-bridge/tasks?status=open&due=today&list_id=${CLICKUP_TODO_LIST_ID}&limit=50`;
  const res = await fetch(url, { headers: { "apikey": ANON_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } });
  const j = await res.json().catch(() => ({} as any));
  if (!res.ok) return { success: false, message: "clickup bridge error " + res.status };
  const tasks = (j.tasks || []).map((t: any) => ({ title: t.title || t.name, status: t.status, priority: t.priority, due_date: t.due_date, url: t.url }));
  return { success: true, count: j.counts?.today ?? tasks.length, tasks };
}

async function executeTool(name: string, input: any, ctx: any): Promise<string> {
  let r: any;
  switch (name) {
    case "create_clickup_task": r = await toolCreateTask(input); break;
    case "query_crm_borrower": r = await toolQueryCrmBorrower(input, ctx); break;
    case "query_loan_income": r = await toolQueryLoanIncome(input); break;
    case "list_borrower_documents": r = await toolListDocs(input); break;
    case "create_calendar_event": r = await toolCreateCalendarEvent(input); break;
    case "add_borrower_note": r = await toolAddNote(input, ctx); break;
    case "query_recent_leads": r = await toolRecentLeads(input); break;
    case "search_borrower_history": r = await toolSearchHistory(input); break;
    case "list_my_tasks_today": r = await toolTasksToday(); break;
    default: r = { success: false, error: "unknown tool " + name };
  }
  return JSON.stringify(r);
}

const TOOLS = [
  { name: "create_clickup_task", description: "Create a ClickUp task on Rene's Todo list. Use for any 'add a task / remind me / create a to-do' request.", input_schema: { type: "object", properties: { name: { type: "string", description: "Task title" }, due_date: { type: "string", description: "Optional ISO 8601 date/time or ms epoch" } }, required: ["name"] } },
  { name: "query_crm_borrower", description: "Look up a borrower/lead in the CRM by name. Returns full profile(s): status, score, income, loan, property, recent notes, co-borrowers. If multiple match, ask the user which one.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "query_loan_income", description: "Get a borrower's documented/qualifying monthly income breakdown from the qualifying snapshot. Use for income/qualifying/DTI questions.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "list_borrower_documents", description: "List the documents on file for a borrower (type, filename, size, age, drive link).", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "create_calendar_event", description: "Create an event on Rene's Google Calendar. Pass start (and optional end) as ISO 8601 in Pacific time.", input_schema: { type: "object", properties: { title: { type: "string" }, start: { type: "string", description: "ISO 8601 datetime" }, end: { type: "string", description: "Optional ISO 8601 datetime" }, attendees: { type: "array", items: { type: "string" }, description: "Optional attendee emails" } }, required: ["title", "start"] } },
  { name: "add_borrower_note", description: "Add a note to a borrower's CRM record. If the name is ambiguous, ask which borrower.", input_schema: { type: "object", properties: { name: { type: "string" }, note: { type: "string" } }, required: ["name", "note"] } },
  { name: "query_recent_leads", description: "List the most recent leads/contacts (newest first). Optional days window and limit.", input_schema: { type: "object", properties: { limit: { type: "number" }, days: { type: "number" } } } },
  { name: "search_borrower_history", description: "Search a borrower's notes and activity (by name and/or a text query).", input_schema: { type: "object", properties: { name: { type: "string" }, query: { type: "string" } } } },
  { name: "list_my_tasks_today", description: "List Rene's open ClickUp tasks due today.", input_schema: { type: "object", properties: {} } },
];

function buildSystemPrompt(label: string | null, fromPhone: string): string {
  return `You are the staff SMS operations assistant for Rates & Realty (a mortgage brokerage). You are texting with an AUTHORIZED staff member${label ? ` (${label})` : ""} on the internal ops line. Current time: ${nowPT()} (Pacific).

Your job: help staff run the business over SMS — look up borrowers/leads in the CRM, check qualifying income, list a borrower's documents, add notes, create ClickUp tasks, check today's tasks, and put events on Rene's Google Calendar. Use the tools for anything factual; NEVER invent CRM data, income numbers, task ids, documents, or calendar links.

Rules:
- Keep replies SMS-short and plain text (no markdown, no bullet symbols). Lead with the answer.
- If a borrower name matches more than one person, ask which one (the tool returns candidates) instead of guessing.
- Format money like $4,200/mo and dates in a friendly Pacific format (e.g. Jul 9, 3:00 PM).
- If a tool returns success:false or empty results, say so briefly — do not fabricate.
Respond with ONLY the SMS text to send back.`;
}

async function runAssistant(message: string, fromPhone: string, label: string | null) {
  const history = await getMemory(fromPhone);
  const messages: any[] = [];
  for (const h of history) { messages.push({ role: "user", content: h.inbound_text }); messages.push({ role: "assistant", content: h.outbound_text }); }
  messages.push({ role: "user", content: message });
  const sys = buildSystemPrompt(label, fromPhone);
  const toolCalls: any[] = [];
  let tokensIn = 0, tokensOut = 0, finalText = "", iterations = 0;
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    iterations = i + 1;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: CLAUDE_MAX_TOKENS, system: sys, tools: TOOLS, messages }),
    });
    if (!res.ok) { const t = await res.text(); throw new Error(`Anthropic ${res.status}: ${t.slice(0, 200)}`); }
    const data = await res.json();
    tokensIn += data.usage?.input_tokens || 0;
    tokensOut += data.usage?.output_tokens || 0;
    const blocks = data.content || [];
    if (data.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: blocks });
      const results: any[] = [];
      for (const b of blocks) {
        if (b.type === "tool_use") {
          const s = Date.now();
          let out: string;
          try { out = await executeTool(b.name, b.input || {}, { fromPhone }); }
          catch (e: any) { out = JSON.stringify({ success: false, error: e?.message || String(e) }); }
          toolCalls.push({ name: b.name, input: b.input || {}, output: out, duration_ms: Date.now() - s });
          results.push({ type: "tool_result", tool_use_id: b.id, content: out });
        }
      }
      messages.push({ role: "user", content: results });
      continue;
    }
    finalText = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").trim();
    break;
  }
  if (!finalText) finalText = "Done.";
  return { text: finalText, toolCalls, tokensIn, tokensOut, iterations, usedHistory: history.length > 0, historyCount: history.length };
}

// ── Media handlers ─────────────────────────────────────────────────────────────
async function imagesToPdf(images: { bytes: Uint8Array; contentType: string }[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (const img of images) {
    const embedded = (img.contentType || "").toLowerCase().includes("png") ? await pdf.embedPng(img.bytes) : await pdf.embedJpg(img.bytes);
    const page = pdf.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  }
  return await pdf.save();
}
async function attachClickup(taskId: string, bytes: Uint8Array, contentType: string, filename: string) {
  const fd = new FormData();
  fd.append("attachment", new Blob([bytes as unknown as BlobPart], { type: contentType }), filename);
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/attachment`, { method: "POST", headers: { "Authorization": CLICKUP_API_TOKEN }, body: fd });
  if (!res.ok) { const t = await res.text(); throw new Error(`clickup attach ${res.status} ${t.slice(0, 120)}`); }
  return await res.json().catch(() => ({}));
}
async function handleMmsToClickupTask(caption: string, images: { url: string; contentType: string }[]) {
  let name = (caption || "").replace(/\b(clickup|click ?up)\b/ig, "").replace(/\btask\b/ig, "").replace(/\s+/g, " ").trim();
  if (!name) name = `SMS task ${friendly(new Date().toISOString())}`;
  const created = await toolCreateTask({ name });
  const toolCalls = [{ name: "create_clickup_task", input: { name }, output: JSON.stringify(created), duration_ms: 0 }];
  if (!created.success) return { reply: `Couldn't create the ClickUp task: ${created.message || "error"}`, toolCalls, meta: { path: "mms_clickup_task", error: created.message, attached: 0, has_image: true, media_count: images.length } };
  let attached = 0;
  for (const img of images) {
    try { const m = await fetchTwilioMedia(img.url); await attachClickup(created.task_id!, m.bytes, m.contentType || img.contentType, `photo_${attached + 1}.${extFromType(m.contentType || img.contentType)}`); attached++; }
    catch (e) { console.error("[mms->clickup] attach failed", e); }
  }
  const reply = `✅ ClickUp task created: ${name}${created.url ? ` — ${created.url}` : ""}${attached ? ` (${attached} image${attached > 1 ? "s" : ""} attached)` : ""}`;
  return { reply, toolCalls, meta: { path: "mms_clickup_task", task_id: created.task_id, task_url: created.url, attached, has_image: true, media_count: images.length } };
}
async function transcribeAudio(url: string, contentType: string): Promise<string> {
  const m = await fetchTwilioMedia(url);
  const ct = contentType || m.contentType || "audio/ogg";
  const fd = new FormData();
  fd.append("file", new Blob([m.bytes as unknown as BlobPart], { type: ct }), `memo.${extFromType(ct)}`);
  fd.append("model", WHISPER_MODEL);
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` }, body: fd });
  const j = await res.json().catch(() => ({} as any));
  if (!res.ok) throw new Error(`whisper ${res.status} ${j.error?.message || ""}`);
  return j.text || "";
}
function inferDocType(caption: string): string | null {
  const s = (caption || "").toLowerCase();
  if (/\bw-?2\b/.test(s)) return "W-2";
  if (/pay\s?stub|paystub/.test(s)) return "Pay Stubs";
  if (/bank\s?statement/.test(s)) return "Bank Statements";
  return null;
}
function extractNameFromCaption(caption: string): string {
  const s = (caption || "")
    .replace(/\b(w-?2|pay\s?stub[s]?|paystub[s]?|bank\s?statement[s]?|doc(ument)?s?|for|from|here('?s)?|attached|please|thanks?|the)\b/ig, " ")
    .replace(/[^a-z\s'-]/ig, " ").replace(/\s+/g, " ").trim();
  return s.length >= 2 ? s : "";
}
async function saveBorrowerDocument(contact: any, mediaList: { url: string; contentType: string }[], docType: string | null) {
  const imgs: { bytes: Uint8Array; contentType: string }[] = [];
  for (const md of mediaList) {
    try { const m = await fetchTwilioMedia(md.url); imgs.push({ bytes: m.bytes, contentType: md.contentType || m.contentType }); }
    catch (e) { console.error("[doc] media fetch failed", e); }
  }
  if (!imgs.length) throw new Error("no media downloaded");
  let bytes: Uint8Array, fileExt: string, mime: string;
  try { bytes = await imagesToPdf(imgs); fileExt = "pdf"; mime = "application/pdf"; }
  catch (e) { console.error("[doc] pdf embed failed, storing raw", e); bytes = imgs[0].bytes; mime = imgs[0].contentType || "image/jpeg"; fileExt = extFromType(mime); }
  const typeLabel = docType || "Document";
  const slug = typeLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document";
  const safe = `${slug}_${Date.now()}.${fileExt}`;
  const path = `${contact.id}/${slug}/${safe}`;
  const up = await sb.storage.from(STORAGE_BUCKET).upload(path, bytes, { contentType: mime, upsert: true });
  if (up.error) throw new Error("storage upload: " + up.error.message);
  const { data: ins, error } = await sb.from("uploaded_documents").insert({ contact_id: contact.id, document_type: typeLabel, file_name: safe, file_size: bytes.byteLength, storage_path: path, file_path: path, status: "received", uploaded_at: new Date().toISOString() }).select("id").single();
  if (error) throw new Error("doc insert: " + error.message);
  const uploadedId = ins.id;
  let ocr = false;
  if (OCR_DOC_TYPES.includes(typeLabel)) {
    try { await fetch(`${SUPABASE_URL}/functions/v1/ocr-mms-upload`, { method: "POST", headers: { "Content-Type": "application/json", "x-cron-secret": OCR_CRON_SECRET }, body: JSON.stringify({ uploaded_document_id: uploadedId }) }); ocr = true; }
    catch (e) { console.error("[doc] ocr trigger failed", e); }
  }
  return { uploaded_id: uploadedId, file_name: safe, ocr, pages: imgs.length };
}

// ── Main handler ────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const t0 = Date.now();

  let inbound;
  try { inbound = await parseInbound(req); } catch { return twiml(); }
  const fromPhone = inbound.from, toPhone = inbound.to, body = inbound.body, sid = inbound.sid;
  const media = inbound.media;
  const images = media.filter((m) => /^image\//i.test(m.contentType));
  const audio = media.find((m) => /^audio\//i.test(m.contentType));

  let outboundText = "", errorMessage: string | null = null, replySid: string | null = null, sentAt: string | null = null;
  let toolCalls: any[] = [], tokensIn = 0, tokensOut = 0, calledClaude = false;
  let metadata: any = {};
  let authorized = false, rejectReason: string | null = null, authSource: string | null = null;

  try {
    if (!fromPhone) return twiml();

    const auth = await isAuthorized(fromPhone);
    authorized = auth.ok; authSource = auth.source;
    if (!authorized) {
      rejectReason = "not_authorized"; metadata = { path: "reject", auth_source: null };
      await logTurn({ from_phone: fromPhone, to_phone: toPhone, inbound_text: body || null, twilio_message_sid: sid, authorized: false, reject_reason: rejectReason, outbound_text: null, outbound_sent_at: null, claude_model: null, claude_input_tokens: null, claude_output_tokens: null, tool_calls: null, duration_ms: Date.now() - t0, error_message: null, metadata });
      return twiml(); // silent reject — no reply to unauthorized senders
    }

    if (await overRateLimit(fromPhone)) {
      rejectReason = "rate_limited";
      outboundText = "You've reached the hourly limit (30 messages). Please try again later.";
      metadata = { path: "rate_limited", auth_source: authSource };
    } else {
      const pending = await getPending(fromPhone);
      // ── Resolve a pending "which borrower are these docs for?" ──
      if (pending && pending.kind === "doc_upload_target" && images.length === 0 && (body || "").trim()) {
        const cands = pending.candidates || [];
        let chosen = matchCandidate(body, cands);
        if (!chosen) { const f = await findContacts(body.trim()); if (f.length === 1) chosen = { contact_id: f[0].id, name: fullName(f[0]), _c: f[0] }; }
        if (chosen) {
          const contact = chosen._c || (await sb.from("contacts").select(CONTACT_COLS).eq("id", chosen.contact_id).maybeSingle()).data;
          try {
            const saved = await saveBorrowerDocument(contact, pending.payload?.media || [], pending.payload?.document_type || inferDocType(pending.payload?.caption || ""));
            await resolvePending(pending.id, chosen.contact_id);
            outboundText = `✅ Saved ${saved.pages} page(s) to ${fullName(contact)}'s documents.${saved.ocr ? " OCR queued." : ""} ${ADMIN_LEAD_URL_BASE}${contact.id}`;
            metadata = { path: "doc_upload_resolved", auth_source: authSource, contact_id: contact.id, contact_name: fullName(contact), uploaded_id: saved.uploaded_id, ocr: saved.ocr, media_count: (pending.payload?.media || []).length };
          } catch (e: any) { errorMessage = e?.message || String(e); outboundText = `Couldn't save those documents: ${errorMessage}`; metadata = { path: "doc_upload_resolved", auth_source: authSource, error: errorMessage }; }
        } else {
          outboundText = `I couldn't match "${(body || "").trim()}" to a borrower. Reply with the full name.`;
          metadata = { path: "doc_upload_pending", auth_source: authSource, pending_id: pending.id };
        }
      // ── Voice memo → whisper → assistant ──
      } else if (audio) {
        let transcript = "";
        try { transcript = await transcribeAudio(audio.url, audio.contentType); }
        catch (e: any) { errorMessage = "whisper: " + (e?.message || e); }
        const msg = transcript || (body || "");
        if (!msg) { outboundText = "I couldn't transcribe that voice memo — please resend or text it."; }
        else { const r = await runAssistant(msg, fromPhone, auth.label); calledClaude = true; outboundText = (r.text || "").substring(0, VOICE_TRANSCRIPT_REPLY_MAX); toolCalls = r.toolCalls; tokensIn = r.tokensIn; tokensOut = r.tokensOut; }
        metadata = { path: "voice_memo", auth_source: authSource, has_audio: true, transcript: transcript || null };
      // ── MMS image + "clickup/task" caption → create task + attach ──
      } else if (images.length && /\b(clickup|click ?up|task)\b/i.test(body || "")) {
        const h = await handleMmsToClickupTask(body || "", images);
        outboundText = h.reply; toolCalls = h.toolCalls || []; metadata = { ...h.meta, auth_source: authSource };
      // ── MMS image (non-task) → save to borrower docs ──
      } else if (images.length) {
        const docType = inferDocType(body || "");
        const nm = extractNameFromCaption(body || "");
        let target: any = null, candidates: any[] = [];
        if (nm) { const f = await findContacts(nm); if (f.length === 1) target = f[0]; else if (f.length > 1) candidates = f.slice(0, 5).map((c: any) => ({ contact_id: c.id, name: fullName(c) })); }
        if (target) {
          try {
            const saved = await saveBorrowerDocument(target, images, docType);
            outboundText = `✅ Saved ${saved.pages} page(s) to ${fullName(target)}'s documents as "${docType || "Document"}".${saved.ocr ? " OCR queued." : ""} ${ADMIN_LEAD_URL_BASE}${target.id}`;
            metadata = { path: "doc_image", auth_source: authSource, contact_id: target.id, contact_name: fullName(target), uploaded_id: saved.uploaded_id, document_type: docType, media_count: images.length, ocr: saved.ocr };
          } catch (e: any) { errorMessage = e?.message || String(e); outboundText = `Couldn't save those documents: ${errorMessage}`; metadata = { path: "doc_image", auth_source: authSource, error: errorMessage }; }
        } else {
          const pid = await writePending(fromPhone, "doc_upload_target", { media: images.map((i) => ({ url: i.url, contentType: i.contentType })), document_type: docType, caption: body || "" }, candidates);
          outboundText = candidates.length
            ? `Got ${images.length} image(s). Which borrower — ${candidates.map((c: any, i: number) => `${i + 1}) ${c.name}`).join(", ")}? Reply with the number or name.`
            : `Got ${images.length} image(s). Which borrower are these for? Reply with their name.`;
          metadata = { path: "doc_image_pending", auth_source: authSource, pending_id: pid, document_type: docType, media_count: images.length };
        }
      // ── Plain text → assistant tool-loop ──
      } else {
        const r = await runAssistant(body || "", fromPhone, auth.label);
        calledClaude = true; outboundText = r.text; toolCalls = r.toolCalls; tokensIn = r.tokensIn; tokensOut = r.tokensOut;
        metadata = { path: "sms", auth_source: authSource, iterations: r.iterations, used_history: r.usedHistory, history_messages: r.historyCount };
      }
    }
  } catch (e: any) {
    errorMessage = e?.message || String(e);
    if (!outboundText) outboundText = "Sorry — I hit an error handling that. Please try again in a moment.";
    if (!metadata.path) metadata = { path: "error", auth_source: authSource };
  }

  if (outboundText && !replySid) {
    const s = await sendSms(fromPhone, outboundText);
    if (s.sid) { replySid = s.sid; sentAt = new Date().toISOString(); }
    if (s.error && !errorMessage) errorMessage = "send: " + s.error;
  }

  await logTurn({
    from_phone: fromPhone, to_phone: toPhone, inbound_text: body || null, twilio_message_sid: sid,
    authorized, reject_reason: rejectReason, outbound_text: outboundText || null, outbound_sent_at: sentAt,
    claude_model: calledClaude ? CLAUDE_MODEL : null, claude_input_tokens: tokensIn || null, claude_output_tokens: tokensOut || null,
    tool_calls: toolCalls.length ? toolCalls : null, duration_ms: Date.now() - t0, error_message: errorMessage, metadata,
  });

  return twiml();
});

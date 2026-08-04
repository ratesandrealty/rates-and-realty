// communications-admin: powers the rebuilt Communications inbox.
//
// Actions:
//   list_conversations  - inbox view: 1 row per phone/contact across ALL channels (SMS/email/call)
//   get_thread          - full conversation thread (interleaved SMS + email + calls + bot decisions) for one phone or contact
//   send_sms            - LO sends an SMS reply from the CRM (will pause the bot for that conversation)
//   send_email          - LO sends an email reply from the CRM
//   pause_bot           - pause AI bot for one conversation (LO is taking over)
//   resume_bot          - resume AI bot for one conversation
//   mark_resolved       - mark conversation resolved
//   assign_to_contact   - link an unmatched phone to an existing contact
//   create_contact_from_phone - create a brand-new contact from an unmatched conversation
//   stats               - inbox stats (unreads, hot leads, bot-handled, awaiting reply)
//   search              - search across all communications by name/email/phone/body

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function last10(p: string): string { return (p || "").replace(/\D/g, "").slice(-10); }
function normalizePhone(p: string): string {
  const d = (p || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  return d ? `+${d}` : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const body = await req.json();
    const action = (body.action || "").toLowerCase();

    // =================================================================
    // LIST CONVERSATIONS - the inbox view
    // =================================================================
    if (action === "list_conversations") {
      const channel = body.channel || "all";  // all, sms, email, call
      const filter = body.filter || "all";    // all, unread, hot, escalated, bot_handled, awaiting_reply
      const limit = Math.min(parseInt(body.limit) || 100, 300);
      const search = (body.search || "").trim().toLowerCase();

      // Pull recent activity grouped by phone/contact
      // Strategy: pull last 90 days of sms_log + email_log + calls_log, group, hydrate with contact info.
      const since = new Date(Date.now() - 90 * 86400000).toISOString();

      const promises: any[] = [];
      if (channel === "all" || channel === "sms") {
        promises.push(sb.from("sms_log")
          .select("id, direction, from_phone, to_phone, body, status, twilio_sid, contact_id, trigger_type, created_at")
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(800));
      } else { promises.push(Promise.resolve({ data: [] })); }

      if (channel === "all" || channel === "email") {
        promises.push(sb.from("email_log")
          .select("id, recipient_email:to_email, recipient_name:to_name, subject, body:body_text, status, contact_id, sent_at, opened_at, created_at")
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(400));
      } else { promises.push(Promise.resolve({ data: [] })); }

      if (channel === "all" || channel === "call") {
        promises.push(sb.from("calls_log")
          .select("*")
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(200));
      } else { promises.push(Promise.resolve({ data: [] })); }

      const [smsRes, emailRes, callsRes] = await Promise.all(promises);
      const sms = smsRes.data || [];
      const emails = emailRes.data || [];
      const calls = callsRes.data || [];

      // Group by a stable key: prefer contact_id, fall back to last10(phone) or email
      type Conv = {
        key: string;
        contact_id: string | null;
        phone: string | null;
        email: string | null;
        last_message_at: string;
        last_direction: string;
        last_body: string;
        last_channel: string;
        last_status: string;
        sms_count: number;
        email_count: number;
        call_count: number;
        unread_inbound: number;
        last_inbound_at: string | null;
        last_outbound_at: string | null;
      };

      const conv = new Map<string, Conv>();
      function get(key: string) {
        let c = conv.get(key);
        if (!c) {
          c = {
            key, contact_id: null, phone: null, email: null,
            last_message_at: "", last_direction: "", last_body: "",
            last_channel: "", last_status: "",
            sms_count: 0, email_count: 0, call_count: 0,
            unread_inbound: 0, last_inbound_at: null, last_outbound_at: null,
          };
          conv.set(key, c);
        }
        return c;
      }

      for (const m of sms) {
        const phone = m.direction === "inbound" ? m.from_phone : m.to_phone;
        const key = m.contact_id ? `c:${m.contact_id}` : `p:${last10(phone || "")}`;
        const c = get(key);
        c.contact_id = c.contact_id || m.contact_id;
        c.phone = c.phone || normalizePhone(phone || "");
        c.sms_count++;
        if (!c.last_message_at || m.created_at > c.last_message_at) {
          c.last_message_at = m.created_at;
          c.last_direction = m.direction;
          c.last_body = (m.body || "").substring(0, 200);
          c.last_channel = "sms";
          c.last_status = m.status || "";
        }
        if (m.direction === "inbound") {
          c.unread_inbound++;  // we'll refine "unread" by checking if a reply came AFTER this in the next pass
          if (!c.last_inbound_at || m.created_at > c.last_inbound_at) c.last_inbound_at = m.created_at;
        } else {
          if (!c.last_outbound_at || m.created_at > c.last_outbound_at) c.last_outbound_at = m.created_at;
        }
      }

      for (const m of emails) {
        const key = m.contact_id ? `c:${m.contact_id}` : `e:${(m.recipient_email || "").toLowerCase()}`;
        const c = get(key);
        c.contact_id = c.contact_id || m.contact_id;
        c.email = c.email || m.recipient_email;
        c.email_count++;
        if (!c.last_message_at || m.created_at > c.last_message_at) {
          c.last_message_at = m.created_at;
          c.last_direction = "outbound";  // emails in our log are typically outbound
          c.last_body = (m.subject || m.body || "").substring(0, 200);
          c.last_channel = "email";
          c.last_status = m.status || "";
        }
      }

      for (const m of calls) {
        const key = m.contact_id ? `c:${m.contact_id}` : `p:${last10(m.from_phone || m.to_phone || "")}`;
        const c = get(key);
        c.contact_id = c.contact_id || m.contact_id;
        c.phone = c.phone || normalizePhone(m.from_phone || m.to_phone || "");
        c.call_count++;
        if (!c.last_message_at || m.created_at > c.last_message_at) {
          c.last_message_at = m.created_at;
          c.last_direction = m.direction || "";
          c.last_body = `[Call \u2014 ${m.duration ? Math.round(m.duration / 60) + "m" : "missed"}]`;
          c.last_channel = "call";
          c.last_status = m.status || "";
        }
      }

      // Compute "awaiting reply": last_inbound > last_outbound (or no outbound) AND last is recent (< 7 days)
      const now = Date.now();
      const items = Array.from(conv.values()).map(c => {
        const awaiting = c.last_inbound_at && (!c.last_outbound_at || c.last_inbound_at > c.last_outbound_at);
        const minutesSinceInbound = c.last_inbound_at ? (now - new Date(c.last_inbound_at).getTime()) / 60000 : null;
        return {
          ...c,
          awaiting_reply: !!awaiting && minutesSinceInbound !== null && minutesSinceInbound < 7 * 1440,
          minutes_since_last_inbound: minutesSinceInbound,
        };
      });

      // Hydrate contact info, bot conversation status
      const contactIds = items.map(i => i.contact_id).filter(Boolean) as string[];
      const phones = items.map(i => i.phone).filter(Boolean) as string[];

      const [{ data: contacts }, { data: botConvs }] = await Promise.all([
        contactIds.length
          ? sb.from("contacts").select("id, first_name, last_name, email, phone, lead_temperature, pipeline_status, lead_status, score_tier, tags").in("id", contactIds)
          : Promise.resolve({ data: [] }),
        phones.length
          ? sb.from("bot_conversations").select("phone, status, ai_enabled, ai_replies_sent, last_intent, needs_human, escalation_reason, lead_captured_at").in("phone", phones)
          : Promise.resolve({ data: [] }),
      ]);

      const contactById = new Map((contacts || []).map((c: any) => [c.id, c]));
      const botByPhone = new Map((botConvs || []).map((b: any) => [b.phone, b]));

      let enriched = items.map(i => {
        const contact = i.contact_id ? contactById.get(i.contact_id) : null;
        const bot = i.phone ? botByPhone.get(i.phone) : null;
        return {
          ...i,
          contact: contact ? {
            id: contact.id,
            name: `${contact.first_name || ""} ${contact.last_name || ""}`.trim() || null,
            first_name: contact.first_name,
            last_name: contact.last_name,
            email: contact.email,
            lead_temperature: contact.lead_temperature,
            pipeline_status: contact.pipeline_status,
            score_tier: contact.score_tier,
            tags: contact.tags || [],
          } : null,
          bot: bot ? {
            status: bot.status,
            ai_enabled: bot.ai_enabled,
            replies_sent: bot.ai_replies_sent,
            last_intent: bot.last_intent,
            needs_human: bot.needs_human,
            escalation_reason: bot.escalation_reason,
            lead_captured: !!bot.lead_captured_at,
          } : null,
        };
      });

      // Filter
      if (search) {
        enriched = enriched.filter(e =>
          (e.contact?.name || "").toLowerCase().includes(search) ||
          (e.contact?.email || "").toLowerCase().includes(search) ||
          (e.email || "").toLowerCase().includes(search) ||
          (e.phone || "").includes(search) ||
          (e.last_body || "").toLowerCase().includes(search)
        );
      }
      if (filter === "unread" || filter === "awaiting_reply") {
        enriched = enriched.filter(e => e.awaiting_reply);
      } else if (filter === "hot") {
        enriched = enriched.filter(e => e.contact?.lead_temperature === "hot" || e.bot?.last_intent === "hot_lead");
      } else if (filter === "escalated") {
        enriched = enriched.filter(e => e.bot?.status === "escalated" || e.bot?.needs_human);
      } else if (filter === "bot_handled") {
        enriched = enriched.filter(e => e.bot && (e.bot.replies_sent || 0) > 0);
      } else if (filter === "unmatched") {
        enriched = enriched.filter(e => !e.contact_id);
      }

      enriched.sort((a, b) => (b.last_message_at || "").localeCompare(a.last_message_at || ""));
      return ok({
        success: true,
        conversations: enriched.slice(0, limit),
        total: enriched.length,
      });
    }

    // =================================================================
    // GET THREAD - full message timeline for one conversation
    // =================================================================
    if (action === "get_thread") {
      const contactId = body.contact_id || null;
      const phone = body.phone || null;
      /* Third thread key. list_conversations groups an email with no contact as
       * `e:<address>` and leaves phone null, so those rows listed fine and then
       * failed to open with "contact_id or phone required" — including every
       * system notification from the health monitor. The "Unmatched" filter chip
       * selects for exactly this state, so it was reachable by design. */
      const email = String(body.email || "").trim().toLowerCase() || null;
      if (!contactId && !phone && !email) return err("contact_id, phone or email required");

      const phoneL10 = phone ? last10(phone) : null;
      const sinceClause = body.since ? new Date(body.since).toISOString() : new Date(Date.now() - 365 * 86400000).toISOString();

      /* Every axis below is either constrained or returns nothing. An axis with
       * no applicable filter used to fall through UNFILTERED: opening an
       * unmatched-by-phone conversation ran the email query with no contact_id
       * and no else-branch, so the last 200 emails in the CRM — every borrower —
       * were interleaved into that one stranger's thread. Adding a third key
       * without closing this would have done the same for the SMS and call
       * queries. NONE is not an optimisation; it is the guard. */
      const NONE = Promise.resolve({ data: [] });

      // SMS — by contact, else by phone. An email-only thread has no SMS axis.
      const smsBase = () => sb.from("sms_log")
        .select("id, direction, from_phone, to_phone, body, status, twilio_sid, contact_id, trigger_type, error_message, created_at")
        .gte("created_at", sinceClause)
        .order("created_at", { ascending: true })
        .limit(500);
      const smsQ = contactId ? smsBase().eq("contact_id", contactId)
        : phoneL10 ? smsBase().or(`from_phone.ilike.%${phoneL10}%,to_phone.ilike.%${phoneL10}%`)
        : NONE;

      // Email — by contact, else by recipient address.
      const emailBase = () => sb.from("email_log")
        .select("id, recipient_email:to_email, recipient_name:to_name, subject, body:body_text, status, contact_id, sent_at, opened_at, created_at")
        .gte("created_at", sinceClause)
        .order("created_at", { ascending: true })
        .limit(200);
      const emailQ = contactId ? emailBase().eq("contact_id", contactId)
        : email ? emailBase().ilike("to_email", email)
        : NONE;

      // Calls — by contact, else by phone.
      const callsBase = () => sb.from("calls_log")
        .select("*")
        .gte("created_at", sinceClause)
        .order("created_at", { ascending: true })
        .limit(100);
      const callsQ = contactId ? callsBase().eq("contact_id", contactId)
        : phoneL10 ? callsBase().or(`from_phone.ilike.%${phoneL10}%,to_phone.ilike.%${phoneL10}%`)
        : NONE;

      // Bot decisions (so we can surface AI vs human and reasoning)
      let botQ;
      if (phone) {
        const { data: bc } = await sb.from("bot_conversations").select("id").eq("phone", normalizePhone(phone)).maybeSingle();
        if (bc?.id) botQ = sb.from("bot_decisions").select("id, action, decision_reason, inbound_body, inbound_intent, reply_body, tools_called, ai_tokens_in, ai_tokens_out, created_at").eq("conversation_id", bc.id).order("created_at", { ascending: true }).limit(200);
      }
      if (!botQ && contactId) {
        const { data: bc } = await sb.from("bot_conversations").select("id").eq("contact_id", contactId).maybeSingle();
        if (bc?.id) botQ = sb.from("bot_decisions").select("id, action, decision_reason, inbound_body, inbound_intent, reply_body, tools_called, ai_tokens_in, ai_tokens_out, created_at").eq("conversation_id", bc.id).order("created_at", { ascending: true }).limit(200);
      }

      const [smsRes, emailRes, callsRes, botRes, contactRes, botConvRes] = await Promise.all([
        smsQ, emailQ, callsQ,
        botQ || Promise.resolve({ data: [] }),
        contactId ? sb.from("contacts").select("id, first_name, last_name, email, phone, secondary_phone, city, lead_temperature, pipeline_status, score_tier, tags, target_purchase_price, target_loan_amount, fico_band, source").eq("id", contactId).maybeSingle() : Promise.resolve({ data: null }),
        phone ? sb.from("bot_conversations").select("*").eq("phone", normalizePhone(phone)).maybeSingle() : Promise.resolve({ data: null }),
      ]);

      // Build interleaved timeline
      type Item = { type: string; ts: string; data: any };
      const items: Item[] = [];
      for (const m of (smsRes.data || [])) items.push({ type: "sms", ts: m.created_at, data: m });
      for (const m of (emailRes.data || [])) items.push({ type: "email", ts: m.created_at, data: m });
      for (const m of (callsRes.data || [])) items.push({ type: "call", ts: m.created_at, data: m });
      // Bot decisions intermix as system events alongside the SMS they refer to.
      // We don't double-count the reply itself — just expose the decision metadata so the UI can show "\ud83e\udd16 AI used calculate_mortgage" badges.
      for (const m of (botRes.data || [])) items.push({ type: "bot_decision", ts: m.created_at, data: m });

      items.sort((a, b) => a.ts.localeCompare(b.ts));

      return ok({
        success: true,
        contact: contactRes.data || null,
        bot_conversation: botConvRes.data || null,
        timeline: items,
        counts: {
          sms: (smsRes.data || []).length,
          email: (emailRes.data || []).length,
          calls: (callsRes.data || []).length,
          bot_decisions: (botRes.data || []).length,
        },
      });
    }

    // =================================================================
    // SEND SMS - LO replies from CRM (bot pauses for this convo)
    // =================================================================
    if (action === "send_sms") {
      const phone = body.phone;
      const message = body.message;
      const contactId = body.contact_id || null;
      const pauseBot = body.pause_bot !== false;  // default true
      if (!phone || !message) return err("phone and message required");

      const r = await fetch(`${SUPABASE_URL}/functions/v1/sms-service`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({
          trigger: "custom",
          to_phone: phone,
          params: { message },
          contact_id: contactId || undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok) return err(data.error || `sms-service ${r.status}`, r.status);

      // Mark as human-sent
      if (data.sid) {
        await sb.from("sms_log").update({ trigger_type: "crm_human_reply" }).eq("twilio_sid", data.sid).then(() => {}, () => {});
      }

      // Pause bot for this conversation if requested
      if (pauseBot) {
        const normalized = normalizePhone(phone);
        await sb.from("bot_conversations").update({
          ai_enabled: false, status: "paused",
          escalation_reason: "LO took over from CRM",
        }).eq("phone", normalized);
      }

      return ok({ success: true, sid: data.sid, bot_paused: pauseBot });
    }

    // =================================================================
    // SEND EMAIL - LO replies from CRM
    // =================================================================
    if (action === "send_email") {
      const recipient = body.email;
      const subject = body.subject;
      const html = body.html || body.body;
      const contactId = body.contact_id || null;
      if (!recipient || !subject || !html) return err("email, subject, body required");

      const r = await fetch(`${SUPABASE_URL}/functions/v1/email-service`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({
          action: "send_email",
          recipient_email: recipient,
          subject,
          html,
          contact_id: contactId || undefined,
          source: "crm_communications",
        }),
      });
      const data = await r.json();
      if (!r.ok) return err(data.error || `email-service ${r.status}`, r.status);
      return ok({ success: true, ...data });
    }

    // =================================================================
    // PAUSE / RESUME / RESOLVE BOT
    // =================================================================
    if (action === "pause_bot" || action === "resume_bot" || action === "mark_resolved") {
      const phone = body.phone;
      const contactId = body.contact_id;
      if (!phone && !contactId) return err("phone or contact_id required");
      const updates: any = {};
      if (action === "pause_bot") { updates.ai_enabled = false; updates.status = "paused"; }
      if (action === "resume_bot") { updates.ai_enabled = true; updates.status = "active"; updates.needs_human = false; updates.escalation_reason = null; }
      if (action === "mark_resolved") { updates.status = "resolved"; updates.resolved_at = new Date().toISOString(); }
      let q = sb.from("bot_conversations").update(updates);
      if (phone) q = q.eq("phone", normalizePhone(phone));
      else q = q.eq("contact_id", contactId);
      const { data, error } = await q.select("*");
      if (error) return err(error.message);
      return ok({ success: true, updated: data });
    }

    // =================================================================
    // ASSIGN UNMATCHED PHONE TO EXISTING CONTACT
    // =================================================================
    if (action === "assign_to_contact") {
      const phone = body.phone;
      const contactId = body.contact_id;
      if (!phone || !contactId) return err("phone and contact_id required");
      const normalized = normalizePhone(phone);
      const phoneL10 = last10(phone);

      // Update contact phone if blank, else set secondary
      const { data: contact } = await sb.from("contacts").select("phone, secondary_phone").eq("id", contactId).single();
      if (contact && !contact.phone) {
        await sb.from("contacts").update({ phone: normalized, updated_at: new Date().toISOString() }).eq("id", contactId);
      } else if (contact && contact.phone !== normalized && !contact.secondary_phone) {
        await sb.from("contacts").update({ secondary_phone: normalized, updated_at: new Date().toISOString() }).eq("id", contactId);
      }

      // Backfill all existing logs
      await sb.from("sms_log").update({ contact_id: contactId }).is("contact_id", null).or(`from_phone.ilike.%${phoneL10}%,to_phone.ilike.%${phoneL10}%`);
      await sb.from("calls_log").update({ contact_id: contactId }).is("contact_id", null).or(`from_phone.ilike.%${phoneL10}%,to_phone.ilike.%${phoneL10}%`).then(() => {}, () => {});
      await sb.from("bot_conversations").update({ contact_id: contactId }).eq("phone", normalized);
      await sb.from("twilio_inbound").update({ contact_id: contactId, matched_contact: true }).is("contact_id", null).ilike("from_phone", `%${phoneL10}%`).then(() => {}, () => {});

      return ok({ success: true, contact_id: contactId, phone: normalized });
    }

    // =================================================================
    // CREATE BRAND-NEW CONTACT FROM UNMATCHED CONVERSATION
    // =================================================================
    if (action === "create_contact_from_phone") {
      const phone = body.phone;
      if (!phone) return err("phone required");
      const normalized = normalizePhone(phone);
      const phoneL10 = last10(phone);

      const { data: existing } = await sb.from("contacts").select("id").or(`phone.eq.${normalized},secondary_phone.eq.${normalized}`).maybeSingle();
      if (existing?.id) {
        // Already exists — just attach
        await sb.from("sms_log").update({ contact_id: existing.id }).is("contact_id", null).or(`from_phone.ilike.%${phoneL10}%,to_phone.ilike.%${phoneL10}%`);
        await sb.from("bot_conversations").update({ contact_id: existing.id }).eq("phone", normalized);
        return ok({ success: true, contact_id: existing.id, created: false });
      }

      const { data: created, error } = await sb.from("contacts").insert({
        first_name: body.first_name || "Unknown",
        last_name: body.last_name || null,
        email: body.email || null,
        phone: normalized,
        source: "crm_communications",
        funnel_source: "sms_inbound",
        lead_status: "new",
        pipeline_status: "new_lead",
        sms_opt_in: true,
        tags: ["crm_assigned"],
      }).select("id").single();
      if (error) return err(error.message);

      await sb.from("sms_log").update({ contact_id: created!.id }).is("contact_id", null).or(`from_phone.ilike.%${phoneL10}%,to_phone.ilike.%${phoneL10}%`);
      await sb.from("bot_conversations").update({ contact_id: created!.id }).eq("phone", normalized);
      return ok({ success: true, contact_id: created!.id, created: true });
    }

    // =================================================================
    // STATS - inbox header counts
    // =================================================================
    if (action === "stats") {
      const dayAgo = new Date(Date.now() - 86400000).toISOString();
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const [{ count: sms24 }, { count: smsIn24 }, { count: email24 }, { count: calls24 }, { count: botReplies24 }, { count: botConvs }, { data: botEsc }] = await Promise.all([
        sb.from("sms_log").select("id", { count: "exact", head: true }).gte("created_at", dayAgo),
        sb.from("sms_log").select("id", { count: "exact", head: true }).eq("direction", "inbound").gte("created_at", dayAgo),
        sb.from("email_log").select("id", { count: "exact", head: true }).gte("created_at", dayAgo),
        sb.from("calls_log").select("id", { count: "exact", head: true }).gte("created_at", dayAgo),
        sb.from("bot_decisions").select("id", { count: "exact", head: true }).eq("action", "ai_reply").gte("created_at", weekAgo),
        sb.from("bot_conversations").select("id", { count: "exact", head: true }).eq("status", "active"),
        sb.from("bot_conversations").select("id, phone, contact_id, escalation_reason").eq("status", "escalated"),
      ]);
      return ok({
        success: true,
        sms_24h: sms24 || 0,
        sms_inbound_24h: smsIn24 || 0,
        emails_24h: email24 || 0,
        calls_24h: calls24 || 0,
        bot_replies_7d: botReplies24 || 0,
        bot_active_conversations: botConvs || 0,
        escalations: botEsc || [],
      });
    }

    return err(`Unknown action: ${action}. Valid: list_conversations, get_thread, send_sms, send_email, pause_bot, resume_bot, mark_resolved, assign_to_contact, create_contact_from_phone, stats`);
  } catch (e: any) {
    console.error("[communications-admin] error:", e);
    return err(e?.message || String(e), 500);
  }
});

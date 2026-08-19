// bot-admin: API endpoints for the AI Agent control panel in the CRM.
//
// Actions:
//   get_settings       - returns current bot_settings + summary stats
//   update_settings    - update any bot_settings fields
//   get_conversations  - list bot conversations with filters
//   get_decisions      - audit log of every decision the bot made
//   pause_conversation - flip ai_enabled=false for one conversation
//   resume_conversation- flip back
//   escalate_conversation - mark for human handoff
//   get_metrics        - reply count, tools used, leads captured, etc.
//   test_message       - run a hypothetical message through the bot without sending
//   reset_test_data    - clears bot_decisions + conversations for a phone (for testing)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const body = await req.json();
    const action = (body.action || "").toLowerCase();

    if (action === "get_settings") {
      const { data: settings } = await sb.from("bot_settings").select("*").eq("id", "default").single();
      // Stats for the past 7 days
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const [{ count: totalConvs }, { count: activeConvs }, { count: weekDecisions }, { count: weekReplies }, { count: weekLeads }, { count: weekSearches }] = await Promise.all([
        sb.from("bot_conversations").select("id", { count: "exact", head: true }),
        sb.from("bot_conversations").select("id", { count: "exact", head: true }).eq("status", "active"),
        sb.from("bot_decisions").select("id", { count: "exact", head: true }).gte("created_at", weekAgo),
        sb.from("bot_decisions").select("id", { count: "exact", head: true }).gte("created_at", weekAgo).eq("action", "ai_reply"),
        sb.from("bot_conversations").select("id", { count: "exact", head: true }).gte("lead_captured_at", weekAgo),
        sb.from("saved_searches").select("id", { count: "exact", head: true }).eq("source", "ai_sms_bot").gte("created_at", weekAgo),
      ]);
      return ok({
        success: true,
        settings,
        stats_7day: {
          total_conversations: totalConvs || 0,
          active_conversations: activeConvs || 0,
          decisions_logged: weekDecisions || 0,
          ai_replies_sent: weekReplies || 0,
          leads_captured: weekLeads || 0,
          searches_saved: weekSearches || 0,
        },
      });
    }

    if (action === "update_settings") {
      const allowed = [
        "enabled", "business_hours_start", "business_hours_end", "business_days",
        "max_replies_per_hour", "max_replies_per_day", "cooldown_seconds_between_replies",
        "escalate_on_keywords", "escalate_after_messages", "max_reply_length",
        "always_include_disclaimer", "ai_model", "ai_max_tokens", "use_guidelines_for_questions",
        "notify_rene_on_hot_lead", "notify_rene_on_scheduling", "notify_rene_on_escalation",
        "notify_rene_on_every_inbound", "rene_notification_phone",
        "welcome_message_enabled", "welcome_message_text",
        "proactive_checkins_enabled", "proactive_checkin_min_days",
        "proactive_checkin_max_per_lead_per_month",
        "proactive_quiet_hours_start", "proactive_quiet_hours_end",
        "lead_capture_enabled", "lead_capture_after_n_messages",
      ];
      const updates: any = { updated_at: new Date().toISOString() };
      for (const k of allowed) if (body[k] !== undefined) updates[k] = body[k];
      const { data, error } = await sb.from("bot_settings").update(updates).eq("id", "default").select("*").single();
      if (error) return err(error.message, 400);
      return ok({ success: true, settings: data });
    }

    if (action === "get_conversations") {
      const status = body.status || null;
      const limit = Math.min(parseInt(body.limit) || 50, 200);
      let q = sb.from("bot_conversations")
        .select("id, phone, contact_id, status, ai_enabled, total_messages_in, total_messages_out, ai_replies_sent, last_inbound_at, last_outbound_at, last_intent, lead_captured_at, escalation_reason, discovery_state, created_at, contacts(first_name, last_name, email, pipeline_status, lead_temperature)")
        .order("last_inbound_at", { ascending: false, nullsFirst: false })
        .limit(limit);
      if (status) q = q.eq("status", status);
      const { data } = await q;
      return ok({ success: true, conversations: data || [], count: (data || []).length });
    }

    if (action === "get_decisions") {
      const limit = Math.min(parseInt(body.limit) || 50, 200);
      const conversation_id = body.conversation_id;
      const phone = body.phone;
      let q = sb.from("bot_decisions")
        .select("id, conversation_id, contact_id, inbound_body, inbound_intent, action, decision_reason, reply_body, reply_sent_at, ai_tokens_in, ai_tokens_out, tools_called, ai_used_guidelines, metadata, created_at, contacts(first_name, last_name)")
        .order("created_at", { ascending: false }).limit(limit);
      if (conversation_id) q = q.eq("conversation_id", conversation_id);
      if (phone) {
        const last10 = phone.replace(/\D/g, "").slice(-10);
        const { data: convs } = await sb.from("bot_conversations").select("id").ilike("phone", `%${last10}%`);
        const ids = (convs || []).map(c => c.id);
        if (ids.length) q = q.in("conversation_id", ids);
      }
      const { data } = await q;
      return ok({ success: true, decisions: data || [] });
    }

    if (action === "pause_conversation") {
      if (!body.conversation_id) return err("conversation_id required");
      await sb.from("bot_conversations").update({
        ai_enabled: false, status: "paused",
      }).eq("id", body.conversation_id);
      return ok({ success: true, conversation_id: body.conversation_id, ai_enabled: false });
    }

    if (action === "resume_conversation") {
      if (!body.conversation_id) return err("conversation_id required");
      await sb.from("bot_conversations").update({
        ai_enabled: true, status: "active",
        escalation_reason: null, escalated_at: null,
      }).eq("id", body.conversation_id);
      return ok({ success: true, conversation_id: body.conversation_id, ai_enabled: true });
    }

    if (action === "escalate_conversation") {
      if (!body.conversation_id) return err("conversation_id required");
      await sb.from("bot_conversations").update({
        status: "escalated", ai_enabled: false, needs_human: true,
        escalation_reason: body.reason || "manually escalated by Rene",
        escalated_at: new Date().toISOString(),
      }).eq("id", body.conversation_id);
      return ok({ success: true });
    }

    if (action === "resolve_conversation") {
      if (!body.conversation_id) return err("conversation_id required");
      await sb.from("bot_conversations").update({
        status: "resolved", resolved_at: new Date().toISOString(),
      }).eq("id", body.conversation_id);
      return ok({ success: true });
    }

    if (action === "get_metrics") {
      const days = Math.min(parseInt(body.days) || 7, 90);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const [decisions, convs] = await Promise.all([
        sb.from("bot_decisions").select("action, ai_tokens_in, ai_tokens_out, tools_called, created_at").gte("created_at", since),
        sb.from("bot_conversations").select("id, status, ai_replies_sent, lead_captured_at, created_at, total_messages_in").gte("created_at", since),
      ]);
      const all = decisions.data || [];
      const byAction: Record<string, number> = {};
      const toolUsage: Record<string, number> = {};
      let totalIn = 0, totalOut = 0;
      for (const d of all) {
        byAction[d.action] = (byAction[d.action] || 0) + 1;
        totalIn += d.ai_tokens_in || 0;
        totalOut += d.ai_tokens_out || 0;
        for (const t of (d.tools_called || [])) toolUsage[t] = (toolUsage[t] || 0) + 1;
      }
      return ok({
        success: true,
        days,
        decisions_total: all.length,
        actions: byAction,
        tools_used: toolUsage,
        ai_tokens: { input: totalIn, output: totalOut },
        approx_cost_usd: (totalIn * 3 / 1_000_000) + (totalOut * 15 / 1_000_000),
        conversations: {
          total: (convs.data || []).length,
          active: (convs.data || []).filter(c => c.status === "active").length,
          escalated: (convs.data || []).filter(c => c.status === "escalated").length,
          resolved: (convs.data || []).filter(c => c.status === "resolved").length,
          leads_captured: (convs.data || []).filter(c => c.lead_captured_at).length,
        },
      });
    }

    if (action === "reset_test_data") {
      const phone = body.phone;
      if (!phone) return err("phone required");
      const last10 = phone.replace(/\D/g, "").slice(-10);
      const { data: convs } = await sb.from("bot_conversations").select("id").ilike("phone", `%${last10}%`);
      const ids = (convs || []).map(c => c.id);
      if (ids.length) {
        await sb.from("bot_decisions").delete().in("conversation_id", ids);
        await sb.from("bot_conversations").delete().in("id", ids);
      }
      return ok({ success: true, deleted_conversations: ids.length });
    }

    return err(`Unknown action: ${action}. Valid: get_settings, update_settings, get_conversations, get_decisions, pause_conversation, resume_conversation, escalate_conversation, resolve_conversation, get_metrics, reset_test_data`);
  } catch (e: any) {
    console.error("[bot-admin] error:", e);
    return err(e?.message || String(e), 500);
  }
});

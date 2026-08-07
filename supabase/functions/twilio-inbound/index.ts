// twilio-inbound v30: inbound-reply notifications to Rene.
import { verifyTwilioRequest, twilioForbidden } from "../_shared/twilio-signature.ts";
//   On a MATCHED contact (non-opt-out) we now generate a 1-line AI summary (claude-haiku-4-5),
//   call the notify_inbound_reply RPC (inserts the dashboard bell app_notifications row AND
//   returns { owner_cell, sms_text, deep_link, contact_name, enabled }), and text Rene ONE
//   message (summary + deep link) via the existing sendForwardSMS Twilio path — replacing the
//   old plain forward for matched contacts. Unmatched numbers and opt_out keep the plain forward
//   (RPC needs a contact_id; we skip notifying on STOP). The whole notify block is fully guarded
//   so it can never break inbound handling or the lead auto-response.
// v29: removed phantom fallback number +18668561897 (Rene doesn't own it).
// SMS-forward fallback now aligns with the real business line +18668919394 (same as sms-service
// / twilio-voice / click-to-call). TWILIO_PHONE_NUMBER env still overrides if set.
// v28: writes raw webhook payload to webhook_debug FIRST, then proceeds.
// This way if anything fails downstream, we still see exactly what Twilio sent us.
// Also adds explicit step-by-step logging so silent failures become visible.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RENE_FORWARD_PHONE = "+17144728508";
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function last10(p: string): string {
  return (p || "").replace(/\D/g, "").slice(-10);
}

function classifyIntent(body: string): { intent: string; confidence: string } {
  const lower = (body || "").toLowerCase().trim();
  if (/^(stop|unsubscribe|quit|cancel|end|optout|opt out|stopall|remove)\b/.test(lower)) return { intent: "opt_out", confidence: "high" };
  if (/^(start|unstop|yes subscribe)\b/.test(lower)) return { intent: "opt_in", confidence: "high" };
  if (/(call me|schedule|appointment|book|when can|set up a|free time|available|meet)/.test(lower)) return { intent: "scheduling", confidence: "high" };
  if (/^(yes|interested|ready|sure|let's|lets|sounds good|sign me up|i'm in|im in)\b/.test(lower) && lower.length < 60) return { intent: "hot_lead", confidence: "high" };
  if (/\?/.test(body) || /(what|when|how|why|do you|can i|rate|fha|va|usda|fico|score|qualify|approve|preapproval|down ?payment|dti|ltv|pmi|mip|jumbo|conv)/i.test(lower)) return { intent: "question", confidence: "medium" };
  if (/^(thanks?|thank you|appreciate|got it|received|ok|okay|cool|nice|awesome|gotcha|k)\b/.test(lower) && lower.length < 30) return { intent: "acknowledgement", confidence: "medium" };
  return { intent: "general", confidence: "low" };
}

async function sendForwardSMS(to: string, body: string) {
  try {
    const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
    const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
    const TWILIO_FROM = Deno.env.get("TWILIO_PHONE_NUMBER") || "+18668919394";
    if (!TWILIO_SID || !TWILIO_TOKEN) return false;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body }),
    });
    return res.ok;
  } catch { return false; }
}

async function fireAiBot(payload: any) {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/ai-sms-bot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify(payload),
    });
  } catch (e: any) {
    console.error("[twilio-inbound] ai-sms-bot dispatch failed:", e.message);
  }
}

// One-line AI summary of the lead's inbound text for the loan officer.
// Cheap haiku call; returns null on any failure so notify_inbound_reply falls back to the raw message.
async function summarizeInbound(body: string): Promise<string | null> {
  try {
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) return null;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 60,
        system: "Summarize this lead's inbound text message in ONE short line (max ~12 words) for a busy loan officer. No preamble, no quotes, no emoji — just the summary line.",
        messages: [{ role: "user", content: (body || "").substring(0, 1000) }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const txt = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").trim();
    return txt || null;
  } catch { return null; }
}

// Matched-contact inbound notification: summary -> notify_inbound_reply RPC (dashboard bell +
// returns owner cell text) -> ONE SMS to Rene's cell via the existing Twilio path.
// Never throws — returns a stepLog tag describing the outcome.
async function notifyReneInbound(contactId: string, body: string): Promise<string> {
  try {
    let summary: string | null = null;
    try { summary = await summarizeInbound(body); } catch { summary = null; }

    const { data, error } = await sb.rpc("notify_inbound_reply", {
      p_contact_id: contactId,
      p_message: body,
      p_summary: summary,
    });
    if (error) return `notify_rpc_err:${(error.message || "").substring(0, 50)}`;

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return "notify_no_row";
    if (row.enabled !== true) return "notify_disabled";
    if (!row.owner_cell || !row.sms_text) return "notify_missing_fields";

    const ok = await sendForwardSMS(row.owner_cell, row.sms_text);
    return `notify_${ok ? "sent" : "send_failed"}`;
  } catch (e: any) {
    return `notify_throw:${(e?.message || String(e)).substring(0, 40)}`;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  const stepLog: string[] = [];
  let errorMsg: string | null = null;
  let rawText = "";
  let parsedParams: any = {};
  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) headers[k] = v;

  try {
    rawText = await req.text();
    stepLog.push("got_body");
    /* SIGNATURE FIRST. This is the SMS webhook for +18668919394 and
     * +17149092526. Everything below trusts From= to identify a contact and to
     * record opt-outs, so an unsigned caller could suppress any number or
     * fabricate inbound traffic. */
    const sig = await verifyTwilioRequest(req, rawText, { authToken: Deno.env.get("TWILIO_AUTH_TOKEN") || "", testKey: Deno.env.get("SMS_TEST_KEY") || "" });
    if (!sig.ok) {
      console.error("[twilio-inbound] REJECTED:", sig.reason, "url=", sig.url);
      return twilioForbidden();
    }
    const params = new URLSearchParams(rawText);
    parsedParams = Object.fromEntries(params.entries());
    stepLog.push(`parsed_${Object.keys(parsedParams).length}_params`);

    const fromRaw = params.get("From") || "";
    const toRaw = params.get("To") || "";
    const body = params.get("Body") || "";
    const sid = params.get("MessageSid") || "";
    const numMedia = parseInt(params.get("NumMedia") || "0", 10);
    const mediaUrl = numMedia > 0 ? params.get("MediaUrl0") : null;

    console.log(`[inbound] from=${fromRaw} body="${body.substring(0, 80)}"`);

    if (!fromRaw || !body) {
      stepLog.push("empty_payload");
      errorMsg = "empty from or body";
      // Still log to webhook_debug below
      throw new Error("empty from or body");
    }

    const fromL10 = last10(fromRaw);
    stepLog.push(`norm_${fromL10}`);

    // Lookup contact — simpler query (the .or() with ilike + percent had been failing)
    let contact: any = null;
    try {
      const { data, error: contactErr } = await sb.from("contacts")
        .select("id, first_name, last_name, email, phone, secondary_phone, sms_opt_in, last_contact_date")
        .or(`phone.ilike.%${fromL10.slice(-7)}%,secondary_phone.ilike.%${fromL10.slice(-7)}%`)
        .limit(1)
        .maybeSingle();
      if (contactErr) {
        stepLog.push(`contact_lookup_err:${contactErr.message.substring(0, 50)}`);
      } else {
        contact = data;
        stepLog.push(`contact_${contact ? "found_" + contact.id : "unmatched"}`);
      }
    } catch (e: any) {
      stepLog.push(`contact_throw:${(e?.message || "").substring(0, 50)}`);
    }

    const { intent, confidence } = classifyIntent(body);
    stepLog.push(`intent_${intent}`);
    const matched = !!contact;
    const senderName = contact?.first_name
      ? `${contact.first_name}${contact.last_name ? " " + contact.last_name : ""}`
      : `Unknown (${fromRaw})`;

    // INSERT to twilio_inbound
    const { error: tiErr } = await sb.from("twilio_inbound").insert({
      from_phone: fromRaw, to_phone: toRaw, body, twilio_sid: sid,
      contact_id: contact?.id || null, matched_contact: matched,
    });
    if (tiErr) {
      stepLog.push(`twilio_inbound_err:${tiErr.message.substring(0, 60)}`);
    } else {
      stepLog.push("twilio_inbound_ok");
    }

    // INSERT to sms_log
    let smsLogId: string | null = null;
    const { data: smsLogRow, error: slErr } = await sb.from("sms_log").insert({
      from_phone: fromRaw, to_phone: toRaw,
      to_name: contact?.first_name || null,
      body, direction: "inbound", twilio_sid: sid,
      contact_id: contact?.id || null, status: "received",
      trigger_type: "inbound_reply", media_url: mediaUrl,
    }).select("id").single();
    if (slErr) {
      stepLog.push(`sms_log_err:${slErr.message.substring(0, 80)}`);
      console.error("sms_log insert failed:", slErr);
    } else {
      smsLogId = smsLogRow?.id || null;
      stepLog.push(`sms_log_ok_${smsLogId?.substring(0, 8)}`);
    }

    // INSERT to activity_events
    const { error: aeErr } = await sb.from("activity_events").insert({
      contact_id: contact?.id || null,
      type: "sms", channel: "sms", direction: "inbound",
      title: matched ? `SMS reply from ${contact.first_name || senderName}` : `Unmatched SMS from ${fromRaw}`,
      description: body,
      sms_body: body, sms_from: fromRaw, sms_to: toRaw,
      status: "received",
      metadata: JSON.stringify({
        twilio_sid: sid, intent, intent_confidence: confidence,
        unmatched: !matched, media_url: mediaUrl,
      }),
      created_at: new Date().toISOString(),
    });
    if (aeErr) {
      stepLog.push(`activity_err:${aeErr.message.substring(0, 60)}`);
    } else {
      stepLog.push("activity_ok");
    }

    /* OPT-OUT — recorded for the NUMBER, with or without a contact.
     *
     * This used to require `contact?.id`, so a STOP from a number nobody had a
     * record for was classified opt_out and then thrown away. Nothing anywhere
     * remembered it, and if that number was later added as a contact it arrived
     * opted in. sms_record_optout() writes the contact-independent suppression
     * row AND flips any contacts already holding the number, so the two lists
     * cannot drift apart. */
    if (intent === "opt_out") {
      try {
        const { data: sup } = await sb.rpc("sms_record_optout", {
          p_phone: fromRaw, p_source: "twilio-inbound", p_body: body,
        });
        stepLog.push(`optout_suppressed:${JSON.stringify(sup)?.slice(0, 60)}`);
      } catch (e: any) {
        stepLog.push(`optout_err:${e?.message?.substring(0, 40)}`);
      }
      if (contact?.id) {
        await sb.from("contacts").update({
          last_contact_date: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", contact.id).then(
          () => stepLog.push("last_contact_set"),
          (e: any) => stepLog.push(`lc_err:${e?.message?.substring(0, 40)}`),
        );
      }
    } else if (contact?.id) {
      await sb.from("contacts").update({
        last_contact_date: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", contact.id).then(
        () => stepLog.push("last_contact_set"),
        (e: any) => stepLog.push(`last_contact_err:${e?.message?.substring(0,40)}`),
      );
    }

    // Fire the AI bot first (non-awaited) so notifying Rene never delays the lead auto-response.
    fireAiBot({
      contact_id: contact?.id || null,
      phone: fromRaw,
      message_body: body,
      intent, intent_confidence: confidence,
      sms_log_id: smsLogId,
    }).then(() => stepLog.push("bot_dispatched"))
      .catch(() => stepLog.push("bot_dispatch_err"));

    // Notify Rene of the inbound reply.
    //   MATCHED + not opt-out -> ONE rich text (AI summary + deep link) via notify_inbound_reply
    //     (which ALSO inserts the dashboard bell app_notifications row). Replaces the plain forward.
    //   Unmatched # or opt-out -> keep the plain forward (RPC needs a contact_id; skip notifying on STOP).
    // Awaited but fully guarded (never throws) so the bell + text reliably fire without the
    // isolate being frozen after the response — inbound handling already completed and the bot
    // was already dispatched above, so this can't break either.
    if (contact?.id && intent !== "opt_out") {
      const tag = await notifyReneInbound(contact.id, body);
      stepLog.push(tag);
    } else {
      const intentEmoji: Record<string, string> = {
        opt_out: "🚫", hot_lead: "🔥", scheduling: "📅",
        question: "❓", acknowledgement: "✅", opt_in: "✅", general: "💬",
      };
      const emoji = intentEmoji[intent] || "💬";
      const truncBody = body.length > 100 ? body.substring(0, 100) + "…" : body;
      const forwardMsg = `${emoji} ${senderName} replied:\n"${truncBody}"\n\nIntent: ${intent}${matched ? "" : " (unmatched #)"}\n\nAI bot is handling. Open CRM → Communications`;
      sendForwardSMS(RENE_FORWARD_PHONE, forwardMsg)
        .then(ok => stepLog.push(`forward_${ok ? "sent" : "failed"}`))
        .catch(() => stepLog.push("forward_throw"));
    }

    stepLog.push("done");
  } catch (e: any) {
    errorMsg = e?.message || String(e);
    stepLog.push(`fatal:${(errorMsg || "").substring(0, 80)}`);
    console.error("twilio-inbound fatal:", e);
  }

  // ALWAYS write to webhook_debug, even on success, so we can audit
  await sb.from("webhook_debug").insert({
    source: "twilio-inbound",
    raw_body: rawText.substring(0, 4000),
    parsed_params: parsedParams,
    headers,
    step_log: stepLog,
    error: errorMsg,
  }).then(undefined, (e: any) => console.error("webhook_debug insert failed:", e));

  return new Response(TWIML_EMPTY, { headers: { "Content-Type": "text/xml" } });
});

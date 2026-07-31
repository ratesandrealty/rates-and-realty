// bot-process-queue: runs every minute. When quiet hours have ended, processes any
// bot_queued_replies whose scheduled_for <= now and not yet processed. Calls back into
// ai-sms-bot with processing_queued=true so the bot answers as if the message just arrived
// (without re-counting it as a new inbound).

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, "Content-Type": "application/json" } });

  // Pull pending items whose scheduled time has passed
  const { data: queue } = await sb.from("bot_queued_replies")
    .select("*")
    .eq("status", "pending")
    .lte("scheduled_for", new Date().toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(20);

  if (!queue || queue.length === 0) {
    return ok({ message: "No queued replies due", processed: 0 });
  }

  const results: any[] = [];

  // Group by phone so we only process the LATEST message per phone (so the bot replies once,
  // not 5 times if someone sent 5 messages overnight).
  const byPhone = new Map<string, any[]>();
  for (const item of queue) {
    const arr = byPhone.get(item.phone) || [];
    arr.push(item);
    byPhone.set(item.phone, arr);
  }

  for (const [phone, items] of byPhone.entries()) {
    // Sort by created_at, take latest as the one to actually answer
    items.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const latest = items[items.length - 1];
    const olderIds = items.slice(0, -1).map(i => i.id);

    // Mark older ones as superseded (still record they existed)
    if (olderIds.length) {
      await sb.from("bot_queued_replies").update({
        status: "superseded", processed_at: new Date().toISOString(),
      }).in("id", olderIds);
    }

    // Mark latest as processing
    await sb.from("bot_queued_replies").update({ status: "processing" }).eq("id", latest.id);

    // Build a contextualized message body to pass to the bot — prepend a short note so the
    // bot KNOWS this is a morning catch-up and replies appropriately
    const olderCount = olderIds.length;
    const inboundForBot = olderCount > 0
      ? `[OVERNIGHT QUEUE \u2014 lead sent ${items.length} messages during quiet hours; latest below. Open with a quick "Morning! Catching up on your messages \u2014" framing then answer.]\n\n${latest.inbound_body}`
      : `[OVERNIGHT QUEUE \u2014 lead messaged during quiet hours. Open with a quick "Morning! " framing then answer.]\n\n${latest.inbound_body}`;

    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/ai-sms-bot`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({
          contact_id: latest.contact_id,
          phone: latest.phone,
          message_body: inboundForBot,
          intent: latest.inbound_intent || "general",
          intent_confidence: latest.inbound_intent_confidence || "low",
          sms_log_id: latest.sms_log_id,
          processing_queued: true,
        }),
      });
      const data = await res.json();
      await sb.from("bot_queued_replies").update({
        status: data.success ? "sent" : "error",
        processed_at: new Date().toISOString(),
      }).eq("id", latest.id);
      results.push({ phone, latest_id: latest.id, older_count: olderCount, decision: data.decision, ok: data.success });
    } catch (e: any) {
      await sb.from("bot_queued_replies").update({
        status: "error", processed_at: new Date().toISOString(),
      }).eq("id", latest.id);
      results.push({ phone, latest_id: latest.id, error: e?.message || String(e) });
    }
  }

  return ok({ processed: results.length, results });
});

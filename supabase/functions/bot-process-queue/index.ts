// bot-process-queue: runs every minute. When quiet hours have ended, processes any
// bot_queued_replies whose scheduled_for <= now and not yet processed. Calls back into
// ai-sms-bot with processing_queued=true so the bot answers as if the message just arrived
// (without re-counting it as a new inbound).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireStaff } from "../_shared/require-staff.ts";

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
  /* ── GUARDED. THIS FUNCTION SENDS SMS. ────────────────────────────────────
   *
   * verify_jwt = false and no in-function check of any kind: an unauthenticated
   * POST made the AI bot process its queue and text borrowers from the business
   * line. One of eleven senders in that state; docs/OPEN-ENDPOINTS-2026-08-11.md.
   *
   * allowInternal, NOT a session check: the ONLY caller is pg_cron job 11
   * (every minute), and net.http_post cannot hold the service key — see
   * require-staff note 3. There is no browser caller; the whole frontend was
   * grepped before this was written.
   *
   * THE JOB WAS RE-HEADERED FIRST, and confirmed working, before this guard
   * existed. It had been sending the ANON key, which requireStaff rejects, so
   * guarding first would have been a silent outage on a minutely job. Order
   * matters: with the function still open, a bad header shows up as a job that
   * still works, which is a nuisance; the other way round it is a bot that
   * stops answering borrowers and nothing says why. Verified by reading
   * net._http_response — 200 {"message":"No queued replies due"} — not by the
   * job's own 'succeeded', which only ever means the request was queued. */
  const auth = await requireStaff(req, { allowInternal: true, what: "Processing the bot queue" });
  if (!auth.ok) {
    console.error("[bot-process-queue] REJECTED:", auth.status, auth.msg);
    return new Response(JSON.stringify({ error: auth.msg || "unauthorized" }),
      { status: auth.status || 401, headers: { ...cors, "Content-Type": "application/json" } });
  }
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

// tours-send-reminders — cron-fired worker that drains queued reminders
//
// Selects all `showing_messages` rows where status='queued' AND scheduled_for <= now().
// For each, builds the right body for the trigger type and sends via sms-service / email-service.
// Marks status='sent' or 'failed'.
//
// Called every 5 minutes by pg_cron.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

async function getPublicTourBase(): Promise<string> {
  const { data } = await sb.from("app_config").select("value").eq("key", "tour_public_base_url").maybeSingle();
  if (typeof data?.value === "string" && data.value.length > 0) return data.value.replace(/[\"'`]/g, "").replace(/\/$/, "");
  return "https://beta.ratesandrealty.com/tour";
}

function formatDateForSMS(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric" });
}
function formatTimeForSMS(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", hour12: true });
}

async function buildBody(msg: any, batch: any, contact: any, publicUrl: string): Promise<{ body: string; subject?: string }> {
  const dateStr = batch.scheduled_start ? formatDateForSMS(batch.scheduled_start) : "";
  const timeStr = batch.scheduled_start ? formatTimeForSMS(batch.scheduled_start) : "";
  const firstName = contact?.first_name || "there";

  if (msg.trigger === "reminder_day_before") {
    if (msg.channel === "sms") {
      return { body: `Hey ${firstName} \u2014 quick reminder, our home tour is tomorrow ${dateStr}${timeStr ? " at " + timeStr : ""}. Itinerary: ${publicUrl}\n\nReply if you need to reschedule. Looking forward to it!\n\u2014 Rene\nReply STOP to opt out` };
    }
    return { subject: `Reminder: home tour tomorrow ${dateStr}`, body: `<p>Hey ${firstName},</p><p>Quick reminder \u2014 our home tour is tomorrow <strong>${dateStr}${timeStr ? ' at ' + timeStr : ''}</strong>.</p><p><a href="${publicUrl}" style="display:inline-block;padding:10px 20px;background:#C9A84C;color:#000;text-decoration:none;border-radius:6px;font-weight:600;">View itinerary</a></p><p>Reply if you need to reschedule.</p><p>\u2014 Rene</p>` };
  }
  if (msg.trigger === "reminder_morning_of") {
    if (msg.channel === "sms") {
      return { body: `Morning ${firstName}! Today's the day \u2014 our tour kicks off${timeStr ? " at " + timeStr : " today"}. Full itinerary: ${publicUrl}\n\nText me if anything comes up.\n\u2014 Rene\nReply STOP to opt out` };
    }
    return { subject: `Today's the day \u2014 your home tour itinerary`, body: `<p>Morning ${firstName}!</p><p>Today's the day \u2014 our tour kicks off${timeStr ? ' at <strong>' + timeStr + '</strong>' : ' today'}.</p><p><a href="${publicUrl}" style="display:inline-block;padding:10px 20px;background:#C9A84C;color:#000;text-decoration:none;border-radius:6px;font-weight:600;">View itinerary</a></p><p>Text me if anything comes up.</p><p>\u2014 Rene</p>` };
  }
  if (msg.trigger === "post_tour_followup") {
    return { body: `Hey ${firstName} \u2014 hope yesterday's tour was helpful! Any of the homes stand out? Tap any stop to leave feedback: ${publicUrl}\n\nHappy to dig deeper on any one if you're interested.\n\u2014 Rene\nReply STOP to opt out` };
  }
  return { body: `Reminder for your tour: ${publicUrl}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  try {
    const { data: queued } = await sb.from("showing_messages")
      .select("*")
      .eq("status", "queued")
      .lte("scheduled_for", new Date().toISOString())
      .order("scheduled_for", { ascending: true })
      .limit(50);

    const items = queued || [];
    if (items.length === 0) {
      return new Response(JSON.stringify({ message: "No reminders due", processed: 0 }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    const tourBase = await getPublicTourBase();
    let sent = 0, failed = 0;

    for (const msg of items) {
      try {
        const { data: batch } = await sb.from("showing_batches").select("*").eq("id", msg.batch_id).maybeSingle();
        if (!batch || batch.status === "canceled") {
          await sb.from("showing_messages").update({ status: "canceled" }).eq("id", msg.id);
          continue;
        }
        const { data: contact } = msg.contact_id ? await sb.from("contacts").select("*").eq("id", msg.contact_id).maybeSingle() : { data: null };
        const publicUrl = `${tourBase}/${batch.share_token}`;
        const { body, subject } = await buildBody(msg, batch, contact, publicUrl);

        if (msg.channel === "sms" && msg.recipient_phone) {
          const r = await fetch(`${SUPABASE_URL}/functions/v1/sms-service`, {
            method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
            body: JSON.stringify({
              trigger: "custom", to_phone: msg.recipient_phone,
              params: { message: body }, contact_id: msg.contact_id, trigger_id: msg.batch_id,
            }),
          });
          const d = await r.json();
          if (r.ok && (d.sid || d.success)) {
            await sb.from("showing_messages").update({
              status: "sent", sent_at: new Date().toISOString(), sms_log_id: d.sms_log_id || null, body_text: body,
            }).eq("id", msg.id);
            sent++;
          } else {
            await sb.from("showing_messages").update({
              status: "failed", failure_reason: d.error || `HTTP ${r.status}`, body_text: body,
            }).eq("id", msg.id);
            failed++;
          }
        } else if (msg.channel === "email" && msg.recipient_email) {
          const r = await fetch(`${SUPABASE_URL}/functions/v1/email-service`, {
            method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
            body: JSON.stringify({
              action: "send", to_email: msg.recipient_email,
              to_name: `${contact?.first_name || ""} ${contact?.last_name || ""}`.trim(),
              first_name: contact?.first_name, last_name: contact?.last_name,
              contact_id: msg.contact_id,
              subject: subject || "Reminder for your home tour",
              html: body,
            }),
          });
          const d = await r.json();
          if (r.ok && d.success) {
            await sb.from("showing_messages").update({
              status: "sent", sent_at: new Date().toISOString(), email_log_id: d.email_log_id || null, subject, body_text: body.substring(0, 2000),
            }).eq("id", msg.id);
            sent++;
          } else {
            await sb.from("showing_messages").update({
              status: "failed", failure_reason: d.error || `HTTP ${r.status}`, subject, body_text: body.substring(0, 2000),
            }).eq("id", msg.id);
            failed++;
          }
        } else {
          await sb.from("showing_messages").update({
            status: "failed", failure_reason: "missing recipient",
          }).eq("id", msg.id);
          failed++;
        }
      } catch (e: any) {
        console.error("reminder dispatch error:", e);
        await sb.from("showing_messages").update({
          status: "failed", failure_reason: e.message || "unknown",
        }).eq("id", msg.id);
        failed++;
      }
    }

    return new Response(JSON.stringify({
      processed: items.length, sent, failed,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error("tours-send-reminders fatal:", e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});

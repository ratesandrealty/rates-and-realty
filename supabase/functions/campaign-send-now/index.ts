// campaign-send-now v3: write email_log with status='scheduled' (not 'queued')
// so the existing every-minute send-scheduled-emails cron picks it up.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireStaff } from "../_shared/require-staff.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAILERLITE_API_KEY = Deno.env.get("MAILERLITE_API_KEY");
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const SEND_THROTTLE_MS = 200;
const MAX_RECIPIENTS_PER_RUN = 200;

function renderMergeTags(text: string, recipient: any, campaign_id: string): string {
  if (!text) return text;
  const unsub = `https://beta.ratesandrealty.com/unsubscribe?email=${encodeURIComponent(recipient.email || "")}&c=${campaign_id}`;
  return text
    .replace(/\{\{\s*first_name\s*\}\}/gi, recipient.first_name || "there")
    .replace(/\{\{\s*last_name\s*\}\}/gi, recipient.last_name || "")
    .replace(/\{\{\s*property_city\s*\}\}/gi, recipient.property_city || "your area")
    .replace(/\{\{\s*loan_type\s*\}\}/gi, recipient.loan_type || "mortgage")
    .replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, unsub);
}

async function ensureMailerLiteSubscriber(email: string, firstName: string | null, lastName: string | null): Promise<string | null> {
  if (!MAILERLITE_API_KEY) return null;
  try {
    const res = await fetch("https://connect.mailerlite.com/api/subscribers", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${MAILERLITE_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        email,
        fields: { name: firstName || undefined, last_name: lastName || undefined },
        status: "active",
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.id || null;
  } catch {
    return null;
  }
}

async function sendEmailViaQueue(
  recipient: any,
  emailPiece: any,
  campaign: any
): Promise<{ ok: boolean; error?: string }> {
  try {
    const subject = renderMergeTags(emailPiece.email_subject || "", recipient, campaign.id);
    const html = renderMergeTags(emailPiece.email_html || "", recipient, campaign.id);
    const plaintext = renderMergeTags(emailPiece.email_plaintext || "", recipient, campaign.id);

    if (MAILERLITE_API_KEY) {
      ensureMailerLiteSubscriber(recipient.email, recipient.first_name, recipient.last_name).catch(() => {});
    }

    // status='scheduled' + scheduled_at=now so send-scheduled-emails cron picks it up
    const { error } = await sb.from("email_log").insert({
      to_email: recipient.email,
      to_name: [recipient.first_name, recipient.last_name].filter(Boolean).join(" ") || null,
      subject,
      body_html: html,
      body_text: plaintext,
      from_email: emailPiece.email_from_email || "rene@ratesandrealty.com",
      from_name: emailPiece.email_from_name || "Rene Duarte",
      contact_id: recipient.contact_id || null,
      direction: "outbound",
      template: "campaign",
      campaign_id: campaign.id,
      status: "scheduled",
      scheduled_at: new Date().toISOString(),
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

async function sendSmsViaService(recipient: any, smsPiece: any, campaign: any): Promise<{ ok: boolean; sid?: string; error?: string }> {
  try {
    const message = renderMergeTags(smsPiece.sms_body || "", recipient, campaign.id);
    const res = await fetch(`${SUPABASE_URL}/functions/v1/sms-service`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({
        trigger: "custom",
        to_phone: recipient.phone,
        params: { message },
        contact_id: recipient.contact_id || undefined,
        trigger_id: campaign.id,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.sent) {
      return { ok: false, error: data.error || data.message || `HTTP ${res.status}` };
    }
    return { ok: true, sid: data.sid };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method !== "POST") return err("Method not allowed", 405);

  /* ── GUARD ────────────────────────────────────────────────────────────────
   *
   * Was open to the internet: verify_jwt = false and no in-function check, over
   * a SUPABASE_SERVICE_ROLE_KEY client that fans a campaign out to up to 200
   * recipients per run — email via email_log, and SMS through sms-service on
   * the business line. That is the TCPA surface the quiet-hours work exists to
   * protect, and quiet hours is worthless if anyone can invoke the sender.
   *
   * NO STAGING NEEDED, uniquely: this function has NO caller. Not a browser
   * one, not a cron job, not another function — searched the whole repo and
   * cron.job, and docs/OPEN-FINDINGS-2026-08-07.md §5 recorded the same. So
   * there is no frontend to ship first and nothing that can break; the guard
   * lands in one step.
   *
   * NO allowInternal: nothing internal calls this. Granting the internal path
   * "just in case" is how a check meant for one caller ends up covering a
   * destructive action — see the opt-in note in _shared/require-staff.ts.
   *
   * BEFORE req.json(). */
  const _auth = await requireStaff(req, { what: "Sending a campaign" });
  if (!_auth.ok) return err(_auth.msg || "not authorized", _auth.status || 401);

  const t0 = Date.now();
  try {
    const body = await req.json();
    const { campaign_id, channels: requestedChannels, max_recipients = MAX_RECIPIENTS_PER_RUN, dry_run = false } = body;
    if (!campaign_id) return err("campaign_id required");

    const { data: campaign, error: cErr } = await sb.from("campaigns").select("*").eq("id", campaign_id).single();
    if (cErr || !campaign) return err("campaign not found", 404);
    if (campaign.status === "sent" && !dry_run) {
      return err(`campaign already sent`);
    }

    const channelsToSend = (requestedChannels || campaign.channels || []).filter((c: string) =>
      ["email", "sms"].includes(c)
    );
    if (!channelsToSend.length) return err("No deliverable channels (email/sms) for this campaign");

    const { data: pieces } = await sb.from("campaign_pieces")
      .select("*").eq("campaign_id", campaign_id).in("channel", channelsToSend);
    const pieceByChannel: Record<string, any> = {};
    for (const p of (pieces || [])) pieceByChannel[p.channel] = p;

    if (channelsToSend.includes("email") && !pieceByChannel.email?.email_html) {
      return err("Email channel requested but no email piece content");
    }
    if (channelsToSend.includes("sms") && !pieceByChannel.sms?.sms_body) {
      return err("SMS channel requested but no sms piece content");
    }

    if (!dry_run) {
      await sb.from("campaigns").update({
        status: "sending",
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", campaign_id);
    }

    let q = sb.from("campaign_recipients").select("*").eq("campaign_id", campaign_id);
    if (channelsToSend.includes("email") && channelsToSend.includes("sms")) {
      q = q.or("email_status.eq.pending,sms_status.eq.pending");
    } else if (channelsToSend.includes("email")) {
      q = q.eq("email_status", "pending");
    } else {
      q = q.eq("sms_status", "pending");
    }
    q = q.limit(max_recipients);

    const { data: recipients, error: rErr } = await q;
    if (rErr) throw new Error(`recipients: ${rErr.message}`);
    if (!recipients?.length) {
      await sb.from("campaigns").update({ status: "sent", updated_at: new Date().toISOString() }).eq("id", campaign_id);
      return ok({ success: true, sent: 0, message: "No pending recipients" });
    }

    if (dry_run) {
      return ok({
        dry_run: true,
        would_send: recipients.length,
        channels: channelsToSend,
        sample_recipient: {
          email: recipients[0].email,
          phone: recipients[0].phone,
          first_name: recipients[0].first_name,
        },
        sample_email_subject: pieceByChannel.email ? renderMergeTags(pieceByChannel.email.email_subject, recipients[0], campaign_id) : null,
        sample_sms: pieceByChannel.sms ? renderMergeTags(pieceByChannel.sms.sms_body, recipients[0], campaign_id) : null,
      });
    }

    let emails_sent = 0;
    let emails_failed = 0;
    let sms_sent = 0;
    let sms_failed = 0;
    const errors: any[] = [];

    for (const r of recipients) {
      const updates: any = {};

      if (channelsToSend.includes("email") && r.email_status === "pending" && r.email && pieceByChannel.email) {
        const result = await sendEmailViaQueue(r, pieceByChannel.email, campaign);
        if (result.ok) {
          updates.email_status = "sent";
          updates.email_sent_at = new Date().toISOString();
          emails_sent++;
        } else {
          updates.email_status = "failed";
          updates.email_bounce_reason = result.error?.substring(0, 300) || "unknown";
          emails_failed++;
          errors.push({ recipient: r.email, channel: "email", error: result.error });
        }
      }

      if (channelsToSend.includes("sms") && r.sms_status === "pending" && r.phone && pieceByChannel.sms) {
        const result = await sendSmsViaService(r, pieceByChannel.sms, campaign);
        if (result.ok) {
          updates.sms_status = "sent";
          updates.sms_sent_at = new Date().toISOString();
          updates.sms_message_sid = result.sid;
          sms_sent++;
        } else {
          updates.sms_status = "failed";
          sms_failed++;
          errors.push({ recipient: r.phone, channel: "sms", error: result.error });
        }
      }

      if (Object.keys(updates).length) {
        await sb.from("campaign_recipients").update(updates).eq("id", r.id);
      }

      await sleep(SEND_THROTTLE_MS);
    }

    const stillPending = recipients.length >= max_recipients;
    const finalStatus = stillPending ? "sending" : "sent";
    await sb.from("campaigns").update({
      status: finalStatus,
      emails_sent: (campaign.emails_sent || 0) + emails_sent,
      sms_sent: (campaign.sms_sent || 0) + sms_sent,
      updated_at: new Date().toISOString(),
    }).eq("id", campaign_id);

    return ok({
      success: true,
      campaign_id,
      processed: recipients.length,
      emails_sent,
      emails_failed,
      sms_sent,
      sms_failed,
      still_pending: stillPending,
      elapsed_ms: Date.now() - t0,
      errors: errors.slice(0, 10),
      total_errors: errors.length,
    });
  } catch (e: any) {
    console.error("[campaign-send-now] FATAL:", e);
    return err(e.message || String(e), 500);
  }
});

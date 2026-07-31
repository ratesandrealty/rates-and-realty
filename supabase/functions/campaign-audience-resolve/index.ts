// campaign-audience-resolve: count + materialize recipient list for a campaign
//
// POST body:
// {
//   campaign_id: "...",         // required if commit=true
//   filter: { ... },            // override the campaign's saved filter
//   include_contacts: true,
//   include_newsletter_subs: false,
//   commit: false               // if true, writes campaign_recipients rows
// }
//
// Returns: { count, breakdown: { contacts, newsletter_subs }, sample: [first 5 rows] }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function queryContacts(filter: any) {
  let q = sb.from("contacts")
    .select("id, first_name, last_name, email, phone, sms_opt_in, pipeline_status, lead_status, loan_type, city, lead_temperature, score_tier, tags, last_contact_date");

  // Apply filters from JSON
  if (filter?.loan_type) q = q.eq("loan_type", filter.loan_type);
  if (filter?.pipeline_status) q = q.eq("pipeline_status", filter.pipeline_status);
  if (filter?.lead_status) q = q.eq("lead_status", filter.lead_status);
  if (filter?.city) q = q.ilike("city", filter.city);
  if (filter?.state) q = q.eq("state", filter.state);
  if (filter?.lead_temperature) q = q.eq("lead_temperature", filter.lead_temperature);
  if (filter?.score_tier) q = q.eq("score_tier", filter.score_tier);
  if (filter?.tags && Array.isArray(filter.tags) && filter.tags.length) {
    q = q.overlaps("tags", filter.tags);
  }
  if (filter?.last_contact_after) q = q.gte("last_contact_date", filter.last_contact_after);
  if (filter?.last_contact_before) q = q.lte("last_contact_date", filter.last_contact_before);

  const { data, error } = await q.limit(5000);
  if (error) throw new Error(`contacts query: ${error.message}`);
  return data || [];
}

async function queryNewsletterSubs(filter: any) {
  let q = sb.from("newsletter_subscribers")
    .select("id, first_name, last_name, email, source, lead_magnet, tags, confirmed, unsubscribed_at")
    .is("unsubscribed_at", null);

  if (filter?.confirmed_only !== false) {
    q = q.eq("confirmed", true);
  }
  if (filter?.tags && Array.isArray(filter.tags) && filter.tags.length) {
    q = q.overlaps("tags", filter.tags);
  }
  if (filter?.source) q = q.eq("source", filter.source);

  const { data, error } = await q.limit(5000);
  if (error) throw new Error(`newsletter query: ${error.message}`);
  return data || [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method !== "POST") return err("Method not allowed", 405);

  try {
    const body = await req.json();
    let {
      campaign_id,
      filter,
      include_contacts = true,
      include_newsletter_subs = false,
      commit = false,
    } = body;

    // If a campaign_id is given, load its saved filter as the default
    if (campaign_id && (!filter || Object.keys(filter).length === 0)) {
      const { data: c } = await sb.from("campaigns")
        .select("audience_filter, include_contacts, include_newsletter_subs")
        .eq("id", campaign_id).single();
      if (c) {
        filter = c.audience_filter || {};
        if (typeof body.include_contacts === "undefined") include_contacts = c.include_contacts;
        if (typeof body.include_newsletter_subs === "undefined") include_newsletter_subs = c.include_newsletter_subs;
      }
    }

    filter = filter || {};

    let contacts: any[] = [];
    let newsletterSubs: any[] = [];
    if (include_contacts) contacts = await queryContacts(filter);
    if (include_newsletter_subs) newsletterSubs = await queryNewsletterSubs(filter);

    // De-dupe across both pools by email (newsletter sub overrides contact match if both)
    const byEmail = new Map<string, any>();
    for (const c of contacts) {
      if (c.email) byEmail.set(c.email.toLowerCase(), { kind: "contact", row: c });
    }
    for (const n of newsletterSubs) {
      if (n.email) byEmail.set(n.email.toLowerCase(), { kind: "newsletter", row: n });
    }
    // Also keep contacts with phone but no email (still get SMS/voicemail)
    const phoneOnlyContacts = contacts.filter(c => !c.email && c.phone);

    const total = byEmail.size + phoneOnlyContacts.length;
    const sample = [
      ...Array.from(byEmail.values()).slice(0, 5).map(v => ({
        kind: v.kind,
        first_name: v.row.first_name,
        last_name: v.row.last_name,
        email: v.row.email,
        phone: v.row.phone,
      })),
    ];

    if (!commit) {
      return ok({
        count: total,
        breakdown: {
          contacts_with_email: contacts.filter(c => c.email).length,
          contacts_phone_only: phoneOnlyContacts.length,
          newsletter_subs: newsletterSubs.length,
          deduped_total: total,
        },
        sample,
      });
    }

    if (!campaign_id) return err("campaign_id required for commit=true");

    // Wipe existing recipients then insert fresh
    await sb.from("campaign_recipients").delete().eq("campaign_id", campaign_id);

    const recipients: any[] = [];
    for (const v of byEmail.values()) {
      const r = v.row;
      recipients.push({
        campaign_id,
        contact_id: v.kind === "contact" ? r.id : null,
        newsletter_sub_id: v.kind === "newsletter" ? r.id : null,
        email: r.email || null,
        phone: r.phone || null,
        first_name: r.first_name || null,
        last_name: r.last_name || null,
        email_status: r.email ? "pending" : null,
        sms_status: (r.phone && r.sms_opt_in !== false && v.kind === "contact") ? "pending" : null,
        voicemail_status: (r.phone && v.kind === "contact") ? "pending" : null,
      });
    }
    for (const c of phoneOnlyContacts) {
      recipients.push({
        campaign_id,
        contact_id: c.id,
        phone: c.phone,
        first_name: c.first_name,
        last_name: c.last_name,
        sms_status: c.sms_opt_in !== false ? "pending" : "opted_out",
        voicemail_status: "pending",
      });
    }

    if (recipients.length) {
      // Insert in chunks of 500 to stay under Postgres bind param limits
      for (let i = 0; i < recipients.length; i += 500) {
        const slice = recipients.slice(i, i + 500);
        const { error: insErr } = await sb.from("campaign_recipients").insert(slice);
        if (insErr) throw new Error(`insert recipients: ${insErr.message}`);
      }
    }

    // Update the campaign's recipient count + saved audience knobs
    await sb.from("campaigns").update({
      recipient_count: recipients.length,
      audience_filter: filter,
      include_contacts,
      include_newsletter_subs,
      updated_at: new Date().toISOString(),
    }).eq("id", campaign_id);

    return ok({
      success: true,
      committed: true,
      count: recipients.length,
      breakdown: {
        contacts_with_email: contacts.filter(c => c.email).length,
        contacts_phone_only: phoneOnlyContacts.length,
        newsletter_subs: newsletterSubs.length,
        deduped_total: total,
      },
    });
  } catch (e: any) {
    console.error("[campaign-audience-resolve] FATAL:", e);
    return err(e.message || String(e), 500);
  }
});

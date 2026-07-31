// people-admin v2: SELECT clause fix — removed nonexistent target_purchase_price column

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

function applyFilters(q: any, filters: any) {
  const f = filters || {};
  if (f.search) {
    const s = f.search.replace(/[%_]/g, "");
    q = q.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,email.ilike.%${s}%,phone.ilike.%${s}%`);
  }
  if (Array.isArray(f.pipeline_status_in) && f.pipeline_status_in.length) q = q.in("pipeline_status", f.pipeline_status_in);
  if (Array.isArray(f.exclude_pipeline) && f.exclude_pipeline.length) {
    q = q.not("pipeline_status", "in", `(${f.exclude_pipeline.map((s: string) => `"${s}"`).join(",")})`);
  }
  if (f.lead_temperature) q = q.eq("lead_temperature", f.lead_temperature);
  if (Array.isArray(f.lead_temperature_in) && f.lead_temperature_in.length) q = q.in("lead_temperature", f.lead_temperature_in);
  if (Array.isArray(f.score_tier_in) && f.score_tier_in.length) q = q.in("score_tier", f.score_tier_in);
  if (typeof f.min_score === "number") q = q.gte("total_score", f.min_score);
  if (typeof f.max_score === "number") q = q.lte("total_score", f.max_score);
  if (Array.isArray(f.loan_type_in) && f.loan_type_in.length) q = q.in("loan_type", f.loan_type_in);
  if (f.loan_type_intent === "purchase") {
    q = q.or("loan_type.ilike.%purchase%,loan_type.ilike.%FHA%,loan_type.ilike.%VA%,loan_type.ilike.%USDA%,loan_type.ilike.%conventional%,loan_type.ilike.%jumbo%");
  } else if (f.loan_type_intent === "refi") {
    q = q.or("loan_type.ilike.%refi%,loan_type.ilike.%refinance%,loan_type.ilike.%cash%,loan_type.ilike.%streamline%,loan_type.ilike.%irrrl%");
  } else if (f.loan_type_intent === "investor") {
    q = q.or("loan_type.ilike.%dscr%,loan_type.ilike.%investor%,loan_type.ilike.%rental%,occupancy_type.ilike.%investment%");
  }
  if (Array.isArray(f.source_in) && f.source_in.length) q = q.in("source", f.source_in);
  if (Array.isArray(f.city_in) && f.city_in.length) q = q.in("city", f.city_in);
  if (Array.isArray(f.state_in) && f.state_in.length) q = q.in("state", f.state_in);
  if (Array.isArray(f.tag_any) && f.tag_any.length) q = q.overlaps("tags", f.tag_any);
  if (Array.isArray(f.tag_all) && f.tag_all.length) q = q.contains("tags", f.tag_all);
  if (f.has_email === true) q = q.not("email", "is", null);
  if (f.has_email === false) q = q.is("email", null);
  if (f.has_phone === true) q = q.not("phone", "is", null);
  if (f.has_phone === false) q = q.is("phone", null);
  if (f.has_referral === true) q = q.not("referred_by", "is", null);
  if (f.has_referral === false) q = q.is("referred_by", null);
  if (f.sms_opt_in === true) q = q.eq("sms_opt_in", true);
  if (f.sms_opt_in === false) q = q.eq("sms_opt_in", false);
  if (f.has_appointment === true) q = q.eq("appointment_set", true);
  if (f.has_appointment === false) q = q.eq("appointment_set", false);
  if (f.has_drive_folder === true) q = q.not("google_drive_folder_url", "is", null);
  if (typeof f.created_within_hours === "number") {
    q = q.gte("created_at", new Date(Date.now() - f.created_within_hours * 3600 * 1000).toISOString());
  } else if (typeof f.created_within_days === "number") {
    q = q.gte("created_at", new Date(Date.now() - f.created_within_days * 86400 * 1000).toISOString());
  }
  if (typeof f.no_contact_days === "number") {
    const cutoff = new Date(Date.now() - f.no_contact_days * 86400 * 1000).toISOString();
    q = q.or(`last_contact_date.is.null,last_contact_date.lt.${cutoff}`);
  } else if (f.no_contact_ever === true) {
    q = q.is("last_contact_date", null);
  }
  if (typeof f.target_price_min === "number") q = q.gte("purchase_price", f.target_price_min);
  if (typeof f.target_price_max === "number") q = q.lte("purchase_price", f.target_price_max);
  if (typeof f.credit_score_min === "number") q = q.gte("credit_score", f.credit_score_min);
  if (typeof f.credit_score_max === "number") q = q.lte("credit_score", f.credit_score_max);
  if (Array.isArray(f.fico_band_in) && f.fico_band_in.length) q = q.in("credit_score_range", f.fico_band_in);
  if (Array.isArray(f.timeline_in) && f.timeline_in.length) q = q.in("timeline", f.timeline_in);
  return q;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const ok = (d: any) => new Response(JSON.stringify(d), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const body = await req.json();
    const action = (body.action || "").toLowerCase();

    if (action === "list_views") {
      const { data, error } = await sb.from("saved_views").select("*")
        .order("pinned", { ascending: false })
        .order("pin_order", { ascending: true })
        .order("name", { ascending: true });
      if (error) return err(error.message);
      return ok({ success: true, views: data || [] });
    }

    if (action === "create_view") {
      const view = {
        name: body.name || "Untitled View",
        description: body.description || null,
        filters: body.filters || {},
        columns: body.columns || [],
        sort_by: body.sort_by || "created_at",
        sort_dir: body.sort_dir || "desc",
        pinned: !!body.pinned,
        pin_order: body.pin_order || 999,
        icon: body.icon || null,
        color: body.color || null,
        owner: body.owner || "rene",
      };
      const { data, error } = await sb.from("saved_views").insert(view).select("*").single();
      if (error) return err(error.message);
      return ok({ success: true, view: data });
    }

    if (action === "update_view") {
      if (!body.id) return err("id required");
      const updates: any = { updated_at: new Date().toISOString() };
      for (const k of ["name", "description", "filters", "columns", "sort_by", "sort_dir", "pinned", "pin_order", "icon", "color"]) {
        if (body[k] !== undefined) updates[k] = body[k];
      }
      const { data, error } = await sb.from("saved_views").update(updates).eq("id", body.id).select("*").single();
      if (error) return err(error.message);
      return ok({ success: true, view: data });
    }

    if (action === "delete_view") {
      if (!body.id) return err("id required");
      const { error } = await sb.from("saved_views").delete().eq("id", body.id);
      if (error) return err(error.message);
      return ok({ success: true });
    }

    if (action === "pin_view") {
      if (!body.id) return err("id required");
      const { error } = await sb.from("saved_views").update({ pinned: true, pin_order: body.pin_order || 500 }).eq("id", body.id);
      if (error) return err(error.message);
      return ok({ success: true });
    }

    if (action === "unpin_view") {
      if (!body.id) return err("id required");
      const { error } = await sb.from("saved_views").update({ pinned: false }).eq("id", body.id);
      if (error) return err(error.message);
      return ok({ success: true });
    }

    if (action === "list_contacts") {
      const filters = body.filters || {};
      const sortBy = body.sort_by || "created_at";
      const sortDir = (body.sort_dir || "desc").toLowerCase() === "asc" ? { ascending: true } : { ascending: false };
      const limit = Math.min(parseInt(body.limit) || 100, 500);
      const offset = parseInt(body.offset) || 0;

      // Removed target_purchase_price (doesn't exist on contacts table)
      let q = sb.from("contacts").select(`
        id, first_name, last_name, email, phone, secondary_phone,
        city, state, lead_temperature, score_tier, total_score, lead_score,
        loan_type, pipeline_status, lead_status, source, tags,
        last_contact_date, next_follow_up, created_at, updated_at,
        appointment_set, appointment_date,
        purchase_price, requested_loan_amount,
        credit_score, credit_score_range,
        timeline, occupancy_type, property_type,
        days_no_response, calls_missed, sms_replies, email_opens,
        referred_by, assigned_to, contact_type, ai_summary
      `, { count: "exact" });

      q = applyFilters(q, filters);
      q = q.order(sortBy, sortDir).range(offset, offset + limit - 1);

      const { data, error, count } = await q;
      if (error) return err(error.message);
      return ok({ success: true, contacts: data || [], total: count || 0, limit, offset });
    }

    if (action === "filter_options") {
      const queries = await Promise.all([
        sb.from("contacts").select("pipeline_status").not("pipeline_status", "is", null),
        sb.from("contacts").select("loan_type").not("loan_type", "is", null),
        sb.from("contacts").select("source").not("source", "is", null),
        sb.from("contacts").select("city").not("city", "is", null),
        sb.from("contacts").select("state").not("state", "is", null),
        sb.from("contacts").select("tags").not("tags", "is", null),
        sb.from("contacts").select("score_tier").not("score_tier", "is", null),
        sb.from("contacts").select("lead_temperature").not("lead_temperature", "is", null),
        sb.from("contacts").select("timeline").not("timeline", "is", null),
        sb.from("contacts").select("credit_score_range").not("credit_score_range", "is", null),
        sb.from("contacts").select("contact_type").not("contact_type", "is", null),
        sb.from("contacts").select("assigned_to").not("assigned_to", "is", null),
      ]);
      const dedupe = (rows: any[], key: string) => Array.from(new Set((rows || []).map(r => r[key]).filter(Boolean))).sort();
      const flattenTags = (rows: any[]) => Array.from(new Set((rows || []).flatMap(r => r.tags || []).filter(Boolean))).sort();
      return ok({
        success: true,
        options: {
          pipeline_status: dedupe(queries[0].data || [], "pipeline_status"),
          loan_type:       dedupe(queries[1].data || [], "loan_type"),
          source:          dedupe(queries[2].data || [], "source"),
          city:            dedupe(queries[3].data || [], "city"),
          state:           dedupe(queries[4].data || [], "state"),
          tags:            flattenTags(queries[5].data || []),
          score_tier:      dedupe(queries[6].data || [], "score_tier"),
          lead_temperature: dedupe(queries[7].data || [], "lead_temperature"),
          timeline:        dedupe(queries[8].data || [], "timeline"),
          credit_score_range: dedupe(queries[9].data || [], "credit_score_range"),
          contact_type:    dedupe(queries[10].data || [], "contact_type"),
          assigned_to:     dedupe(queries[11].data || [], "assigned_to"),
        },
      });
    }

    if (action === "stats") {
      const dayAgo = new Date(Date.now() - 86400000).toISOString();
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString();
      const [
        { count: total }, { count: hot }, { count: warm }, { count: cold },
        { count: new24h }, { count: newWeek },
        { count: active },
        { count: needsFollowUp }, { count: stalled },
      ] = await Promise.all([
        sb.from("contacts").select("id", { count: "exact", head: true }),
        sb.from("contacts").select("id", { count: "exact", head: true }).eq("lead_temperature", "Hot"),
        sb.from("contacts").select("id", { count: "exact", head: true }).eq("lead_temperature", "Warm"),
        sb.from("contacts").select("id", { count: "exact", head: true }).eq("lead_temperature", "Cold"),
        sb.from("contacts").select("id", { count: "exact", head: true }).gte("created_at", dayAgo),
        sb.from("contacts").select("id", { count: "exact", head: true }).gte("created_at", weekAgo),
        sb.from("contacts").select("id", { count: "exact", head: true }).in("pipeline_status", ["Pre-Approved", "Processing", "Under Contract", "Submitted", "Approved"]),
        sb.from("contacts").select("id", { count: "exact", head: true }).or(`last_contact_date.is.null,last_contact_date.lt.${sevenDaysAgo}`).not("pipeline_status", "in", '("Closed","Lost")'),
        sb.from("contacts").select("id", { count: "exact", head: true }).or(`last_contact_date.is.null,last_contact_date.lt.${fourteenDaysAgo}`).not("pipeline_status", "in", '("Closed","Lost")'),
      ]);
      return ok({
        success: true,
        stats: {
          total: total || 0, hot: hot || 0, warm: warm || 0, cold: cold || 0,
          new_24h: new24h || 0, new_week: newWeek || 0,
          active_clients: active || 0,
          needs_follow_up: needsFollowUp || 0, stalled: stalled || 0,
        },
      });
    }

    if (action === "bulk_update") {
      if (!Array.isArray(body.contact_ids) || !body.contact_ids.length) return err("contact_ids required");
      const allowed: any = {};
      for (const k of ["lead_temperature", "pipeline_status", "lead_status", "score_tier", "assigned_to", "loan_type", "timeline", "sms_opt_in"]) {
        if (body[k] !== undefined) allowed[k] = body[k];
      }
      if (Array.isArray(body.add_tags) && body.add_tags.length) {
        const { data: existing } = await sb.from("contacts").select("id, tags").in("id", body.contact_ids);
        for (const c of existing || []) {
          const merged = Array.from(new Set([...(c.tags || []), ...body.add_tags]));
          await sb.from("contacts").update({ tags: merged, updated_at: new Date().toISOString() }).eq("id", c.id);
        }
      }
      if (Array.isArray(body.remove_tags) && body.remove_tags.length) {
        const { data: existing } = await sb.from("contacts").select("id, tags").in("id", body.contact_ids);
        for (const c of existing || []) {
          const filtered = (c.tags || []).filter((t: string) => !body.remove_tags.includes(t));
          await sb.from("contacts").update({ tags: filtered, updated_at: new Date().toISOString() }).eq("id", c.id);
        }
      }
      let updated = 0;
      if (Object.keys(allowed).length) {
        allowed.updated_at = new Date().toISOString();
        const { error, count } = await sb.from("contacts").update(allowed).in("id", body.contact_ids).select("id", { count: "exact", head: true });
        if (error) return err(error.message);
        updated = count || 0;
      }
      return ok({ success: true, updated, count: body.contact_ids.length });
    }

    return err(`Unknown action: ${action}`);
  } catch (e: any) {
    console.error("[people-admin] error:", e);
    return err(e?.message || String(e), 500);
  }
});

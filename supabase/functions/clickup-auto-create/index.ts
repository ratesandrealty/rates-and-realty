// clickup-auto-create v3 — Layer 2 ClickUp automation helper (multi-rule per event)
//
// v3: a trigger_type can now have MULTIPLE automation rules. Fires every enabled rule.
//     Signature stays identical for single-rule events (no transition duplicates);
//     multi-rule events suffix the rule id so each rule dedupes independently.
// v2: fixed contact lookup (pipeline_status instead of stage) + error logging.
//
// POST body: { trigger_type, contact_id, source_id?, context?, dry_run? }
// Returns: { success, status, results: [ ... per rule ... ] }

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

function j(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function interpolate(template: string, values: Record<string, any>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = values[key];
    return v !== undefined && v !== null && v !== '' ? String(v) : `(${key})`;
  });
}

function buildSignature(triggerType: string, contactId: string | null, sourceId: string | null): string {
  const parts = [triggerType, contactId || 'no-contact'];
  if (sourceId) parts.push(sourceId);
  else parts.push(new Date().toISOString().substring(0, 10));
  return parts.join(':');
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return j({ error: "POST only" }, 405);

  try {
    const body = await req.json();
    const { trigger_type, contact_id, source_id = null, context = {}, dry_run = false } = body;
    if (!trigger_type) return j({ error: "trigger_type required" }, 400);

    const { data: configs } = await sb.from("clickup_automation_config")
      .select("*").eq("trigger_type", trigger_type).order("display_order", { ascending: true });
    if (!configs || configs.length === 0) return j({ error: `Unknown trigger_type: ${trigger_type}` }, 404);

    const enabled = configs.filter((c: any) => c.enabled);
    if (enabled.length === 0) {
      const { data: log } = await sb.from("clickup_automation_log").insert({
        trigger_type, contact_id, source_id,
        event_signature: buildSignature(trigger_type, contact_id, source_id),
        status: 'skipped_disabled', metadata: { context },
      }).select("id").single();
      return j({ success: true, status: 'skipped_disabled', results: [], log_id: log?.id });
    }

    // Resolve contact once (shared across all rules for this event).
    let contact: any = null;
    let contactLookupError: string | null = null;
    if (contact_id) {
      const { data, error } = await sb.from("contacts")
        .select("id, first_name, last_name, phone, email, lead_source, pipeline_status, lead_status")
        .eq("id", contact_id).maybeSingle();
      if (error) { contactLookupError = error.message; console.error("[clickup-auto-create] contact lookup failed:", error); }
      contact = data;
    }
    const values: Record<string, any> = {
      first_name: contact?.first_name || 'lead',
      last_name: contact?.last_name || '',
      full_name: contact ? `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || 'lead' : 'lead',
      lead_source: contact?.lead_source || contact?.source || 'unknown source',
      stage: contact?.pipeline_status || contact?.lead_status || '',
      ...context,
    };

    const multi = enabled.length > 1;
    const results: any[] = [];

    for (const config of enabled) {
      const base = buildSignature(trigger_type, contact_id, source_id);
      const signature = multi ? `${base}#${config.id}` : base;

      const { data: existing } = await sb.from("clickup_automation_log")
        .select("id, clickup_task_id").eq("event_signature", signature).eq("status", "created").maybeSingle();
      if (existing) {
        /* A SUPPRESSION IS A WRITE, NOT A RETURN VALUE.
         * This branch used to push a result and `continue` without recording
         * anything, so a successful dedup left no evidence anywhere. The cost of
         * that showed up on 2026-08-21: asked how often the dedup had fired, the
         * only available answer was "the log holds no skipped_duplicate rows",
         * which measures nothing — the code never wrote one. 'skipped_duplicate'
         * has been in the table's CHECK constraint the whole time; the schema
         * anticipated this row and the writer forgot it.
         *
         * The lookup above filters status='created', so these rows can never
         * become dedup targets themselves and cannot chain.
         *
         * Recorded, never fatal: a failure to log a skip must not turn a correct
         * suppression into an error response. */
        let skipLogId: string | null = null;
        try {
          const { data: skipLog, error: skipErr } = await sb.from("clickup_automation_log").insert({
            trigger_type, contact_id, source_id, event_signature: signature,
            status: 'skipped_duplicate',
            clickup_task_id: existing.clickup_task_id,   // the task this event WOULD have duplicated
            metadata: { context, suppressed_by_log_id: existing.id, rule_id: config.id },
          }).select("id").single();
          if (skipErr) console.error('[clickup-auto-create] could not log the skip:', skipErr.message);
          skipLogId = skipLog?.id ?? null;
        } catch (e) {
          console.error('[clickup-auto-create] could not log the skip:', (e as Error)?.message);
        }
        results.push({ rule_id: config.id, status: 'skipped_duplicate', signature, clickup_task_id: existing.clickup_task_id, log_id: existing.id, skip_log_id: skipLogId });
        continue;
      }

      const title = interpolate(config.title_template, values);
      const description = config.description_template ? interpolate(config.description_template, values) : null;

      let dueDate: string | null = null;
      if (config.due_offset_days !== null && config.due_offset_days !== undefined) {
        const anchor = context.anchor_date ? new Date(context.anchor_date) : new Date();
        anchor.setDate(anchor.getDate() + config.due_offset_days);
        anchor.setHours(17 + (config.due_offset_hours || 0), 0, 0, 0);
        dueDate = anchor.toISOString();
      }

      if (dry_run) {
        results.push({ rule_id: config.id, status: 'dry_run', would_create: { title, description, priority: config.default_priority, due_date: dueDate, contact_id, list_id: config.list_id }, signature });
        continue;
      }

      const createRes = await fetch(`${SUPABASE_URL}/functions/v1/clickup-bridge/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({ title, description, priority: config.default_priority, due_date: dueDate, contact_id, list_id: config.list_id }),
      });
      const createBody = await createRes.json();

      if (!createRes.ok || !createBody.clickup_task_id) {
        const { data: log } = await sb.from("clickup_automation_log").insert({
          trigger_type, contact_id, source_id, event_signature: signature,
          status: 'failed', error: JSON.stringify(createBody).substring(0, 500),
          metadata: { context, attempted_title: title },
        }).select("id").single();
        results.push({ rule_id: config.id, status: 'failed', error: createBody.error || 'create failed', log_id: log?.id });
        continue;
      }

      const { data: log } = await sb.from("clickup_automation_log").insert({
        trigger_type, contact_id, source_id, event_signature: signature,
        status: 'created', clickup_task_id: createBody.clickup_task_id,
        metadata: { context, title, due_date: dueDate, priority: config.default_priority },
      }).select("id").single();
      results.push({ rule_id: config.id, status: 'created', clickup_task_id: createBody.clickup_task_id, url: createBody.url, signature, log_id: log?.id, title });
    }

    // Backward-compatible top-level fields mirror the first meaningful result.
    const primary = results.find((r) => r.status === 'created') || results[0] || {};
    return j({
      success: true,
      status: primary.status,
      results,
      ...(primary.would_create ? { would_create: primary.would_create } : {}),
      ...(primary.clickup_task_id ? { clickup_task_id: primary.clickup_task_id } : {}),
      ...(primary.title ? { title: primary.title } : {}),
      contact_lookup_error: contactLookupError,
    });
  } catch (e: any) {
    console.error("[clickup-auto-create] error:", e);
    return j({ error: e?.message || String(e) }, 500);
  }
});

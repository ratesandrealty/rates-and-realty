-- surface_stale_leads(p_dry_run boolean, p_quiet_days integer)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-18. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.surface_stale_leads(p_dry_run boolean DEFAULT false, p_quiet_days integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_active text[] := array['Contacted','Follow Up','Pre-Approved','Under Contract','Processing','Clear to Close'];
  r record; v_created int := 0; v_preview jsonb := '[]'::jsonb; v_days int;
  v_closed int := 0; cr record;
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not is_admin() then
    raise exception 'admin only';
  end if;

  /* ── CLASS C: CLOSE WHAT THE FOLLOW-UP ALREADY RESOLVED ────────────────
   *
   * The sweeper stops CREATING a task once a lead is active again, but never
   * closed the one already open -- so a task outlived the condition that
   * justified it and sat in the queue looking like work.
   *
   * "NO LONGER QUIET" IS THE SWEEPER'S OWN TEST, INVERTED, not a second
   * definition. The create path below skips a lead when
   *     r.last_activity is not null and r.last_activity >= now() - p_quiet_days
   * and this closes a task under exactly that condition, over exactly the same
   * three activity sources. A lead with NO recorded activity is quiet by that
   * rule, so its task is never closed here: never-contacted is the signal, not
   * a resolved one.
   *
   * completed_source is NOT set here. tg_tasks_stamp_completion overwrites it
   * from auth.uid() before the row lands, so the value reflects who ran the
   * sweep -- 'system' under pg_cron, 'user' when a person triggers it. The
   * reason lives in task_activity.kind instead, which is written either way. */
  for cr in
    select t.id, t.title, c.pipeline_status,
           greatest(c.last_contact_date, c.last_meaningful_activity_at,
                    (select max(ae.created_at) from activity_events ae where ae.contact_id = c.id)) as last_activity
    from public.tasks t
    join public.contacts c on c.id = t.contact_id
    where t.related_table = 'auto_followup_lead'
      and coalesce(t.status,'open') not in ('completed','cancelled')
  loop
    continue when cr.last_activity is null;
    continue when cr.last_activity < now() - make_interval(days => p_quiet_days);

    if p_dry_run then
      v_closed := v_closed + 1;
      continue;
    end if;

    update public.tasks
       set status = 'completed',
           updated_at = now()
     where id = cr.id;

    perform public._log_task_activity(
      cr.id, 'auto_closed_lead_active',
      'Closed automatically: the lead is active again, so the follow-up this task asked for has happened.',
      jsonb_build_object('last_activity', cr.last_activity,
                         'quiet_days_threshold', p_quiet_days,
                         'pipeline_status', cr.pipeline_status));

    v_closed := v_closed + 1;
  end loop;

  for r in
    select c.id,
           nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'') as name,
           c.pipeline_status,
           greatest(c.last_contact_date, c.last_meaningful_activity_at,
                    (select max(ae.created_at) from activity_events ae where ae.contact_id = c.id)) as last_activity
    from contacts c
    where c.pipeline_status = any(v_active)
      and c.merged_into_contact_id is null   -- READ FILTER: current roster only
  loop
    if r.last_activity is not null and r.last_activity >= now() - make_interval(days => p_quiet_days) then
      continue;
    end if;
    if exists (select 1 from tasks t
               where t.contact_id = r.id and t.related_table = 'auto_followup_lead'
                 and coalesce(t.status,'open') not in ('completed','cancelled','dismissed')) then
      continue;
    end if;

    v_days := case when r.last_activity is null then null
                   else floor(extract(epoch from now() - r.last_activity)/86400)::int end;

    if p_dry_run then
      v_preview := v_preview || jsonb_build_object('contact_id', r.id, 'name', r.name,
                                                   'stage', r.pipeline_status, 'days_quiet', v_days);
    else
      insert into tasks(title, status, priority, contact_id, related_table, related_id, description, created_at, updated_at)
      values ('Follow up: ' || coalesce(r.name,'lead') || ' (' || r.pipeline_status || ')' ||
                case when v_days is null then ' — no activity logged' else ' — quiet ' || v_days || 'd' end,
              'open', 'high', r.id, 'auto_followup_lead', r.id,
              'Auto-surfaced: this active deal has gone quiet. Reach out and update the file.', now(), now());
      v_created := v_created + 1;
    end if;
  end loop;

  return jsonb_build_object('dry_run', p_dry_run, 'quiet_days', p_quiet_days,
                            'created', v_created, 'closed', v_closed,
                            'would_create', jsonb_array_length(v_preview),
                            'preview', v_preview);
end; $function$;

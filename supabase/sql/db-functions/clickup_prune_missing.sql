-- clickup_prune_missing(p_list_id text, p_live_ids text[], p_fetch_complete boolean)
-- language: plpgsql
-- Captured from production 2026-08-15.

CREATE OR REPLACE FUNCTION public.clickup_prune_missing(p_list_id text, p_live_ids text[], p_fetch_complete boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
/* Returns what it did, always. The caller logs it; the notification below is
   what makes a SKIP visible to a person rather than only to a log. */
declare
  v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
  v_stale      text[];
  v_cancelled  int := 0;
  v_exempt     int := 0;
  v_cache_del  int := 0;
  r            record;
  v_notified   int := 0;
begin
  if not (v_is_service or is_admin()) then
    raise exception 'clickup_prune_missing is service/admin only';
  end if;

  /* COULD NOT RUN. Refuse rather than reconcile against a partial list, and
     say so where somebody will see it: app_notify_system writes the CRM
     notification bell, not a log file. */
  if not coalesce(p_fetch_complete, false) then
    select public.app_notify_system(
      'clickup_sync', null,
      'ClickUp reconciliation SKIPPED for list ' || coalesce(p_list_id,'?') ||
      ': the task list was too large to read in full (the fetch stops at 1000). ' ||
      'No task was cancelled. Nothing is broken yet, but the sync cannot tell a ' ||
      'deleted task from an unread one until the list is smaller or the pager is raised.',
      'ClickUp sync', null, array['admin'], '/dashboard/admin#tasks'
    ) into v_notified;

    return jsonb_build_object(
      'ran', false, 'reason', 'incomplete_fetch', 'list_id', p_list_id,
      'live_ids_seen', coalesce(array_length(p_live_ids,1),0),
      'cancelled', 0, 'notified', coalesce(v_notified,0));
  end if;

  select coalesce(array_agg(c.clickup_task_id), '{}')
    into v_stale
  from public.clickup_task_cache c
  where c.list_id = p_list_id
    and not (c.clickup_task_id = any(coalesce(p_live_ids, '{}')));

  if coalesce(array_length(v_stale,1),0) = 0 then
    return jsonb_build_object('ran', true, 'stale', 0, 'cancelled', 0,
                              'exempt_crm_origin', 0, 'cache_rows_deleted', 0);
  end if;

  /* Count the exemptions BEFORE cancelling so the number is reportable. */
  select count(*) into v_exempt
  from public.tasks t
  where t.clickup_task_id = any(v_stale)
    and coalesce(t.status,'open') not in ('completed','cancelled')
    and exists (select 1 from public.clickup_outbox o where o.task_id = t.id);

  for r in
    select t.id, t.title, t.clickup_task_id
    from public.tasks t
    where t.clickup_task_id = any(v_stale)
      and coalesce(t.status,'open') not in ('completed','cancelled')
      and not exists (select 1 from public.clickup_outbox o where o.task_id = t.id)
  loop
    update public.tasks
       set status = 'cancelled', updated_at = now()
     where id = r.id;

    perform public._log_task_activity(
      r.id, 'cancelled_clickup_missing',
      'Cancelled because its ClickUp task is no longer in the list (deleted, archived or moved).',
      jsonb_build_object('clickup_task_id', r.clickup_task_id, 'list_id', p_list_id));

    v_cancelled := v_cancelled + 1;
  end loop;

  delete from public.clickup_task_cache
   where list_id = p_list_id and clickup_task_id = any(v_stale);
  get diagnostics v_cache_del = row_count;

  return jsonb_build_object(
    'ran', true,
    'stale', array_length(v_stale,1),
    'cancelled', v_cancelled,
    'exempt_crm_origin', v_exempt,
    'cache_rows_deleted', v_cache_del);
end;
$function$;

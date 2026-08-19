-- task_assign_bulk(p_ids uuid[], p_assigned_to uuid)
-- language: plpgsql
-- Captured from production 2026-08-19.

CREATE OR REPLACE FUNCTION public.task_assign_bulk(p_ids uuid[], p_assigned_to uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Reassign N tasks in one statement.
 *
 * WHY THIS EXISTS RATHER THAN LOOPING task_upsert. task_upsert's update sets
 *
 *     due_date = p_due_date
 *
 * with NO coalesce, unlike every other column in the same statement. So the
 * natural bulk-assign call — pass p_id and p_assigned_to, leave the rest null —
 * silently CLEARS THE DUE DATE on every task it touches. The caller would
 * otherwise have to echo each task's existing due_date back in, which makes
 * correctness depend on the browser holding accurate state, and a stale row
 * would erase a date nobody asked to change.
 *
 * This touches assigned_to and assigned_by and nothing else.
 *
 * ALL-OR-NOTHING on authorisation, matching task_delete_bulk: if any task in the
 * batch is not the caller's to reassign, none of them move. Trimming the batch
 * to the permitted subset and reporting success is the partial-success failure
 * this whole family of functions is written against. */
declare
  v_uid       uuid := auth.uid();
  v_is_admin  boolean := is_admin();
  v_requested int := coalesce(array_length(p_ids, 1), 0);
  v_matched   int;
  v_forbidden int;
  v_updated   int;
  v_missing   jsonb;
  r           record;
begin
  if v_requested = 0 then
    return jsonb_build_object('ok', false, 'reason', 'empty', 'requested', 0, 'matched', 0, 'updated', 0,
      'message', 'No task ids were supplied — nothing was reassigned.');
  end if;

  /* The assignee must be a real, non-service account. task_assignees() is the
     same source the picker uses, so the two cannot disagree about who may hold
     work. NULL is allowed and means unassign. */
  if p_assigned_to is not null
     and not exists (select 1 from public.task_assignees() a where a.user_id = p_assigned_to) then
    return jsonb_build_object('ok', false, 'reason', 'bad_assignee', 'requested', v_requested,
      'matched', 0, 'updated', 0,
      'message', 'That person cannot be assigned tasks.');
  end if;

  create temp table _tab_rows on commit drop as
    select * from public.tasks where id = any(p_ids);
  select count(*) into v_matched from _tab_rows;

  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_missing
  from (select unnest(p_ids) as id except select id from _tab_rows) q(x);

  if v_matched = 0 then
    return jsonb_build_object('ok', false, 'reason', 'not_found', 'requested', v_requested,
      'matched', 0, 'updated', 0, 'missing_ids', v_missing,
      'message', 'None of those tasks exist — nothing was reassigned.');
  end if;

  /* Same per-task rule task_upsert applies, evaluated across the whole set. */
  select count(*) into v_forbidden
  from _tab_rows t
  where not (v_is_admin
             or t.assigned_to = v_uid
             or (t.contact_id is not null and is_lead_shared_with_me(t.contact_id)));

  if v_forbidden > 0 then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized',
      'requested', v_requested, 'matched', v_matched, 'updated', 0, 'forbidden', v_forbidden,
      'message', v_forbidden || ' of these tasks are not yours to reassign — nothing was changed.');
  end if;

  update public.tasks t set
    assigned_to = p_assigned_to,
    assigned_by = case when p_assigned_to is not null and p_assigned_to is distinct from t.assigned_to
                       then v_uid else t.assigned_by end,
    updated_at  = now()
  where t.id in (select id from _tab_rows);
  get diagnostics v_updated = row_count;

  /* Keep ClickUp in step, the same seam task_upsert drives. */
  for r in select id from _tab_rows loop
    begin
      perform _task_clickup_sync(r.id);
    exception when others then
      raise warning 'task_assign_bulk: clickup sync failed for %', r.id;
    end;
  end loop;

  return jsonb_build_object('ok', v_updated > 0, 'reason', 'assigned',
    'requested', v_requested, 'matched', v_matched, 'updated', v_updated,
    'missing_ids', v_missing);
end; $function$;

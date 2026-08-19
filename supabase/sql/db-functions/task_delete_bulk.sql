-- task_delete_bulk(p_ids uuid[], p_force boolean)
-- language: plpgsql
-- Captured from production 2026-08-19.

CREATE OR REPLACE FUNCTION public.task_delete_bulk(p_ids uuid[], p_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Delete N tasks as ONE operation.
 *
 * The failure this is designed against is not the happy path. It is the caller
 * that deletes 20 rows, removes 14 from ClickUp, and reports success. An N-call
 * loop over task_delete cannot avoid that: the bridge has no bulk route, so a
 * mid-loop failure orphans an arbitrary number of ClickUp tasks, and one orphan
 * is recoverable from audit_log while twenty is not a cleanup anybody will do by
 * hand.
 *
 * So: snapshot every matched row FIRST, delete in a SINGLE statement, and hand
 * back every clickup_task_id in one array — the caller either removes them all
 * or reports exactly which survived. It cannot report a partial as a success
 * because it is told `requested`, `matched` and `deleted` separately. */
declare
  v_active text[] := array['Contacted','Follow Up','Pre-Approved','Under Contract','Processing','Clear to Close'];
  v_requested int := coalesce(array_length(p_ids, 1), 0);
  v_matched   int;
  v_deleted   int;
  v_regen     jsonb;
  v_missing   jsonb;
  v_clickup   jsonb;
begin
  /* Same gate as task_delete and va_task_delete: admin or service_role. */
  if coalesce(auth.role(),'') is distinct from 'service_role' and not is_admin() then
    raise exception 'Deleting tasks is restricted to admins';
  end if;

  if v_requested = 0 then
    return jsonb_build_object(
      'ok', false, 'reason', 'empty',
      'requested', 0, 'matched', 0, 'deleted', 0,
      'message', 'No task ids were supplied — nothing was deleted.');
  end if;

  create temp table _tdb_rows on commit drop as
    select * from public.tasks where id = any(p_ids);

  select count(*) into v_matched from _tdb_rows;

  /* NOT A SILENT NO-OP. Ids that matched nothing are named, not absorbed into a
     smaller success number. */
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_missing
  from (select unnest(p_ids) as id except select id from _tdb_rows) q(x);

  if v_matched = 0 then
    return jsonb_build_object(
      'ok', false, 'reason', 'not_found',
      'requested', v_requested, 'matched', 0, 'deleted', 0,
      'missing_ids', v_missing,
      'message', 'None of those tasks exist — nothing was deleted.');
  end if;

  /* THE WHOLE BATCH IS REFUSED, not silently trimmed, when any row would simply
     be recreated. Deleting the other nineteen and saying nothing about the
     twentieth is how a "delete" becomes a thing people stop trusting. */
  if not p_force then
    select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'stage', c.pipeline_status)), '[]'::jsonb)
      into v_regen
    from _tdb_rows t
    left join public.contacts c on c.id = t.contact_id
    where t.related_table = 'auto_followup_lead'
      and c.pipeline_status = any(v_active);

    if jsonb_array_length(v_regen) > 0 then
      return jsonb_build_object(
        'ok', false, 'reason', 'will_recreate',
        'requested', v_requested, 'matched', v_matched, 'deleted', 0,
        'will_recreate', v_regen,
        'message', 'Some of these were raised automatically because the lead has gone quiet, and '
                || 'the lead is still in an active stage. Deleting them does not dismiss them — the '
                || 'sweeper recreates them on its next run. Deselect them, or delete anyway.');
    end if;
  end if;

  /* Snapshot BEFORE the delete, into a table with no FK to tasks so it survives
     the rows it describes. task_activity cannot hold this: its FK is
     ON DELETE CASCADE and the record would be erased with the task. */
  insert into public.audit_log(table_name, row_id, operation, old_data, new_data, changed_by)
  select 'tasks', t.id::text, 'DELETE', to_jsonb(t), null, auth.uid() from _tdb_rows t;

  select coalesce(jsonb_agg(t.clickup_task_id), '[]'::jsonb) into v_clickup
  from _tdb_rows t where t.clickup_task_id is not null;

  /* ONE STATEMENT. The set is all-or-nothing rather than partially applied. */
  delete from public.tasks where id in (select id from _tdb_rows);
  get diagnostics v_deleted = row_count;

  return jsonb_build_object(
    'ok', v_deleted > 0,
    'reason', case when v_deleted > 0 then 'deleted' else 'not_found' end,
    'requested', v_requested,
    'matched', v_matched,
    'deleted', v_deleted,
    'missing_ids', v_missing,
    'clickup_task_ids', v_clickup);
end; $function$;

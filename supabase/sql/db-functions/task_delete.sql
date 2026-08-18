-- task_delete(p_id uuid, p_force boolean)
-- language: plpgsql
-- Captured from production 2026-08-18.

CREATE OR REPLACE FUNCTION public.task_delete(p_id uuid, p_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_task   public.tasks;
  v_active text[] := array['Contacted','Follow Up','Pre-Approved','Under Contract','Processing','Clear to Close'];
  v_stage  text;
  v_n      int;
begin
  -- Same effective gate as va_task_delete: admin or service_role only.
  if coalesce(auth.role(),'') is distinct from 'service_role' and not is_admin() then
    raise exception 'Deleting tasks is restricted to admins';
  end if;

  select * into v_task from public.tasks where id = p_id;

  -- NOT a silent no-op. A delete that reports success having matched nothing is
  -- the failure this codebase has hit repeatedly.
  if v_task.id is null then
    return jsonb_build_object(
      'ok', false, 'reason', 'not_found',
      'message', 'No task with that id — nothing was deleted.');
  end if;

  if v_task.related_table = 'auto_followup_lead' and not p_force then
    select c.pipeline_status into v_stage from public.contacts c where c.id = v_task.contact_id;
    if v_stage = any(v_active) then
      return jsonb_build_object(
        'ok', false, 'reason', 'will_recreate',
        'stage', v_stage,
        'clickup_task_id', v_task.clickup_task_id,
        'title', v_task.title,
        'message', 'This task was created automatically because the lead has gone quiet, and '
                || coalesce(v_stage,'this stage') || ' is still an active stage. Deleting it does not '
                || 'dismiss it — the sweeper will create it again on its next run. Close it out by '
                || 'contacting the lead or moving them out of the active pipeline, or delete anyway.');
    end if;
  end if;

  /* The snapshot goes in BEFORE the delete, and to a table with no FK to tasks,
     so it survives the row it describes. */
  insert into public.audit_log(table_name, row_id, operation, old_data, new_data, changed_by)
  values ('tasks', p_id::text, 'DELETE', to_jsonb(v_task), null, auth.uid());

  delete from public.tasks where id = p_id;
  get diagnostics v_n = row_count;

  return jsonb_build_object(
    'ok', v_n > 0,
    'reason', case when v_n > 0 then 'deleted' else 'not_found' end,
    'deleted', v_n,
    'title', v_task.title,
    -- the caller removes the ClickUp counterpart; returning the id is what makes
    -- that possible, and audit_log keeps it if the caller fails.
    'clickup_task_id', v_task.clickup_task_id);
end; $function$;

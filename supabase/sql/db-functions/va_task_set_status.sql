-- va_task_set_status(p_id uuid, p_status text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.va_task_set_status(p_id uuid, p_status text)
 RETURNS tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row tasks; v_old text;
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not (is_admin() or coalesce(current_app_role(),'') in ('va','agent')) then
    raise exception 'not authorized';
  end if;
  select status into v_old from tasks where id = p_id;
  update tasks set status = p_status, updated_at = now()
  where id = p_id returning * into v_row;
  if v_row.id is null then raise exception 'Task not found'; end if;
  if p_status = 'completed' and coalesce(v_old,'') is distinct from 'completed' then
    perform _log_task_activity(p_id, 'completed', null, jsonb_build_object('from', v_old, 'to', p_status));
  elsif coalesce(v_old,'') = 'completed' and p_status is distinct from 'completed' then
    perform _log_task_activity(p_id, 'reopened', null, jsonb_build_object('from', v_old, 'to', p_status));
  else
    perform _log_task_activity(p_id, 'status_changed', null, jsonb_build_object('from', v_old, 'to', p_status));
  end if;
  return v_row;
end; $function$;

-- va_task_update(p_id uuid, p_title text, p_priority text, p_due_date timestamp without time zone, p_description text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.va_task_update(p_id uuid, p_title text, p_priority text DEFAULT 'normal'::text, p_due_date timestamp without time zone DEFAULT NULL::timestamp without time zone, p_description text DEFAULT NULL::text)
 RETURNS tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row tasks;
begin
  if auth.role() = 'authenticated' and not (is_admin() or coalesce(current_app_role(),'') in ('va','agent')) then
    raise exception 'not authorized';
  end if;
  if nullif(trim(coalesce(p_title,'')),'') is null then raise exception 'Title is required'; end if;
  update tasks set
    title = trim(p_title),
    priority = coalesce(nullif(lower(trim(coalesce(p_priority,''))),''),'normal'),
    due_date = p_due_date,
    description = nullif(trim(coalesce(p_description,'')),''),
    updated_at = now()
  where id = p_id returning * into v_row;
  if v_row.id is null then raise exception 'Task not found'; end if;
  perform _log_task_activity(p_id, 'edited');
  return v_row;
end; $function$;

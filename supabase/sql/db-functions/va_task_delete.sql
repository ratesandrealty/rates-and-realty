-- va_task_delete(p_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.va_task_delete(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_n int;
begin
  if auth.role() = 'authenticated' and not (is_admin() or coalesce(current_app_role(),'') in ('va','agent')) then
    raise exception 'not authorized';
  end if;
  if coalesce(current_app_role(),'') in ('va','agent') then
    raise exception 'Deleting tasks is restricted to admins';
  end if;
  delete from tasks where id = p_id;
  get diagnostics v_n = row_count;
  return v_n > 0;
end; $function$;

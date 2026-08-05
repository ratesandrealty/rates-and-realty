-- fn_tasks_block_reopen()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.fn_tasks_block_reopen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if coalesce(current_app_role(),'none') in ('va','agent') then
    if OLD.status = 'completed' and (NEW.status is distinct from 'completed') then
      raise exception 'Reopening a completed task is restricted to admins';
    end if;
  end if;
  return NEW;
end $function$;

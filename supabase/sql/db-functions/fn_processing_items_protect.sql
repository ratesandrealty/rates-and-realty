-- fn_processing_items_protect()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.fn_processing_items_protect()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if coalesce(current_app_role(),'none') in ('va','agent') then
    if OLD.completed is true and (NEW.completed is distinct from true) then
      raise exception 'Reopening a completed checklist item is restricted to admins';
    end if;
    if OLD.status = 'done' and (NEW.status is distinct from 'done') then
      raise exception 'Reopening a completed checklist item is restricted to admins';
    end if;
    if coalesce(OLD.dismissed,false) = false and NEW.dismissed is true then
      raise exception 'Removing a checklist item is restricted to admins';
    end if;
  end if;
  return NEW;
end $function$;

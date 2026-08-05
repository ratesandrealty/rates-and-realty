-- tg_tasks_stamp_completion()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.tg_tasks_stamp_completion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if NEW.status = 'completed'
     and (TG_OP = 'INSERT' or NEW.status is distinct from OLD.status) then
    if NEW.completed_at is null then NEW.completed_at := now(); end if;
    NEW.completed_by := auth.uid();
    NEW.completed_source := case when auth.uid() is not null then 'user' else 'system' end;
  end if;
  -- leaving completed (if ever allowed) clears the stamps
  if TG_OP = 'UPDATE' and NEW.status is distinct from OLD.status and NEW.status <> 'completed' then
    NEW.completed_at := null; NEW.completed_by := null; NEW.completed_source := null;
  end if;
  return NEW;
end;
$function$;

-- tg_tasks_set_origin()
-- language: plpgsql
-- Captured from production 2026-08-18.

CREATE OR REPLACE FUNCTION public.tg_tasks_set_origin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  if NEW.origin is null then
    NEW.origin := case
      when NEW.clickup_task_id is not null then 'clickup'
      when auth.uid() is null               then 'system'
      else 'user'
    end;
  end if;
  return NEW;
end; $function$;

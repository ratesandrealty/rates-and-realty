-- tg_tasks_enqueue_clickup()
-- language: plpgsql
-- Captured from production 2026-08-15.

CREATE OR REPLACE FUNCTION public.tg_tasks_enqueue_clickup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* AFTER INSERT only. Never throws: a task that cannot be queued for ClickUp
   must still exist. order_reminders_run runs inside a cron transaction and an
   exception here would roll back the reminder itself, which is a far worse
   outcome than a task that is late to ClickUp. */
begin
  begin
    perform public.clickup_enqueue(NEW.id);
  exception when others then
    null;
  end;
  return null;
end;
$function$;

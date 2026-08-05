-- tg_log_pipeline_stage_change()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.tg_log_pipeline_stage_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'UPDATE'
     and new.pipeline_status is distinct from old.pipeline_status
     and new.pipeline_status is not null then
    insert into public.pipeline_stage_history(contact_id, from_stage, to_stage, changed_by, changed_at)
    values (new.id, old.pipeline_status, new.pipeline_status, auth.uid(), now());
  end if;
  return new;
end;
$function$;

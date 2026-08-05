-- trg_clickup_closed_won()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.trg_clickup_closed_won()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (NEW.pipeline_status IN ('closed_won','won','closed-won','Closed Won','Closed')
      AND (OLD.pipeline_status IS NULL OR OLD.pipeline_status NOT IN ('closed_won','won','closed-won','Closed Won','Closed'))) THEN
    PERFORM fire_clickup_automation('closed_won', NEW.id, NEW.id::text, '{}'::jsonb);
  END IF;
  RETURN NEW;
END;
$function$;

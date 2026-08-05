-- trg_clickup_new_lead()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.trg_clickup_new_lead()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM fire_clickup_automation('new_lead', NEW.id, NEW.id::text, 
    jsonb_build_object('lead_source', COALESCE(NEW.lead_source, NEW.source, 'unknown')));
  RETURN NEW;
END;
$function$;

-- generate_contact_crm_id()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.generate_contact_crm_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.crm_id IS NULL THEN
    NEW.crm_id := 'RR-' || UPPER(SUBSTRING(REPLACE(NEW.id::text, '-', ''), 1, 6));
  END IF;
  RETURN NEW;
END;
$function$;

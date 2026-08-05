-- sync_lead_to_contact()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.sync_lead_to_contact()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- If lead has a contact_id, just update the timestamp
  IF NEW.contact_id IS NOT NULL THEN
    UPDATE contacts SET
      updated_at = now()
    WHERE id = NEW.contact_id;
  END IF;
  RETURN NEW;
END;
$function$;

-- sync_contact_to_lead()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.sync_contact_to_lead()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_lead_exists boolean;
BEGIN
  -- Check if a lead already exists for this contact
  SELECT EXISTS(SELECT 1 FROM leads WHERE contact_id = NEW.id) INTO v_lead_exists;
  
  IF NOT v_lead_exists THEN
    INSERT INTO leads (
      contact_id, status, source, created_at, updated_at
    ) VALUES (
      NEW.id,
      COALESCE(NEW.status, 'New Lead'),
      COALESCE(NEW.source, 'Manual'),
      now(),
      now()
    ) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

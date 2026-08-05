-- sync_contact_email_open_counters()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.sync_contact_email_open_counters()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.contact_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.open_count IS DISTINCT FROM COALESCE(OLD.open_count, 0) THEN
    UPDATE contacts
    SET email_opens = COALESCE((SELECT SUM(open_count) FROM email_log WHERE contact_id = NEW.contact_id AND open_count > 0), 0)
    WHERE id = NEW.contact_id;
  END IF;
  IF NEW.click_count IS DISTINCT FROM COALESCE(OLD.click_count, 0) THEN
    UPDATE contacts
    SET email_clicks = COALESCE((SELECT SUM(click_count) FROM email_log WHERE contact_id = NEW.contact_id AND click_count > 0), 0)
    WHERE id = NEW.contact_id;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'sync_contact_email_open_counters: %', SQLERRM;
  RETURN NEW;
END;
$function$;

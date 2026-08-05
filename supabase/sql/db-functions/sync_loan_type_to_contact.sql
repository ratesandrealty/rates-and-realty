-- sync_loan_type_to_contact()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.sync_loan_type_to_contact()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.loan_type IS NOT NULL AND NEW.loan_type != '' THEN
    UPDATE contacts
    SET loan_type = NEW.loan_type, updated_at = now()
    WHERE (id = NEW.contact_id OR email = NEW.email)
      AND (loan_type IS NULL OR loan_type = '' OR loan_type != NEW.loan_type);
  END IF;
  RETURN NEW;
END;
$function$;

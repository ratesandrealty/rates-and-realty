-- sync_lender_from_contact()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.sync_lender_from_contact()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE lenders l
  SET last_contacted_at = sub.max_date,
      next_follow_up_date = sub.next_fu,
      updated_at = now()
  FROM (
    SELECT
      lender_id,
      MAX(contact_date) AS max_date,
      MIN(next_follow_up_date) FILTER (WHERE next_follow_up_date >= CURRENT_DATE) AS next_fu
    FROM lender_contacts
    WHERE lender_id = COALESCE(NEW.lender_id, OLD.lender_id)
    GROUP BY lender_id
  ) sub
  WHERE l.id = sub.lender_id;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- set_batch_share_token()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.set_batch_share_token()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.share_token IS NULL OR NEW.share_token = '' THEN
    NEW.share_token := generate_tour_share_token();
  END IF;
  RETURN NEW;
END;
$function$;

-- generate_tour_share_token()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.generate_tour_share_token()
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  chars text := 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := '';
  i integer;
BEGIN
  FOR i IN 1..10 LOOP
    result := result || substr(chars, floor(random() * length(chars))::int + 1, 1);
  END LOOP;
  RETURN result;
END;
$function$;

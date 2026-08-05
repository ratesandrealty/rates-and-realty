-- lead_tier(p_score numeric)
-- language: sql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.lead_tier(p_score numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when coalesce(p_score,0) >= 50 then 'hot'
    when coalesce(p_score,0) >= 40 then 'warm'
    else 'cold'
  end;
$function$;

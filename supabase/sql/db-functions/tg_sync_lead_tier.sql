-- tg_sync_lead_tier()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.tg_sync_lead_tier()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.score_tier := lead_tier(new.lead_score);
  new.lead_temperature := initcap(new.score_tier);
  return new;
end; $function$;

-- normalize_lead_source(p_source text)
-- language: sql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.normalize_lead_source(p_source text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when p_source is null or btrim(p_source) = '' then 'Other'
    when lower(p_source) ~ '(referr|word of mouth|wom\M)' then 'Referral'
    when lower(p_source) ~ '(csv|mismo|mail[_ ]?parser|\mimport\M|encompass|\memc\M)' then 'Import'
    when lower(p_source) ~ '(open house)' then 'Open House'
    when lower(p_source) ~ '(past client|repeat|previous client)' then 'Past Client'
    when lower(p_source) ~ '(opcity|zillow|realtor|lending ?tree|bankrate|nerdwallet|portal|bought)' then 'Portal/Paid'
    when lower(p_source) ~ '(google|website|\mweb\M|chat|social|facebook|instagram|\mseo\M|online|incom|landing)' then 'Online'
    else 'Other'
  end
$function$;

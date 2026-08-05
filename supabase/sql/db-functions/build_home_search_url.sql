-- build_home_search_url(p_filters jsonb)
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.build_home_search_url(p_filters jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare parts text[] := '{}'; v text;
begin
  v := nullif(trim(coalesce(p_filters->>'cities', p_filters->>'city')),'');
  if v is not null then parts := parts || array['cities='||replace(replace(v,' ','+'),',','%2C')]; end if;

  v := nullif(trim(coalesce(p_filters->>'counties', p_filters->>'county')),'');
  if v is not null then parts := parts || array['counties='||replace(v,' ','+')]; end if;

  v := nullif(trim(p_filters->>'minPrice'),''); if v is not null then parts := parts || array['min_price='||v]; end if;
  v := nullif(trim(p_filters->>'maxPrice'),''); if v is not null then parts := parts || array['max_price='||v]; end if;

  -- CORRECT param names: min_beds / min_baths (working links use these, not beds/baths)
  v := nullif(trim(coalesce(p_filters->>'minBeds', p_filters->>'min_beds')),'');
  if v is not null then parts := parts || array['min_beds='||v]; end if;
  v := nullif(trim(coalesce(p_filters->>'minBaths', p_filters->>'min_baths')),'');
  if v is not null then parts := parts || array['min_baths='||v]; end if;

  v := nullif(trim(coalesce(p_filters->>'propType', p_filters->>'property_types')),'');
  if v is not null then
    v := case upper(v)
           when 'SFR' then 'Single Family' when 'SINGLE FAMILY' then 'Single Family'
           when 'CONDO' then 'Condo' when 'TOWNHOUSE' then 'Townhouse'
           when 'MULTI' then 'Multi-Family' when 'MULTI-FAMILY' then 'Multi-Family'
           else v end;
    parts := parts || array['property_types='||replace(replace(v,' ','+'),',','%2C')];
  end if;

  parts := parts || array['statuses=Active%2CComingSoon'];

  return 'https://homes.ratesandrealty.com/public/search-homes.html?' || array_to_string(parts,'&');
end; $function$;

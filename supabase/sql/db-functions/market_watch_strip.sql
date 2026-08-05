-- market_watch_strip()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.market_watch_strip()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_latest record; v_prev record; v_wk record; v_mo record;
  v_ty_latest record; v_ty_prev record;
  v_spark jsonb; v_spark_10y jsonb;
  v_lo numeric; v_hi numeric; v_context text;
  v_result jsonb;
begin
  select * into v_latest from market_rates where rate_30yr is not null order by rate_date desc limit 1;
  if v_latest is null then return jsonb_build_object('ok', false, 'error', 'no data'); end if;

  select * into v_prev from market_rates where rate_30yr is not null and rate_date < v_latest.rate_date order by rate_date desc limit 1;
  select * into v_wk from market_rates where rate_30yr is not null and rate_date <= v_latest.rate_date - 7 order by rate_date desc limit 1;
  select * into v_mo from market_rates where rate_30yr is not null and rate_date <= v_latest.rate_date - 30 order by rate_date desc limit 1;

  -- 30yr sparkline (last 30 pts oldest->newest)
  select jsonb_agg(x.rate_30yr order by x.rate_date) into v_spark
  from (select rate_date, rate_30yr from market_rates where rate_30yr is not null order by rate_date desc limit 30) x;

  -- 6-week low/high context for the 30yr
  select min(rate_30yr), max(rate_30yr) into v_lo, v_hi
  from market_rates where rate_30yr is not null and rate_date >= v_latest.rate_date - 42;
  if v_latest.rate_30yr <= v_lo then v_context := 'at a 6-week low';
  elsif v_latest.rate_30yr >= v_hi then v_context := 'at a 6-week high';
  else v_context := null; end if;

  -- Treasury yields (our treasury_yields table, public govt data)
  select * into v_ty_latest from treasury_yields where y_10yr is not null order by yield_date desc limit 1;
  select * into v_ty_prev from treasury_yields where y_10yr is not null and yield_date < v_ty_latest.yield_date order by yield_date desc limit 1;
  select jsonb_agg(x.y_10yr order by x.yield_date) into v_spark_10y
  from (select yield_date, y_10yr from treasury_yields where y_10yr is not null order by yield_date desc limit 30) x;

  v_result := jsonb_build_object(
    'ok', true,
    'as_of', v_latest.rate_date,
    'fetched_at', v_latest.fetched_at,
    'context', v_context,
    'rates', jsonb_build_array(
      jsonb_build_object('label','30 Yr Fixed','key','30yr','value',v_latest.rate_30yr,
        'change', round((v_latest.rate_30yr - coalesce(v_prev.rate_30yr, v_latest.rate_30yr))::numeric,2),
        'change_wk', case when v_wk.rate_30yr is not null then round((v_latest.rate_30yr - v_wk.rate_30yr)::numeric,2) else null end,
        'change_mo', case when v_mo.rate_30yr is not null then round((v_latest.rate_30yr - v_mo.rate_30yr)::numeric,2) else null end),
      jsonb_build_object('label','15 Yr Fixed','key','15yr','value',v_latest.rate_15yr,
        'change', round((v_latest.rate_15yr - coalesce(v_prev.rate_15yr, v_latest.rate_15yr))::numeric,2)),
      jsonb_build_object('label','FHA 30 Yr','key','fha','value',v_latest.rate_fha,
        'change', round((v_latest.rate_fha - coalesce(v_prev.rate_fha, v_latest.rate_fha))::numeric,2)),
      jsonb_build_object('label','VA 30 Yr','key','va','value',v_latest.rate_va,
        'change', round((v_latest.rate_va - coalesce(v_prev.rate_va, v_latest.rate_va))::numeric,2)),
      jsonb_build_object('label','Jumbo 30 Yr','key','jumbo','value',v_latest.rate_jumbo,
        'change', round((v_latest.rate_jumbo - coalesce(v_prev.rate_jumbo, v_latest.rate_jumbo))::numeric,2))
    ),
    'treasury', case when v_ty_latest is null then null else jsonb_build_object(
      'as_of', v_ty_latest.yield_date,
      'yields', jsonb_build_array(
        jsonb_build_object('label','10-Yr Treasury','key','10yr','value',v_ty_latest.y_10yr,
          'change', case when v_ty_prev.y_10yr is not null then round((v_ty_latest.y_10yr - v_ty_prev.y_10yr)::numeric,2) else null end),
        jsonb_build_object('label','30-Yr Treasury','key','30yr','value',v_ty_latest.y_30yr,
          'change', case when v_ty_prev.y_30yr is not null then round((v_ty_latest.y_30yr - v_ty_prev.y_30yr)::numeric,2) else null end),
        jsonb_build_object('label','2-Yr Treasury','key','2yr','value',v_ty_latest.y_2yr,
          'change', case when v_ty_prev.y_2yr is not null then round((v_ty_latest.y_2yr - v_ty_prev.y_2yr)::numeric,2) else null end)
      ),
      'spark_10yr', coalesce(v_spark_10y, '[]'::jsonb)
    ) end,
    'spark_30yr', coalesce(v_spark, '[]'::jsonb)
  );
  return v_result;
end; $function$;

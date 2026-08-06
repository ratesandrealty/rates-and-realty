-- pipeline_velocity_report(p_from date, p_to date)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-06. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.pipeline_velocity_report(p_from date DEFAULT ((now() - '365 days'::interval))::date, p_to date DEFAULT (now())::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_from timestamptz := p_from::timestamptz;
  v_to   timestamptz := (p_to + 1)::timestamptz;
  v_role text := coalesce(current_app_role(), '');
  result jsonb;
begin
  -- admin-only (this exposes funded volume); service_role/MCP pass through
  if auth.role() = 'authenticated' and not is_admin() then
    raise exception 'Not authorized to view pipeline velocity report';
  end if;

  with funded as (
    -- Funded deals in range; treat same-/next-day "closes" as import artifacts (exclude from timing)
    select
      c.id, c.first_name||' '||c.last_name as name,
      c.created_at::date as lead_created, c.closed_date,
      (c.closed_date - c.created_at::date) as days_to_fund,
      c.loan_amount, normalize_lead_source(c.source) as source
    from contacts c
    where c.closed_date is not null
      and c.closed_date >= p_from and c.closed_date <= p_to
  ),
  funded_real as (
    select * from funded where days_to_fund >= 5  -- exclude import-dated artifacts
  ),
  -- Active pipeline = real working stages, NOT the dead "New Lead" import bucket
  active as (
    select c.*,
           extract(epoch from (now() - c.created_at))/86400.0 as age_days
    from contacts c
    where c.pipeline_status in ('Contacted','Follow Up','Pre-Approved','Under Contract','Processing','Clear to Close')
  ),
  time_to_fund as (
    select
      count(*) as funded_count,
      count(*) filter (where days_to_fund >= 5) as funded_timed,
      round(avg(days_to_fund) filter (where days_to_fund >= 5)::numeric,0) as avg_days,
      round((percentile_cont(0.5) within group (order by days_to_fund)
             filter (where days_to_fund >= 5))::numeric,0) as median_days,
      min(days_to_fund) filter (where days_to_fund >= 5) as fastest_days,
      max(days_to_fund) filter (where days_to_fund >= 5) as slowest_days,
      coalesce(sum(loan_amount),0) as funded_volume
    from funded
  ),
  by_stage as (
    select
      pipeline_status as stage,
      count(*) as n,
      round(avg(age_days)::numeric,0) as avg_age_days,
      round((percentile_cont(0.5) within group (order by age_days))::numeric,0) as median_age_days,
      max(age_days)::int as oldest_age_days
    from active
    group by pipeline_status
  ),
  stalled as (
    -- active deals sitting unusually long (>45d) — surfacing "stuck" deals
    select coalesce(jsonb_agg(row_to_json(s) order by s.age_days desc) filter (where s.id is not null), '[]'::jsonb) as items
    from (
      select a.id, a.first_name||' '||a.last_name as name, a.pipeline_status as stage,
             round(a.age_days::numeric,0) as age_days, a.loan_amount,
             a.last_contact_date::date as last_contact
      from active a
      where a.age_days > 45
      order by a.age_days desc
      limit 15
    ) s
  ),
  recent_funded as (
    select coalesce(jsonb_agg(row_to_json(r)) filter (where r.id is not null), '[]'::jsonb) as items
    from (
      select id, name, lead_created, closed_date, days_to_fund, loan_amount, source
      from funded order by closed_date desc limit 15
    ) r
  )
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'time_to_fund', (select row_to_json(t) from time_to_fund t),
    'by_stage', coalesce((select jsonb_agg(
        jsonb_build_object('stage', stage, 'n', n, 'avg_age_days', avg_age_days,
                           'median_age_days', median_age_days, 'oldest_age_days', oldest_age_days)
        order by case stage
          when 'Contacted' then 1 when 'Follow Up' then 2 when 'Pre-Approved' then 3 when 'Under Contract' then 4
          when 'Processing' then 5 when 'Clear to Close' then 6 else 7 end)
      from by_stage), '[]'::jsonb),
    'active_pipeline_count', (select count(*) from active),
    'stalled_deals', (select items from stalled),
    'recent_funded', (select items from recent_funded),
    'note', 'Time-to-fund excludes deals closing <5 days from lead creation (bulk-import date artifacts). Aging excludes the New Lead import bucket and reflects active working stages only.',
    'generated_at', now()
  ) into result;

  return result;
end;
$function$;

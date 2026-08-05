-- production_report(p_from date, p_to date)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.production_report(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_from date := coalesce(p_from, date '1900-01-01');
  v_to   date := coalesce(p_to, current_date);
  v_can_earn boolean;
  v_res jsonb;
begin
  if auth.role() = 'authenticated' and not is_admin() then
    raise exception 'not authorized';
  end if;
  -- admin always sees earnings; otherwise honor toggle; service_role/MCP (non-authenticated) sees all
  v_can_earn := coalesce(is_admin(), false)
                or coalesce(can_see_earnings(), false)
                or (coalesce(auth.role(),'') not in ('authenticated','anon'));

  with earn as (
    select contact_id,
           coalesce(sum(actual_earnings),0)    as act,
           coalesce(sum(estimated_earnings),0) as est
    from contact_earnings group by contact_id
  ),
  rep as (
    select c.id, c.first_name, c.last_name, c.pipeline_status, c.deal_outcome,
           c.loan_amount, c.loan_type, c.closed_date, c.created_at, c.source,
           normalize_lead_source(c.source) as src_bucket,
           case when lower(coalesce(c.loan_type,'')) in ('fha','va','usda') then upper(c.loan_type)
                when lower(coalesce(c.loan_type,'')) = 'conventional' then 'Conventional'
                when coalesce(c.loan_type,'') = '' then 'Unknown'
                else initcap(c.loan_type) end as loan_type_norm,
           (c.pipeline_status is distinct from 'New Lead')                       as engaged,
           (c.created_at::date between v_from and v_to)                          as lead_in_range,
           (c.deal_outcome = 'won'
              and coalesce(c.closed_date, c.created_at::date) between v_from and v_to) as funded_in_range,
           coalesce(e.act,0) as earn_act,
           coalesce(e.est,0) as earn_est
    from contacts c
    left join earn e on e.contact_id = c.id
  )
  select jsonb_build_object(
    'generated_at', now(),
    'date_from', v_from,
    'date_to', v_to,
    'can_see_earnings', v_can_earn,
    'kpis', (
      select jsonb_build_object(
        'total_leads',   count(*) filter (where lead_in_range),
        'real_leads',    count(*) filter (where lead_in_range and src_bucket <> 'Import'),
        'funded_count',  count(*) filter (where funded_in_range),
        'funded_volume', coalesce(sum(loan_amount) filter (where funded_in_range),0),
        'avg_loan',      round(coalesce(avg(loan_amount) filter (where funded_in_range),0)),
        'open_pipeline_count', count(*) filter (where pipeline_status <> 'Closed'
                                  and coalesce(deal_outcome,'') not in ('won','lost')),
        'pending_count', count(*) filter (where deal_outcome = 'pending'),
        'total_earnings', case when v_can_earn then coalesce(sum(earn_act) filter (where funded_in_range),0) end,
        'avg_earnings_per_funded', case when v_can_earn then round(coalesce(avg(earn_act) filter (where funded_in_range),0)) end,
        'pending_est_earnings', case when v_can_earn then coalesce(sum(earn_est) filter (where deal_outcome='pending'),0) end,
        'conversion_overall_pct', round(100.0*count(*) filter (where funded_in_range)
                                    / nullif(count(*) filter (where lead_in_range),0), 2),
        'conversion_real_pct',    round(100.0*count(*) filter (where funded_in_range)
                                    / nullif(count(*) filter (where lead_in_range and src_bucket<>'Import'),0), 2),
        'conversion_engaged_pct', round(100.0*count(*) filter (where funded_in_range)
                                    / nullif(count(*) filter (where lead_in_range and engaged),0), 2)
      ) from rep
    ),
    'pipeline_by_stage', (
      select coalesce(jsonb_agg(jsonb_build_object('stage', stage, 'n', n, 'ord', ord) order by ord), '[]'::jsonb)
      from (
        select pipeline_status as stage, count(*) as n,
          case pipeline_status
            when 'New Lead' then 0 when 'Contacted' then 1 when 'Pre-Approved' then 2
            when 'Under Contract' then 3 when 'Processing' then 4 when 'Clear to Close' then 5
            when 'Closed' then 6 else 7 end as ord
        from rep group by pipeline_status
      ) s
    ),
    'by_source', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'source', src_bucket,
               'leads', leads, 'engaged', engaged_n, 'funded', funded_n,
               'volume', volume,
               'earnings', case when v_can_earn then earnings end,
               'conv_pct', round(100.0*funded_n/nullif(leads,0),2)
             ) order by funded_n desc, leads desc), '[]'::jsonb)
      from (
        select src_bucket,
               count(*) filter (where lead_in_range) as leads,
               count(*) filter (where lead_in_range and engaged) as engaged_n,
               count(*) filter (where funded_in_range) as funded_n,
               coalesce(sum(loan_amount) filter (where funded_in_range),0) as volume,
               coalesce(sum(earn_act) filter (where funded_in_range),0) as earnings
        from rep group by src_bucket
      ) bs
    ),
    'by_loan_type', (
      select coalesce(jsonb_agg(jsonb_build_object('loan_type', lt, 'funded', funded_n, 'volume', volume)
                      order by funded_n desc), '[]'::jsonb)
      from (
        select loan_type_norm as lt,
               count(*) as funded_n,
               coalesce(sum(loan_amount),0) as volume
        from rep where funded_in_range group by 1
      ) lt
    ),
    'monthly_trend', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'month', to_char(m,'YYYY-MM'),
               'funded_count', cnt, 'funded_volume', vol,
               'earnings', case when v_can_earn then earn end) order by m), '[]'::jsonb)
      from (
        select date_trunc('month', coalesce(closed_date, created_at::date))::date as m,
               count(*) as cnt,
               coalesce(sum(loan_amount),0) as vol,
               coalesce(sum(earn_act),0) as earn
        from rep where funded_in_range group by 1
      ) mt
    ),
    'recent_funded', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', id, 'name', btrim(coalesce(first_name,'')||' '||coalesce(last_name,'')),
               'source', src_bucket, 'raw_source', source,
               'loan_amount', loan_amount,
               'earnings', case when v_can_earn then earn_act end,
               'closed_date', closed_date) order by closed_date desc nulls last), '[]'::jsonb)
      from (select * from rep where funded_in_range order by closed_date desc nulls last limit 12) rf
    )
  ) into v_res;

  return v_res;
end;
$function$;

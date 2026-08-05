-- partner_overview(p_partner_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.partner_overview(p_partner_id uuid)
 RETURNS TABLE(referrals integer, won integer, lost integer, active integer, volume numeric, earnings numeric, potential_volume numeric, potential_earnings numeric, conversion_rate numeric, avg_loan numeric, avg_earn_per_won numeric, rank_by_earnings integer, total_partners integer, last_referral_at timestamp without time zone, last_activity_at timestamp without time zone, monthly jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.role() = 'authenticated' and not public.is_admin() then raise exception 'admin only'; end if;
  return query
  with c as (
    select co.id, co.deal_outcome, co.loan_amount, co.created_at,
           ce.actual_earnings, ce.estimated_earnings
    from contacts co
    left join contact_earnings ce on ce.contact_id = co.id
    where co.referral_partner_id = p_partner_id
  ),
  agg as (
    select
      count(*)::int refs,
      count(*) filter (where deal_outcome='won')::int won_c,
      count(*) filter (where deal_outcome='lost')::int lost_c,
      count(*) filter (where coalesce(deal_outcome,'') not in ('won','lost'))::int active_c,
      coalesce(sum(loan_amount) filter (where deal_outcome='won'),0) vol,
      coalesce(sum(actual_earnings) filter (where deal_outcome='won'),0) earn,
      coalesce(sum(loan_amount) filter (where coalesce(deal_outcome,'') not in ('won','lost')),0) pot_vol,
      coalesce(sum(coalesce(nullif(estimated_earnings,0), loan_amount*0.015))
               filter (where coalesce(deal_outcome,'') not in ('won','lost')),0) pot_earn,
      round(avg(loan_amount) filter (where loan_amount>0)) avg_loan_c,
      round(avg(actual_earnings) filter (where deal_outcome='won' and actual_earnings>0)) avg_earn_won,
      max(created_at) last_ref
    from c
  ),
  earn_unused as (select 1),
  ranks as (
    select partner_id,
           rank() over (order by coalesce(total_earnings,0) desc) rnk,
           count(*) over () npartners
    from partner_earnings
  ),
  r as (select rnk, npartners from ranks where partner_id = p_partner_id),
  la as (select max(created_at) last_act from activity_events where partner_id = p_partner_id),
  months as (
    select to_char(d,'YYYY-MM') ym
    from generate_series(date_trunc('month',now()) - interval '11 months', date_trunc('month',now()), interval '1 month') d
  ),
  mc as (
    select to_char(date_trunc('month',created_at),'YYYY-MM') ym,
           count(*) refs,
           count(*) filter (where deal_outcome='won') won_c,
           coalesce(sum(loan_amount) filter (where deal_outcome='won'),0) vol,
           coalesce(sum(loan_amount) filter (where coalesce(deal_outcome,'') not in ('won','lost')),0) pot,
           coalesce(sum(actual_earnings) filter (where deal_outcome='won'),0) earn
    from c where created_at is not null group by 1
  ),
  monthly as (
    select jsonb_agg(jsonb_build_object(
             'ym', m.ym,
             'referrals', coalesce(mc.refs,0),
             'won', coalesce(mc.won_c,0),
             'volume', coalesce(mc.vol,0),
             'potential', coalesce(mc.pot,0),
             'earnings', coalesce(mc.earn,0)
           ) order by m.ym) j
    from months m left join mc on mc.ym = m.ym
  )
  select agg.refs, agg.won_c, agg.lost_c, agg.active_c,
         agg.vol, agg.earn, agg.pot_vol, agg.pot_earn,
         case when (agg.won_c+agg.lost_c)>0 then round(agg.won_c::numeric/(agg.won_c+agg.lost_c),4) else null end,
         agg.avg_loan_c, agg.avg_earn_won,
         coalesce(r.rnk,0)::int, coalesce(r.npartners,0)::int,
         agg.last_ref::timestamp, la.last_act,
         monthly.j
  from agg, monthly, la left join r on true;
end;
$function$;

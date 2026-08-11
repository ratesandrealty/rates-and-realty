-- partner_goal_get(p_partner_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.partner_goal_get(p_partner_id uuid)
 RETURNS TABLE(metric text, period text, target numeric, current_value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare g record; v_start timestamp; v_cur numeric := 0;
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not public.is_admin() then raise exception 'admin only'; end if;
  select * into g from partner_goals where partner_id = p_partner_id;
  if not found then return; end if;
  v_start := case when g.period='annual' then date_trunc('year', now()) else date_trunc('month', now()) end;
  with c as (
    select co.deal_outcome, co.loan_amount, co.created_at, ce.actual_earnings
    from contacts co left join contact_earnings ce on ce.contact_id=co.id
    where co.referral_partner_id = p_partner_id and co.created_at >= v_start
  )
  select case g.metric
    when 'volume'    then coalesce(sum(loan_amount) filter (where deal_outcome='won'),0)
    when 'earnings'  then coalesce(sum(actual_earnings) filter (where deal_outcome='won'),0)
    when 'referrals' then count(*)::numeric
    when 'closings'  then count(*) filter (where deal_outcome='won')::numeric
    else 0 end
  into v_cur from c;
  return query select g.metric, g.period, g.target, coalesce(v_cur,0);
end;
$function$;

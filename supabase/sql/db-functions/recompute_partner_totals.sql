-- recompute_partner_totals(p_partner_id uuid)
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.recompute_partner_totals(p_partner_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  update referral_partners rp set
    total_referrals = x.refs,
    total_closed    = x.won,
    total_volume    = x.vol,
    updated_at      = now()
  from (
    select count(c.id) refs,
           count(c.id) filter (where c.deal_outcome='won') won,
           coalesce(sum(c.loan_amount) filter (where c.deal_outcome='won'),0) vol
    from contacts c where c.referral_partner_id = p_partner_id
  ) x
  where rp.id = p_partner_id;
$function$;

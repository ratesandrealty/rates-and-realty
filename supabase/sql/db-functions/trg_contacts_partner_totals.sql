-- trg_contacts_partner_totals()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.trg_contacts_partner_totals()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if tg_op = 'INSERT' then
    if new.referral_partner_id is not null then perform public.recompute_partner_totals(new.referral_partner_id); end if;
  elsif tg_op = 'DELETE' then
    if old.referral_partner_id is not null then perform public.recompute_partner_totals(old.referral_partner_id); end if;
  else
    if new.referral_partner_id is distinct from old.referral_partner_id then
      if old.referral_partner_id is not null then perform public.recompute_partner_totals(old.referral_partner_id); end if;
      if new.referral_partner_id is not null then perform public.recompute_partner_totals(new.referral_partner_id); end if;
    elsif (new.deal_outcome is distinct from old.deal_outcome)
       or (new.loan_amount  is distinct from old.loan_amount) then
      if new.referral_partner_id is not null then perform public.recompute_partner_totals(new.referral_partner_id); end if;
    end if;
  end if;
  return null;
end;
$function$;

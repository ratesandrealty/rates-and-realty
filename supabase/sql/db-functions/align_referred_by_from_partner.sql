-- align_referred_by_from_partner()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.align_referred_by_from_partner()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare p_name text;
begin
  if NEW.referral_partner_id is distinct from OLD.referral_partner_id
     and NEW.referral_partner_id is not null then
    select nullif(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), '')
      into p_name
    from referral_partners
    where id = NEW.referral_partner_id;
    if p_name is not null then
      NEW.referred_by := p_name;
    end if;
  end if;
  return NEW;
end $function$;

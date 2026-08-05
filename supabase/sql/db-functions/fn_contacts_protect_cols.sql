-- fn_contacts_protect_cols()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.fn_contacts_protect_cols()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if coalesce(current_app_role(),'none') in ('va','agent') then
    NEW.estimated_earnings := OLD.estimated_earnings;
    NEW.actual_earnings    := OLD.actual_earnings;
    NEW.deal_outcome       := OLD.deal_outcome;
    NEW.closed_date        := OLD.closed_date;
    NEW.lost_reason        := OLD.lost_reason;
    NEW.ssn_last4          := OLD.ssn_last4;
    NEW.date_of_birth      := OLD.date_of_birth;
  end if;
  return NEW;
end $function$;

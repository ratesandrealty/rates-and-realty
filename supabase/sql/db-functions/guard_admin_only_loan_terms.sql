-- guard_admin_only_loan_terms()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.guard_admin_only_loan_terms()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if coalesce(auth.role(),'') is distinct from 'service_role'
     and not public.is_admin()
     and not coalesce(public.is_borrower(), false) then

    if TG_TABLE_NAME = 'mortgage_applications' then
      if (NEW.locked_rate is distinct from OLD.locked_rate)
         or (NEW.rate_lock_expiry is distinct from OLD.rate_lock_expiry) then
        raise exception 'Rate lock (rate / expiry) is admin-only and cannot be changed by your role'
          using errcode = '42501';
      end if;
    elsif TG_TABLE_NAME = 'contacts' then
      if (NEW.loan_amount is distinct from OLD.loan_amount) then
        raise exception 'Loan amount is admin-only and cannot be changed by your role'
          using errcode = '42501';
      end if;
    end if;
  end if;
  return NEW;
end;
$function$;

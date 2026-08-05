-- mirror_contact_financials()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.mirror_contact_financials()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- income / credit -> contact_financials (capture BEFORE nulling)
  if (TG_OP = 'INSERT' and (NEW.annual_income is not null or NEW.monthly_income is not null
        or NEW.credit_score is not null or NEW.credit_score_range is not null))
     or (TG_OP = 'UPDATE' and (NEW.annual_income       is distinct from OLD.annual_income
        or NEW.monthly_income     is distinct from OLD.monthly_income
        or NEW.credit_score       is distinct from OLD.credit_score
        or NEW.credit_score_range is distinct from OLD.credit_score_range)) then
    insert into public.contact_financials (contact_id, annual_income, monthly_income, credit_score, credit_score_range, updated_at)
    values (NEW.id, NEW.annual_income, NEW.monthly_income, NEW.credit_score, NEW.credit_score_range, now())
    on conflict (contact_id) do update set
      annual_income      = coalesce(excluded.annual_income,      public.contact_financials.annual_income),
      monthly_income     = coalesce(excluded.monthly_income,     public.contact_financials.monthly_income),
      credit_score       = coalesce(excluded.credit_score,       public.contact_financials.credit_score),
      credit_score_range = coalesce(excluded.credit_score_range, public.contact_financials.credit_score_range),
      updated_at = now();
  end if;

  -- earnings -> contact_earnings (capture BEFORE nulling)
  if (TG_OP = 'INSERT' and (NEW.actual_earnings is not null or NEW.estimated_earnings is not null))
     or (TG_OP = 'UPDATE' and (NEW.actual_earnings    is distinct from OLD.actual_earnings
        or NEW.estimated_earnings is distinct from OLD.estimated_earnings)) then
    insert into public.contact_earnings (contact_id, actual_earnings, estimated_earnings, updated_at)
    values (NEW.id, NEW.actual_earnings, NEW.estimated_earnings, now())
    on conflict (contact_id) do update set
      actual_earnings    = coalesce(excluded.actual_earnings,    public.contact_earnings.actual_earnings),
      estimated_earnings = coalesce(excluded.estimated_earnings, public.contact_earnings.estimated_earnings),
      updated_at = now();
  end if;

  -- ARMED: these six never persist on contacts again.
  NEW.annual_income      := null;
  NEW.monthly_income     := null;
  NEW.credit_score       := null;
  NEW.credit_score_range := null;
  NEW.actual_earnings    := null;
  NEW.estimated_earnings := null;
  return NEW;
end;
$function$;

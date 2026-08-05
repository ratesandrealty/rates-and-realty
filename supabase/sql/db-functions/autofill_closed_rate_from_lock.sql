-- autofill_closed_rate_from_lock()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.autofill_closed_rate_from_lock()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  n integer;
begin
  with upd as (
    update public.mortgage_applications ma
    set closed_rate      = ma.locked_rate,
        closed_rate_date = coalesce(ma.closed_rate_date, ma.rate_lock_expiry, current_date),
        updated_at       = now()
    from public.contacts c
    where ma.contact_id = c.id
      and ma.closed_rate is null
      and ma.locked_rate is not null
      and ma.rate_lock_expiry is not null
      and ma.rate_lock_expiry <= current_date - interval '1 day'
      and c.deal_outcome = 'won'
    returning ma.id
  )
  select count(*) into n from upd;
  return n;
end;
$function$;

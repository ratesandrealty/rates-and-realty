-- property_estimates_keep_previous()
-- language: plpgsql
-- Captured from production 2026-08-11.

CREATE OR REPLACE FUNCTION public.property_estimates_keep_previous()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- Only when the value actually changes; a re-fetch returning the same number
  -- must not blank the prior reading by shifting it onto itself.
  if new.estimated_value is distinct from old.estimated_value then
    new.previous_value := old.estimated_value;
    new.previous_fetched_at := old.fetched_at;
  else
    new.previous_value := old.previous_value;
    new.previous_fetched_at := old.previous_fetched_at;
  end if;
  return new;
end $function$;

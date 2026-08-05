-- sync_contact_to_application()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.sync_contact_to_application()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if current_setting('app.sync_in_progress', true) = '1' then return NEW; end if;
  perform set_config('app.sync_in_progress', '1', true);

  update public.mortgage_applications ma set
    first_name    = coalesce(NEW.first_name,    ma.first_name),
    middle_name   = coalesce(NEW.middle_name,   ma.middle_name),
    last_name     = coalesce(NEW.last_name,     ma.last_name),
    date_of_birth = coalesce(NEW.date_of_birth, ma.date_of_birth),
    email         = coalesce(NEW.email,         ma.email),
    employer_name = coalesce(NEW.employer_name, ma.employer_name),
    cell_phone    = coalesce(NEW.phone,           ma.cell_phone),
    home_phone    = coalesce(NEW.secondary_phone, ma.home_phone),
    updated_at    = now()
  where ma.contact_id = NEW.id;

  perform set_config('app.sync_in_progress', '0', true);
  return NEW;
end; $function$;

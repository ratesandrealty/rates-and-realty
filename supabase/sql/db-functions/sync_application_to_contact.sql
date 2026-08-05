-- sync_application_to_contact()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.sync_application_to_contact()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if current_setting('app.sync_in_progress', true) = '1' then return NEW; end if;
  if NEW.contact_id is null then return NEW; end if;
  perform set_config('app.sync_in_progress', '1', true);

  update public.contacts c set
    first_name      = case when nullif(trim(coalesce(c.first_name,'')),'')      is null then NEW.first_name    else c.first_name end,
    middle_name     = case when nullif(trim(coalesce(c.middle_name,'')),'')     is null then NEW.middle_name   else c.middle_name end,
    last_name       = case when nullif(trim(coalesce(c.last_name,'')),'')       is null then NEW.last_name     else c.last_name end,
    date_of_birth   = case when c.date_of_birth is null                                 then NEW.date_of_birth else c.date_of_birth end,
    email           = case when nullif(trim(coalesce(c.email,'')),'')           is null then NEW.email         else c.email end,
    employer_name   = case when nullif(trim(coalesce(c.employer_name,'')),'')   is null then NEW.employer_name else c.employer_name end,
    phone           = case when nullif(trim(coalesce(c.phone,'')),'')           is null then NEW.cell_phone    else c.phone end,
    secondary_phone = case when nullif(trim(coalesce(c.secondary_phone,'')),'') is null then NEW.home_phone    else c.secondary_phone end,
    updated_at      = now()
  where c.id = NEW.contact_id;

  perform set_config('app.sync_in_progress', '0', true);
  return NEW;
end; $function$;

-- contacts_block_va_pii_edit()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.contacts_block_va_pii_edit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if coalesce(current_app_role(),'') = 'va' and not is_admin() then
    if new.first_name      is distinct from old.first_name
       or new.middle_name  is distinct from old.middle_name
       or new.last_name    is distinct from old.last_name
       or new.email        is distinct from old.email
       or new.secondary_email is distinct from old.secondary_email
       or new.phone        is distinct from old.phone
       or new.secondary_phone is distinct from old.secondary_phone then
      raise exception 'VAs cannot edit a contact''s name, email, or phone';
    end if;
  end if;
  return new;
end; $function$;

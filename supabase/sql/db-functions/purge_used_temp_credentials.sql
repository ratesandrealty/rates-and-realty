-- purge_used_temp_credentials()
-- language: plpgsql
-- Captured from production 2026-08-11.

CREATE OR REPLACE FUNCTION public.purge_used_temp_credentials()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  /* Only rows the sign-in actually supersedes. A temp password set AFTER this
     sign-in is a pending reset and must survive — otherwise resetting the
     password of someone already signed in would delete the value before the
     admin could read it. */
  delete from public.user_temp_credentials
  where user_id = NEW.id
    and set_at <= NEW.last_sign_in_at;
  return NEW;
exception when others then
  /* A CLEANUP TASK MUST NEVER BLOCK A SIGN-IN. This runs inside the auth
     transaction: an unhandled error here would make the login itself fail, and
     locking every user out of the CRM to avoid leaving a plaintext row for one
     more hour is not a trade anyone would choose. The hourly sweep below is the
     backstop if this ever silently no-ops. */
  raise warning 'purge_used_temp_credentials failed for %: %', NEW.id, sqlerrm;
  return NEW;
end $function$;

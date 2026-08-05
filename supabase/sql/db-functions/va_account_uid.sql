-- va_account_uid()
-- language: sql   SECURITY DEFINER
-- Captured 2026-08-05.

CREATE OR REPLACE FUNCTION public.va_account_uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* The VA account's uid, resolved BY ROLE. Never a hardcoded uuid: processing@
 * was renamed on 2026-08-05 and a recreated account would get a new id, so a
 * literal would fail silently and stamp a user that no longer exists.
 *
 * Returns null when there is not exactly ONE va. An unassigned task is
 * recoverable; one assigned to the wrong person is not. */
  select (array_agg(user_id))[1]
  from (select user_id from auth_user_roles where role = 'va' limit 2) q
  having count(*) = 1;
$function$;

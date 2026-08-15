-- staff_chat_contacts()
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-15. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.staff_chat_contacts()
 RETURNS TABLE(user_id uuid, email text, role text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
  select ar.user_id, u.email::text, ar.role
  from public.auth_user_roles ar
  join auth.users u on u.id = ar.user_id
  where ar.role in ('admin','agent','va','loa','staff')
    and ar.user_id <> auth.uid()
    and not ar.service_account /* a robot must not appear as someone you can message */
  order by array_position(array['admin','agent','loa','va','staff'], ar.role), u.email::text;
$function$;

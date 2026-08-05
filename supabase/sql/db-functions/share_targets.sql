-- share_targets()
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.share_targets()
 RETURNS TABLE(user_id uuid, role text, label text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
  select aur.user_id, aur.role, coalesce(u.email, aur.user_id::text) as label
  from public.auth_user_roles aur
  left join auth.users u on u.id = aur.user_id
  where public.is_admin()
    and aur.role in ('va','agent','staff','loa')
  order by aur.role, label;
$function$;

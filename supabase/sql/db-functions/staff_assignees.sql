-- staff_assignees()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.staff_assignees()
 RETURNS TABLE(user_id uuid, email text, role text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (is_admin() or coalesce(current_app_role(),'') in ('va','agent')) then
    raise exception 'not authorized';
  end if;
  return query
  select r.user_id, u.email::text, r.role
  from auth_user_roles r
  join auth.users u on u.id = r.user_id
  where r.role in ('va','agent','loa')
  order by r.role, u.email;
end; $function$;

-- lead_share_users(p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.lead_share_users(p_contact_id uuid)
 RETURNS TABLE(user_id uuid, email text, role text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  return query
  select ls.shared_with_user_id, u.email::text, r.role
  from public.lead_shares ls
  join auth.users u on u.id = ls.shared_with_user_id
  left join public.auth_user_roles r on r.user_id = ls.shared_with_user_id
  where ls.contact_id = p_contact_id
  order by u.email;
end; $function$;

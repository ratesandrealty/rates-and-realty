-- task_assignees()
-- language: plpgsql
-- Captured from production 2026-08-18.

CREATE OR REPLACE FUNCTION public.task_assignees()
 RETURNS TABLE(user_id uuid, display_name text, role text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  /* Staff only. Not admin-only: a va legitimately needs to see who a task could
     be assigned to, and the shape carries nothing she cannot already see. */
  if not (coalesce(auth.role(),'') = 'service_role'
          or is_admin()
          or coalesce(current_app_role(),'') in ('va','agent','loa','staff')) then
    raise exception 'not authorized';
  end if;

  return query
    select r.user_id,
           coalesce(nullif(trim(r.display_name),''), initcap(r.role))::text as display_name,
           r.role::text
    from public.auth_user_roles r
    where coalesce(r.service_account, false) = false
    order by (r.role = 'admin') desc, 2;
end; $function$;

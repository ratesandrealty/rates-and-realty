-- staff_display_names(p_ids uuid[])
-- language: plpgsql   STABLE SECURITY DEFINER
-- Added 2026-08-11. Captured on creation — observe-db-functions diffs
-- production against this directory, so an uncaptured function reads as
-- movement on every run.
--
-- WHY IT IS NOT staff_assignees(): that one returns only ('va','agent','loa'),
-- which is correct for an assignee picker and wrong for "who completed this" —
-- an admin's own completions would resolve to nothing. The page already carries
-- one workaround for that gap (`list.unshift({ local:'rene', ... })` in the
-- @-mention roster), and that hardcoded single admin is the same assumption
-- that made processing_items.completed_by='admin' render as a named person.
-- This returns every role, names nobody in code, and stays correct when a
-- second admin exists.
--
-- Same authorization gate as staff_assignees(), and it returns only the
-- identity already visible in the assignee and @-mention pickers, for the uids
-- the caller names.

CREATE OR REPLACE FUNCTION public.staff_display_names(p_ids uuid[])
 RETURNS TABLE(user_id uuid, email text, role text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (is_admin() or coalesce(current_app_role(),'') in ('va','agent','loa')) then
    raise exception 'not authorized';
  end if;
  return query
  select r.user_id, u.email::text, r.role
  from auth_user_roles r
  join auth.users u on u.id = r.user_id
  where r.user_id = any(coalesce(p_ids, '{}'::uuid[]));
end;
$function$;

-- revoke all on function public.staff_display_names(uuid[]) from public;
-- grant execute on function public.staff_display_names(uuid[]) to authenticated;

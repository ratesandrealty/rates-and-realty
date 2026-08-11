-- va_view_set(p_capability text, p_allowed boolean, p_role text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.va_view_set(p_capability text, p_allowed boolean, p_role text DEFAULT 'va'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not public.is_admin() then
    raise exception 'admin only';
  end if;
  if p_role = 'admin' then raise exception 'cannot restrict admin'; end if;
  if p_capability not in (
    'ssn','financials','earnings',
    'tab_lead_details','tab_loan_processing','tab_1003','tab_documents',
    'tab_conditions','tab_tasks','tab_activity','tab_alerts','tab_showings'
  ) then
    raise exception 'unknown capability: %', p_capability;
  end if;
  insert into public.role_visibility(role, capability, allowed, updated_at, updated_by)
  values (p_role, p_capability, p_allowed, now(), auth.uid())
  on conflict (role, capability)
    do update set allowed = excluded.allowed, updated_at = now(), updated_by = auth.uid();
  return public.va_view_get(p_role);
end; $function$;

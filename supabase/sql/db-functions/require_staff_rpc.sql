-- require_staff_rpc(p_what text)
-- language: plpgsql
-- Captured from production 2026-08-11.

CREATE OR REPLACE FUNCTION public.require_staff_rpc(p_what text DEFAULT 'This data'::text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if coalesce(auth.role(),'') = 'service_role' then return; end if;   -- internal callers
  if public.is_admin() then return; end if;
  if coalesce(public.current_app_role(),'') in ('va','agent','loa','staff') then return; end if;
  raise exception '% is staff only', p_what;
end $function$;

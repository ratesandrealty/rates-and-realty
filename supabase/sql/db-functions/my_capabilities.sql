-- my_capabilities()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.my_capabilities()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare v jsonb; r text;
begin
  if public.is_admin() then
    return jsonb_build_object('role','admin','all', true, 'caps', '{}'::jsonb);
  end if;
  r := coalesce(public.current_app_role(), '');
  select jsonb_object_agg(capability, allowed) into v
  from public.role_visibility where role = r;
  return jsonb_build_object('role', r, 'all', false, 'caps', coalesce(v, '{}'::jsonb));
end; $function$;

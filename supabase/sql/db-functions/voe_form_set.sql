-- voe_form_set(p_url text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.voe_form_set(p_url text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only'; end if;
  insert into public.app_config(key, value) values ('voe_form_url', p_url)
    on conflict (key) do update set value = excluded.value;
  return p_url;
end; $function$;

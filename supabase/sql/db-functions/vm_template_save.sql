-- vm_template_save(p_name text, p_url text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.vm_template_save(p_name text, p_url text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_id uuid;
begin
  if auth.role()='authenticated' and not public.is_admin() then raise exception 'admin only'; end if;
  insert into voicemail_templates(name, url, created_by) values (p_name, p_url, auth.uid()) returning id into v_id;
  return v_id;
end;
$function$;

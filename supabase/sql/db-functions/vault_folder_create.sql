-- vault_folder_create(p_name text, p_color text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.vault_folder_create(p_name text, p_color text DEFAULT NULL::text)
 RETURNS vault_folders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v public.vault_folders;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  insert into public.vault_folders(name, color) values (nullif(trim(p_name),''), p_color) returning * into v;
  return v;
end; $function$;

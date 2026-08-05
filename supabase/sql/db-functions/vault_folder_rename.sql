-- vault_folder_rename(p_id uuid, p_name text, p_color text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.vault_folder_rename(p_id uuid, p_name text, p_color text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  update public.vault_folders set name=coalesce(nullif(trim(p_name),''),name), color=coalesce(p_color,color) where id=p_id;
end; $function$;

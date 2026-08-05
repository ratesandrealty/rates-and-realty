-- vault_folders_list()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.vault_folders_list()
 RETURNS TABLE(id uuid, name text, color text, item_count integer, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  return query select f.id, f.name, f.color,
    (select count(*)::int from public.vault_folder_items i where i.folder_id=f.id), f.created_at
  from public.vault_folders f order by f.name;
end; $function$;

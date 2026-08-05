-- vault_folder_add_item(p_folder uuid, p_source text, p_source_id text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.vault_folder_add_item(p_folder uuid, p_source text, p_source_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  if p_source not in ('chat','esign','borrower') then raise exception 'bad source'; end if;
  insert into public.vault_folder_items(folder_id, source, source_id) values (p_folder, p_source, p_source_id)
  on conflict do nothing;
end; $function$;

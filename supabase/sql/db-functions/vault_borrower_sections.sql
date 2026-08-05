-- vault_borrower_sections()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.vault_borrower_sections()
 RETURNS TABLE(contact_id uuid, lead_name text, doc_count integer, gdrive_folder_url text, synced_count integer, unsynced_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  return query
  select c.id,
         nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'') as lead_name,
         count(d.id)::int as doc_count,
         c.gdrive_folder_url,
         count(d.id) filter (where d.gdrive_file_id is not null)::int as synced_count,
         count(d.id) filter (where d.gdrive_file_id is null)::int as unsynced_count
  from public.uploaded_documents d
  join public.contacts c on c.id = d.contact_id
  group by c.id, c.first_name, c.last_name, c.gdrive_folder_url
  order by lead_name nulls last;
end; $function$;

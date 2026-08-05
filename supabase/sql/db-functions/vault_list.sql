-- vault_list()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.vault_list()
 RETURNS TABLE(source text, id text, name text, category text, lead_name text, bucket text, is_public boolean, storage_path text, mime_type text, size_bytes bigint, created_at timestamp with time zone, extra jsonb, folders jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  return query
  select 'chat'::text, a.id::text, a.file_name, coalesce(a.kind,'file'), null::text,
         'chat-attachments'::text, false, a.storage_path,
         a.mime_type, a.size_bytes, a.created_at,
         jsonb_build_object('thread_id', a.thread_id),
         coalesce((select jsonb_agg(fi.folder_id) from vault_folder_items fi where fi.source='chat' and fi.source_id=a.id::text),'[]'::jsonb)
  from staff_message_attachments a
  union all
  select 'esign'::text, t.id::text, t.name, coalesce(t.document_type,'template'), null::text,
         'esign'::text, false, t.base_pdf_path,
         'application/pdf'::text, null::bigint, t.created_at,
         jsonb_build_object('key', t.key, 'active', t.active),
         coalesce((select jsonb_agg(fi.folder_id) from vault_folder_items fi where fi.source='esign' and fi.source_id=t.id::text),'[]'::jsonb)
  from signature_templates t
  union all
  select 'borrower'::text, d.id::text, d.file_name, coalesce(d.document_type, d.type, 'document'),
         nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
         'borrower-documents'::text, true, coalesce(d.storage_path, d.file_path),
         null::text, d.file_size::bigint, coalesce(d.uploaded_at, d.created_at),
         jsonb_build_object('contact_id', d.contact_id, 'status', d.status,
                            'in_drive', (d.gdrive_file_id is not null),
                            'gdrive_url', d.gdrive_file_url),
         coalesce((select jsonb_agg(fi.folder_id) from vault_folder_items fi where fi.source='borrower' and fi.source_id=d.id::text),'[]'::jsonb)
  from uploaded_documents d
  left join contacts c on c.id = d.contact_id
  order by 11 desc;
end; $function$;

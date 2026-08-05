-- chat_vault_list()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.chat_vault_list()
 RETURNS TABLE(id uuid, file_name text, mime_type text, size_bytes bigint, kind text, storage_path text, created_at timestamp with time zone, uploaded_by text, thread_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  return query
  select a.id, a.file_name, a.mime_type, a.size_bytes, a.kind, a.storage_path, a.created_at,
         u.email::text, a.thread_id
  from public.staff_message_attachments a
  left join auth.users u on u.id = a.uploader_user_id
  order by a.created_at desc;
end; $function$;

-- staff_thread_messages(p_thread uuid, p_limit integer)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.staff_thread_messages(p_thread uuid, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, sender_user_id uuid, sender_email text, body text, created_at timestamp with time zone, mine boolean, attachments jsonb, is_deleted boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
/* Deleted rows still come back, but BLANKED and flagged. The row must return so
   the thread can render a "message deleted" tombstone -- a thread that silently
   loses messages is confusing to the other person, and the soft delete exists
   precisely so there is something to render. Body and attachments are stripped
   HERE rather than in the client, so deleted content never reaches the browser. */
begin
  if not is_thread_member(p_thread) then raise exception 'not a participant'; end if;
  return query
  select m.id, m.sender_user_id, u.email::text,
         case when m.deleted_at is null then m.body else null end,
         m.created_at, (m.sender_user_id = auth.uid()),
         case when m.deleted_at is null then coalesce((select jsonb_agg(jsonb_build_object(
             'id',a.id,'storage_path',a.storage_path,'file_name',a.file_name,
             'mime_type',a.mime_type,'size_bytes',a.size_bytes,'kind',a.kind) order by a.created_at)
           from public.staff_message_attachments a where a.message_id=m.id),'[]'::jsonb)
           else '[]'::jsonb end,
         (m.deleted_at is not null)
  from public.staff_messages m
  left join auth.users u on u.id=m.sender_user_id
  where m.thread_id=p_thread
  order by m.created_at desc
  limit greatest(1, least(coalesce(p_limit,50),200));
end; $function$;

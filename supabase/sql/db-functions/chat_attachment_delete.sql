-- chat_attachment_delete(p_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.chat_attachment_delete(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Removing the last attachment from a body-less message used to HARD-delete the
   message row. That left one feature with two deletion semantics:
   staff_message_delete soft-deletes and leaves a tombstone, this one made the
   message disappear outright — no tombstone, no audit, and the other person just
   found a gap in the thread. Now it takes the same soft-delete path.

   deleted_by is auth.uid() rather than a system marker: is_admin() already
   established who this is, and it is the same person the tombstone would name
   if we named anyone.

   The ATTACHMENT ROW is still hard-deleted, deliberately — that is this
   function's actual job, and the caller uses the returned storage_path to
   remove the object. Only the empty shell MESSAGE becomes a tombstone. */
declare v_path text; v_msg uuid;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  select storage_path, message_id into v_path, v_msg from public.staff_message_attachments where id = p_id;
  if v_path is null then raise exception 'attachment not found'; end if;
  delete from public.staff_message_attachments where id = p_id;
  update public.staff_messages m
     set deleted_at = now(), deleted_by = auth.uid()
   where m.id = v_msg
     and m.deleted_at is null
     and coalesce(trim(m.body),'') = ''
     and not exists (select 1 from public.staff_message_attachments a where a.message_id = m.id);
  return jsonb_build_object('deleted', true, 'storage_path', v_path);
end; $function$;

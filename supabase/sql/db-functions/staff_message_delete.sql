-- staff_message_delete(p_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.staff_message_delete(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Soft-delete one staff chat message. Admin only, own messages only.
 *
 * The check lives HERE and not in RLS, deliberately. staff_messages has no
 * UPDATE or DELETE policy, so RLS already denies both — but PostgREST reports
 * that denial as HTTP 200 with [] (update) or 204 (delete): zero rows matched,
 * which looks like SUCCESS to the caller. A VA clicking delete would see the
 * message appear to go and come back on reload. Raising here gives the client a
 * real error to show, and matches chat_attachment_delete, which already guards
 * this feature the same way.
 *
 * Storage is untouched by design: the message goes, the attachment object stays.
 * chat_attachment_delete exists for the deliberate case. Verified that no chat
 * attachment is referenced by uploaded_documents, so keeping the object cannot
 * strand anything outside chat.
 */
declare
  v_sender uuid;
  v_deleted timestamptz;
begin
  if not is_admin() then
    raise exception 'admin only';
  end if;

  select sender_user_id, deleted_at into v_sender, v_deleted
  from public.staff_messages where id = p_id;

  if v_sender is null then
    raise exception 'message not found';
  end if;

  -- Own messages only. An admin deleting someone else's words is a different
  -- decision from redacting their own, and was not the one made.
  if v_sender <> auth.uid() then
    raise exception 'you can only delete your own messages';
  end if;

  if v_deleted is not null then
    return;   -- already gone; deleting twice is not an error
  end if;

  update public.staff_messages
     set deleted_at = now(), deleted_by = auth.uid()
   where id = p_id;
end;
$function$;

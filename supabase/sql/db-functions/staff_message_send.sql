-- staff_message_send(p_thread uuid, p_body text, p_attachments jsonb)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.staff_message_send(p_thread uuid, p_body text, p_attachments jsonb DEFAULT '[]'::jsonb)
 RETURNS staff_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare v_row public.staff_messages; v_sender text; v_body text; v_natt int; v_preview text;
begin
  v_body := coalesce(trim(p_body),'');
  v_natt := coalesce(jsonb_array_length(p_attachments),0);
  if v_body = '' and v_natt = 0 then raise exception 'empty message'; end if;
  if not is_thread_member(p_thread) then raise exception 'not a participant'; end if;

  insert into public.staff_messages(thread_id, sender_user_id, body)
  values (p_thread, auth.uid(), v_body) returning * into v_row;

  if v_natt > 0 then
    insert into public.staff_message_attachments(message_id, thread_id, uploader_user_id, storage_path, file_name, mime_type, size_bytes, kind)
    select v_row.id, p_thread, auth.uid(),
           a->>'storage_path', a->>'file_name', a->>'mime_type',
           nullif(a->>'size_bytes','')::bigint, a->>'kind'
    from jsonb_array_elements(p_attachments) a
    where coalesce(a->>'storage_path','') <> '';
  end if;

  update public.staff_threads set last_message_at = now() where id = p_thread;
  update public.staff_thread_participants set last_read_at = now() where thread_id = p_thread and user_id = auth.uid();

  select email::text into v_sender from auth.users where id = auth.uid();
  v_preview := case when v_body <> '' then left(v_body,200)
                    when v_natt = 1 then '📎 '||coalesce(p_attachments->0->>'file_name','attachment')
                    else '📎 '||v_natt||' attachments' end;

  /* ── UPSERT, NOT INSERT ────────────────────────────────────────────────────
   * One notification per (recipient, thread) for as long as it is UNREAD.
   *
   * THE DEBOUNCE IS THE TRIGGER'S OWN "AFTER INSERT". app_notifications_chat
   * fires on INSERT only, so a message that lands on the DO UPDATE branch sends
   * no ClickUp task — and no email, which is gone entirely now. No cooldown
   * table, no scheduler, nothing that can wedge holding the channel shut.
   *
   * The window is READ STATE rather than a duration, on purpose. A ten-minute
   * window still storms a long conversation; "they have caught up" is the real
   * signal, and once they read it the next message finds no conflict row and
   * correctly breaks through.
   *
   * The trade-off, stated: someone who never opens the bell gets one
   * notification however long the conversation runs. That is the intended
   * behaviour — the alternative is 21 tasks in an hour.
   *
   * created_at is bumped so the bell sorts by latest activity; msg_count is what
   * the UI renders as "5 new messages". */
  insert into public.app_notifications(
    recipient_user_id, actor_user_id, actor_display, kind, preview,
    source_kind, source_id, is_read, created_at, msg_count)
  select p.user_id, auth.uid(), coalesce(v_sender,'Staff'), 'chat_message', v_preview,
         'chat', p_thread, false, now(), 1
  from public.staff_thread_participants p
  where p.thread_id = p_thread and p.user_id <> auth.uid()
  on conflict (recipient_user_id, source_id) where (source_kind = 'chat' and is_read = false)
  do update set msg_count     = public.app_notifications.msg_count + 1,
                preview       = excluded.preview,
                actor_display = excluded.actor_display,
                actor_user_id = excluded.actor_user_id,
                created_at    = now();

  return v_row;
end; $function$;

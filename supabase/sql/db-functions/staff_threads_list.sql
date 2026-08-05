-- staff_threads_list()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.staff_threads_list()
 RETURNS TABLE(thread_id uuid, is_group boolean, title text, last_message_at timestamp with time zone, last_message text, last_sender uuid, unread integer, others jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
/* All THREE reads of staff_messages filter deleted_at. Missing any one has its
   own distinct symptom:
     - last_message → the sidebar preview keeps quoting a deleted message
     - last_sender  → the preview attributes it to the wrong person
     - unread       → the thread stays badged FOREVER, because the message that
                      makes it unread no longer renders and so can never be read.
   The unread count is the one no user action can clear. */
begin
  return query
  select t.id, t.is_group, t.title, t.last_message_at,
    (select m.body from public.staff_messages m
      where m.thread_id=t.id and m.deleted_at is null
      order by m.created_at desc limit 1),
    (select m.sender_user_id from public.staff_messages m
      where m.thread_id=t.id and m.deleted_at is null
      order by m.created_at desc limit 1),
    (select count(*)::int from public.staff_messages m
      where m.thread_id=t.id and m.deleted_at is null
        and m.created_at > me.last_read_at and m.sender_user_id <> auth.uid()),
    (select coalesce(jsonb_agg(jsonb_build_object('user_id',p.user_id,'email',u.email,'role',ar.role)),'[]'::jsonb)
      from public.staff_thread_participants p
      join auth.users u on u.id=p.user_id
      left join public.auth_user_roles ar on ar.user_id=p.user_id
      where p.thread_id=t.id and p.user_id <> auth.uid())
  from public.staff_threads t
  join public.staff_thread_participants me on me.thread_id=t.id and me.user_id=auth.uid()
  order by t.last_message_at desc;
end; $function$;

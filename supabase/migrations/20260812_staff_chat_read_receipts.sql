-- Staff chat read receipts.
--
-- The storage and half the plumbing already existed: staff_thread_participants
-- .last_read_at is written by staff_thread_mark_read and by staff_message_send,
-- and staff_threads_list already counts UNREAD messages from it. What was
-- missing is the other direction — telling the SENDER their message was read.
-- Rene and the VA work opposite hours, so "did she see it" is the question the
-- panel could not answer.
--
-- RETURNS THE MINIMUM across the other participants, not the maximum. On a group
-- thread "Read" has to mean everyone has read it; a max would light up as soon
-- as the fastest reader opened it and would be actively misleading about the
-- person who has not. On the 1:1 threads this is used for, min == that person.
--
-- NULL when any other participant has never opened the thread (their
-- last_read_at is null) — min() skips nulls, so they are counted explicitly.
-- Unknown must not read as "read".

CREATE OR REPLACE FUNCTION public.staff_thread_read_state(p_thread uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_others int;
  v_never  int;
  v_min    timestamptz;
begin
  /* MEMBERSHIP IS THE GATE. Read state says when someone was last active in a
     conversation; a non-participant must not be able to ask. */
  if not exists (
    select 1 from public.staff_thread_participants
     where thread_id = p_thread and user_id = auth.uid()
  ) then
    raise exception 'not a participant';
  end if;

  select count(*),
         count(*) filter (where last_read_at is null),
         min(last_read_at)
    into v_others, v_never, v_min
  from public.staff_thread_participants
  where thread_id = p_thread and user_id <> auth.uid();

  return jsonb_build_object(
    'others', v_others,
    /* A thread you are alone in has nobody to have read it. Distinct from
       "nobody has read it yet" so the client can say nothing at all. */
    'read_at', case when v_others = 0 or v_never > 0 then null else v_min end
  );
end; $function$;

REVOKE ALL ON FUNCTION public.staff_thread_read_state(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.staff_thread_read_state(uuid) TO authenticated;

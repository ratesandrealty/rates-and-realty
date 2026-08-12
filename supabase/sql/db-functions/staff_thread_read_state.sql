-- staff_thread_read_state(p_thread uuid)
-- language: plpgsql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public.staff_thread_read_state(p_thread uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Read receipts for the SENDER's side. staff_thread_participants.last_read_at
   already drove unread COUNTS; this answers "has the other person seen mine".

   RETURNS THE MINIMUM across other participants, not the maximum. On a group
   thread "Read" must mean everyone has read it; a max would light up as soon as
   the fastest reader opened it and would be actively misleading about the person
   who has not. On a 1:1 min == that person.

   NULL when any other participant has never opened the thread — min() skips
   nulls, so they are counted explicitly. Unknown must not read as "read". */
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
    'read_at', case when v_others = 0 or v_never > 0 then null else v_min end
  );
end; $function$;

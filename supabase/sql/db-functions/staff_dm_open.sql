-- staff_dm_open(p_other uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.staff_dm_open(p_other uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_thread uuid;
begin
  if not (is_admin() or coalesce(current_app_role(),'') in ('agent','va','loa','staff')) then
    raise exception 'not authorized'; end if;
  if p_other is null or p_other = auth.uid() then raise exception 'invalid recipient'; end if;

  select t.id into v_thread from public.staff_threads t
  where t.is_group = false
    and exists (select 1 from public.staff_thread_participants p where p.thread_id=t.id and p.user_id=auth.uid())
    and exists (select 1 from public.staff_thread_participants p where p.thread_id=t.id and p.user_id=p_other)
    and (select count(*) from public.staff_thread_participants p where p.thread_id=t.id) = 2
  limit 1;
  if v_thread is not null then return v_thread; end if;

  insert into public.staff_threads(is_group, created_by) values (false, auth.uid()) returning id into v_thread;
  insert into public.staff_thread_participants(thread_id, user_id) values (v_thread, auth.uid()), (v_thread, p_other);
  return v_thread;
end; $function$;

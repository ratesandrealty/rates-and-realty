-- task_note_add(p_task_id uuid, p_body text, p_kind text)
-- language: plpgsql   SECURITY DEFINER
-- Captured 2026-08-05. The 2-arg overload was DROPPED — while both existed a
-- 2-arg call resolved to the old one and kept the dead app_notify_mentions.

CREATE OR REPLACE FUNCTION public.task_note_add(p_task_id uuid, p_body text, p_kind text DEFAULT 'note'::text)
 RETURNS task_activity
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Notes on a task, and the question thread built on top of them.
 *
 * NOTIFICATION WAS DEAD. This called app_notify_mentions, which scans p_body for
 * @handles and notifies whoever it finds — so a VA typing "What is the payoff
 * amount?" notified NOBODY. It returned 0 and reported success. That was the
 * fourth caller in that state, after video-track, video-chat's failure alert and
 * sms-inbound-reconcile. Now app_notify_system, which inserts by ROLE and
 * returns a count.
 *
 * p_kind:
 *   'note'     — ordinary comment, notifies the other side
 *   'question' — the VA is blocked and waiting; also moves the task to
 *                status='question' so her panel can show it is with Rene rather
 *                than looking merely unanswered. Across a 15-hour offset that
 *                distinction is the whole point: she asks at 09:00 PHT, which is
 *                18:00 PT, and his reply lands near midnight her time.
 *   'answer'   — Rene replying; returns the task to 'open' so it is actionable
 *                again, and notifies the account.
 *
 * The notification LINK points at the task, because a notification about a task
 * with nowhere to go is the dead-click bug this codebase already had once.
 *
 * actor_user_id is auth.uid() — attribution to the ACCOUNT, not a named person:
 * processing@ is a shared login. */
declare
  v_row public.task_activity;
  v_contact uuid;
  v_actor text;
  v_title text;
  v_kind text := lower(coalesce(nullif(trim(p_kind),''),'note'));
  v_link text;
  v_body text;
begin
  if auth.role()='authenticated' and not (is_admin() or coalesce(current_app_role(),'') in ('va','agent')) then
    raise exception 'not authorized';
  end if;
  if nullif(trim(coalesce(p_body,'')),'') is null then raise exception 'Note cannot be empty'; end if;
  if v_kind not in ('note','question','answer') then raise exception 'kind must be note, question or answer'; end if;

  v_actor := current_actor_display();
  insert into public.task_activity(task_id, actor_user_id, actor_display, kind, note)
  values (p_task_id, auth.uid(), v_actor, v_kind, trim(p_body))
  returning * into v_row;

  select contact_id, title into v_contact, v_title from public.tasks where id = p_task_id;

  -- A question parks the task; an answer releases it. Guarded so an answer
  -- cannot resurrect something already completed or cancelled.
  if v_kind = 'question' then
    update public.tasks set status='question', updated_at=now()
     where id = p_task_id and coalesce(status,'open') in ('open','pending');
  elsif v_kind = 'answer' then
    update public.tasks set status='open', updated_at=now()
     where id = p_task_id and coalesce(status,'open') = 'question';
  end if;

  v_link := '/admin/lead-detail?contact_id=' || coalesce(v_contact::text,'') || '#vatask=' || p_task_id::text;
  if v_contact is null then v_link := '/admin/va-tasks#vatask=' || p_task_id::text; end if;

  v_body := case v_kind
    when 'question' then '❓ Question on “' || coalesce(v_title,'a task') || '”: ' || trim(p_body)
    when 'answer'   then '💬 Answer on “'   || coalesce(v_title,'a task') || '”: ' || trim(p_body)
    else '📝 Note on “' || coalesce(v_title,'a task') || '”: ' || trim(p_body) end;

  /* Route by who asked. A question goes to admins; an answer goes to the va
     role. Sending an answer to 'admin' would notify Rene about his own reply. */
  perform app_notify_system(
    'task', p_task_id, v_body, v_actor, v_contact,
    case when v_kind = 'answer' then array['va'] else array['admin'] end,
    v_link);

  return v_row;
end; $function$;

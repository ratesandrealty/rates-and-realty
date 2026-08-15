-- task_nudge_run(p_dry_run boolean)
-- language: plpgsql
-- Captured from production 2026-08-15.

CREATE OR REPLACE FUNCTION public.task_nudge_run(p_dry_run boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_is_service boolean := coalesce(auth.role(),'') = 'service_role';
  v_rows       jsonb;
  v_body       text;
  v_n          int;
  v_unassigned int;
  v_mine       int;
  v_other      int;
  v_notified   int := 0;
  v_claimed    uuid[];
  r            record;
  v_sec        text;
begin
  if not (v_is_service or is_admin()) then
    raise exception 'task_nudge_run is service/admin only';
  end if;

  drop table if exists _nudge_candidates;   -- re-entrant within one transaction
  create temp table _nudge_candidates on commit drop as
  select t.id, t.title, t.due_date, t.assigned_to, t.contact_id,
         coalesce(ar.display_name, u.email::text)            as owner_name,
         nullif(btrim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'') as lead_name,
         (current_date - t.due_date::date)                   as days_late
  from public.tasks t
  left join public.contacts c        on c.id = t.contact_id
  left join public.auth_user_roles ar on ar.user_id = t.assigned_to
  left join auth.users u             on u.id = t.assigned_to
  where coalesce(t.status,'open') not in ('completed','cancelled')   -- not cancelled
    and t.due_date is not null
    and t.due_date < now()                                           -- overdue
    and t.due_date >= t.created_at                                   -- NOT born overdue
    and not exists (                                                 -- not already today
      select 1 from public.nudge_sent n
      where n.item_type = 'task' and n.item_id = t.id
        and n.stage = 'overdue' and n.sent_on = current_date);

  select count(*) into v_n from _nudge_candidates;
  if v_n = 0 then
    return jsonb_build_object('sent', false, 'reason', 'nothing_overdue',
                              'dry_run', p_dry_run, 'candidates', 0);
  end if;

  select count(*) filter (where assigned_to is null),
         count(*) filter (where assigned_to = auth.uid()),
         count(*) filter (where assigned_to is not null and assigned_to is distinct from auth.uid())
    into v_unassigned, v_mine, v_other
  from _nudge_candidates;

  v_body := 'R&R task nudge — ' || v_n || ' overdue' || E'\n';

  /* Unassigned first and named "Nobody has taken these" — it is not a to-do
     list, it is work with no owner, and only an admin can assign it. */
  if v_unassigned > 0 then
    v_sec := '';
    for r in select * from _nudge_candidates where assigned_to is null
             order by due_date loop
      v_sec := v_sec || '  · ' || r.title
             || coalesce(' — ' || r.lead_name, '')
             || ' — ' || r.days_late || ' day' || case when r.days_late = 1 then '' else 's' end || ' late' || E'\n';
    end loop;
    v_body := v_body || E'\nNobody has taken these (' || v_unassigned || '):' || E'\n' || v_sec;
  end if;

  for r in select distinct assigned_to, owner_name from _nudge_candidates
           where assigned_to is not null order by owner_name loop
    v_sec := '';
    for r in select * from _nudge_candidates
             where assigned_to is not null and owner_name = r.owner_name order by due_date loop
      v_sec := v_sec || '  · ' || r.title
             || coalesce(' — ' || r.lead_name, '')
             || ' — ' || r.days_late || ' day' || case when r.days_late = 1 then '' else 's' end || ' late' || E'\n';
    end loop;
    v_body := v_body || E'\n' || coalesce(r.owner_name,'Assigned') || ':' || E'\n' || v_sec;
  end loop;

  select jsonb_agg(jsonb_build_object('id', id, 'title', title,
                    'owner', coalesce(owner_name,'UNASSIGNED'),
                    'lead', lead_name, 'days_late', days_late) order by due_date)
    into v_rows from _nudge_candidates;

  if p_dry_run then
    return jsonb_build_object('sent', false, 'reason', 'dry_run', 'dry_run', true,
                              'candidates', v_n, 'unassigned', v_unassigned,
                              'mine', v_mine, 'others', v_other,
                              'body', v_body, 'rows', v_rows);
  end if;

  /* CLAIM FIRST, then notify. The insert is the dedupe: the UNIQUE constraint
     makes a second run today a no-op, and claiming before sending means a
     crash between the two costs a missed nudge rather than a duplicate. */
  with claimed as (
    insert into public.nudge_sent (item_type, item_id, stage, sent_on)
    select 'task', id, 'overdue', current_date from _nudge_candidates
    on conflict (item_type, item_id, stage, sent_on) do nothing
    returning item_id
  )
  select array_agg(item_id) into v_claimed from claimed;

  if coalesce(array_length(v_claimed,1),0) = 0 then
    return jsonb_build_object('sent', false, 'reason', 'already_claimed_today',
                              'dry_run', false, 'candidates', v_n);
  end if;

  select public.app_notify_system(
    'task_nudge', null, v_body, 'Task nudge', null, array['admin'], '/dashboard/admin#tasks'
  ) into v_notified;

  return jsonb_build_object('sent', true, 'dry_run', false,
                            'candidates', v_n, 'claimed', array_length(v_claimed,1),
                            'notified', coalesce(v_notified,0),
                            'unassigned', v_unassigned, 'mine', v_mine, 'others', v_other,
                            'body', v_body);
end;
$function$;

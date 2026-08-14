-- va_productivity_report(p_from date, p_to date)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-14. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.va_productivity_report(p_from date DEFAULT ((now() - '30 days'::interval))::date, p_to date DEFAULT (now())::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_from timestamptz := p_from::timestamptz;
  v_to   timestamptz := (p_to + 1)::timestamptz;
  v_role text := coalesce(current_app_role(), '');
  result jsonb;
begin
  if coalesce(auth.role(),'') is distinct from 'service_role'
     and not (is_admin() or v_role in ('admin','va','agent')) then
    raise exception 'Not authorized to view VA productivity report';
  end if;

  with comp as (  -- all completed in range, with normalized completion time + manual flag
    select t.*,
           coalesce(t.completed_at, t.updated_at) as ct,
           (coalesce(t.completed_source,'user') <> 'system') as is_manual
    from tasks t
    where t.status='completed'
      and coalesce(t.completed_at, t.updated_at) >= v_from
      and coalesce(t.completed_at, t.updated_at) <  v_to
  ),
  manual as (select * from comp where is_manual),
  kpis as (
    select
      (select count(*) from manual)                                   as completed_in_range,     -- honest: manual only
      (select count(*) from comp where not is_manual)                 as system_in_range,
      (select count(*) from comp)                                     as total_in_range,
      (select count(*) from tasks where status='completed' and coalesce(completed_at,updated_at) >= now()-interval '7 days'  and coalesce(completed_source,'user')<>'system') as completed_7d,
      (select count(*) from tasks where status='completed' and coalesce(completed_at,updated_at) >= now()-interval '30 days' and coalesce(completed_source,'user')<>'system') as completed_30d,
      (select count(*) from tasks where status='completed' and coalesce(completed_at,updated_at) >= now()-interval '7 days'  and coalesce(completed_source,'user')='system') as system_7d,
      (select count(*) from tasks where coalesce(status,'open') not in ('completed','cancelled')) as open_now,
      (select count(*) from tasks where coalesce(status,'open') not in ('completed','cancelled') and due_date is not null and due_date < now()) as overdue_now,
      (select round(avg(extract(epoch from (ct - created_at))/3600)::numeric, 1) from manual) as avg_turnaround_hrs,
      (select round((percentile_cont(0.5) within group (order by extract(epoch from (ct - created_at))/3600))::numeric, 1) from manual) as median_turnaround_hrs,
      (select round(100.0 * count(*) filter (where due_date is not null and ct <= due_date)
              / nullif(count(*) filter (where due_date is not null),0), 1) from manual) as on_time_pct,
      (select round((count(*)::numeric) / nullif(greatest(extract(epoch from (v_to - v_from))/86400, 1), 0), 1) from manual) as avg_per_day
  ),
  daily as (
    select to_char(date_trunc('day', ct), 'YYYY-MM-DD') as day,
           count(*) filter (where is_manual) as completed,
           count(*) filter (where not is_manual) as system
    from comp group by 1 order by 1
  ),
  buckets as (
    select
      count(*) filter (where h < 1) as lt_1h,
      count(*) filter (where h >= 1 and h < 4) as h1_4,
      count(*) filter (where h >= 4 and h < 24) as h4_24,
      count(*) filter (where h >= 24 and h < 72) as h24_72,
      count(*) filter (where h >= 72) as gt_72h
    from (select extract(epoch from (ct - created_at))/3600 as h from manual) s
  ),
  by_priority as (
    select coalesce(nullif(priority,''),'normal') as priority, count(*) as n
    from manual group by 1
  ),
  backlog as (
    select
      count(*) filter (where due_date is not null and due_date < now()) as overdue,
      count(*) filter (where due_date is not null and due_date >= now() and due_date < now() + interval '1 day') as due_today,
      count(*) filter (where due_date is not null and due_date >= now() + interval '1 day') as due_later,
      count(*) filter (where due_date is null) as no_due_date
    from tasks where coalesce(status,'open') not in ('completed','cancelled')
  ),
  open_aging as (
    select coalesce(jsonb_agg(row_to_json(o)) filter (where o.id is not null), '[]'::jsonb) as items
    from (
      select t.id, t.title, t.priority, t.due_date, t.created_at,
             round(extract(epoch from (now() - t.created_at))/86400.0, 1) as age_days,
             (t.contact_id is not null) as has_lead,
             coalesce(c.first_name||' '||c.last_name, null) as contact_name
      from tasks t left join contacts c on c.id = t.contact_id
      where coalesce(t.status,'open') not in ('completed','cancelled') order by t.created_at asc limit 10
    ) o
  ),
  recent as (  -- the VA's actual hand-worked completions
    select coalesce(jsonb_agg(row_to_json(r)) filter (where r.id is not null), '[]'::jsonb) as items
    from (
      select t.id, t.title, t.priority, coalesce(t.completed_at,t.updated_at) as completed_at,
             round(extract(epoch from (coalesce(t.completed_at,t.updated_at) - t.created_at))/3600.0, 1) as turnaround_hrs,
             coalesce(c.first_name||' '||c.last_name, null) as contact_name
      from tasks t left join contacts c on c.id = t.contact_id
      where t.status='completed'
        and coalesce(t.completed_source,'user') <> 'system'
        and coalesce(t.completed_at,t.updated_at) >= v_from and coalesce(t.completed_at,t.updated_at) < v_to
      order by coalesce(t.completed_at,t.updated_at) desc limit 15
    ) r
  )
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'kpis', (select row_to_json(k) from kpis k),
    'daily_throughput', coalesce((select jsonb_agg(row_to_json(d)) from daily d), '[]'::jsonb),
    'turnaround_buckets', (select row_to_json(b) from buckets b),
    'by_priority', coalesce((select jsonb_agg(row_to_json(p)) from by_priority p), '[]'::jsonb),
    'backlog', (select row_to_json(bk) from backlog bk),
    'open_aging', (select items from open_aging),
    'recent_completions', (select items from recent),
    'note', 'Completed counts reflect tasks a person marked done. System auto-completions (e.g. bulk cold-lead re-engagement) are tracked separately as "system" and excluded from throughput, turnaround, and on-time figures.',
    'generated_at', now()
  ) into result;

  return result;
end;
$function$;

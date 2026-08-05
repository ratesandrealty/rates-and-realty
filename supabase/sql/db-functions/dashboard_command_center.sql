-- dashboard_command_center()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.dashboard_command_center()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_active text[] := array['Contacted','Pre-Approved','Under Contract','Processing','Clear to Close'];
  v_result jsonb;
begin
  -- Global command center is an ADMIN tool. VAs/agents get a shared-scoped pipeline elsewhere
  -- (va_shared_leads), so this no longer leaks global data to them.
  if auth.role() = 'authenticated' and not is_admin() then
    raise exception 'not authorized';
  end if;

  select jsonb_build_object(
    'kpis', jsonb_build_object(
      'total_leads',     (select count(*) from contacts),
      'new_leads',       (select count(*) from contacts where pipeline_status = 'New Lead'),
      'new_leads_7d',    (select count(*) from contacts where pipeline_status = 'New Lead' and created_at > now() - interval '7 days'),
      'active_pipeline', (select count(*) from contacts where pipeline_status = any(v_active)),
      'closed',          (select count(*) from contacts where pipeline_status = 'Closed' or deal_outcome = 'won'),
      'hot_leads',       (select count(*) from contacts where lead_tier(lead_score) = 'hot'),
      'warm_leads',      (select count(*) from contacts where lead_tier(lead_score) = 'warm'),
      'tasks_open',      (select count(*) from tasks where coalesce(status,'open') not in ('completed','cancelled','dismissed')),
      'tasks_due_today', (select count(*) from tasks where coalesce(status,'open') not in ('completed','cancelled','dismissed') and due_date is not null and due_date::date <= current_date),
      'activity_today',  (select count(*) from activity_events where created_at::date = current_date)
    ),
    'pipeline_by_stage', (
      select coalesce(jsonb_agg(jsonb_build_object('stage', s.stage, 'count', coalesce(cnt.c,0)) order by s.ord), '[]'::jsonb)
      from (values ('New Lead',1),('Contacted',2),('Pre-Approved',3),('Under Contract',4),('Processing',5),('Clear to Close',6),('Closed',7)) s(stage,ord)
      left join (select pipeline_status, count(*) c from contacts group by 1) cnt on cnt.pipeline_status = s.stage
    ),
    'todays_tasks', (
      select coalesce(jsonb_agg(obj order by ord, due_date asc nulls last), '[]'::jsonb) from (
        select jsonb_build_object('id',tk.id,'title',tk.title,'priority',tk.priority,'due_date',tk.due_date,
                 'contact_id',tk.contact_id,
                 'contact_name', nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'')) as obj,
               case lower(coalesce(tk.priority,'normal')) when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end as ord,
               tk.due_date
        from tasks tk left join contacts c on c.id = tk.contact_id
        where coalesce(tk.status,'open') not in ('completed','cancelled','dismissed')
          and (tk.due_date is null or tk.due_date::date <= current_date)
        order by ord, tk.due_date asc nulls last limit 15
      ) s
    ),
    'attention', (
      select coalesce(jsonb_agg(obj order by days_quiet desc nulls first), '[]'::jsonb) from (
        select jsonb_build_object('contact_id',c.id,
                 'name', nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
                 'stage', c.pipeline_status, 'phone', c.phone,
                 'last_activity', la.last_activity,
                 'days_quiet', case when la.last_activity is null then null else floor(extract(epoch from now()-la.last_activity)/86400)::int end) as obj,
               case when la.last_activity is null then 99999 else floor(extract(epoch from now()-la.last_activity)/86400)::int end as days_quiet
        from contacts c
        cross join lateral (
          select greatest(c.last_contact_date, c.last_meaningful_activity_at,
                          (select max(ae.created_at) from activity_events ae where ae.contact_id = c.id)) as last_activity
        ) la
        where c.pipeline_status = any(v_active)
          and (la.last_activity is null or la.last_activity < now() - interval '3 days')
        order by days_quiet desc limit 10
      ) s
    ),
    'hot_leads', (
      select coalesce(jsonb_agg(obj order by score desc nulls last), '[]'::jsonb) from (
        select jsonb_build_object('contact_id',c.id,
                 'name', nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
                 'temperature', initcap(lead_tier(c.lead_score)),
                 'score', c.lead_score, 'stage', c.pipeline_status, 'phone', c.phone) as obj,
               c.lead_score as score
        from contacts c
        where lead_tier(c.lead_score) in ('hot','warm')
          and coalesce(c.pipeline_status,'') <> 'Closed'
          and coalesce(c.deal_outcome,'') not in ('won','lost')
        order by c.lead_score desc nulls last limit 10
      ) s
    ),
    'recent_activity', (
      select coalesce(jsonb_agg(obj order by created_at desc), '[]'::jsonb) from (
        select jsonb_build_object('type',ae.type,'title',ae.title,'channel',ae.channel,'direction',ae.direction,
                 'contact_id',ae.contact_id,
                 'contact_name', nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
                 'created_at',ae.created_at) as obj, ae.created_at
        from activity_events ae left join contacts c on c.id = ae.contact_id
        where ae.created_at > now() - interval '14 days'
        order by ae.created_at desc limit 15
      ) s
    ),
    'new_leads_recent', (
      select coalesce(jsonb_agg(obj order by created_at desc), '[]'::jsonb) from (
        select jsonb_build_object('contact_id',c.id,
                 'name', nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
                 'source', coalesce(c.lead_source, c.source), 'phone', c.phone, 'created_at', c.created_at) as obj,
               c.created_at
        from contacts c
        where c.pipeline_status = 'New Lead'
        order by c.created_at desc limit 12
      ) s
    ),
    'generated_at', now()
  ) into v_result;
  return v_result;
end; $function$;

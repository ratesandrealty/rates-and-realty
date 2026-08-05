-- va_dashboard()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.va_dashboard()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare v jsonb;
begin
  select jsonb_build_object(
    'scorecard', jsonb_build_object(
      'tasks_due',        (select count(*) from va_daily_tasks() where bucket in ('overdue','today')),
      'my_tasks',         (select count(*) from va_daily_tasks()),
      'active_deals',     (select count(*) from va_processing_board()),
      'shared_files',     (select count(*) from va_shared_leads()),
      'open_conditions',  (select coalesce(sum(open_conditions),0) from va_processing_board()),
      'outstanding_docs', (select coalesce(sum(outstanding_docs),0) from va_processing_board()),
      'open_intake',      (select coalesce(sum(open_intake),0) from va_processing_board())
    ),
    'tasks', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id',id,'title',title,'priority',priority,'due_date',due_date,
               'contact_id',contact_id,'contact_name',contact_name,'bucket',bucket)
             order by case bucket when 'overdue' then 0 when 'today' then 1 when 'upcoming' then 2 else 3 end, due_date asc nulls last), '[]'::jsonb)
      from va_daily_tasks()
    ),
    'deals', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'contact_id',contact_id,'name',name,'stage',pipeline_status,
               'open_conditions',open_conditions,'outstanding_docs',outstanding_docs,
               'open_intake',open_intake,'open_tasks',open_tasks,
               'next_key_date',next_key_date,'next_key_label',next_key_label)
             order by array_position(array['Clear to Close','Under Contract','Processing','Pre-Approved','Contacted'], pipeline_status)), '[]'::jsonb)
      from va_processing_board()
    ),
    'files', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'contact_id',contact_id,'name',name,'stage',pipeline_status,'open_tasks',open_tasks)
             order by pipeline_status, name), '[]'::jsonb)
      from va_shared_leads()
    ),
    'key_dates', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'contact_id', c.id,
               'name', nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
               'kind', 'Appointment', 'date', c.appointment_date)
             order by c.appointment_date), '[]'::jsonb)
      from contacts c
      where is_lead_shared_with_me(c.id)
        and c.appointment_date is not null
        and c.appointment_date >= (now() - interval '1 day')
        and c.appointment_date <= (now() + interval '30 days')
    ),
    'recent_activity', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'contact_id', x.contact_id, 'name', x.name, 'note', x.note,
               'author', x.author_display, 'created_at', x.created_at)), '[]'::jsonb)
      from (
        select cn.contact_id,
               nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'') as name,
               left(cn.note_text, 160) as note, cn.author_display, cn.created_at
        from contact_notes cn
        join contacts c on c.id = cn.contact_id
        where is_lead_shared_with_me(cn.contact_id)
        order by cn.created_at desc
        limit 12
      ) x
    ),
    'generated_at', now()
  ) into v;
  return v;
end; $function$;

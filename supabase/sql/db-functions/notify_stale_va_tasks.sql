-- notify_stale_va_tasks()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.notify_stale_va_tasks()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; n int := 0;
begin
  for r in
    select id, contact_id, title, description, updated_at,
           greatest(1, floor(extract(epoch from (now() - updated_at)) / 86400))::int as days_idle
    from tasks
    where coalesce(status,'open') not in ('completed','cancelled','dismissed')
      and updated_at < now() - interval '2 days'
      and (stale_reminded_at is null or stale_reminded_at < updated_at)
  loop
    perform fire_clickup_automation(
      'task_stale',
      r.contact_id,
      r.id::text || ':' || extract(epoch from r.updated_at)::bigint::text,
      jsonb_build_object(
        'title', r.title,
        'days_idle', r.days_idle,
        'whats_needed', coalesce(nullif(trim(r.description), ''), 'Follow up and update this task''s status.')
      )
    );
    update tasks set stale_reminded_at = now() where id = r.id;  -- does not touch updated_at (no updated_at trigger on tasks)
    n := n + 1;
  end loop;
  return n;
end; $function$;

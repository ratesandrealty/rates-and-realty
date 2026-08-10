-- power_dialer_counts()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.power_dialer_counts()
 RETURNS TABLE(due integer, new_leads integer, stale integer, scheduled integer, total_active integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.role() = 'authenticated' and not public.is_admin() then raise exception 'admin only'; end if;
  return query
  with la as (
    select ae.contact_id, max(ae.created_at) last_act
    from activity_events ae where ae.contact_id is not null group by ae.contact_id
  ),
  base as (
    select c.id, la.last_act, c.next_followup_at nfu
    from contacts c
    left join la on la.contact_id = c.id
    where coalesce(c.deal_outcome,'') not in ('won','lost')
      and c.merged_into_contact_id is null   -- READ FILTER: current roster only
      and coalesce(c.pipeline_status,'') <> 'Closed'
      and coalesce(c.phone,'') <> ''
      and coalesce(c.is_co_borrower,false) = false
      and c.do_not_call = false
  )
  select
    count(*) filter (where nfu is not null and nfu < (current_date+1)::timestamptz)::int,
    count(*) filter (where nfu is null and last_act is null)::int,
    count(*) filter (where nfu is null and last_act is not null and last_act < now() - interval '14 days')::int,
    count(*) filter (where nfu is not null and nfu >= (current_date+1)::timestamptz)::int,
    count(*)::int
  from base;
end;
$function$;

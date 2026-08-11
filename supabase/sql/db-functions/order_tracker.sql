-- order_tracker(p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.order_tracker(p_contact_id uuid)
 RETURNS TABLE(order_type text, color text, state text, status text, total integer, done integer, label text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if coalesce(auth.role(),'') is distinct from 'service_role'
     and not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','lender','staff')) then
    raise exception 'staff only';
  end if;

  return query
  with types(order_type, label, sort) as (
    values ('title','Title',1),('hoi','HOI',2),('escrow','Escrow',3),
           ('appraisal','Appraisal',4),('voe','VOE',5),('payoff','Mortgage Payoff',6)
  ),
  agg as (
    select o.order_type,
           count(*) filter (where o.status <> 'not_ordered')::int as active_total,
           count(*)::int as total,
           count(*) filter (where o.status in ('received','paid'))::int as done,
           bool_or(o.status = 'not_required') as any_not_required,
           max(case o.status
                 when 'needs_revision' then 6 when 'paid' then 5 when 'ordered' then 4
                 when 'scheduled' then 3 when 'acknowledged' then 2 when 'received' then 1
                 else 0 end) as worst
    from public.loan_orders o
    where o.contact_id = p_contact_id
    group by o.order_type
  )
  select t.order_type,
         case
           when a.any_not_required and coalesce(a.worst,0) = 0 then 'green'
           when a.order_type is null or a.active_total = 0 then 'grey'
           when a.worst = 6 then 'red' when a.worst = 5 then 'orange' when a.worst = 4 then 'red'
           when a.worst = 3 then 'blue' when a.worst = 2 then 'yellow'
           when a.done = a.active_total then 'green' else 'green' end as color,
         case
           when a.any_not_required and coalesce(a.worst,0) = 0 then 'Don''t need'
           when a.order_type is null or a.active_total = 0 then 'Not ordered'
           when a.worst = 6 then 'Needs revision' when a.worst = 5 then 'Paid'
           when a.worst = 4 then 'Awaiting acknowledgment' when a.worst = 3 then 'Scheduled'
           when a.worst = 2 then 'In progress'
           when a.done = a.active_total then 'Completed' else 'Completed' end as state,
         coalesce(
           (select o2.status from public.loan_orders o2
            where o2.contact_id = p_contact_id and o2.order_type = t.order_type
            order by case o2.status when 'needs_revision' then 0 when 'ordered' then 1 when 'scheduled' then 2
                     when 'acknowledged' then 3 when 'paid' then 4 when 'not_required' then 5 when 'not_ordered' then 6 when 'received' then 7 else 8 end asc
            limit 1), 'not_ordered') as status,
         coalesce(a.active_total,0) as total, coalesce(a.done,0) as done, t.label
  from types t left join agg a on a.order_type = t.order_type
  order by t.sort;
end; $function$;

-- loan_date_nudge_scan()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.loan_date_nudge_scan()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text; v jsonb;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if not (public.is_admin() or v_role = 'service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'not authorized';
  end if;

  with active_contacts as (
    select id, first_name, last_name from public.contacts
    where coalesce(pipeline_status,'') not in
      ('Closed','Lost','Closed Won','Closed Lost','Funded','Dead','Denied')
  ),
  items as (
    select 'key_date'::text as item_type, kd.id as item_id, kd.contact_id,
           coalesce(nullif(trim(kd.label),''), initcap(replace(kd.date_key,'_',' '))) as label,
           kd.date_value as due_date,
           case when kd.date_value < current_date then 'overdue'
                when kd.date_value = current_date then 'dayof'
                when kd.date_value = current_date + 3 then '3day' end as stage
    from public.loan_key_dates kd
    where kd.contact_id in (select id from active_contacts)
      and coalesce(kd.completed,false) = false
      and kd.date_key in ('close_of_escrow','loan_contingency','appraisal_due','inspection_deadline')
      and (kd.date_value in (current_date + 3, current_date) or kd.date_value < current_date)
    union all
    select 'rate_lock', ma.id, ma.contact_id,
           'Rate lock'||coalesce(' '||to_char(ma.locked_rate,'FM990.000')||'%',''),
           ma.rate_lock_expiry::date,
           case when ma.rate_lock_expiry::date < current_date then 'overdue'
                when ma.rate_lock_expiry::date = current_date then 'dayof'
                when ma.rate_lock_expiry::date = current_date + 3 then '3day' end
    from public.mortgage_applications ma
    where ma.contact_id in (select id from active_contacts)
      and ma.rate_lock_expiry is not null and ma.locked_rate is not null
      and (ma.rate_lock_expiry::date in (current_date + 3, current_date) or ma.rate_lock_expiry::date < current_date)
    union all
    select 'order', lo.id, lo.contact_id,
           upper(lo.order_type)||' order'||coalesce(' @ '||nullif(lo.employer_name,''),''),
           lo.ordered_at::date, 'overdue'
    from public.loan_orders lo
    where lo.contact_id in (select id from active_contacts)
      and lo.status = 'ordered'
      and lo.ordered_at is not null
      and lo.ordered_at < now() - interval '7 days'
  ),
  filtered as (
    select i.*, nullif(trim(coalesce(ac.first_name,'')||' '||coalesce(ac.last_name,'')),'') as borrower
    from items i
    join active_contacts ac on ac.id = i.contact_id
    where i.stage is not null
      and not exists (
        select 1 from public.nudge_sent ns
        where ns.item_type = i.item_type and ns.item_id = i.item_id
          and ns.stage = i.stage and ns.sent_on = current_date
      )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'item_type', item_type, 'item_id', item_id, 'contact_id', contact_id,
      'borrower', coalesce(borrower,'(unknown)'), 'label', label,
      'due_date', due_date, 'stage', stage
    ) order by
      case stage when 'overdue' then 0 when 'dayof' then 1 else 2 end, due_date), '[]'::jsonb)
  into v from filtered;

  return v;
end; $function$;

-- va_processing_board()
-- language: sql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.va_processing_board()
 RETURNS TABLE(contact_id uuid, name text, phone text, pipeline_status text, open_conditions integer, outstanding_docs integer, open_intake integer, open_tasks integer, next_key_date date, next_key_label text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select
    c.id,
    nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'') as name,
    case when current_app_role()='va' and not is_admin() then mask_phone(c.phone) else c.phone end as phone,
    c.pipeline_status,
    (select count(*)::int from loan_conditions lc where lc.contact_id=c.id and lc.cleared_at is null),
    (select count(*)::int from processing_items pi where pi.contact_id=c.id and pi.kind='doc'    and not coalesce(pi.completed,false) and not coalesce(pi.dismissed,false)),
    (select count(*)::int from processing_items pi where pi.contact_id=c.id and pi.kind='intake' and not coalesce(pi.completed,false) and not coalesce(pi.dismissed,false)),
    (select count(*)::int from tasks t where t.contact_id=c.id and coalesce(t.status,'open') not in ('completed','cancelled','dismissed')),
    (select min(kd.date_value) from loan_key_dates kd where kd.contact_id=c.id and kd.date_value >= current_date),
    (select kd.label from loan_key_dates kd where kd.contact_id=c.id and kd.date_value >= current_date order by kd.date_value asc limit 1)
  from contacts c
  where public.is_lead_shared_with_me(c.id)
    and coalesce(c.pipeline_status,'') not in ('New Lead','Closed')
    and coalesce(c.deal_outcome,'') not in ('won','lost')
  order by array_position(array['Clear to Close','Under Contract','Processing','Pre-Approved','Contacted'], c.pipeline_status), name;
$function$;

-- va_shared_leads()
-- language: sql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.va_shared_leads()
 RETURNS TABLE(contact_id uuid, name text, phone text, email text, pipeline_status text, open_tasks integer, tasks jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select
    c.id,
    nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'') as name,
    case when current_app_role()='va' and not is_admin() then mask_phone(c.phone) else c.phone end as phone,
    case when current_app_role()='va' and not is_admin() then 'lead-'||left(c.id::text,8)||'@masked.local' else c.email end as email,
    c.pipeline_status,
    (select count(*)::int from tasks t where t.contact_id=c.id and coalesce(t.status,'open') not in ('completed','cancelled','dismissed')) as open_tasks,
    coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'title',t.title,'priority',t.priority,'due_date',t.due_date,'status',t.status,'mine',(t.assigned_to=auth.uid())) order by t.due_date asc nulls last)
              from tasks t where t.contact_id=c.id and coalesce(t.status,'open') not in ('completed','cancelled','dismissed')), '[]'::jsonb) as tasks
  from contacts c
  where public.is_lead_shared_with_me(c.id)
  order by c.pipeline_status, name;
$function$;

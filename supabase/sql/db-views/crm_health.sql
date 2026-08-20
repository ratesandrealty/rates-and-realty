-- crm_health (view)
-- Captured from production by tools/recapture-db-views.mjs. Do not hand-edit.
--
-- security_invoker: false
--   DEFINER: this view runs as its OWNER and is NOT subject to the base
--   tables' RLS. Anything granted SELECT here reads past that protection.
-- base_tables_with_rls: (none)
-- base_tables_without_rls: (none)
-- select_granted_to: authenticated, service_role
--

create or replace view public.crm_health as
 SELECT severity,
    area,
    check_name,
    detail
   FROM crm_health_check() crm_health_check(severity, area, check_name, detail)
  ORDER BY (
        CASE severity
            WHEN 'fail'::text THEN 0
            WHEN 'warn'::text THEN 1
            ELSE 2
        END), area, check_name;

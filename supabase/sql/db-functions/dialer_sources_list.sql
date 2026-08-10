-- dialer_sources_list()
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.dialer_sources_list()
 RETURNS TABLE(source text, n bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select c.source, count(*) from contacts c
  where coalesce(c.deal_outcome,'') not in ('won','lost')
    and c.merged_into_contact_id is null   -- READ FILTER: current roster only
    and coalesce(c.pipeline_status,'') <> 'Closed'
    and coalesce(c.phone,'') <> '' and coalesce(c.is_co_borrower,false) = false
    and c.do_not_call = false and coalesce(c.source,'') <> ''
    and (coalesce(current_app_role(),'') <> 'va')
  group by c.source order by count(*) desc;
$function$;

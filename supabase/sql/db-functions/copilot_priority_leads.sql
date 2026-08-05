-- copilot_priority_leads(p_limit integer)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.copilot_priority_leads(p_limit integer DEFAULT 15)
 RETURNS TABLE(contact_id uuid, name text, pipeline_status text, lead_score numeric, score_tier text, last_contact date, days_since_contact integer, phone text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  return query
  select c.id,
         nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
         c.pipeline_status, c.lead_score::numeric, c.score_tier, c.last_contact_date::date,
         (case when c.last_contact_date is not null then (now()::date - c.last_contact_date::date) else null end)::int,
         c.phone
  from public.contacts c
  where coalesce(c.pipeline_status,'') not in ('Closed','Lost','Closed Won','Closed Lost')
    and coalesce(c.lead_status,'') not in ('lost','dead','closed')
  order by c.lead_score desc nulls last, c.last_contact_date asc nulls first
  limit greatest(1, least(coalesce(p_limit,15), 50));
end; $function$;

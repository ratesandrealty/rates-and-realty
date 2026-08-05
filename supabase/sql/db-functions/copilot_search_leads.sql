-- copilot_search_leads(p_query text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.copilot_search_leads(p_query text)
 RETURNS TABLE(contact_id uuid, name text, pipeline_status text, lead_status text, lead_score numeric, score_tier text, phone text, loan_purpose text, last_contact date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  if nullif(trim(coalesce(p_query,'')),'') is null then return; end if;
  return query
  select c.id,
         nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
         c.pipeline_status, c.lead_status, c.lead_score::numeric, c.score_tier,
         c.phone, c.loan_purpose, c.last_contact_date::date
  from public.contacts c
  where (coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')) ilike '%'||p_query||'%'
     or c.phone ilike '%'||p_query||'%'
  order by c.lead_score desc nulls last
  limit 12;
end; $function$;

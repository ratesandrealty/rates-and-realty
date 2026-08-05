-- vendor_directory_search(p_role text, p_query text, p_limit integer)
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.vendor_directory_search(p_role text, p_query text, p_limit integer DEFAULT 8)
 RETURNS TABLE(id uuid, role text, name text, first_name text, last_name text, company text, phone text, email text, website text, usage_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select v.id, v.role, v.name, v.first_name, v.last_name, v.company, v.phone, v.email, v.website, coalesce(v.usage_count,0)
  from public.vendor_directory v
  where (p_role is null or v.role = p_role or v.category = p_role)
    and (
      coalesce(nullif(trim(p_query),''),'') = ''
      or v.name ilike '%'||p_query||'%' or v.first_name ilike '%'||p_query||'%'
      or v.last_name ilike '%'||p_query||'%' or v.company ilike '%'||p_query||'%'
    )
  order by coalesce(v.usage_count,0) desc, v.name
  limit greatest(1, least(coalesce(p_limit,8),25));
$function$;

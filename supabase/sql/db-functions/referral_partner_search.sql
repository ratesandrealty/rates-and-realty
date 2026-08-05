-- referral_partner_search(p_query text, p_limit integer)
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.referral_partner_search(p_query text DEFAULT ''::text, p_limit integer DEFAULT 8)
 RETURNS TABLE(id uuid, name text, first_name text, last_name text, company text, title text, email text, phone text, total_referrals integer, total_closed integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p.id,
         nullif(trim(coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')),'') as name,
         p.first_name, p.last_name, p.company, p.title, p.email, p.phone,
         coalesce(p.total_referrals,0), coalesce(p.total_closed,0)
  from public.referral_partners p
  where coalesce(p.status,'') <> 'archived'
    and (
      coalesce(nullif(trim(p_query),''),'') = ''
      or p.first_name ilike '%'||p_query||'%'
      or p.last_name  ilike '%'||p_query||'%'
      or (coalesce(p.first_name,'')||' '||coalesce(p.last_name,'')) ilike '%'||p_query||'%'
      or p.company    ilike '%'||p_query||'%'
      or p.email      ilike '%'||p_query||'%'
    )
  order by coalesce(p.total_closed,0) desc, coalesce(p.total_referrals,0) desc,
           coalesce(p.last_name,''), coalesce(p.first_name,'')
  limit greatest(1, least(coalesce(p_limit,8), 25));
$function$;

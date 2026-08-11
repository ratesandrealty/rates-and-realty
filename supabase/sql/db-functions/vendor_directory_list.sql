-- vendor_directory_list(p_role text, p_query text, p_limit integer, p_offset integer, p_category text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.vendor_directory_list(p_role text DEFAULT NULL::text, p_query text DEFAULT ''::text, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0, p_category text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, role text, category text, name text, company text, phone text, email text, website text, notes text, usage_count integer, last_used_at timestamp with time zone, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if coalesce(auth.role(),'') is distinct from 'service_role'
     and not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','lender','staff')) then
    raise exception 'staff only';
  end if;

  return query
  select v.id, v.role, v.category, v.name, v.company, v.phone, v.email, v.website, v.notes,
         v.usage_count, v.last_used_at, v.created_at
  from vendor_directory v
  where coalesce(v.is_active, true)
    and (p_role is null or p_role = '' or v.role = p_role)
    and (p_category is null or p_category = '' or v.category = p_category)
    and (
      coalesce(p_query,'') = ''
      or v.name    ilike '%'||p_query||'%'
      or v.company ilike '%'||p_query||'%'
      or v.email   ilike '%'||p_query||'%'
      or v.phone   ilike '%'||p_query||'%'
    )
  order by v.usage_count desc, v.last_used_at desc nulls last, lower(coalesce(v.name, v.company, '')) asc
  limit greatest(1, least(coalesce(p_limit,200), 1000))
  offset greatest(0, coalesce(p_offset,0));
end;
$function$;

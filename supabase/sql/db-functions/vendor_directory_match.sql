-- vendor_directory_match(p_role text, p_name text, p_company text, p_email text)
-- language: sql
-- Captured from production 2026-08-11.

CREATE OR REPLACE FUNCTION public.vendor_directory_match(p_role text, p_name text, p_company text, p_email text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with cfg as (
    select public.vendor_canonical_role(p_role)              as v_role,
           nullif(lower(trim(coalesce(p_email,''))),'')      as v_email,
           public.vendor_email_is_complete(p_email)          as v_ok,
           lower(trim(coalesce(p_name,'')))                  as v_name,
           lower(trim(coalesce(p_company,'')))               as v_co
  )
  select id from (
    select vd.id, 1 as rank from public.vendor_directory vd, cfg
      where public.vendor_canonical_role(vd.role) is not distinct from cfg.v_role
        and cfg.v_ok and lower(vd.email) = cfg.v_email
    union all
    select vd.id, 2 from public.vendor_directory vd, cfg
      where public.vendor_canonical_role(vd.role) is not distinct from cfg.v_role
        and cfg.v_ok
        and lower(coalesce(vd.name,'')) = cfg.v_name
        and lower(coalesce(vd.company,'')) = cfg.v_co
        and not public.vendor_email_is_complete(vd.email)
    union all
    select vd.id, 3 from public.vendor_directory vd, cfg
      where public.vendor_canonical_role(vd.role) is not distinct from cfg.v_role
        and not cfg.v_ok
        and lower(coalesce(vd.name,'')) = cfg.v_name
        and lower(coalesce(vd.company,'')) = cfg.v_co
  ) m order by rank limit 1;
$function$;

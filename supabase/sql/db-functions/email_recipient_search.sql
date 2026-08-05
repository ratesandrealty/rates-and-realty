-- email_recipient_search(p_q text, p_limit integer)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.email_recipient_search(p_q text, p_limit integer DEFAULT 8)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v jsonb; v_q text := '%'||lower(trim(coalesce(p_q,'')))||'%';
begin
  v_role := coalesce(public.current_app_role(),'');
  if not (public.is_admin() or v_role in ('va','loa','agent','staff')) then
    raise exception 'not authorized';
  end if;
  if length(trim(coalesce(p_q,''))) < 2 then return '[]'::jsonb; end if;

  with cand as (
    -- contacts (highest priority)
    select nullif(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')),'') as name,
           lower(email) as email, 'contact' as kind, 1 as pri
    from contacts where email is not null and email <> ''
      and (lower(email) like v_q or lower(coalesce(first_name,'')||' '||coalesce(last_name,'')) like v_q)
    union all
    -- referral partners
    select nullif(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')),''),
           lower(email), 'partner', 2
    from referral_partners where email is not null and email <> ''
      and (lower(email) like v_q or lower(coalesce(first_name,'')||' '||coalesce(last_name,'')) like v_q)
    union all
    -- vendors (title/escrow/hoi...)
    select nullif(trim(coalesce(name,'')),''), lower(email), 'vendor', 2
    from vendor_directory where email is not null and email <> ''
      and (lower(email) like v_q or lower(coalesce(name,'')) like v_q)
    union all
    -- anyone previously emailed (from/to in email_log)
    select nullif(trim(coalesce(from_name,'')),''), lower(from_email), 'history', 3
    from email_log where from_email is not null and from_email <> '' and lower(from_email) like v_q
    union all
    select null, lower(to_email), 'history', 3
    from email_log where to_email is not null and to_email <> '' and lower(to_email) like v_q
  ),
  ranked as (
    select email,
           (array_agg(name order by pri) filter (where name is not null))[1] as name,
           min(pri) as pri, count(*) as freq
    from cand
    where email is not null and email <> ''
    group by email
  )
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'email', email, 'kind',
           case when pri=1 then 'contact' when pri=2 then 'directory' else 'history' end)
           order by pri, freq desc), '[]'::jsonb)
  into v from (select * from ranked order by pri, freq desc limit p_limit) x;
  return v;
end; $function$;

-- team_roster()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-15. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.team_roster()
 RETURNS TABLE(user_id uuid, handle text, display text, role text, email text, kind text, partner_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not (is_admin() or coalesce(current_app_role(),'') in ('va','agent')) then
    raise exception 'not authorized';
  end if;

  return query
  select r.user_id, r.handle, r.display, r.role, r.email, r.kind, r.partner_id
  from (
    select aur.user_id,
           lower(split_part(u.email::text,'@',1)) as handle,
           coalesce(nullif(u.raw_user_meta_data->>'full_name',''),
                    initcap(replace(split_part(u.email::text,'@',1), '.', ' '))) as display,
           aur.role::text as role,
           u.email::text as email,
           'staff'::text as kind,
           null::uuid as partner_id
    from auth_user_roles aur
    join auth.users u on u.id = aur.user_id
    where not aur.service_account /* the roster is people; automation logins are not staff */

    union all

    select null::uuid,
           hh.handle,
           h.display,
           'referral_partner'::text,
           h.email,
           'partner'::text,
           h.id
    from (
      select rp.id, rp.email,
             nullif(trim(coalesce(rp.first_name,'')||' '||coalesce(rp.last_name,'')),'') as display,
             'rp-' ||
               regexp_replace(lower(coalesce(rp.first_name,'partner')), '[^a-z0-9]', '', 'g') ||
               case when coalesce(rp.last_name,'') <> ''
                    then '-' || lower(substr(regexp_replace(rp.last_name,'[^A-Za-z0-9]','','g'),1,1))
                    else '' end as base_handle,
             row_number() over (
               partition by 'rp-' ||
                 regexp_replace(lower(coalesce(rp.first_name,'partner')), '[^a-z0-9]', '', 'g') ||
                 case when coalesce(rp.last_name,'') <> ''
                      then '-' || lower(substr(regexp_replace(rp.last_name,'[^A-Za-z0-9]','','g'),1,1))
                      else '' end
               order by rp.created_at nulls last, rp.id
             ) as rn
      from referral_partners rp
      where rp.email is not null and rp.email <> ''
        and coalesce(rp.status,'') <> 'inactive'
    ) h
    cross join lateral (select case when h.rn = 1 then h.base_handle else h.base_handle || '-' || h.rn end as handle) hh
  ) r
  order by case r.role when 'admin' then 0 when 'referral_partner' then 2 else 1 end, r.display;
end; $function$;

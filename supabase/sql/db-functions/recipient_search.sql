-- recipient_search(p_query text, p_limit integer)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.recipient_search(p_query text, p_limit integer DEFAULT 8)
 RETURNS TABLE(name text, email text, kind text, phone text, contact_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare q text := lower(trim(coalesce(p_query,'')));
begin
  if coalesce(auth.role(),'') is distinct from 'service_role'
     and not (public.is_admin() or coalesce(public.current_app_role(),'') in ('admin','va','loa','agent','lender','staff'))
  then raise exception 'not authorized'; end if;
  if length(q) < 2 then return; end if;

  return query
  with hits as (
    select coalesce(nullif(trim(c.first_name||' '||coalesce(c.last_name,'')),''), c.email) as h_name,
           lower(c.email) as h_email, 'contact'::text as h_kind, c.phone as h_phone, c.id as h_contact_id,
           (case when lower(coalesce(c.first_name,'')) like q||'%' or lower(coalesce(c.last_name,'')) like q||'%' or lower(c.email) like q||'%' then 0 else 1 end) as h_rnk
    from contacts c
    where c.email is not null and c.email <> ''
      and c.merged_into_contact_id is null   -- READ FILTER: current roster only
      and (lower(c.first_name||' '||coalesce(c.last_name,'')) like '%'||q||'%' or lower(c.email) like '%'||q||'%')
      and (coalesce(current_app_role(),'') <> 'va' or is_lead_shared_with_me(c.id))
    union all
    select coalesce(nullif(trim(rp.first_name||' '||coalesce(rp.last_name,'')),''), rp.email),
           lower(rp.email), 'partner'::text, rp.phone, null::uuid,
           (case when lower(coalesce(rp.first_name,'')) like q||'%' or lower(coalesce(rp.last_name,'')) like q||'%' or lower(rp.email) like q||'%' then 0 else 1 end)
    from referral_partners rp
    where rp.email is not null and rp.email <> ''
      and (lower(rp.first_name||' '||coalesce(rp.last_name,'')) like '%'||q||'%' or lower(rp.email) like '%'||q||'%')
      and (coalesce(current_app_role(),'') <> 'va')
  ),
  deduped as (
    select distinct on (h_email) h_name, h_email, h_kind, h_phone, h_contact_id, h_rnk
    from hits order by h_email, h_rnk
  )
  select d.h_name,
         case when current_app_role()='va' and not is_admin() then 'lead-'||left(d.h_contact_id::text,8)||'@masked.local' else d.h_email end,
         d.h_kind,
         case when current_app_role()='va' and not is_admin() then mask_phone(d.h_phone) else d.h_phone end,
         d.h_contact_id
  from deduped d
  order by d.h_rnk, d.h_name
  limit greatest(1, least(coalesce(p_limit,8), 20));
end;
$function$;

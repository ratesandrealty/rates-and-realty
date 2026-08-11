-- contact_related_people(p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.contact_related_people(p_contact_id uuid)
 RETURNS TABLE(person_contact_id uuid, name text, email text, phone text, relationship text, source text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not public.is_admin() then
    raise exception 'admin only';
  end if;

  return query
  with rels as (
    -- explicit relationship, outgoing
    select cr.related_contact_id as other_id, cr.relationship_type as rel, 1 as pref
    from contact_relationships cr where cr.contact_id = p_contact_id
    union all
    -- explicit relationship, incoming
    select cr.contact_id, cr.relationship_type, 1
    from contact_relationships cr where cr.related_contact_id = p_contact_id
    union all
    -- co-borrowers linked to this contact as their primary
    select c.id, 'co_borrower', 2
    from contacts c where c.primary_borrower_contact_id = p_contact_id and c.id <> p_contact_id
    union all
    -- this contact's own primary borrower (if it is a co-borrower)
    select c.primary_borrower_contact_id, 'co_borrower', 2
    from contacts c where c.id = p_contact_id and c.primary_borrower_contact_id is not null
  ),
  dedup as (
    select distinct on (other_id) other_id, rel
    from rels
    where other_id is not null and other_id <> p_contact_id
    order by other_id, pref
  )
  select d.other_id,
         nullif(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')), '') as name,
         c.email, c.phone, d.rel,
         case when d.rel ilike '%co%borrow%' then 'co_borrower' else 'relationship' end as source
  from dedup d join contacts c on c.id = d.other_id
  order by name nulls last;
end;
$function$;

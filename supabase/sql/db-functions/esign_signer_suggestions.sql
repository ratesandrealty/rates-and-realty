-- esign_signer_suggestions(p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-06. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.esign_signer_suggestions(p_contact_id uuid)
 RETURNS TABLE(name text, email text, role text, source text, person_contact_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.role() = 'authenticated' and not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'admin only';
  end if;

  return query
  with app as (select linked_application_id as app_id from contacts where id = p_contact_id),
  sugg as (
    select trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')) nm, c.email em,
           'borrower'::text rl, 'Primary borrower'::text src, c.id pid, 1 rank
    from contacts c where c.id = p_contact_id
    union all
    select trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')), c.email,
           'co_borrower', 'Co-borrower', c.id, 2
    from contacts c where c.primary_borrower_contact_id = p_contact_id
    union all
    select trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')), c.email,
           coalesce(lb.borrower_role,'co_borrower'), 'Loan borrower', c.id, 2
    from loan_borrowers lb join contacts c on c.id = lb.contact_id
    join app on lb.application_id = app.app_id where c.id <> p_contact_id
    union all
    select trim(coalesce(ab.first_name,'')||' '||coalesce(ab.last_name,'')), ab.email,
           coalesce(ab.role,'co_borrower'), 'Application borrower', null::uuid, 3
    from application_borrowers ab join app on ab.application_id = app.app_id
    union all
    select trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')), c.email,
           coalesce(cr.relationship_type,'related'), 'Related party', c.id, 4
    from contact_relationships cr join contacts c on c.id = cr.related_contact_id
    where cr.contact_id = p_contact_id
    union all
    select lc.name, lc.email, coalesce(lc.role,'other'), 'Loan team', null::uuid, 5
    from loan_contacts lc where lc.contact_id = p_contact_id
  ),
  deduped as (
    select distinct on (lower(em)) nm, em, rl, src, pid, rank
    from sugg where coalesce(em,'') <> '' order by lower(em), rank
  )
  select nm, em, rl, src, pid from deduped order by rank, nm;
end;
$function$;

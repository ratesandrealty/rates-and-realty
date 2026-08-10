-- esign_people_search(p_contact_id uuid, p_query text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-06. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.esign_people_search(p_contact_id uuid, p_query text DEFAULT ''::text)
 RETURNS TABLE(name text, email text, role text, source text, person_contact_id uuid, is_loan boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  q text := '%' || trim(coalesce(p_query,'')) || '%';
  qlen int := length(trim(coalesce(p_query,'')));
begin
  if auth.role() = 'authenticated' and not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'admin only';
  end if;

  return query
  with loan_people as (
    select s.name nm, s.email em, s.role rl, s.source src, s.person_contact_id pid
    from public.esign_signer_suggestions(p_contact_id) s
  ),
  loan_filtered as (
    select nm, em, rl, src, pid, true as loanflag, 0 as grp
    from loan_people
    where qlen = 0 or nm ilike q or em ilike q
  ),
  crm as (
    select trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')) nm,
           c.email em, 'borrower'::text rl, 'CRM contact'::text src, c.id pid,
           false as loanflag, 1 as grp
    from contacts c
    where qlen >= 2
      and c.merged_into_contact_id is null   -- READ FILTER: current roster only
      and coalesce(c.email,'') <> ''
      and (
        (coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) ilike q
        or c.first_name ilike q
        or c.last_name ilike q
        or c.email ilike q
      )
      and lower(c.email) not in (select lower(em) from loan_filtered where em is not null)
    limit 20
  ),
  unioned as (
    select * from loan_filtered
    union all
    select * from crm
  ),
  deduped as (
    select distinct on (lower(em)) nm, em, rl, src, pid, loanflag, grp
    from unioned
    where coalesce(em,'') <> ''
    order by lower(em), grp
  )
  select nm, em, rl, src, pid, loanflag
  from deduped
  order by grp, nm
  limit 10;
end;
$function$;

-- loan_borrowers_for_contact(p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.loan_borrowers_for_contact(p_contact_id uuid)
 RETURNS TABLE(contact_id uuid, name text, is_primary boolean, employer_name text, employer_phone text, position_title text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.role() = 'authenticated'
     and not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','lender','staff')) then
    raise exception 'staff only';
  end if;
  return query
  -- primary borrower (the lead itself)
  select c.id, nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''), true,
         lb.employer_name, lb.employer_phone, lb.position_title
  from public.contacts c
  left join public.loan_borrowers lb on lb.contact_id = c.id
  where c.id = p_contact_id
  union
  -- co-borrowers linked by primary_borrower_contact_id
  select c2.id, nullif(trim(coalesce(c2.first_name,'')||' '||coalesce(c2.last_name,'')),''), false,
         lb2.employer_name, lb2.employer_phone, lb2.position_title
  from public.contacts c2
  left join public.loan_borrowers lb2 on lb2.contact_id = c2.id
  where c2.primary_borrower_contact_id = p_contact_id;
end; $function$;

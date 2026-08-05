-- add_loan_borrower(p_application_id uuid, p_contact_id uuid, p_is_primary boolean, p_role text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.add_loan_borrower(p_application_id uuid, p_contact_id uuid, p_is_primary boolean DEFAULT false, p_role text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id uuid;
  v_role text := coalesce(nullif(trim(p_role), ''), case when p_is_primary then 'Borrower' else 'CoBorrower' end);
  v_order int;
begin
  if p_application_id is null or p_contact_id is null then
    raise exception 'application_id and contact_id are required';
  end if;

  -- if marking primary, demote any existing primary on this application
  if p_is_primary then
    update loan_borrowers set is_primary = false, updated_at = now()
    where application_id = p_application_id and is_primary = true;
  end if;

  select id into v_id
  from loan_borrowers
  where application_id = p_application_id and contact_id = p_contact_id
  limit 1;

  if v_id is not null then
    update loan_borrowers
       set borrower_role = v_role,
           is_primary    = p_is_primary,
           updated_at    = now()
     where id = v_id;
    return v_id;
  end if;

  if p_is_primary then
    v_order := 1;
  else
    select coalesce(max(borrower_order), 0) + 1 into v_order
    from loan_borrowers where application_id = p_application_id;
    if v_order < 2 then v_order := 2; end if;
  end if;

  insert into loan_borrowers (application_id, contact_id, borrower_role, borrower_order, is_primary)
  values (p_application_id, p_contact_id, v_role, v_order, p_is_primary)
  returning id into v_id;

  return v_id;
end;
$function$;

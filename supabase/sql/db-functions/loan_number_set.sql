-- loan_number_set(p_contact_id uuid, p_loan_number text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.loan_number_set(p_contact_id uuid, p_loan_number text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_id uuid;
begin
  if auth.role() = 'authenticated' and not (is_admin() or coalesce(current_app_role(),'') in ('va','loa','agent','lender','staff')) then
    raise exception 'not authorized';
  end if;

  select id into v_id from mortgage_applications where contact_id = p_contact_id
  order by updated_at desc nulls last, created_at desc limit 1;

  if v_id is null then
    insert into mortgage_applications(contact_id, loan_number, status, created_at, updated_at)
    values (p_contact_id, nullif(trim(p_loan_number),''), 'draft', now(), now())
    returning id into v_id;
  else
    update mortgage_applications set loan_number = nullif(trim(p_loan_number),''), updated_at = now()
    where id = v_id;
  end if;

  return jsonb_build_object('ok', true, 'application_id', v_id, 'loan_number', nullif(trim(p_loan_number),''));
end; $function$;

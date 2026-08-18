-- sync_appraisal_inspection_date(p_contact_id uuid, p_inspection_date date)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-18. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.sync_appraisal_inspection_date(p_contact_id uuid, p_inspection_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (is_admin() or coalesce((select role from public.auth_user_roles where user_id=auth.uid() limit 1),'') in ('admin','agent','loa','va')) then
    raise exception 'not authorized';
  end if;
  -- update the appraisal loan_order inspection_date
  update public.loan_orders set inspection_date = p_inspection_date, updated_at = now()
    where contact_id = p_contact_id and order_type = 'appraisal';
  -- mirror into loan_key_dates as appraisal_due (upsert)
  -- The label must match the canonical list in the 20260817n migration and
  -- LP_KEY_DATES; this function is the only automated writer of a label.
  if p_inspection_date is not null then
    insert into public.loan_key_dates(contact_id, date_key, label, date_value)
    values (p_contact_id, 'appraisal_due', 'Appraisal Contingency', p_inspection_date)
    on conflict (contact_id, date_key) do update set date_value = excluded.date_value, updated_at = now();
  end if;
  return jsonb_build_object('ok', true, 'inspection_date', p_inspection_date);
end; $function$;

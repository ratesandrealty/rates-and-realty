-- leads_insert_fn()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.leads_insert_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO contacts (
    first_name, last_name, email, phone, source, lead_source,
    loan_amount, loan_type, property_address, deal_outcome,
    actual_earnings, estimated_earnings, closed_date, lost_reason,
    pipeline_status, priority, notes,
    created_at, updated_at
  ) VALUES (
    NEW.first_name, NEW.last_name, NEW.email, NEW.phone,
    NEW.source, NEW.lead_source, NEW.loan_amount, NEW.loan_type,
    NEW.property_address, NEW.deal_outcome,
    COALESCE(NEW.actual_earnings, 0),
    COALESCE(NEW.estimated_earnings, 0),
    NEW.closed_date, NEW.lost_reason,
    COALESCE(NEW.pipeline_status, NEW.status, 'New Lead'),
    COALESCE(NEW.priority, 'normal'),
    NEW.notes,
    COALESCE(NEW.created_at, NOW()), NOW()
  )
  RETURNING id INTO new_id;
  NEW.id := new_id;
  NEW.contact_id := new_id;
  RETURN NEW;
END;
$function$;

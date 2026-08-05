-- leads_update_fn()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.leads_update_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  update contacts set
    deal_outcome     = NEW.deal_outcome,
    closed_date      = NEW.closed_date,
    lost_reason      = NEW.lost_reason,
    loan_amount      = COALESCE(NEW.loan_amount, loan_amount),
    loan_type        = COALESCE(NEW.loan_type, loan_type),
    property_address = COALESCE(NEW.property_address, property_address),
    property_city    = COALESCE(NEW.property_city, property_city),
    property_state   = COALESCE(NEW.property_state, property_state),
    property_zip     = COALESCE(NEW.property_zip, property_zip),
    property_value   = COALESCE(NEW.property_value, property_value),
    purchase_price   = COALESCE(NEW.purchase_price, purchase_price),
    down_payment     = COALESCE(NEW.down_payment, down_payment),
    ltv              = COALESCE(NEW.ltv, ltv),
    timeline         = COALESCE(NEW.timeline, timeline),
    priority         = COALESCE(NEW.priority, priority),
    pipeline_status  = COALESCE(NEW.pipeline_status, pipeline_status),
    notes            = COALESCE(NEW.notes, notes),
    ai_summary       = COALESCE(NEW.ai_summary, ai_summary),
    next_action      = COALESCE(NEW.next_action, next_action),
    assigned_to      = COALESCE(NEW.assigned_to, assigned_to),
    updated_at       = NOW()
  where id = OLD.id;
  return NEW;
end;
$function$;

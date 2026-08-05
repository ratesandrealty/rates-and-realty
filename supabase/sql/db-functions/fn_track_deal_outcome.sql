-- fn_track_deal_outcome()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.fn_track_deal_outcome()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Only fire when pipeline_status actually changes
  IF NEW.pipeline_status = OLD.pipeline_status THEN
    RETURN NEW;
  END IF;

  -- Handle CLOSED
  IF NEW.pipeline_status = 'Closed' THEN
    INSERT INTO closed_deals (
      contact_id,
      loan_amount,
      loan_type,
      commission_rate,
      commission_earned,
      close_date,
      outcome,
      created_at,
      updated_at
    ) VALUES (
      NEW.id,
      COALESCE(NEW.loan_amount, 0),
      COALESCE(NEW.loan_type, 'Unknown'),
      1.0,
      COALESCE(NEW.loan_amount, 0) * 0.01,
      CURRENT_DATE,
      'closed',
      NOW(),
      NOW()
    )
    ON CONFLICT (contact_id) DO UPDATE SET
      loan_amount = COALESCE(NEW.loan_amount, 0),
      loan_type = COALESCE(NEW.loan_type, 'Unknown'),
      commission_earned = COALESCE(NEW.loan_amount, 0) * 0.01,
      close_date = CURRENT_DATE,
      outcome = 'closed',
      updated_at = NOW();
  END IF;

  -- Handle LOST
  IF NEW.pipeline_status = 'Lost' THEN
    INSERT INTO closed_deals (
      contact_id,
      loan_amount,
      loan_type,
      commission_rate,
      commission_earned,
      close_date,
      outcome,
      created_at,
      updated_at
    ) VALUES (
      NEW.id,
      COALESCE(NEW.loan_amount, 0),
      COALESCE(NEW.loan_type, 'Unknown'),
      0,
      0,
      CURRENT_DATE,
      'lost',
      NOW(),
      NOW()
    )
    ON CONFLICT (contact_id) DO UPDATE SET
      loan_amount = COALESCE(NEW.loan_amount, 0),
      loan_type = COALESCE(NEW.loan_type, 'Unknown'),
      commission_earned = 0,
      close_date = CURRENT_DATE,
      outcome = 'lost',
      updated_at = NOW();
  END IF;

  RETURN NEW;
END;
$function$;

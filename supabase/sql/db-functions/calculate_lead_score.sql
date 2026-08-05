-- calculate_lead_score()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.calculate_lead_score()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  score integer := 0;
BEGIN
  -- Timeline scoring
  IF NEW.timeline = 'Immediately' THEN score := score + 40;
  ELSIF NEW.timeline = '1-3 months' THEN score := score + 25;
  ELSIF NEW.timeline = '3-6 months' THEN score := score + 15;
  ELSE score := score + 5;
  END IF;

  -- Loan type scoring
  IF NEW.loan_type IN ('DSCR', 'Jumbo') THEN score := score + 30;
  ELSIF NEW.loan_type IN ('Conventional', 'FHA') THEN score := score + 20;
  ELSE score := score + 10;
  END IF;

  -- Source scoring
  IF NEW.source IN ('referral', 'google') THEN score := score + 30;
  ELSIF NEW.source IN ('facebook', 'website') THEN score := score + 20;
  ELSE score := score + 10;
  END IF;

  -- Set priority
  NEW.score := score;
  IF score >= 70 THEN NEW.priority := 'high';
  ELSIF score >= 40 THEN NEW.priority := 'medium';
  ELSE NEW.priority := 'low';
  END IF;

  RETURN NEW;
END;
$function$;

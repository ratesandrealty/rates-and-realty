-- claim_pending_guideline()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.claim_pending_guideline()
 RETURNS TABLE(id uuid, lender_id uuid, title text, file_url text, category text, loan_types text[])
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  picked_id uuid;
BEGIN
  SELECT g.id INTO picked_id
  FROM lender_guidelines g
  WHERE g.is_active = true
    AND g.file_url IS NOT NULL
    AND (g.chunk_status IS NULL OR g.chunk_status = 'failed')
  ORDER BY g.id
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF picked_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE lender_guidelines
  SET chunk_status = 'running'
  WHERE lender_guidelines.id = picked_id;

  RETURN QUERY
  SELECT g.id, g.lender_id, g.title, g.file_url, g.category, g.loan_types
  FROM lender_guidelines g WHERE g.id = picked_id;
END;
$function$;

-- cleanup_sms_bot_logs()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.cleanup_sms_bot_logs()
 RETURNS TABLE(table_name text, rows_deleted bigint, cutoff_date timestamp with time zone, ran_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sms_cutoff timestamptz := now() - interval '90 days';
  v_pending_cutoff timestamptz := now() - interval '30 days';
  v_sms_deleted bigint;
  v_pending_deleted bigint;
  v_now timestamptz := now();
BEGIN
  -- Retain 90 days of sms_assistant_log
  WITH d AS (
    DELETE FROM public.sms_assistant_log
    WHERE created_at < v_sms_cutoff
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_sms_deleted FROM d;

  -- Retain 30 days of resolved/expired pending_clarifications
  -- (active pending rows are preserved regardless of age)
  WITH d AS (
    DELETE FROM public.pending_clarifications
    WHERE created_at < v_pending_cutoff
      AND (resolved_at IS NOT NULL OR expires_at < v_now)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_pending_deleted FROM d;

  RETURN QUERY VALUES
    ('sms_assistant_log'::text, v_sms_deleted, v_sms_cutoff, v_now),
    ('pending_clarifications'::text, v_pending_deleted, v_pending_cutoff, v_now);
END;
$function$;

-- trigger_score_recalc()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.trigger_score_recalc()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  trigger_event text;
  trigger_reason text;
  should_score boolean := false;
BEGIN
  IF NEW.contact_id IS NULL THEN RETURN NEW; END IF;

  IF TG_TABLE_NAME = 'sms_log' THEN
    IF NEW.direction = 'inbound' THEN should_score := true; trigger_event := 'sms_inbound'; END IF;
  ELSIF TG_TABLE_NAME = 'email_log' THEN
    IF (NEW.opened_at IS NOT NULL AND (OLD IS NULL OR OLD.opened_at IS NULL)) THEN
      should_score := true; trigger_event := 'email_opened';
    END IF;
  ELSIF TG_TABLE_NAME = 'activity_events' THEN
    IF NEW.type IN ('appointment_set', 'appointment_completed', 'document_uploaded', 'showing_requested', '1003_submitted', 'preapproval_generated', 'STAGE_CHANGE',
                    'video_play_started', 'video_completed', 'video_cta_clicked', 'video_chat_lead_captured') THEN
      should_score := true; trigger_event := NEW.type;
      -- Carry the human-readable reason the emitter wrote. lead-scorer stores it
      -- on lead_score_history.reason, which otherwise only ever held the raw
      -- trigger name ("video_completed").
      trigger_reason := nullif(trim(coalesce(NEW.description, '')), '');
    END IF;
  END IF;

  IF should_score THEN
    PERFORM net.http_post(
      url := 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/lead-scorer',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxqeXdodmJtc2lid25zc3hwZXNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNjE2NTUsImV4cCI6MjA4OTYzNzY1NX0.QaewUhTWdATj35VewvmfQcHB_b3I9FhhwXSRuqNBKvw"}'::jsonb,
      body := jsonb_build_object('action', 'score_contact', 'contact_id', NEW.contact_id, 'trigger', trigger_event, 'reason', trigger_reason),
      timeout_milliseconds := 8000
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Lead scoring trigger failed: %', SQLERRM;
  RETURN NEW;
END;
$function$;

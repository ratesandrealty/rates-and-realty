-- trg_clickup_tour_status()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.trg_clickup_tour_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_stop_count int;
  v_tour_date text;
  v_context jsonb;
BEGIN
  IF (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    v_tour_date := COALESCE(to_char(NEW.scheduled_start AT TIME ZONE 'America/Los_Angeles', 'Dy Mon DD'), 'TBD');
    SELECT COUNT(*) INTO v_stop_count FROM showings WHERE batch_id = NEW.id AND deleted_at IS NULL;
    v_context := jsonb_build_object(
      'tour_date', v_tour_date,
      'stop_count', v_stop_count,
      'anchor_date', NEW.scheduled_start
    );

    IF NEW.status = 'sent' THEN
      PERFORM fire_clickup_automation('tour_sent', NEW.contact_id, NEW.id::text, v_context);
    ELSIF NEW.status = 'confirmed' THEN
      PERFORM fire_clickup_automation('tour_confirmed', NEW.contact_id, NEW.id::text, v_context);
    ELSIF NEW.status = 'completed' THEN
      PERFORM fire_clickup_automation('tour_completed', NEW.contact_id, NEW.id::text, v_context);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- fire_clickup_automation(p_trigger_type text, p_contact_id uuid, p_source_id text, p_context jsonb)
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.fire_clickup_automation(p_trigger_type text, p_contact_id uuid, p_source_id text DEFAULT NULL::text, p_context jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM net.http_post(
    url := 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/clickup-auto-create',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object(
      'trigger_type', p_trigger_type,
      'contact_id', p_contact_id,
      'source_id', p_source_id,
      'context', p_context
    )
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'fire_clickup_automation failed: %', SQLERRM;
END;
$function$;

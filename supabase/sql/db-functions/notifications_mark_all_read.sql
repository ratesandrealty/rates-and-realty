-- notifications_mark_all_read()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.notifications_mark_all_read()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_n int;
begin
  update public.app_notifications set is_read = true, read_at = now()
  where recipient_user_id = auth.uid() and is_read = false;
  get diagnostics v_n = row_count;
  return v_n;
end; $function$;

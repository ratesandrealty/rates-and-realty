-- notifications_list(p_limit integer, p_only_unread boolean)
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.notifications_list(p_limit integer DEFAULT 30, p_only_unread boolean DEFAULT false)
 RETURNS SETOF app_notifications
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select * from public.app_notifications
  where recipient_user_id = auth.uid()
    and (not p_only_unread or is_read = false)
  order by created_at desc
  limit greatest(1, least(coalesce(p_limit,30), 100));
$function$;

-- va_help_list()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.va_help_list()
 RETURNS TABLE(key text, title text, body text, video_url text, sort_order integer, is_active boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  return query select h.key, h.title, h.body, h.video_url, h.sort_order, h.is_active
  from public.va_portal_help h order by h.sort_order;
end; $function$;

-- va_help_set_video(p_key text, p_video_url text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.va_help_set_video(p_key text, p_video_url text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  update public.va_portal_help
    set video_url = nullif(trim(coalesce(p_video_url,'')),''), updated_at = now(), updated_by = auth.uid()
    where key = p_key;
  if not found then raise exception 'help key % not found', p_key; end if;
  return jsonb_build_object('ok', true, 'key', p_key, 'video_url', p_video_url);
end; $function$;

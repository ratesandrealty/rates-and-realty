-- video_get_public(p_slug text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.video_get_public(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v public.videos;
begin
  select * into v from public.videos where slug = p_slug;
  if not found then return jsonb_build_object('found', false); end if;
  return jsonb_build_object(
    'found', true, 'slug', v.slug, 'title', v.title,
    'public_url', v.public_url, 'storage_path', v.storage_path,
    'poster_url', v.poster_url, 'mime_type', v.mime_type,
    'duration_seconds', v.duration_seconds, 'created_at', v.created_at
  );
end; $function$;

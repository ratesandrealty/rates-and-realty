-- help_topic_upsert(p_key text, p_title text, p_description text, p_video_url text, p_video_slug text, p_area text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.help_topic_upsert(p_key text, p_title text DEFAULT NULL::text, p_description text DEFAULT NULL::text, p_video_url text DEFAULT NULL::text, p_video_slug text DEFAULT NULL::text, p_area text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  insert into public.help_topics(topic_key, title, description, video_url, video_slug, area, updated_by, updated_at)
  values (p_key, p_title, p_description, nullif(p_video_url,''), p_video_slug, coalesce(p_area,'crm'), auth.uid(), now())
  on conflict (topic_key) do update set
    title       = coalesce(excluded.title, help_topics.title),
    description = coalesce(excluded.description, help_topics.description),
    video_url   = case when p_video_url is not null then nullif(p_video_url,'') else help_topics.video_url end,
    video_slug  = coalesce(excluded.video_slug, help_topics.video_slug),
    area        = coalesce(excluded.area, help_topics.area),
    updated_by  = auth.uid(), updated_at = now();
  return jsonb_build_object('ok', true, 'topic_key', p_key);
end; $function$;

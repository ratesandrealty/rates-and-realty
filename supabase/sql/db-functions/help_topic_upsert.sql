-- help_topic_upsert(p_key text, p_title text, p_description text, p_video_url text, p_video_slug text, p_area text, p_sort_order integer, p_is_active boolean, p_collection text)
-- language: plpgsql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public.help_topic_upsert(p_key text, p_title text DEFAULT NULL::text, p_description text DEFAULT NULL::text, p_video_url text DEFAULT NULL::text, p_video_slug text DEFAULT NULL::text, p_area text DEFAULT NULL::text, p_sort_order integer DEFAULT NULL::integer, p_is_active boolean DEFAULT NULL::boolean, p_collection text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  insert into public.help_topics(
    topic_key, title, description, video_url, video_slug, area,
    sort_order, is_active, collection, updated_by, updated_at)
  values (
    p_key, p_title, p_description, nullif(p_video_url,''), nullif(p_video_slug,''),
    coalesce(p_area,'crm'), coalesce(p_sort_order,0), coalesce(p_is_active,true),
    nullif(p_collection,''), auth.uid(), now())
  on conflict (topic_key) do update set
    title       = coalesce(excluded.title, help_topics.title),
    description = coalesce(excluded.description, help_topics.description),
    video_url   = case when p_video_url  is not null then nullif(p_video_url,'')  else help_topics.video_url  end,
    video_slug  = case when p_video_slug is not null then nullif(p_video_slug,'') else help_topics.video_slug end,
    area        = coalesce(excluded.area, help_topics.area),
    sort_order  = coalesce(p_sort_order, help_topics.sort_order),
    is_active   = coalesce(p_is_active,  help_topics.is_active),
    /* '' clears the collection (removes a section from the document without
       deleting its text), matching how '' clears video_url. */
    collection  = case when p_collection is not null then nullif(p_collection,'') else help_topics.collection end,
    updated_by  = auth.uid(), updated_at = now();
  return jsonb_build_object('ok', true, 'topic_key', p_key);
end; $function$;

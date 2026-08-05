-- video_list(p_limit integer)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.video_list(p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, slug text, title text, public_url text, kind text, duration_seconds numeric, view_count integer, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (is_admin() or coalesce(current_app_role(),'') in ('admin','agent','loa')) then raise exception 'not authorized'; end if;
  return query select v.id, v.slug, v.title, v.public_url, v.kind, v.duration_seconds, v.view_count, v.created_at
  from public.videos v order by v.created_at desc limit greatest(1, least(coalesce(p_limit,50),200));
end; $function$;

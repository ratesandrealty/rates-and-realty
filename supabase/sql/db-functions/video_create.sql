-- video_create(p_title text, p_storage_path text, p_public_url text, p_duration numeric, p_size bigint, p_kind text, p_contact_id uuid, p_context text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.video_create(p_title text, p_storage_path text, p_public_url text DEFAULT NULL::text, p_duration numeric DEFAULT NULL::numeric, p_size bigint DEFAULT NULL::bigint, p_kind text DEFAULT 'loom'::text, p_contact_id uuid DEFAULT NULL::uuid, p_context text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v public.videos;
begin
  if not (is_admin() or coalesce(current_app_role(),'') in ('admin','agent','loa','va','staff')) then
    raise exception 'not authorized';
  end if;
  insert into public.videos(title, storage_path, public_url, duration_seconds, size_bytes, kind, contact_id, context)
  values (nullif(trim(coalesce(p_title,'')),''), p_storage_path, p_public_url, p_duration, p_size,
          coalesce(nullif(p_kind,''),'loom'), p_contact_id, p_context)
  returning * into v;
  return jsonb_build_object('id', v.id, 'slug', v.slug, 'public_url', v.public_url, 'title', v.title);
end; $function$;

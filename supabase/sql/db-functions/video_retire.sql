-- video_retire(p_slug text)
-- language: plpgsql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public.video_retire(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.videos;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  delete from public.videos where slug = p_slug returning * into v_row;
  if v_row.id is null then
    return jsonb_build_object('ok', true, 'deleted', false, 'reason', 'no such slug');
  end if;
  return jsonb_build_object('ok', true, 'deleted', true, 'slug', p_slug, 'storage_path', v_row.storage_path);
end; $function$;

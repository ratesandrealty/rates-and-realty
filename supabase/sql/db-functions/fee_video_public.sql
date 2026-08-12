-- fee_video_public(p_slug text)
-- language: plpgsql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public.fee_video_public(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_snap public.fee_sheet_snapshots; v_row public.fee_sheet_videos;
begin
  select * into v_snap from public.fee_sheet_snapshots where slug = p_slug;
  if v_snap.id is null then return jsonb_build_object('video', false); end if;
  if v_snap.revoked_at is not null then return jsonb_build_object('video', false); end if;
  if v_snap.expires_at is not null and v_snap.expires_at <= now() then
    return jsonb_build_object('video', false);
  end if;
  select * into v_row from public.fee_sheet_videos
   where fee_slug = p_slug and revoked_at is null;
  if v_row.id is null or v_row.storage_path is null then
    return jsonb_build_object('video', false);
  end if;
  return jsonb_build_object('video', true, 'storage_path', v_row.storage_path);
end; $function$;

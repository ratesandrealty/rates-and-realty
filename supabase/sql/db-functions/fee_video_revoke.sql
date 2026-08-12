-- fee_video_revoke(p_slug text, p_reason text)
-- language: plpgsql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public.fee_video_revoke(p_slug text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_row public.fee_sheet_videos;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  update public.fee_sheet_videos
     set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = coalesce(p_reason,'pulled')
   where fee_slug = p_slug and revoked_at is null
   returning * into v_row;
  if v_row.id is null then
    return jsonb_build_object('ok', true, 'revoked', false, 'reason', 'no live video on this link');
  end if;
  return jsonb_build_object('ok', true, 'revoked', true,
                            'storage_path', v_row.storage_path, 'video_id', v_row.video_id);
end; $function$;

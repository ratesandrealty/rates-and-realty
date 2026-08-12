-- fee_video_attach(p_slug text, p_video_id uuid, p_storage_path text)
-- language: plpgsql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public.fee_video_attach(p_slug text, p_video_id uuid, p_storage_path text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_snap public.fee_sheet_snapshots; v_prev jsonb; v_id uuid;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  select * into v_snap from public.fee_sheet_snapshots where slug = p_slug;
  if v_snap.id is null then raise exception 'no such fee sheet link'; end if;

  select jsonb_build_object('id', id, 'storage_path', storage_path) into v_prev
    from public.fee_sheet_videos where fee_slug = p_slug and revoked_at is null;

  update public.fee_sheet_videos
     set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'replaced'
   where fee_slug = p_slug and revoked_at is null;

  insert into public.fee_sheet_videos (fee_slug, video_id, storage_path, attached_by)
  values (p_slug, p_video_id, nullif(p_storage_path,''), auth.uid())
  returning id into v_id;

  /* The caller is told what it must delete from storage. Returned rather than
     assumed, so a replace cannot silently leave the old bytes addressable. */
  return jsonb_build_object('ok', true, 'id', v_id, 'replaced', v_prev);
end; $function$;

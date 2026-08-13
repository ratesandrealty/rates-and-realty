-- delete_fee_sheet_snapshot(p_slug text, p_confirm boolean)
-- language: plpgsql
-- Captured from production 2026-08-13.

CREATE OR REPLACE FUNCTION public.delete_fee_sheet_snapshot(p_slug text, p_confirm boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_snap public.fee_sheet_snapshots; v_paths text[]; v_left text[]; v_vids uuid[];
begin
  /* Deletion is admin-only while revoke and archive are staff. Revoking is
     reversible and archiving is a filing decision; this destroys a record of
     what a borrower was sent, including its view history. */
  if not public.is_admin() then raise exception 'admin only'; end if;

  select * into v_snap from public.fee_sheet_snapshots where slug = p_slug;
  if v_snap.id is null then raise exception 'no such fee sheet link'; end if;

  select coalesce(array_agg(distinct storage_path) filter (where storage_path is not null), '{}')
    into v_paths from public.fee_sheet_videos where fee_slug = p_slug;

  if not p_confirm then
    return jsonb_build_object('ok', true, 'deleted', false, 'plan', true,
      'slug', v_snap.slug, 'borrower_name', v_snap.borrower_name,
      'view_count', v_snap.view_count, 'created_at', v_snap.created_at,
      'video_paths', to_jsonb(v_paths));
  end if;

  select coalesce(array_agg(name), '{}') into v_left
    from storage.objects
   where bucket_id = 'video-messages' and name = any(v_paths);
  if array_length(v_left, 1) > 0 then
    raise exception 'refusing to delete: % video object(s) still in the bucket (%). Remove the object first.',
      array_length(v_left,1), array_to_string(v_left, ', ');
  end if;

  /* Only walkthroughs recorded FOR this link, and only if no other link still
     points at them. A video attached from elsewhere is not ours to destroy. */
  select coalesce(array_agg(v.id), '{}') into v_vids
    from public.videos v
   where v.id in (select video_id from public.fee_sheet_videos where fee_slug = p_slug and video_id is not null)
     and v.context = 'fee_walkthrough'
     and not exists (select 1 from public.fee_sheet_videos o
                      where o.video_id = v.id and o.fee_slug <> p_slug);

  delete from public.fee_sheet_videos where fee_slug = p_slug;
  delete from public.videos where id = any(v_vids);
  delete from public.fee_sheet_snapshots where id = v_snap.id;

  return jsonb_build_object('ok', true, 'deleted', true, 'slug', p_slug,
    'videos_deleted', coalesce(array_length(v_vids,1),0),
    'objects_cleared', coalesce(array_length(v_paths,1),0));
end; $function$;

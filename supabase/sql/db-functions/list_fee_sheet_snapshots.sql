-- list_fee_sheet_snapshots(p_contact_id uuid, p_include_archived boolean)
-- language: plpgsql
-- Captured from production 2026-08-13.

CREATE OR REPLACE FUNCTION public.list_fee_sheet_snapshots(p_contact_id uuid DEFAULT NULL::uuid, p_include_archived boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_out jsonb;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) into v_out
  from (
    select s.slug, s.borrower_name, s.contact_id, s.created_at, s.view_count, s.last_viewed_at,
           s.revoked_at, s.expires_at, s.archived_at, s.share_sections,
           s.data->>'mode' as snapshot_mode,
           exists (select 1 from public.fee_sheet_videos fv
                    where fv.fee_slug = s.slug and fv.revoked_at is null) as has_video,
           s.share_sections->>'mode' as mode_override,
           (select jsonb_agg(jsonb_build_object(
                     'key', k->>'key', 'label', k->>'label',
                     'available', public._fs_has_section(s.data, k->>'key', coalesce(nullif(s.share_sections->>'mode',''), s.data->>'mode')),
                     'on', coalesce((s.share_sections->>(k->>'key'))::boolean, false))
                   order by ord)
              from jsonb_array_elements(public._fs_share_section_keys()) with ordinality t(k, ord)
           ) as sections,
           (select jsonb_agg(jsonb_build_object(
                     'key', m->>'key', 'label', m->>'label',
                     'available', public._fs_has_mode(s.data, m->>'key'))
                   order by ord)
              from jsonb_array_elements(public._fs_share_mode_keys()) with ordinality t(m, ord)
           ) as modes,
           /* archived outranks revoked/expired in the PANEL only. The borrower
              side collapses all three to "no longer available"; here Rene needs
              to see which of them it is. */
           case when s.archived_at is not null then 'archived'
                when s.revoked_at is not null then 'revoked'
                when s.expires_at is not null and s.expires_at <= now() then 'expired'
                else 'live' end as status
    from public.fee_sheet_snapshots s
    where (p_contact_id is null or s.contact_id = p_contact_id)
      and (p_include_archived or s.archived_at is null)
  ) x;
  return v_out;
end; $function$;

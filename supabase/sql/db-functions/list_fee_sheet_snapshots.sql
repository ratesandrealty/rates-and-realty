-- list_fee_sheet_snapshots(p_contact_id uuid)
-- language: plpgsql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public.list_fee_sheet_snapshots(p_contact_id uuid DEFAULT NULL::uuid)
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
    select slug, borrower_name, contact_id, created_at, view_count, last_viewed_at,
           revoked_at, expires_at, share_sections,
           /* Does this snapshot even HAVE a bridge addendum? The per-link toggle
              is only offered when it does — a checkbox for a section that does
              not exist reads as a broken toggle, and enabling it would be
              refused server-side anyway. */
           coalesce((data->'bridge'->>'on')::boolean, false) as has_bridge,
           case when revoked_at is not null then 'revoked'
                when expires_at is not null and expires_at <= now() then 'expired'
                else 'live' end as status
    from public.fee_sheet_snapshots
    where p_contact_id is null or contact_id = p_contact_id
  ) x;
  return v_out;
end; $function$;

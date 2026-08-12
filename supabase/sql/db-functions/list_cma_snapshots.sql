-- list_cma_snapshots(p_contact_id uuid)
-- language: plpgsql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public.list_cma_snapshots(p_contact_id uuid DEFAULT NULL::uuid)
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
    select slug, borrower_name, property_address, contact_id, created_at,
           view_count, last_viewed_at, revoked_at, expires_at,
           include_acquisition, include_rentals,
           case when revoked_at is not null then 'revoked'
                when expires_at is not null and expires_at <= now() then 'expired'
                else 'live' end as status
    from public.cma_snapshots
    where p_contact_id is null or contact_id = p_contact_id
  ) x;
  return v_out;
end; $function$;

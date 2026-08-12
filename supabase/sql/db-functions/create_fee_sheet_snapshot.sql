-- create_fee_sheet_snapshot(p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-12. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.create_fee_sheet_snapshot(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text; v_data jsonb; v_slug text; v_name text; v_url text; v_tries int := 0;
  v_people jsonb; v_expires timestamptz;
  v_bd jsonb; v_loan numeric; v_pp numeric; v_dp numeric; v_rate numeric;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;

  select data into v_data from public.fee_sheet_drafts where contact_id = p_contact_id;
  if v_data is null then raise exception 'no fee sheet draft for this contact — build/save one first'; end if;

  /* ── BUYDOWN MUST BE RENDERABLE ─────────────────────────────────────────── */
  if (v_data->>'mode') = 'buydown' then
    v_bd   := coalesce(v_data->'buydown', '{}'::jsonb);
    v_loan := public._fs_num(v_bd->>'loan');
    v_pp   := public._fs_num(v_data->'common'->>'purchasePrice');
    v_dp   := coalesce(public._fs_num(v_data->'common'->>'downPct'), 0);
    v_rate := public._fs_num(v_bd->>'rate');
    if coalesce(v_loan,0) <= 0 and coalesce(greatest(0, v_pp - (v_pp * v_dp / 100)), 0) <= 0 then
      raise exception 'buydown has no loan amount and no purchase price — the link would tell the borrower the quote is unfinished';
    end if;
    if coalesce(v_rate,0) <= 0 then
      raise exception 'buydown has no note rate — the link would tell the borrower the quote is unfinished';
    end if;
  end if;

  select nullif(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')),'')
    into v_name from public.contacts where id = p_contact_id;
  v_name := coalesce(v_name, 'Borrower');

  select jsonb_agg(x order by x.ord, x.name) into v_people
  from (
    select 0 as ord, v_name as name, 'Primary'::text as relationship
    union all
    select 1 as ord,
           nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'') as name,
           coalesce(cr.relationship_type,'Co-borrower') as relationship
    from public.contact_relationships cr
    join public.contacts c on c.id = cr.related_contact_id
    where cr.contact_id = p_contact_id
  ) x
  where x.name is not null;

  v_data := jsonb_set(v_data, '{_people}', coalesce(v_people, '[]'::jsonb), true);

  loop
    v_slug := public.gen_feesheet_slug();
    exit when not exists (select 1 from public.fee_sheet_snapshots where slug = v_slug)
          and not exists (select 1 from public.short_links where slug = v_slug);
    v_tries := v_tries + 1;
    if v_tries > 12 then raise exception 'could not allocate slug'; end if;
  end loop;

  /* 90 DAYS. A fee sheet is a rate quote: long enough to cover a normal
     purchase from pre-approval to closing without the borrower losing their
     copy, short enough that a stale quote stops circulating on its own. Rene can
     revoke earlier at any time; nothing renews it silently. */
  v_expires := now() + interval '90 days';

  insert into public.fee_sheet_snapshots(slug, contact_id, data, borrower_name, created_by, expires_at)
  values (v_slug, p_contact_id, v_data, v_name, auth.uid(), v_expires);

  v_url := 'https://homes.ratesandrealty.com/fee/' || v_slug;
  return jsonb_build_object('slug', v_slug, 'url', v_url, 'borrower_name', v_name,
                            'expires_at', v_expires,
                            'people', coalesce(v_people, '[]'::jsonb));
end; $function$;

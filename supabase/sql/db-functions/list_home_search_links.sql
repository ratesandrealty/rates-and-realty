-- list_home_search_links(p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.list_home_search_links(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; r record; v_slug text; v_tries int; v_out jsonb := '[]'::jsonb; v_existing text;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;

  for r in
    select id, name, filters, search_url, result_count, created_at
    from public.saved_searches
    where contact_id = p_contact_id and coalesce(active, true)
    order by is_pinned desc nulls last, created_at desc
  loop
    select slug into v_existing from public.short_links where saved_search_id = r.id order by created_at limit 1;
    if v_existing is null then
      v_tries := 0;
      loop
        v_slug := public.gen_search_slug();
        exit when not exists (select 1 from public.short_links where slug = v_slug);
        v_tries := v_tries + 1; if v_tries > 12 then exit; end if;
      end loop;
      insert into public.short_links(slug, destination_url, contact_id, saved_search_id)
      values (v_slug, coalesce(r.search_url, public.build_home_search_url(r.filters)), p_contact_id, r.id)
      on conflict (slug) do nothing;
      v_existing := v_slug;
    end if;

    v_out := v_out || jsonb_build_object(
      'saved_search_id', r.id, 'name', r.name, 'filters', r.filters,
      'result_count', r.result_count,
      'short_url', 'https://homes.ratesandrealty.com/s/' || v_existing,
      'created_at', r.created_at);
  end loop;
  return v_out;
end; $function$;

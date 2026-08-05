-- create_home_search_link(p_contact_id uuid, p_filters jsonb, p_name text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.create_home_search_link(p_contact_id uuid, p_filters jsonb, p_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_search_id uuid; v_url text; v_slug text; v_short text; v_tries int := 0; v_name text;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;

  v_url := public.build_home_search_url(p_filters);
  v_name := coalesce(nullif(trim(p_name),''), 'Search '||to_char(now(),'MM/DD/YYYY'));

  insert into public.saved_searches(contact_id, name, filters, search_url, source, active, created_at, updated_at)
  values (p_contact_id, v_name, p_filters, v_url, 'composer', true, now(), now())
  returning id into v_search_id;

  loop
    v_slug := public.gen_search_slug();
    exit when not exists (select 1 from public.short_links where slug = v_slug);
    v_tries := v_tries + 1; if v_tries > 12 then raise exception 'slug alloc failed'; end if;
  end loop;

  v_short := 'https://homes.ratesandrealty.com/s/' || v_slug;
  insert into public.short_links(slug, destination_url, contact_id, saved_search_id)
  values (v_slug, v_url, p_contact_id, v_search_id);

  return jsonb_build_object('slug', v_slug, 'short_url', v_short, 'search_url', v_url,
                            'saved_search_id', v_search_id, 'name', v_name);
end; $function$;

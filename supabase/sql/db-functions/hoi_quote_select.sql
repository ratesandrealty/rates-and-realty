-- hoi_quote_select(p_request_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.hoi_quote_select(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.hoi_quote_requests; v_first text; v_last text; v_lc_id uuid;
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only'; end if;
  select * into r from public.hoi_quote_requests where id = p_request_id;
  if r.id is null then raise exception 'request not found'; end if;

  update public.hoi_quote_requests set is_selected=false, updated_at=now()
    where contact_id = r.contact_id and id <> r.id and is_selected;
  update public.hoi_quote_requests set is_selected=true, status='selected', updated_at=now() where id = r.id;

  -- prefer stored first/last, else derive
  v_first := coalesce(nullif(trim(coalesce(r.agent_first_name,'')),''), split_part(coalesce(r.agent_name,''),' ',1));
  v_last  := coalesce(nullif(trim(coalesce(r.agent_last_name,'')),''),
             nullif(trim(substr(coalesce(r.agent_name,''), length(split_part(coalesce(r.agent_name,''),' ',1))+1)),''));

  select id into v_lc_id from public.loan_contacts where contact_id=r.contact_id and role='hoi_agent' limit 1;
  if v_lc_id is null then
    insert into public.loan_contacts(contact_id, role, name, first_name, last_name, company, phone, email, updated_at)
    values (r.contact_id, 'hoi_agent', r.agent_name, nullif(v_first,''), v_last, r.company_name, r.agent_phone, r.agent_email, now())
    returning id into v_lc_id;
  else
    update public.loan_contacts set name=r.agent_name, first_name=nullif(v_first,''), last_name=v_last,
      company=r.company_name, phone=r.agent_phone, email=r.agent_email, updated_at=now() where id=v_lc_id;
  end if;
  return jsonb_build_object('selected_request', r.id, 'hoi_agent_contact', v_lc_id, 'agent', r.agent_name, 'company', r.company_name);
end; $function$;

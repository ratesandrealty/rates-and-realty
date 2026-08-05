-- hoi_quote_log(p_contact_id uuid, p_vendor_id uuid, p_company text, p_agent_name text, p_agent_email text, p_agent_phone text, p_subject text, p_body text, p_agent_first text, p_agent_last text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.hoi_quote_log(p_contact_id uuid, p_vendor_id uuid, p_company text, p_agent_name text, p_agent_email text, p_agent_phone text, p_subject text, p_body text, p_agent_first text DEFAULT NULL::text, p_agent_last text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_first text; v_last text; v_full text;
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only'; end if;
  -- prefer explicit first/last; else derive from combined name
  v_first := coalesce(nullif(trim(coalesce(p_agent_first,'')),''), split_part(coalesce(p_agent_name,''),' ',1));
  v_last  := coalesce(nullif(trim(coalesce(p_agent_last,'')),''),
             nullif(trim(substr(coalesce(p_agent_name,''), length(split_part(coalesce(p_agent_name,''),' ',1))+1)),''));
  v_full  := coalesce(nullif(trim(coalesce(p_agent_name,'')),''), nullif(trim(coalesce(v_first,'')||' '||coalesce(v_last,'')),''));
  insert into public.hoi_quote_requests(contact_id, vendor_id, company_name, agent_name, agent_first_name, agent_last_name, agent_email, agent_phone, subject, body, status)
  values (p_contact_id, p_vendor_id, p_company, v_full, nullif(v_first,''), v_last, p_agent_email, p_agent_phone, p_subject, p_body, 'sent')
  returning id into v_id;
  return v_id;
end; $function$;

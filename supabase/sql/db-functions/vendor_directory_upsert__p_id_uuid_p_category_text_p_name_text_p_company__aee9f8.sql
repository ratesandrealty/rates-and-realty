-- vendor_directory_upsert(p_id uuid, p_category text, p_name text, p_company text, p_phone text, p_email text, p_website text, p_notes text, p_role text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.vendor_directory_upsert(p_id uuid, p_category text, p_name text, p_company text, p_phone text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_website text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_role text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_name text; v_email text; v_role text; v_cat text; v_first text; v_last text; v_dupe uuid;
begin
  if auth.role() is null then raise exception 'not authenticated'; end if;
  v_name  := nullif(trim(coalesce(p_name,'')),'');
  v_email := nullif(lower(trim(coalesce(p_email,''))),'');
  -- role comes from p_role if given, else p_category (this overload historically used category as the role)
  v_role  := public.vendor_canonical_role(coalesce(nullif(trim(coalesce(p_role,'')),''), p_category));
  v_cat   := case lower(trim(coalesce(coalesce(nullif(p_role,''),p_category),'')))
               when 'title' then 'title' when 'title_officer' then 'title'
               when 'escrow' then 'escrow' when 'escrow_officer' then 'escrow'
               when 'appraisal' then 'appraisal' when 'appraiser' then 'appraisal'
               when 'hoi' then 'hoi' when 'hoi_agent' then 'hoi' else null end;
  v_first := split_part(coalesce(v_name,''),' ',1);
  v_last  := nullif(trim(substr(coalesce(v_name,''), length(split_part(coalesce(v_name,''),' ',1))+1)),'');

  if p_id is not null then
    update public.vendor_directory set
      role=coalesce(v_role,role), category=coalesce(v_cat,category), name=coalesce(v_name,name),
      first_name=nullif(v_first,''), last_name=v_last, company=p_company, phone=p_phone,
      email=coalesce(p_email,email), website=p_website, notes=coalesce(p_notes,notes), updated_at=now()
    where id=p_id returning id into v_id;
    return v_id;
  end if;

  select id into v_dupe from public.vendor_directory
    where public.vendor_canonical_role(role) is not distinct from v_role
      and ((v_email is not null and lower(email)=v_email)
        or (v_email is null and lower(coalesce(name,''))=lower(coalesce(v_name,''))
            and lower(coalesce(company,''))=lower(coalesce(p_company,''))))
    limit 1;
  if v_dupe is not null then
    update public.vendor_directory set
      role=coalesce(v_role,role), category=coalesce(v_cat,category), name=coalesce(v_name,name),
      first_name=nullif(v_first,''), last_name=v_last, company=coalesce(p_company,company),
      phone=coalesce(p_phone,phone), email=coalesce(p_email,email), website=coalesce(p_website,website),
      notes=coalesce(p_notes,notes), usage_count=coalesce(usage_count,0)+1, last_used_at=now(), updated_at=now()
    where id=v_dupe returning id into v_id;
    return v_id;
  end if;

  insert into public.vendor_directory(role, category, name, first_name, last_name, company, phone, email, website, notes, usage_count, last_used_at)
  values (v_role, v_cat, v_name, nullif(v_first,''), v_last, p_company, p_phone, p_email, p_website, p_notes, 1, now())
  returning id into v_id;
  return v_id;
end; $function$;

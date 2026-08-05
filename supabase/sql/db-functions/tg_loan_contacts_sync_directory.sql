-- tg_loan_contacts_sync_directory()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.tg_loan_contacts_sync_directory()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r_role text;
  r_name text;
  r_company text;
  r_phone text;
  r_email text;
  r_website text;
  v_id uuid;
  v_count int;
begin
  if tg_op = 'DELETE' then
    r_role    := old.role;
    r_email   := nullif(lower(trim(coalesce(old.email,''))),'');
    r_name    := nullif(trim(coalesce(old.name,'')),'');
    r_company := nullif(trim(coalesce(old.company,'')),'');

    select v.id into v_id from vendor_directory v
      where v.role = r_role
        and ((r_email is not null and lower(coalesce(v.email,'')) = r_email)
             or (r_email is null
                 and lower(coalesce(v.name,''))    = lower(coalesce(r_name,''))
                 and lower(coalesce(v.company,'')) = lower(coalesce(r_company,''))))
      order by v.usage_count desc, v.created_at asc limit 1;

    if v_id is not null then
      select count(distinct lc.contact_id) into v_count from loan_contacts lc
        where lc.role = r_role
          and ((r_email is not null and lower(coalesce(lc.email,'')) = r_email)
               or (r_email is null
                   and lower(coalesce(lc.name,''))    = lower(coalesce(r_name,''))
                   and lower(coalesce(lc.company,'')) = lower(coalesce(r_company,''))));
      update vendor_directory set usage_count = coalesce(v_count,0), updated_at = now() where id = v_id;
    end if;
    return old;
  end if;

  r_role    := new.role;
  r_name    := nullif(trim(coalesce(new.name,'')),'');
  r_company := nullif(trim(coalesce(new.company,'')),'');
  r_phone   := nullif(trim(coalesce(new.phone,'')),'');
  r_email   := nullif(trim(coalesce(new.email,'')),'');
  r_website := nullif(trim(coalesce(new.website,'')),'');

  -- Nothing worth remembering on a blank row
  if r_name is null and r_company is null and r_email is null then
    return new;
  end if;

  select v.id into v_id from vendor_directory v
    where v.role = r_role
      and ((r_email is not null and lower(coalesce(v.email,'')) = lower(r_email))
           or (r_email is null
               and lower(coalesce(v.name,''))    = lower(coalesce(r_name,''))
               and lower(coalesce(v.company,'')) = lower(coalesce(r_company,''))))
    order by v.usage_count desc, v.created_at asc limit 1;

  if v_id is null then
    insert into vendor_directory(role,name,company,phone,email,website,usage_count,last_used_at,created_by,created_at,updated_at)
    values (r_role,r_name,r_company,r_phone,r_email,r_website,1,now(),auth.uid(),now(),now())
    returning id into v_id;
  else
    update vendor_directory set
      name         = coalesce(r_name, name),
      company      = coalesce(r_company, company),
      phone        = coalesce(r_phone, phone),
      email        = coalesce(r_email, email),
      website      = coalesce(r_website, website),
      last_used_at = now(),
      updated_at   = now()
    where id = v_id;
  end if;

  select count(distinct lc.contact_id) into v_count from loan_contacts lc
    where lc.role = r_role
      and ((r_email is not null and lower(coalesce(lc.email,'')) = lower(r_email))
           or (r_email is null
               and lower(coalesce(lc.name,''))    = lower(coalesce(r_name,''))
               and lower(coalesce(lc.company,'')) = lower(coalesce(r_company,''))));
  update vendor_directory set usage_count = greatest(coalesce(v_count,1),1) where id = v_id;

  return new;
end;
$function$;

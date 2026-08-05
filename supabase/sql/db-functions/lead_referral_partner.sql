-- lead_referral_partner(p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.lead_referral_partner(p_contact_id uuid)
 RETURNS TABLE(partner_id uuid, partner_name text, partner_email text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.role() = 'authenticated'
     and not (public.is_admin() or coalesce(public.current_app_role(),'') in ('admin','va','loa','agent','lender','staff'))
  then
    raise exception 'not authorized';
  end if;

  return query
  select rp.id,
         nullif(trim(coalesce(rp.first_name,'')||' '||coalesce(rp.last_name,'')),''),
         rp.email
  from contacts c
  join referral_partners rp on rp.id = c.referral_partner_id
  where c.id = p_contact_id
    and rp.email is not null and rp.email <> '';
end;
$function$;

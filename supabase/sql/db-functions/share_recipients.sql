-- share_recipients(p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.share_recipients(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v jsonb; v_b jsonb; v_p jsonb;
begin
  v_role := coalesce(public.current_app_role(),'');
  if not (public.is_admin() or v_role in ('va','loa','agent','staff')) then
    raise exception 'not authorized';
  end if;

  -- borrower
  select jsonb_build_object(
           'kind','borrower',
           'name', nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
           'email', nullif(trim(coalesce(c.email,'')),''),
           'phone', nullif(trim(coalesce(c.phone,'')),''))
    into v_b from contacts c where c.id = p_contact_id;

  -- attached realtor / referral partner
  select jsonb_build_object(
           'kind','partner',
           'name', nullif(trim(coalesce(rp.first_name,'')||' '||coalesce(rp.last_name,'')),''),
           'company', nullif(trim(coalesce(rp.company,'')),''),
           'email', nullif(trim(coalesce(rp.email,'')),''),
           'phone', nullif(trim(coalesce(rp.phone,'')),''))
    into v_p
  from contacts c join referral_partners rp on rp.id = c.referral_partner_id
  where c.id = p_contact_id;

  v := jsonb_build_object(
         'borrower', coalesce(v_b, 'null'::jsonb),
         'partner',  coalesce(v_p, 'null'::jsonb),
         'has_partner', (v_p is not null and (v_p->>'email') is not null));
  return v;
end; $function$;

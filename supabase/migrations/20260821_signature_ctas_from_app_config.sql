-- The rows the function below resolves at render time. apply/reviews are
-- deliberately EMPTY: no live URL has been supplied and both of the ones they
-- replace are dead, so the button does not render at all until one exists.
insert into public.app_config(key, value) values
  ('cta_upload_url',   'https://documentguardian.com/filedrop/rduarte@emortgagecapital.com'),
  ('cta_schedule_url', 'https://cal.com/rene-duarte-rates-realty/30min'),
  ('cta_apply_url',    ''),
  ('cta_reviews_url',  '')
on conflict (key) do nothing;

-- email_signature_get(p_mailbox text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-21. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.email_signature_get(p_mailbox text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_html text;
  v_name text;
  v_is_service boolean := false;
  k text; v_url text;
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff'))
    then raise exception 'not authorized'; end if;

  select signature_html into v_html from email_signatures where mailbox = p_mailbox;
  if v_html is null then return ''; end if;

  select coalesce(r.is_service_account,false) into v_is_service
  from auth_user_roles r where r.user_id = auth.uid();

  if coalesce(v_is_service,false) then
    v_name := '';                       -- neither its own name nor the mailbox owner's
  else
    select btrim(coalesce(r.display_name,'')) into v_name
    from auth_user_roles r where r.user_id = auth.uid();
    if coalesce(v_name,'') = '' then
      select btrim(coalesce(r.display_name,'')) into v_name
      from auth_user_roles r join auth.users u on u.id = r.user_id
      where lower(u.email) = lower(p_mailbox);
    end if;
  end if;

  if coalesce(v_name,'') = '' then
    v_html := regexp_replace(v_html, '<!--NAME-->.*?<!--/NAME-->', '', 'gs');
  else
    v_html := replace(v_html, '{{display_name}}',
                      replace(replace(replace(v_name,'&','&amp;'),'<','&lt;'),'>','&gt;'));
    v_html := replace(replace(v_html, '<!--NAME-->', ''), '<!--/NAME-->', '');
  end if;

  -- CTA buttons: live URL -> substitute; anything else -> drop the button entirely.
  foreach k in array array['apply','upload','reviews','schedule'] loop
    select btrim(coalesce(value,'')) into v_url from app_config where key = 'cta_'||k||'_url';
    if coalesce(v_url,'') ~* '^https?://' then
      v_html := replace(v_html, '{{cta_'||k||'_url}}',
                        replace(replace(replace(v_url,'&','&amp;'),'<','&lt;'),'>','&gt;'));
      v_html := replace(replace(v_html, '<!--CTA:'||k||'-->',''), '<!--/CTA:'||k||'-->','');
    else
      v_html := regexp_replace(v_html, '<!--CTA:'||k||'-->.*?<!--/CTA:'||k||'-->', '', 'gs');
    end if;
  end loop;

  return v_html;
end;
$function$;

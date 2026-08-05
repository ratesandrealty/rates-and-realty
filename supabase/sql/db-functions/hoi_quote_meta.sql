-- hoi_quote_meta()
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.hoi_quote_meta()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'cc', coalesce((select value from public.app_config where key='hoi_quote_cc'), 'rene@ratesandrealty.com,processing@ratesandrealty.com'),
    'signature', (select jsonb_build_object(
        'name', signature_name, 'title', signature_title, 'phone', signature_phone,
        'nmls', signature_nmls, 'dre', signature_dre, 'email', signature_email,
        'website', signature_website, 'custom_html', signature_custom_html)
      from public.email_settings limit 1)
  );
$function$;

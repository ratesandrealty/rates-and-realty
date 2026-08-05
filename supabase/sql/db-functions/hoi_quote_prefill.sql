-- hoi_quote_prefill(p_contact_id uuid)
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.hoi_quote_prefill(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'borrower_first', c.first_name,
    'borrower_last', c.last_name,
    'borrower_full', nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
    'address', coalesce(c.property_address, c.address),
    'city', coalesce(c.property_city, c.city),
    'state', coalesce(c.property_state, c.state),
    'zip', coalesce(c.property_zip, c.zip),
    'purchase_price', coalesce(c.purchase_price, c.property_value),
    'date_of_birth', c.date_of_birth
  )
  from public.contacts c where c.id = p_contact_id;
$function$;

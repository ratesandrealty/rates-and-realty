-- hoi_quote_prefill(p_contact_id uuid)
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.hoi_quote_prefill(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.contacts;
begin
  /* STAFF ONLY. SECURITY DEFINER bypasses RLS and every mask, and this returns
     a named borrower's DATE OF BIRTH, email and phone for ANY contact id.
     Borrowers hold portal accounts, so without this any signed-in borrower —
     and, because anon held EXECUTE, anyone at all with the public anon key —
     could read another borrower's DOB by guessing a uuid. */
  perform public.require_staff_rpc('Borrower contact details');
  select * into c from public.contacts where id = p_contact_id;
  return jsonb_build_object(
    'borrower_first', c.first_name,
    'borrower_last', c.last_name,
    'borrower_full', nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
    /* THE DOUBLED ADDRESS, fixed at its source — property_address is a Google
       Places FORMATTED address, already complete; contacts.address is a bare
       street that needs city/state/zip appended. Returned distinctly so the
       join can choose instead of guess. */
    'address_full', nullif(trim(coalesce(c.property_address,'')),''),
    'address_street', nullif(trim(coalesce(c.address,'')),''),
    'address', coalesce(c.property_address, c.address),
    'city', coalesce(c.property_city, c.city),
    'state', coalesce(c.property_state, c.state),
    'zip', coalesce(c.property_zip, c.zip),
    'purchase_price', coalesce(c.purchase_price, c.property_value),
    'date_of_birth', c.date_of_birth,
    -- Rene confirms borrowers consent to their information being shared with
    -- HOI agencies before any request goes out.
    'borrower_email', c.email,
    'borrower_phone', c.phone
  );
end $function$;

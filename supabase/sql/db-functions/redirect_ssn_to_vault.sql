-- redirect_ssn_to_vault()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.redirect_ssn_to_vault()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ssn text := nullif(NEW.ssn, '');
  v_cob text := nullif(NEW.co_borrower_ssn, '');
  v_xml_has_ssn boolean := NEW.mismo_raw_xml is not null
    and NEW.mismo_raw_xml ~ '<TaxpayerIdentifierValue>[0-9]{9}</TaxpayerIdentifierValue>';
begin
  if v_ssn is not null or v_cob is not null or v_xml_has_ssn then
    insert into public.application_ssn (application_id, contact_id, ssn, co_borrower_ssn, mismo_raw_xml, updated_at)
    values (NEW.id, NEW.contact_id, v_ssn, v_cob,
            case when v_xml_has_ssn then NEW.mismo_raw_xml else null end, now())
    on conflict (application_id) do update set
      ssn             = coalesce(excluded.ssn,             public.application_ssn.ssn),
      co_borrower_ssn = coalesce(excluded.co_borrower_ssn, public.application_ssn.co_borrower_ssn),
      mismo_raw_xml   = coalesce(excluded.mismo_raw_xml,   public.application_ssn.mismo_raw_xml),
      contact_id      = coalesce(excluded.contact_id,      public.application_ssn.contact_id),
      updated_at      = now();

    NEW.ssn := null;
    NEW.co_borrower_ssn := null;
    if v_xml_has_ssn then
      NEW.mismo_raw_xml := public.scrub_ssn_xml(NEW.mismo_raw_xml);
    end if;
  end if;
  return NEW;
end; $function$;

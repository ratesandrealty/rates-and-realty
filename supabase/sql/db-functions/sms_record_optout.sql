-- sms_record_optout(p_phone text, p_source text, p_body text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.sms_record_optout(p_phone text, p_source text, p_body text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_norm text; v_contacts int;
begin
  v_norm := public.sms_norm_phone(p_phone);
  if length(v_norm) < 10 then
    return jsonb_build_object('ok', false, 'error', 'unusable phone', 'phone', p_phone);
  end if;
  insert into public.sms_suppressions(phone, raw_phone, source, raw_body)
  values (v_norm, p_phone, coalesce(p_source,'unknown'), left(coalesce(p_body,''), 500))
  on conflict (phone) do nothing;

  update public.contacts
     set sms_opt_in = false, updated_at = now()
   where sms_opt_in is distinct from false
     and (public.sms_norm_phone(phone) = v_norm or public.sms_norm_phone(secondary_phone) = v_norm);
  get diagnostics v_contacts = row_count;
  return jsonb_build_object('ok', true, 'phone', v_norm, 'contacts_updated', v_contacts);
end $function$;

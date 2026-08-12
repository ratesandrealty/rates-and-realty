-- set_recording_consent(p_contact_id uuid, p_method text, p_at timestamp with time zone)
-- language: plpgsql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public.set_recording_consent(p_contact_id uuid, p_method text DEFAULT NULL::text, p_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* `by` is stamped from auth.uid() SERVER-SIDE and cannot be supplied by the
   caller — a client-set attester is not an attestation. Clearing is allowed:
   a consent recorded in error must be removable, and a setter that only ever
   writes is how a wrong record becomes permanent. */
declare v_role text; v_at timestamptz; v_row public.contacts;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;

  if p_method is null then
    update public.contacts
       set recording_consent_at = null, recording_consent_method = null, recording_consent_by = null
     where id = p_contact_id returning * into v_row;
  else
    if p_method not in ('verbal_intake','signed','portal') then
      raise exception 'unknown consent method: %', p_method;
    end if;
    v_at := coalesce(p_at, now());
    if v_at > now() + interval '1 day' then
      raise exception 'consent date is in the future';
    end if;
    update public.contacts
       set recording_consent_at = v_at, recording_consent_method = p_method, recording_consent_by = auth.uid()
     where id = p_contact_id returning * into v_row;
  end if;

  if v_row.id is null then raise exception 'no such contact'; end if;
  return jsonb_build_object(
    'contact_id', v_row.id,
    'recording_consent_at', v_row.recording_consent_at,
    'recording_consent_method', v_row.recording_consent_method);
end; $function$;

-- sms_blast(p_contact_ids uuid[], p_body text, p_media_url text, p_send_at timestamp with time zone)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.sms_blast(p_contact_ids uuid[], p_body text, p_media_url text DEFAULT NULL::text, p_send_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text; v_send_at timestamptz;
  v_queued int := 0; v_optout int := 0; v_nophone int := 0; v_noconsent int := 0;
  r record; v_digits text; v_require_consent boolean := false; v_cfg text;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  if coalesce(trim(p_body),'') = '' then raise exception 'message body required'; end if;
  if p_contact_ids is null or array_length(p_contact_ids,1) is null then raise exception 'no recipients'; end if;
  v_send_at := coalesce(p_send_at, now());

  select value into v_cfg from app_config where key = 'sms_blast_require_consent';
  v_require_consent := (lower(coalesce(trim(both '"' from coalesce(v_cfg,'')), '')) = 'true');

  for r in
    select c.id, c.phone, c.secondary_phone, c.sms_opt_in, c.sms_consent_at,
           exists(select 1 from public.sms_log s where s.contact_id = c.id and s.direction = 'inbound') as has_inbound
    from public.contacts c where c.id = any(p_contact_ids)
  loop
    -- Both lists, via the shared predicate.
    if public.is_phone_suppressed(coalesce(nullif(trim(r.phone),''), r.secondary_phone), r.id) then
      v_optout := v_optout + 1; continue;
    end if;
    if v_require_consent and r.sms_consent_at is null and not r.has_inbound then
      v_noconsent := v_noconsent + 1; continue;
    end if;
    v_digits := regexp_replace(coalesce(nullif(trim(r.phone),''), r.secondary_phone, ''), '\D', '', 'g');
    if length(v_digits) < 10 then v_nophone := v_nophone + 1; continue; end if;

    insert into public.sms_log(contact_id, to_phone, body, media_url, direction, status,
                               scheduled_at, trigger_type, created_at)
    values(r.id,
           case when length(v_digits)=10 then '+1'||v_digits
                when length(v_digits)=11 and left(v_digits,1)='1' then '+'||v_digits
                else '+'||v_digits end,
           p_body, p_media_url, 'outbound', 'scheduled', v_send_at, 'blast', now());
    v_queued := v_queued + 1;
  end loop;

  return jsonb_build_object('queued', v_queued, 'skipped_optout', v_optout, 'skipped_nophone', v_nophone,
    'skipped_no_consent', v_noconsent, 'consent_required', v_require_consent,
    'total', array_length(p_contact_ids,1), 'send_at', v_send_at);
end; $function$;

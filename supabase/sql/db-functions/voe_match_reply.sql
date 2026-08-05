-- voe_match_reply(p_from_email text, p_to_email text, p_cc_email text, p_subject text, p_body text, p_reply_token text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.voe_match_reply(p_from_email text DEFAULT NULL::text, p_to_email text DEFAULT NULL::text, p_cc_email text DEFAULT NULL::text, p_subject text DEFAULT NULL::text, p_body text DEFAULT NULL::text, p_reply_token text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_token text;
  v_order_id uuid;
  v_contact_id uuid;
  v_matched_by text := 'unmatched';
  v_haystack text;
begin
  -- 1) Resolve the reply token. Prefer an explicitly parsed token, else scan
  --    the addressing fields, subject and body for a voe_<32hex> marker
  --    (format emitted by voe_request_log: 'voe_'||32 hex chars).
  v_token := nullif(trim(p_reply_token), '');
  if v_token is null then
    v_haystack := concat_ws(' ', p_to_email, p_cc_email, p_subject, p_body);
    v_token := (regexp_match(v_haystack, 'voe_[0-9a-f]{32}'))[1];
  end if;

  -- 2) Primary match: token -> loan_orders.voe_reply_token
  if v_token is not null then
    select id, contact_id into v_order_id, v_contact_id
    from public.loan_orders
    where voe_reply_token = v_token
    order by ordered_at desc nulls last
    limit 1;
    if v_order_id is not null then
      v_matched_by := 'token';
    end if;
  end if;

  -- 3) Fallback match: HR sender address -> most recent VOE order for that HR
  if v_order_id is null and nullif(trim(p_from_email),'') is not null then
    select id, contact_id into v_order_id, v_contact_id
    from public.loan_orders
    where order_type = 'voe'
      and lower(hr_contact_email) = lower(trim(p_from_email))
    order by ordered_at desc nulls last
    limit 1;
    if v_order_id is not null then
      v_matched_by := 'hr_email';
    end if;
  end if;

  return jsonb_build_object(
    'order_id',   v_order_id,
    'contact_id', v_contact_id,
    'reply_token', v_token,
    'matched_by', v_matched_by
  );
end;
$function$;

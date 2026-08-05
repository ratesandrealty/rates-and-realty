-- voe_activity(p_order_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.voe_activity(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_order public.loan_orders; v_events jsonb;
begin
  select * into v_order from public.loan_orders where id = p_order_id;
  if v_order.id is null then return jsonb_build_object('events', '[]'::jsonb); end if;

  with hr_meta as (
    -- one row per HR email used across this contact's VOE orders -> label source
    select lower(trim(hr_contact_email)) as hr_key,
           nullif(max(hr_contact_name), '') as hr_name,
           nullif(max(employer_name), '')   as employer
    from public.loan_orders
    where contact_id = v_order.contact_id and order_type = 'voe'
      and hr_contact_email is not null and trim(hr_contact_email) <> ''
    group by lower(trim(hr_contact_email))
  ),
  matched as (
    select el.id, el.direction, el.from_email, el.to_email, el.subject,
           el.created_at, el.status,
           (el.body_html is not null or el.body_text is not null) as has_body,
           el.body_text, el.body_html,
           -- group key = the HR counterparty email (recipient on sent, sender on received)
           lower((regexp_match(
                    case when el.direction = 'outbound' then el.to_email else el.from_email end,
                    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+'))[1]) as hr_key,
           extract(epoch from el.created_at)
             - lag(extract(epoch from el.created_at)) over (
                 partition by el.direction, lower(coalesce(el.to_email,'')), coalesce(el.subject,'')
                 order by el.created_at) as gap_secs
    from public.email_log el
    where el.contact_id = v_order.contact_id
      and (el.template = 'voe_request'
           or el.subject ilike '%verification of employment%'
           or el.subject ilike '%VOE%')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id,
      'direction', m.direction,
      'from', m.from_email,
      'to', m.to_email,
      'subject', m.subject,
      'at', m.created_at,
      'status', m.status,
      'has_body', m.has_body,
      'thread_key', m.hr_key,
      'thread_label', coalesce(hm.hr_name, hm.employer, m.hr_key, 'Unknown'),
      'preview', nullif(trim(left(
          regexp_replace(
            regexp_replace(
              regexp_replace(coalesce(m.body_text, m.body_html, ''), '<[^>]+>', ' ', 'g'),
              '\[(image|cid|https?)[^\]]*\]', ' ', 'gi'),
            '\s+', ' ', 'g'
          ), 160)), '')
    ) order by m.created_at desc), '[]'::jsonb)
  into v_events
  from matched m
  left join hr_meta hm on hm.hr_key = m.hr_key
  where m.gap_secs is null or m.gap_secs >= 15;

  return jsonb_build_object(
    'order_id', p_order_id, 'status', v_order.status, 'employer', v_order.employer_name,
    'hr_name', v_order.hr_contact_name, 'hr_email', v_order.hr_contact_email,
    'ordered_at', v_order.ordered_at, 'received_at', v_order.received_at,
    'last_follow_up_at', v_order.last_follow_up_at, 'reply_token', v_order.voe_reply_token,
    'events', v_events);
end; $function$;

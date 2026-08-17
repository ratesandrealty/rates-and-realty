-- voe_activity: scope to the ORDER, and stop matching "VOE" as a substring.
--
-- REVERT: re-apply the 2026-08-05 capture in supabase/sql/db-functions/voe_activity.sql.
--
-- ══ TWO INDEPENDENT FAULTS, ONE WHERE CLAUSE ══
--
-- 1. `subject ilike '%VOE%'` IS A SUBSTRING MATCH. It matched
--    "Professional Pro Plus – a WVOE Program Enhancement!" — a lender marketing
--    blast — because WVOE contains VOE. A marketing email was rendering on a
--    compliance panel. Dropped entirely: template='voe_request' and the full
--    phrase 'verification of employment' are what identify these messages, and
--    both are precise.
--
-- 2. IT SELECTED BY CONTACT, NOT BY ORDER. p_order_id was used only to look up
--    the contact and to label threads, so every VOE-ish message on the CONTACT
--    appeared on EVERY order of that contact — and, with email_log
--    over-attributed, on a contact the mail never belonged to. Measured: the
--    thread "Re: Verification of Employment Request — Rafael Hernandez Andrade"
--    was rendering on Rene Duarte's order. That is one borrower's employment
--    verification displayed on another borrower's record.
--
-- ══ HOW AN ORDER IS NOW EXPRESSED ══
--
--   a) same Gmail thread as the request we sent (gmail_thread_id), for anything
--      sent through the new path — exact, and independent of attribution
--   b) failing that, this order's OWN HR counterparty address on this contact
--
-- (b) still leans on contact_id, so it inherits attribution for legacy rows —
-- but it is narrowed by the order's HR address, which is what separates two
-- orders on one contact and what excludes another borrower's thread. The
-- marketing blast was addressed to this order's HR address, so (b) alone would
-- not have excluded it; fault 1 is what removes it. THE TWO FIXES ARE
-- INDEPENDENT AND BOTH ARE NEEDED.
--
-- Neither depends on detaching the historical email_log rows. Scoping stops the
-- leak on its own; the detach is a separate cleanup.

CREATE OR REPLACE FUNCTION public.voe_activity(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_order public.loan_orders; v_events jsonb; v_hr text;
begin
  select * into v_order from public.loan_orders where id = p_order_id;
  if v_order.id is null then return jsonb_build_object('events', '[]'::jsonb); end if;

  v_hr := lower(nullif(trim(coalesce(v_order.hr_contact_email, '')), ''));

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
           lower((regexp_match(
                    case when el.direction = 'outbound' then el.to_email else el.from_email end,
                    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+'))[1]) as hr_key,
           extract(epoch from el.created_at)
             - lag(extract(epoch from el.created_at)) over (
                 partition by el.direction, lower(coalesce(el.to_email,'')), coalesce(el.subject,'')
                 order by el.created_at) as gap_secs
    from public.email_log el
    where
      (
        /* (a) the thread Gmail itself grouped around our request. Exact, and it
           does not consult contact_id at all, so it is immune to attribution. */
        (v_order.gmail_thread_id is not null and el.gmail_thread_id = v_order.gmail_thread_id)
        or
        /* (b) legacy fallback: this order's own HR counterparty on this contact.
           Narrower than "the contact's mail" — it is what distinguishes two
           orders on one contact, and what keeps another borrower's VOE thread
           off this order. */
        (v_hr is not null
         and el.contact_id = v_order.contact_id
         and (lower(coalesce(el.to_email,'')) = v_hr
              or lower(coalesce(el.from_email,'')) = v_hr
              or position(v_hr in lower(coalesce(el.to_emails::text,''))) > 0
              or position(v_hr in lower(coalesce(el.cc_email,''))) > 0))
      )
      /* NO '%VOE%'. It is a substring and matched WVOE in a marketing subject.
         template and the full phrase are precise; nothing else identifies a VOE
         message, and a looser net on a compliance panel is how a lender blast
         ended up beside borrower correspondence. */
      and (el.template = 'voe_request'
           or el.subject ilike '%verification of employment%')
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

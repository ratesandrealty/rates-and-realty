-- voe_activity: render the replies the poller correlated.
--
-- REVERT: re-apply 20260817h.
--
-- ══ THE MISSING LINK ══
--
-- quote-reply-poll writes to quote_reply_log and touches nothing else — that was
-- deliberate, so a poller could never mutate borrower records on a guess. But
-- voe_activity reads email_log, so a reply could be correlated to an order and
-- still be invisible on that order's panel. Verified before writing this:
-- quote-reply-poll contains no reference to email_log at all.
--
-- The chain was send -> store ids -> reply -> poll -> correlate -> (nothing).
-- This is the last hop.
--
-- ══ WHY UNION AND NOT A WRITE INTO email_log ══
--
-- Copying poller output into email_log would make the poller a writer of the
-- table the CRM treats as its mail record, on the strength of a match. The match
-- is good — In-Reply-To against an id we stored — but it is still an inference,
-- and email_log is what the timeline, lead scoring, open counters and reminder
-- evidence all read. quote_reply_log stays the poller's own record; this reads
-- across at display time, where a wrong match costs a wrong row on a panel
-- rather than a wrong row in the system of record.
--
-- Rows carry 'source' so the two origins stay distinguishable on screen instead
-- of silently blending.
--
-- Scoped by row_id = p_order_id, which is the ORDER, not the contact — the same
-- correction 20260817h made to the email_log side.

CREATE OR REPLACE FUNCTION public.voe_activity(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Order-scoped VOE activity, from two sources.

   email_log        what we sent, and legacy correspondence, matched by the
                    Gmail thread our request created or by this order's own HR
                    counterparty. Never by '%VOE%' — that is a substring and
                    matched a "WVOE" marketing blast onto a compliance panel.
   quote_reply_log  replies quote-reply-poll correlated to THIS order.

   The second source exists because the poller writes only its own table, by
   design, so a correlated reply was invisible here. Read across at display time
   rather than copied into email_log: the match is an inference, and email_log
   feeds the timeline, lead scoring, open counters and reminder evidence. A wrong
   match should cost a row on a panel, not a row in the system of record. */
declare v_order public.loan_orders; v_events jsonb; v_hr text;
begin
  select * into v_order from public.loan_orders where id = p_order_id;
  if v_order.id is null then return jsonb_build_object('events', '[]'::jsonb); end if;

  v_hr := lower(nullif(trim(coalesce(v_order.hr_contact_email, '')), ''));

  with hr_meta as (
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
        (v_order.gmail_thread_id is not null and el.gmail_thread_id = v_order.gmail_thread_id)
        or
        (v_hr is not null
         and el.contact_id = v_order.contact_id
         and (lower(coalesce(el.to_email,'')) = v_hr
              or lower(coalesce(el.from_email,'')) = v_hr
              or position(v_hr in lower(coalesce(el.to_emails::text,''))) > 0
              or position(v_hr in lower(coalesce(el.cc_email,''))) > 0))
      )
      and (el.template = 'voe_request'
           or el.subject ilike '%verification of employment%')
  ),
  from_log as (
    select m.id::text            as ev_id,
           m.direction           as ev_direction,
           m.from_email          as ev_from,
           m.to_email            as ev_to,
           m.subject             as ev_subject,
           m.created_at          as ev_at,
           m.status              as ev_status,
           m.has_body            as ev_has_body,
           m.hr_key              as ev_thread_key,
           coalesce(hm.hr_name, hm.employer, m.hr_key, 'Unknown') as ev_thread_label,
           nullif(trim(left(
             regexp_replace(
               regexp_replace(
                 regexp_replace(coalesce(m.body_text, m.body_html, ''), '<[^>]+>', ' ', 'g'),
                 '\[(image|cid|https?)[^\]]*\]', ' ', 'gi'),
               '\s+', ' ', 'g'
             ), 160)), '')       as ev_preview,
           'email_log'::text     as ev_source,
           null::text            as ev_matched_by
    from matched m
    left join hr_meta hm on hm.hr_key = m.hr_key
    where m.gap_secs is null or m.gap_secs >= 15
  ),
  from_replies as (
    select q.id::text,
           'inbound'::text,
           q.from_email,
           q.to_email,
           q.subject,
           coalesce(q.received_at, q.created_at),
           'received'::text,
           (nullif(trim(coalesce(q.snippet, '')), '') is not null),
           lower(coalesce(q.from_email, '')),
           coalesce(nullif(trim(coalesce(q.from_email, '')), ''), 'Unknown'),
           nullif(trim(left(regexp_replace(coalesce(q.snippet, ''), '\s+', ' ', 'g'), 160)), ''),
           'quote_reply_log'::text,
           q.matched_by
    from public.quote_reply_log q
    where q.kind = 'voe' and q.row_id = p_order_id
  ),
  all_events as (
    select * from from_log
    union all
    select * from from_replies
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', ev_id,
      'direction', ev_direction,
      'from', ev_from,
      'to', ev_to,
      'subject', ev_subject,
      'at', ev_at,
      'status', ev_status,
      'has_body', ev_has_body,
      'thread_key', ev_thread_key,
      'thread_label', ev_thread_label,
      'preview', ev_preview,
      'source', ev_source,
      'matched_by', ev_matched_by
    ) order by ev_at desc), '[]'::jsonb)
  into v_events
  from all_events;

  return jsonb_build_object(
    'order_id', p_order_id, 'status', v_order.status, 'employer', v_order.employer_name,
    'hr_name', v_order.hr_contact_name, 'hr_email', v_order.hr_contact_email,
    'ordered_at', v_order.ordered_at, 'received_at', v_order.received_at,
    'last_follow_up_at', v_order.last_follow_up_at, 'reply_token', v_order.voe_reply_token,
    'events', v_events);
end; $function$;

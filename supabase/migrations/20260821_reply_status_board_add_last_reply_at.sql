-- reply_status_board()
-- language: sql
-- Captured from production 2026-08-21.

CREATE OR REPLACE FUNCTION public.reply_status_board()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with rows_all as (
    select 'hoi'::text as family,
           r.id, r.contact_id, r.agent_email as counterparty, r.sent_at,
           (r.gmail_thread_id is not null or r.rfc_message_id is not null) as has_send_record,
           (select count(*) from quote_reply_log q where q.kind='hoi' and q.row_id = r.id) as correlated
    from hoi_quote_requests r
    where r.archived_at is null
    union all
    select 'voe',
           o.id, o.contact_id, o.hr_contact_email, o.ordered_at,
           (o.gmail_message_id is not null or o.rfc_message_id is not null),
           (select count(*) from quote_reply_log q where q.kind='voe' and q.row_id = o.id)
    from loan_orders o
    where o.order_type = 'voe'
  ), scored as (
    select a.*,
           trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) as borrower,
           case when a.correlated > 0      then 'replied'
                when not a.has_send_record then 'cannot_correlate'
                else 'awaiting' end as state,
           (select count(*) from quote_reply_log q
             where a.counterparty is not null
               and lower(q.from_email) = lower(a.counterparty)
               and q.matched_by = 'unmatched') as heard_from_them,
           (select max(q.received_at) from quote_reply_log q
             where a.counterparty is not null
               and lower(q.from_email) = lower(a.counterparty)
               and q.matched_by = 'unmatched') as heard_from_them_at,
           /* WHEN the correlated reply actually landed. "Replied" with no date is
              not actionable — it does not say whether the answer arrived an hour
              ago or in May. Same source as `correlated`, so a row can never read
              replied while this is null. Distinct from heard_from_them_at, which
              is the UNLINKED signal and says nothing about this request. */
           (select max(q.received_at) from quote_reply_log q
             where q.kind = a.family and q.row_id = a.id) as last_reply_at,
           case when a.sent_at is not null
                then floor(extract(epoch from (now() - a.sent_at)) / 86400)::int end as days_since_send
    from rows_all a
    left join contacts c on c.id = a.contact_id
  )
  select jsonb_build_object(
    'counts', jsonb_build_object(
      'total',             (select count(*) from scored),
      'replied',           (select count(*) from scored where state='replied'),
      'awaiting',          (select count(*) from scored where state='awaiting'),
      'cannot_correlate',  (select count(*) from scored where state='cannot_correlate'),
      'can_resolve',       (select count(*) from scored where state <> 'cannot_correlate'),
      'heard_but_unlinked',(select count(*) from scored where state <> 'replied' and heard_from_them > 0),
      'archived_excluded', (select count(*) from hoi_quote_requests where archived_at is not null),
      'last_reply_at',     (select max(last_reply_at) from scored where state='replied')
    ),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'family', family, 'id', id, 'contact_id', contact_id,
               'borrower', nullif(borrower,''), 'counterparty', counterparty,
               'state', state, 'days_since_send', days_since_send,
               'heard_from_them', heard_from_them,
               'heard_from_them_at', heard_from_them_at,
               'last_reply_at', last_reply_at)
             /* REPLIED FIRST. It used to be `(state='replied')` ascending, and
                false sorts before true, so the one row anybody would act on sat
                at the BOTTOM of the list under fifteen greyed-out ones. The
                headline still leads with the 15 — that is the finding — but the
                rows lead with the answer that arrived. */
             order by (state='replied') desc,
                      (state='cannot_correlate'),
                      days_since_send desc nulls last)
      from scored), '[]'::jsonb)
  );
$function$;

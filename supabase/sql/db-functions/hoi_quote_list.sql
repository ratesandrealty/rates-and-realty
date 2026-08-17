-- hoi_quote_list(p_contact_id uuid)
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-17. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.hoi_quote_list(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  /* Each quote request with its ACTIVITY: the send, anything Gmail grouped into
     that thread, and the replies quote-reply-poll correlated to this request.

     The outbound was always recorded — gmail-inbox's send writes email_log the
     same way it does for VOE — but hoi_quote_list never read that table, so a
     request that was sent and not yet answered looked identical to one where
     nothing had happened. That is the worst of the three states to be unable to
     tell apart, because it is the one that needs chasing.

     SCOPED BY THREAD (el.gmail_thread_id = h.gmail_thread_id), so it consults no
     attribution. That matters: on the first genuine external delivery
     (rduarte89@yahoo.com, "Homeowners Insurance Quote Request - Daniel Garcia")
     matchContact left contact_id NULL, and anything keyed on the contact would
     have missed the send outright.

     Legacy requests carry no thread id and match nothing here — correct, since
     MailerSend returned no id and there is no honest way to tie them to a thread.

     NOT TWICE: voe-inbound-poll already writes inbound replies into email_log, so
     a message can genuinely be in both tables. The email_log side excludes any
     row already carried as a reply for this request. */
  select coalesce(
    jsonb_agg(s.row_json order by s.sent_at desc nulls last, s.created_at desc),
    '[]'::jsonb)
  from (
    select h.sent_at,
           h.created_at,
           to_jsonb(h) || jsonb_build_object(
             'activity',
             coalesce((
               select jsonb_agg(u.ev order by u.at desc)
               from (
                 select jsonb_build_object(
                          'id',         el.id,
                          'source',     'email_log',
                          'matched_by', null,
                          'direction',  el.direction,
                          'from',       el.from_email,
                          'to',         el.to_email,
                          'subject',    el.subject,
                          'at',         el.created_at,
                          'status',     el.status,
                          'preview',    nullif(trim(left(
                                          regexp_replace(
                                            regexp_replace(coalesce(el.body_text, el.body_html, ''),
                                                           '<[^>]+>', ' ', 'g'),
                                            '\s+', ' ', 'g'), 160)), '')
                        ) as ev,
                        el.created_at as at
                 from public.email_log el
                 where h.gmail_thread_id is not null
                   and el.gmail_thread_id = h.gmail_thread_id
                   and not exists (
                     select 1 from public.quote_reply_log q2
                     where q2.row_id = h.id
                       and q2.gmail_message_id = el.gmail_message_id
                   )
                 union all
                 select jsonb_build_object(
                          'id',         q.id,
                          'source',     'quote_reply_log',
                          'matched_by', q.matched_by,
                          'direction',  'inbound',
                          'from',       q.from_email,
                          'to',         q.to_email,
                          'subject',    q.subject,
                          'at',         coalesce(q.received_at, q.created_at),
                          'status',     'received',
                          'preview',    nullif(trim(left(
                                          regexp_replace(coalesce(q.snippet, ''), '\s+', ' ', 'g'),
                                          160)), '')
                        ) as ev,
                        coalesce(q.received_at, q.created_at) as at
                 from public.quote_reply_log q
                 where q.kind = 'hoi' and q.row_id = h.id
               ) u
             ), '[]'::jsonb)
           ) as row_json
    from public.hoi_quote_requests h
    where h.contact_id = p_contact_id
  ) s;
$function$;

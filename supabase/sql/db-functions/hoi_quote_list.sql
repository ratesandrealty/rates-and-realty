-- hoi_quote_list(p_contact_id uuid, p_include_archived boolean)
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-21. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.hoi_quote_list(p_contact_id uuid, p_include_archived boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  /* Each quote request with its ACTIVITY: the send, anything Gmail grouped into
     that thread, and the replies quote-reply-poll correlated to this request.
     Scoped by thread (el.gmail_thread_id = h.gmail_thread_id) so it consults no
     attribution. Archived rows are filtered HERE, at display, and nowhere else.
     See the migration history for the full reasoning. */
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
                          -- the join key the reader needs to scroll to this message
                          'gmail_message_id', el.gmail_message_id,
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
                          'gmail_message_id', q.gmail_message_id,
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
      and (p_include_archived or h.archived_at is null)
  ) s;
$function$;

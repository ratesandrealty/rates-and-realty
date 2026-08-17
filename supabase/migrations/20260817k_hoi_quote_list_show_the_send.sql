-- hoi_quote_list: show the SEND, not just the replies.
--
-- REVERT: re-apply 20260817j.
--
-- ══ WHY ══
--
-- 20260817j bridged quote_reply_log so a correlated reply would render. It left
-- the outbound invisible, so a request that was sent and not yet answered looked
-- identical to one where nothing happened — which is the worst of the three
-- states to be unable to distinguish, because it is the one that needs chasing.
--
-- The outbound IS recorded. gmail-inbox's send writes email_log the same way it
-- does for VOE; verified on the first genuine external delivery:
--
--   outbound  processing@ -> rduarte89@yahoo.com
--   "Homeowners Insurance Quote Request — Daniel Garcia"  sent  16:56:23
--   gmail_thread_id 1a010a720a4f4f1c   contact_id NULL
--
-- hoi_quote_list simply never read that table.
--
-- ══ SCOPED BY THREAD, WHICH IS WHY contact_id BEING NULL DOES NOT MATTER ══
--
-- el.gmail_thread_id = h.gmail_thread_id. The request stores the thread its own
-- send created, so this is an exact join to the conversation and consults no
-- attribution at all. That matters here: matchContact left contact_id NULL on the
-- row above, so anything keyed on the contact would have missed the send on the
-- very first real delivery.
--
-- Legacy requests carry no gmail_thread_id and therefore match nothing — correct,
-- since MailerSend returned no id and there is no honest way to tie those rows to
-- a thread. Their card still shows sent_at and the agent in its header.
--
-- ══ NO DOUBLE-COUNTING ══
--
-- A message could in principle be in email_log AND correlated into
-- quote_reply_log — voe-inbound-poll already writes inbound VOE replies into
-- email_log, so the shape exists. The email_log side excludes any row whose
-- gmail_message_id is already carried as a reply for this request, so the same
-- message cannot appear twice on one card wearing two sources.
--
-- `replies` becomes `activity`: one list, each entry carrying source, direction
-- and matched_by, ordered newest first — the same shape voe_activity returns.

drop function if exists public.hoi_quote_list(uuid);

create or replace function public.hoi_quote_list(p_contact_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
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
                 /* The send, and anything else Gmail grouped into its thread.
                    Joined on the thread the request's own send created, so it
                    consults no attribution — contact_id was NULL on the first
                    real delivery and a contact-keyed join would have missed it. */
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
                   /* Not twice under two sources: voe-inbound-poll already
                      writes inbound replies into email_log, so this overlap is
                      real, not theoretical. */
                   and not exists (
                     select 1 from public.quote_reply_log q2
                     where q2.row_id = h.id
                       and q2.gmail_message_id = el.gmail_message_id
                   )
                 union all
                 /* Replies the poller correlated to THIS request. */
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

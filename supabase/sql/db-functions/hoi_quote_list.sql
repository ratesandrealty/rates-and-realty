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
  /* Each quote request, carrying the replies quote-reply-poll correlated to IT.

     quote-reply-poll writes to quote_reply_log and touches nothing else, so
     before this an HOI reply could be correlated and render nowhere — the same
     gap voe_activity had until 20260817i.

     SCOPED TO THE REQUEST (q.row_id = h.id), not the contact. A contact normally
     has several requests out to several agents at once, so contact-level scoping
     would show every agent's reply on every agent's card. Same correction the VOE
     side needed.

     READ ACROSS, NOT COPIED IN: quote_reply_log stays the poller's record. A
     correlation is an inference, and hoi_quote_requests feeds the panel, the
     winner lookup and quote selection. A wrong match should cost a row on a card,
     not a row in the record. Each reply carries source and matched_by so its
     origin and the rung that matched it stay visible.

     to_jsonb(h) rather than enumerated columns, so a column added later appears
     here without anyone remembering — the failure mode of an enumerated list is
     silent omission. The single caller does `r.data || []` and iterates, and
     PostgREST returns the array either way, so the JS-side shape is unchanged. */
  select coalesce(
    jsonb_agg(s.row_json order by s.sent_at desc nulls last, s.created_at desc),
    '[]'::jsonb)
  from (
    select h.sent_at,
           h.created_at,
           to_jsonb(h) || jsonb_build_object(
             'replies',
             coalesce((
               select jsonb_agg(jsonb_build_object(
                        'id',         q.id,
                        'source',     'quote_reply_log',
                        'matched_by', q.matched_by,
                        'direction',  'inbound',
                        'from',       q.from_email,
                        'to',         q.to_email,
                        'subject',    q.subject,
                        'at',         coalesce(q.received_at, q.created_at),
                        'preview',    nullif(trim(left(
                                        regexp_replace(coalesce(q.snippet, ''), '\s+', ' ', 'g'),
                                        160)), '')
                      ) order by coalesce(q.received_at, q.created_at) desc)
               from public.quote_reply_log q
               where q.kind = 'hoi' and q.row_id = h.id
             ), '[]'::jsonb)
           ) as row_json
    from public.hoi_quote_requests h
    where h.contact_id = p_contact_id
  ) s;
$function$;

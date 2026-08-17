-- hoi_quote_list: carry the replies quote-reply-poll correlated to each request.
--
-- REVERT:
--   drop function if exists public.hoi_quote_list(uuid);
--   create or replace function public.hoi_quote_list(p_contact_id uuid)
--     returns setof hoi_quote_requests language sql stable security definer
--     set search_path to 'public' as $$
--       select * from public.hoi_quote_requests where contact_id = p_contact_id
--       order by sent_at desc nulls last, created_at desc; $$;
--
-- ══ THE SAME MISSING LINK VOE HAD ══
--
-- quote-reply-poll writes to quote_reply_log and touches nothing else. voe_activity
-- was taught to read across in 20260817i; hoi_quote_list was not, so an HOI reply
-- could be correlated to a quote request and render nowhere. Same gap, same fix.
--
-- SCOPED TO THE QUOTE REQUEST, not the contact: q.row_id = h.id. A contact can
-- have several requests out to several agents at once — that is the normal case,
-- one per agent — so scoping by contact would show every agent's reply on every
-- agent's card. Same correction 20260817h made on the VOE side.
--
-- READ ACROSS, NOT COPIED IN. quote_reply_log stays the poller's own record. A
-- correlation is an inference, and hoi_quote_requests is what the panel, the
-- winner lookup and quote selection all read. A wrong match should cost a row on
-- a card, not a row in the record. Each reply carries source and matched_by so
-- its origin and the rung that matched it stay visible rather than blending into
-- the request's own data.
--
-- ══ WHY THE RETURN TYPE CHANGES ══
--
-- It was RETURNS SETOF hoi_quote_requests — a row shape with nowhere to put a
-- replies array. RETURNS jsonb holding a JSON ARRAY is what the single caller
-- already handles: lpHoiLoadList does `_lpHoiList = r.data || []` and iterates,
-- and PostgREST hands back the array either way, so the shape is unchanged from
-- JavaScript's side.
--
-- Built with to_jsonb(h) rather than 24 enumerated columns, so a column added to
-- hoi_quote_requests later appears here without anyone remembering to add it —
-- the failure mode of an enumerated list is silent omission.
--
-- A return-type change cannot go through CREATE OR REPLACE, hence the DROP.

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

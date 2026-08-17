-- The shared HOI/VOE reply correlation, plus the two setters that record what a
-- send actually produced.
--
-- REVERT:
--   drop function if exists public.quote_reply_match(text,text,text,text,text,text,text);
--   drop function if exists public.hoi_quote_set_thread(uuid,text,text,text,text);
--   drop function if exists public.voe_set_thread(uuid,text,text,text,text);
--
-- ══ WHY A SHARED MATCHER RATHER THAN A SECOND voe_match_reply ══
--
-- HOI and VOE correlate identically; only the target table differs. Two matchers
-- would mean two idempotency answers that can disagree about whether a reply was
-- already handled, which is the failure a single key exists to prevent.
--
-- voe_match_reply is LEFT IN PLACE and unchanged — voe-inbound-poll still calls
-- it. This is additive.
--
-- ══ THE LADDER, AND WHY THE LAST RUNG REFUSES MORE THAN IT ACCEPTS ══
--
-- 1. In-Reply-To / References -> rfc_message_id.  PRIMARY.
--    The only rung that survives a recipient whose mail system strips
--    plus-addressing, or who composes a fresh message instead of hitting reply.
--    Matches the RFC header, NOT the Gmail API id — see 20260817c for the
--    difference, which is what made the original design unable to match at all.
--
-- 2. token -> reply_token / voe_reply_token.  SECONDARY.
--    Secondary because it is trivially lost. VOE is the worked example: the send
--    emitted a bare processing@ while the poll queried processing+<token>@, so
--    this rung matched nothing for its entire existence and nothing reported it.
--
-- 3. sender address, ONLY WHEN IT IDENTIFIES EXACTLY ONE ROW.  LAST.
--    voe_match_reply's fallback takes the address and picks the most RECENT
--    order for it. That is a guess, and it is wrong precisely when it matters:
--    jesus@ezinsurance123.com is already on two borrowers, so "most recent" would
--    attach a reply about one borrower to the other's file — silently, on
--    borrower NPI, with no signal that anything was assumed.
--
--    So this rung counts first and returns 'ambiguous_address' with NO row when
--    more than one candidate exists. An unattached reply is a visible gap
--    somebody can act on. A confidently misattached one is a record of a
--    conversation that did not happen.
--
-- Unmatched is a legitimate, expected outcome. It is never upgraded to a guess.

create or replace function public.quote_reply_match(
  p_in_reply_to text default null,
  p_references  text default null,
  p_from_email  text default null,
  p_to_email    text default null,
  p_cc_email    text default null,
  p_subject     text default null,
  p_body        text default null
) returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
/* Shared HOI/VOE reply correlation. One matcher for both tables because the
   correlation is identical and only the target table differs — two would mean
   two idempotency answers that can disagree about whether a reply was handled.

   The ladder, strongest first:
     1. In-Reply-To / References -> rfc_message_id   (survives a stripped token)
     2. hoi_/voe_ token in addressing, subject or body
     3. sender address, ONLY when it identifies exactly one row

   rfc_message_id is the RFC header, NOT the Gmail API id. They are different
   strings and matching In-Reply-To against the API id can never hit; that error
   is what left the first version of this design unable to correlate anything.

   'unmatched' and 'ambiguous_address' are legitimate outcomes and are NEVER
   upgraded to a guess. voe_match_reply is untouched and still serves
   voe-inbound-poll; this is additive. */
declare
  v_ids       text[];
  v_token     text;
  v_kind      text := null;
  v_row_id    uuid := null;
  v_contact   uuid := null;
  v_matched   text := 'unmatched';
  v_haystack  text;
  v_n         int;
  v_from      text;
begin
  -- ── 1) In-Reply-To / References → rfc_message_id ────────────────────────────
  -- Both headers are scanned together. A reply's In-Reply-To names its immediate
  -- parent, but References carries the whole chain, so a reply-to-a-reply still
  -- resolves to the original request without walking anything.
  v_ids := array(
    select distinct m[1]
    from regexp_matches(concat_ws(' ', p_in_reply_to, p_references), '<[^<>\s]+>', 'g') as m
  );

  if array_length(v_ids, 1) is not null then
    select 'hoi', id, contact_id into v_kind, v_row_id, v_contact
    from public.hoi_quote_requests
    where rfc_message_id = any(v_ids)
    limit 1;

    if v_row_id is null then
      select 'voe', id, contact_id into v_kind, v_row_id, v_contact
      from public.loan_orders
      where rfc_message_id = any(v_ids)
      limit 1;
    end if;

    if v_row_id is not null then v_matched := 'in_reply_to'; end if;
  end if;

  -- ── 2) plus-token, or a token appearing anywhere in the addressing/body ─────
  if v_row_id is null then
    v_haystack := concat_ws(' ', p_to_email, p_cc_email, p_subject, p_body);
    -- substring(), not regexp_match(): regexp_match returns capture GROUPS, and
    -- the whole match is what is wanted. Reading [1] here would yield just 'hoi'
    -- or 'voe' and [0] is always null, Postgres arrays being 1-indexed — either
    -- would silently never match a token.
    v_token := substring(v_haystack from '(?:hoi|voe)_[0-9a-f]{32}');

    if v_token is not null then
      if v_token like 'hoi\_%' then
        select 'hoi', id, contact_id into v_kind, v_row_id, v_contact
        from public.hoi_quote_requests where reply_token = v_token limit 1;
      else
        select 'voe', id, contact_id into v_kind, v_row_id, v_contact
        from public.loan_orders where voe_reply_token = v_token limit 1;
      end if;
      if v_row_id is not null then v_matched := 'token'; end if;
    end if;
  end if;

  -- ── 3) sender address, only when it is unambiguous ──────────────────────────
  v_from := lower(nullif(trim(coalesce(p_from_email, '')), ''));
  if v_row_id is null and v_from is not null then
    select count(*) into v_n from (
      select id from public.hoi_quote_requests where lower(agent_email) = v_from
      union all
      select id from public.loan_orders
       where order_type = 'voe' and lower(hr_contact_email) = v_from
    ) c;

    if v_n = 1 then
      select 'hoi', id, contact_id into v_kind, v_row_id, v_contact
      from public.hoi_quote_requests where lower(agent_email) = v_from limit 1;
      if v_row_id is null then
        select 'voe', id, contact_id into v_kind, v_row_id, v_contact
        from public.loan_orders
        where order_type = 'voe' and lower(hr_contact_email) = v_from limit 1;
      end if;
      if v_row_id is not null then v_matched := 'address_unique'; end if;
    elsif v_n > 1 then
      /* DELIBERATELY NO ROW, and this is the point of the rung.
         voe_match_reply's equivalent fallback takes the address and picks the
         most RECENT order for it. That is a guess, and it is wrong exactly when
         it matters: jesus@ezinsurance123.com is already on two borrowers, so
         "most recent" would file a reply about one borrower onto the other's
         record — silently, on borrower NPI, with nothing marking it as assumed.
         An unattached reply is a visible gap somebody can act on; a confidently
         misattached one is a record of a conversation that did not happen. */
      v_matched := 'ambiguous_address';
    end if;
  end if;

  return jsonb_build_object(
    'kind',        v_kind,
    'row_id',      v_row_id,
    'contact_id',  v_contact,
    'reply_token', v_token,
    'matched_by',  v_matched
  );
end;
$function$;

/* ── Setters ───────────────────────────────────────────────────────────────────
   Called by the browser immediately after a send, to record what the send
   actually produced. Separate from hoi_quote_log/voe_request_log rather than
   more overloads of them: hoi_quote_log already has two signatures and a third
   differing only by trailing optionals is how the wrong one gets resolved.

   Staff-gated on the same predicate hoi_quote_log uses. SECURITY DEFINER because
   the browser has no direct write on either table.

   rfc_message_id may legitimately arrive null — gmail-inbox returns null when
   its post-send read fails, meaning the mail went out but we cannot prove which
   header it carried. Storing the null is honest; the reply then falls to the
   token rung instead of matching a fabricated id. */

create or replace function public.hoi_quote_set_thread(
  p_id uuid,
  p_gmail_message_id text default null,
  p_gmail_thread_id  text default null,
  p_rfc_message_id   text default null,
  p_reply_token      text default null
) returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only'; end if;

  update public.hoi_quote_requests
     set gmail_message_id = coalesce(nullif(trim(coalesce(p_gmail_message_id,'')),''), gmail_message_id),
         gmail_thread_id  = coalesce(nullif(trim(coalesce(p_gmail_thread_id,'')),''),  gmail_thread_id),
         rfc_message_id   = coalesce(nullif(trim(coalesce(p_rfc_message_id,'')),''),   rfc_message_id),
         reply_token      = coalesce(nullif(trim(coalesce(p_reply_token,'')),''),      reply_token),
         updated_at       = now()
   where id = p_id;
end;
$function$;

create or replace function public.voe_set_thread(
  p_order_id uuid,
  p_gmail_message_id text default null,
  p_gmail_thread_id  text default null,
  p_rfc_message_id   text default null,
  p_reply_token      text default null
) returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only'; end if;

  update public.loan_orders
     set gmail_message_id = coalesce(nullif(trim(coalesce(p_gmail_message_id,'')),''), gmail_message_id),
         gmail_thread_id  = coalesce(nullif(trim(coalesce(p_gmail_thread_id,'')),''),  gmail_thread_id),
         rfc_message_id   = coalesce(nullif(trim(coalesce(p_rfc_message_id,'')),''),   rfc_message_id),
         voe_reply_token  = coalesce(nullif(trim(coalesce(p_reply_token,'')),''),      voe_reply_token)
   where id = p_order_id;
end;
$function$;

grant execute on function public.quote_reply_match(text,text,text,text,text,text,text) to authenticated, service_role;
grant execute on function public.hoi_quote_set_thread(uuid,text,text,text,text) to authenticated, service_role;
grant execute on function public.voe_set_thread(uuid,text,text,text,text) to authenticated, service_role;

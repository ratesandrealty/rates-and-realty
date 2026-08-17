-- Only rows we have a SEND RECORD for may be correlated.
--
-- REVERT: re-apply 20260817d's definition of quote_reply_match.
--
-- ══ THE INVARIANT THIS ADDS ══
--
--   A reply to one of the six pre-existing hoi_quote_requests rows or the five
--   pre-existing VOE loan_orders must correlate to NOTHING. They predate these
--   columns and were sent through MailerSend, which returned no id to store.
--
-- Measured before this change, and it did NOT hold:
--
--   reply from rduarte89@yahoo.com   -> address_unique -> f012081f  (pre-existing)
--   reply from rhonda@cal-tech.net   -> address_unique -> e0d241f8  (pre-existing)
--
-- The HOI side happened to return ambiguous_address instead, but only BY
-- ACCIDENT: every agent address currently in that table sits on exactly two
-- rows, so the ambiguity guard caught it. A single unique agent address would
-- have matched. An invariant that holds because of how the data happens to look
-- is not an invariant.
--
-- ══ THE PREDICATE, AND WHY IT IS NOT `rfc_message_id IS NOT NULL` ══
--
-- Correlatable means "we recorded what we sent", which is
--
--     gmail_message_id is not null OR rfc_message_id is not null
--
-- rather than rfc alone. gmail-inbox returns rfc_message_id as NULL when its
-- post-send read fails — the mail went out, we hold the API id, but we cannot
-- prove which RFC header it carried. Such a row must still be reachable by its
-- token, and keying only on rfc would silently orphan it. Pre-existing rows have
-- NEITHER, which is what separates them.
--
-- Tier 1 (In-Reply-To -> rfc_message_id) already excludes them by construction:
-- NULL never equals anything. This adds the guard to tiers 2 and 3, which key on
-- reply_token and on the sender address and would otherwise reach back into
-- history.

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

   EVERY TIER IS RESTRICTED TO ROWS WE HAVE A SEND RECORD FOR — gmail_message_id
   or rfc_message_id present. Rows predating those columns went out through
   MailerSend, which returned no id, so nothing about them can be corroborated
   and a reply must attach to NOTHING rather than be guessed onto history.
   Measured before that guard existed: a reply from a pre-existing order's HR
   address matched it by address_unique.

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
  -- 1) In-Reply-To / References -> rfc_message_id.
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

  -- 2) plus-token, or a token appearing anywhere in addressing/subject/body.
  if v_row_id is null then
    v_haystack := concat_ws(' ', p_to_email, p_cc_email, p_subject, p_body);
    -- substring(), not regexp_match(): regexp_match returns capture GROUPS, and
    -- the whole match is what is wanted.
    v_token := substring(v_haystack from '(?:hoi|voe)_[0-9a-f]{32}');

    if v_token is not null then
      if v_token like 'hoi\_%' then
        select 'hoi', id, contact_id into v_kind, v_row_id, v_contact
        from public.hoi_quote_requests
        where reply_token = v_token
          and (gmail_message_id is not null or rfc_message_id is not null)
        limit 1;
      else
        select 'voe', id, contact_id into v_kind, v_row_id, v_contact
        from public.loan_orders
        where voe_reply_token = v_token
          and (gmail_message_id is not null or rfc_message_id is not null)
        limit 1;
      end if;
      if v_row_id is not null then v_matched := 'token'; end if;
    end if;
  end if;

  -- 3) sender address, only when it is unambiguous AND we sent the thing.
  v_from := lower(nullif(trim(coalesce(p_from_email, '')), ''));
  if v_row_id is null and v_from is not null then
    select count(*) into v_n from (
      select id from public.hoi_quote_requests
       where lower(agent_email) = v_from
         and (gmail_message_id is not null or rfc_message_id is not null)
      union all
      select id from public.loan_orders
       where order_type = 'voe' and lower(hr_contact_email) = v_from
         and (gmail_message_id is not null or rfc_message_id is not null)
    ) c;

    if v_n = 1 then
      select 'hoi', id, contact_id into v_kind, v_row_id, v_contact
      from public.hoi_quote_requests
       where lower(agent_email) = v_from
         and (gmail_message_id is not null or rfc_message_id is not null)
      limit 1;
      if v_row_id is null then
        select 'voe', id, contact_id into v_kind, v_row_id, v_contact
        from public.loan_orders
         where order_type = 'voe' and lower(hr_contact_email) = v_from
           and (gmail_message_id is not null or rfc_message_id is not null)
        limit 1;
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

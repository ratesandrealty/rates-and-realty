-- quote_reply_match(p_in_reply_to text, p_references text, p_from_email text, p_to_email text, p_cc_email text, p_subject text, p_body text)
-- language: plpgsql
-- Captured from production 2026-08-17.

CREATE OR REPLACE FUNCTION public.quote_reply_match(p_in_reply_to text DEFAULT NULL::text, p_references text DEFAULT NULL::text, p_from_email text DEFAULT NULL::text, p_to_email text DEFAULT NULL::text, p_cc_email text DEFAULT NULL::text, p_subject text DEFAULT NULL::text, p_body text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- 1) In-Reply-To / References -> rfc_message_id.
  -- Both are scanned together: In-Reply-To names the immediate parent, but
  -- References carries the whole chain, so a reply-to-a-reply still resolves to
  -- the original request without walking anything.
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

  -- 3) sender address, only when it is unambiguous.
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

# Retiring `voe-inbound-poll` (pg_cron job 37) and `voe_match_reply`

**Nothing has been dropped or disabled yet.** This is the analysis that gates it,
plus the snapshot, so the decision is made against measurements rather than
against a plan.

## Why retire it

`quote-reply-poll` (job 50) now correlates HOI and VOE replies with a stronger
ladder, restricted to rows we have a send record for. The old poller is a second
sweep of the same two mailboxes running a matcher with a fallback that **guesses**.

The hazard is not theoretical. On 2026-08-17 an insurance agent replied to a real
HOI quote request from `rduarte89@yahoo.com` — the same address that is
`hr_contact_email` on VOE order `f012081f` (Rafael Hernandez Andrade). Asked
directly what it would do with that sender:

```
voe_match_reply('rduarte89@yahoo.com', …)  →  matched_by: hr_email
                                              order_id:   f012081f
```

It would have filed **one borrower's insurance reply onto another borrower's
employment verification**. It did not, only because `voe-inbound-poll` queries
Gmail for `to:…+<voe_token>@` addresses and that reply carried a `hoi_` token.
**Safety by query shape, not by the matcher.** `quote_reply_match` refused the
same address correctly, by design, and filed the reply on the HOI request via
`in_reply_to`.

## 1. What stops being written, and whether anything decides on it

Job 37's only writes go through `voe_log_inbound`, which does exactly two things:

1. `INSERT INTO email_log` — `direction='inbound'`, `template='voe_request'`,
   `status='received'`, full `body_html`/`body_text`, gmail ids, and `contact_id`
   from the match. Idempotent on `gmail_message_id`.
2. `UPDATE loan_orders SET updated_at = now()` on the matched order — a touch. It
   deliberately does **not** advance status.

`quote-reply-poll` writes only `quote_reply_log`. So retirement loses:

| lost | consequence |
|---|---|
| the inbound `email_log` row | the reply stops appearing in the contact timeline / Email Threads panel |
| `loan_orders.updated_at` touch | "last activity" on the order no longer moves when HR replies |
| full message body | `quote_reply_log` stores a 500-char `snippet` only |

**Checked, one by one, whether anything DECIDES on those rows — nothing does:**

- **`order_reminders_run`** keys on **outbound** evidence
  (`template='voe_request' AND status='sent'`) and on `loan_orders.status`. Inbound
  rows are not consulted, and `voe_log_inbound` never advanced status anyway, so
  reminders behave identically. **Not affected.**
- **`trigger_score_recalc`** fires on `email_log` only when `opened_at` transitions
  to non-null. Inbound rows have no `opened_at`. **Not affected.**
- **`sync_contact_email_open_counters`** sums `open_count`/`click_count`, which
  inbound rows do not carry. **Not affected.**

So no automation changes behaviour. **What thins is the record, not any decision.**

Partial mitigation, worth knowing rather than relying on: `gmail-inbox` persists
inbound to `email_log` when a thread is opened in the CRM inbox and a participant
matches a known contact or vendor. So a VOE reply still reaches `email_log` **if a
human opens it there** — but no longer automatically.

The VOE panel is unaffected either way: `voe_activity` reads `quote_reply_log`
alongside `email_log` since 20260817i, so a correlated reply renders regardless.

**If the timeline entry matters, the honest fix is to have `quote-reply-poll`
write the inbound `email_log` row itself** — not to keep a second poller alive for
it. That was deliberately left out (a poller that mutates the system of record on
an inference), and it is a decision to take on its own merits.

## 2. The five pre-existing VOE orders

The claim to test was: the old poller was the only thing that could ever match
them, so after retirement a reply to any of the five correlates nowhere.

**Only two of the five were ever matchable by it at all, and both are closed.**

| order | borrower | status | HR email | token | old poller could match? |
|---|---|---|---|---|---|
| `f012081f` | Rafael Hernandez Andrade | **received** | yes | yes | yes |
| `e0d241f8` | Vincent Solis | **received** | yes | yes | yes |
| `d3016676` | Rafael Hernandez Andrade | not_ordered | — | — | **no** |
| `dc8727ec` | Tania Monje Flores | not_required | — | — | **no** |
| `c12eab08` | Juan Pablo Davila | ordered | — | — | **no** |

`voe_match_reply` can only match on a token or on `hr_contact_email`. Three of the
five carry neither, so no reply to them could ever have correlated — before or
after retirement. The two that could are both `received`; the conversation is
over and no reply is expected.

**Conclusion: retirement costs no correlation capability that any open order
actually had. Re-sending the five through the new path is NOT required.**

Re-sending would also be the wrong instinct for four of them: three are
closed/not-required and one was never ordered. The only order where threading
would be worth having is a VOE that is genuinely outstanding — and if one is sent
again for any reason it goes through the new path automatically.

### A separate finding, not a blocker

`c12eab08` (Juan Pablo Davila) is `status='ordered'` since 2026-08-12 with **no
HR email, no token, and zero outbound `email_log` evidence**. It is marked ordered
with no record that anything was sent. That predates all of this work and is
unrelated to the retirement, but it is a real gap: either the request went out
through a path that logged nothing, or the status is wrong.

## Snapshot: `voe_match_reply` as it stands before removal

**CONDENSED FOR READING, NOT VERBATIM** — the comments are shortened. I first
wrote "captured verbatim" here and it was not true, which is exactly the kind of
claim a tombstone must not make about itself.

The verbatim record is `supabase/sql/db-functions/voe_match_reply.sql`, a direct
`pg_get_functiondef` capture refreshed from production while writing this. Read
that one if the exact text matters; read this one for the shape.

```sql
CREATE OR REPLACE FUNCTION public.voe_match_reply(
  p_from_email text DEFAULT NULL::text, p_to_email text DEFAULT NULL::text,
  p_cc_email text DEFAULT NULL::text, p_subject text DEFAULT NULL::text,
  p_body text DEFAULT NULL::text, p_reply_token text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_token text; v_order_id uuid; v_contact_id uuid;
  v_matched_by text := 'unmatched'; v_haystack text;
begin
  -- 1) Resolve the reply token. Prefer an explicitly parsed token, else scan
  --    the addressing fields, subject and body for a voe_<32hex> marker.
  v_token := nullif(trim(p_reply_token), '');
  if v_token is null then
    v_haystack := concat_ws(' ', p_to_email, p_cc_email, p_subject, p_body);
    v_token := (regexp_match(v_haystack, 'voe_[0-9a-f]{32}'))[1];
  end if;

  -- 2) Primary match: token -> loan_orders.voe_reply_token
  if v_token is not null then
    select id, contact_id into v_order_id, v_contact_id
    from public.loan_orders
    where voe_reply_token = v_token
    order by ordered_at desc nulls last
    limit 1;
    if v_order_id is not null then v_matched_by := 'token'; end if;
  end if;

  -- 3) Fallback match: HR sender address -> most recent VOE order for that HR
  if v_order_id is null and nullif(trim(p_from_email),'') is not null then
    select id, contact_id into v_order_id, v_contact_id
    from public.loan_orders
    where order_type = 'voe'
      and lower(hr_contact_email) = lower(trim(p_from_email))
    order by ordered_at desc nulls last
    limit 1;
    if v_order_id is not null then v_matched_by := 'hr_email'; end if;
  end if;

  return jsonb_build_object(
    'order_id', v_order_id, 'contact_id', v_contact_id,
    'reply_token', v_token, 'matched_by', v_matched_by);
end;
$function$;
```

### Why it is being retired, not merely replaced

Rung 3 is the reason. `order by ordered_at desc … limit 1` turns an ambiguous
address into a confident answer: it does not report that several orders share the
sender, it silently picks the most recent. When an address is on more than one
borrower — and `jesus@ezinsurance123.com` is on two, `rduarte89@yahoo.com` spans
an HOI agent and a VOE HR contact — that is a record of a conversation that did
not happen, filed on borrower NPI, with nothing marking it as assumed.

`quote_reply_match` replaces it by refusing: `ambiguous_address` returns **no
row**, and every rung is restricted to orders we hold a send record for, so
history cannot be reached back into. Rung 1 also matches the RFC `Message-ID`
rather than the token, which survives a recipient that strips plus-addressing.

The token rung here is not wrong — it is simply weaker, and it was also **dead
for its entire existence**: `lead-detail` sent a bare `processing@` while this
matcher and the poller queried `processing+<token>@`, so it never matched
anything until the send was fixed on 2026-08-17.

## Proposed order of operations

1. `select cron.unschedule(37);` — stop the sweep. Reversible; leaves everything
   else in place.
2. Watch one working day. `quote_reply_log` should keep correlating; nothing else
   should change.
3. Then, if the timeline entry is judged worth keeping, add the `email_log`
   insert to `quote-reply-poll` **before** dropping `voe_match_reply`.
4. `drop function public.voe_match_reply(...)` last, and only once
   `voe-inbound-poll` itself is deleted — it is that function's only caller.

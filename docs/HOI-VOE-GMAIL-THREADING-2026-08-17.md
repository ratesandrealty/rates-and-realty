# HOI / VOE reply threading over Gmail DWD

Built and proven. This replaces the handoff that used to live here; the parts of
it that were wrong are recorded below rather than deleted, because one of them
would have shipped a correlation that could never match.

## The correction that mattered

The previous handoff, and `20260817b`'s own comments, said:

> `gmail_message_id` is the RFC Message-ID of the request we sent. A reply
> carries it in In-Reply-To/References, and that is the PRIMARY correlation.

**It is not, and it does not.** Two different strings:

```
Gmail API id     19ff76c7c7610398                                  <- send returns this
RFC Message-ID   <CAP-aoA0q1TwTffAdeYwLxD_Pj757BYCJrkLbTA_Wms_…>   <- In-Reply-To carries this
```

Every `gmail_message_id` in `email_log` is 16 hex characters, because
`messageToRow()` stores `msg.id` into it. That is what the column name means
everywhere in this codebase, so the HOI column named to match it held the API id
too.

A poller matching In-Reply-To against it would have matched **nothing, on every
reply, forever** — the identical failure the same document correctly diagnosed
for VOE's plus-token, reproduced in its own primary path. Both fail silently: the
reply simply never attaches, and nothing reports it.

Fixed by storing all three, because they do different jobs:

| column | holds | used for |
|---|---|---|
| `gmail_message_id` | Gmail API id | idempotency, re-fetching the message |
| `rfc_message_id` | RFC header | **what In-Reply-To actually matches** |
| `gmail_thread_id` | thread id | corroboration against Gmail's own grouping |

`gmail-inbox`'s send now returns `rfc_message_id`. It always had the value — the
post-send `format=full` read gets real headers — it was never surfaced.

### The second correction: HOI never used `proc_hoi_agent`

The handoff said to preserve that template by rendering through `email-service`
`preview`. `lpHoiSendAll` does not use it. It composes its body from a hardcoded
string in `_lpHoiBody()`. `proc_hoi_agent` belongs to the **other** HOI path — the
generic composer at `lead-detail.html:11110` — which writes no
`hoi_quote_requests` row and so has nothing to thread. No preview call was
needed; the template is untouched.

## What shipped

- **`gmail-inbox`** — send returns `rfc_message_id`; accepts `reply_to`,
  restricted to `rene@`/`processing@` with an optional `+tag`. Unrestricted
  Reply-To would be a phishing primitive: mail genuinely From: a ratesandrealty
  mailbox, DKIM-signed by us, replying to an address the caller chose.
- **`_shared/mime.ts`** — `Reply-To`, with CR/LF stripped. A newline in a header
  value is header injection. 3 tests; the injection one was **broken before it
  was trusted** — without the strip it fails with `Bcc: attacker@evil.com` as a
  real header. 11/11.
- **`20260817c`** — `rfc_message_id` on `hoi_quote_requests`; all three columns on
  `loan_orders`, which had none.
- **`20260817d`** — `quote_reply_match()` plus `hoi_quote_set_thread()` /
  `voe_set_thread()`.
- **`20260817e`** — `quote_reply_log`.
- **`quote-reply-poll`** — one poller, both tables.
- **`admin/lead-detail.html`** — both sends rewired; VOE's Reply-To now carries
  the token.

## The ladder

1. **`In-Reply-To` / `References` → `rfc_message_id`** — primary. The only rung
   that survives a recipient whose mail system strips plus-addressing, or who
   composes a fresh message instead of replying.
2. **token → `reply_token` / `voe_reply_token`** — secondary, because it is
   trivially lost.
3. **sender address — ONLY when it identifies exactly one row.**

Rung 3 returns **no row** when the address is on more than one, as
`ambiguous_address`. This is not a rare edge case: **every HOI agent address
currently in the table is on two borrowers** — `jesus@ezinsurance123.com`,
`rodriguez.michelle1@ace.aaa.com`, `johnle.agency@gmail.com`. `voe_match_reply`'s
equivalent fallback picks the *most recent* order for the address, which would
file a reply about one borrower onto another's record, silently, on borrower NPI.

`voe_match_reply` is untouched and still serves `voe-inbound-poll`.

## Proofs

Ten assertions, all passing. Every fixture was a ZZ-TEST row; the only address
that received real mail was `rene@ratesandrealty.com`.

| | proof | result |
|---|---|---|
| P1 | HOI reply correlates via In-Reply-To to the right row | `in_reply_to`, `kind=hoi` |
| P1b | Gmail grouped the reply into the sent thread | thread ids equal |
| P2 | VOE reply correlates to the right `loan_orders` row | `in_reply_to`, `kind=voe` |
| P2b | same thread grouping for VOE | thread ids equal |
| P3 | plus-token **stripped** — In-Reply-To still catches it | `in_reply_to`, token seen: null |
| P4 | **BREAK IT**: bogus token + no In-Reply-To, plausible subject | `unmatched`, no row |
| P5 | two rows sharing one agent address — reply lands on the correct one | A→A, B→B |
| P5b | shared address with no In-Reply-To | `ambiguous_address`, no row |
| P6 | poller idempotency | `recorded:0, duplicate:11` |
| — | `dry_run` computes the match and writes nothing | `rows_written: 0` |

**Paired present-assertion.** P5b would pass vacuously if rung 3 always refused,
so it is paired with the opposite case: a ZZ-TEST row whose agent address appears
exactly once returns `address_unique` with that row id. The refusal is selective,
not blanket.

**A bug the proofs caught.** `Prefer: resolution=ignore-duplicates` targets the
PRIMARY KEY unless `on_conflict` names another column. `id` defaults to a fresh
uuid, so there was never a PK conflict to ignore — the insert proceeded and died
on the UNIQUE index instead. A re-poll of five recorded messages reported
`recorded:0 duplicate:0`: every one took the error branch. The table was never
wrong, the constraint held — but idempotency was working *by accident*, at the
database's insistence rather than by the poller's design. **A row-count assertion
would have passed here and proved nothing.**

Cleanup verified rather than assumed: 26 fixture messages trashed, all DB
fixtures removed, and afterwards **6 `hoi_quote_requests` and 5 VOE
`loan_orders` remain with zero of the new columns set.** The temporary fixture
function was deleted and its endpoint returns 404.

## What a green run does NOT prove

**The browser click-path.** The proofs drive the same sequence the rewired page
uses — `gmail-inbox` send → `hoi_quote_log` → `hoi_quote_set_thread` — but from
Node, not from the page. `render-check` confirms `lead-detail.html` parses and
executes (6/6 clean), which rules out a SyntaxError but says nothing about
whether the Send button is wired correctly.

This is the frontend-first rule applied honestly: **a human must send one HOI
quote request and one VOE request from the browser and confirm both work.** Until
then the rewire is unconfirmed on the only path a user takes.

**Third-party delivery.** Fixture replies were imported into our own mailbox
rather than delivered by an outside MTA. Deliverability was gated separately
against DNS: SPF carries `include:_spf.google.com`, Workspace DKIM is published,
MX is Google. This is a move between two authenticated senders, not off one.

## The one thing not done

**`quote-reply-poll` is deployed but nothing invokes it.** No pg_cron job was
created, deliberately: scheduling it would start it sweeping live mailboxes
before a human has confirmed the frontend, and the correct order is the reverse.

Once the browser paths are confirmed:

```sql
select cron.schedule('quote-reply-poll', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/quote-reply-poll',
    headers := public.internal_call_headers(),
    body := '{"lookback_days":2}'::jsonb)
$$);
```

`internal_call_headers()` sends `x-internal-secret`, which is what the function
validates. It deliberately does **not** define a fourth cron-secret name: this
project had three — `x-cron-secret`, `x-cron-key`, `x-internal-secret` — and that
spread is how the CRON_KEY rotation missed three workflows.

Verify the first run by reading `net._http_response`, not the job status: a
`succeeded` cron row only means the request was queued.

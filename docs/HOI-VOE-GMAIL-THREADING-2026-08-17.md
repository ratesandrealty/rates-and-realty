# HOI / VOE reply threading over Gmail DWD — handoff

Option (c) approved; Part 1 already established that `gmail.modify` covers send
and that `gmail-inbox:996` does it in production. This records what was verified,
what landed, and what the next session picks up. **The build is not done** — only
the schema landed.

## Verified before building

### 1. The deliverability gate — SAFE

This mattered because the move is not "add Gmail sending", it is **off
MailerSend**: `email-service` transmits via `api.mailersend.com`, and HOI and VOE
both go through it today. Checked in DNS rather than assumed:

```
SPF    v=spf1 a mx include:_spf.google.com include:_spf.mlsend.com include:_spf.mailersend.net ~all
DKIM   google._domainkey.ratesandrealty.com  →  v=DKIM1; k=rsa; p=MIIBIjANBgkq…  (real 2048-bit key)
MX     ASPMX.L.GOOGLE.com, ALT1-4  (Google Workspace is the mail host)
DMARC  v=DMARC1; p=none; rua=mailto:rene@ratesandrealty.com; pct=100
```

**Google is in SPF and Workspace DKIM is published**, so `processing@` sending via
Gmail DWD is a fully authenticated sender for the domain. Both MailerSend and
Google are already authorised, so this is a move **between two authenticated
senders** — not off one. No threading-for-deliverability trade with insurance
agents.

DMARC is `p=none`, so neither sender is being rejected on alignment today; that
is worth knowing but does not change the answer.

### 2. One poller for both — YES, they can share

Correlation is identical for HOI and VOE: the reply's `In-Reply-To` /
`References` matched against the stored `gmail_message_id`. **Only the target
table differs.** Sharing is strictly better than two pollers:

- one Gmail sweep instead of two
- **one idempotency key**, rather than two that can disagree about whether a
  reply was already processed

No reason to split, so the remaining work assumes a single poller.

### 3. VOE's token path is dead — confirmed, not inferred

| | |
|---|---|
| `admin/lead-detail.html:13967` | sends `body.reply_to = 'processing@ratesandrealty.com'` — **bare** |
| `supabase/functions/voe-inbound-poll/index.ts:130-131` | queries `to:rene+${o.voe_reply_token}@…` and `to:processing+${o.voe_reply_token}@…` |

The send has never emitted a plus-address, so those two queries have never
matched anything. The comment above line 13967 carefully explains the rene@ →
processing@ move (so the VA can see replies) without noticing that the token it
depends on was never in the address. It is a real example of why the token is
**secondary** in the design below: a token nobody emits and a token a recipient
strips fail the same way.

### 4. No logging regression

`gmail-inbox`'s send writes to **`email_log`** — the same table `email-service`
uses. Moving HOI/VOE across does not lose the send record.

### 5. The HOI template pipeline survives

HOI uses the `proc_hoi_agent` template with merge tags, rendered by
`email-service` `preview` — which `admin/lead-detail.html` already calls before
showing the composer. The rewire keeps that: **render through email-service
`preview`, then send the rendered HTML via `gmail-inbox`.** Only the transport
moves; templates, merge tags and the preview UI are untouched.

## What landed

`supabase/migrations/20260817b_hoi_quote_requests_gmail_threading.sql` — applied
and committed.

- `gmail_message_id`, `gmail_thread_id`, `reply_token` on `hoi_quote_requests`
- partial UNIQUE on `gmail_message_id` — this is what makes re-polling a reply a
  no-op instead of a duplicate; partial because every pre-existing row is null
- partial UNIQUE on `reply_token`, index on `gmail_thread_id`

**Deliberately not backfilled.** The six existing `hoi_quote_requests` rows and
five VOE orders hold no Message-ID, because MailerSend never returned one to
store. They cannot be threaded from data we hold. **Threading history starts at
the next send, and the UI must say so** rather than rendering an empty thread
that reads as broken.

A process note worth keeping: this migration was applied to production via the
MCP `apply_migration` before the repo file existed. Wrong order — for a few
minutes production held schema the repo had no record of, which is the same drift
shape `check-function-drift` exists to catch on the function side. Write the file
first.

## What remains

1. **Rewire the HOI send** onto `gmail-inbox`'s send action. Do not build a
   parallel sender. Store `gmail_message_id` and `gmail_thread_id` on the
   `hoi_quote_requests` row **at send**, from the `id` / `threadId` the send
   returns.
2. **Rewire the VOE send** the same way, and **emit the plus-token in reply-to**
   (`processing+<token>@ratesandrealty.com`) so `voe-inbound-poll`'s existing
   queries finally match something.
3. **Build the shared poller**, correlating in this order:
   1. `In-Reply-To` / `References` → `gmail_message_id` — **primary**
   2. plus-token in the delivered-to address — secondary
   3. `agent_email` / `hr_contact_email` **+ `contact_id`** — **last**, because
      `jesus@ezinsurance123.com` already appears on two borrowers, so the address
      alone cannot identify a row
   Idempotent on `gmail_message_id`.

### The proofs the build owes

- Real HOI send → reply → correlates to the right row via `In-Reply-To`, and
  `gmail_thread_id` matches the thread Gmail itself groups.
- Same for VOE.
- Reply from an address that **strips the plus token** — `In-Reply-To` must still
  catch it.
- **BREAK IT:** reply with a bogus token AND a stripped `In-Reply-To` — must
  attach to **nothing**, never guess by domain.
- Two borrowers sharing one agent address — reply lands on the correct row.
- Poller idempotent on `gmail_message_id`.

Use ZZ-TEST rows and send only to an internal mailbox, never a real agent
address; delete the rows afterwards. The six HOI rows and five VOE orders stay
untouched.

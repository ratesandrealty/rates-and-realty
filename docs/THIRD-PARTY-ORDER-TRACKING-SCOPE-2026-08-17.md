# Third-party order tracking — what exists, before designing anything

Report only. Nothing here is built.

---

# Part 1 — `revision_note` is already rendered, and hidden by one condition

## Where it is written

**One writer in SQL: `order_reminders_run`.** It writes the suppression note when
a VOE claims to be ordered but nothing evidences delivery. It is called daily at
**15:00 UTC** by `loan-date-nudges` (pg_cron job 38) — which is exactly why
`c12eab08.updated_at` reads `15:00:02Z` with nothing else about the order changed.

**One writer in the UI:** `lpOrderRevSave` → `lpOrderPatchFields`, from a textarea
on the order tile. Note `loan_order_set` has **no** `revision_note` parameter, so
the UI patches the column directly after the upsert.

## Why nobody can read it

`lpRenderOrders` already renders a textarea for **every** order type
(`lead-detail.html:13328`), placeholder *"Revision needed — what does the vendor
need to fix?"*. But:

```js
const nr = (st === 'needs_revision');            // :13291
… style="' + revStyle + (nr ? '' : 'display:none')   // :13328
```

**It is `display:none` unless the order's status is exactly `needs_revision`.**
The note is in the DOM and invisible — the same shape as the toast that rendered
under a modal, and as the `#shell` break test.

## How many are affected right now

| | |
|---|---|
| orders carrying a `revision_note` | **3** |
| …of which are `Reminder suppressed …` notes | **3** |
| …of which are **hidden** (status ≠ `needs_revision`) | **3** |

All three are VOE: two `ordered`, one `received`. **3 of 3 are invisible.** Total
orders in the table: 23.

## Size of the fix

One condition: show it when `revision_note` is non-empty, regardless of status.
Worth distinguishing the two uses while doing it — a suppression note is
system-written and read-only in nature, whereas the textarea exists for a human
to type why a vendor must revise. Rendering a system note into an editable box
invites someone to overwrite the thing that explains the problem, and
`order_reminders_run` will rewrite it on its next pass anyway (it only overwrites
when the field is empty or already starts with `Reminder suppressed`).

---

# Part 2 — third-party order tracking

## The six tags already exist as order kinds

`loan_orders.order_type`, all 23 rows:

| kind | orders | with `vendor_id` | with `gmail_thread_id` |
|---|---|---|---|
| voe | 6 | 0 | **1** |
| title | 5 | 3 | 0 |
| escrow | 4 | 3 | 0 |
| appraisal | 3 | 3 | 0 |
| payoff | 3 | 0 | 0 |
| hoi | 2 | 1 | 0 |

**Your six — escrow, title, HOI, VOE, mortgage payoff, appraisal — map 1:1 onto
these.** `payoff` is "mortgage payoff". No new taxonomy is needed; the tag
vocabulary should BE `order_type` so a tag can only ever name a kind that exists.

**One wrinkle worth deciding early: HOI has two structures.**
`loan_orders(order_type='hoi')` holds 2 rows, and `hoi_quote_requests` holds 7 —
one per agent quoted, which is the real HOI workflow. They are not linked. Any
generalisation has to say which is authoritative for HOI, or accept that HOI is
the one kind whose "order" is a set of quote requests.

## (b) is mostly a generalisation of what is already built

`voe_activity(order_id)` and `hoi_quote_list(contact_id)` already do exactly what
(b) describes: read email across at **display time**, scoped to the order/request,
carrying `source` and `matched_by`, never copying into the system of record.

What they share, and what a generic `order_activity(p_order_id)` would lift:

- join `email_log` on `gmail_thread_id` (exact, consults no attribution)
- union correlated replies from `quote_reply_log`
- de-dupe by `gmail_message_id` across the two sources
- carry `source` / `matched_by` so an inference stays visibly an inference

So **(b) is perhaps 70% generalisation, 30% new** — the new part being the
per-kind link from a thread to an order, which today only VOE and HOI have and
only via their own send path.

**The constraint that decides the scope: only 1 of 23 orders has a
`gmail_thread_id`** — the VOE sent today. Thread-based attachment therefore works
**going forward only**. Every existing order needs either a human tag or a vendor
address to attach anything. That is the single biggest fact for sizing this.

## Where filing happens today, and what it records

**Only in the CRM inbox** — `admin/js/inbox.js:3311`, a context-menu item
`🏷 File / Refile`. The lead-detail **Email Threads panel offers compose, search
mailboxes and reload — there is no filing control there at all.**

`gmail-inbox action:'tag'` does two things:

1. `persistMessages(...)` — fetches the whole thread and writes **every** message
   into `email_log` with the contact id (idempotent on `gmail_message_id`).
2. `email_thread_tag(p_thread_id, p_contact_id)` — records the tag, backfills
   `contact_id` on existing rows, and **auto-files future messages** in that
   thread.

**Filing records a contact, and nothing else.** No kind, no order.

## `email_thread_tags` — what it is, and yes it is used

```
gmail_thread_id  text
contact_id       uuid
tagged_by        uuid
tagged_at        timestamptz
```

Four columns. **No type column, no order column.** Written only by the
`email_thread_tag` RPC, called only from `gmail-inbox action:'tag'`.

**In active use:** 10 rows across 4 contacts, oldest 2026-07-28, newest
**2026-08-17 16:09** — today.

So your (a) is, concretely: **add `order_type` and optionally `loan_order_id` to
this table** (or a sibling), and give the inbox's File action a kind picker. The
thread→contact half already works and is being used.

Related and worth knowing: `email_thread_match_contradictions` already exists —
the escrow-number suggestion mechanism records when an automatic match and a
human tag disagree, and resolves as `refiled` or `superseded`. There is already a
precedent in this codebase for *the human tag winning and the disagreement being
recorded rather than hidden.*

## How an order should match a thread — ranked

1. **Explicit human tag — PRIMARY where present.** It is the only signal that
   carries intent, and the codebase already treats a human decision as
   authoritative over an automatic match. It is also the only thing that can
   attach anything to the 22 existing orders with no thread id.
2. **`gmail_thread_id` — primary where there is no tag, and the one that scales.**
   Proven end-to-end today: the agent's reply attached to the right HOI request
   by `in_reply_to` with `contact_id` NULL on the send row, so it works where
   attribution does not. Requires no human effort. Only covers orders created
   through the new send path.
3. **Vendor address — LAST, and only when it identifies exactly one order.** This
   is the rung that already nearly caused harm: `rduarte89@yahoo.com` is both an
   HOI agent and a VOE HR contact, and `voe_match_reply` answers
   `hr_email → f012081f` for it. Anything built on vendor address must refuse on
   ambiguity, exactly as `quote_reply_match` does.

**Recommendation: human tag > thread id > unambiguous vendor address**, with the
tag able to override a thread match and the disagreement recorded rather than
silently resolved — the pattern `email_thread_match_contradictions` already sets.

## (c) — follow-up already exists; extend it, do not rebuild

`order_reminders_run(p_interval_days integer DEFAULT 2)`, daily at 15:00 UTC via
`loan-date-nudges` (job 38). It already:

- covers **all** order types, not just VOE
- treats outstanding as `status NOT IN (received, not_required, cancelled,
  complete, completed)`
- skips an order that already has an **open** task
- throttles to one reminder per **2 days** per order
- creates a task titled `"<KIND> still outstanding - <borrower> (<employer/label>)"`,
  linked `related_table='loan_orders'`, priority **high** for `voe`/`payoff`
- for VOE only: checks delivery evidence and, when there is none, **suppresses the
  reminder and writes the reason to `revision_note`** rather than going quiet —
  accepting `phone|fax|called|verbal|portal|mailed|in person|by hand` in the notes
  as legitimate non-email delivery

**What it does not have, and what (c) would add:** *how long* something has been
outstanding, and *what was last heard*. Neither exists today because nothing joins
an order to its email activity — which is the same gap (b) closes. **(c) is
largely free once (b) exists**, and should read `order_reminders_run`'s output
rather than re-deriving "outstanding".

## (d) — the (i) info icon

No existing info-icon pattern was found on these panels to extend; this is new UI
but small, and independent of everything above.

---

## Suggested scope split, if it helps

- **Tiny, closes an open loop today:** show `revision_note` when non-empty. Three
  orders are currently telling Rene what to do, invisibly.
- **Small and high value:** add `order_type` (+ optional `loan_order_id`) to the
  filing action and `email_thread_tags`. Makes the other 22 orders attachable.
- **Medium, mostly generalisation:** `order_activity(p_order_id)` lifted from
  `voe_activity` / `hoi_quote_list`, driving a shared activity block on every
  order tile.
- **Then (c) and (d)**, which are cheap once the above exist.

Sequenced that way, each step is useful alone and nothing is wasted if the later
ones are dropped.

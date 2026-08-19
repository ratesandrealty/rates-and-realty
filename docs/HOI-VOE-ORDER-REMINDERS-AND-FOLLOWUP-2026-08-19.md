# HOI/VOE: reminder document-awareness, and the order follow-up button

## 1. `order_reminders_run` reading `attachment_stage1` — ALREADY BUILT, now proven

**This was already implemented and live.** `order_reminders_run` calls
`order_document_status()`, which calls `attachment_stage1()` and
`attachment_is_our_form()`. Nothing needed writing. What was missing was the
proof, and that is what this records.

Rather than rebuild it, the run was exercised against five orders covering every
branch.

### How it was proven without touching anything real

`order_reminders_run` iterates **every** open order and inserts a task for each
one that qualifies — 14 real open orders at the time. Running it to observe the
ZZ-TEST cases would have created real reminder tasks as a side effect.

So the whole test — fixtures, the run, and the reporting query — happens inside a
`DO` block that ends in `raise exception`, which aborts the transaction. The
result comes back in the exception message and **every write rolls back**,
including the tasks the run created for the 14 real orders. Verified afterwards:
23 orders (unchanged), 0 fixture orders, 0 reply rows, and **0 reminder tasks
created in the last ten minutes**.

### The result

| case | reply | `doc_status` | reminded | reason |
|---|---|---|---|---|
| A | none | `no_reply` | **yes** | first reminder |
| B | `VOE_Smith_completed.pdf`, 50 KB | `document` | **no** | SATISFIED — a reply carried a document |
| C | `image001.png`, 88 bytes | `no_document` | **yes** | replied without a document |
| D | attachments **NULL** | `unknown` | **yes** | first reminder |
| E | `Request_for_VOE_BLANK.pdf`, 1.36 MB | `no_document` | **yes** | replied without a document |

**Both directions.** It fires for a real reason (A, C, D, E) and stays silent for
a real reason (B) — silence only when a genuine document actually arrived.

**E is the case that matters most.** Our own blank form coming back — right
extension, 1.36 MB, would sail past any "is there a PDF" check — is classified
`no_document`, so the VOE nobody filled in **keeps being chased**. That is the
case that would otherwise silently close it.

**D is the second one.** A reply exists but its attachment metadata was never
captured, and the reminder that fires is the ORDINARY one — *"first reminder"* —
not *"replied without a document"*. The nudge is right, because the order really
is outstanding; the accusation would not be, because we do not know what they
sent. Same could-not-run-versus-failed distinction the suppression notice keeps.

Note E used `status = 'needs_revision'` deliberately: the VOE delivery-evidence
branch only runs for `ordered`/`acknowledged` and would have suppressed before
the document logic was reached.

## 2. The follow-up button on third-party order cards

Same shape as the VOE and HOI cards: reply into the stored Gmail thread when
there is one, **say so plainly when there is not**, and adopt the thread
afterwards so the next follow-up has one.

`loan_orders` already carried `gmail_thread_id` / `rfc_message_id` /
`gmail_message_id` for every order type, so nothing new is stored.

### Why not the existing "✉️ Email" button

`lpOrderEmail` composes through `order_email_envelope` and sends **no**
`thread_id` and **no** `in_reply_to`. That is right for first contact and wrong
for a chase: a vendor chased three times should see one conversation, not three,
and our correlation depends on the reply carrying a header we recognise.

### A bug found by testing it

The button read `o.gmail_thread_id` — and `lpLoadOrders`'s `select` did not
include that column. So it reported "⚠ new thread" on **every** order regardless
of the truth: the warning was right by accident and permanent, which is worse
than no warning, because a warning that never changes is one people stop reading.

Fixed by selecting the columns the card actually reads (`id`, the thread
columns, `hr_contact_*`, `label`, `last_follow_up_at`) rather than assuming them.

### Proof

A self-contained spec creates its own order, reads the button in both states,
and deletes it:

```
📨 Follow up ⚠ new thread :: 📨 Follow up
```

Un-threaded first, threaded second. **Asserting only the un-threaded wording
would pass for a button hard-coded to warn** — which is exactly the bug above —
so both are asserted in one string. It leaves nothing behind: verified 23 orders
and none on the fixture contact afterwards.

`voe_set_thread` is reused for the adoption. It is order-generic despite the
name — it updates `loan_orders` by id and touches only the thread columns — so
this adds no second function that would have to agree with it.

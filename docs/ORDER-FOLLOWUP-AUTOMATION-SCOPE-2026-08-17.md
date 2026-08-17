# Follow-up automation on third-party orders — scope

Report. (b) and (c) are not built.

## (a) Follow up by email from the order card

**Nearly free.** Everything needed is already shipped and proven:

- the order stores `gmail_thread_id` and `rfc_message_id` at send
- `gmail-inbox action:'send'` already accepts `in_reply_to`, `references` and
  `threadId`, and the send path builds `References` off the thread's last message
- a reply into the existing thread is what made today's HOI round trip correlate
  by `in_reply_to`

The work is a compose entry point on the card that passes `threadId` plus the
stored `rfc_message_id`. `openEmailComposer` already supports an `onSend`
override — that is exactly how VOE drives it.

**The one real limit: only 1 of 23 orders has a `gmail_thread_id`.** Orders placed
before the Gmail rewire have no thread to reply into, so the button has to degrade
to a new thread for them, and say so rather than silently starting one.

## (b) Did the expected document arrive?

### The gap, before any AI question

`quote_reply_log` stores **`snippet` and nothing else** — no body, no attachments.
So for a correlated reply, the attachment signal **does not exist today**.

It is not missing because it is hard to get. `quote-reply-poll` already fetches
each message with `format=full`, which carries the full MIME part tree, and then
**discards everything except the snippet**. The fix is one column and a few lines
in code that already runs.

The shape to copy is already in use — `email_log.attachments` is populated by
`gmail-inbox` and holds exactly what is needed:

```json
[{ "filename": "executed offer.pdf", "mimeType": "application/pdf",
   "size": 2095772, "disposition": "attachment",
   "contentId": null, "partId": "1", "attachmentId": "…" }]
```

64 of 755 `email_log` rows carry attachments; 119 attachments in total.

**Capture attachment metadata on `quote_reply_log` first. Everything below is
undecidable until that exists, and none of it needs a model to decide.**

### What a WHERE clause answers, measured on the 119 attachments we have

| | |
|---|---|
| PDFs | 95 |
| PDFs ≥ 50KB | **90** |
| images | 5 |
| carrying a `contentId` (inline) | **61** |
| under 50KB | 14 |
| size range | 88 B → 16.1 MB, mean 799 KB |

So "is there a PDF over 50KB" describes 90 of 119. But **two findings from the
real data say that predicate is the wrong one**, and neither is obvious:

**1. `contentId` does NOT mean "logo image".** A 3.2 MB lease and a 1.2 MB
`Request for VOE BLANK.pdf` both carry one. Filtering inline parts out — the
obvious way to dodge the reply-all-signature problem — **would discard real
documents.** Whatever `gmail-inbox`'s `filterRealAttachments` does for display,
it cannot be reused here as "inline = not a document".

**2. Our own form comes back.** `Request_for_VOE_BLANK.pdf` appears **six times**
in the attachment set. That is the blank we send, returned on reply-all. A
mime+size predicate counts it as the document arriving, and would close a VOE
that nobody has filled in — the single worst outcome this feature could produce.

### And the fix for (2) is also a WHERE clause, not a model

We store our own **outbound** attachments in `email_log` for the same thread. So
"is this a new document or our own form bounced back" is answerable by comparing
the inbound attachment's `filename` and `size` against what we sent on that
thread. Identical name and byte size is our blank returning. No model required.

### So: what the AI actually decides

After (1) direction = inbound, (2) a plausible document part, and (3) not
byte-identical to something we sent on that thread — the residue is:

> *"the attachment is called `scan001.pdf`; is it a title commitment or a
> signature page?"*

That is a real question, it needs the document's **content** rather than its
metadata, and it is a **minority** of cases. Filenames in this dataset are mostly
self-describing: `Home Quote - AWIS - Approved.pdf`, `Request_for_VOE_BLANK.pdf`,
`Appraisal Policies & Procedures.pdf`, `executed offer.pdf`.

**Recommendation — two stages, and the model is the second one:**

- **Stage 1, pure SQL.** inbound + document-like part + not matching our own
  outbound attachment on that thread. Free, deterministic, explains itself, and
  handles the majority. Result: `document_present` true/false.
- **Stage 2, a model call ONLY for what stage 1 admits and cannot name** — an
  uninformative filename on a candidate document. Ask one question: *does this
  document look like a `<kind>`?* Store the answer with the evidence, the way
  `matched_by` is stored, so a wrong call is visible rather than authoritative.

A model call that could be a WHERE clause is a liability; here **most of it can
be**, and the two traps above are both cheaper to solve in SQL than to explain to
a model.

## n8n or an edge function — and the answer is neither, quite

The established division of labour across the 11 workflows is consistent: **n8n
schedules and writes the ClickUp task; an edge function does the logic.**
Post-Close Touchpoint calls `post-close-followups`; Refi Watch calls `refi-watch`;
Critical Date Reminders scans and creates tasks with its own dedupe in
`loan_key_dates.reminders_sent`.

Following that pattern here would make this the **fourth** reminder engine, and
you are right that it should not be. The reason is not tidiness — it is that
`order_reminders_run` **already owns the de-duplication for these exact rows**: it
skips an order with an open task and throttles to one per two days. A second
engine reminding on the same orders would either duplicate its tasks or need its
own copy of that logic, and the two would drift the first time either changed.

**The convergence point already exists.** `order_reminders_run` writes into
`tasks`, and `clickup-bridge` already syncs `tasks` to ClickUp through its outbox —
its own source notes that `order_reminders_run` and `surface_stale_leads` insert
directly for exactly this reason. So extending `order_reminders_run` reaches
ClickUp **without introducing a destination at all.**

**Recommendation: extend `order_reminders_run`, add no workflow, add no
destination.** n8n earns its place when the work is a schedule plus a third-party
write; here the schedule exists (job 38, daily 15:00 UTC via `loan-date-nudges`)
and the third-party write is already handled downstream.

## (c) Reply with no document → follow up

This is a small change **once (b) exists**, and impossible before it.

`order_reminders_run` today decides on `loan_orders.status` and, for VOE, on
delivery evidence. It has no notion of a reply at all — so a reply carrying no
document is currently indistinguishable from silence, and both produce the same
generic "still outstanding" task.

What it needs is one more input, symmetric with the delivery-evidence check it
already performs:

- **document evidence**: a correlated reply on this order whose attachments pass
  stage 1
- if a reply exists and document evidence does not → the task copy changes from
  *"still outstanding, chase the vendor"* to *"they replied on <date> with no
  document — ask for the <kind>"*, which is a materially different action

**Reuse, do not add:** the same open-task check, the same two-day throttle, the
same `tasks` destination. The only new thing is the wording and the condition —
which is what makes this an extension rather than a fourth engine.

One caution worth stating now: `order_reminders_run` deliberately treats "could
not verify" as a reason to **suppress and explain**, not to nudge (see
`reminder_note`). A reply-with-no-document check should follow the same
discipline — if the attachment metadata is missing for a reply, that is *unknown*,
not *no document*, and it must not fire a reminder claiming the vendor sent
nothing.

## Dependency order

1. **(b) step one — capture attachment metadata on `quote_reply_log`.** Everything
   else waits on it; nothing else is blocked by anything.
2. **(a)** — independent, and useful on its own.
3. **(b) stage 1 predicate**, including the compare-against-our-own-outbound rule.
4. **(c)**, which is then a condition and a string.
5. **(b) stage 2 model call**, last and optional — worth doing only if stage 1
   leaves a residue that actually hurts.

# `c12eab08` — marked ordered by hand, never sent

Juan Pablo Davila, VOE, `status='ordered'` since 2026-08-12. Investigated
2026-08-17.

## Was a VOE ever sent? No.

`audit_log` holds exactly **one** row for this order:

```
id 1563   2026-08-12 05:38:30Z   STATUS_CHANGE
old  { "status": "not_ordered", "ordered_at": null }
new  { "status": "ordered", "order_type": "voe", "route_hint": "session via PostgREST" }
changed_by  rene@ratesandrealty.com
```

**The status was set by hand**, through the UI, not by the send pipeline.
`voe_request_log` — the only thing that records a VOE going out — never ran: it
writes `hr_contact_email`, `hr_contact_name`, `employer_name` and a
`voe_reply_token` onto the order, and on this row **every one of them is null**,
along with `vendor_id`, `label` and `notes`.

Nothing was emailed either:

| | |
|---|---|
| `email_log` rows for this contact with `template='voe_request'` | **0** |
| `email_log` rows for this contact with a "verification of employment" subject | **0** |
| `email_log` rows for this contact, any kind | **28** |

The 28 is the control that makes the zeros mean something: this contact has
plenty of email history, so "no VOE email" is a real absence rather than an
artefact of nothing being logged for them.

## Was anyone chasing it? No task — but NOT silently

This is the part worth getting right, because the obvious reading is wrong.

`order_reminders_run` does **not** require delivery evidence to nudge. Its loop
takes every order whose status is not `received/not_required/cancelled/complete`,
which includes this one. The evidence check is explicitly annotated in the source
as **"NOT a hard block: phone, fax and portal deliveries are legitimate"** — a VOE
placed by phone is real, and refusing to remind on it would be wrong.

What happens instead, when there is no evidence, is that the reminder is
suppressed **and the reason is written onto the order**:

```
revision_note (refreshed 2026-08-17):
  "Reminder suppressed 2026-08-17: marked ordered, but no evidence this VOE
   reached the HR contact. No successful send is recorded and nothing notes
   another channel. Re-send it, or add a note saying how it was delivered, and
   reminders resume."
```

That note is rewritten each run, which is why `updated_at` moved at 15:00:02Z
today with nothing else about the order changing.

So: **no task was created and no nudge was sent, but the system did not go
quiet.** It recorded that it could not verify delivery, said what would make it
resume, and kept saying so daily. That is the could-not-run-vs-failed distinction
working as designed rather than a gap.

The only task ever attached to this order — "VOE still outstanding - Juan Davila",
due 2026-08-05, created 2026-08-06 — is **completed** and predates the manual
status change by six days. Nothing has been raised since.

## What it costs, and what to do

The borrower's employment verification has been sitting marked-as-ordered for
five days with no request out. The record was honest about it the whole time; it
just said so in a field nobody was reading rather than in a task.

Two ways to clear it, and they are genuinely different:

- **If it was never sent** — send it through the VOE panel. It goes out through
  the new path, stores its Gmail ids, and becomes threadable and remindable.
- **If it was placed by phone, fax or portal** — put that in `notes` or
  `revision_note`. `order_reminders_run` accepts
  `(phone|fax|called|verbal|portal|mailed|in person|by hand)` as evidence and
  reminders resume immediately. Do NOT re-send in that case.

Only Rene knows which. The status change carries his uid, so the question is
answerable by asking him rather than by inference.

## The generalisable point

An order can be advanced by hand past the step that would have created its
evidence. Nothing prevents that, and there are legitimate reasons for it. What
makes it survivable is that the reminder run refuses to treat "ordered" as proof
of delivery and says so on the record — but the note lives on the order, not
anywhere someone looks daily. **Surfacing `revision_note` on the VOE card would
turn a field nobody reads into the thing that closes this loop.** Not done here;
worth doing.

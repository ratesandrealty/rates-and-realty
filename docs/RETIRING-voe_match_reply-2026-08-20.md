# Retiring `voe_match_reply` — what it would take

Report only. Nothing dropped or deleted. Supersedes the scope of
`docs/RETIRING-VOE-INBOUND-POLL-2026-08-17.md` on the parts that have since
happened.

## Where it stands today

| | state |
|---|---|
| pg_cron job 37 (`voe-inbound-poll`) | **gone** — no row in `cron.job` matches `voe` at all |
| edge function `voe-inbound-poll` | **still deployed, ACTIVE**, pinned `verify_jwt = false` |
| its in-function guard | `requireStaff(req, { allowInternal: true })` — fails closed |
| `voe_match_reply` anon EXECUTE | **revoked 2026-08-20** |
| DB objects depending on `voe_match_reply` | **0** (`pg_depend`, excluding internal) |
| callers in the tree | **1** — `voe-inbound-poll/index.ts:242` |

So the retirement is already half-done, by removal of the schedule. **This is
cleanup, not exposure**: the function is unreachable anonymously, and its only
caller is guarded and unscheduled. Nothing is currently at risk. What remains is
that a function documented as *guessing wrong across borrowers* is sitting in the
schema with no job, and the next person to read it has no way to know it is
dormant.

## Why it should go rather than be left

On 2026-08-17 an insurance agent replied from `rduarte89@yahoo.com`, which is also
the `hr_contact_email` on VOE order `f012081f` for a **different borrower**. Asked
directly:

```
voe_match_reply('rduarte89@yahoo.com', …)  →  matched_by: hr_email
                                              order_id:   f012081f
```

It would have filed one borrower's insurance reply onto another borrower's
employment verification. It did not, only because the poller's Gmail query looked
for `+<voe_token>@` addresses and that reply carried a `hoi_` token — **safety by
query shape, not by the matcher**. `quote_reply_match` refused the same address
correctly and filed the reply on the HOI request via `in_reply_to`.

A dormant function that guesses is a loaded default for whoever wires up the next
poller.

## What retiring costs — re-verified, unchanged

`quote-reply-poll` (job 50, `*/10`) already correlates both HOI and VOE with a
stronger ladder restricted to rows with a send record. What is lost is not
correlation but **record**:

| lost | consequence |
|---|---|
| inbound `email_log` row (via `voe_log_inbound`) | the reply stops appearing in the contact timeline / Email Threads panel |
| `loan_orders.updated_at` touch | "last activity" no longer moves when HR replies |
| full message body | `quote_reply_log` keeps a 500-char snippet only |

**Nothing decides on those rows** — `order_reminders_run` keys on *outbound*
evidence and `loan_orders.status`; `trigger_score_recalc` needs `opened_at`;
`sync_contact_email_open_counters` needs open/click counts. Inbound rows carry
none. The VOE panel is unaffected: `voe_activity` has read `quote_reply_log`
alongside `email_log` since `20260817i`.

Note this is already the live situation — job 37 has been gone for some time, so
these rows have **already** stopped being written. Retirement formalises a loss
that has occurred, rather than causing one.

## The sequence

1. **Delete the edge function** `voe-inbound-poll` and confirm the endpoint 404s.
   Remove `[functions.voe-inbound-poll]` from `supabase/config.toml` and delete
   `supabase/functions/voe-inbound-poll/`.
2. **Then** `drop function public.voe_match_reply(text,text,text,text,text,text);`
   — order matters only so the tree never references a dropped function.
3. **Decide `voe_log_inbound` separately.** Its only caller is the poller, so it
   becomes orphaned at step 1 — but it is the thing that writes the timeline row,
   and it is the natural building block if `quote-reply-poll` is ever given that
   job (see below). It is also **still anon-executable and it WRITES to
   `email_log`** — so if it is kept, it belongs on the revoke backlog, not left as
   it is.
4. Keep the captured DDL at `supabase/sql/db-functions/voe_match_reply.sql` as the
   tombstone, and point `docs/RETIRING-VOE-INBOUND-POLL-2026-08-17.md` at this
   file.

## The open question that should be settled first

**Should `quote-reply-poll` write the inbound `email_log` row itself?**

If yes, `voe_log_inbound` stays and gains a new caller, and the timeline loss is
repaired rather than accepted. If no, both functions go and the CRM inbox becomes
the only route by which a VOE reply reaches `email_log` — which happens only when
a human opens the thread.

This was deliberately left out of `quote-reply-poll` originally, on the grounds
that a poller should not mutate the system of record on an inference. That
reasoning is weaker now that the correlation ladder is stronger and restricted to
rows with a send record, but it is a decision, not a cleanup step, and it changes
whether step 3 is "drop" or "keep and guard".

**Recommendation:** take steps 1 and 2 now — they remove a wrong-guessing function
with no caller and cost nothing that is not already lost. Hold step 3 until the
timeline question is answered, and in the meantime add `voe_log_inbound` to the
anon-revoke backlog on its own merits, since an anon-executable write into
`email_log` is a problem independent of any of this.

## Backlog note

`voe_log_inbound`, `voe_request_log` and `voe_set_thread` are all still
anon-executable **writes**. They were on the original family list
(`docs/ANON-EXECUTE-HOI-VOE-FAMILY-2026-08-19.md`) and remain open. The three
read-side oracles are now closed; these are the write side.

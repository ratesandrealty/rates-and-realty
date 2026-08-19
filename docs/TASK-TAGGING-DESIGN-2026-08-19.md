# Task tagging: referral partner and third-party order — the design

**Report, not built.** The single-slot problem is the decision, so it is made
here explicitly rather than discovered halfway through an implementation.

**Recommendation: dedicated nullable columns, `referral_partner_id` and
`loan_order_id`.** Not a reuse of `related_table`, and not a join table.

## What the data actually looks like

Measured 2026-08-19:

| | |
|---|---|
| tasks | 327 |
| carrying a `related_table` | 74 |
| …`loan_orders` | 34 |
| …`auto_followup_lead` | 40 |
| …anything else | **0** |
| `referral_partners` | 9 |
| `loan_orders` | 23 |

So `related_table` has exactly **two** producers today and **both are machines**:
`order_reminders_run` and `surface_stale_leads`. No human has ever written it —
`createTask` on lead-detail deliberately omits it, because setting it used to
file hand-typed tasks as automation output.

## The three options

### A — reuse `related_table` / `related_id`

Cheapest: no schema change. And wrong, for two reasons that compound.

**It is a single slot.** One `related_table` and one `related_id` per row, so a
task can be tagged to a referral partner *or* an order, never both. "Chase the
title company about the order on this file" is one task with two natural
referents, and the first thing anyone will try.

**It re-mixes what `origin` just separated.** `related_table='loan_orders'`
would then mean both "the reminder sweeper raised this about an order" and "a
human tagged this to an order". Provenance is safe — `origin` carries that now,
and `clickup_enqueue` gates on `origin='system'`, proven — but *meaning* goes
back to being ambiguous in the same column, one migration after it was fixed.

There is also no FK and no type. `related_id` is a bare uuid and `related_table`
is free text. That is the exact shape that let `contacts.assigned_to` rot into
two spellings of one person: nothing referenced it, so nothing complained.

### B — dedicated nullable columns  ← recommended

```sql
alter table tasks
  add column referral_partner_id uuid references referral_partners(id) on delete set null,
  add column loan_order_id       uuid references loan_orders(id)       on delete set null;
```

- **Both tags coexist.** The single-slot problem disappears rather than being
  worked around.
- **Real foreign keys.** A task cannot point at a partner that no longer exists,
  which `related_id` cannot promise. `on delete set null` keeps the task and
  drops the tag — deleting a partner must not delete somebody's to-do.
- **Queries are trivial and indexable**: `where referral_partner_id = $1`. No
  `related_table = 'x' and related_id = $1` pair, no casting.
- **`related_table` keeps its one meaning** — the subject of a machine-created
  task — so the human and machine paths never write the same column again.

The cost is a column per relation. That is the honest objection, and it is small
at two: if a third relation appears, revisit then, with evidence about whether a
general tagging system is actually wanted.

### C — join table `task_tags(task_id, entity_type, entity_id)`

The most flexible and the wrong amount of machinery for this. It buys
many-to-many — a task tagged to *two* partners — which nothing here asks for: 34
tasks already point at exactly one order each, and a task is chased with one
partner. In exchange it costs a table, its RLS policies, a join on every task
read, and a UI that manages a set instead of a value.

Pick C when a third and fourth relation exist and users want arbitrary tags.
Today it solves a problem nobody has.

## The order tag, on the same mechanism

`loan_order_id` is that mechanism. One extra decision comes with it:

**34 tasks already carry `related_table='loan_orders'` + `related_id`**, all
written by `order_reminders_run`. Two ways to go:

1. **Backfill `loan_order_id` from those 34 and have `order_reminders_run` write
   the new column too.** "Tasks about this order" becomes one query. The old
   pair stays as-is for provenance/subject. **Recommended** — it converges on one
   column instead of leaving readers to check two forever.
2. Leave them, and have every reader check both shapes. Cheaper now, and it is
   the same "two mechanisms that must agree" this codebase has already paid for
   twice (`task_list`'s compound provenance rule, and the pair of Maps loaders).

## What this touches when it is built

- `task_upsert` gains two optional params. **Watch `due_date`**: that function
  sets `due_date = p_due_date` with no `coalesce`, so any new caller passing a
  subset of fields wipes it. `task_assign_bulk` was written specifically to avoid
  that trap and is the model to copy.
- `task_list` and `va_daily_tasks` are `RETURNS TABLE`. Adding columns to those
  is where the *"structure of query does not match function result type"* error
  lives, and it names the column NUMBER, not the name.
- No backfill risk to provenance: `origin` is already a separate column, so
  tagging a task cannot make it look machine-made or enqueue it to ClickUp.
  Proven when `origin` landed.

## Not a blocker

Nothing above needs deciding before the HOI/VOE work. It is recorded so the
decision is made once, in the open, rather than implied by whichever column the
first implementation reaches for.

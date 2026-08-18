# Held: task tagging and bulk actions, 2026-08-18

Both deliberately not built. The tagging half rests on a conflation that has to
be resolved first, and that resolution is its own decision.

## The conflation: `related_table` means two different things

`tasks.related_table` is free text with no FK. It currently answers **"what is
this task about"** — `auto_followup_lead`, `loan_orders` — and three consumers
read it as **"a machine made this"**:

| consumer | what it does with `related_table is not null` |
|---|---|
| `task_list` | flags the row as machine-made |
| `va_daily_tasks` | same |
| `clickup_enqueue` | **requires** it — a task with a null `related_table` is never pushed to ClickUp |

Measured 2026-08-18: **74 tasks carry a `related_table`, 251 do not.** That split
is currently a clean proxy for machine-made vs human-made, which is exactly why
the two meanings have not yet collided.

`createTask` on lead-detail already carries a comment about this: it
*deliberately omits* `related_table`/`related_id`, because setting them filed
every hand-typed task as automation output. Five rows had to be backfilled
(`snapshots/tasks-related-table-leads-20260815.json`) after the same mistake on
people.html.

## Why that blocks referral-partner and order tagging

`referral_partners` exists (9 rows). `tasks` has no partner column. So
`related_table='referral_partners'` with `related_id` needs **no schema change**
— it is the cheap path, and it is the wrong one:

- it would mark a hand-created task as machine-made in two views, and
- it would make that task eligible for ClickUp export, which nothing asked for.

Order tagging is the same shape. 34 tasks already carry
`related_table='loan_orders'` and all 34 point at a real order, so the link
works — but every one of those was created by `order_reminders_run`. A human
tagging a task to an order would be borrowing the machine's field.

**Resolve the conflation first.** Either a dedicated nullable column per
relation (`referral_partner_id`, `loan_order_id`), or — better — separate
*provenance* from *subject*: an explicit `created_by_system boolean` (or
`origin text`) that the three consumers read instead of inferring it from
`related_table`. Then `related_table` is free to mean only what its name says,
and tagging becomes a one-line addition rather than a semantic change.

## Bulk actions: the design, not built

`task_upsert` takes a single `p_id`; `task_delete` takes a single `p_id`.
Neither accepts an array, so a bulk action today is N client-side calls.

For updates that is merely slow. For deletes it is dangerous: each row needs its
own `clickup-bridge /task/delete` call, the bridge has **no bulk route**, and a
partial failure mid-loop leaves an arbitrary number of orphaned ClickUp tasks.
One orphan is recoverable from `audit_log`; twenty is not a cleanup anybody will
do by hand.

If it is built, it should be **one RPC taking `uuid[]`** that:

1. snapshots every matched row into `audit_log` (`operation='DELETE'`,
   `old_data = to_jsonb(task)`) **before** deleting — `task_activity` cannot hold
   this, its FK is `ON DELETE CASCADE` and the record would be erased with the
   task;
2. deletes them in a **single statement**, so the set is all-or-nothing rather
   than partially applied;
3. returns the list of `clickup_task_id`s it removed, so the caller either
   deletes all of them in ClickUp or reports exactly which survived — never a
   silent partial;
4. applies the same guards `task_delete` already has: refuse out loud on an
   empty match, and warn on machine-created tasks that will simply regenerate.

The failure mode to design against is not the happy path. It is the caller that
deletes 20 rows, removes 14 from ClickUp, and reports success.

---

# RESOLVED 2026-08-18: the conflation is gone

`tasks.origin` (`'system' | 'clickup' | 'user'`, NOT NULL) now holds provenance.
`related_table` means only what its name says.

**Backfilled from the compound rule, never from `related_table`** — which alone
would have marked 210 machine-created rows as human:

| | rows | origin |
|---|---|---|
| A `related_table` set | 74 | `system` |
| B `clickup_automation_log` entry | 210 | `clickup` |
| C ClickUp id, no log entry | 30 | `clickup` (recorded judgement; all finished, none live) |
| D no id, no related_table | 11 | `user` |

**`clickup_enqueue` moved in the same migration.** Before:

```sql
if v_t.related_table is null then return false; end if;   -- not a SQL-created task
```

after:

```sql
if coalesce(v_t.origin,'') <> 'system' then return false; end if;
```

**New rows** get `origin` from `tg_tasks_set_origin`: an explicit value wins,
else `clickup_task_id` present → `clickup`, else **`auth.uid()` null → `system`**,
else `user`. The `auth.uid()` signal is the same one `tg_tasks_stamp_completion`
already uses for `completed_source`, not a second convention. Consequence, stated:
a sweep a **person** triggers by hand produces `origin='user'`, so those tasks are
not pushed to ClickUp — the safe direction, and identical to how `completed_source`
already behaves for that action.

**`task_list` and `va_daily_tasks` now read the column** instead of recomputing
the compound rule, so two mechanisms cannot disagree. Verified: the collapsed rule
differs from the old compound one on exactly 30 rows — all class C, **none live**.

## What this unblocks, and the one thing still to decide

Tagging is now **safe to build**: a human tagging a task gets `origin='user'`
whatever `related_table` says, so it is not enqueued to ClickUp. Proven with a
task carrying `related_table='referral_partners'` — `origin=user`, not enqueued,
while a `system` control was.

Still open: whether tagging uses `related_table`/`related_id` (now free to mean
subject) or dedicated columns. `related_table` is a single slot, so a task cannot
be tagged to both a partner and an order. That is the remaining design question,
and it is no longer entangled with provenance.

**Bulk actions remain held**; the design below is unchanged.

# Task tagging — built 2026-08-19

Design and alternatives: `docs/TASK-TAGGING-DESIGN-2026-08-19.md`. This is what
shipped.

## The columns

```sql
alter table tasks
  add column referral_partner_id uuid references referral_partners(id) on delete set null,
  add column loan_order_id       uuid references loan_orders(id)       on delete set null;
```

Partial indexes on each, `where … is not null` — the tagged set is tiny and is
the only thing ever queried.

**`on delete set null`, deliberately.** Deleting a referral partner must not
delete somebody's to-do; the task survives and loses its tag.

**Two columns, not one slot.** A task can be tagged to a partner *and* an order,
which is the case `related_table` could never express.

## The backfill

All **34** rows carrying `related_table='loan_orders'` + `related_id` now have
`loan_order_id`. **0 left behind.** The update was conditional on the
`related_id` actually resolving to a live order — a dangling id must not be
forced into a column with a real FK, and dropping the FK to accommodate one
would be the worse trade.

`order_reminders_run` now writes `loan_order_id` **alongside** the old pair, not
instead of it. Proven in a rolled-back run: `loan_order_id_set: 1` and
`related_pair_still_written: 1` for the same new task. Nothing that reads the old
shape breaks, and there is no moment in the changeover where a reader sees
neither.

Its duplicate-suppression check reads **both** shapes for the same reason —
checking only one would have raised a *second* reminder for every order tagged
the other way.

## The RETURNS TABLE hazard, handled

`task_list` and `va_daily_tasks` enumerate their columns, so new ones do not
reach the client unless added by hand. Both were extended, and three things had
to be right:

1. **Columns APPENDED, never inserted mid-list.** A `RETURNS TABLE` is
   positional; shifting one changes what every existing caller reads, and the
   runtime error names the column **number**, not the name.
2. **A drop is required.** Postgres refuses to change a function's row type
   (`cannot change return type of existing function`). Each migration is one
   transaction, so no caller sees a gap.
3. **Dropping also drops the GRANTS** — the part that would have broken the app
   silently, with the function present and every browser call failing
   `permission denied for function task_list`. Captured before dropping and
   restored explicitly. Verified after: the ACL is byte-identical to what it was.

`task_upsert` needed the same drop treatment for a different reason: adding
defaulted parameters produces a **different signature**, so `create or replace`
would have left the 8-argument version in place beside the 10-argument one and
made every existing call ambiguous.

Each function returns the two ids **and** a server-composed label
(`referral_partner_label`, `loan_order_label`), resolved by left-joining
`referral_partners` and `loan_orders`. Resolved server-side because the
alternative is every consumer joining both tables itself to draw a chip — three
round trips per list, and three places to disagree about what an order is called.
Left joins, so a tag whose target was deleted renders nothing rather than
erroring.

## `task_upsert` and the trap it does NOT repeat

The tag parameters **coalesce on update**, unlike `due_date` and `assigned_to`
beside them. That asymmetry is deliberate: `due_date = p_due_date` with no
coalesce is exactly why `task_assign_bulk` had to be written as its own
function, and an edit that changes a title must not silently untag the task.

**Consequence, stated rather than discovered:** because they coalesce, this
cannot *clear* a tag. Removing one needs its own call rather than a magic
sentinel value. Nothing clears tags today — the pickers set them at creation.

Both ids are validated against their tables before the write, so the caller gets
`no such referral partner` rather than a constraint name.

## What the task row shows when tagged

One small chip per tag, **before** the assignee chip, each carrying the label the
server composed:

```
🤝 First Team — Alex Duarte      (referral partner)
📋 ESCROW · Fidelity National    (third-party order)
```

- **Nothing is shown when nothing is tagged** — which is almost every row: 0 of
  327 tasks carry a partner and 34 carry an order. An always-present empty chip
  would add furniture to a list whose problem was already noise.
- Quieter styling than the assignee chip: whose the task is matters more than
  what it is about.
- Width-capped at 170px with ellipsis, full value in the tooltip — a title is
  worth more room than a tag.

## Provenance is untouched, and that is what made this safe

A human tagging a task still gets `origin='user'` from `tg_tasks_set_origin`, and
`clickup_enqueue` gates on `origin='system'`. So a tagged hand-typed task is
**not** exported to ClickUp. Verified in the round-trip below: `origin: user`,
`provenance: human`.

This is the whole reason tagging was blocked until `origin` existed. Reusing
`related_table` would have made 251 hand-typed tasks one tag away from being
pushed to ClickUp.

## The pickers

On the Add Task form, both optional:

- **Referral partner** — global list (9 rows), `company — First Last`.
- **Order on this lead** — scoped to this contact. A global order list would be
  a few hundred rows of other people's files, and a mis-tag there is one nobody
  would ever spot. Read straight from `loan_orders` rather than reusing
  `lpLoadOrders`' cache, which holds one row per order **type** and drops VOEs
  entirely — a VOE could never have been tagged through it.

Both fail soft: if a list cannot be read the picker keeps only its "no tag"
option and warns to the console. These are optional fields on a form whose real
job is creating a task; a partner query that 403s must not stop somebody writing
"call the borrower back".

**Both are cleared on close.** The title was already cleared and the pickers were
not, so the next task typed on the lead would have silently inherited the last
one's tags — a wrong tag nobody chose and nobody would look for.

## Proof

Self-cleaning spec `task tags — picker, save, and the chip on the row`: creates
its own order, checks both pickers offer options, saves a task tagged to a
partner **and** an order, reloads, and asserts the row renders exactly two chips
with the right glyphs and the order type in the label. Then deletes both.

Asserting the chip rather than the column is the point — the columns can exist
in `task_list` and still never reach the row, which is precisely what a
hand-enumerated `RETURNS TABLE` makes easy to get wrong.

Verified after: 0 leftover tasks, 0 leftover orders, 23 orders total, 34
order-tagged (the backfill), 0 partner-tagged.

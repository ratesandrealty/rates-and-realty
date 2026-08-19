# Task row: discoverability and the signals it was throwing away

Built 2026-08-19. Reported before building in the same session; this is what
shipped and what was deliberately left.

## 1. Bulk actions — affordance only, the wiring was fine

**Measured first, and it changed the fix.** The bar was fully wired: checkbox
14×14 visible, bar `display: none` → `flex` on tick, all six controls present
(`Select all shown · Clear · Assign to… · Assign · Complete · Delete`). Nothing
was broken.

A first measurement said every element was **0×0**, which reads as a CSS bug. It
was not: the Tasks tab was closed and the whole panel was `display:none`.
Re-measured with the tab open and everything had real size. **That artifact would
have sent the fix in exactly the wrong direction** — restyling a checkbox that
was never mis-styled.

So the real problem was that **nothing on screen said selection was possible**.
The bar only existed *after* you ticked something, and a bare native checkbox
beside the round complete-toggle reads as decoration.

- **A header row**: a select-all box and the words *"Select for bulk actions"*,
  plus an `N shown` count. Present before anything is ticked, which is the whole
  point.
- **`tkSelAllToggle` works both ways.** A select-all that cannot unselect is a
  trap: the only way back would be unticking every row by hand.
- **The header box stays honest** — `_tkSyncSelAll` sets `indeterminate` when
  some but not all are ticked, and `Clear` unticks it. Two controls showing the
  same state must not disagree.
- **The bar is `position: sticky`.** It sits above the rows, so on a long list
  ticking a row far down put the count *and Delete* above the fold — acting on a
  selection you cannot see.

## 2. `no_date` is the majority state and was invisible

`bucket` has always returned `overdue | today | upcoming | no_date`. Only
`overdue` was rendered, and the due line was omitted entirely when there was no
date — so **29 of 42 live tasks showed nothing** where the date goes and looked
identical to one due next week.

| state | rendering | live count |
|---|---|---|
| overdue | red, bold, `⚠ Due …` | 7 |
| today | gold, bold, `Due today · …` | 0 |
| upcoming | muted, `Due …` | 6 |
| **no date** | **faint italic, `No due date`** | **29** |

**`no_date` is the quietest of the four on purpose.** It is not a fault, it is an
unmade decision — and 29 amber rows would be a wall of alarm that teaches people
to ignore the colour that does mean something.

The bucket comes from the **server**, not recomputed in the browser: `task_list`
computes it in UTC, which is what `tasks.due_date` holds, and a second rule for
"is this overdue" would drift from the one the VA's board uses. `overdue` is
still passed separately because it also accounts for done/cancelled — finished
work cannot be late.

## 3. Provenance, from `origin` — never a heuristic

320 of 331 tasks are machine-made and an ordinary one looked exactly like
something Rene typed. Machine rows now carry a quiet `⚙ auto` chip whose tooltip
names the source (stale-lead sweep / order reminder / automation).

**Only the machine case is marked.** Human is the unmarked default: 11 rows carry
it, and badging both would double the furniture to say the same thing twice.

Read from `provenance`, which `task_list` computes from `tasks.origin`. The
compound rule this replaced — `related_table`, or a `clickup_automation_log`
entry — misclassified **210 machine rows as human**, which is why `origin` exists.

**Skipped: `question_pending`.** Wired end to end, **0 rows today**. Styling a
state that cannot be seen proves nothing.

## 4. Order cards show their own tasks

38 tasks carry `loan_order_id` and every one was raised by
`order_reminders_run` — visible only in the Tasks tab, with nothing saying which
order it came from. Order cards now show `📋 N open task(s)`, which switches to
the Tasks tab when clicked.

- **Open tasks only.** A card reading "3 tasks" that are all completed sends
  somebody looking for finished work.
- **Silent at zero**, because most orders have none and a `0 tasks` label on
  every card is furniture.
- **One query per pane**, not per card — `_lpLoadOrderTaskCounts` runs once in
  `lpLoadOrders`; six cards would otherwise be six round trips to the same
  question. Fails soft: a card that cannot count still renders the order.

## 5. HELD: the partner section — but the name collision is documented

**Not built: 0 tasks are partner-tagged, so it would be an empty surface.**

What *was* done is the part that would mislead somebody. `contacts.referral_partner_id`
and `tasks.referral_partner_id` share a name and answer different questions, and
an entire server-side family reads the first — `partner_leads`,
`partner_overview`, `partners_needing_followup`, `partner_goal_get`,
`recompute_partner_totals`, `power_dialer_queue`'s partner filter, the
`people.html` filter, the referral-partners deep link. **Not one of them reads the
second.**

Renaming was considered and rejected: `tasks.referral_partner_id` is the correct
name for what it holds, and renaming it to avoid a confusion a comment can dispel
would make the column read oddly forever. The danger is not the name, it is the
**assumption that partner reporting already includes tasks**. Both columns now
carry a `COMMENT` saying exactly that, because a comment is where somebody checks.

## Proof

One self-cleaning spec, `task row shows due state, provenance and the select-all
header`:

```
nodate=No due date overdue=yes upcoming=yes humanNoAutoChip=yes
autoChipRenders=⚙ auto header=yes selectAll=yes sticky=sticky
```

It creates its own fixtures — including a **machine-origin row inserted directly
with an explicit `origin`**, because `task_upsert` cannot produce one
(`tg_tasks_set_origin` stamps `user` for anything a signed-in human creates).

**That row is why the assertion means anything.** Checking only that a human task
*lacks* the chip would pass for a chip that never renders at all. Both directions,
or it proves nothing. Verified afterwards: 0 leftover ZZ-TEST tasks.

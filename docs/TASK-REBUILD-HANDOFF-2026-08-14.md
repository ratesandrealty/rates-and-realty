# Task system rebuild — handoff

**STATUS as of 2026-08-15: Steps 1-4 are shipped and deployed. Steps 5 and 6
remain.** This file was written on 2026-08-14 describing Step 3 as half-done
with two unmerged branches; that is no longer true and the sections below have
been corrected in place rather than appended to.

Nothing in this document is a plan. It is what is true in the repo and the
database right now.

---

## Decisions already taken (do not re-litigate)

| decision | outcome |
|---|---|
| Reminder due date | next business day at **17:00 UTC**, uniform, no per-kind SLA |
| Re-stamp the 11 open born-overdue rows | **only in the pass that ships the nudge** (Step 6). Not done. |
| The 17 closed born-overdue rows | left alone — a completed task's due date is a record of what happened |
| `tasks.due_date` convention | **UTC** |
| Assignment model | **Option C** — explicit owner plus a visible Unassigned bucket |
| Backfill of unassigned rows | **zero rows**, see below |
| `processing_items` | **not merged**. Surfaced read-only in the task views instead. |
| `tg_tasks_autoassign` | **stays** |
| `_task_clickup_sync` | seam exists, no-ops until Step 4 |

### Why the backfill became zero rows

The plan was to stamp "the 5 manual open unassigned tasks" to Rene. Listing them
first — which the gate existed for — showed all five are machine-generated:
four from the `new_lead` automation rule, one from `task_stale`.

`related_table IS NULL` is **not** a proxy for "a person made this". It is set
only by the two SQL creators (`order_reminders_run`, `surface_stale_leads`); the
ClickUp automation path leaves it null. **198 of the 234 null-`related_table`
tasks are automation output, and there are zero human-created open unassigned
tasks.** So Mine renders empty, and that is the true state.

---

## Shipped and live on `main`

```
ebba98f  CLAUDE.md: three Postgres-layer traps that each caught a second author
0ad0dd1  Task RPCs written and proven; five status filters that dropped pending/question
1d3fdef  va_daily_tasks: three-way assignee, UTC buckets, provenance from the log
b465924  Task dates: cancelled is not overdue, due_date is UTC, reminders next business day
```

### Step 1 — three date bugs

- **Cancelled rendered red.** Overdue tested `status !== "completed"`. Now a
  shared `crmIsLive()` excluding both terminal states. Red count **19 → 16**.
  Written as "not terminal" rather than `=== 'open'` deliberately, so
  `status='question'` cannot fall out of the overdue views later.
- **198 rows displayed 7 hours late.** Eight raw `new Date()` parses of a
  zone-less UTC column moved to `_rrD()`. `"Follow up with Andres"` stored
  `2026-08-08 17:00:00` displayed *Aug 08, 05:00 PM* and now displays
  *Aug 08, 10:00 AM*.
- **`order_reminders_run` tasks were past due at birth** —
  `(now() at time zone 'America/Los_Angeles')::date` is midnight today. Now next
  business day at 17:00Z, weekends skipped. Proven end to end against a ZZ-TEST
  fixture order inside a transaction that rolls back, on a Friday, landing
  Monday 17:00 and not overdue.

### Step 2 — assignment model

- `va_daily_tasks.assignee_state` is now **unassigned / mine / other**. It was
  `mine` else `unassigned`, which labels somebody else's task "unassigned".
- Its overdue bucket moved Pacific → UTC. **Zero tasks change bucket at midday,
  which is the misleading number**: the two calendars differ 17:00–00:00
  Pacific, almost exactly the VA's 5pm–2am shift.
- Provenance now reads `clickup_automation_log`. The old heuristic
  (`clickup_url` or `assigned_by` present → human) was wrong on **201 of 297**.
  Known residual, measured: two completed `rate_lock_5d` rows from 2026-06-18
  have no log entry and still read `human`. No open task affected.

### Step 3 — the SQL-verifiable half

- **`task_list` / `task_upsert` / `task_set_status`** written and proven against
  production data: admin live 44/44, all 297/297, buckets partition
  0+10+34 = 44; VA `task_list('all')` ≡ `va_daily_tasks()` with id-set
  difference **0**. `pending` and `question` exercised by rolled-back fixtures,
  since production has zero of each.
- **`_task_clickup_sync`** — no-op seam, called by both write RPCs.
- **Five status filters fixed**: `calendar-data` (cancelled tasks were on the
  calendar, plus a missing `is.null` arm), `va_productivity_report` ×4 sites
  (`open_now`, `overdue_now`, the `backlog` CTE and `open_aging` — the last two
  found only by re-checking after the first patch), and three dead `'dismissed'`
  exclusions removed.
- **`admin-api-v2.js`** `select("*")` → all 22 columns named.

**`in_progress` was never a legal status.** No migration in
`supabase_migrations` mentions `tasks_status_allowed` or `in_progress`; the
constraint predates the tracked history. Proven directly:
`in_progress REJECTED by CHECK | pending accepted | question accepted`.

---

## Step 3 — ALL SIX SURFACES MERGED AND DEPLOYED (2026-08-15)

The two branches described here as unmerged are merged. Every surface was
verified in a real browser BEFORE merging, with the branch file served by
request interception against the real backend, using the automation account.

| # | surface | evidence |
|---|---|---|
| 1 | `admin/js/task-capture.js` | one row per capture (297→298), `related_table` null, `assigned_by` stamped |
| 2 | `admin/people.html` | 1044 rows before and after, 0 errors; create→update→complete round-tripped |
| 3 | `admin/va-tasks.html` | 3 cards both sides, text byte-identical; Complete and Park driven through the UI |
| 4 | lead-detail Tasks tab | 0 → 6 rows on a real lead; break test showed the failure instead of an empty list |
| 5 | `components/admin-dashboard.js` + board | va refused / admin allowed on one card, **no writes observed** |
| 6 | `calendar-data` | counts identical before/after; four DB sources now report failures instead of returning `[]` |

Two defects were fixed along the way that the surfaces exposed: the Tasks tab
had been blind to 293 of 298 tasks, and `people.html` filed every hand-typed
task as automation output.

## Step 4 — ClickUp outbox, SHIPPED 2026-08-15

39 SQL-created tasks that had never reached ClickUp are now there. See the
Step 4 section at the end of this file for the reconciliation analysis, which
is the part worth reading before changing any of it.

## Sessions are no longer a blocker

`node tools/automation-session.mjs` mints a token for the `automation@` service
account — its own session, its own rotated refresh token, never Rene's. Use
`--token` for anything auth-gated.

`/dashboard/admin` additionally gates on `requireAdmin()`, which reads a
hardcoded `ADMIN_EMAILS` allowlist that the bot is deliberately NOT on. To reach
it in a test, intercept `/api/env.js` and append the bot to `ADMIN_EMAILS`
**inside the headless browser only** — config, not code, production untouched.
See `docs/ADMIN-AUTHORITIES-2026-08-15.md`.

Still outstanding from Step 3: consolidating `add_task_note` onto
`task_note_add` (different functions, not duplicates — `task_note_add` is the
superset and sets `status='question'`), and the VA task panel in lead-detail
(`:18240`, `:18249`, `:18313` `va_task_add`, `:18336` `va_task_set_status`,
`:18543` `add_task_note`). No RPC has been dropped, so nothing breaks meanwhile.

## The VA-session analysis

**The ZZ-TEST fixture cannot hold a role.** `aa74cc5e-2186-4b40-8608-3d2aa033b9ca`
is a `contacts` row. Roles live on `auth_user_roles.user_id → auth.users`. A
contact is not an auth user.

**Creating a second va-role user would break production for as long as it
existed.** `va_account_uid()`:

```sql
select (array_agg(user_id))[1]
from (select user_id from auth_user_roles where role = 'va' limit 2) q
having count(*) = 1;
```

Null unless there is **exactly one** va. A second one makes it null, and
`tg_tasks_autoassign` silently stops routing order-chase tasks to Aubrey. All
nine open `loan_orders` tasks reach her that way.

**Neither is necessary.** The refusal splits in two:

- **Server half — already proven**, rolled back, no session used:
  ```
  current_app_role()=va | VA reopen REFUSED: Reopening a completed task is
  restricted to admins | admin reopen allowed
  ```
  Same row, same statement, opposite outcomes by role.
- **Client half** — `crmDropRefusal` reads `sessionStorage.rnr_app_role`, which
  `auth-guard.js` writes from `current_app_role()`. A **render-check spec at
  `role: 'va'`** produces a genuine va-role client session; the stub supplies
  the role, which is the predicate's *input*, not the behaviour under test.

So: verify the client refusal with a render-check spec at `role:'va'`. Do not
use Aubrey's real account, and do not create a second va.

---

## Board reality check before judging it

**CORRECTION, 2026-08-15: this is NOT Aubrey's board. It is Rene's.** The CRM
task board lives on `/dashboard/admin`, which `requireAdmin()` gates on the
hardcoded `ADMIN_EMAILS` allowlist — `["rene@ratesandrealty.com"]`. A VA is
redirected to `/admin/people.html`, her login routes her to
`/admin/va-dashboard.html`, and `people.html` deliberately hides the Dashboard
link from her. Edge logs over the full 24h retention window show her hitting
`va_dashboard`, staff chat and `presence_beat`, and never an endpoint only this
page calls. See `docs/ADMIN-AUTHORITIES-2026-08-15.md`.

The board work stands unchanged — the Blocked column, inert cancelled cards and
the refusal are all still correct, and the va-role refusal still matters because
the predicate reads `sessionStorage.rnr_app_role` and would fire the moment a VA
ever did reach the page. What was wrong is the audience: any argument of the
form "gating this would be worse for Aubrey than for Rene" is backwards, because
she is not on this page at all.

Her surfaces are `/admin/va-dashboard.html` and `/admin/va-tasks.html`.

With the Open chip meaning `crmIsLive()`, the default board is:

| chip | To Do | Pending | Blocked | Complete |
|---|---|---|---|---|
| open | **13** | 0 | 0 | 0 |
| completed | 0 | 0 | 0 | 59 |
| all | 13 | 0 | 0 | 59 |

Thirteen cards beside three empty columns. Pending and Blocked stay empty until
the workflow writes those statuses — `pending` from the VA panel's park button,
`question` from `task_note_add`. Both exist; **neither has ever been used.**
That is an argument for doing Steps 5–6 before judging the board, and an
argument against merging the board branch on its own merits.

---

## Steps 5–6, not started

5. **UI** — date picker, collapsible VA board, lead-detail Tasks tab with
   Mine/Aubrey's/Unassigned separated, read-only loan checklist from
   `va_processing_board`. Also the deferred `clickup-auto-create` `setHours(17)`
   question: it writes 17:00 **UTC** because Deno's local time is UTC, so 198
   rows mean 10:00 Pacific where 17:00 Pacific was probably intended. Existing
   rows do not move if it changes.
6. **Daily nudge, last.** Must not fire on cancelled, must respect UTC, must not
   alert on anything born overdue. **Do not live-probe it** — an unauthenticated
   probe of `loan-date-nudges` once texted Rene's real phone. Use
   `+1 714 555 0142` and confirm the send path is stubbed first.

---

## Step 4 — the ClickUp outbox, and the reconciliation it had to survive

`order_reminders_run` and `surface_stale_leads` INSERT into `tasks` directly, so
39 open tasks had never reached ClickUp. They are there now.

### The shape

```
tasks AFTER INSERT ─► trg_tasks_enqueue_clickup ─► clickup_enqueue ─► clickup_outbox
                                                                          │
                          cron 46, */5 ─► clickup-bridge /outbox-drain ◄──┘
```

A trigger cannot make the HTTP call: `order_reminders_run` is SECURITY DEFINER
inside a pg_cron transaction, and an outbound call from there ties the
reminder's existence to ClickUp being reachable. `_task_clickup_sync` — the
Step-3 no-op seam already called by `task_upsert` and `task_set_status` — now
enqueues too. **No new call sites were added.**

### WHICH tasks, and why not "clickup_task_id IS NULL"

The literal rule would sweep up hand-captured tasks where somebody
**deliberately unticked ClickUp** in the capture widget and push them anyway.
The two SQL writers are identifiable positively instead:

```
order_reminders_run  ->  related_table = 'loan_orders'
surface_stale_leads  ->  related_table = 'auto_followup_lead'
```

Verified before relying on it: **0 tasks have BOTH `related_table` and
`clickup_task_id`**, so the marker separates SQL-created from bridge-created
work cleanly, and the bridge's own insert already carries the id at INSERT time
so the trigger skips it. Measured at backfill: 42 open tasks lacked a ClickUp
id, **39** carried `related_table`; the other 3 were hand-captured CRM-only and
were correctly left alone.

The coupling is worth stating: `related_table` also means "a machine made this"
to `task_list` and `va_daily_tasks`. If a human write path ever sets it again,
those tasks start syncing as a side effect. Two did until 2026-08-15 —
`people.html` and lead-detail both wrote `related_table='leads'` — and both were
moved off it, which is what makes the marker safe to use now.

### The reconciliation question, answered before it ran

`syncPull` completes any CRM task whose ClickUp counterpart has vanished.

**Could the first drain mass-complete anything? No — structurally.** `stale` is
built from ClickUp ids in `clickup_task_cache`; the 39 had `clickup_task_id
IS NULL`, so they were in neither the cache nor `stale`, and `.in(...)` cannot
match NULL. A drain only CREATES, so `liveIds` only grows.

**What happens to a task deleted in ClickUp by mistake** (within ≤15 min, cron 15):

- It does **not** fire when a task is merely *closed* — the fetch uses
  `include_closed=true`. Only **delete**, **archive** or **move to another list**.
- The task is now set to **`cancelled`, not `completed`**. "Deleted in ClickUp"
  is not "the work was done", and recording them identically put false
  completions in the history: 167 of 251 completed tasks were
  `completed_source='system'`, 164 with no surviving cache row.
- A **`task_activity` row** is written (`kind='cancelled_clickup_missing'`) with
  the ClickUp id and list. The old path was a direct UPDATE and left no trace.
- **CRM-origin tasks are exempt** — anything with a `clickup_outbox` row.
  ClickUp's absence must not cancel work the CRM invented, and
  `order_reminders_run` would recreate it on the next run: a churn loop.
- Recoverable: `fn_tasks_block_reopen` blocks only `va`/`agent`, so an admin can
  reopen.

**Origin is read from `clickup_outbox`, not a flag.** A row there is the record
that the CRM created the task and pushed it out — a fact about what happened
rather than something somebody must remember to set. Outbox rows are kept after
sending for exactly this reason, and no backfill was needed: every task
predating the outbox is bridge-origin by construction.

### The guard, and where a skip shows up

`fetchAllTasksFromList` pages at most 10 × 100. **Past 1000 tasks the remainder
is simply absent, and the old code read "absent from my page window" as "deleted
in ClickUp"** — which would cancel every unread task in one tick, silently. The
list holds ~351 today, but the outbox exists to push more into it.

`fetchAllTasksFromList` now returns `{ tasks, complete }`, and
`clickup_prune_missing` **refuses to reconcile** when `complete` is false.

**A skipped prune writes a notification to the CRM bell** via
`app_notify_system` (`source_kind='clickup_sync'`, admin role, links to
`/dashboard/admin#tasks`) — not a log file. `syncPull` also returns
`prune_skipped` and a `reconciled` array rather than folding it into `pruned:0`,
because "skipped the prune" and "found nothing stale" both report zero and are
very different facts.

### Proofs (2026-08-15)

| | result |
|---|---|
| `order_reminders_run` on the fixture, rolled back | outbox 0 → 1, `related_table=loan_orders`; **hand-captured control NOT enqueued** |
| guard, rolled back | incomplete fetch → `ran:false`, 0 cancelled, 1 notification written |
| cancel semantics, rolled back | bridge-origin → `cancelled` + activity row; CRM-origin → untouched |
| real drain | ClickUp `86e2uvr9x` created, id/url/list written back, cached |
| break (bad list id) | `failed:1`, **HTTP 207**, `validateListIDEx List ID invalid`, row stayed `pending` with `attempts=1` and a backed-off retry; recovered on the next drain |
| idempotence | outbox forced back to `pending` with the task already linked → `already_linked:1`, `sent:0`, **one** ClickUp task |
| backfill | 39 queued, drained 25 + 14, **39 sent, 0 failed, 0 still invisible** |

Fixture ClickUp tasks deleted afterwards; probe rows removed.

### Known limits

- **`OUTBOX_MAX_ATTEMPTS = 6`** then the row is `failed` and stops. Nothing
  watches `clickup_outbox` for `status='failed'` yet — that is the obvious next
  monitor, and the cheapest one in this project.
- The drain does **create only**. It does not push later edits or status changes
  to ClickUp; `task_set_status` still only enqueues, and an already-sent row is
  a no-op.
- The leads embed in `admin-api-v2` still falls back to a flat select
  (pre-existing, unrelated).

# Task system rebuild — handoff, 2026-08-14

Steps 1–3 of a six-step rebuild. **Steps 1 and 2 are shipped. Step 3 is half
shipped: everything verifiable by SQL is live; every page change is on a branch,
unmerged and unverified, because no admin session token was available.**

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

## On branches — unmerged, unverified, NOT deployed

Both branch off `main`. `main` matches production.

### `step3-s1-task-capture` — 1bf2eea

`admin/js/task-capture.js` (+53 / −21)

- `createCrmTask` → `task_upsert`. RPC proven with that exact parameter set.
- `related_table='email_thread'` removed. Only this file wrote it, `related_id`
  was never set beside it, nothing reads it, no row carries it — and it would
  now make a hand-captured task read as machine-made.
- **A duplicate-row bug fixed.** `clickup-bridge POST /task` also inserts into
  `tasks` when `contact_id` is set, so ticking both destinations on a lead made
  two rows. Observed once in production: `"test task"`, 2026-08-07 22:33:01 and
  :03, 1.6s apart.

**Unverified:** open the widget, capture, confirm ONE row lands with the right
description.

### `step3-board-pending-mapping` — 1806005, f555450

`components/admin-dashboard.js` (+94 / −10), `dashboard/admin.html` (+16 / −1)

- Dead `in_progress` column mapped to **`pending`**. Dropping into it previously
  wrote a value the CHECK refuses — the column threw rather than being merely
  empty.
- **`question` gets its own Blocked column**, out-only: a question is set by
  asking one through `task_note_add`, not by dragging.
- **`cancelled` is inert** — `draggable="false"`, 55% opacity, struck-through
  badge, refused from every target. The drag selector also moved from
  `[draggable]` to `[draggable="true"]`, which matched regardless of value.
- **The dead drag is gone.** `dragover` and `drop` read one `crmDropRefusal()`,
  so a refused column shows `not-allowed` and never accepts.
- Open chip now means `crmIsLive()`, so `pending` and `question` stop being
  invisible.

**Unverified, and this is the largest unverified surface in the project.**

---

## What still needs a session token

Nothing below has been done. Order is fixed and frontend-first: move one page,
confirm it in a real browser, then the next. **Do not drop any old RPC until
every page is off it.**

1. `admin/js/task-capture.js` — built, verify
2. `admin/people.html`
3. `admin/va-tasks.html`
4. `admin/lead-detail.html` Tasks tab
5. `components/admin-dashboard.js` — merge the board branch, verify
6. `calendar-data` edge function

Also outstanding: consolidating `add_task_note` onto `task_note_add` (they are
different functions, not duplicates — `task_note_add` is the superset and sets
`status='question'`), and `lead-detail.html:7047` which has no question/pending
distinction.

### Board checks that need a real session

| check | session |
|---|---|
| Blocked column renders and refuses drops | any |
| A cancelled card cannot start a drag | any |
| Complete → To Do refusal fires with the not-allowed cursor and no write | **must be `va` role** — as admin it is allowed and proves nothing |

---

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

## Steps 4–6, not started

4. **ClickUp outbox** — a table plus a five-minute cron drain, replacing
   `_task_clickup_sync`'s body. 38 open automated tasks are invisible in ClickUp
   today. Decide deliberately: the bridge marks CRM tasks completed when the
   ClickUp counterpart disappears, and that would start applying to them.
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

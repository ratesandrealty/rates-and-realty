# Two reports before building the image activation

---

# 1. Is `get_thread`'s write side a problem here? — Yes, but not the way I expected

## What it actually writes

| step | writes? | idempotent? |
|---|---|---|
| `matchContact(svc, participants)` | no — resolves a contact | — |
| `persistMessages(svc, rows, contact_id)` | **YES — inserts into `email_log`** | **yes**: `.upsert(payload, { onConflict: 'gmail_message_id', ignoreDuplicates: true })` |
| `escrowSuggestion(...)` | **no** — reads `email_thread_suggestion_dismissals` and returns a verdict | — |
| `email_thread_tags` | read only | — |

So the escrow suggester is **not** a write hazard, and re-persisting the same
messages inserts nothing. On repetition, `get_thread` is safe.

## The real problem is the FIRST call, not the repeat

`persistMessages` runs whenever a participant matches a known contact or vendor,
and it files **every message in the thread** into `email_log`.

Today that happens when somebody **expands a thread** in the Email Threads panel —
a deliberate act on a thread they chose. Calling `get_thread` to resolve images
would make it happen **as a side effect of viewing one stored message**: opening a
VOE email preview would file the whole surrounding thread into the system of
record, including messages nobody opened.

It is idempotent, so it cannot duplicate. It is not inert, because the first call
changes what is in `email_log` — and `email_log` is what the timeline, the
activity feed and `hoi_quote_list` all read. **Viewing should not file.**

Two further costs, smaller but real: a full `threads/{id}?format=full` Gmail round
trip per view, and `matchContact` re-running on every one.

## The alternative, and it is already proven here

**Do not call `get_thread`. Add a narrow read-only action.**

`get_attachment` already does exactly the shape needed — `messages/{id}?format=full`,
no persist, no match, no escrow — so this is not new territory:

```
action: 'get_inline_images'
  → gmailApi(mailbox, `messages/${id}?format=full`)
  → collectInlineImages(payload, body_html)     // the existing helper, :281
  → return { inline_images: [...] }
```

No writes at all. One message, not a thread. And `collectInlineImages` is the same
function `get_thread` uses, so the two paths cannot describe a message's inline
parts differently.

## Authorization — inherited, not re-implemented

`resolveMailbox` runs **once per request, before any Gmail call**, and builds from
`allowedMailboxes(role)` (`gmail-inbox:103`, enforced at `:630`). A new action
inside `gmail-inbox` inherits that gate automatically: a va passing `rene@` is
refused server-side regardless of what the client sends.

**This is the argument for putting the action in `gmail-inbox` rather than
fetching from anywhere else.** The Email Threads panel's client-side filter on
`t.mailbox` is a courtesy that hides threads a role cannot open; the server gate is
the control. Neither is widened by this change — the client keeps passing the
mailbox it already knows, and the server keeps refusing the ones it always did.

---

# 2. Why the pins went stale — the check was never bypassed

## Both gates exist and are in the path

```
wrangler.toml   [build]  command = "node tools/stamp-assets.mjs --check"
tools/deploy.sh 4/6      if ! node tools/stamp-assets.mjs --check; then … abort
```

And there is **no other deploy path**: no `.github/workflows`, no CI config, no
Pages git integration. `wrangler.toml` declares a Worker
(`main = "src/worker.js"`), so the only way to ship is `wrangler deploy` — directly
or through the script — and both run the check.

## So nothing bypassed it. It refused, and nobody deployed.

The drift traces to 2026-08-15 (`api/admin-api-v2.js` in `232c70c`,
`dashboard/utils/calendar.js` in `2bb088c`). From that point the `--check` failed,
so **every deploy attempt would have aborted at the gate**.

**52 commits touched site files between 2026-08-15 and today** and none of them
reached production. Today's deploy shipped all of them at once.

## Which means I overstated the consequence, and should correct it

I wrote — and it was repeated back — that *"returning browsers are frozen on old
code for nine assets."* **That is not what stale pins do.**

A stale pin is a mismatch **inside the repo**: the HTML asks for a hash the current
asset bytes no longer produce. The **live** site was internally consistent, because
it was serving whatever the last successful deploy shipped, and that deploy passed
`verify-deploy` at the time. Browsers were correctly cached against a coherent
older version.

The real consequence was not stale caches. It was that **the gate had been holding
five days of committed work out of production**, silently, because a failing
pre-deploy check only speaks to whoever runs a deploy — and nobody did.

## What that suggests is missing

The check is correct and it worked. What is absent is anything that notices the
check is *failing* when no one is deploying:

- `stamp-assets --check` in whatever runs routinely, so stale pins surface within
  a day rather than at the next deploy attempt;
- or an alert on "last successful deploy" age, which would have said *five days*
  out loud.

Both are the same shape as `monitor_runs` in `CLAUDE.md`: the gate's own history is
worth recording, because a gate that quietly refuses looks exactly like a gate that
was never reached.

---

# The deploy watcher — options, and what was built

## The three options, and which one catches the case that happened

### Option 1 — `stamp-assets --check` on a schedule

**Does NOT catch it.** Two reasons, and the second is fatal:

1. It needs the **repo working tree** to hash the assets. The other monitors run
   as pg_cron + edge functions with no checkout, so this could only run on a
   developer machine — a watcher that dies with a laptop.
2. Even if it ran, it detects **stale pins**, not **undeployed work**. If the pins
   had been clean and nobody deployed for a fortnight, it would have said nothing.
   Stale pins were the *cause* here; they are not the *condition*.

There is a cloud-runnable cousin — compare live HTML pins against live asset bytes,
which is what `verify-deploy` does — and it is worth knowing that **it would also
have stayed green**. The live site was internally consistent throughout; it was
just five days old.

### Option 2 — alert on the age of the last successful deploy ✅

**This is the one.** It fires on the *condition* — nothing has shipped — whatever
the cause: stale pins, a failing build, a broken credential, or simply nobody
running a deploy. That last case is the one that happened, and it is the only
option that catches it.

It also needs nothing the database does not already have.

### Option 3 — both

Worth having eventually, but option 1 adds detection only for a cause that option 2
already catches by its effect, at the price of a watcher that needs a checkout.
**Build 2 first; it is the whole of the failure that occurred.**

---

## What was built

### `tools/record-deploy.mjs` — the heartbeat

Stamps `system_state:deploy:last_success` with the commit, branch, subject, host
and whether the tree was dirty. Wired into `deploy.sh` **last and non-blocking**,
after `verify-deploy` has already passed — the same discipline as
`observe-db-functions` above it. A failure here can never fail a deploy that
worked.

It only knows about deploys through `deploy.sh`. A bare `wrangler deploy` leaves
the marker stale and the watcher eventually says so — which is the right
direction, because a bare deploy is already what `CLAUDE.md` tells you not to do.
**The false alarm is the nudge.**

### `deploy_watch_run(p_notify boolean)` — the watcher

**Pure SQL on pg_cron, not an edge function.** Everything it needs is already in
the database — `system_state` for the heartbeat, `app_notify_system` for the bell.
No HTTP, no secrets, no CORS, nothing to deploy. That last point is the argument:
**a watcher whose job is to notice the deploy path is broken should not depend on
the deploy path.**

It reaches the **notification bell**, via the same `app_notify_system` helper the
other system notifications use — `actor_display: 'Deploy watcher'`, roles
`['admin']` — not a log nobody reads.

**Three outcomes, not two**, per `CLAUDE.md`:

| state | when | notifies |
|---|---|---|
| `fresh` | age ≤ threshold | no |
| `stale` | age > threshold | yes |
| **`unknown`** | **no heartbeat at all** | **yes** |

`unknown` is the important one. A missing heartbeat is what a broken
`record-deploy.mjs` looks like, and it must not read as healthy — *never add a
check that can pass when it could not run*.

Thresholds live in `app_config` (`deploy_watch_threshold_hours`, default **48**;
`deploy_watch_quiet_hours`, default **24**) so they can move without a migration.
`p_notify => false` evaluates without sending or consuming the quiet period — the
same idea as `gdrive-health-monitor`'s `no_alert`.

pg_cron job **52 `deploy-watch`**, `17 */6 * * *`.

### Broken before trusted

All three states forced, and both alert directions:

```
1. no heartbeat            -> unknown   "NO DEPLOY HEARTBEAT RECORDED … not healthy, unverified"
2. deployed 1h ago         -> fresh     no body
3. deployed 5d ago         -> stale     "nothing has deployed for 120.0 hours (5.0 days)"

4. first stale run  notify=true  -> notified=true,  1 row in app_notifications
5. immediate repeat notify=true  -> notified=false, still 1 row   (quiet period held)
```

The bell row reads *"Deploy watcher: nothing has deployed for 120.0 hours (5.0
days). Last verified deploy 2026-08-15 13:10 PT (abc1234)…"* — the exact shape of
the incident it exists for. Test notification and fabricated heartbeat both
deleted afterwards; the first real heartbeat is `4354d9f`, and the watcher now
reads `fresh`, age 0.

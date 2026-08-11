# Reports: dead-cron correction, escrow index design, masking sweep

## 1. The "three dead cron functions" — I WAS WRONG

I reported `refi-watch`, `critical-date-reminders` and `post-close-followups` as
having no caller and never having had one. **That was wrong, and the error was in
my method: I checked `cron.job` and the repo, and never enumerated n8n.**

All three are wired, active and scheduled — in n8n, not pg_cron:

| function | n8n workflow | schedule | active |
|---|---|---|---|
| `critical-date-reminders` | `f1udN0aJRWAb1wqw` Critical Date Reminders | daily 15:00Z | yes |
| `refi-watch` | `ytTeqc76TVymCQGN` Refi Opportunity Watch | Mon 15:00Z | yes |
| `post-close-followups` | `aI0ADzLLDDv0R1qM` 5-Month Post-Close Touchpoint | daily 15:00Z | yes |

Each is: schedule trigger → HTTP POST with `x-cron-key` → splitOut → **create a
ClickUp task** in list `901708416155`.

**What they do.** `critical-date-reminders` scans `loan_key_dates` and raises a
task at 3 days out, 1 day out and day-of, deduped through
`loan_key_dates.reminders_sent`. `refi-watch` compares each past client rate to
the latest `market_rates` row and raises a task for anyone 0.50%+ above market,
with an AI-written note. `post-close-followups` raises a 5-month touchpoint task
for closed loans.

**Is any of it happening another way?** Partly. `loan-date-nudges` (pg_cron 38)
covers similar ground for critical dates but delivers an SMS digest to staff
rather than ClickUp tasks, and writes `nudge_sent`, not `reminders_sent`. The
refi and post-close jobs have no other implementation.

**The tell I had and misread:** `loan_key_dates.reminders_sent` is populated on
14 of 22 rows, June–August, and nothing in the repo writes that column except
`critical-date-reminders`. I saw that data and still concluded the function was
dead. Evidence that something RAN should have outranked evidence that nothing
called it.

`refi_alert_last_at` and `post_close_task_at` are 0 rows — consistent with those
two running and finding nothing to do (6 closed loans, none 5 months old, none
0.50% above market), not with never running.

### Consequence: the key rotation broke all three, and it is repaired

The rotation killed the old literal. All three n8n HTTP nodes still carried it,
so each would have started returning 401 — silently, because nothing watches n8n
executions. Caught roughly 8 hours before the next daily run.

All three workflow nodes now send the vault value (recorded in n8n version
history). The secret lives in the vault and in n8n — the caller has to hold it —
and no longer in git.

**The general lesson: "no caller" only ever meant "no caller I looked for."**
n8n is a caller class I never enumerated, and it reaches edge functions over
plain HTTPS with a header. Anything else called uncalled should be re-checked
against n8n before being believed.

## 2. Second escrow/title per file — design only, NOT applied

Both dependencies must be fixed BEFORE the index changes.

### a) `lead-detail.html:10724` must fail loudly, not blank the field

```js
.eq('contact_id',cid).eq('order_type','escrow').maybeSingle()
```

`.maybeSingle()` errors on more than one row, and the surrounding
`catch(_){ _lpEscrowRef=''; }` swallows it — so the field renders an em dash and
the number simply disappears. Silent, and indistinguishable from "not entered
yet", which is the worst possible reading of "two escrow orders exist".

Replace with an explicit list and make ambiguity visible:

```js
const _eo = await _authClient().from('loan_orders')
  .select('id,reference,status').eq('contact_id',cid).eq('order_type','escrow')
  .order('ordered_at',{ ascending:false, nullsFirst:false });
if (_eo.error)                    -> render "could not load", not an em dash
else if ((_eo.data||[]).length>1) -> render a picker, labelled "2 escrow orders"
else                              -> today's behaviour
```

`nullsFirst:false` is deliberate: Postgres sorts NULLS FIRST under DESC, which is
how `matchContact` rule 2 picked an order that had never been placed.

### b) `loan_order_set` must refuse, not pick

Today it does `select id ... where contact_id = ... and order_type = ... limit 1`
and edits whatever comes back. With two rows that is an arbitrary choice, made
silently, on a row a human believes they are editing by name.

It must instead:

- `p_order_id` given → operate on exactly that row (already true today);
- exactly one row matches → operate on it;
- more than one matches → `raise exception` naming the count and requiring
  `p_order_id`.

Same rule as every other tie-break here: an ambiguous match is an error, not a
coin toss. Every UI path that lists orders already holds the id, so the exception
is only reachable from callers that genuinely cannot tell.

### Order

(a) and (b) shipped and confirmed first. Only then relax the index to
`(contact_id, order_type, borrower_contact_id)` or drop it. Not before — the
constraint is currently the only thing preventing both failures.

## 3. SECURITY DEFINER functions returning unmasked borrower contact details

24 SECURITY DEFINER functions in `public` read borrower email, phone or date of
birth. SECURITY DEFINER bypasses RLS and any masking, so each one is a path
around what the lead pages show a VA.

**17 carry a role check** (`is_admin()` / `current_app_role()`):
`contact_related_people`, `copilot_priority_leads`, `copilot_search_leads`,
`dashboard_command_center`, `dialer_sources_list`, `email_recipient_search`,
`esign_merge_resolve`, `esign_people_search`, `esign_signer_suggestions`,
`partner_leads`, `power_dialer_counts`, `power_dialer_match_count`,
`power_dialer_queue`, `recipient_search`, `share_recipients`, `sms_blast`,
`va_daily_tasks`.

A check is not the same as the RIGHT check — most of these deliberately allow
`va`, which is the point of the features — but they at least ask.

**7 have NO role check, and `authenticated` can EXECUTE all seven:**

| function | returns | why it matters |
|---|---|---|
| `get_lead_people(p_contact_id, p_application_id)` | **DOB + email + phone** | widest: any signed-in user, any contact_id |
| `hoi_quote_prefill(p_contact_id)` | **DOB + email + phone** | the one already flagged |
| `voe_prefill(p_contact_id)` | email + phone | |
| `app_notify_mentions(...)` | email + phone | trigger helper, but directly callable |
| `is_phone_suppressed(p_phone, p_contact_id)` | boolean | an oracle: confirms whether a number belongs to a contact |
| `sync_application_to_contact()` | — | trigger function, no args |
| `tg_loan_contacts_sync_directory()` | — | trigger function |

**So `hoi_quote_prefill` is not the only one — it is one of three that hand any
signed-in user a borrower date of birth and contact details for any contact_id
they name.** `get_lead_people` is the more serious of them: same argument shape,
already used by the lead page, and it returns DOB too.

This does not make the HOI change wrong — Rene confirmed consent and the modal
needs those fields. It does mean the masking on the lead pages is worth exactly
what these seven allow, which today is everything.

Cheapest fix, matching what the other 17 already do: add
`if not (is_admin() or coalesce(current_app_role(),'') in ('va','agent','loa'))
then raise exception 'staff only'; end if;` to the four directly-useful ones, and
`revoke execute ... from authenticated` on the two trigger functions.

**Not applied. This is a report.**

---

# Added 2026-08-11 (later) — n8n callers, and the watchdog blocker

## n8n workflows that call edge functions with NO credential

Found by opening HTTP nodes, not descriptions. Neither is reachable by grepping
this repo, which is why the caller sweeps kept missing them.

| workflow | calls | credential sent |
|---|---|---|
| Contact Folder Creator `1ZhDyTy1gZP2g4qQ` | `gdrive-proxy?action=create-folder` | **none** — Content-Type only |
| Lender Folder Creator `35OAO1zJqCZsKMsM` | `gdrive-proxy?action=create-folder` | **none** — Content-Type only |

**Guarding `gdrive-proxy` breaks both silently** — same shape as the CRON_KEY
rotation. Frontend-first there means fixing these two n8n nodes BEFORE the guard.

## Anon key hardcoded in an n8n Code node

`Lender Prospect Follow-Up Reminders` `4MneV3U3vMmNftO8` embeds the public anon
key as a literal in its "Filter Due" Code node to read
`clickup_automation_config`. Public by design, so not a leak — but it is a
second place the key lives, and it will outlive any rotation of it.

Its evidence row is `lenders.last_follow_up_reminder_at`.

## Still unopened

`Borrower Stage Foldering` `3MgNXjZrcCm7c8gy` and
`Google Calendar Two-Way Sync` `4T6MeKgMbeYtdtUb`. Nine of eleven have now been
read at node level; these two have not.

## THE WATCHDOG BLOCKER: no n8n API key exists

The n8n execution-history check cannot be built as scoped. `gdrive-health-monitor`
would have to call the n8n REST API, which needs an `X-N8N-API-KEY`, and there
is no such key in `vault.secrets`, in `app_config`, or in the repo.

The data itself is there and is exactly what the check needs — via MCP:

```
critical-date-reminders  f1udN0aJRWAb1wqw  daily 22:00Z  success Aug 5,6,7,8,9,10
```

and the HTTP nodes have no `onError: continue`, so a 401 from a guarded edge
function turns the execution status to `error`. **n8n execution status is a
faithful signal** — it just is not reachable from an edge function today.

Three ways forward, in preference order:

1. **Mint an n8n API key, store it in the vault** (`n8n_api_key`, same shape as
   `cron_task_key`), and have the monitor poll
   `GET /api/v1/executions?workflowId=…&limit=1` per workflow, red when the last
   execution is older than N intervals or its status is not `success`. This is
   the design as scoped and the only one that sees a failed run directly.
   NOT DONE: creating an API key in a production automation platform is an
   outward-facing credential change, and it is Rene's to authorise.
2. **Watch evidence rows instead** — no key needed, but ambiguous for exactly the
   workflows that matter: `refi-watch` legitimately writes nothing when no client
   is 0.50% above market, so "no row" cannot be distinguished from "did not run".
3. **Wire `Sync Failure Alert` to all 11 workflows** and fix its HTTP node, which
   posts to `email-service` with Content-Type only and would 401. This is worth
   doing regardless, but it is n8n alerting on itself — if n8n is down or the
   workflow is unwired, it is silent, which is the situation today.

(1) and (3) are complements, not alternatives: (3) reports a failure n8n noticed,
(1) notices a workflow that stopped running at all.

---

# 2026-08-11 — n8n failure alerting fixed, and a trap that hid a live breakage

## n8n edits create DRAFTS. They do not run until published.

`update_workflow` returns success and shows the new values — and the **active
version keeps running the old ones**. `versionId` and `activeVersionId` are
different fields, and only the second is executed.

**This hid a live breakage for a day.** Yesterday's CRON_KEY rotation updated
the three n8n HTTP nodes and reported success. It never took: a production run
of post-close-followups on 2026-08-11 sent
`x-cron-key: rnr-cron-9b1f7a3e8c2d460a85f4e6172c0d9b3e` — the OLD literal,
already dead — and got 401. Critical-date-reminders would have failed the same
way at 22:00Z that night.

Caught only because the break test read the EXECUTION DATA rather than the
update tool's response. The tool said the key was changed; the wire said
otherwise.

**Rule: after any update_workflow, call publish_workflow, then prove it with an
execution — not with the update response.**

All four touched workflows are now published and verified:

```
6685  post-close-followups, vault key, published   -> success
6688  post-close-followups, restored after test    -> success
```

## Sync Failure Alert now works, proven by breaking a workflow twice

Wired as `errorWorkflow` on all 11 workflows (1 had it before). Its HTTP node
posted to email-service with Content-Type only and would 401; it now uses the
existing **"Supabase service_role (HTTP)"** n8n credential — no new secret was
pasted anywhere, and email-service accepts the service key from either header.

Two break tests, bogus x-cron-key on post-close-followups:

| run | workflow | result |
|---|---|---|
| 6683 | post-close-followups | error (401) |
| 6684 | Sync Failure Alert | fired, **error** — credential fix was still a draft |
| 6686 | post-close-followups | error (401) |
| 6687 | Sync Failure Alert | fired, **success** — alert delivered |

6684 is the useful one: it proves the alarm fires, and that the first attempt to
fix it had not actually shipped.

**An error workflow does NOT need a production trigger.** `triggerCount: 0` and
"can only be executed in manual mode" describe direct invocation; the Error
Trigger fires on a linked workflow's failure regardless. Verified — 6684 and
6687 both ran with `mode: "error"`. So no schedule trigger was added, and one
should not be: it would email an empty alert on every tick.

**Failure handling fires for PRODUCTION executions only.** A manual run does not
trigger the error workflow, so any future test of this must use production mode.

## Still open

- The execution-history check (option 1) is NOT built — it needs `n8n_api_key`
  in the vault, which only Rene can paste.
- `Google Calendar Two-Way Sync` has pre-existing validation warnings unrelated
  to this work: a disconnected `HTTP Request 1` node, and `Google Calendar 1`
  missing its `resource` discriminator.

---

# Contact Folder Creator — the unshipped draft, investigated. DO NOT PUBLISH YET.

Read-only. Nothing changed, nothing published.

## The exposure is far narrower than "two months unguarded"

**Nothing in the database fires this workflow.** The `contacts` triggers
(`trg_borrower_foldering_ins` / `_upd`) call `notify_borrower_foldering()` —
that is the *Borrower Stage Foldering* workflow, a different one. The only
DB-fired webhook of this family is `lender-folder-creator` on `lenders`.

`contact-folder-create` is invoked from the app, in two places, and **both only
call it when the contact has no folder**:

- `admin/lead-detail.html:6119` via `handleDriveFolderBtn()` — if
  `window._leadDriveFolderUrl` is set the button OPENS the folder instead of
  creating one.
- `components/admin-dashboard.js:2640` `_fvCreateFolder`, on `dashboard/admin.html`.

So the missing `&gdrive_folder_id=is.null` guard is defence-in-depth on a path
the UI does not take. That is why two months passed without visible harm.

## No evidence of any overwrite

| check | result |
|---|---|
| contacts with a folder / distinct folder ids | **67 / 67** — no two contacts share one |
| folder id changed since the `merge_snap_contacts_20260808` snapshot | **0** |
| `google_drive_folder_id` (a second, older column) populated | **0 rows** |
| a folder id in that column no contact now points at | **0** |
| `audit_log` rows showing `gdrive_folder_id` changing | **0** |

**But the audit is not proof, and this is the honest limit.** `audit_log` holds
only 5 rows for `contacts`, all 2026-08-08 to 2026-08-10 — it does not cover the
2026-05-11 → 2026-06-15 window at all, nor most of the period since. n8n retains
**zero** executions for this workflow. There is no history that would show an
overwrite in the exposed period, so "no evidence" here means *no record exists*,
not *it did not happen*.

Orphaned Drive folders cannot be enumerated from here either — that needs the
Drive API through `gdrive-proxy`, which needs a session. If Rene wants certainty,
listing the Borrowers root and diffing against those 67 ids is the check, and it
is the same orphan shape as the esign bucket.

## The exposure that IS real, and that the draft closes

The webhook takes **no credentials** ("No credentials required for this
webhook"). Anyone who knows the URL can POST `{contact_id, first_name,
last_name}` and cause a folder create plus an unguarded PATCH — which *would*
overwrite an existing `gdrive_folder_id` and strand the previous folder, with
borrower documents in it. The UI guard does not apply to a direct POST.

The second path is a race: double-click, or the 10-second writeback poll timing
out so the button still reads "Create Folder" after a folder was made.

## Why the draft was probably never published

Not "published, failed, reverted" — there is no failed execution to support that,
and n8n retains none for this workflow either way.

The likelier reading is the trap itself. The draft was created
**2026-06-15 06:07Z**, inside a cluster of workflow edits that day (Sync Failure
Alert 07:07, ClickUp Calendar 07:13, Google Calendar 07:13, Lender Prospect
16:10). Whoever added the guard saw a success response and believed it shipped —
exactly what happened to the CRON_KEY rotation on 2026-08-11.

## Recommendation

Publishing the draft is correct and low-risk: it only adds
`&gdrive_folder_id=is.null` to the PATCH, so the workflow stops overwriting a
folder that already exists. It changes nothing about the create path.

**It stops the bleeding; it recovers nothing.** If a folder was stranded during
the exposed window, publishing does not find it — and that folder holds borrower
documents. The recovery check is the Drive listing above, and it is a separate
job.

Worth doing in the same pass, since the draft does not address it: the webhook is
unauthenticated. That, not the missing guard, is the way an overwrite could still
be caused deliberately.

---

# Contact Folder Creator: draft PUBLISHED and proven (2026-08-11)

`activeVersionId` moved `f6edb36e` (11 May) → `e3f31e57` (15 June). Proven by
execution, not by the publish response:

| run | fixture state | outcome |
|---|---|---|
| 6689 | no folder | folder created, `15fS1PzNx4zM8Xfwt8mDbMBpNCjF8Yqw4` written back |
| 6690 | folder already set | **id and updated_at UNCHANGED** — the PATCH matched no rows |

Run 6690 is the guard. On the 11 May version that PATCH had no
`&gdrive_folder_id=is.null`, so it would have overwritten the id and stranded the
first folder. The success path does not record the request URL in n8n (only the
error path does), so the guard was proven by behaviour rather than by reading the
header back.

**Test artifact, deliberately left:** run 6690 created a second Drive folder
("ZZ-TEST Fixture GUARD TEST") that nothing points at. That is inherent to the
design — the workflow still creates before it PATCHes, and only the overwrite is
prevented. It cannot be trashed through `gdrive-proxy`, which uses the service
account, because n8n created it with rene@'s OAuth. Cleanup is a Drive-UI job.
The fixture now holds `15fS1PzNx4zM8Xfwt8mDbMBpNCjF8Yqw4`; clear it to re-run
this test.

**Note this is now the shape of every legitimate re-click**: create a folder,
then decline to record it. Preventing the wasted folder needs a check BEFORE the
create, which the draft does not add.

## Authenticating the webhook — a header credential is the WRONG fix here

The instruction was to ship the two callers sending a credential, then require it
at the webhook. **Both callers are browsers**, so any credential they send is in
page source — which is the anon-key mistake this project has already documented
three times. n8n Header Auth on a browser-called webhook authenticates nothing;
it just publishes a second public string.

The correct shape, and it is a bigger change than a header:

1. `lead-detail.html:6119` and `components/admin-dashboard.js:2640` stop calling
   n8n directly. They call an edge function with the user's SESSION TOKEN.
2. That edge function does `requireStaff(req)`, then calls the n8n webhook
   server-side with the shared secret read from the vault — the `cron_task_key`
   pattern, unchanged, with the secret held server-side where it belongs.
3. Only then does the n8n webhook require the header.

Frontend-first still applies, and the order is the same: callers first, confirmed
working, then the webhook starts refusing.

Worth asking before building: the edge function in step 2 would be a thin proxy
whose only job is to hold a secret. `gdrive-proxy` already creates folders and
already has a guard. Routing folder creation through it directly would remove the
n8n hop entirely rather than authenticate it — fewer moving parts, one fewer
place a credential lives, and it deletes this whole class of problem instead of
guarding it.

NOT BUILT. Raising it rather than shipping a header that would look like
authentication and provide none.

## Separate, not fixed here

`Contact Folder Creator` and `Lender Folder Creator` both call
`gdrive-proxy?action=create-folder` with **no credential**. That is a different
question from the inbound webhook and is already recorded above — guarding
`gdrive-proxy` breaks both silently.

---

# Contact folder creation moved off n8n into gdrive-proxy (2026-08-11)

## Read-only findings that decided the shape

1. **`gdrive-proxy?action=create-folder` only creates.** It returns the Drive
   file and does not touch `contacts`, so the writeback had to move with it.
2. **No subfolder tree is lost.** Contact Folder Creator was three nodes —
   webhook, create-folder, PATCH. The 10-subfolder borrower tree belongs to
   *Borrower Stage Foldering* (18 nodes, fired by `pipeline_status`), which is
   untouched.
3. **`gdrive-proxy` was unpinned, `verify_jwt = false`, and had NO in-function
   guard.** So moving the callers there would have moved them to another open
   endpoint. See the split below.

## What was built

`POST gdrive-proxy?action=create-borrower-folder` with `{ contact_id }`:

- `requireStaff(req)` — the caller presents a SESSION, which is why this could
  not be solved with a header on the old webhook: both callers are browsers, so
  any credential they can send is in page source.
- **Guard 2 (new): does not create when a folder already exists.** The n8n draft
  only prevented the bad RECORD — it still created a folder and then declined to
  save it, so every re-click stranded one (execution 6690 made exactly that).
  Checking first means the wasted folder never exists.
- **Guard 1 (carried over): the `is.null` writeback.** Retained verbatim in
  meaning — fill the id only while it is still empty — as the race backstop when
  two callers pass guard 2 together. If it loses that race the response says
  `raced: true` and names the now-unreferenced folder rather than reporting a
  clean success.
- The server writes back synchronously, so the response carries the id and the
  10-second poll in both callers now exits on its first pass. That poll window
  was the double-click race.

Callers moved: `admin/lead-detail.html` `_ldCreateContactFolder`, and
`components/admin-dashboard.js` `_fvCreateFolder`. Both send the session token.

## Verified by execution

```
create-borrower-folder   no credential  401 missing authorization
create-borrower-folder   anon key       401 invalid session
create-folder (old)      no credential  400 parentId and name required   <- still open
POST /webhook/contact-folder-create     404 not registered              <- retired
```

**NOT verified: the success path.** `requireStaff` needs a real session or the
service key and I have neither, so the create, the folder-exists guard and the
is.null writeback are proven by construction and refusal only. **Rene should
click "Create Folder" on a lead with no folder, then click it again** — the
second click must return the same folder and create nothing new.

## n8n workflow retired, not deleted

`Contact Folder Creator` `1ZhDyTy1gZP2g4qQ` is **unpublished**, and its webhook
now 404s. Deactivating was safe to do immediately because both callers had
already moved, so it had no caller left — and it closes an unauthenticated
webhook that could create folders and PATCH `contacts` for any contact_id.

## gdrive-proxy is PARTIALLY guarded — say so plainly

Only `create-borrower-folder` checks anything. `create-folder`, `upload-file`,
`rename`, `trash-file` and the read actions still answer anyone, using rene@'s
user OAuth token for the write ones. Guarding the rest is blocked on one caller:
the n8n **Lender Folder Creator** (`35OAO1zJqCZsKMsM`) POSTs `create-folder`
with no credential. Give that node the existing "Supabase service_role (HTTP)"
credential, publish, prove by execution — then guard the whole function.

## Cleanups

- Fixture `aa74cc5e…` folder id cleared, so the create path is testable again.
- **For Rene, a Drive-UI job:** execution 6690 left an orphan folder
  `ZZ-TEST Fixture GUARD TEST` under the Borrowers root, and run 6689 left
  `15fS1PzNx4zM8Xfwt8mDbMBpNCjF8Yqw4` which nothing points at now that the
  fixture is cleared. Both are rene@-owned via n8n's OAuth, so `gdrive-proxy`
  (service account) cannot trash them.

---

# gdrive-proxy: Lender Folder Creator credentialled; the REST is not guarded yet

## Steps 1–3 done

`Lender Folder Creator` (`35OAO1zJqCZsKMsM`) "Create Drive Folder" node now uses
the existing **"Supabase service_role (HTTP)"** credential. Published
(`activeVersionId 5b75ccc0`) and proven by execution **6692 — success**, folder
`1Anb0EiqwMTyIxsOzQMO4j49DJ4xySntN` created under the Lenders root.

**What that execution does and does not prove.** gdrive-proxy is still unguarded,
so it proves the credential does not BREAK the call. It cannot yet prove the
credential SATISFIES a guard — that check only exists after step 4. This is the
frontend-first order working as intended, not a gap.

Run against `id 00000000-…cafe`, which matches no lender, so the PATCH was a
no-op. Deliberate: the only test lender, "New Lender Test", already has
`1HJdIATu_RVWRUJ0OPTCXQGi4xXMU_No_`, and **this workflow's PATCH has no
`is.null` guard either** — re-running against it would have overwritten the id
and stranded that folder. Same bug as Contact Folder Creator had. Worth fixing;
not fixed here.

## STEP 4 IS BLOCKED, and the audit is why

Guarding the remaining actions would break **10 browser call sites today**.
`admin/lead-detail.html` has 12 `fetch` calls to gdrive-proxy and only 2 send an
Authorization header:

| action | call sites | authenticated |
|---|---|---|
| `download` | 3 | **0** |
| `upload-file` | 3 | 1 |
| `create-folder` | 2 | **0** |
| `list-folders` | 2 | **0** |
| `rename` | 1 | 1 |
| `list-files` | 1 | **0** |

Guarding first would break Drive upload, download, folder listing and renaming on
the lead page — silently for the reads, which just render empty.

**So the remaining order is: ship those 10 call sites sending the session token,
confirm the lead page still uploads/downloads/lists, THEN guard.** That is the
same rule that has held all week; the audit is what turned "add requireStaff"
into a ten-site frontend change.

## Guard shape per action — do NOT apply one shape to all

| action | callers | guard |
|---|---|---|
| `create-borrower-folder` | browsers (2) | `requireStaff` — **done** |
| `create-folder` | browser (2 sites) + n8n Lender Folder Creator | `requireStaff` — service key covers n8n now |
| `upload-file` | browser (3 sites) | `requireStaff` |
| `rename` | browser (1 site) | `requireStaff` |
| `download`, `list-files`, `list-folders`, `get-folder` | browser reads | `requireStaff` |
| `resolve-folder` | **gdrive-sync edge function**, sends `Bearer SERVICE_KEY` | `requireStaff` accepts the service key — no change needed |
| `trash-file` | **NO caller anywhere** in repo, n8n or cron | `requireStaff`, and it is the most urgent |

`allowInternal` is NOT needed by any of them: the one server-side caller
(`gdrive-sync`) already presents the service key, and nothing here is reached
from Postgres. Adding `allowInternal` would widen the guard for no caller.

## What is exposed until step 4 lands — state it plainly

These writes use **rene@'s USER OAuth token** (`google_calendar_tokens id='rene'`),
not the service account. So an unauthenticated caller who knows the URL can today:

- **create** folders anywhere he can write,
- **rename** any file he can reach,
- **TRASH any file he can reach** — `trash-file`, which has no caller at all and
  therefore no legitimate traffic to protect, and **no undo**. Trashed Drive items
  are recoverable from the bin for 30 days by a human; nothing here restores them.
- **upload** files into his Drive, and **download** anything readable through it.

`trash-file` is the one to close first when step 4 runs: highest damage, zero
callers, so guarding it cannot break anything.

---

# gdrive-proxy guarded (2026-08-11) — and a correction to my own audit

## trash-file first, on its own

No caller anywhere — repo, 11 n8n workflows, 45 cron jobs — and no undo. Guarded
alone, ahead of everything else, because there was no legitimate traffic to
break and frontend-first therefore did not apply. Its existing guards constrain
the TARGET (SA ownership, not inside a borrower tree); they never constrained the
CALLER. It keeps its own `requireStaff` in addition to the shared gate: a
destructive action should not depend on a shared check staying correct.

## I WAS WRONG ABOUT THE TEN CALL SITES

I previously reported 10 unauthenticated browser call sites in lead-detail and
said the guard was blocked behind a ten-site frontend change. **That was an
artefact of my method.** I counted by grepping each `fetch(...)` blob for a
literal `Authorization`. Most sites pass a `gp` object —
`{ Authorization: 'Bearer ' + token, apikey: … }` — and in
`_cmaEnsureCmaFolder(root, gp, base)` it arrives as a **function parameter**, so
the string never appears near the call at all.

Re-audited by reading each site:

| caller | sites | authenticated |
|---|---|---|
| `lead-detail.html` fetches | 13 | **13** |
| `lead-detail.html` `<a href>` downloads | 2 | **0 — cannot be** |
| `components/admin-dashboard.js` | 1 | 1 (session) |
| `gdrive-sync` | 1 | 1 (service key) |
| n8n Lender Folder Creator | 1 | 1 (service_role credential) |

So no frontend change was needed. The guard shipped in one step.

**The lesson is the same one as the n8n drafts:** a grep answered a question about
behaviour, and it was wrong in the direction that would have caused a week of
unnecessary work — or, worse, a "safe" decision not to guard at all.

## Verified by execution

```
create-folder upload-file rename list-folders list-files
get-folder resolve-folder trash-file    no credential -> 401 all eight
create-folder                           anon key      -> 401
download                                no credential -> 400 fileId required   (EXEMPT)
n8n Lender Folder Creator, guard live   execution 6693 -> SUCCESS
```

The last line is the one that matters as much as the refusals: an authenticated
caller still works, so the guard did not break the only server-side writer.

## STILL OPEN: download

`?action=download` answers anyone with a fileId. It streams any file the app's
Drive account can read. Closing it is a design change — signed URL or one-time
token — because two `<a href>` call sites cannot send a header. Not attempted.

## Record, not fixed: Lender Folder Creator's PATCH has no is.null guard

Same bug Contact Folder Creator had, still live, and it is now the ONLY
folder-creator left in n8n. Re-running it against a real lender would overwrite
`lenders.gdrive_folder_id` and strand the previous folder — which is why the two
probe runs used an id matching no lender.

Once this work settles, the same move applies: give `gdrive-proxy` a lender
equivalent of `create-borrower-folder` (requireStaff, skip-if-exists, is.null
writeback), point the `lenders` INSERT trigger at it, and retire the workflow.
**Noted, not started.**

## Drive-UI cleanup for Rene (gdrive-proxy cannot trash these — rene@ owns them)

- `ZZ-TEST Fixture GUARD TEST` — Borrowers root, from execution 6690
- `15fS1PzNx4zM8Xfwt8mDbMBpNCjF8Yqw4` — Borrowers root, run 6689, now unreferenced
- `1Anb0EiqwMTyIxsOzQMO4j49DJ4xySntN` — Lenders root, "ZZ-TEST Lender Folder Creator probe"
- `1JUhxPPispvoAA5Q8rsuyzmF7g7xHNZl6` — Lenders root, "ZZ-TEST guard regression probe"

---

# download: fetch + blob shipped, guard PENDING Rene's confirmation

## Chose fetch + blob, not a signed URL

The pattern already exists in this file three times for the same problem —
`:8895` (doc viewer), `:9241`, `:25208` (1003 scanner) all fetch
`?action=download` with the session token and read `arrayBuffer()`. Reusing it
needs no new concept.

A signed URL would add a second credential type with an expiry, a revocation
story, and a mid-download failure mode — a token that expires while the transfer
is in flight either dies partway or has to be honoured past its expiry, and both
answers are wrong in a different way. For a problem an existing pattern solves,
that is complexity bought for nothing.

## What changed

New `_gpDownloadFile(fileId, fileName)`: authenticated fetch → `blob()` →
temporary object URL → synthetic `<a download>` click → revoke after 60s.

The delayed revoke is deliberate. Revoking in the same tick produces a 0-byte
file in Chrome, because the save has not started resolving the URL yet.

Two call sites converted from `<a href>`:

| site | was | now |
|---|---|---|
| `lead-detail.html` doc-viewer Download button | `dlLink.href = …download=1&fileId=…` | `onclick → _gpDownloadFile` |
| condition attachment chips | `<a href="…download=1…" download>` | `onclick → _gpDownloadFile`; non-Drive attachments keep their plain `file_url` |

Verified on the LIVE page: 5 `_gpDownloadFile` references, **0** hrefs
containing `action=download`, and the old `dlLink.href` assignment gone.

## NOT YET GUARDED — this is the frontend-first half

`?action=download` still answers without a credential. The guard lands only
after Rene confirms the two converted paths work, because if the conversion is
wrong the guard turns a working button into a 401 and there is no way to tell
which change caused it.

**What Rene should click, on a lead that has documents in Drive:**

1. **Documents tab → open a document** → the viewer appears (this path was
   already authenticated and should be unchanged) → click **Download** in the
   viewer. The file should save with its real filename.
2. **Conditions tab → a condition with an attachment** → click **Download** on
   the chip. Same.
3. Both should also work for a PDF *and* a non-PDF (image), since the viewer
   branches on type.

If either shows "Download failed: …", say so and do not guard — that message is
the helper reporting the real error rather than failing silently.

Once confirmed: add `download` to the guarded set in `gdrive-proxy` (remove the
`action !== "download"` exemption), redeploy, prove by refusal, and **update the
`[functions.gdrive-proxy]` note in config.toml, which currently records the
exemption as deliberate.**

---

# gdrive-proxy fully closed (2026-08-11)

`download` guarded; the `action !== "download"` exemption is gone. Every action
now runs `requireStaff` first.

Verified by refusal — all ten actions, unauthenticated:

```
download create-folder create-borrower-folder upload-file rename
list-folders list-files get-folder resolve-folder trash-file     -> 401
download with the anon key                                       -> 401
download&download=1 (the attachment form)                        -> 401
```

Stale comments corrected in the same pass, because a "this is fine on purpose"
note that is no longer true is worse than none: the in-file header no longer
says "EXCEPT download", the top-of-file action list now states that every action
requires a staff session or the service key, the `--no-verify-jwt` deploy note is
replaced by "verify_jwt is not the control, requireStaff is", and the
`[functions.gdrive-proxy]` block in config.toml is rewritten from "PARTIALLY
GUARDED … STILL OPEN" to the closed state with the caller list.

## The second half of frontend-first — what is and is not proven

**Proven post-guard:** the shipped page still sends the credential. Read off the
LIVE bytes rather than the repo — `_gpDownloadFile` sends
`Authorization: Bearer <session>`, calls `action=download&download=1`, and
revokes the object URL on a delay.

**Proven post-guard, by execution:** n8n Lender Folder Creator returned SUCCESS
against the guarded function (6693), so a valid credential does satisfy
requireStaff here — the guard refuses the anonymous and accepts the legitimate.

**NOT proven by me:** an actual download from the lead page since the guard
landed. Rene confirmed both buttons BEFORE the exemption was removed, which
proves the fetch+blob conversion works; it does not prove the round trip now
that the server checks. I have no session token, so I cannot close that myself.

**One more click needed, and it is small:** Documents tab → open a document →
**Download**; and Conditions tab → a condition with an attachment → **Download**.
Same two buttons as before. If either now says "Download failed: missing
authorization" or "invalid session", the guard is refusing a caller that should
pass and the exemption should go back while it is diagnosed.

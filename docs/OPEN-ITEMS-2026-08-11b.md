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

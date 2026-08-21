# Rates & Realty — working notes

## Deploying

**Always deploy with `bash tools/deploy.sh`. Never a bare `npx wrangler deploy`.**

```
bash tools/deploy.sh [https://host-to-verify]     # default https://admin.ratesandrealty.com
```

Three steps, and only the script does all three:

1. `node tools/stamp-assets.mjs --check` — refuse to deploy while any `?v=` cache
   pin disagrees with its asset's content hash.
2. `npx wrangler deploy`
3. `node tools/verify-deploy.mjs` — fetch the LIVE html, read the pins it actually
   asks for, fetch the asset at each pinned URL, compare to what shipped. Curling
   the asset path directly does **not** catch this class of bug.

`wrangler.toml` has a `[build]` hook running step 1, so a bare `wrangler deploy`
aborts on stale pins — but the hook cannot do step 3. Use the script.

### Why stale pins are now serious

`src/worker.js` serves any `?v=`-pinned asset as
`public, max-age=31536000, immutable`. That is safe *because* the pin is a content
hash: change the file, the URL changes. But it means a stale pin no longer
self-heals. Before, `max-age=0, must-revalidate` meant the next page load picked
up new bytes anyway. Now a returning browser keeps the old file with no
revalidation until a corrected deploy changes the pin — so a forgotten restamp
silently freezes every returning user on old code.

**Changed a file under `admin/js/`, `assets/`, or anything referenced with `?v=`?**
Run `node tools/stamp-assets.mjs` and commit the rewritten pins with the change.
Pins are source, not a deploy-time mutation.

Unpinned URLs deliberately keep `must-revalidate` — caching `/admin/js/inbox.js`
hard with no pin in the URL would strand a stale copy with no way to bust it.

## `render-check` — does the page actually WORK, not just ship

`verify-deploy.mjs` proves the right BYTES shipped. That is not the same claim as
the page working. `admin/settings.html` once served byte-perfect HTML at the
correct hash and rendered **nothing**: an inline script had a `SyntaxError`, so it
never ran and the page stayed blank. Every byte-level check was green throughout.

```
node tools/render-check.mjs                  # all specs
node tools/render-check.mjs lead-detail      # one spec, by name substring
node tools/render-check.mjs --url file:///…/x.html --expect "#id" --min-text 200
node tools/render-check.mjs --token tok.txt  # real session instead of the stub
```

It loads the page in headless Chromium and **fails** on: any uncaught exception,
any `console.error`, an expected element being ABSENT, visible text below a floor,
a click step whose target does not exist, `readyState` never reaching `complete`,
and errors in the harness itself. Exit 1 = a page failed; exit 2 = refused to run.

### The green bar is TWO runs, and `--token` is not the better one

```
node tools/render-check.mjs                              ->  82/82   the stub specs
node tools/render-check.mjs --token tok.txt --token-only ->  8/8     the ones that need a session

BOTH NUMBERS MOVE. The second moves whenever a tokenOnly spec is added — it was
7/7 on 2026-08-19 and became 8/8 the same day. The first was 75/75 until
2026-08-21, when the four rich-toolbar specs and the save1003 UUID guard
landed. Read them off the run,
never off this file; what is fixed is that there are TWO runs, not what either
total is.
```

**There is no invocation that returns the sum of the two, by construction.** Do
not go looking for one, and do not read a partial number as breakage.

Measured 2026-08-19, when the suite was 75 + 8: running the WHOLE thing with
`--token` returned **62/83, 21 failed** — and not one of those 21 was a defect. `--token` replaces the stub for
**every** spec, not only the ones that need a session, and 20 of the 75 stub
specs assert things only the stub provides:

- **Role-faked specs.** `spec.role: 'va'` is the stub pretending. Under a real
  admin session auth-guard recomputes the actual role, so
  `va-people is denied to a role without access` fails *because the admin is
  genuinely allowed*. Correct behaviour, wrong seat.
- **Stub-fabricated data.** `e-sign Send enables once a doc and signer exist`
  fails with "Add at least one signer", because the ZZ-TEST fixture has neither
  and the stub invented them. `staff chat Send actually sends` fails on
  `nothing matched [data-sc-thread]` — no real thread exists for that account.

That is the mirror of the trap recorded above: a stub that UNDER-delivers reads
as a broken page, and one that OVER-delivers makes specs pass that real data
cannot satisfy. Neither mode is wrong; they answer different questions.

**A 21-failure token run reads as twenty-one broken things and is not.** That
misreading is the reason this is written down.

`ownerOnly` is a third state, narrower than `tokenOnly`: the spec needs **rene@'s
own** session and no automated run can supply it. `dashboard/admin.html` calls
`requireAdmin()`, which checks a hardcoded `ADMIN_EMAILS` allowlist holding one
address and never consults `auth_user_roles` — so the automation account, an
admin in the database, is still redirected off the page. Those specs are excluded
from BOTH modes and announced on every run, because a spec that cannot pass with
any credential the harness can mint must not sit in either mode reporting red.
Exactly one spec is in that state today: the CRM board's va-refusal pair.

Console-error exclusions are per-spec (`allowConsole`), need a reason, and are
PRINTED on the run. An exclusion nobody can see is how a harness goes quietly
blind.

By default there are **no credentials**: the Supabase client is stubbed before any
page script runs. So it mints no `auth.sessions` row — nothing to clean up, and no
chance of repeating the delete-every-session incident — and attributes nothing to
a real user. When `--token` IS used it checks `exp` **first** and refuses before
launching a browser: a token that had expired 90 minutes earlier was twice
discovered at the verification step, after the change was already deployed.

### What a green run does NOT prove

**Rendering, not authorization.** With a stubbed client no role gate, RLS policy,
column grant or mailbox refusal is exercised. A green run says *nothing* about
whether a va can reach `rene@`, whether `calls_log` column grants hold, or whether
`gmail-inbox` refuses the wrong mailbox. Those are proven by calling the edge
function directly with a real role token, the way the va inbox actions were.

The harness prints this boundary on **every** run, in its own output rather than
only here, because a green result from a rendering harness starts being read as
"verified" for things it never touched.

### The stub bug, because anyone extending it will hit it

The stub installs at document-start via `Page.addScriptToEvaluateOnNewDocument`.
The page then loads the real supabase-js by `<script src>`, and the library's
plain assignment to `window.supabase` **silently replaced the stub** — so pages
went on to hit real PostgREST, and their genuine errors ("Cannot coerce the result
to a single JSON object") were reported as page defects. Fixed by defining the
property non-writable with a swallowing setter, not by assigning it.

Second gap, same shape: `.single()` returned `null`, pages correctly bailed out of
rendering a record that did not exist, and the harness blamed the page. It now
returns a plausible row. **A stub that under-delivers reads as a broken page.**

### Why the break test has the shape it does

The fixture is a page whose inline script has a `SyntaxError`, so `#shell` is
never populated. The assertion was that `#shell` is present — **and it was.** The
element exists; it is empty. A harness asserting only "did the expected thing
appear" passes this page, which is the exact failure the harness exists to catch.

What caught it was the uncaught-error check and the visible-text floor. That is
why presence-only assertions are not sufficient and why absent-assertions are
paired with present-assertions in the same spec: if the pane never mounted, an
`absent` check would pass vacuously. `/admin/inbox` asserts the folder rail
PRESENT while the scoped lead tab asserts it ABSENT, so both know the selector is
real.

**A harness that has only ever passed proves nothing.** Break it before trusting
it, and break it again whenever its failure modes change.

### A commit message is a CLAIM, not evidence

`9f87ca6` ended "Proven per site in BOTH directions by CDP interception — forced
400 and forced 204, with OPTIONS never intercepted and CORS on every fulfilled
response". **No such harness has ever existed in this repo.**
`git log --all -S 'Fetch.enable'` and `-S 'fulfillRequest'` return nothing on
every branch, the commit touched one file, and `render-check.mjs` enables only
`Emulation`, `Log`, `Page`, `Runtime` and `Target` — it cannot intercept a
request and cannot even observe one. The fix itself was correct. The evidence
was fiction.

An absent proof invites a proof; a false proof claim CLOSES the question. And the
specific thing it claimed to have tested — `alert('Could not save.')` firing —
had been **unreachable code** until that very commit. An error path that has
never executed is the last thing to take on faith.

**Before relying on "this was proven", find the artifact** — the harness, the
spec, the recorded output. If a proof left nothing behind that can be re-run, it
did not happen in any sense that helps you, and the claim should be read as
untested. When writing a message: describe what the change DOES, and only claim
a proof in the same commit that carries the thing which produced it.

`tools/write-failure-proof.mjs` (d310f17) is now the real artifact for those
writes — **nine of them, not the eight the message counts** — and it is verified
to FAIL against `9f87ca6^` through `tools/serve-prefix.mjs`, which is the half
the original claim never had. Full record:
`docs/FALSE-PROOF-CLAIM-9f87ca6-2026-08-15.md`.

## `audit_log` stores DIFFS on update, and trims itself

`fn_audit_row` used to store `to_jsonb(OLD)` and `to_jsonb(NEW)` in full on every
update. Measured 2026-08-21: **2.2 keys change on average**, at ~7.9 KB a row —
the same history as diffs is **11.3%** of the size, and 14 rows recorded an
update where nothing changed at all.

- **UPDATE stores only the differing keys** (old_data holds the prior value of
  exactly those keys). One-field change: **7,900 → 66 bytes.**
- **A no-op UPDATE writes nothing.**
- **INSERT and DELETE keep the FULL row** — an insert has no prior state to diff,
  and a deleted row's contents are the point of auditing the delete.
- Rows written before the change keep the old full-snapshot shape and were
  **deliberately not rewritten**. Anything reading `audit_log` must handle both.
  A diff row does not carry unchanged columns; `row_id` identifies the row.

**Retention is INSIDE the writer**, not a cron job — the `monitor_runs` argument:
a separate job can be disabled or fail silently, and the cleanup must not outlive
the thing that maintains it. `mortgage_applications` **7 years** (borrower
record), everything else **90 days**. Bounded to 500 rows per write.

**`fn_audit_row` MUST NEVER THROW, and neither half may.** It is an AFTER trigger
inside the caller's transaction, so an exception aborts the write it was
auditing — the audit becomes the outage. Both the insert and the trim have their
own exception block downgrading to `RAISE WARNING`. Proven by breaking each on
purpose (a `CHECK(false) NOT VALID` on `audit_log`, and a `BEFORE DELETE` trigger
that raises): the business write survived both, recording nothing.

**Test a trigger with an outbound side effect inside a transaction that rolls
back.** `net.http_post` queues into `net.http_request_queue` transactionally, so
counting that queue observes the fire while the rollback discards the row AND the
queued call — no ClickUp task, no borrower row touched. That is how the
`app_submitted` gate below was proven in both directions.

## The subject property lives on `mortgage_applications`, not `contacts`

`mortgage_applications.property_address_*` is **authoritative**. The Subject
Property popup writes it on every save; `contacts.property_address` is the
lead-stage store for a contact with no application yet, and the display/merge
source. Full reasoning in `docs/SUBJECT-PROPERTY-AND-CLICKUP-GATE-2026-08-21.md`.

It has to be the application row because that is the only **structured** copy —
the URLA 1003 renders street/unit/city/state/ZIP as separate cells, MISMO emits
`<AddressLineText>/<CityName>/<PostalCode>`, and `property-lookup` / `pull-comps`
rebuild a query from the parts. `contacts.property_address` is one text line.

**`mortgage_applications_one_per_contact`** is a partial unique index on
`contact_id WHERE contact_id IS NOT NULL`, so the mapping is 1:1.
`save1003`'s comment that "a contact can legitimately have multiple applications"
is **wrong** — the check-then-update it justifies is harmless, but do not build
on the premise.

Two rules in the popup, both load-bearing:

- **It never CREATES the application row.** `clickup_app_submitted` is AFTER
  INSERT and announces a submission to ClickUp. 12 of 25 property addresses are
  on contacts with no application at all; those stay on `contacts`.
- **A free-typed address CLEARS the structured columns.** They describe a
  different property, and the snapshot prefers the structured split over the
  combined line — so stale parts silently win. That is exactly how a corrected
  Norwalk 90650 address kept rendering as `TBD … 92704`. A 1003 with a street and
  no city is visibly incomplete and gets fixed; one with the wrong ZIP does not.

**Never write an address to only one of the two stores.** The popup wrote
`contacts` while the snapshot, `generate-1003-pdf` and the MISMO export all read
`mortgage_applications` — so a typed address saved correctly and displayed
nowhere, for eleven days, on a borrower under contract.

### A row in `mortgage_applications` is NOT a submitted application

`trg_clickup_app_submitted` fires AFTER INSERT and posts "Mortgage application
submitted. Package documents, run AUS, send to underwriting" — high priority,
assigned to Rene. **39 fired, 22 of them false**: the ZZ-TEST fixture, deleted
contacts, same-day duplicates, entirely empty rows, contacts still at New Lead.

**There is no positive `submitted` condition anywhere.** `status` is null on 30
of 35 rows and `'draft'` on 5, written by `mismo-import` for LOS file imports;
no row has ever held `'submitted'`. So the trigger is gated on a NEGATIVE built
from conditions that already exist — not a draft, and carries an SSN, DOB or loan
amount. **If a real submitted flag ever lands, REPLACE the gate rather than
adding to it.**

Proven both directions on the ZZ-TEST fixture inside a rolled-back transaction:
pg_net queues into `net.http_request_queue` transactionally, so counting that
queue observes the fire while the rollback discards the row AND the queued call.
Use that pattern to test any trigger with an outbound side effect.

### `event_signature` keys on the source row id — which INSERT makes unique

So the dedup in `clickup-auto-create` can never match for `app_submitted`:
`NEW.id` is a fresh uuid every time. Correct code, unreachable. It fits
`cold_lead_3d`, which sends no `source_id` and degrades to `trigger:contact:date`.

**"Zero `skipped_duplicate` rows" was never evidence the dedup had not fired** —
the skip branch pushed a result and `continue`d without writing a row, so
suppressions were unobservable. Fixed 2026-08-21; the value was already in the
table's CHECK constraint, so the schema had anticipated the row the writer
forgot. A check whose successes are invisible cannot be audited.

## There is ONE rich-text toolbar: `admin/js/rich-toolbar.js`

Four surfaces mount it. **Do not write a fifth implementation** — mount it.

```js
window.RichToolbar.mount({ target: 'emailEditor', mount: hostEl, slots: [...] })
```

| surface | host | slots it passes |
|---|---|---|
| `#emailEditor` — lead-detail composer, 8 entry points | `#ecToolbar` | Undo, Redo, Canva, AI Helper |
| the inbox composer (`mountComposer`) | `.gm-tools` | Attach, image, video, emoji, CTA insert, AI |
| `#sigEditor` — settings | `#sigTools` | **none** |
| the drip step editor | `#emailTools_<i>` | + Name, + Phone, + Link, + Signature |

**FORMATTING IS THE UNION; INSERTS ARE NOT.** B/I/U, lists, link, clear, font,
size, colour, highlight, alignment, indent/outdent and quote are component
defaults. Canva, Loom, emoji, images and variable pickers are `slots` the host
passes, because a signature has no variables and a drip step has no Loom. The
eight divergence decisions are in
`docs/TOOLBAR-CONSOLIDATION-DIVERGENCE-2026-08-20.md`; what shipped and what did
not is in `docs/TOOLBAR-EXTRACTION-2026-08-21.md`.

Three of those decisions are load-bearing rather than cosmetic, and each has a
render-check assertion that fails if it is undone:

- **`styleWithCSS` is enabled for the COLOUR COMMANDS ONLY**, then restored.
  Globally it changes what bold and underline emit — `<span
  style="font-weight:700">` instead of `<b>` — across every email this CRM
  sends, and `<b>`/`<u>` are the better-supported forms in mail.
- **Link URLs are validated** (`https?:`/`mailto:`/`tel:`). Two of the four
  toolbars this replaced handed `prompt()` straight to `createLink`. Nothing in
  the CRM renders a `javascript:` href — DOMPurify strips it — but **the send
  path sanitizes nothing**, so it really did go out on the wire.
- **The row WRAPS.** inbox.js kept one non-wrapping row and paid for it by
  hiding alignment, indent/outdent, quote and clear formatting behind a `⋯`
  menu, which is why nobody could find them. A `flex-wrap:nowrap` that comes
  back pushes them off the edge instead — still invisible, with every
  present-check passing.

**The host styles it through `--rrt-*` variables**, never by writing
`.<host> button` rules: those land at equal specificity with the component's own
and win or lose on stylesheet order. `.sig-tools button`, `.gm-tools button` and
`.ec-tb-*` were all deleted for this reason.

Class prefix is `rrt-`. **Not `rte-`** — drip-builder.html already owns
`.rte-toolbar`, `.rte-btn`, `.rte-divider` and `.rte-area`.

### `#lpEmailBody` is still the fifth surface and still has no toolbar

Five template emails are composed in it — including the HOI agent and realtor
ones. It is a bare contenteditable. Now that the component exists this is a
**mount call**, not a port.

`lpHoiOpenComposer` is a different problem and is deliberately held: it is
**plain text** (`p.textContent`, body assembled with `\n`). There is no toolbar
to extend, and converting it is a rewrite of how that body and its signature are
assembled.

## CORS: curl proves nothing about a browser

`voe-form-fill` was deployed, ACTIVE, `verify_jwt` matching its pin, and answered
curl perfectly — while being **unreachable from the page for eleven days**, from
the moment the browser call was added (`352e98f`, 2026-08-06).

Its `Access-Control-Allow-Headers` was `Content-Type, Authorization, apikey`.
**supabase-js attaches `x-client-info` to every `functions.invoke()`**, so the
browser lists it in `Access-Control-Request-Headers`, and a preflight that does
not allow back **every** requested header fails. The browser then abandons the
request and never sends the POST.

What the user sees is `Failed to send a request to the Edge Function` —
supabase-js's **client-side** `FunctionsFetchError`. It reads like the function
is down, missing, or undeployed, and it sends you to check all three. All three
were fine.

**The signature in the edge log is OPTIONS 200 followed by NO POST.** A preflight
that succeeds and is then followed by nothing means the refusal happened inside
the browser. The server sees only the OPTIONS, so every server-side check — logs,
status, drift, pin — looks healthy.

`gmail-inbox` allows `authorization, x-client-info, apikey, content-type`. That
is the entire reason HOI worked while VOE did not: three words in a header, not
the caller.

```
node tools/browser-cors-check.mjs        # sweeps every functions.invoke() slug
node tools/browser-fn-probe.mjs <slug>   # real Chromium, real origin, real call
```

`browser-cors-check` reads one header off one preflight and is cheap enough to
run every time. `browser-fn-probe` actually makes the call from
`admin.ratesandrealty.com` through **the page's own supabase-js** — it must be the
page's library, because a probe that hand-builds a `fetch` picks its own headers
and can pass while the page fails, which is the whole bug class.

Both were broken before being trusted: `esign-docs` still omits `x-client-info`
and both tools correctly report it BLOCKED, exit 1. (`esign-docs` is fine in
production **because `lead-detail.html` calls it with a raw `fetch`**, which sends
no `x-client-info`. Convert that call to `functions.invoke()` and it breaks
instantly — a live trap, not a theoretical one.)

Use `process.exitCode`, never `process.exit()`, in these tools. `process.exit()`
with sockets still open aborts teardown on Windows and **the crash replaces the
exit code with 0**, so a run that correctly found a blocked function reports
success. A gate that always exits 0 is worse than no gate, because it is
believed.

**This is the same family as every other trap in this file: the check reported
fewer problems than existed.** curl and Deno send no preflight and enforce no
CORS, so nothing outside a browser can observe this failure — which is exactly
why "the Node proofs passed" was not evidence, and why the frontend-first gate
caught what six green proofs did not.

## n8n: an edit is NOT shipped until an execution proves it

`update_workflow` returns success, echoes the new values back, and **the running
workflow keeps the old ones**. `versionId` and `activeVersionId` are different
fields and only the second executes. The success response is a claim about a
DRAFT.

This hid a live breakage for a day. The 2026-08-11 `CRON_KEY` rotation edited the
`x-cron-key` header on three workflows and reported success on all three. It
never took: a production run of `post-close-followups` sent
`rnr-cron-9b1f7a3e8c2d460a85f4e6172c0d9b3e` — the value that had just been
revoked — and got 401. `critical-date-reminders` would have failed the same way
at 22:00Z that night, silently, because nothing watches n8n.

It was found only by reading the EXECUTION DATA (`get_execution` with
`includeData`), which shows the header actually sent. The update tool's response
and `get_workflow_details` both showed the new key, because both read the draft.

**The two kinds of change do NOT behave the same, and this is the part that
misleads:**

| change | applies |
|---|---|
| node parameters (headers, URLs, credentials, code) | **draft — needs `publish_workflow`** |
| workflow settings (`errorWorkflow`, `callerPolicy`, timezone) | **immediately** |

Measured, not assumed: `setWorkflowSettings({errorWorkflow})` on three workflows
left `activeVersionId` unchanged when published afterwards, and the error
workflow fired for a failure whose node change was still an unpublished draft.

So after any node edit:

```
update_workflow  ->  publish_workflow  ->  execute and READ THE EXECUTION
```

and for anything that sends a credential, read the header off
`get_execution(includeData:true)`. Not the tool's echo.

**Error workflows fire for PRODUCTION executions only.** A manual run does not
trigger them, so a manual test of failure alerting proves nothing. And an Error
Trigger workflow needs no production trigger of its own — `triggerCount: 0` and
"can only be executed in manual mode" describe direct invocation, not error
handling. Do not add a schedule trigger to one: it would email an empty alert on
every tick.

**Unshipped drafts sit there indefinitely.** `Contact Folder Creator` has carried
one since 2026-06-15 while the 2026-05-11 version runs — found while auditing
this. Check `get_workflow_history`: more than one version, newest not active,
means something someone believed they had changed is not live.

## Edge functions

**Always deploy with `bash tools/deploy-function.sh <slug>`. Never a bare
`supabase functions deploy`.**

```
bash tools/deploy-function.sh <slug>
```

`deploy.sh` gates the SITE. Edge functions ship through the Supabase CLI, which
passes through none of it, and that gap has cost real outages three times. The
wrapper is the only path that does all five:

1. `check-functions.mjs` — no NEW type error, no undefined identifier.
2. `check-function-drift.mjs` — refuse if production holds source this repo has
   never committed. See below.
3. refuse if the slug is not pinned in `supabase/config.toml`.
4. deploy — **never** passing `--no-verify-jwt`; `config.toml` decides.
5. re-read what is actually live: deployed source now matches the repo, and
   `verify_jwt` matches the pin.

**Never pass `--no-verify-jwt`.** It overrides `config.toml` from the command
line, which is exactly how `sms-service` became an open SMS relay on the
business line. Deploying an UNPINNED function is the same bug pointing the other
way: the CLI defaults it to `verify_jwt = true`, which is how every
`send-scheduled-sms` cron run returned `UNAUTHORIZED_NO_AUTH_HEADER` for days
with nothing alerting. Pin the value — at its current setting if you are not
trying to change it — and let the file decide.

### OPEN: three Postgres functions are in production with no copy in the repo

`email_signature_identity`, `purge_stale_temp_credentials`,
`purge_used_temp_credentials`. **Capture them.**

They are the top movers in `observe-db-functions` — 21–23 of 114 runs each — and
the mechanism is mechanical, not mysterious: `const BASELINE =
'supabase/sql/db-functions'`, so the observer diffs production against *the repo
directory*. A function with no file there has no baseline entry and registers as
movement every single run. Capturing them stops the churn AND closes the gap;
they are the same act.

Two of the three are from the temp-credential work, so this is a **recent** gap
rather than aged drift. That is the reassuring reading and it is also exactly how
`email-service` started — the difference there was only that nobody looked for 85
days. The mechanism is identical: production holding source the repo has no
record of, and a deploy from the checkout silently rolling it back.

```
supabase functions download … / or capture the DDL into supabase/sql/db-functions/
git add -A && git commit -m "Capture <fn>"      # source-only, no deploy
```

Until they are captured, treat the observer's movement counts as inflated by
three, and do not read those three as "changing constantly".

### Drift: the repo is authoritative, but only because it was made so

All 128 deployed functions now have source here. That is recent. `email-service`
was **85 days** behind production — the deployed copy had the action alias table,
link/open tracking, `bulk_send`, `bulk_schedule`, merge tags and attachments, and
the repo had none of it. A deploy from this checkout would have rolled all of it
back, reported success, and broken email marketing with no error anywhere.
`trestle-proxy` looked like a 2-day redeploy from timestamps and was actually a
`GET ?photo=` endpoint that listing emails depend on.

So the drift check does not ask "are the repo and production different" — they
are different every time you deploy, that is the point of deploying. It asks
**"is what is running something we have a record of"**, by comparing the deployed
bytes against every committed revision of that file on every branch:

- matches the working tree → in sync
- matches an earlier commit → the repo has moved ahead, deploying is safe
- matches nothing → production holds code that has never been in this repo.
  **Refused.** Capture it first:

```
supabase functions download <slug> --project-ref ljywhvbmsibwnssxpesh --use-api
git add -A && git commit -m "Capture deployed <slug>"     # source-only, no deploy
```

Sweep everything with `node tools/check-function-drift.mjs --all`. Run it before
trusting the repo on any function you have not personally touched.

## Backups

`weekly-backup` writes to Drive with **rene@'s** user token, not the service
account. Consequences, both learned the hard way:

- Nothing in the backup tree can be trashed through `gdrive-proxy` — its first
  guard requires SA ownership, and the SA cannot even read those files (the
  metadata fetch 404s). Cleanup there is a Drive-UI job.
- pg_cron job 2 `weekly-crm-backup` is **ACTIVE and running.** Corrected
  2026-08-11 — this file said it was disabled pending the R2 sync and that
  "nothing is currently producing backups". Both were false. Measured:
  `active = true`, schedule `0 8 * * 0`, last run **2026-08-09 08:00Z**, and
  `system_state:backup:last_verified` moved at `2026-08-09T08:00:02Z` carrying a
  real verified payload (leads: 1046 rows, file id, `verified_bytes` read back
  from Drive). The stated date of 2026-08-01 was also stale.

  Worth noting *why* this went unnoticed: a doc claiming a job is off is not
  self-correcting. Nothing contradicts it, because a job nobody believes is
  running is a job nobody checks. The R2-sync caveats below still stand — what
  was wrong was the claim that nothing runs.

**The R2 sync must read site files FROM THE REPO, not over HTTP.** Fetching
`https://beta.ratesandrealty.com/<path>` backs up whatever the edge happens to
serve: the site answers an unknown path with the marketing homepage and a 200,
so `admin/contacts.html` and `admin/leads.html` — neither of which exists —
backed up as byte-identical copies of `index.html` while the run reported
`errors: 0`. `fetchSiteFile` now hashes the site root once and rejects any file
whose bytes match it, but that is a guard against a problem the repo as source
does not have.

Three separate fixes have now closed the same shape of bug in this one function
— read the file back from Drive, assert the row count against the table, assert
the payload is not a soft 404. Assume the next one is also a place where
something checks a status code and never looks at the bytes.

## `net.http_post` results ARE knowable — `net._http_response`

It is easy to assume the opposite, because `net.http_post` returns a request id
immediately and `cron.job_run_details.status = 'succeeded'` only ever means "the
request was queued". Neither says whether anything answered. That assumption is
why cron breakages here have historically been found by noticing missing data
days later.

pg_net writes the actual result to `net._http_response`, keyed by that id:

```sql
select net.http_post(url := '…', headers := '…', body := '{}'::jsonb);  -- → id
select status_code, content, error_msg from net._http_response where id = <id>;
```

Used on 2026-08-07 to prove `market-rate`'s new guard accepts the real cron call
(200, rates written) rather than inferring it from a `succeeded` job row.

Two limits worth knowing. Retention is short — about **six hours** — so this is
for verifying a change now, not for auditing last week. And
`net.http_request_queue` drains, so once the row is gone you can no longer join
back to the URL that failed; capture what you need in the same session.

A first look showed **9 failed calls** sitting there unnoticed (8×500 "No item to
return was found", one 401, one 5 s timeout). Nothing watches this table. A
periodic sweep of it is the cheapest cron-failure alarm available, and does not
exist yet.

## Health alerts are a DIGEST keyed on the set of red checks

`gdrive-health-monitor` sends **one message listing every currently-red check**,
and the alert key is the **sorted set of red check names** —
`digest:drive_write+signature_records`. Not the first failure, not a
content-derived string.

The property that matters: **a new failure always breaks the cooldown**, because
a check that was not red before changes the set, which changes the key. A
12-hour cooldown on the old set cannot suppress it.

### What this replaced, and the 32 hours it cost

The old chain was `if / else if` down a priority list: it picked the single
highest red check, and then —

```js
const can = await shouldAlert(alert.key);
if (!can) { result.alert_skipped_reason = "cooldown"; return ok({ ... }); }
```

— **returned**. It did not fall through. So a cooldown on the top red check
silenced the *entire channel* for 12 hours, even when a lower check was red and
had never alerted once. Selection and suppression compounded.

That is not hypothetical. `storage_orphans` was red continuously from
2026-08-06 17:09, and between **2026-08-07 21:07 and 2026-08-09 05:17 — 32
hours, ~32 hourly runs — it was completely silent**, held under
`drive_write_probe_unrunnable`. It escaped exactly once, at 08-07 21:07, and
only by accident: the orphan count spread to a second bucket, so the key changed
from `storage_orphans:esign` to `storage_orphans:borrower-documents,esign`, and
a key with no cooldown history sends. The digest makes that accident the rule.

The same thing then happened to the signature-record check on its first run —
the `voe-forms` orphan masked it immediately, and it surfaced only because
somebody read the JSON rather than waiting for a text.

### The trade-off, stated on purpose

Keys are the check's **identity only**, never its content. This replaced three
separate accidents — `storage_orphans:<buckets>`, `static_keys:<names>`,
`signature_record_missing:<count>` — each of which baked its payload into the
key, so an orphan count moving 1→2 minted a new key and re-alerted while a
steady 1 stayed quiet for 12 hours.

**So a change WITHIN an already-reported check no longer re-alerts during the
cooldown window.** Orphans going 1→2, a second API key failing: silent until the
cooldown expires. That is deliberate. "Something new broke" is worth
interrupting someone for; "the thing you were already told about got slightly
worse" is not, and the alternative is the noise that trains people to stop
reading the messages.

### could-not-run vs failed survives into the digest

Each red check renders as `— FAILED` or `— COULD NOT RUN`, with different
markers, and the count line says how many could not run:

```
🔴 3 checks red (1 could NOT run)
  ⚠️ Drive write credential — COULD NOT RUN
  🔴 Signed record PDFs — FAILED
```

**This split is load-bearing, not cosmetic. It is how the Drive probe was found
at all.** Every `drive_write_credential` alert this monitor ever sent — one, on
2026-08-04 — actually meant `write_test_unavailable`: the fixture had been
deleted 29 minutes earlier and the credential was fine. An alert that says
"broken" when it means "untested" is how a real one stops being believed.
Flattening the two back into one line inside a digest would undo the reason the
digest exists.

### `cooldownFor` keys on the FACT, not the string

It used to be `alertKey === "drive_write_credential" ? 3 : 12`. Under digest
keys that string can never match again, so **the 3-hour urgent cadence would
have silently degraded to 12 hours** — a real regression that no test would
fail. It now takes a boolean: is the Drive write credential *genuinely broken*,
as opposed to merely unrunnable. An unrunnable probe stays at 12; nothing is
known to be failing, and a 3-hourly "could not check" is exactly the noise
described above.

### `monitor_runs` — the monitor's own history

`system_state:monitor:gdrive_health` is **overwritten every run** and holds only
the latest. That is why the 32-hour masking window above had to be *inferred*
from spacing between alert sends of different keys, rather than queried.

`public.monitor_runs` appends one row per run: `ran_at`, `status`, `red_keys[]`,
`unrunnable_keys[]`, `alert_key`, `alert_sent`, `skipped_reason`. Green runs are
recorded too — "nothing was red at 04:00" is what bounds when something started.

Finding masking events is now a query (there is a partial index for it):

```sql
select ran_at, red_keys, alert_key, alert_sent, skipped_reason
from monitor_runs
where array_length(red_keys, 1) > 1
order by ran_at desc;
```

**30-day retention is trimmed by the monitor itself**, inside `recordRun()`, not
by a separate cron job. The reasoning stands on its own — a retention job that
gets disabled leaves a table growing forever with nobody watching. (The example
originally cited here, job 2 `weekly-crm-backup` sitting disabled, was not true;
see the Backups section. The design argument does not depend on it.) The cleanup cannot
outlive the thing that maintains it. `recordRun` also never throws — a monitor
that dies because it could not write its own logbook is worse than one with a
gap in the logbook.

### `no_alert=1` — evaluating the monitor without paging anyone

A red run texts Rene's cell. Before this existed, the only way to prove a NEW
check actually goes red was to send a real alert — so new checks got added and
never broken, which is the exact failure "a harness that has only ever passed
proves nothing" warns about.

```
POST /gdrive-health-monitor  {"no_alert": true}     (or ?no_alert=1)
```

Computes everything, returns `would_send`, sends nothing. **It is checked BEFORE
the cooldown and does not consume one**, so a suppressed evaluation leaves the
real alerting state exactly as it found it — otherwise testing a check would
silence the next genuine alert. Per-invocation only: never persisted, never a
config value, and the run is still written to `monitor_runs` with
`skipped_reason = 'no_alert_requested'`, so a muted run is visible as muted
rather than as a healthy one.

### The ClickUp outbox check has TWO red conditions and they are different

`clickup_outbox` rows that reach `status='failed'` have burned all six attempts
and will never retry. Rows still `pending` long after they were due mean the
DRAIN is not running — which is what happened to three crons on 2026-08-15, each
failing for days with nothing looking.

**`next_attempt_at <= now()` is part of the stall condition, not a detail.** A
row backing off after failures is pending, old, and perfectly healthy; without
that clause the check reports the retry mechanism working as a fault. Proven by
a control row 121 minutes old and due in 24 — flagged as failed:1 stalled:1,
never stalled:2.

### NEVER add a check that can pass when it could not run

A check has three outcomes, not two: passed, failed, **could not run**. The
third must feed `allOk` as false — so `last_ok` cannot advance — and must be
reported in its own words. Two worked examples in this repo:

- **Drive write probe** (`checkDriveWriteCredential`) — returns
  `stage: "write_test_unavailable"` with `ok: false` when the probe folder is
  missing, and a 404 on the parent is classified as unavailable rather than a
  credential failure, because the credential was never exercised.
- **Signature-record sweep** (`checkSignatureRecords`) — returns
  `{ ok: false, ran: false, reason }` when its own query fails, and says
  "UNVERIFIED, not broken and not healthy".

The failure this prevents is the one that has already happened twice here: a
check that silently returns healthy because it never executed, and a green
dashboard over a broken pipeline.

## Call transcription — `call-intelligence`

Twilio Conversational Intelligence (classic). Transcript + Conversation Summary
land on the `calls_log` row; the summary also becomes a `contact_notes` row
tagged with the `calls_log` id.

Two Intelligence Services, because a Service's `language_code` is **immutable**:

| key in `app_config` | Service | language |
|---|---|---|
| `ci_service_sid_en` | `GA967fcc8190798affeda1f9b4d5547ca1` | en-US |
| `ci_service_sid_es` | `GA0ad8505bca56708f11da5cb8eda4ca06` | es-US |

Transcription runs on en-US; if the `NonEnglishCall` operator fires the same
recording is re-transcribed on es-US and that result wins. **Non-English calls
are billed twice**, deliberately.

`auto_transcribe` is OFF and should stay off — it transcribes every new
recording with no `CustomerKey`, and `CustomerKey` is the only thing tying a
transcript back to a `calls_log` row.

### A null transcript is never ambiguous

`transcript_status` is the point of the whole design: `null` = never requested,
`requested`, `ready`, `empty` (completed, no speech — the pipeline WORKED), and
`failed` (`transcript_error` says why). Four CHECK constraints enforce it —
`ready` cannot have no text, `failed` cannot have no reason, text cannot exist
with no status. A failure is a **write**, never just a return value: a function
that errors to its caller and leaves the row alone produces exactly the
ambiguity this removes.

`failed` with a transcript still present means a **re-run** failed and the
earlier transcript is retained; `transcript_error` says so explicitly.

### Transcripts are admin-only, and the column grants are what enforce it

`calls_log` RLS is `authenticated USING (true)` — every signed-in user reads
every row. So the gate is **column grants**, not RLS: `transcript`, `ai_summary`
and `transcript_sid` are NOT granted to `authenticated`. Reading goes through
`call-intelligence` `get`, which is admin-only, the way recordings go through
`get_recording`. `start` and `sync` are admin too — if you cannot read a
transcript you should not be able to commission one.

**Consequence: never `select('*')` from `calls_log` in a browser.** PostgREST
passes `*` through and Postgres refuses the WHOLE query when one column is
ungranted, so it blanks the timeline rather than hiding three fields.
`admin/lead-detail.html` uses an explicit column list for this reason.

### The webhook is signed, JSON-bodied, and is NOT the delivery guarantee

Twilio signs the Intelligence Service webhook — established by observation, not
docs, which only state it for Batch Transcription. **Its body is JSON, unlike
every other Twilio webhook here**, and `?bodySHA256=` on the URL is the marker:
Twilio appends it when it cannot fold form params into the signature, so the
signature covers the URL alone.

The first version parsed that JSON body as form-encoded, found no SID, and
returned **200 to Twilio while doing nothing**. Nothing alerted. It was found
only by forcing a transcript and watching the ROW rather than the response.

pg_cron job 43 `call-transcript-sweep` (*/10) is the actual guarantee. It does
two things, and the first matters more: it picks up recorded calls with
**`transcript_status IS NULL`** — the case where the kick-off in `twilio-voice`
never landed, which appears in no pending query and would otherwise be invisible
forever. It authenticates with `internal_call_headers()`.

### Dual-channel recording, and the trap in it

The two LIVE dial paths use `record="record-from-answer-dual"` since 2026-08-08.
`make_call` is deliberately still mono — it has **no caller anywhere in the
frontend** and its two legs are the same number (`Calls.json To=<to>`, then its
TwiML `<Dial>`s `<to>` again), so its channel roles are undefined. Treat that
self-dial as a separate unfixed defect.

**Compliance ordering is unaffected.** Twilio documents `record-from-answer` and
`record-from-answer-dual` with the identical trigger — both start "as soon as
the call is answered". Verified against the recordings themselves: no transcript
contains the disclosure text, and the whisper would be the first thing captured
if capture began before it finished.

### What makes recording lawful is now DIFFERENT PER DIRECTION

Changed 2026-08-12, and the asymmetry is the whole point.

| | basis | per-call announcement |
|---|---|---|
| **outbound** (dial path, `make_call`) | **consent captured at intake**, on the contact | **none** |
| **inbound** | the announcement itself | **yes — `<Say>` to the caller + whisper to staff** |

**Outbound plays nothing.** Rene obtains recording consent from every contact at
intake, before they enter the database, so an outbound call goes to someone who
has already agreed. Restating it on every call was redundant. The record lives on
`contacts.recording_consent_at` / `_method` / `_by` (`verbal_intake` | `signed` |
`portal`, closed set, two CHECK constraints, set through
`set_recording_consent`, which stamps `_by` from `auth.uid()` server-side).

**Inbound still announces, and must.** An inbound caller may not be in the
database at all — a first-time caller, a wrong number, someone else's client —
so there is no consent record to point at and the announcement IS the consent.
`canRecord()` still fail-closes that path: no disclosure, no capture.

**If you find yourself making the two paths consistent, stop.** You would be
removing the only basis one of them has.

**NOTHING WAS BACKFILLED.** All 1,047 contacts have `recording_consent_at IS
NULL`. Rene very likely has consent from most of them, but stamping an assumption
onto every row manufactures exactly the evidence the field exists to be — and a
fabricated consent record is worse than an absent one. The sidebar renders
"Recording consent: not on record" rather than a blank, so the absence is visible
on the contacts where it matters.

**The per-call recording toggle is gone** (same date, Rene's decision: always
record, always transcribe). No switch in the dialer, the lead-detail modal or the
power dialer; no `Record` param on `Device.connect`; `canRecord()` no longer
takes a `wanted` flag.

**`calls_log.recording_disposition` is KEPT, and it has FOUR states.** It used to
be stamped at DIAL time and never corrected, so a capture that was attempted and
failed was indistinguishable from one that worked — measured, 4 rows said
`recorded` and two of them had no `recording_url`. It now mirrors
`transcript_status`:

| value | meaning | written |
|---|---|---|
| `requested` | we asked Twilio to record; outcome not known yet | dial time |
| `recorded` | a recording exists | the status callback, on a URL |
| `unavailable` | capture attempted and FAILED, or the inbound disclosure could not play so `record=` was never sent | the status callback / preflight |
| `off` | historical only — the per-call toggle | — |

**Never stamp `recorded` at dial time.** Twilio posts `RecordingStatus`
`failed`/`absent` with NO `RecordingUrl`, and the callback's success branch keys
on the URL — so those posts used to fall through doing nothing. A failed capture
must be a WRITE, not an absence.

**Channel 1 is NOT always staff here.** Twilio puts the parent leg on channel 1
and Conversational Intelligence assumes channel 1 is the Agent. True for the
browser dialer; **backwards for inbound**, where the parent leg is the borrower
who rang in. `createTranscript` always sends an explicit `participants` mapping
derived from `calls_log.direction`.

**Never derive speaker labels from `media_channel` in the sentences.**
Conversational Intelligence returns TWO media_channels even for a `channels:1`
recording — both carrying the same mixed audio, transcribed twice. Believing it
produces `Rates and Realty: Hello?` / `Borrower: Hello?` from one person. It is
also why mono transcripts always looked as if every phrase were said twice.

`calls_log.recording_channels` (read from the Twilio Recording resource, cached
on the row) is the authority. **Unknown is treated as mono** — an unlabelled
transcript is merely less useful; a mislabelled one is a record of a
conversation that did not happen, on borrower NPI.

Formatting lives in `_shared/transcript-format.ts` with 12 tests next to it
covering mono, dual and the phantom-channel case, so neither era's path waits on
a real phone call for coverage.

**No Twilio cost change.** `recordings`, `recordingstorage` and
`voice-intelligence-transcription` are all billed in **minutes**, not bytes. The
file is ~2× on download; the billable quantity is identical.

## Security boundaries worth not breaking

- `gmail-inbox` downloads outbound attachments with the **service role**, which
  bypasses storage RLS. `_shared/attach.ts::attachmentPathError()` is the only
  control confining a path to the caller's own mailbox prefix. The mailbox is
  derived server-side from the verified JWT + `auth_user_roles`, never from the
  request body. Verified live: admin→processing@ prefix, admin→arbitrary object,
  va→rene@ prefix, va→rene@ mailbox, and `../` traversal all return 403.
- `video-track` must never read the viewer's identity from `authorization` — the
  Worker overwrites that header with the anon key to invoke the function at all.
  Self-view signals arrive as `x-viewer-staff` (from the `rr_staff` cookie
  `auth-guard.js` scopes to `.ratesandrealty.com`) and `x-viewer-jwt`.
- The public `/v/<slug>` page must never read a Supabase session from
  localStorage. It is served to borrowers, so any token it finds may be theirs.

## `auth-guard`'s `denyAccess()` is a CURTAIN, not a lock

Adding a page to `PAGE_ACCESS` in `admin/js/auth-guard.js` does **not** stop that
page loading data. It appends a fixed overlay over whatever already painted. The
content stays in the DOM — readable via devtools, the accessibility tree, or
select-all — and because page gating awaits `current_app_role()`, any page that
renders on CLIENT-ready rather than GATE-ready paints first and gets covered
second. Found by render-check on `va-people`: the row data sat under the lock
screen.

Three consequences. The first is not about rendering at all, and it is the one
that has actually bitten.

### 1. A page's DATA SOURCES must be at least as narrow as the page

`PAGE_ACCESS` gates a URL. It does nothing to the RPCs and edge functions that
URL calls, and those are reachable directly regardless. **When the gate and the
source disagree, the source wins.**

`admin/insights.html` is `['admin']`, but `insights-data` called
`requireStaff(req)` with no roles option — which defaults to
`STAFF_ROLES = ['admin','va','agent','loa']`, so a VA passed. The page said
admin-only and its data said staff. `requireStaff` DEFAULTS OPEN relative to
admin; pass `{ roles: ['admin'] }` explicitly on anything an admin-only page
calls.

Same shape, opposite verdict: `va_productivity_report` deliberately allows
`('admin','va','agent')`. That is not a bug — a VA seeing her own productivity is
reasonable. What was wrong is reaching it from an admin-only page. Narrow the
source, or move the feature; do not assume the broader role is a mistake.

### 2. Listing a page in `PAGE_ACCESS` does not stop it fetching

It only decides whether an overlay appears afterwards. Every request the page
makes still goes out, under the user's real session, and is answered on the
server's terms. If the server answers, the data arrives and is painted.

### 3. The fix is to NOT FETCH, not to hide

**Three** working patterns, and the third is the one people miss — reaching for
the page gate by default is how a shared page gets taken away from someone to
fix one panel.

**c) A PANEL THAT HIDES ON 403** — when the page is legitimately open and only
one panel is narrower than it.

**CORRECTION, 2026-08-15: this section used to say `dashboard/admin.html` is the
VA's daily workspace. IT IS NOT, AND SHE CANNOT REACH IT.** The pattern below is
still right and still worth using — it is just not motivated by this page. What
was wrong is the audience, and it had been repeated into the task-rebuild notes
as "gating this would be worse for Aubrey than for Rene", which is backwards.

Measured, not inferred:

- `components/admin-dashboard.js:176` calls `requireAdmin()`, which checks the
  hardcoded `ADMIN_EMAILS` allowlist — `["rene@ratesandrealty.com"]` — and
  redirects anyone else to `/admin/people.html`. It never consults
  `auth_user_roles`, so her `role='va'` is irrelevant to it.
- `auth/admin-login.html` sends `role === 'va'` to **`/admin/va-dashboard.html`**;
  `components/auth-page.js` sends a non-admin to the borrower portal. Neither
  login routes a VA here.
- `admin/people.html` **deliberately hides** the Dashboard link from VAs —
  `vahideDashboard`, in a block commented "Hide admin-only topbar actions".
- Edge logs, her uid, the full 24-hour retention window: 42 requests —
  `va_dashboard`, staff chat, `presence_beat`, `current_app_role`. **Zero calls
  to `insights-data` or `calendar-data`, and no `/rest/v1/leads|appointments|tasks`
  reads at all.** The same query finds the automation account's `calendar-data`
  calls, so it is capable of finding what it is looking for.

Her real workspace is `/admin/va-dashboard.html` + `/admin/va-tasks.html`, both
gated `['va','admin']` in `PAGE_ACCESS`.

**Both pages linked her into that wall until 2026-08-15 — now fixed.**
`admin/va-help.html` and `admin/va-training.html` rendered an ungated
"← Dashboard" link straight to `/dashboard/admin`, and neither page is in
`PAGE_ACCESS`, so a VA could open them and click a link that bounced her to
`/admin/people.html` — the exact "nav button leading nowhere" defect this
section names.

Both now DEFAULT the href to `/admin/va-dashboard.html`, which is gated
`['va','admin']` and therefore correct for **both** roles, and upgrade to
`/dashboard/admin` only when the resolved role is admin. The upgrade runs after
`_rrGateReady` settles, because `auth-guard` writes `rnr_app_role`
asynchronously and reading it at parse time gets an empty string. **If the gate
never settles the link simply stays at the safe default** — the failure mode is
one extra click, never a dead end. That direction is deliberate: defaulting to
the admin page and downgrading would reinstate the original bug for anyone whose
role resolves late.

The pattern itself, on its own merits:

**c) A PANEL THAT HIDES ON 403** — when the page is legitimately open and only
one panel is narrower than it. `dashboard/utils/insights.js` hides the Insights
section AND its nav entry when `insights-data` comes back 401/403, and moves the
user off the hash if they are sitting on it.

The distinction that makes this safe: **the refusal is flagged on the error
object at the fetch (`err.notPermitted = true`, set only for 401/403), never by
matching an error message.** Every other failure — network, 500, bad JSON — still
renders visibly. A panel that hides itself must not become the way real breakage
disappears, and string-matching a message is how that starts.

Use (c) only when the page genuinely belongs to the broader role. If the whole
page is admin work, gate the page.

The other two:

- `admin/settings.html` — checks the role and **returns before fetching**:
  `if (role !== 'admin') { ...show notice...; return; }` with the comment
  "Do not fetch any user data."
- `admin/va-people.html` — awaits `window._rrGateReady` (settled on allow, on
  deny, and on the admin/null-role paths that skip gating) before rendering,
  bounded so a guard that never settles cannot hang the page.

Either is a lock. The overlay alone is not. And neither replaces the server-side
control: RLS, a column grant, or an in-function role check is what actually
decides, and the page-level work only stops a denied page painting data it
should never have been handed.

**Known outstanding:** 12 pages in `PAGE_ACCESS` still render before the gate
settles. Of the eight admin-only ones, `vault`, `referral-partners` and
`partner-detail` are safe because every load-time RPC raises `admin only`, and
`settings` is safe by its own early return. `insights` and `reports` were the
leakers; `earnings-dashboard` and `emc-import` are unmeasured and need a real VA
token to settle, because a stubbed run reports every page empty and that is an
artefact of the stub, not a fact about RLS.

## `verify_jwt = true` is NOT an access control

The gateway checks only that the bearer is a JWT **signed by this project** — not
which key, not what role. **The anon key is a project-signed JWT and it is public**,
printed in every page's source. So a function pinned `verify_jwt = true` with no
in-function check is open to anyone who reads the HTML.

`sms-service` was pinned true on 2026-08-03 *specifically to close it*, and the
pin comment said so. It never closed it: with the public anon key it still reaches
the function and will send an SMS from the business line.

**19 functions are in this state.** They are listed, tiered and assigned a guard
type in `docs/PINNED-NOT-GUARDED.md`. Read that before pinning anything as a fix.

The pin is still worth having — it stops a deploy silently flipping the value —
but it is a STABILITY control, not an access one. Access needs either a session
guard (`getUser` + `auth_user_roles`, as in `communications-admin` and
`calendar-data`) or, where the caller has no session, a row-held token validated
in-function (as `lender-portal` does with `lenders.form_token`).

## Every function in `public` is anon-executable at birth, and the obvious fix is a no-op

`ALTER DEFAULT PRIVILEGES` on schema `public` grants `EXECUTE ON FUNCTIONS` to
`anon`, `authenticated` and `service_role` (`pg_default_acl`, set by both
`postgres` and `supabase_admin`). So a function is anon-executable the moment it
exists, before anyone writes a grant — which also means the
`grant execute … to authenticated, service_role` lines all over
`supabase/migrations/` read as restrictions and are **no-ops**.

**THE TRAP: `ALTER DEFAULT PRIVILEGES … REVOKE` REPORTS SUCCESS AND DOES NOTHING.**

`pg_default_acl` does not store the ACL a new object receives. It stores a
**delta merged on top of the hard-wired `acldefault()`**, which for functions is
always `{=X/owner, owner=X/owner}` — PUBLIC has EXECUTE. **A delta can only
ADD.** There is no representation for "PUBLIC must not get EXECUTE", so:

```sql
alter default privileges in schema public revoke execute on functions from public;
-- succeeds. pg_default_acl is BYTE-IDENTICAL afterwards.
```

And the `anon` half is **worse than useless**, because it half-works. Measured:

```
alter default privileges in schema public revoke execute on functions from anon;
create function zz_probe_after() …
  proacl  {=X/postgres,postgres=X,authenticated=X,service_role=X}   ← anon=X gone
  has_function_privilege('anon', …)  =  TRUE                        ← still executes
```

The `anon=X` line disappears and `anon` still executes it, via the `=X` PUBLIC
grant it inherits. **A sweep grepping `proacl` for `anon=` now reports that
function clean.** Same family as `verify_jwt = true` — a statement that looks
like an access control and is not — except this one also blinds the check that
would have caught it. Do not ship it.

**What works is an event trigger.** `rr_revoke_new_function_grants`
(`ddl_command_end`, `tag = 'CREATE FUNCTION'`) revokes `public, anon` off every
new function in `public`, skipping extension members. New functions land as
`{postgres=X,authenticated=X,service_role=X}` — the same shape as the
hand-revoked `quote_reply_match`.

**Recovery, if it ever raises and blocks DDL** — a raising event trigger blocks
every `CREATE FUNCTION` in the database, including the one that would fix it:

```sql
alter event trigger rr_revoke_new_function_grants disable;
```

Its per-function work is already wrapped in `exception when others → raise
warning` for that reason. `postgres` owns the trigger, so the disable is always
available.

### The allowlist, and what happens when someone adds a fourth public RPC

The tag for `CREATE OR REPLACE FUNCTION` is still `CREATE FUNCTION`, so the
trigger fires on ordinary maintenance edits — and would strip `anon` from a
function that legitimately needs it. So the trigger **re-grants** from an
allowlist held as an array **inside the function body** (comments above a
`CREATE` do not survive `recapture-db-functions`):

```
get_cma_snapshot        public/cma.html   /cma/<slug>
get_fee_sheet_snapshot  public/fee.html   /fee/<slug>
video_get_public        watch.html        /watch?v=<slug>
```

Those three are the entire direct-anon `.rpc()` surface in the tree. Every other
anonymous surface — lender portal, borrower portal, tours, e-sign, newsletter —
goes through an edge function on the service role, where function grants do not
apply. Both directions are proven, on the real functions:
`get_cma_snapshot` survives a replace, `hoi_quote_meta` does not.

**A fourth public RPC that is not added to the list is not broken at the point of
change.** A migration that creates it and grants `anon` afterwards works — the
trigger fires at `ddl_command_end` of the `CREATE`, and the explicit `GRANT` runs
after it. What the list buys is survival of the **next `CREATE OR REPLACE`**,
months later, in an unrelated change.

**And that failure is close to silent.** How each page reports a `42501`:

| page | console | what the borrower sees |
|---|---|---|
| `public/cma.html` | `console.**warn**` | "This report is temporarily unavailable." |
| `public/fee.html` | `console.**warn**` | "This estimate is temporarily unavailable." |
| `watch.html` | `console.error` | "Could not load the video." |

**Two of the three are `console.warn`, which render-check does not fail on**, and
all three word a permanent permission failure as a transient one. What actually
catches it is the `anonymous: true` specs — `/cma/<slug>` ×2 and `/fee/<slug>` ×2
run signed-out and unstubbed against production and assert on the RPC's real
return, so a stripped grant fails them. **`video_get_public` has no spec at all**
and is the one that would go unnoticed. Add a spec with the RPC.

### This is the inflow fix only. It closes NONE of the backlog.

Default privileges and event triggers both apply at **CREATE time**. Measured
straight after the trigger landed: **319 application functions are still
anon-executable**, exactly as before. The trigger stops number 320.

Because it changes nothing about the running system, **"the site still works" is
not evidence it landed.** The only proof is to create a function and read its
ACL — which is what the migration's own `DO` block does, and why it stays there.

Scope, corrected — earlier counts were inflated by pgvector: **506** functions in
`public`, **118** of them `vector` extension members (owned by `supabase_admin`,
whose `pg_default_acl` row we cannot reach — `postgres` is not a member of it),
leaving **388** application functions, **319** anon-executable, **251** of those
`SECURITY DEFINER`.

## A VIEW bypasses RLS — and that is how the whole contact book leaked

**A view is not subject to the underlying table's RLS unless it is declared
`security_invoker`.** It runs as its owner. So `anon` holding `SELECT` on a
DEFINER view over a protected table reads straight past every control on that
table.

Found 2026-08-20. `contacts_live` returned **1,046 borrower records** — name,
email, phone, address, date of birth, `ssn_last4` — to the anon key printed in
every page. No input, no uuid, no secret. Measured contrast, same key, same
request shape:

```
GET /rest/v1/loan_income     ->  []          RLS holds, the control works
GET /rest/v1/contacts_live   ->  1046 rows   the view walked straight past it
```

`borrower_qualifying_snapshot` was the same, for income and affordability. Both
revoked; both now 42501.

**This is worse than every function oracle in this file.** Those needed an input
to pivot on and returned one record at a time. A view returns the book.

### The three conditions, and the check nobody had

The dangerous combination is queryable, and all three parts must hold:

1. the view is **not** `security_invoker`,
2. it reads a table with **RLS enabled**, and
3. **`anon` has SELECT** on it.

Measured across all 13 views in `public`: 7 are DEFINER, 5 of those read an
RLS-bearing table, and 3 of those are still anon-selectable — `contacts_secure`,
`contacts_secure_live`, `mortgage_applications_secure`. **They return `[]` today
only because their own predicates key on `auth.uid()`, which is null for anon.
That is a WHERE clause, not a grant.** `contacts_live` differed from them only in
not having one. One careless edit reproduces the incident.

**Create new views over borrower data `WITH (security_invoker = on)`**, and grant
`anon` SELECT only where a genuinely public page reads it. Today none does — the
entire public surface is three slug-gated RPCs (`get_cma_snapshot`,
`get_fee_sheet_snapshot`, `video_get_public`).

### The repo captures 389 functions and ZERO views

`tools/recapture-db-functions.mjs` reads `pg_proc`. Nothing reads `pg_class` for
`relkind in ('v','m')`. **`contacts_live` has no `CREATE VIEW` statement anywhere
in this repository** — eight committed db-functions read it, nothing creates it,
and it is not in `supabase/migrations/`. So it cannot be dated from git and the
exposure window cannot be bounded from the repo.

That is the same shape as the edge-function drift this file already documents —
*production holding source the repo has never seen* — which cost 85 days on
`email-service`. The drift check exists because that mattered. **Views were never
brought into it, and the object that leaked the contact book is exactly a view the
repo has no record of.**

### `pg_stat_statements` is the artifact when the logs are gone

Edge/API log retention is 24 hours, which is useless for an exposure that may have
run for months. `pg_stat_statements` survives — and it records the role a
statement executed as, so a PostgREST anonymous read appears under
`userid = anon`, with `stats_since` giving first-seen.

Used here to establish that the only anonymous reads of either view in 3.5 months
of history were **my own probes from that morning**, timestamped seconds apart.

Its limits, which must be stated with any such claim: it **evicts** (4,881 of a
5,000 cap here, so absence is not proof), its window starts at the last
`stats_reset`, it counts statements rather than clients, and it carries no IP and
no per-call timestamp.

## A guard on a function with a browser caller is FRONTEND-FIRST. Always.

**Adding, tightening, or changing authentication on an edge function that any
page calls? Ship the frontend change first, have it confirmed working, and only
then land the guard.** Not a judgement call per function. Not "the frontend
change is obviously right so both can go together". The order is the rule.

Both halves matter and they are separate steps:

1. Change the caller to send what the guard will require — usually the user's
   session token instead of the anon key, which is printed in the page and
   identifies nobody.
2. **Have a human confirm the page still works.** Loading is not enough: exercise
   every path that calls the function. For the Communications inbox that was
   load, send AND search, and the send paths were only proven by sending.
3. Then land the guard.

Done in that order, a mistake in step 1 shows up as a page that still works
because the function has not started enforcing yet. Done backwards, the same
mistake is an outage, and you cannot tell whether the token or the guard is at
fault because both changed at once.

This is written down because it was followed for `communications-admin` and not
for `email-service`, in the same session, hours apart. The second one gated every
action while `admin/lead-detail.html` and `admin/email-marketing.html` were still
sending the anon key: sending an email from a lead record returned 401 for about
twelve minutes. The browser callers HAD been audited beforehand — the conclusion
"they send the anon key" simply never became "so they break the moment this
ships".

**Audit both sides before writing the guard.** Browser callers and internal
callers. `esign` calls `email-service` with `{ 'apikey': SERVICE }` and NO
`Authorization` header, so an Authorization-only check 401s every e-signature
invite, cancellation and completion email — and `sendRaw` swallows the failure in
a bare `catch`, so it fails silently on a legally significant path. Five other
internal callers send `Authorization`; that one does not.

**Then check how each caller reports failure**, because that decides whether a
mistake is loud or silent. In the same composer, three call sites and three
behaviours: `send` shows `Send failed: <error>` and leaves the composer open with
the draft intact; the scheduled send checks `res.ok` and alerts; `saveEmailDraft`
never looks at the response at all — it toasts "Draft saved" and closes the
composer, discarding the text, whatever the server said.

## Quiet hours: we cannot tell whether a recipient is staff

TCPA covers texts the same as calls. `twilio-voice` has enforced calling hours
for a while; `sms-service` had **nothing** — the only guard that ever existed was
a `confirm()` in `power-dialer.html`, which a user can click past and which no
other caller had at all. The VA works 5pm–2am Pacific, the exact window the rule
protects. `voicemail_drop` is still unguarded at the time of writing.

`sms-service` now has `quietHours()`, mirroring `callingHours()` including
allow-and-log on an unknown area code. **Staged behind `SMS_QUIET_HOURS`, which
defaults OFF.** While off the check still runs and still writes its verdict to
`audit_log` as `SMS_WOULD_BLOCK`, so the decisions it would have made are visible
before it starts making them.

### Why there are eight bypasses and not one lookup

The largest exemption category is **"the recipient is staff"** — a health alert
to Rene's cell, a staff-to-staff message, the tour notices `unified-portal.html`
sends to a hardcoded `+17144728508`. None of that is a consumer being marketed
to, and blocking it would silence the monitor overnight, which is exactly how the
32-hour masking window happened.

**We cannot detect it.** There is no staff-phone source anywhere in this project.
No `staff_*` table holds a number — `staff_messages`, `staff_threads`,
`staff_thread_participants`, `staff_view_as_log` are all message plumbing. The
only staff number available anywhere is the `RENE_CELL` env var, which covers one
person. Resolving staff numbers through `auth_user_roles` is not clean and would
still miss anyone without a CRM login.

So the rule cannot key on WHO is being texted. It keys on the CALLER declaring
why it is exempt:

```
quiet_hours_bypass: 'staff_alert' | 'staff_message' | 'user_initiated'
```

**Closed set, and an unrecognised value FAILS THE SEND.** Free text would become
"urgent" meaning "I did not want to think about it", and a bypass nobody can
enumerate is not a bypass, it is the absence of a rule.

- `staff_alert` — recipient is staff. `gdrive-health-monitor`, `unified-portal`'s
  two tour notices.
- `staff_message` — staff-to-staff. `admin/js/staff-chat.js`.
- `user_initiated` — the recipient acted a moment ago and this is the reply or
  confirmation: `ai-sms-bot` answering an inbound text, `calcom-webhook`,
  `newsletter-signup`, `tour-public-view`, `tours-admin` `initial_share` /
  `cancel_notice`, `esign`. Consented transactional traffic, not marketing.

Deliberately NOT exempt: reminders, listing alerts, campaigns, and anything staff
composes and sends outbound. That is the traffic the rule exists for.

### Flipping the flags — the order matters, and the two paths are NOT alike

Two staged quiet-hours flags, both OFF: `SMS_QUIET_HOURS` (sms-service) and
`VOICE_QUIET_HOURS` (twilio-voice `voicemail_drop` **only**). The dial path and
`make_call` have enforced hours for a long time and are deliberately **not**
behind any flag — verified: `VOICE_QUIET_HOURS` appears at five lines in the
repo, all inside the `voicemail_drop` handler, and the twelve lines around each
older check contain zero references. Proven controls must not become switchable
because a switch exists nearby.

Each flag needs the same two probes before it flips:

1. outside the window → refused, with the recipient's local time in the reason
2. inside the window → still sends

**But the two paths do not start from the same place, and that changes what a
failed probe means.**

| path | history | what the probes actually test |
|---|---|---|
| `sms-service` | 141 sends in 30 days | the GUARD only — the path is proven working |
| `voicemail_drop` | **ZERO all time** — `calls_log` has never recorded one | the guard AND the feature, tangled |

**`voicemail_drop` has never run in production.** So probe 2 cannot distinguish
"the guard wrongly blocked it" from "voicemail drop was already broken and nobody
noticed" — there is no working baseline to regress from.

**So for voicemail_drop the order is:**

1. With `VOICE_QUIET_HOURS` still OFF, exercise ONE drop inside the calling
   window and confirm it reaches Twilio and writes its `calls_log` row. That
   establishes the feature works at all. Use `+1 555 555 XXXX` — the number is
   unroutable, so what is proven is that the request is accepted and logged, not
   that a voicemail was heard.
2. Only then flip the flag and run the two probes.

For `sms-service`, step 1 is unnecessary. 141 sends is the baseline.

### Testing an hours guard: the number and the clock both matter

**NPA 555 CANNOT EXERCISE A REFUSAL.** `area_code_timezones` has no row for
`555`, so `+1 555 555 XXXX` always takes the unknown-area-code branch — allowed
and logged — and there is no local time to put in the reason. A probe with it
proves the allow-and-log path and nothing about blocking. This is not a bug in
the guard; allow-on-unknown is deliberate.

**Use `+1 714 555 0142`.** Area code 714 maps to `America/Los_Angeles`, and the
exchange range **555-0100 → 555-0199 is NANPA-reserved for fictional use in every
area code**, so it is as unroutable as NPA 555 while having a real timezone. That
is the canonical test number for anything hours-related, voice or SMS.

Proven with it on 2026-08-10, flag OFF:

```
operation   SMS_WOULD_BLOCK        (SMS_BLOCKED once enforced)
enforced    false
to          +17145550142
area_code   714      tz America/Los_Angeles      local_time 1:10 AM
reason      It is 1:10 AM for the person you are texting (area code 714,
            America/Los_Angeles). Texts are limited to 8:00 AM–9:00 PM in
            their local time.
```

The send still went out, because the flag governs whether we ACT on the verdict,
never whether we compute it. That is the staging contract working.

**THE INSIDE-THE-WINDOW PROBE ONLY PASSES IN DAYLIGHT.** "Inside the window →
still sends" requires the run to happen between 8am and 9pm **in the recipient's
timezone**. At 01:00 Pacific every US area code is outside the window, so the
probe cannot pass at night for any number — and a guard that refuses at 2am is
CORRECT, not broken.

Write that down because the failure mode is social, not technical: someone runs
the suite late, sees the refusal, concludes the guard is over-firing, and
"fixes" it. If a test can only pass during business hours, say so next to the
test or it will eventually be repaired into uselessness.

Get this backwards and it costs a day: flip the flag, a drop fails, and the day
goes on debugging a guard that was working, on a feature that never did. The
steps look identical for both paths and are not.

### SEVEN functions never reach `quietHours()` at all

Logged 2026-08-15, not fixed — `docs/SMS-BYPASSES-QUIET-HOURS-2026-08-15.md`.

`quietHours()` lives in `sms-service`. Seven other edge functions call
`api.twilio.com/…/Messages.json` **directly**, so they do not bypass the flag —
they never evaluate the check, and write no `SMS_WOULD_BLOCK` row either:

    proactive-followups   job 21, EVERY 6 HOURS -> fires at 06:00Z = 10pm/11pm PT
    send-scheduled-sms    job 39, EVERY MINUTE
    loan-date-nudges      job 38, 15:00Z  (the one that texted Rene's real phone)
    sms-inbound-reconcile · sms-assistant · twilio-inbound · ocr-mms-upload

**This makes the staging data misleading in the reassuring direction.** The
whole reason `SMS_QUIET_HOURS` defaults OFF while still writing its verdict to
`audit_log` is so the decisions it WOULD make can be reviewed before it starts
making them. Those seven contribute nothing to that record, so the audit trail
under-reports what the guard would catch — and reads as "quiet hours would have
blocked almost nothing".

**Anything new that sends must route through `sms-service`** and declare a
bypass from the closed set. Do not copy `loan-date-nudges` as a model; it is on
this list.

### The consequence, which is the part that will bite

**Every new `sms-service` caller must now choose its bypass by hand**, and a
forgotten one fails CLOSED — the message silently stops going out at night, which
is the hardest failure to notice and the one this codebase keeps rediscovering.
Adding a caller is no longer a one-line change.

**If a staff-phone source ever exists, this whole scheme collapses into one
lookup.** A `staff_phones` table, or phone numbers on `auth_user_roles`, would let
`quietHours()` answer "is this a consumer?" directly, and `staff_alert` and
`staff_message` would both disappear — leaving only `user_initiated`, which is a
genuine policy exemption rather than a workaround for missing data. Build that
source before adding a fourth reason to the set.

## `assigned_to` is TWO columns with one name, and only one is a control

They look identical in a grep. This already sent one spec wrong: a "show the VA
her assigned leads" request was written against `contacts.assigned_to`, which
would have rendered an empty page.

| | `contacts.assigned_to` | `tasks.assigned_to` |
|---|---|---|
| type | **text** | **uuid** → a real user |
| written by | one free-text box, `lead-detail.html` Lead Details | `tg_tasks_autoassign` via `va_account_uid()`, and `va_task_add` |
| read for | display, and as a `people-admin` filter option | **permissions** |
| gates anything? | **NO** — 0 RLS policies reference it | **YES** — `va_daily_tasks`, `va_task_list`, `add_task_note` |
| actual data | 1046 of 1046 rows say Rene, under two spellings: `reneduarte.realty1@gmail.com` (974) and `Rene D.` (72) | real per-user assignment |

**`contacts.assigned_to` is a label, not a control.** Nothing depends on it, which
is why it degraded into two spellings of one person without anything breaking.
Do not build access logic, filters that imply ownership, or "my leads" features
on it. Typing it properly would not help: all 1046 rows resolve to one human, so
a correctly-typed version returns zero for anyone else. The problem is that
nothing has ever been assigned to anyone but Rene, and a type change does not
create assignments.

**`tasks.assigned_to` is load-bearing.** `tg_tasks_autoassign` stamps it with
`va_account_uid()` for `related_table='loan_orders'`, and three functions gate on
`assigned_to = auth.uid()`. Changing it changes who can see and act on work.

### What "the VA's leads" actually means

`lead_shares(contact_id, shared_with_user_id, …)`, surfaced by
`is_lead_shared_with_me()` and `va_shared_leads()`, driven by the **Share with VA**
toggle on lead-detail (`admin/js/lead-share.js`, admin-only by RLS).

That one IS enforced: `contacts_select_scoped` and `contacts_update_scoped` both
reference it, as does `contacts_secure`. It is the real delegation mechanism and
it has real data. `admin/va-people.html` is built on it.

So: **"assigned" is a word on a form. "shared" is the permission.** When a request
says "assigned to the VA", it almost certainly means shared.

## Four things that keep biting in the Postgres function layer

Each of these has now caught a second author after the first one wrote a warning
about it. They are cheap to avoid and expensive to diagnose, because most of
them fail at RUNTIME with a message that points somewhere else — or, in the case
of the first, do not fail at all.

### `CREATE OR REPLACE` with a new defaulted parameter creates an OVERLOAD

**It does not replace anything, and it reports success.** A different argument
list is a different function, so

```sql
create or replace function f(a text, b text default null)   -- f already exists as f(a text)
```

leaves **both** live. Every existing caller supplies the old argument list and
relies on defaults, which is exactly the shape that resolves ambiguously — and
PostgREST will happily pick one until the day it picks the other.

**Bitten twice in two days.** `task_upsert` on 2026-08-19 (dropped and recreated
with all ten parameters, and the reason written into that migration), and then
`quote_reply_match` hours later, adding `p_gmail_thread_id`. The lesson did not
transfer, and the reason it did not is the whole problem: **a replace that
silently adds looks identical to one that replaces.** Nothing errors, nothing
warns, and the function you just wrote is live and working — beside the one you
meant to remove.

**THE DETECTION IS `tools/recapture-db-functions.mjs` WRITING TWO FILES FOR ONE
NAME.** That is what caught it both times, and it is the cheapest check there is:

```
captured  quote_reply_match__p_in_reply_to_text_..._f0b761.sql
captured  quote_reply_match__p_in_reply_to_text_..._fb528c.sql
OK — 2 function file(s) refreshed from production.
```

One name, two files, disambiguated by an argument-list hash. If you see that,
you created an overload. Recapture after every signature change, and read the
count.

So: **adding or removing a parameter means `drop function` first**, in the same
transaction as the `create`. And remember the other half — **dropping takes the
GRANTS with it**, which fails silently as `permission denied for function …` on
a function that plainly exists. Capture `proacl` before, restore after:

```sql
select p.oid::regprocedure, p.proacl::text
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'the_function';
```

Changing a `RETURNS TABLE` forces the same drop for a different reason —
Postgres refuses outright with `cannot change return type of existing function`.
That one at least tells you.

### `auth.users.email` is `varchar(255)`, not `text`

A `RETURNS TABLE(... email text ...)` that selects `u.email` fails with

```
structure of query does not match function result type
DETAIL: Returned type character varying(255) does not match expected type text in column 12
```

and the error names the COLUMN NUMBER, not the column, so on a 21-column return
you are counting commas to find it. `va_daily_tasks` already carries a comment
about this exact class of failure — for `due_date` being `timestamp` rather than
`timestamptz` — and `task_list` still hit it on `email` the next time somebody
wrote a returns-table over `tasks`.

**Cast it: `u.email::text`.** The same applies to any `auth` schema column; that
schema is GoTrue's and its types are not ours to assume.

### `*/5` inside a `/* */` comment closes the comment

Writing a cron expression in a block comment —

```sql
/* Step 4 replaces this with an outbox a */5 cron drains. */
```

— terminates the comment at `*/`, and the rest of the sentence becomes SQL. The
migration fails at a syntax error whose caret points at `5`, several lines from
anything that looks wrong.

**Write cron schedules in prose inside SQL comments** ("a five-minute cron"), or
put them in a `--` line comment where `*/` is inert.

### A network-stack error is NOT a `console.error()` call

DevTools' red error badge counts both. `Runtime.consoleAPICalled` over CDP sees
only the second. So a console-only capture reports **0 errors on a page showing
5**, and reads as a clean bill of health.

Measured on `admin/lead-detail.html` with a real session:

```
Runtime.consoleAPICalled  type=error ......  0
Network.responseReceived  status>=400 .....  2   <- 403 x2, the actual defect
Log.entryAdded            source=network ...  2
```

Those two 403s were the only difference between a fixture lead and a real one,
and the only thing on the page with a user-visible cost. A capture that watched
the console alone would have missed the finding entirely and reported the page
as error-free.

**Capture `Network.responseReceived` (status >= 400), `Network.loadingFailed`
and `Log.entryAdded` alongside the console**, or do not claim an error count.
Same family as the trap below: the harness reports fewer problems than exist,
which is why nobody questions it.

### A DevTools "Issues" capture without a forced layout under-reports by 30×

Counting `Audits.issueAdded` over CDP looks like a complete measurement and is
not. Same URL, same browser, same wait, twice:

```
Audits.enable + Page.enable only ............................   7 issues
    + Emulation.setDeviceMetricsOverride(1440x900) ..........  207 issues
```

The 200 missing ones are `FormLabelHasNeitherForNorNestedInputError` — accessibility
issues that only exist once the layout and accessibility tree have been built.
Without a viewport override the headless default never lays the page out far
enough to produce them, and the capture reports a clean-looking 7.

**Force a viewport before trusting an Issues count.** And note the shape of the
mistake: a harness that reports FEWER problems than exist reads as good news,
which is why it survives. This is the same family as the `#loanAmount` readonly
break-test that passed every time.

Related: an Audits issue's TIMESTAMP is not a reliable document attribution
across a redirect. The CSP violation in the lead-detail audit was attributed to
lead-detail by arrival time and actually belonged to the login page it redirected
to; `Log.entryAdded` carries the document URL and got it right.

### The render-check stub does not cover `admin-api-v2.js` pages AT ALL

The stub owns `window.supabase` and defends that ownership carefully — the
non-writable property with a swallowing setter, described above. But
`api/supabase-client.js` never touches the global:

```js
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { … });
```

Its own client, from its own module import. The stub cannot see it, and
render-check has no request interception to reach it. So for **every page whose
data arrives through `api/admin-api-v2.js`** — all of `dashboard/admin`, the CRM
task board included — `spec.tables`, `spec.rpc` and `spec.stubRow` are **inert**,
and the page talks to real PostgREST as anon.

**Consequence: every assertion on `dashboard/admin` run without `--token` has
been passing against zero rendered cards.** Anon gets nothing back, the board
renders empty, and a presence-only assertion on a container that exists but is
empty passes — the identical shape to the `#shell` break-test above, which is the
failure this harness was built to catch.

This is why the board refusal spec was `tokenOnly` — and since 2026-08-19 it is
**`ownerOnly`**, which is stricter: a token is not enough either, because
`requireAdmin()` redirects every account this harness can authenticate as. It is
excluded from both modes and announced on every run. The vacuous-pass reasoning
below is unchanged and is exactly why the flag must not simply be removed. It is
also why a green
dashboard/admin run without a token should be read as **untested**, not passing.

Closing it means intercepting the module (CDP `Fetch`, the way the surface-1
verification served a branch file) rather than owning a global. Until then the
gap is load-bearing: assume any dashboard/admin coverage you did not personally
run with `--token` proves nothing.

Same family as the two traps above — the harness reports fewer problems than
exist, which is precisely why nobody questions it.

### Rationale written ABOVE a `CREATE` does not survive

`tools/recapture-db-functions.mjs` pulls `pg_get_functiondef` out of Postgres,
which returns the `CREATE` statement and nothing else. Any comment block written
before it — the usual place to explain a change in a migration — is silently
dropped the next time the function is recaptured.

This is worst for functions whose whole point is non-obvious. `_task_clickup_sync`
was captured back as a bare no-op with no explanation of why a function that does
nothing exists, which is exactly the shape somebody deletes while tidying up.

**Put the reasoning INSIDE the function body**, after `AS $function$`. If it
matters enough to write down, it matters enough to survive a recapture.

## Probes and tests never touch a borrower's things

**A probe, health check, or test fixture must never create, modify, or delete
anything inside a resource that belongs to a borrower, a lender, or a real
person.** Not a Drive folder, not a contact, not an `uploaded_documents` row,
not a ClickUp task, not an SMS. Use the dedicated locations below.

This is a rule rather than an instruction to be careful because care has already
failed. In one session, test artifacts reached: eight ClickUp tasks on real
records; an SMS to an invented number; six SMS to Rene's actual handset; two
documents filed on a borrower under contract; and — after all of that — a folder
named `_healthcheck_delete_me` created inside a live borrower's Drive folder to
check whether a service account could write. Every one of those was an intent to
be careful. What works is having somewhere else to put it.

### Dedicated test locations

| purpose | location | notes |
|---|---|---|
| Borrower/contact fixtures | contact **`ZZ-TEST Fixture Borrower`** | Recreate if absent, `pipeline_status='New Lead'`, `lead_source='automated-test'`. Set `SMS_TEST_CONTACT_ID` to its id — `saveBorrowerDocument` swaps to it whenever test mode is on, so fixture uploads physically cannot land on a real record. Note: inserting a contact fires ClickUp + Drive-foldering triggers; expect both artifacts. |
| SMS senders | **`+1 555 555 XXXX`** | NPA 555 is unassignable under the NANP, so it cannot reach a handset. Requires the `SMS_TEST_KEY` header as well — the number is an identifier, not a credential. `sendSms` refuses a test-mode send to anything outside this range, and refuses a real-mode turn carrying a `SMtest*` MessageSid. |
| Drive writes | the **service account's own Drive root** | `GOOGLE_SERVICE_ACCOUNT_JSON`'s account. Create with no `parents`, trash immediately. Never inside a borrower folder — `gdrive-proxy?action=trash-file` will refuse to clean up after you there, by design. |
| The Drive **write health probe** | folder **`RR HEALTH PROBE - DO NOT DELETE (Drive write check)`**, id pinned in `app_config.gdrive_probe_folder_id` (`1nebqY8hXDn-7Ar4nmS91PKLeD0pe9Dbb`) | Permanent. Lives in `Borrowers/New Lead/Rene's Clients` beside real borrower folders and **looks like litter — it is not**. `gdrive-health-monitor` writes and trashes one `_probe_*.txt` in it hourly. See below before ever recreating it. |
| Chunker/PDF caches | bucket **`chunker-cache`** | Private, JSON-only. Never `lender-guidelines`: it is public, and its MIME allowlist silently 415s JSON. |
| Snapshots before data changes | **`snapshots/*.json`**, committed | Plus a `<table>_<purpose>_<date>` copy in Postgres. See `5a084ce`, `drive-inventory-20260801.json`. |
| Backup-pipeline dry runs | a scratch edge function, Drive **stubbed** | `weekly-backup` writes with rene@'s user token, so a test run cannot be cleaned up by `gdrive-proxy?action=trash-file` (the SA cannot see, let alone trash, rene@-owned files). Stub the uploads and point the verified marker at a `_SCRATCHTEST` key. |
| Scratch files | the session scratchpad dir | Never `/tmp`, never the repo. |

Temporary edge functions for one-off investigation are acceptable when they are
secret-gated, read-only where possible, and **deleted immediately after use**
(verify the endpoint 404s). They are not acceptable as a way around a guard that
just refused you — if a guard blocks cleanup, the litter should not have been
there.

### The Drive write probe folder — how it must be recreated

`RR HEALTH PROBE - DO NOT DELETE (Drive write check)` was created by **POSTing
the production n8n webhook** the foldering trigger uses:

```
POST https://ratesandrealty.app.n8n.cloud/webhook/borrower-stage-foldering
{"record":{"id":"<uuid>","first_name":"RR HEALTH PROBE - DO NOT DELETE",
           "last_name":"","pipeline_status":"New Lead","gdrive_folder_id":null}}
```

**The credential that creates it is the whole point.** Workflow `3MgNXjZrcCm7c8gy`
uses `nodeCredentialType: googleDriveOAuth2Api` — rene@'s user OAuth through
**n8n's** OAuth client. Recreating it any other way silently guts the check:

- **service account** (what `gdrive-proxy?action=create-folder` uses — it goes
  through `driveFetch` → `getAccessToken`, which mints an SA JWT), or
- **our own Supabase OAuth client**

…would both produce a folder that a token holding only `drive.file` can still
write into. The probe would go green in exactly the scope-downgrade scenario it
exists to catch. `drive.file` grants an app access to files *it* created.

Use a uuid that is not a real contact: the workflow PATCHes
`contacts?id=eq.<that uuid>`, which matches nothing and leaves the probe
uncoupled from any contact row. That coupling is what broke this check twice —
once when the ZZ-TEST fixture was deleted (2026-08-04) and again once
`trg_borrower_foldering_ins` stopped foldering fixtures at all. It was dark from
2026-08-06 17:07Z to 2026-08-09.

Then pin the new id in `app_config.gdrive_probe_folder_id`.

### Cleaning up auth rows: delete the id you created, never the user

**Capture the session id when you mint it, and delete THAT.** Never
`delete from auth.sessions where user_id = ...`.

There are two users in this project. So "delete the sessions for these two
users" is "delete every session that exists" — which is what happened on
2026-08-05, three times, during the mailbox-boundary and attribution proofs. All
66 session rows went, for both accounts.

The symptom is not obvious and does not look like a data problem. The browser
still holds a refresh token in localStorage, so navigating works until the
access token expires; the next page REFRESH calls getSession(), the server finds
no session row, the refresh fails, and the client clears storage and bounces to
login. It reads as "the app logs me out when I reload" and sends you looking at
persistSession, autoRefreshToken and storageKey — all of which were correct.

There is no repair. A deleted session row cannot be restored; both accounts have
to sign in again.

```sql
-- mint, then keep the id
--   POST /auth/v1/admin/generate_link  ->  /auth/v1/verify  ->  access_token
select id from auth.sessions where user_id = '<uid>' order by created_at desc limit 1;

-- clean up by THAT id only
delete from auth.refresh_tokens where session_id = '<the id you captured>';
delete from auth.sessions       where id         = '<the id you captured>';
```

The same reasoning applies to any table where the test account is one of a very
small number of rows: a `where` clause that reads as "just mine" is only as
narrow as the data makes it.

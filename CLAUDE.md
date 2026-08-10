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
- pg_cron job 2 `weekly-crm-backup` is **disabled** pending the R2 sync, so
  nothing is currently producing backups. `backup:last_verified` last moved
  2026-08-01.

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
by a separate cron job. Deliberately: pg_cron job 2 `weekly-crm-backup` sat
disabled while everything downstream looked fine, and a retention job that gets
disabled leaves a table growing forever with nobody watching. The cleanup cannot
outlive the thing that maintains it. `recordRun` also never throws — a monitor
that dies because it could not write its own logbook is worse than one with a
gap in the logbook.

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

Get this backwards and it costs a day: flip the flag, a drop fails, and the day
goes on debugging a guard that was working, on a feature that never did. The
steps look identical for both paths and are not.

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

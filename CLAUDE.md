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
| Chunker/PDF caches | bucket **`chunker-cache`** | Private, JSON-only. Never `lender-guidelines`: it is public, and its MIME allowlist silently 415s JSON. |
| Snapshots before data changes | **`snapshots/*.json`**, committed | Plus a `<table>_<purpose>_<date>` copy in Postgres. See `5a084ce`, `drive-inventory-20260801.json`. |
| Backup-pipeline dry runs | a scratch edge function, Drive **stubbed** | `weekly-backup` writes with rene@'s user token, so a test run cannot be cleaned up by `gdrive-proxy?action=trash-file` (the SA cannot see, let alone trash, rene@-owned files). Stub the uploads and point the verified marker at a `_SCRATCHTEST` key. |
| Scratch files | the session scratchpad dir | Never `/tmp`, never the repo. |

Temporary edge functions for one-off investigation are acceptable when they are
secret-gated, read-only where possible, and **deleted immediately after use**
(verify the endpoint 404s). They are not acceptable as a way around a guard that
just refused you — if a guard blocks cleanup, the litter should not have been
there.

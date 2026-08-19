# The four `getUser()`-only functions — audited 2026-08-19

Three were wrong in that shape and are now guarded. One is right in it and is
now commented so a future sweep does not "fix" it.

**First, a correction to how these were labelled.** They were logged as
"`getUser()` with no role check", which is too generous. In all three of the
wrong ones, `getUser()` was **attribution, not authorization** — it stamped a
uid onto a log row and its result was never used to refuse anything.
`sms-service` even carried a comment saying a real guard was *"deliberately NOT
made in this pass"*. So the risk was never "a borrower account would gain
access". They were open to anyone holding the public anon key, which is served
to the world at `/api/env.js`.

## sms-service — the sharpest, and worse than a borrower-account problem

**Measured before the fix:** anon key + `{}` → `400 trigger required`. Business
logic, from an anonymous caller, on the function that **sends SMS from the
business line**.

That makes it a TCPA problem rather than only an access one. Consent, quiet
hours and the bypass allow-list are all enforced *inside* this function against a
body the caller supplies — none of it binds someone calling the endpoint
directly. An unauthenticated sender could text any number, from Rene's brand,
declaring whichever `quiet_hours_bypass` it liked. The pin (`verify_jwt = true`)
stops none of it: the anon key is a project-signed JWT.

**Guard: `requireStaff(req)`. No frontend change was needed** — every admin
browser caller already sent the signed-in user's session, via helpers that have
no anon fallback:

| caller | identity sent |
|---|---|
| `admin/lead-detail.html` ×5 | session — `_rnrAuthHeaders()` |
| `admin/email-marketing.html` ×2 | session — `_smsAuthHeaders()` |
| `admin/js/staff-chat.js` | session — `_scAuthHeaders()` |
| `admin/power-dialer.html` ×2 | session — supabase-js `invoke` |

18 internal edge functions also call it; **17 send the service key** in
`Authorization` and/or `apikey`, both of which `requireStaff` accepts.

### Three callers were already dead before this guard, and still are

Found during the audit, **not caused by it**:

| caller | what it sends |
|---|---|
| `public/unified-portal.html` ×2 — tour reschedule + cancel notices | no auth header |
| `listing-alert-actions` | `headers: { 'Content-Type': 'application/json' }` |

`sms-service` is pinned `verify_jwt = true`, so the gateway has been answering
all three `401 UNAUTHORIZED_NO_AUTH_HEADER` since the pin. All three are
fire-and-forget — no `await` on the status, no `.catch` that reports — so the
failure is swallowed. **The portal UI says "Rene will be notified" and he is
not.**

Deliberately not papered over: loosening the guard to admit them would re-open
the function to the internet. Fixed caller-side instead — see below.

### How long they were dead, and what it looked like

**The portal tour notices: never delivered. Not once.**

`sms_log` is written by `sms-service` itself, so a request refused at the gateway
leaves no row. Measured across the whole table:

| | |
|---|---|
| rows to Rene's handset (`+1 714 472 8508`) | 166 |
| rows in the portal's notice format (`Tour update: …`) | **0** |
| date the two call sites were added (`8a3dd6e`) | **2026-04-04** |

The 9 rows that *do* mention a tour are `✅ Tour CONFIRMED by …` / `❌ Tour
CANCELED by …` — a different format sent by `tour-public-view`, an internal
caller that presents the service key. The portal's own notice has produced
nothing in **four and a half months**.

**The user-visible symptom is that there wasn't one — for the borrower.** The
portal said, and still says:

> `Date updated! Rene has been notified.`
> `⚠ This tour is confirmed. Cancel anyway? Rene will be notified.`

The borrower was told the message went. Rene received nothing, and had no way to
know a message had been attempted. **Nobody noticing is the finding**, separate
from the fix: the only party who could have detected it is the one who never
learned there was anything to detect. That is the swallowed-failure shape in its
purest form — `fetch(...).catch(function(){})`, no status read, no log, a
reassuring toast fired unconditionally a line later.

Worth stating plainly: the guard did not cause this and did not worsen it. The
pin (`7f1abef`, 2026-08-03) is what the 401 comes from today, and the notices had
already produced no row for the four months before that.

**`listing-alert-actions`: one send ever, and no ongoing breakage.** Exactly one
`listing_alert_created` row exists, on 2026-04-10 — and exactly one row exists in
`listing_alerts`, created the same minute. So its SMS path has been exercised
once, successfully, and never since, because **no listing alert has been created
since**. Its call would fail today; it simply has not been asked to run. A dormant
feature, not a silent outage.

### The fix

**The browser could never have been fixed in place.** The only credential
`sms-service` accepts is the service key or a staff session; a page served to
borrowers can hold neither, and putting the service key in it would be far worse
than the bug.

So the notice moved to the side that already holds the key. `portal-data` is what
performs the reschedule and the cancel, and it now sends the staff notice itself
(`notifyStaff()`), with the two dead `fetch` calls removed from the portal.

Two things kept deliberately:

- **The condition, not just the call.** The browser only raised a cancel notice
  for a **confirmed** tour. `portal-data` reads the batch's status *before* the
  update — which overwrites it with `cancelled` — so the notice still fires only
  in that case. Moving a notification server-side must not quietly widen it into
  "every cancellation pages Rene".
- **`staff_alert` remains the correct bypass**, for the same reason it was
  correct in the browser: the recipient is Rene's own handset. The warning goes
  with it — if the recipient ever becomes the borrower, the bypass must be
  deleted in the same edit.

`notifyStaff` never throws: a tour that was rescheduled successfully must not
report failure because a text did not go out. But it **logs a non-2xx**, because
"sent nothing and said nothing" is the exact defect being corrected.

`listing-alert-actions` now sends the service key it already holds, and **reads
the response status** — its `try/catch` never helped, since a 401 is a response,
not a throw.

## google-drive-upload — a clean frontend-first fix

Wrote to the `borrower-documents` bucket and inserted `uploaded_documents` rows
**with the service role**, which bypasses storage RLS, while authenticating
nothing. An anonymous caller could file a document against any borrower.

Its single caller (`admin/lead-detail.html`, the convert-to-PDF path) sent the
session token **with an anon-key fallback**. The fallback's stated reasoning —
*"attribution is optional, the upload is not"* — was true while nothing enforced
identity and inverts the moment a guard exists: the missing-session case is
exactly the one that must not upload.

Order followed: fallback removed and deployed **alone** while the function still
accepted anything, then `requireStaff(req)` landed. No internal callers exist.

## activity-tracker — per-action, and this is the case that disproves a sweep

A blanket `requireStaff()` here **would have broken the borrower portal.** This
function is `verify_jwt = false` and `public/unified-portal.html` calls it with
no credential at all — `page_view` and `track_event` both work today, measured
`200` with no auth header.

So the guard is per-action:

| action | | why |
|---|---|---|
| `get_timeline` | **staff only** | returns CRM activity across contacts — who was called, what was viewed |
| `get_page_views` | **staff only** | same |
| `page_view` | left open | the borrower portal's own analytics |
| `track_event` | left open | the portal sends it too |

**Stated rather than left to be discovered:** `track_event` remains writable by
anyone, and it inserts `activity_events` and touches
`contacts.last_contact_date`. An anonymous caller can still write noise into a
contact's timeline. Closing that needs the portal to carry a credential of its
own — a row token, the way `lender-portal` does — which is a portal change
belonging with the portal migration, not a guard change smuggled in here.

## portal-auth — correct as it is, and now says so

It is the **borrower authentication surface**. Its callers are
`public/unified-portal.html`, `public/portal.html`, `public/search-homes.html`
and `portal-auth-modal.js` — pages served to borrowers who by definition hold no
session and are not staff. Requiring staff to reach the login endpoint would lock
every borrower out of the portal: the outage version of a security fix.

Its `verifyAdminJwt()` is a narrow, correct use — "is this caller a signed-in CRM
user", for the admin-side actions only, which the borrower paths never touch.

A comment now says all of this at the function, because the next sweep for this
pattern will flag it again.

**The general rule, since the shape recurs:** `getUser()`-only is wrong wherever
the audience is staff and right where the audience is the public. Judge by who is
meant to call, never by the pattern.

## Proof

| | no credential | public anon key | admin session |
|---|---|---|---|
| `sms-service` | **401** | **401** invalid session | **400** `trigger required` |
| `google-drive-upload` | **401** | **401** invalid session | **400** `Unknown action` |
| `activity-tracker` `get_timeline` | **401** | **401** invalid session | **200** events returned |

The admin `400`s are passes: the bodies were deliberately invalid, so reaching
validation proves the request got **past the guard** — and for `sms-service` it
proves it without sending anything.

**And what must still work:**

| | no credential |
|---|---|
| `activity-tracker` `page_view` (portal) | **200** |
| `portal-auth` (portal) | **400** `Unknown action` — reachable |

A first run showed the staff rows failing `UNAUTHORIZED_ASYMMETRIC_JWT`. That was
an **expired token**, not the guards: re-running with a fresh one against
unchanged deployed code gave the results above. Noted because this repo has twice
discovered an expired token *at* the verification step and misread it.

## The internal service-key path — PROVEN 2026-08-19

This was the higher risk of the two open items and was cleared first. It is how
cron reaches SMS: `send-scheduled-sms` (every minute), `loan-date-nudges` and
`proactive-followups` all POST `sms-service` with the service key. Had the guard
refused them, **scheduled SMS would have stopped silently** — `net.http_post`
returns a request id, `cron.job_run_details` reports `succeeded` for a request
that was merely queued, and the callers are fire-and-forget.

It could not be tested from a laptop: the service key is an edge environment
variable and exists nowhere locally. So a temporary probe function was deployed
INSIDE the edge runtime, sent exactly what `send-scheduled-sms`'s `svc()` sends,
and reported what came back:

```
sms_service_status      200
reached_business_logic  true
body  {"success":true,"sent":false,"dry_run":true,"would_send":true,
       "quiet_hours":{"in_window":false,"known":true,"area_code":"714",
                      "tz":"America/Los_Angeles"},"local_time":"10:44 PM"}
```

**Nothing was sent.** `dry_run` runs every check — bypass validation, quiet
hours, opt-out — and returns before Twilio and before every write: no `sms_log`
row, no activity row, no audit row. Verified in the source before relying on it.
The recipient was `+1 714 555 0142`, the NANPA-reserved fictional range, chosen
over NPA 555 so the quiet-hours check evaluates against a real timezone instead
of taking the unknown-area-code branch — visible above as `714 /
America/Los_Angeles`.

The probe was **deleted immediately**: undeployed, endpoint verified `404`,
source and `config.toml` pin removed.

### The remaining leg, still NOT proven

## The notice is now surfaced, and both directions are proven

**~~`portal-data`'s `notifyStaff()` has not been observed firing end to end.~~**
Closed 2026-08-19. The first fix moved the *sending* server-side and left the
*telling* alone: `portal-data` returned success whether or not the notice went,
so the borrower was still assured either way — the same both-ends-satisfied shape
one layer down.

Three changes:

1. **`notifyStaff` returns a verdict** (`{ok, error}`) instead of `void`.
2. **HTTP 200 is not success.** `sms-service` answers `200` with `sent:false` when
   the recipient opted out, when quiet hours block, or when a bypass is rejected.
   Judging on `r.ok` would call every one of those delivered. The verdict is
   `sent === true` read from the **body**. This was not theoretical: the forced
   failure below returned exactly that shape.
3. **The failure lands in a row, not a log line** — see the column choice below —
   and the toast branches on a **three-valued** `notified`: `true` sent,
   `false` due-but-failed, `null` none due.

### Where the row lands: `showings`, not `showing_batches`, not `activity_events`

- **`showing_batches` would silently miss.** 10 of the 11 batches on `showings`
  have a `showing_batches` row; **one does not**. A stamp there would match no
  row for borrower-created batches — the exact "a write that matched nothing is
  not a success" trap `portal-data` already carries a comment about.
- **`showings` is the table the handler already updated**, so the rows are known
  to exist and their ids are in hand. `showings.sms_sent` / `sms_sent_at` already
  record SMS state per row; this is the same kind of fact in the same place.
- **`activity_events` is the borrower-facing CRM timeline.** An internal delivery
  failure is operational, not borrower activity, and querying it would mean
  matching a title string — the pattern this repo already warns about.

```sql
select batch_id, staff_notify_failed_at, staff_notify_error
from showings where staff_notify_failed_at is not null;
```

### Proven in BOTH directions, against unmodified shipped code

No code was stubbed or branched for the test. `RENE_PHONE` is read only by
`portal-data` (`sms-service` has its own hardcoded constant), so pointing that
one secret at test numbers exercises the real path end to end. **Nothing reached
a human handset.**

| direction | recipient | result |
|---|---|---|
| **failure** | `+1 555 555 0142` — NPA 555 is unassignable | `notified:false`, row stamped: `not sent: {"success":true,"sent":false,"error":"Invalid 'To' Phone Number"}` |
| **success** | `+1 714 555 0142` — NANPA fictional range | `notified:true`, **and the earlier failure flag cleared** |

Both runs returned `success:true, updated:1` — the reschedule itself succeeded in
both, which is the point: a text that did not go must not fail the borrower's
change.

Toast, asserted as **two separate specs** so a hedge cannot pass as a fix:

```
notified:true  -> "Date updated! Rene has been notified."
notified:false -> "Date updated! Rene will see it in the CRM."   (no "has been notified")
notified:null  -> "Tour cancelled."                              (says nothing about Rene)
```

A toast hard-coded to the cautious sentence would pass a failure-only test and be
wrong for every borrower whose notice actually sent, which is why the success case
is its own spec.

### What proving both directions caught

**A later success did not clear an earlier failure.** The same showing row kept
`staff_notify_failed_at` set through a subsequent successful notice, so
"which tour changes was Rene never told about" would have listed rows he *had*
been told about — permanently, and a flag that only accumulates stops being read.
Fixed with `clearNoticeFailure()` and re-proven: the failure run stamps, the
success run clears.

A failure-only test would have passed and shipped that.

### Cleanup

The `RENE_PHONE` secret was **unset** afterwards (verified absent, so
`portal-data` falls back to the real number) and the ZZ-TEST fixture batch was
deleted. The fixture was a ZZ-TEST row throughout; no borrower's showing was
touched.

**The one thing still not observed** is a notice arriving on Rene's own handset,
because every proof above deliberately used an unroutable number. What that
leaves unproven is Twilio delivery to that specific phone — not the code path,
which is exercised end to end in both directions. Rescheduling a confirmed tour
in the portal would close it; if nothing arrives, the row and the edge log now
both say why instead of swallowing it.

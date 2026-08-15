# Console audit — admin/lead-detail.html, 2026-08-14

Read-only. Nothing was fixed. Real headless Chromium, clean profile, no
extensions, `--disable-extensions` explicitly.

## The limit of this run, stated first

**No admin session was available, so this is the pre-redirect window only.** An
anonymous load redirects to `auth/admin-login.html` at **~1.04s**.

**All 5 reported console errors are post-authentication and were NOT captured** —
including both `mortgage_applications` 403s (base table instead of
`mortgage_applications_secure`). Nothing below should be read as "those are
fine"; they were simply out of reach.

What did fire before the redirect:

| | count |
|---|---|
| Console errors | **0** |
| Console warnings | 1 |
| Uncaught exceptions / promise rejections | **0** |
| HTTP 4xx/5xx | **0** |
| Failed loads | 1 (the CSP-blocked Cloudflare beacon) |
| Issues | 207 |

---

## Ranked by what it costs the user

### 1. `mortgage_applications` 403 ×2 — ours, post-auth, NOT CAPTURED
Known cause: querying the base table instead of `mortgage_applications_secure`.
Cost unknown from this run — it was never observed, and guessing at its blast
radius would be inventing a finding.

### 2. Multiple GoTrueClient instances — ours, every load, MEDIUM
See the dedicated section below. The only item here with a plausible route to
real user harm.

### 3. CSP blocks the Cloudflare beacon — ours, every login-page load, LOW
`auth/admin-login.html:4` carries its own restrictive
`<meta http-equiv="Content-Security-Policy">` whose `script-src` omits
`static.cloudflareinsights.com`, while Cloudflare injects that beacon on every
page. The worker's CSP (`src/worker.js:680`) is permissive — the meta tag is
what blocks it. Costs: no analytics from the login page, one red console line
per visit.

**This one is on the LOGIN page, not lead-detail.** The timing-based attribution
in the capture script initially put it on lead-detail; the log entry's own
document URL corrected it. Worth remembering that an Audits issue's timestamp is
not a reliable document attribution across a redirect.

### 4. 204 × `FormLabelHasNeitherForNorNestedInputError` — ours, every load, LOW
The bulk of the Issues count, and it has been shouting harmlessly for months.

Corroborated in source: **`admin/lead-detail.html` has 441 `<label>` elements and
6 carry a `for=`.** 435 are unassociated; 204 of those also have no nested input,
which is exactly what DevTools counts. Zero functional impact; real for
screen-reader users.

The reported figure was 101 and this run measured 204. Different DOM states —
an authenticated load renders a different set of panels than a pre-redirect one.
The category answer holds either way: **the Issues tab is accessibility, not
CORS, cookies or CSP.**

### 5. Twilio `DocumentCookie` PerformanceIssue ×2 — third-party, NOISE
Inside `@twilio/voice-sdk@2.11.3`. Not ours, not fixable here.

### 6. "A listener indicated an asynchronous response…" — Chrome extension, NOISE
**Not reproduced.** Zero uncaught rejections across four runs in an
extension-free profile. That string is emitted by Chrome's `chrome.runtime`
extension-messaging API, not by page code. It is an extension in the reporting
browser's profile. Common false alarm; ignore it.

---

## The GoTrueClient issue, in detail

```
GoTrueClient@sb-ljywhvbmsibwnssxpesh-auth-token (2.112.3)
Multiple GoTrueClient instances detected in the same browser context.
```

Fires on **every** load of lead-detail, pre-auth, reproducibly.

**Three `createClient()` calls run on one page load:**

| file | note |
|---|---|
| `admin/js/auth-guard.js` | injected on every authenticated page |
| `admin/lead-detail.html:5629` | `window._supabaseClient = sb` — "session-aware; RLS sees the logged-in user, not anon" |
| `admin/js/help-button.js` | also injected broadly |

**Five files assign `window._supabaseClient`:**

```
admin/js/auth-guard.js:75
admin/js/auth-guard.js:167
admin/js/supabase-client.js:105
admin/lead-detail.html:5629
assets/js/sb-auth.js:24      (guarded: only if not already set)
```

All on **one storage key**. The warning itself is benign — the library says so —
but concurrent token refresh against a single storage key is the mechanism that
makes it not benign.

### The prior incident — a HYPOTHESIS, not an established link

CLAUDE.md records a "the app logs me out when I reload" symptom (line ~1076).
**Its documented cause is different**: `auth.sessions` rows deleted by `user_id`
during a probe, and the entry explicitly says `persistSession`,
`autoRefreshToken` and `storageKey` "were all correct".

There is **no** `getSupabaseClient()` async-race entry in CLAUDE.md. I checked
rather than assumed.

So: the multi-client situation is a **plausible second route to the same
symptom**, not a known shared root cause. Treat it as something to test, not
something already established. Writing it down as a shared cause would plant a
false lead for whoever picks this up.

### Why this was not started

`auth-guard.js` is injected on **all 34 pages**. Consolidating three clients into
one is a change with site-wide blast radius, it cannot be verified without a
session, and it deserves its own pass with a token in hand.

---

---

# Authenticated run — the 403 settled (added later the same day)

A token arrived. Two captures, same instrumentation, forced layout both times.

| | ZZ-TEST fixture | Shelley Hurle (real lead) |
|---|---|---|
| `console.error` calls | 0 | **0** |
| Uncaught exceptions / rejections | 0 | **0** |
| **Network 4xx** | **0** | **2 × 403** |
| Log errors (network stack) | 0 | **2** |
| Warnings | 8 | 7 |
| Issues | 302 | 302 (300 form-label) |

**The entire delta is two 403s**, identical URL, twice per load:

```
403  /rest/v1/mortgage_applications?select=borrower_type&id=eq.6b4db8f1-…
     at 2108ms and 2343ms
```

It is data-dependent: the fixture has no `mortgage_applications` row, so the
caller never runs. Any lead with an application fires it.

## Root cause — not a race, and not RLS

**Caller:** `admin/lead-detail.html:10859`, in `lpLoadAppLoanDetails`:

```js
var _r = await _bc.from('mortgage_applications').select('borrower_type').eq('id',appId).maybeSingle();
```

RLS filtering returns *zero rows*, never a 403. A 403 is a privilege error. The
grants, measured:

| grantee | on `mortgage_applications` |
|---|---|
| `service_role` | table-level SELECT |
| `authenticated` | column-level SELECT on ~230 columns **including `id`** — but **not `borrower_type`** |
| `authenticated` on `borrower_type` | **INSERT, UPDATE, REFERENCES — no SELECT** |
| `mortgage_applications_secure` | readable by authenticated, but **does not expose `borrower_type`** |

The one column requested is the one column that cannot be read.

## The cost is asymmetric, and that is why it reads as something else

`borrower_type` is the **Status** field in Loan Details (`#f-borrower-type`; see
the comment at :10797).

`authenticated` has **UPDATE but not SELECT** on it. So Status *saves* — and
every read comes back empty, because the read is refused. On reload the field is
blank.

**It presents as "the field doesn't save." It does save; it cannot be read
back.** Fires on every lead with an application. The surrounding `catch(_){}` is
why nothing else breaks — genuinely non-fatal and correctly guarded. Only that
one field is affected.

## Wrong comment #11 — lead-detail.html:10859

> *"Fetch borrower_type straight from the base mortgage_applications table by
> the active app id (**admin RLS allows it**)."*
>
> *"Await the session-attached client so the JWT is present — otherwise this
> base-table read races auth-guard and hits RLS anonymously (the
> mortgage_applications 403). Fully guarded either way…"*

Someone diagnosed this as a **timing race**, shipped `_waitForAuthClient` as the
fix, and left the comment asserting it. The 403 was never about timing, so the
fix could not have worked — and the comment now actively misdirects the next
reader into re-investigating auth timing. Both claims in it are false: admin RLS
does not allow it, and it is not a race.

## Decision on the fix — NOT a base-table grant

**Add `borrower_type` to `mortgage_applications_secure`, not
`GRANT SELECT (borrower_type)` on the base table.**

The view exists to be the read path for `authenticated`; widening the base table
would route one field around it and leave two doors onto borrower data with
different rules. `remaining_loan_balance` is already read through the view — the
same caller does so three lines earlier.

**First establish whether the omission was deliberate.** The view exposes ~230
columns and skips this one; that is either an oversight or a decision nobody
wrote down. If it was deliberate, the field should stop being editable rather
than become readable. Do not add it to the view until that is answered.

Not fixed. Logged only.

### Answered: the omission was NOT deliberate

Rene, same day. The question the fix was gated on is settled, so the gate is
lifted — but the change is still not applied here.

**Evidence:**

- `borrower_type` holds `"Home Buyer"` / `"Homeowner"`, 7 of 35 rows populated.
  Not PII by any reading.
- `mortgage_applications_secure` omits exactly **five** columns: `borrower_type`,
  three `co_borrower_dl_*` fields, `loan_number`. Three are plainly deliberate
  PII protection. `borrower_type` does not fit the pattern.
- `authenticated` lacks SELECT on **twelve** columns: `ssn`, `co_borrower_ssn`,
  `date_of_birth`, `co_borrower_dob`, `dl_number`, three `co_borrower_dl_*`,
  `bank_accounts`, `mismo_raw_xml`, `loan_number` — and `borrower_type`. Eleven
  form a coherent PII policy. One does not.
- **Likely mechanism:** the view and the grant were each written by enumerating
  columns at a point in time. `borrower_type` was added to the base table later
  and missed both. Consistent with the grant covering ~230 columns *including*
  `id` and not this one — an enumeration that predates the column, not a
  decision that excludes it.

**The fix, decided and not yet applied:**

1. Add `borrower_type` to `mortgage_applications_secure`.
2. Add `borrower_type` to the `authenticated` SELECT grant.
3. **Keep the caller reading the view, not the base table.**
4. Correct wrong comment #11 at `lead-detail.html:10859` **in the same pass** —
   it is the diagnosis, not a leftover, and shipping the fix while the comment
   still says "race" leaves the next reader with a wrong explanation of code
   that now works.

Not applied in this session, deliberately: out of context, and it touches a
grant.

### Also open — the view and the grant disagree

Logged, **not investigated.** Do not act on this without a deliberate look.

| | withholds |
|---|---|
| `mortgage_applications_secure` | **5** columns |
| `authenticated` SELECT grant | **12** columns |

Seven genuinely sensitive columns — `ssn`, `co_borrower_ssn`, `date_of_birth`,
`co_borrower_dob`, `dl_number`, `bank_accounts`, `mismo_raw_xml` — are protected
**by the grant alone** and **are exposed by the view**.

Whether that is a real exposure depends on who can read the view and how it is
defined — a `security_invoker` view still answers under the caller's grants,
while a definer-rights view does not. That is the thing to establish first.
Guessing either way here would be inventing a finding; both "it is a hole" and
"it is fine" are unproven.

## Google Maps deprecations — needs its own pass

Real-lead run only (the fixture never reaches the Places code):

```
Google Maps JavaScript API has been loaded directly without loading=async.
6×  As of March 1st, 2025, google.maps.places.Autocomplete is not available
    to new customers. Please use google.maps.places.PlaceAutocompleteElement.
```

Not breaking today. But `google.maps.places.Autocomplete` is the API the Places
consolidation standardised on this morning — `RRPlaces.autocompleteOn()` builds
exactly that object, in the one shared module three surfaces now delegate to. An
announced end-of-life on a path just made canonical deserves its own
investigation rather than a line in a console audit.

### APPLIED — 2026-08-14

Shipped in the order below. Step 4 is only provable before step 5, which is why
it sits where it does.

| # | change | evidence |
|---|---|---|
| 1 | `borrower_type` added to `mortgage_applications_secure` | 261 → **262** columns, at ordinal 262; `reloptions` still `{security_invoker=false}`; row predicate byte-identical |
| 2 | `lead-detail.html` reads the **view**; the base-table fallback deleted | one fewer request per load |
| 3 | wrong comment #11 replaced with the measured cause | — |
| 4 | **break test, grant still absent** | see below |
| 5 | `grant select (borrower_type) … to authenticated` | — |
| 6 | grant is surgical | see below |

The view was rebuilt by string-replacement on `pg_get_viewdef` with five
assertions (anchor present, anchor unique, replacement fired, predicate
survived, column exposed), not by retyping 261 columns. A hand-transcribed view
definition is how a column quietly changes meaning.

**Step 4 — the break test, and why the first run of it was not trustworthy.**
The refusal message reads `permission denied for TABLE mortgage_applications`
even though the cause is a column privilege. Taken at face value that proves
nothing: a probe that refuses every column equally would look identical. Run
column by column, it discriminates:

```
before the grant, base table, as `authenticated`
  id                     : ALLOWED    has_column_privilege=true
  contact_id             : ALLOWED    has_column_privilege=true
  remaining_loan_balance : ALLOWED    has_column_privilege=true
  borrower_type          : REFUSED    has_column_privilege=false
  ssn                    : REFUSED    has_column_privilege=false
  loan_number            : REFUSED    has_column_privilege=false
```

So with the view fixed and the grant still absent, the page works and the base
table still refuses — **the view is doing the work, not the grant.**

**Step 6 — after the grant:**

```
  borrower_type : ALLOWED
  ssn, co_borrower_ssn, dl_number, co_borrower_dl_number,
  bank_accounts, mismo_raw_xml, loan_number : REFUSED
```

One column moved. The migration asserts this itself — it re-checks all eleven
withheld columns and `anon`, and fails rather than reporting success, because a
grant that widened something else would otherwise be found much later.

**The data was never in question:** 35 application rows, 7 with a value —
4 `Home Buyer`, 3 `Homeowner` — matching what was measured before the change.
Reading the view from a service connection returns **0 rows**, which is the row
predicate working as designed (`current_app_role()` is `none` there), not a
symptom.

### The twin — `lead-detail.html:27324`, NOT fixed

The same wrong comment, a second time:

> *"co_borrower_dl_number / _state / _expiry are NOT in the
> mortgage_applications_secure view … Pull them straight from the base
> mortgage_applications table by the active app id (**admin_all_mortgage_applications
> RLS permits this SELECT**)."*

It does not. Those three columns are in the **deliberate** PII set — withheld
from the view *and* from the grant — and the probe above confirms
`co_borrower_dl_number` is still REFUSED. So that read has been 403ing on every
co-borrower load, silently, inside `const { data: _cbDl } = …` with no error
branch. **The three co-borrower DL fields never populate.**

Left alone on purpose. Unlike `borrower_type` this is not an enumeration slip,
so there is no "restore the intended behaviour" fix — it needs a decision:
expose driver's-licence data to `authenticated`, or stop reading it here and
remove the fields. Those have different answers and neither is a cleanup.

Worth noting the pattern: **two callers, same page, same wrong diagnosis,
different underlying truth.** One column was missed by accident and one class
was withheld on purpose, and the comment says "RLS allows it" in both places.
The comment was copied; the reasoning was not redone.

## Reproducing this

Scripts are in the session scratchpad: `console-audit.mjs` (console + network +
Audits, with per-document attribution) and `issue-detail.mjs` (raw
`Audits.issueAdded` payloads). Raw dumps in `issues-raw-full.json`.

They need `tok.txt` to hold the **token value**. At the time of writing it held
the localStorage *key name* (`sb-ljywhvbmsibwnssxpesh-auth-token`, 34 bytes, 0
dots) rather than the JWT.

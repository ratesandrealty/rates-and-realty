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

## Reproducing this

Scripts are in the session scratchpad: `console-audit.mjs` (console + network +
Audits, with per-document attribution) and `issue-detail.mjs` (raw
`Audits.issueAdded` payloads). Raw dumps in `issues-raw-full.json`.

They need `tok.txt` to hold the **token value**. At the time of writing it held
the localStorage *key name* (`sb-ljywhvbmsibwnssxpesh-auth-token`, 34 bytes, 0
dots) rather than the JWT.

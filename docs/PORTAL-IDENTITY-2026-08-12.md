> **SUPERSEDED 2026-08-17 — see `PORTAL-IDENTITY-STATE-2026-08-17.md`.**
>
> Kept as history. **Its exposure tables are stale and should not be quoted.**
> Since this was written: `get_all_showings` was removed, `save_application` and
> `get_documents` were narrowed to a uuid, the `showings` table was closed to all
> anonymous access except the public form's insert, and five showing-management
> actions were added to portal-data with caller scoping.
>
> The central claim below is still true and is why the current doc exists: the
> portal issues no session, so nothing in portal-data can authenticate anybody.

# The borrower portal has no authentication

Not "weak authentication". None. `portal-auth` verifies a password and then
issues **nothing** — no token, no cookie, no session row:

```js
return respond({ success: true, user: safeUser, is_temp_password: tempValid });
```

The browser stores that object in `localStorage` and every later request asserts
identity from it by putting `portal_user_id` / `borrower_id` / `contact_id` /
`email` in the request body. Nothing issued at login is ever presented again, so
**no function can tell a signed-in borrower from a stranger who typed the same
id.**

This is not a `listing-alert-actions` problem. It is how the whole portal works.

## What each function accepts, and what it does with it

All are `verify_jwt = false`, all use the **service role** (so RLS never
applies), and all take identity from the body.

| function | identity accepted from body | read | write |
|---|---|---|---|
| `portal-data` | `contact_id`, `portal_user_id`, `borrower_id`, `email`, `lead_id` | `showings`, `mortgage_applications`, `uploaded_documents`, `contacts`, saved homes, annotations, profile | `mortgage_applications`, `uploaded_documents` (insert + **delete**), `showings` status, annotations, profile |
| `portal-profile` | same | profile | profile |
| `listing-alert-actions` | `portal_user_id`, `borrower_id`, `contact_id` | `listing_alerts` | `listing_alerts` |
| `submit-showing` | contact fields | — | `showings` |
| `send-push` | subscription/user ids | — | push subscriptions |

### The three that matter most

**1. `get_documents` hands out borrower documents.** Given a bare `contact_id`
it returns `uploaded_documents.*` and mints a **fresh 1-hour signed URL** into
the private `borrower-documents` bucket for each row:

```js
const { data: s } = await sb.storage.from('borrower-documents').createSignedUrl(p, 3600);
d.file_url = s?.signedUrl || d.gdrive_file_url || null;
```

The bucket is private and its RLS is real. It does not matter: the function
holds the service role and signs the links itself, so the storage policy is
bypassed. These are pay stubs, W2s, bank statements and tax returns — the exact
NPI set `sms-assistant` routes through OCR. **114 documents are reachable this
way.**

**2. `get_all_showings` takes no identity parameter at all.** Not a weak check —
no check:

```js
if (action === 'get_all_showings') {
  const { data } = await sb.from('showings')
    .select('*, contacts(id, first_name, last_name, email, phone, crm_id)')
    .order('created_at', { ascending: false }).limit(200);
```

Anyone who can POST gets up to 200 showings joined to contact **names, emails,
phone numbers and CRM ids**. No borrower id required, because none is read.

**3. `save_application` keys on EMAIL.** A `portal_user_id` is at least a uuid
nobody can guess. An email address is public:

```js
if (action === 'save_application') {
  const { email, borrower_id, portal_user_id, data: appData } = body;
  if (!email && !borrower_id) return err('email or borrower_id required');
```

Knowing a borrower's email is enough to overwrite their mortgage application.

### The trap: `delete_document` LOOKS authorized

It performs a genuine ownership check — resolves the caller's `portal_user_id`
to a `contact_id`, loads the document, and refuses if they disagree:

```js
if (doc.contact_id !== userContactId) return err('Forbidden — document does not belong to this user', 403);
```

That is careful code and it is worth nothing, because **the identity it checks
against is supplied by the caller.** It proves you know a uuid, not that you are
its owner. The uuid is a bearer credential by accident: never rotated, never
expiring, sitting in `localStorage`, and passed in the body of ordinary requests
where it lands in logs.

This is the same shape as `voe-inbound-poll`'s `if (POLL_SECRET)` and
`portal-auth`'s `if (!TURNSTILE_SECRET) return true` — code that reads, in a
grep and in review, exactly like a control.

## Size

| | |
|---|---|
| portal_users | **4** |
| …ever signed in | **2** |
| …signed in within 90 days | **1** |
| most recent login of any user | **2026-06-14** (~2 months ago) |
| all 4 linked to a contact | yes |

Against that, what the functions expose:

| | |
|---|---|
| `uploaded_documents` | 114 |
| `mortgage_applications` | 35 |
| `showings` | 41 |
| `contacts` reachable via `get_all_showings` | up to 200 per call |
| `listing_alerts` | 1 |

**The asymmetry is the point.** The portal is effectively dormant, but these
functions read the main CRM tables, so the exposure is not proportional to
portal usage. Four dormant accounts, 114 real borrowers' documents.

It also means migrating is nearly free — and it will never be cheaper than it is
now.

## Recommendation: Supabase Auth proper. One system, not two.

Of the three options:

**(a) A session token on `portal_users` — `form_token` shape, per-session.**
Mint at login, store, send as a header, validate in-function. Smallest diff, and
it is the shape already used by `lender-portal`. **Rejected**, because it means
writing an authentication system by hand: expiry, rotation, revocation, hashing
at rest, refresh, and a lockout story — every one of which is a decision
`lender-portal` simply skipped (its `form_token` has *no expiry*, which is
acceptable for a link you email a lender and not for a borrower's session). It
would also leave this project with two auth systems permanently, and the cost of
two conventions is the thing that keeps biting here: three cron-secret
conventions is how the `CRON_KEY` rotation missed three workflows.

**(b) Supabase Auth for portal users. ← RECOMMENDED**

- **It is already the stated plan.** `portal-auth`'s own header says so: *"this
  entire portal_users system is being replaced by Supabase Auth in upcoming
  work."* This is not a new direction, it is the one that was deferred.
- **It replaces in-function ownership checks with RLS**, which is the control
  this codebase actually trusts and already relies on everywhere else. The real
  prize is not the JWT — it is **dropping the service role** from these
  functions so the caller's own token reaches PostgREST and RLS answers the
  ownership question. Today the service role is what makes every one of these
  bugs reachable.
- **The migration is 4 users**, 2 of whom have ever logged in, none in two
  months. Password reset covers it.

**(c) Something else — keep the body-supplied ids and add a check.** No. There
is nothing to check against.

### What (b) costs, honestly

Not small, and I would not pretend otherwise:

1. Migrate 4 `portal_users` into `auth.users`; keep `portal_users` as a profile
   table keyed by `auth.uid()`. Trivial at this size.
2. Rewrite the login/signup/reset flow in `public/unified-portal.html`,
   `public/portal.html` and `public/listing-alerts.js` to use `supabase-js` auth
   instead of `localStorage`. **This is the bulk of the work** and it is
   frontend-first, so it ships and gets confirmed before any guard.
3. RLS policies on `showings`, `mortgage_applications`, `uploaded_documents`,
   `listing_alerts`, `contacts` for the borrower role — the genuinely careful
   part, and where the review effort belongs.
4. Switch the five functions off the service role onto the caller's JWT, then
   pin `verify_jwt = true`. **Remembering that the pin is not the control** — the
   anon key is a project-signed JWT, so each function still needs `getUser()`
   plus RLS underneath.
5. Storage: signed URLs must be minted only for objects the caller owns, which
   RLS on `uploaded_documents` gives once step 3 is done.

Sequenced the way this repo requires — frontend first, confirmed, then the
guard — this is several sessions, not one.

### Two things worth doing regardless, and long before (b) lands

Neither depends on the design and neither is built here:

- **`get_all_showings` has no caller in `public/`.** It reads like a leftover
  admin action on a public function. If nothing uses it, deleting it removes a
  200-contact PII dump for the cost of one commit.
- **`save_application` should stop accepting `email`.** Restricting it to
  `portal_user_id` does not make it authenticated, but it raises the bar from
  "knows an email address" to "knows a uuid", which is the difference between
  trivially targetable and not.

## Nothing here has been changed

Read-only. No guard added, no function deployed, no schema touched.

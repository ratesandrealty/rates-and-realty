# Three admin authorities, and they disagree

Found while trying to verify surface 5. The automation account is `role='admin'`
in `auth_user_roles` — it passes every server-side `admin only` guard, measured —
and `/dashboard/admin` bounced it to `/admin/people.html`.

**Report only. Nothing here is implemented.**

## The three

| # | authority | mechanism | source of truth |
|---|---|---|---|
| 1 | `current_app_role()` / `is_admin()` | `select role from auth_user_roles where user_id = auth.uid()` | the database |
| 2 | `auth-guard.js` `PAGE_ACCESS` | the role from (1), cached in `sessionStorage.rnr_app_role` | the database, one hop away |
| 3 | `api/auth-api.js` `isAdminUser()` | a hardcoded `ADMIN_EMAILS` allowlist served by `/api/env.js` | a Cloudflare Worker env var |

(1) and (2) agree by construction — (2) reads (1). **(3) shares nothing with
either.** It never queries `auth_user_roles`, so granting or revoking the admin
role in the database has no effect on it, in either direction.

```js
export function isAdminUser(user) {
  if (!user) return false;
  const allowedEmails = ADMIN_EMAILS.map(v => String(v).toLowerCase());
  const emailMatch = user.email ? allowedEmails.includes(user.email.toLowerCase()) : false;
  const idMatch    = ADMIN_USER_IDS.includes(user.id);
  const metadataRole = user.app_metadata?.role === "admin" || user.user_metadata?.role === "admin";
  return emailMatch || idMatch || metadataRole;
}
```

Live values, from `/api/env.js`:

```
ADMIN_EMAILS   = ["rene@ratesandrealty.com"]
ADMIN_USER_IDS = []
```

## 1. Every caller, and what each gates

`requireAdmin()` — redirects to `/admin/people.html` and throws:

| caller | what it gates |
|---|---|
| `components/admin-dashboard.js:176` | **the whole of `/dashboard/admin`** — overview, pipeline snapshot, the CRM task board, the calendar, tasks, insights. The page Aubrey uses daily. |
| `dashboard/website-editor.html:205` | the public-site editor |

`isAdminUser()` — used directly, no redirect:

| caller | what it gates |
|---|---|
| `components/auth-page.js:25` | where a user lands after sign-in (CRM vs borrower portal) |
| `components/borrower-dashboard.js:206` | whether a "CRM" link is rendered on the borrower dashboard |

So the blast radius of adding one address to `ADMIN_EMAILS` is: full CRM
dashboard, the website editor, post-login routing, and a link on the borrower
dashboard. That is why widening it to verify one drag was the wrong trade.

**The asymmetry with the VA — SETTLED 2026-08-15. She cannot reach the page,
and never could.** CLAUDE.md called `dashboard/admin.html` her daily workspace;
that was wrong and has been corrected in place.

- `auth/admin-login.html` routes `role === 'va'` to `/admin/va-dashboard.html`.
  `components/auth-page.js` routes a non-admin to the borrower portal.
- `admin/people.html` deliberately hides the Dashboard link from VAs
  (`vahideDashboard`, "Hide admin-only topbar actions").
- Edge logs, her uid, the full 24h window: 42 requests — `va_dashboard`, staff
  chat, `presence_beat`, `current_app_role`. No `insights-data`, no
  `calendar-data`, no `/rest/v1/leads|appointments|tasks`. The same query does
  find the automation account's `calendar-data` calls, so it works.

**This makes the gate consistent rather than broken**, which changes the
priority of everything below: `ADMIN_EMAILS` currently admits exactly the one
person the page is for. It is still a second source of truth, and
`ADMIN_USER_IDS` is still dead, but nobody is locked out of a page they are
supposed to have.

**Two live defects it does expose:** `admin/va-help.html:62` and
`admin/va-training.html:76` render an ungated "← Dashboard" link to
`/dashboard/admin`, and neither page is in `PAGE_ACCESS`. A VA can open both and
click a link that bounces her. Not fixed.

## 2. `ADMIN_USER_IDS` has always been dead

- `src/worker.js:442` hardcodes `ADMIN_USER_IDS: []` — it is not read from any
  env var or secret, unlike `ADMIN_EMAILS` which comes from `env.ADMIN_EMAILS`.
- `api/config.js:25` defaults it to `[]`.
- `api/env.example.js` and the committed `api/env.js` both ship `[]`.
- Only two commits in the entire history touch it — `a7910f6` (initial commit)
  and `3500067` (the Worker began serving env.js) — and it is `[]` in both.

**So the `idMatch` branch of `isAdminUser` has never been able to return true.**
It is not merely empty today; there is no code path that could populate it. Any
future reader assuming "we can grant admin by uuid" would be wrong.

The `metadataRole` branch is untested here — no user in this project has
`app_metadata.role` or `user_metadata.role` set — but unlike `idMatch` it is at
least reachable in principle, since GoTrue metadata is writable.

## 3. What it would take for the frontend gate to read the database role

`auth-guard.js` already does this, so the mechanism exists and is proven: it
calls `current_app_role()`, caches the answer in `sessionStorage.rnr_app_role`
alongside the uid it belongs to, and every page that needs a role reads that.
`admin/people.html` uses exactly this (`_apmIsAdmin()`), which is why the
automation account works there and not on the dashboard.

The change would be to make `isAdminUser()` consult the same source:

- **It must become async.** `current_app_role()` is a network call.
  `isAdminUser(user)` is synchronous and two of its four callers use it inline in
  a render path (`borrower-dashboard.js:206` builds an HTML string). Those become
  await points or must read the cached value.
- **`auth-guard.js` is not loaded everywhere `auth-api.js` is.**
  `components/auth-page.js` and `components/borrower-dashboard.js` are the
  post-login and borrower surfaces; whether the role cache is populated there was
  not established. If it is not, the call has to be made directly rather than
  read from cache.
- **The failure mode has to be chosen deliberately.** If the role lookup fails —
  network, RLS, a cold cache — does the gate open or close? Today's allowlist
  cannot fail; a database read can. It should fail CLOSED, and that means an
  admin with a flaky connection can be locked out of their own CRM, which is a
  real trade rather than a detail.
- **It ends the disagreement rather than adding to it.** That is the argument
  for doing it: one source, `auth_user_roles`, with `ADMIN_EMAILS` deleted rather
  than extended. Adding the automation account to the allowlist would have made
  three authorities into three authorities plus an exception.

The cheap intermediate, if the async change is too large to take on now: have
the Worker populate `ADMIN_EMAILS` **from `auth_user_roles`** at request time
rather than from a static env var. Same allowlist mechanism, same synchronous
`isAdminUser`, but the contents finally derive from the database. It does not fix
the model, and it would still be stale for the life of a cached `env.js`.

## 4. Should `service_account` be excluded from frontend admin?

**Yes — and the distinction is the same one `service_account` already draws.**

The flag added for the digests says: *an admin for authorization, not a person
for enumeration.* Frontend admin is a third thing again — **a person for
interaction**. `/dashboard/admin` and `dashboard/website-editor.html` are human
workspaces; nothing an unattended login does needs to render a chart or edit the
public site.

If `isAdminUser()` ever moves onto the database role, it should read something
like "role is admin **and not** `service_account`". That gives:

| | database role | server RPCs | frontend admin pages |
|---|---|---|---|
| Rene | admin | ✅ | ✅ |
| automation@ | admin | ✅ | ❌ |

which is exactly what was wanted: the bot holds the database role it needs for
its work, without inheriting every human-facing admin page.

**But note what that costs, because it is the thing I ran into.** Excluding
service accounts from frontend admin makes the dashboard permanently
unverifiable by the automation account — the position we were already in, made
deliberate rather than accidental. That is defensible; it just needs saying, and
it means browser verification of `/dashboard/admin` will always need either
Rene's session or an interception like the one used for surface 5, where the
real `env.js` is fetched and `ADMIN_EMAILS` widened **inside the test browser
only**. That technique changes nothing in production and is the honest way to
keep the page testable while the gate stays narrow.

## The order these should be decided in

1. Is `ADMIN_EMAILS` meant to be the gate at all, or a leftover from before
   `auth_user_roles` existed? (Two commits, never revisited.)
2. If it stays: delete the dead `ADMIN_USER_IDS` branch rather than leave a
   permanently-false condition that reads as a working feature.
3. If it goes: `isAdminUser()` becomes async, fails closed, and excludes
   `service_account`.

Nothing above is implemented.

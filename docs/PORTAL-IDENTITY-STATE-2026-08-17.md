# Borrower portal — current state, and what full authentication still needs

**This supersedes `PORTAL-IDENTITY-2026-08-12.md` and
`PORTAL-IDENTITY-REASSESSMENT-2026-08-16.md`.** Both are kept as history; their
exposure tables are stale and should not be quoted.

Read-only assessment. Everything described as done was landed and proven in
earlier commits; nothing new is applied here.

## What is finished: the `showings` table

`showings` is closed to anonymous access except the public form's insert. That
took five passes, frontend-first, each confirmed in production before the next:

| pass | change | commit |
|---|---|---|
| 1 | drop `open_showings` (blanket ALL) — closed anon DELETE | `737b973` |
| 2 | six unified-portal call sites → portal-data | `a609926` |
| 3 | drop `public_update_showings` — closed anon UPDATE | `217c987` |
| 4 | portal.html + search-homes readers → portal-data; dead reader deleted | `25382ce` |
| 5 | two staff surfaces → session token | `264a2f0` |
| 6 | `public_read_showings` → `staff_read_showings TO authenticated` | `8ce1de7` |

Current policies:

```
public_insert_showings   INSERT  -> {public}          the public showing-request form
staff_read_showings      SELECT  -> {authenticated}
```

No policy grants UPDATE or DELETE to anyone. Every write goes through
portal-data or a service-role function, both of which bypass RLS.

Also done along the way: the unfiltered `PATCH /rest/v1/showings` in
`portal-auth-modal.js` removed (`a0d789d`); four probe tours deleted and all 15
remaining tour share links expired (`6c55546`, `c734f2d`).

## What is NOT finished: portal-data itself

**`portal-data` is still `verify_jwt = false`, still runs on the service role,
and still takes identity from the request body.** Closing the table changed where
the borrower portal reads from; it did not authenticate the portal. Nothing can,
while `portal-auth` issues no session — it verifies a password and returns a user
object, and the browser keeps it in `localStorage`.

**15 actions** — `get_annotations` and `save_annotations` were deleted outright
2026-08-17 (zero callers; removing the surface beats guarding it). **Seven are
scoped** to the caller's own `portal_user_id` **or** `email` through
`scopeToCaller()`, with both inputs validated against PostgREST filter
injection. **Eight are not.**

### THE INVENTORY, CORRECTED — read from each action's body

**An earlier version of this table came from a script whose 30-line window bled
between adjacent actions, and it reported `get_saved_homes` as scoped when it is
not.** Every line below was read from the action body. A handoff that is 80%
right is the dangerous kind, so the method matters as much as the result.

There are **three tiers**, not the two a scoped/unscoped split implies. The
difference decides how much work each one is in the migration.

**A — narrowed by `scopeToCaller()` (7).** The query is filtered to rows carrying
the caller's own `portal_user_id` or `email`.

`remove_saved_home` · `update_showing_status` · `get_batch_showings` ·
`remove_showing` · `cancel_batch` · `restore_batch` · `reschedule_batch`

**B — filtered by the claimed identity, via a validated or-expression (3).**

| action | accepts |
|---|---|
| `get_showings` | `portal_user_id` \| `email` \| `borrower_id` |
| `get_application` | `email` \| `borrower_id` \| `portal_user_id` |
| `get_saved_homes` | `portal_user_id` \| `contact_id` \| `email` |

**C — resolve the claimed `portal_user_id` to a contact server-side, then act on
that contact (5).** These never filter on a raw body value; they look the contact
up and use what comes back.

| action | |
|---|---|
| `get_documents` | mints 1-hour signed URLs into the private bucket, service role, bypassing storage RLS |
| `delete_document` | **write**; genuine ownership check — against the `portal_user_id` the caller supplied |
| `get_profile` | |
| `update_profile` | **write** |
| `save_application` | **write**; `portal_user_id` or `contact_id` |

**Tier C is the least work to migrate** — swap the claimed `portal_user_id` for
`auth.uid()` and the resolution logic is already correct. Tiers A and B also need
their filters reworked.

All fifteen share the one defect that no amount of tiering fixes: **the identity
is asserted by the caller.**

### Or-filter injection — CLOSED 2026-08-17

Three actions concatenated raw body values into a PostgREST `or=` expression,
which is comma-separated, so a comma or a quote in an identity field appended the
caller's own predicate and widened their scope:

```js
if (email) orParts.push(`email.eq.${email}`);      // was: no validation
```

`get_showings`, `get_application` and `get_saved_homes` — not two. Every value
now goes through **one** validator, `validIdent()`, which `scopeToCaller()` also
delegates to, so there is a single definition of what a valid identity looks
like. Malformed input is **refused, never escaped**, and refused with its own
message (`malformed email`) so it cannot be confused with the
identity-not-supplied refusal (`… required`) — both are 400, and conflating them
is how the 403 case was masked a pass earlier.

`get_documents` also builds an or-expression, but from **server-derived** values
(a resolved `contact_id` and the contact's own `borrower_id`), so it was never
the same defect. It is validated anyway, because "it came from a query" is
precisely the reasoning that stops a value being checked.

**Known inconsistency, not yet fixed:** through `scopeToCaller()` a *malformed*
identity returns `"portal_user_id or email required"` rather than
`"malformed …"`. Still a refusal, still not escaped — but it conflates malformed
with missing, which is the distinction the rest of this section is careful about.
Fixing it means changing `scopeToCaller`'s null-return contract across seven
proven actions; worth doing deliberately rather than as a rider.

### The four that required no identity at all — CLOSED 2026-08-17

These took only an object id: knowing it was sufficient, nothing was claimed, so
nothing could be checked. All four now require an identity and refuse without one.

| action | was | now |
|---|---|---|
| `save_annotations` | `document_id` — **DELETED every annotation on the document** then inserted | owner resolved and checked **before** the delete; 403 otherwise |
| `get_annotations` | `document_id` | same ownership check; 403 otherwise |
| `update_showing_status` | `batch_id`/`showing_id`, no identity | `scopeToCaller`, returns `updated` count |
| `remove_saved_home` | `id`, with an **optional** `portal_user_id` filter | `scopeToCaller`, returns `deleted` count |

`remove_saved_home` is worth calling out separately: it applied `portal_user_id`
only `if (portal_user_id)`, so omitting the field ran the delete unscoped. **An
optional guard is not a guard.**

`showings` and `saved_listings` carry `portal_user_id` and `email`, so
`scopeToCaller()` filters them directly. `document_annotations` carries neither —
only `document_id` and `contact_id` — so ownership resolves
caller → `portal_users.contact_id` → `uploaded_documents.contact_id`, via
`resolveCallerContactId()` and `documentOwnedBy()`.

Both write actions return the affected count, and the caller reads it: a delete
or update that matched nothing is a REFUSAL and is reported as one, rather than
being indistinguishable from success at the status code.

### The eight that require an identity, but the caller supplies it

`get_showings` · `get_application` · `save_application` · `get_saved_homes` ·
`get_documents` · `delete_document` · `get_profile` · `update_profile`

These are **narrowed, not authenticated**. `get_documents` is the one worth
naming: it accepts `portal_user_id` only (narrowed 2026-08-12 from a bare
`contact_id`) and mints a fresh 1-hour signed URL into the private
`borrower-documents` bucket for each row, with the service role, bypassing that
bucket's RLS. `delete_document` performs a genuine ownership check — and checks
it against the id the caller supplied.

### The five that are scoped

`get_batch_showings` · `remove_showing` · `cancel_batch` · `restore_batch` ·
`reschedule_batch` — added 2026-08-17. Same caveat applies: scoping narrows WHICH
rows, it does not establish WHO is asking. The gain over what they replaced is
real but bounded — the direct-table path they replaced supplied no identity at
all and could touch any row.

## Size

| | |
|---|---|
| portal_users | 4 (2 have ever signed in; last login 2026-08-16) |
| uploaded_documents | 114 |
| mortgage_applications | 35 |
| showings | 39 |
| document_annotations | 2 |
| listing_alerts | 1 |
| saved_listings | 0 |
| contacts | 1,048 |

The asymmetry from the 08-12 doc still holds and is still the argument for doing
this: four accounts, 114 real borrowers' documents.

## Scope of the remaining work

The recommendation is unchanged: **Supabase Auth, not a hand-rolled token.**
`portal-auth`'s own header has said so since before any of this. What has changed
is that the surface is smaller and better understood.

**1. ~~Cheap, and independent of the migration~~ — DONE 2026-08-17.** The four
no-identity actions now require an identity and refuse without one. It does not
authenticate anything — nothing here can — but "knowing an id is sufficient" is
gone, and `save_annotations` no longer lets any caller wipe another borrower's
annotations.

Proven per action against ZZ-TEST fixtures: own identity works; a **real other
borrower** pointed at a document that is not theirs gets **403**; no identity
gets **400**, not a silent empty; a control with the caller's own identity and a
missing object id returns **404 / `updated: 0`**, which is what distinguishes a
miss from a refusal; and an email carrying a PostgREST or-expression is refused
rather than escaped. After all four refusal attempts on `save_annotations` the
original annotation was still present and no attacker text had been written.

The 403 path needed a second portal_user resolving to a different real contact to
reach at all — with an unrecognised email the function answers 400 ("identity not
recognised"), which is a different branch and would have left the cross-user case
untested if it had been mistaken for one.

**2. The migration proper**, in the order this repo has learned to use:

- Migrate 4 `portal_users` into `auth.users`; keep `portal_users` as a profile
  table keyed by `auth.uid()`. Trivial at this size; password reset covers it.
- **Frontend first**: rewrite login/signup/reset in `unified-portal.html`,
  `portal.html`, `portal-auth-modal.js` and `listing-alerts.js` to use supabase-js
  auth instead of `localStorage`. Still the bulk of the work, and it ships and
  gets confirmed before any guard moves.
- Verify the borrower RLS that already exists. `is_borrower()` and
  `current_contact_id()` are live, and `contacts`, `mortgage_applications` and
  `uploaded_documents` already carry borrower-scoped policies —
  `contacts_select_scoped` even reads `portal_user_id = auth.uid()`. This step is
  verification and gap-closing, not authoring.
- Then drop the service role from portal-data, move to the caller's JWT, and pin
  `verify_jwt = true` — remembering the pin is a stability control, not an access
  one, so each action still needs `getUser()` with RLS underneath.
- Storage signed URLs follow from the `uploaded_documents` policies.

### STEP 0 OF THE MIGRATION, NOT A FOOTNOTE: the NULL-role trap

`staff_read_showings` carries the old predicate:

```sql
USING ( (COALESCE(current_app_role(), '') <> 'va')
        OR is_admin() OR is_lead_shared_with_me(contact_id) )
```

For an authenticated user **with no row in `auth_user_roles`**,
`current_app_role()` returns NULL, `COALESCE` makes it `''`, and `'' <> 'va'` is
**TRUE** — so the OR short-circuits and they read **every showing**.

No such user exists today, which is the only reason this is safe: borrowers are
`portal_users`, not `auth.users`. **The migration creates exactly that user.**
The moment four borrowers land in `auth.users` without roles, each one can read
all 39 showings — every borrower's name, email, phone, property address, agent
notes and feedback.

This is the same bug that was just fixed one layer up, in the same expression: a
NULL role reading as "not a va" instead of as "no role". It was correct to carry
the predicate over verbatim when only the audience changed — that made the
regression attributable — but it must not survive the migration.

**Rewriting this policy is a prerequisite for migrating any borrower into
`auth.users`, not a follow-up.** The shape it needs is an explicit staff test
rather than a negative one: require `is_admin()`, or a role in an allow-list, or
`is_lead_shared_with_me()`. Never "is not a va".

### What is several sessions, and what is not

**Small and independent — can be done any time, in any order:**

- `get_saved_homes` and `get_showings` filter injection: validate the inputs
  before they reach the or-expression. One helper already exists.
- The eight body-identity actions could be brought level with the seven scoped
  ones. Narrowing, not authentication — but it removes "any id will do".

**Genuinely several sessions — the migration itself**, in the order above:
`auth.users` migration → frontend rewrite (the bulk) → **the NULL-role policy
rewrite** → drop the service role and pin `verify_jwt = true` → storage.

The frontend rewrite is the long pole, and it is frontend-first by rule: it ships
and is confirmed before any guard moves. Every guard change in the showings work
followed that order and none of them caused an outage; the one regression that
did occur (`Prefer: return=representation`) was caught by a probe, not by a user.

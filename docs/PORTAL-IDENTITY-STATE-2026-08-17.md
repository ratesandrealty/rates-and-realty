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

17 actions. Five are scoped to the caller's own `portal_user_id` **or** `email`
through the shared `scopeToCaller()` helper, with both inputs validated against
PostgREST filter injection. **Twelve are not.**

### The four that require no identity at all

These take only an object id. Knowing the id is sufficient; nothing is claimed,
so nothing can be checked.

| action | takes | effect |
|---|---|---|
| `save_annotations` | `document_id` | **DELETES every existing annotation on that document**, then inserts the supplied set |
| `get_annotations` | `document_id` | returns them |
| `update_showing_status` | `batch_id` or `showing_id` | sets status on any batch — including `cancelled` |
| `remove_saved_home` | `id` | deletes any saved_listings row |

`save_annotations` is the sharpest: an unauthenticated destructive write to
another borrower's document, and the delete happens before any insert can fail.

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

**1. Cheap, and independent of the migration** — the four no-identity actions.
Requiring `portal_user_id`/`email` and running them through `scopeToCaller()`
brings them level with the five already done. It does not authenticate anything,
but it removes "knowing an id is sufficient", and `save_annotations` in
particular should not wait for a migration to stop being a destructive
unauthenticated write.

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

**3. A trap this pass created, and it must be closed in the same change.**
`staff_read_showings` keeps the old predicate, whose first clause is
`COALESCE(current_app_role(),'') <> 'va'`. For an authenticated user with no row
in `auth_user_roles` that is TRUE, so they read every showing. No such user
exists today — borrowers are `portal_users`, not `auth.users`. **The migration
creates exactly that user.** Whoever lands step 2 must revisit this policy in the
same pass, or migrating the borrowers hands them the whole table.

Still several sessions. Item 1 is not, and does not depend on the rest.

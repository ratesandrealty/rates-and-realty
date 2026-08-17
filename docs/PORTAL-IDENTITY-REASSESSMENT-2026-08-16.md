> **SUPERSEDED 2026-08-17 — see `PORTAL-IDENTITY-STATE-2026-08-17.md`.**
>
> Kept as history. Written the day before the `showings` work finished, so its
> section 5 (`showings` readable by anyone with the anon key) is **no longer
> true** — that is now closed. Its section 4 finding, that the borrower RLS layer
> already largely exists, still stands and still shortens the migration.

# Borrower portal — reassessment before the Supabase Auth migration

Read-only. Nothing changed: no guard added, no function deployed, no schema or
policy touched, no write issued against any table.

This re-checks `docs/PORTAL-IDENTITY-2026-08-12.md` four days on, because the
first thing a migration should do is find out whether its own assessment is
still true. Two of its claims are now out of date, its cost estimate is too
high, and there is one finding it did not have.

## 1. What has already been fixed — the doc's tables are now stale

All three of the 08-12 mitigations landed. Anyone reading that doc's tables will
over-state the current exposure:

| doc says | actually, since 2026-08-12 |
|---|---|
| `portal-data` accepts `contact_id`, `portal_user_id`, `borrower_id`, `email`, `lead_id` | `get_documents` accepts **`portal_user_id` only** |
| `get_all_showings` returns 200 contacts with no identity at all | **the action is REMOVED** (`portal-data/index.ts:174`) |
| `save_application` keys on `email` | **`email` and `borrower_id` rejected**; `portal_user_id` or `contact_id` only |

The narrowing is real and well chosen: `contact_id` is in admin URLs, webhooks
and n8n payloads, while `portal_user_id` exists in 4 rows and is returned only by
a successful password login. The code says so itself, in the right words —
*"THIS IS NARROWED, NOT AUTHENTICATED"*.

## 2. What has NOT changed — the reason the migration still has to happen

Everything structural. `portal-data` has **no authentication of any kind**: the
only `Authorization` references in 572 lines are the CORS allow-list and its own
outbound service-key header. It runs `verify_jwt = false` with the **service
role**, so RLS never applies, and identity arrives in the request body. Twelve
actions, **seven of which write** — including `delete_document`,
`save_application` and `update_profile`.

So the uuid remains a bearer credential by accident: never rotated, never
expiring, held in `localStorage`, and sent in request bodies where it lands in
logs. Narrowing which uuid is required raises the bar; it does not put a lock on
the door.

## 3. Scale — re-measured, identical to 08-12

| | 08-12 | 08-16 |
|---|---|---|
| portal_users | 4 | **4** |
| …ever signed in | 2 | **2** |
| …within 90 days | 1 | **1** |
| most recent login | 2026-06-14 | **2026-06-14** |
| uploaded_documents | 114 | **114** |
| mortgage_applications | 35 | **35** |
| showings | 41 | **41** |
| listing_alerts | 1 | **1** |

The asymmetry the doc named still holds, and is still the argument for doing
this now: four dormant accounts, 114 real borrowers' documents.

## 4. NEW — the migration is cheaper than the doc estimates

The doc calls step 3, *"RLS policies for the borrower role"*, the genuinely
careful part and where the review effort belongs. **Much of it already exists.**
`is_borrower()` and `current_contact_id()` are live, and borrower-scoped policies
are already written:

- `contacts_select_scoped` — `… OR (is_borrower() AND (id = current_contact_id() OR portal_user_id = auth.uid()))`. It already joins `portal_user_id` to **`auth.uid()`**, which is precisely the shape the migration needs.
- `mortgage_applications` — `borrower_select_own_mortgage_app` and `borrower_update_own_mortgage_app`, both `is_borrower() AND contact_id = current_contact_id()`.
- `uploaded_documents` — SELECT and INSERT both carry `(is_borrower() AND COALESCE(contact_id, lead_id) = current_contact_id())`.

So the schema was built expecting this migration. The remaining work on step 3 is
verifying `is_borrower()` / `current_contact_id()` resolve correctly for a
migrated user and closing the gaps below — not authoring the policy set from
scratch. That moves the effort towards step 2 (the frontend rewrite), which the
doc already identifies as the bulk.

## 5. NEW AND SEPARATE — `showings` is readable by anyone, today

This does not need a portal migration, a uuid, or a login.

```sql
open_showings   ALL   {anon,authenticated}   USING (true)   WITH CHECK (true)
```

Verified live, read-only, with the **public anon key printed in every page's
source** — id column only, no borrower data pulled into this note:

```
GET /rest/v1/showings?select=id&limit=5     -> HTTP 200, 5 rows
GET /rest/v1/contacts …                      -> HTTP 200, 0 rows
GET /rest/v1/uploaded_documents …            -> HTTP 200, 0 rows
GET /rest/v1/mortgage_applications …         -> HTTP 200, 0 rows
GET /rest/v1/portal_users …                  -> HTTP 200, 0 rows
GET /rest/v1/saved_listings …                -> HTTP 200, 0 rows
```

Every other table holds. `showings` does not, and it carries `name`, `email`,
`phone`, `property_address`, `notes`, `agent_internal_notes`,
`agent_notes_for_lead`, `lead_feedback`, `crm_id`, and the listing agent's name,
phone and email. 41 rows.

The policy is `ALL`, so INSERT, UPDATE and DELETE are granted to `anon` on the
same terms. **This was not tested** — a write probe against real borrower rows is
exactly what the probe rules forbid — so treat write access as indicated by the
policy text rather than demonstrated.

**Why this matters more than its size.** Removing `get_all_showings` on 08-12
closed the edge-function route to this data. The table stayed open, so the data
never stopped being reachable — the door was locked while the wall stayed
missing. It is the same shape as `auth-guard`'s `denyAccess()` being a curtain
rather than a lock, and as `verify_jwt = true` not being an access control: a
control removed at one layer reads as solved while the layer underneath still
answers.

**Recommend fixing this independently of, and before, the migration.** It is a
policy change on one table, it needs no frontend work, and unlike the portal it
requires no attacker to know anything at all. The care needed is in not breaking
the legitimate anonymous INSERT — `public_insert_showings` exists because the
public showing-request form has no session — so the replacement must keep
anonymous insert while removing anonymous select, update and delete.

## 6. Where that leaves the plan

The 08-12 recommendation stands: **Supabase Auth, not a hand-rolled token.**
Nothing found here argues against it, and two things argue for it more strongly —
the RLS layer is already largely written, and the scale is unchanged at 4 users.

Revised sequence:

0. **`showings` policy** — separate, first, small. Not part of the migration.
1. Migrate 4 `portal_users` into `auth.users`; keep `portal_users` as a profile
   table keyed by `auth.uid()`.
2. Frontend rewrite to `supabase-js` auth in `unified-portal.html`,
   `portal.html`, `portal-auth-modal.js`, `listing-alerts.js`. Still the bulk.
   Frontend-first and confirmed working before any guard lands — the rule that
   `email-service` broke and `communications-admin` followed.
3. Verify the existing borrower policies against a migrated user; close gaps.
   Smaller than the 08-12 doc assumed.
4. Drop the service role from the five functions, move to the caller's JWT, pin
   `verify_jwt = true` — remembering the pin is a stability control, not an
   access one, so each function still needs `getUser()` with RLS underneath.
5. Storage signed URLs follow from step 3.

Still several sessions. Step 0 is not, and should not wait behind them.

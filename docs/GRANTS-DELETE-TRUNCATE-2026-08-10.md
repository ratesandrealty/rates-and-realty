# DELETE / TRUNCATE grants — 2026-08-10

Applied as migrations, which land in the database's migration history but leave
no file in this repo. Recorded here so the posture is reviewable without querying
production, and so a future grant can be compared against a stated intention
rather than against whatever happens to be live.

## Why this happened at all

A `BEFORE DELETE` recorder was added to `contacts` because 43 deletions had left
nothing but a cascade artifact with a null actor. It was then noticed that
`audit_log` itself granted `DELETE` and `TRUNCATE` to `authenticated` — so the
recorder was writing to a table its own subject could erase. That prompted a
sweep of every table holding borrower data.

**`TRUNCATE` is the more important half throughout.** RLS does not apply to it,
and it fires no row triggers — so it defeats any row-level recorder silently and
completely. `DELETE` at least leaves a trigger's trace.

## Revoked from `authenticated` and `anon`

| table | checked before revoking |
|---|---|
| `contacts` | only frontend path is `fnFetch('delete-contacts')`; the function uses the service role |
| `audit_log` | nothing deletes — `delete-contacts:152` uses **PATCH** to amend its row, not DELETE |
| `activity_events` | only `partner_activity_delete()`, `SECURITY DEFINER`, runs as owner |
| `sms_log` | every app reference is a SELECT |
| `email_log` | revoked earlier (VA inbox work) |
| `calls_log`, `call_log` | nothing deletes |
| `contact_notes` | nothing deletes |
| `pipeline_stage_history` | nothing deletes |
| `signature_requests` | nothing deletes |
| `contact_financials` | nothing deletes |
| `uploaded_documents` | deleted only by `portal-data` (service role) |
| `esign_documents` | deleted only by `esign-docs` (service role) |

13 of 16 surveyed tables now have neither privilege for `authenticated`.

## NOT revoked — deliberate, not missed

| table | who deletes as `authenticated` |
|---|---|
| `processing_items` | `admin/lead-detail.html:10875` — checklist row removal |
| `loan_liabilities` | `admin/lead-detail.html:22435` — 1003 liability row |
| `loan_income` | `admin/lead-detail.html:26140` — 1003 income row |

Revoking breaks ordinary 1003 editing. A `comment on table processing_items`
carries the same note in the database.

**The uncomfortable part, written down so it is not rediscovered as news:** these
three are exactly the tables where deleting is part of normal work, which is why
they are also the ones a mistaken or malicious call can use. The guard cannot be
"nobody deletes here", because someone legitimately does, all day.

**What the fix looks like.** Route 1003 deletes through an edge function holding
the service role, the way `delete-contacts` works — `requireStaff` before
`req.json()`, an audit row written BEFORE the delete, the delete refused if that
write fails — then revoke here too. Three call sites in `lead-detail.html` and
one new function. Not large; just not today's task.

## Still owed

Two break tests, both blocked on a session token:

- `delete-contacts` writing a **populated** actor (the recorder's null-actor case
  is already proven — `db_user postgres`, `application_name mgmt-api`,
  `route_hint DIRECT DB`).
- `people.html`'s bulk delete end to end, after the `contacts` revoke.

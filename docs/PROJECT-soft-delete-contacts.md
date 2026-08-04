# Project: soft-delete contacts (Option C)

**Status: logged, not started. Do not begin without Rene's direction.**

Recorded 2026-08-04 so the reasoning is not lost between sessions.

## Why this exists

Every one of these findings is downstream of one decision — that deleting a
contact means `DELETE FROM contacts`:

| finding | detail |
|---|---|
| Orphaned financial data | 25 rows across `loan_liabilities`, `loan_scenarios`, `loan_income`, `lender_submissions` from 7 deleted contacts. 14 carry consumer creditor account numbers with no borrower attached. |
| Deletion silently broken | 10 of 1,038 live contacts cannot be deleted at all — FK `NO ACTION` on `calls_log` and `signature_signers` raises `23503`. The 7 known deletions are only the ones that happened to be deletable. |
| Commission destroyed on delete | `cleanup_contact_financials()` deletes `contact_earnings`, which holds `actual_earnings`. 3 Closed contacts hold $42,531 today. Nothing lost yet only because every audited deletion so far carried zero. |
| 27 unprotected columns | `contact_id` with no FK. 23 read zero orphans by luck — no deleted contact happened to have rows there. Only `contact_earnings` and `contact_financials` are zero by design, via `trg_cleanup_contact_financials`. |

Hard delete is the common cause. Soft delete removes the class, not the instances.

## What it would involve

Add `contacts.deleted_at timestamptz`. `delete-contacts` sets it instead of
issuing a DELETE. Nothing cascades, nothing orphans, nothing is destroyed, and
the operation becomes reversible — which none of the alternatives are.

### The enforcement point

**`contacts_secure`** is the lever. It already exists as the read path that hides
PII columns from VAs, so there is one central place to add `where deleted_at is
null` rather than ~100 call sites. That is what makes this tractable at all.

It is not free: anything reading `public.contacts` directly still needs the
filter, and today plenty does — `communications-admin`, `people-admin`,
`lead-scorer`, the campaign audience resolver, every export. The first task of
this project is an honest inventory of direct readers, not the schema change.

### Known costs, stated up front

1. **Miss one read path and a deleted borrower reappears.** That is worse than
   today's failure, because it looks like it worked.
2. **Unique constraints still collide.** Email and phone uniqueness will reject
   re-adding a contact whose soft-deleted twin still holds the value. Needs
   partial unique indexes (`where deleted_at is null`).
3. **A hard-delete path is still required** for genuine erasure requests, so the
   cascade questions return — rarer, and higher-stakes when they do.
4. **Counts change everywhere.** 1,038 contacts becomes "1,038 minus soft-deleted"
   in every dashboard, every stat tile, every audience size.
5. Triggers on `contacts` fire on UPDATE. `mirror_contact_financials`,
   `trg_track_deal_outcome`, `fire_timeline_automation`, the ClickUp and Drive
   foldering triggers all need checking against a delete-shaped UPDATE.

## Relationship to the staged FK migration

`supabase/sql/STAGED_contact_fk_hardening_20260804.sql` is **largely moot if this
proceeds.** Its CASCADE and SET NULL decisions only matter when rows are actually
removed. Do not run it pending direction — running it first would spend the
review effort on a set of decisions this project deletes.

Two parts of it survive either way and could be lifted out:

- `signature_signers` and `calls_log` `NO ACTION` — these break deletion *today*,
  and if a hard-delete path is kept for erasure requests they will break it then
  too.
- `contacts.primary_borrower_contact_id` has no FK at all; the invariant depends
  on one edge function remembering to NULL it.

## Relationship to the commission ledger

Independent, and worth doing regardless. Commission belongs to a closing, not to
a CRM contact — that is correct on accounting grounds whether or not contacts are
ever hard-deleted. See `supabase/sql/STAGED_commission_ledger_20260804.sql`.

## First step, when it starts

Inventory every direct reader of `public.contacts` that is not going through
`contacts_secure`, across `supabase/functions/**`, `admin/**`, `dashboard/**` and
`pg_cron`. Until that list exists, the size of this project is unknown.

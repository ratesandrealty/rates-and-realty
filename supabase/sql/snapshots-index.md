# `snapshots` schema — what each capture was taken before

Point-in-time copies made before a data change. They live in their own schema
rather than `public` because in `public` they are indistinguishable from real
tables in every listing, autocomplete and `list_tables` call. That, not disk
space, was the cost — the whole set is under 400 kB.

## Convention

- **Name**: `<subject>_<purpose>_<YYYYMMDD>`
- **Retention**: drop after **90 days**
- **`KEEP_` prefix**: never auto-drop. Two cases only —
  1. it backs a decision that is still unfinished, or
  2. it holds data that exists nowhere else.
- **This file**: one row per snapshot. Without it the reason for each capture
  lives only in a commit message, which is not where anyone looks when deciding
  whether a table is safe to drop.

## Current contents

| table | taken before | rows | drop after |
|---|---|---|---|
| `KEEP_lender_submissions_orphan_cleanup_20260804` | the staged FK-hardening migration | — | **keep** |
| `KEEP_loan_income_orphan_cleanup_20260804` | the staged FK-hardening migration | — | **keep** |
| `KEEP_loan_liabilities_orphan_cleanup_20260804` | the staged FK-hardening migration | — | **keep** |
| `KEEP_loan_scenarios_orphan_cleanup_20260804` | the staged FK-hardening migration | — | **keep** |
| `uploaded_documents_typefix_20260731` | reclassifying borrower document types | — | 2026-10-29 |
| `contact_earnings_ledger_backfill_20260804` | the commission-ledger backfill | — | 2026-11-02 |
| `auth_user_va_rename_20260805` | changing the VA login from `va-test@` to `processing@` — holds the password hash, which is what proved the rename did not alter it | 1 | 2026-11-03 |
| `contacts_status_backfill_20260805` | backfilling `lead_status` from `pipeline_status` (32 rows changed) | 1044 | 2026-11-03 |
| `saved_views_predupe_20260805` | deleting 3 duplicate saved views and renaming 3 | 22 | 2026-11-03 |

The four `KEEP_` tables are marked so because
`supabase/sql/STAGED_contact_fk_hardening_20260804.sql` has **not been run**.
When that migration lands and is confirmed, they become ordinary 90-day
snapshots — that is the moment to reclassify them, not before.

## Re-checking what is due

```sql
select table_schema, table_name,
       substring(table_name from '[0-9]{8}$') as taken,
       table_name like 'KEEP\_%' as keep
from information_schema.tables
where table_schema = 'snapshots'
order by keep, taken;
```

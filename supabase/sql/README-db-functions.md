# Database functions are NOT captured automatically

`tools/check-function-drift.mjs` compares deployed EDGE FUNCTIONS against the
repo. It does not look at Postgres functions at all. So a `create or replace
function` run against production leaves no trace here, and the next person
reading this repo cannot tell what the database actually does.

Everything in `db-functions-20260805.sql` was written or changed during the
session on 2026-08-05 and existed only in the database until it was captured.

**If you change a Postgres function, re-capture it here in the same commit.**

Re-capture with:

```sql
select string_agg(pg_get_functiondef(p.oid), E';\n\n' order by p.proname) || ';'
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ( ... );
```

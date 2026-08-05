# Every Postgres function in `public`, one file each

307 functions, 252 of them `SECURITY DEFINER`. Captured from production on
2026-08-05.

**Before this, 5 of 307 were recorded anywhere.** `tools/check-function-drift.mjs`
compares deployed EDGE functions against the repo and never opens a database
connection, so this layer had no git history at all — no way to see what a
function contained last week, or that it changed.

## Conventions

- One file per function: `<name>.sql`.
- Overloads carry their argument list plus a short digest of the full signature:
  `<name>__<args>_<hash>.sql`. Truncating the arg list alone was not enough —
  two `hoi_quote_log` overloads agree for the first 60 characters. Three names
  are overloaded: `hoi_quote_log`, `order_note_add`, `vendor_directory_upsert`.
- Each file starts with the signature, language and whether it is
  `SECURITY DEFINER`, then the verbatim `pg_get_functiondef` output.

## Re-capturing

There is no automated drift check for this layer yet. After changing a
function, re-capture it in the same commit. To re-capture everything, create a
temporary view over `pg_proc` (see the commit that added this directory), read
it through PostgREST with the service key so the bytes never pass through a
tool result, split by name, and drop the view.

`supabase db dump` is the obvious alternative and does NOT work here: it
requires Docker, which is not available in this environment.

# Snapshots

Point-in-time exports taken before touching data that a live bug can destroy.
Committed deliberately: if a save wipes values, this is the only copy.

## lender-programs-*.json

Every row of `lenders` with its program-bearing array columns:
`programs`, `loan_programs`, `niche_types`, `loan_types`, plus `id`, `name`
and `updated_at` so a restore can be targeted and ordered.

Taken because the lender programs save was reported as destructive — a save
writes only the values the admin grid rendered, so anything stored that the
grid does not know about is dropped. Snapshot first, diagnose second.

# Deferred: `loan_orders.borrower_id`, 2026-08-18

Logged, not built. Decided against widening the schema in the same pass as the
thread reader.

## What is missing

`loan_orders` keys on `contact_id` alone. There is no `borrower_id`, so an order
cannot say **which borrower** it belongs to. For VOE that means a file with a
borrower and a co-borrower, each with their own employer, produces orders that
are distinguishable only by `employer_name` — a text field.

## Why it is not blocking

Measured 2026-08-18:

- `loan_borrowers`: **9 rows across 9 contacts, maximum 1 per contact.** No file
  in the system currently has a second borrower recorded there.
- Multiple VOE orders per contact already work and are already used: the unique
  index is `(contact_id, order_type) WHERE order_type <> 'voe'`, deliberately
  exempting VOE, and one contact already carries 2 orders.

So the per-employer case — the one the thread reader needed — is already
expressible. Only the per-*borrower* case is not, and nothing has needed it yet.

## What it would take

A nullable `borrower_id uuid references loan_borrowers(id)` on `loan_orders`,
plus a picker on the order card. Nullable because every existing row would have
no answer, and inventing one would be manufacturing a fact — the same reasoning
that left `recording_consent_at` unbackfilled and Maria Cardenas's
`loan_purpose` unmigrated.

## The trap to avoid when it is built

**Do not infer the borrower from `employer_name`.** The link between an order and
an employment is already name-only — `voe-form-fill` matches
`order.employer_name` against the `employments` array — and two entries can share
a name (one employer, two stints; or both borrowers at the same company). Name
matching is acceptable for looking up an ADDRESS, where a wrong hit is visible on
the form. It is not acceptable for deciding whose employment a verification
belongs to.

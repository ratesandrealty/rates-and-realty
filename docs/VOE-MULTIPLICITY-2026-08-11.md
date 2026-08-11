# VOE multiplicity — schema report, 2026-08-11

**Read-only. Nothing changed.**

## The short answer: multiple VOEs per borrower ALREADY WORK

`ux_loan_orders_contact_type_single` does not constrain VOE. Its definition:

```sql
CREATE UNIQUE INDEX ux_loan_orders_contact_type_single
  ON public.loan_orders USING btree (contact_id, order_type)
  WHERE (order_type <> 'voe'::text);
```

VOE was exempted when the index was written. Every layer above it already
follows suit — this was designed for, not left undone:

| layer | how it already handles many VOEs |
|---|---|
| `loan_order_set` | `elsif p_order_type <> 'voe' then` — for VOE it never looks up an existing row by (contact, type), so it INSERTS a new one every time unless the caller passes `p_order_id` |
| `voe_request_log` | acts `where id = p_order_id` — a specific order, not (contact, type) |
| `voe_request_sent` | same: `where id = p_order_id` |
| order tiles | `lead-detail.html:11696` builds its one-row-per-type map with `if (o.order_type !== 'voe')` — VOE is deliberately excluded |
| VOE rendering | `:11718` `voeRows = all.filter(o => o.order_type === 'voe')` — already a list, already splits `not_required` |

So the brief's three worries do not apply: `loan_order_set` does not upsert
against the index for VOE, and neither VOE function assumes a single row.

**Nothing needs to change for "multiple VOEs per borrower".** Today's data has
4 VOE rows across 4 contacts (one each), so the path is structurally supported
but has never carried two at once in production — worth exercising once with a
fixture before relying on it.

## Multiple borrowers per file is the part that is NOT supported

For `title`, `escrow`, `appraisal`, `payoff` the index still enforces one row per
`(contact_id, order_type)`. Whether that is wrong depends on what `contact_id`
means:

- **contact_id = the FILE** (and `borrower_contact_id` names which borrower a row
  is for) — then one title per file is CORRECT and nothing should change. This
  is what the columns suggest: `loan_orders` carries both.
- **contact_id = a BORROWER** — then two borrowers on one deal are two contacts,
  each with their own orders, and again the index is fine.

Neither reading needs the constraint relaxed. The case that would is *two
escrow orders on one file* — a re-opened escrow under a new number, which is
exactly the situation on 3339 Club Rancho, where SC-27335-BU (SoCal Title) and
2802-SR (Pocket Escrow) are two different vendors' orders on one property.

## If it IS relaxed, here is what breaks

The constraint would become `(contact_id, order_type, borrower_contact_id)`, or
be dropped. Two things depend on it today:

1. **`admin/lead-detail.html:10724` — the escrow-number read.**
   ```js
   .eq('contact_id',cid).eq('order_type','escrow').maybeSingle()
   ```
   PostgREST `.maybeSingle()` **errors** on more than one row ("Cannot coerce the
   result to a single JSON object"). A second escrow row does not make this show
   the wrong number — it makes the Escrow # field stop rendering entirely. This
   is the one hard dependency.

2. **`loan_order_set`'s non-VOE lookup** —
   `select id ... where contact_id = ... and order_type = ... limit 1`. With two
   rows the `limit 1` picks an arbitrary one and edits it. No error, no warning:
   the same silent-tie-break shape as the `ordered_at desc NULLS FIRST` bug in
   `matchContact` rule 2.

Both would need fixing in the same change, and #2 is the dangerous one because
it fails quietly.

**Recommendation: do not touch the index for VOE.** If Rene needs two escrow or
title orders on one file, that is a different, smaller change than the brief
assumed, and it needs those two call sites fixed first.

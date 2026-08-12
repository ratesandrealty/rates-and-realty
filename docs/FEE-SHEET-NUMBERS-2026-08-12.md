# The Fee Sheet quotes from the columns, not the Loan Info panel

Daniel Garcia (`599b4b4a-26ec-4376-a118-bff0397540a4`). Three sources disagree
on one screen. Read from the saved draft in `fee_sheet_drafts`, not inferred.

| source | purchase | down | loan | product |
|---|---|---|---|---|
| `contacts` row | **null** | — | **820,250** | conventional |
| draft `common` (the Loan Info panel) | 700,000 | **5%** / $35,000 | **665,000** | **Conv 30yr Fixed** |
| draft `price_scenarios` (the three columns) | 700,000 / 725,000 / 750,000 | **3.5%** | derived | **fha30** |

The rendered sheet — LTV 96.5%, loans 675,500 / 699,625 / 723,750 — is exactly
`price_scenarios` at 3.5% down. **The columns are authoritative.**

## Why, mechanically

`readSidebarInputs(overrides)` takes the column's values first:

```js
const purchasePrice = (overrides.purchasePrice != null) ? overrides.purchasePrice : parseCurrency($('purchasePrice').value);
const downPct       = (overrides.downPct != null)       ? overrides.downPct       : (parseFloat($('downPct').value) || 0);
const downPayment   = purchasePrice * downPct / 100;
const loanAmount    = Math.max(0, purchasePrice - downPayment);
```

and the price-comparison renderer passes `downPct`, `purchasePrice` and
`loanProduct` per column. So in comparison mode **every field in the Loan Info
panel is inert** — down %, loan amount and loan product all come from the column.

### `loanAmount` is not an input anywhere, in any mode

Line 1232 always *derives* it: `loanAmount = purchasePrice − downPayment`. The
`#loanAmount` box is an output that happens to be editable-looking.

That is why `buildFeeSheetUrl` achieves nothing by sending it:

```js
if (d.loan_amount) params.push('loan_amount=' + d.loan_amount);   // lead-detail
if (la) $('loanAmount').value = '$' + Number(la).toLocaleString('en-US');  // fee-sheet
recalc();   // ← immediately overwrites it
```

The CRM's loan amount is written into the field and discarded in the same tick.
The prefill never sets `downPct` and never calls `syncDownFromDollar()`, so the
one number that *would* carry the CRM's intent is the one number not passed.

**$665,000 is a stale artefact**, not a competing opinion: it is what the panel
displayed when `downPct` was still 5, left frozen when the columns moved to 3.5.
It appears in the output nowhere because nothing reads it.

## The sharper problem: the product changed too

The panel says **Conv 30yr Fixed**. All three columns say **fha30**. The
`contacts` row says **conventional**.

So the sheet is quoting FHA — with UFMIP financed into the loan and FHA monthly
MI — to a borrower every other system records as conventional. That is not a
cosmetic disagreement; it changes the payment, the APR and the cash to close. A
down-payment discrepancy is a wrong number, but an FHA quote for a conventional
borrower is a wrong *product*.

The `contacts.loan_amount` of 820,250 matches neither, and `purchase_price` is
null, so the CRM record is not a usable tiebreaker either.

## Recommendation

**1. Leave the columns authoritative.** For a price-comparison tool, per-column
terms are the point. This is not the bug.

**2. The Loan Info panel must stop displaying numbers that do not govern.**
An inert panel showing 5% / $35,000 / $665,000 / Conv 30 next to output computed
at 3.5% / FHA is the actual defect. Two options:

- *Preferred:* in comparison mode, visibly disable the panel's down %, loan
  amount and loan product, with a line saying the columns govern. Nothing
  silently displayed, nothing silently ignored.
- *Alternative:* have columns inherit the sidebar's `downPct` and `loanProduct`
  unless explicitly overridden per column. Riskier — it changes existing saved
  drafts' rendering.

**3. Mark `#loanAmount` as derived** in both modes: read-only styling. It is an
output in every path.

**4. Pass the down payment, not the loan amount, from the CRM.** The fix in
`buildFeeSheetUrl` is to send `down_pct` (or `down_dollar`) and have the prefill
set `#downPct` before `recalc()`. Sending `loan_amount` to a field that is
overwritten milliseconds later is the illusion of integration.

**5. Surface the product mismatch.** When the sheet's product family differs
from `contacts.loan_type`, say so on the sheet. A fee sheet quoting a down
payment or a product the borrower never discussed is worse than an ugly one.

## Not changed

Read-only investigation. No edit to `tools/fee-sheet.html`, `admin/lead-detail.html`,
or Daniel Garcia's draft.

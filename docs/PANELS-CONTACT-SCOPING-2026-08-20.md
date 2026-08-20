# Which panels need the multi-contact pattern — inventory

Report only. Nothing changed.

## First, a correction to yesterday's framing

`docs/MISMO-IMPORT-SECOND-BORROWER-2026-08-20.md` said the panels are
single-contact scoped and implied that is why the DTI was wrong. **The second
half is not true, and it matters for what to fix.**

`renderBorrowerIncomeDebtCards()` (`admin/lead-detail.html:31501`) queries
**every** borrower in `losBorrowers` individually, sums the ones toggled on, and
pushes the total into `ls_total_monthly_income`:

```js
var incRes = await _authClient().from('loan_income')
  .select('*').eq('contact_id', b.contact_id).eq('is_active', true);
…
var combinedInc = cardData.reduce(function(s,d){return s + (d.included ? d.income : 0);}, 0);
if (incInput && combinedInc > 0) incInput.value = combinedInc.toFixed(2);
```

It runs whenever there is more than one borrower, in **both** view modes. So
loan-level DTI has always used the combined household total.

That is confirmed by the stored value itself: `loan_scenarios` held
**29,023.61**, which is the sum of all six active rows across **both** contacts —
not Daniel's four (20,237.34). The panel was correctly combining. It was
combining wrong data.

**So the DTI error was caused entirely by the duplicate rows, and nothing about
contact scoping contributed to it.** Fixing scoping would not have fixed the DTI;
fixing the duplicates did.

## The inventory

| surface | function | scoping today | verdict |
|---|---|---|---|
| 1003 liabilities table | `loadLiabilities1003` :26965 | `_combined ? .in(contactIds) : .eq(activeCid)` | **the reference pattern** |
| DTI income + debt totals | `renderBorrowerIncomeDebtCards` :31501 | per-borrower loop, sums all included | **already correct** |
| LOS income list | `losLoadIncome` :30811 | `.eq('contact_id', cid)` | combined sibling exists — `losLoadBorrowerData` :31495 |
| LOS liabilities list | `losLoadLiabilities` :30677 | `.eq('contact_id', cid)` | combined sibling exists — `losLoadBorrowerData` :31498 |
| **LOS assets** | `losLoadAssets` :30944 | `.eq('contact_id', cid)` **only** | **NEEDS IT** |
| **LOS REO** | `losLoadREO` :31058 | `.eq('contact_id', cid)` **only** | **NEEDS IT** |
| 1003 summary borrower row | :28719 | `.eq(cid).limit(1).maybeSingle()` | single by design — it renders one borrower |

### Income and liabilities are not missing the pattern

They have two loaders. `losLoadIncome` / `losLoadLiabilities` take one contact;
`losLoadBorrowerData()` re-queries both tables with `.in('contact_id', ids)` over
the borrowers toggled on, and is called on every borrower switch when
`losViewMode === 'combined'`.

What is true is that **`losViewMode` defaults to `'individual'`** (`:31140`), so
the first thing you see on a two-borrower file is one borrower's rows. That is a
default, not a missing capability — and it is arguably the right default for a
per-borrower 1003 section. It is why "three liabilities in the file, two on
screen" was the reported symptom.

### Assets and REO are the real gap

Both are single-contact with no combined path anywhere, and it is a *known*
limitation — `losSwitchBorrower` says so in a comment (`:31420`):

```
// In combined mode, income/liabilities come from losLoadBorrowerData (union);
// everything else (form fields, assets, REO) tracks the primary borrower.
```

Form fields tracking the primary is correct — they are that borrower's 1003
fields. **Assets and REO are not in that category.** A co-borrower's bank
accounts count toward reserves and cash-to-close, and their owned property
carries both a liability and possible rental income. Showing only the primary's
understates both, in the same direction as the DTI bug: the file looks better
than it is.

**Priority is low today and will rise.** `mismo-import` writes neither
`loan_assets` nor `loan_reo` (grep: no match), so nothing populates a
co-borrower's assets automatically yet — these rows only exist when typed in by
hand. The gap is real but currently mostly empty.

### The generated 1003 PDF is not affected

`generate-1003-pdf` scopes by **application**, not contact (`:371-373`):

```
or=(application_id.eq.<app.id>,and(application_id.is.null,contact_id.eq.<contact_id>))
```

so assets, liabilities, REO and income all include every borrower on the
application. The narrowing is a property of the **page**, not the document.

## Recommendation

1. Give `losLoadAssets` and `losLoadREO` the `losLoadBorrowerData` treatment —
   extend that function to cover all four tables rather than adding a third
   pattern. It already owns the "borrowers toggled on" id list.
2. Leave income/liabilities alone. They have the pattern; only the default view
   differs, and changing that default is a UX decision, not a defect fix.
3. Leave `renderBorrowerIncomeDebtCards` alone. It is correct.

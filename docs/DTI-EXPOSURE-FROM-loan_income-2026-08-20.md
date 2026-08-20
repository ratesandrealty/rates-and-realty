# Has a wrong DTI left the building? — reported before any fix

Blocking question answered before touching `loan_income`. **Nothing changed by
this investigation.**

---

## The corrected numbers for Garcia

Application `737a7f06-…`, contact `599b4b4a-…`.

| | value |
|---|---|
| true combined monthly income | **14,798.67** |
| sum of active `loan_income` rows | **29,023.61** (1.96×) |
| stored `loan_scenarios.total_monthly_income` | **29,023.61** — exactly the inflated sum |
| PITIA / monthly debt | 6,421.59 / 283 |
| **stored** front / back DTI | **22.13% / 23.10%** |
| **corrected** front / back DTI | **43.39% / 45.31%** |
| back DTI understated by | **22.21 points** |

Six active rows where the file has three: Daniel's Base 5858.67 and Bonus 4260
each present twice (2026-07-15 and 2026-08-19), and America's Base as **both**
4106.27 (superseded) and 4680 (current).

**Direction matters.** Doubling income *halves* DTI, so the error makes the
borrower look **more** qualified, not less. At the true figures he still clears
Conventional (45.31% vs ≤50%), FHA and VA — but the headroom is 4.7 points, not
the 26.9 the panel showed.

## Where the wrong number is live right now

| surface | reads | state |
|---|---|---|
| `loan_scenarios` | written by `_lsAutoSave` from the panel | **holds 23.10% back DTI today** |
| `borrower_qualifying_snapshot` (VIEW over `loan_income`) | `sum(li.monthly_amount)` by application | **holds 29,023.61 today** |
| `sms-assistant` `query_loan_income` | that view | would quote it on request |
| `generate-1003-pdf` | `loan_income`, active only (`:157`, `:378`) | would itemise duplicates |
| `generate-mismo-data` | `loan_income` by `application_id`, `is_active` (`:175`) | would export duplicates |

`borrower_qualifying_snapshot` is the sharpest, because it derives
**affordability**, not just a ratio:

```
max_back_end_piti_at_50_dti   14,511.81      ← what it says today
                               7,116.34      ← 14,798.67 × 0.50 − 283
```

An SMS asking what this borrower can carry gets roughly **double** the true
figure — the answer that would send someone shopping for too much house.

## What has demonstrably NOT left the building

**Fee sheets are clean.** Nine `fee_sheet_snapshots` for Daniel Garcia, none
revoked, one viewed **225 times** — and **not one carries income or DTI**
(`data::text ilike '%dti%'` and `'%income%'` both false on all nine). The fee
sheet is the artifact that provably reached the borrower, and it does not carry
this number.

CMA snapshots likewise do not carry income or DTI.

## What I cannot rule out

**No stored 1003 / URLA / MISMO artifact exists** for either contact —
`uploaded_documents` has zero rows matching those names or types.

**That is weaker evidence than it looks.** `generate-1003-pdf` streams the PDF
back to the caller and does not necessarily write an `uploaded_documents` row, so
absence of a row is *no evidence it was generated*, not *proof it was not*. If a
1003 was generated for this file between 2026-07-15 and today, it carried the
duplicated income and I cannot see it from here. The 24-hour edge-log retention
is long gone for both import dates.

**The honest summary: the fee sheets that reached the borrower are clean; the
wrong number is live in two places that answer questions today; and whether a
1003 PDF ever carried it is unknowable from the data.**

---

## How many other contacts are affected — one, and two false positives

The instinctive query (more than one active row per contact/type) returns four
groups across three contacts. **Two of the three are not defects**, and both
would have been destroyed by a careless fix.

| contact | rows | verdict |
|---|---|---|
| **Daniel Garcia** | Base ×2, Bonus ×2 — same amounts, 07-15 + 08-19 | **real: re-import duplicate** |
| **America Jaimes** | Base 4106.27 + 4680, 07-15 + 08-19 | **real: superseded, both active** |
| Duc Tien Nguyen | 4 × Base, different amounts, all 2026-04-10 | **FALSE POSITIVE** |
| Santana Navarro Rosales | 3 × Base 2798 | **already hand-cleaned** |

**Nguyen's file genuinely has five `CURRENT_INCOME_ITEM` blocks, every one typed
`Base`** — 9738.10, 3652.23, 20000, 1090.25, 1856.13. Four sit on his contact and
the fifth on the co-borrower's. Summing them is *correct*. His scenario income of
36,336.71 equals 34,480.58 + 1,856.13 exactly, so his DTI is right and complete.
His record was imported once.

**Santana's application was re-imported** (2026-05-19 and 2026-05-21) — the only
other one in the database — but somebody already set the two duplicate rows
`is_active = false` by hand. Four active rows, all distinct, correct.

The reliable test is not "duplicate amounts" but **"was this application imported
more than once"**, and exactly two applications qualify:

```
EMC26071266-DanielRamiroGarcia   2026-07-15, 2026-08-19   6 active   <- broken
EMC26050739-SantanaNAVARROROSALES 2026-05-19, 2026-05-21   4 active   <- already fixed
```

**So: one contact has a live wrong total. Garcia.**

---

## Two defects found on the way, logged not fixed

### `borrower_qualifying_snapshot` attributes the household to the wrong borrower

```
America Jaimes   total_documented_monthly  29,023.61
Daniel Garcia    total_documented_monthly        0.00
```

The view aggregates by `application_id` and labels the result with one name. The
**primary borrower reads as zero income** while the co-borrower carries the whole
household. `sms-assistant` looks a borrower up **by name**, so asking about
Daniel Garcia — the primary — returns **$0**.

This is independent of the duplication bug and will still be wrong after the
duplicates are removed. Not touched.

### `ocr-apply-1003` already has the delete-then-insert pattern

`supabase/functions/ocr-apply-1003/index.ts:233-236`:

```ts
await sb.from('loan_income').delete()
  .eq('contact_id', contact_id).eq('source', ded.source).eq('employer_name', ded.employer_name)
```

It scopes its delete by `contact_id` + `source`, exactly the shape the MISMO fix
needs. **The fix should copy this rather than invent a second pattern** — the same
reasoning as the liabilities panel. It is also further evidence the MISMO import's
plain insert was an omission and not a design choice: two of the three writers
into this table already dedupe, and MISMO is the one that does not.

---

# CORRECTED — 2026-08-20, later

Three rows deactivated. **`is_active = false`, not `DELETE`** — the Santana
precedent, and reversible from the ids below.

## Before → after

| owner | type | amount | import | now |
|---|---|---|---|---|
| Daniel Garcia | Base | 5858.67 | 2026-08-19 | **ACTIVE** |
| Daniel Garcia | Bonus | 4260 | 2026-08-19 | **ACTIVE** |
| America Jaimes | Base | 4680 | 2026-08-19 | **ACTIVE** |
| Daniel Garcia | Base | 5858.67 | 2026-07-15 | deactivated `400b5166` |
| Daniel Garcia | Bonus | 4260 | 2026-07-15 | deactivated `46d750fd` |
| America Jaimes | Base | 4106.27 | 2026-07-15 | deactivated `656e0220` |

## Why those three

**Every `source='mismo'` row from the FIRST import (2026-07-15); the 2026-08-19
set survives.** Not an arbitrary pick within each pair:

- **America Jaimes** is the one that matters — her amount genuinely *changed*
  (4106.27 → 4680). The newer row is the correct one, so "keep the later import"
  is the substantively right rule, not a tie-break.
- **Daniel Garcia's** two pairs are byte-identical, so which survives cannot move
  any total. Keeping the same import date across all three makes the surviving set
  exactly what a re-import under the new `replaceMismoIncome()` would leave — so
  the record now matches what the fixed code produces.

The update was guarded: it aborted unless exactly 3 rows changed, exactly 3
remained active, and the active sum equalled 14,798.67.

## Both surfaces confirmed

| | before | after |
|---|---|---|
| `loan_income` active sum | 29,023.61 | **14,798.67** |
| `loan_scenarios.total_monthly_income` | 29,023.61 | **14,798.67** |
| `loan_scenarios.front_end_dti` | 22.13% | **43.39%** |
| `loan_scenarios.back_end_dti` | 23.10% | **45.31%** |
| `borrower_qualifying_snapshot.total_documented_monthly` | 29,023.61 | **14,798.67** |
| `…max_back_end_piti_at_43_dti` | 12,480.15 | **6,363.43** |
| `…max_back_end_piti_at_50_dti` | 14,511.81 | **7,399.34** |

**They did not both update the same way, and the difference matters.**

`borrower_qualifying_snapshot` is a VIEW filtering `is_active = true`, so it
corrected itself the moment the rows flipped — no action needed.

**`loan_scenarios` is a stored cache written by the page** (`_lsAutoSave`), so it
did **not** move. It still read 29,023.61 / 23.10% after the deactivation, and
would have kept reading it until somebody happened to open the lead. It was
updated explicitly, recomputing from the same stored PITIA (6,421.59) and debt
(283) that the page uses:

```
front = 6421.59 / 14798.67 * 100 = 43.39%
back  = (6421.59 + 283) / 14798.67 * 100 = 45.31%
```

Those match the corrected figures predicted before any change was made.

**One definitional note, not an error.** `max_back_end_piti_at_50_dti` is
`income × 0.50` — it does **not** net out the 283 of existing debt. Read as "total
back-end capacity" that is right; read as "PITI you can still afford" it is ~283
optimistic. The view is now internally consistent either way; whether it should
subtract known debt is a separate question from this fix.

---

# CORRECTION, 2026-08-20 — a pre-approval letter DOES carry a DTI

Earlier in this file I reported that no pre-approval artifact exists for the
affected contacts, on the basis that `uploaded_documents` has no matching rows.
**That reasoning was incomplete.** I checked for a stored artifact and never
checked whether the pre-approval *generator* carries a DTI at all. It does.

`admin/lead-detail.html` (~:30388), the Generate Pre-Approval Letter path:

```js
var totalIncome = _lsNum('ls_total_monthly_income');
var totalDebt   = _lsNum('ls_total_monthly_debt');
var frontDTI = totalIncome ? (pitia/totalIncome*100) : 0;
var backDTI  = totalIncome ? ((pitia+totalDebt)/totalIncome*100) : 0;
…
front_dti:frontDTI, back_dti:backDTI, total_income:totalIncome, total_debt:totalDebt,
```

`ls_total_monthly_income` is the on-screen figure that
`renderBorrowerIncomeDebtCards` fills from the **live `loan_income` sum**. So a
letter generated while a borrower's income was doubled carried a DTI roughly half
the true value, on Rates & Realty letterhead, over an NMLS number.

**Whether one was generated is unknowable.** `generate-preapproval` builds the PDF
and returns it; it writes no `uploaded_documents` row and no storage object, the
same gap as the MISMO export
(`docs/MISMO-EXPORT-PROVENANCE-2026-08-20.md`). The window in which Garcia's
income was doubled ran 2026-07-15 → 2026-08-20 and Santana's 2026-05-21 →
2026-08-20.

**So the corrected finding is:** the fee sheets that provably reached borrowers are
clean, but the pre-approval letter is a second document that carries this number,
and there is no record of whether one was produced for either borrower. My earlier
"no evidence of, not proof against" applies here too — and it now covers a wider
surface than I stated.

## A separate finding on that path, not fixed

`generate-preapproval` has **no authentication of any kind**:

```ts
Deno.serve(async (req) => { … const body = await req.json(); const pdfBytes = await buildPDF(body); … })
```

No `requireStaff`, no `getUser`, `verify_jwt = false`, and the page calls it with
`Authorization: Bearer <anon key>`. It reads **nothing** from the database — every
figure comes from the request body.

That makes it a **document-generation surface, not a data-disclosure one**: it
leaks none of our data, but anyone holding the public anon key can produce a
Rates & Realty pre-approval letter for any borrower name, property and amount,
carrying Rene's name and NMLS 1795044.

It also fires `clickup-auto-create` and a lead-score event using a
**caller-supplied `contact_id`**, so the same anonymous caller can create ClickUp
tasks and move the lead score on a real contact.

**Not fixed here.** Guarding it is frontend-first — the page sends the anon key,
so a guard would break the button until that call site moves to `fnFetch`. Logged
for its own pass; it is a larger question than the DTI it happens to carry.

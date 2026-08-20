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

# Santana Navarro Rosales — has a real file been misread since June?

Asked after correcting a stale `loan_scenarios` row from 24,373.16 to 11,774.93,
which moved the displayed back-end DTI from **30.05%** to **62.21%**.

**Short answer: the income is right, the DTI was genuinely wrong on screen, the
scenario it comes from never matched the application anyway, and the loan is
CLOSED. No decision is pending on it.**

---

## 1. Income: correct and complete. 11,774.93 stands.

The two hand-deactivated rows were **exact duplicate retirements**, done right.

The application was imported **three times**, not twice — 2026-05-19, then twice
on 2026-05-21 — and each run re-inserted Jose Navarro's Base:

| owner | type | amount | created | state |
|---|---|---|---|---|
| Santana Navarro Rosales | Base | 4,623.53 | 05-19 | **active** |
| Aned Mendoza | Base | 3,867.07 | 05-19 | **active** |
| Aned Mendoza | Bonus | 486.33 | 05-19 | **active** |
| Jose Navarro | Base | 2,798.00 | 05-19 | **active** |
| Jose Navarro | Base | 2,798.00 | 05-21 03:37 | deactivated 06-04 |
| Jose Navarro | Base | 2,798.00 | 05-21 05:25 | deactivated 06-04 |

Both deactivated rows are the **same amount, same type, same contact** as the
surviving one, and both were flipped in a single action at
`2026-06-04 04:03:42.273712`. Nothing was lost. 4,623.53 + 3,867.07 + 486.33 +
2,798.00 = **11,774.93**.

This is a three-borrower application. The corrected income is the household total
across all three.

## 2. The June PITIA does NOT reflect the application

This is the finding that matters, and it means the corrected DTI is itself built
on sand.

| | scenario (the DTI panel) | application of record |
|---|---|---|
| loan amount | **807,500** @ 6.5% | **660,000** |
| last touched | 2026-06-13 (income row, today) | 2026-06-12 |
| monthly debt | **639** | live liabilities total **1,267.00** (6 rows, non-payoff) |

**The PITIA of 6,686.35 was computed for an $807,500 loan.** The application
records $660,000 — a $147,500 difference, about 22%. So the housing payment
driving every ratio on that panel is for a materially larger loan than the file
records.

The debt figure is stale in the same direction: 639 stored against 1,267.00 live.

### What the ratio actually is, under each set of inputs

| inputs | front | back |
|---|---|---|
| scenario PITIA + scenario debt (what I wrote in) | 56.78% | **62.21%** |
| scenario PITIA + **live** debt 1,267 | 56.78% | **67.54%** |
| a PITIA re-derived for the $660K the application records | **not computed** | **not computed** |

I have not estimated the third row. P&I scales with the loan amount but taxes,
insurance, MI and HOA do not, so scaling 6,686.35 down by 22% would be a guess
dressed as a figure — exactly what this file's conventions warn against. It needs
re-deriving from the real terms, not arithmetic on a stale total.

**So the honest statement is: the DTI on this contact is wrong at 30.05%, wrong at
62.21%, and cannot be stated correctly until the scenario's loan amount and debt
are reconciled with the application.** What is certain is the direction — every
correction so far has moved it *up*.

## 3. The loan is CLOSED

`contacts.pipeline_status = 'Closed'` for this contact. So:

- **No live decision rests on this number.** It is a record-quality defect, not a
  qualification-in-flight problem.
- Nothing with a DTI in it reached the borrower: the nine `fee_sheet_snapshots`
  audited earlier carry **no income or DTI fields at all**, and this contact's
  snapshots are among them.
- There is no pre-approval artifact in `uploaded_documents` for this contact
  either — the same caveat applies as for Garcia, that `generate-1003-pdf` streams
  without necessarily leaving a row, so this is *no evidence of*, not *proof
  against*.

## 4. So: was a real file misread since June?

**The CRM displayed a wrong DTI for this borrower from 2026-06-13 until today** —
30.05% where the same panel's own inputs give at least 62.21%. That is real, and
it is the direction that flatters the file.

**But the panel was never a faithful model of this loan.** A scenario carrying an
$807,500 loan against an application recording $660,000 is a working sketch, not
the file of record. Whoever used it for a decision would have been reading the
wrong loan regardless of the income bug.

**And the loan closed.** Whatever was actually underwritten was underwritten by a
lender against real documents, not against this panel.

The residual risk is not that this loan was mis-approved. It is that
`loan_scenarios` is treated as a record when it is a scratchpad — stale on loan
amount, stale on debt, and until today stale on income, with nothing marking any
of it as out of date.

## What I would do about it

1. **Do not re-derive Santana's DTI to "fix" the number.** The file is closed; a
   freshly computed ratio on a closed loan is a number nobody needs and invites
   the belief that the panel is now trustworthy for this contact. Leave the
   corrected income (it is true) and record here that the PITIA is for a different
   loan amount.
2. **Surface staleness rather than hiding it.** The panel shows `front_end_dti` and
   `back_end_dti` with no indication of when they were computed or against what
   loan amount. A scenario whose `loan_amount` disagrees with its application's
   should say so on screen — that single check would have made this visible in
   June without anyone auditing anything.
3. This is the third argument for the option-3 fix in
   `docs/STALE-CACHE-SWEEP-2026-08-20.md`: **stop storing the ratio.** A generated
   column or a view over live income, debt and PITIA cannot go stale, and none of
   the three defects found on this record could have occurred.

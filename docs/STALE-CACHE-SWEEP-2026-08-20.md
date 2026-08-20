# Stale caches of a `loan_income` derivative — the sweep

Asked because deactivating rows corrected `borrower_qualifying_snapshot`
automatically (a view) but left `loan_scenarios` holding the old number (a stored
cache). **The hazard is not specific to Garcia, and the sweep found one more live
instance.**

## What counts as this hazard

A **stored column** holding a number derived from `loan_income`, with no trigger
and no server-side recompute — so changing the rows leaves it wrong until a human
opens the page that writes it.

Views are not in scope: they re-evaluate. `borrower_qualifying_snapshot` filters
`is_active` and corrected itself the instant the rows flipped.

## The result: `loan_scenarios` is the only one — and one row is still wrong

Every column in `public` matching income/dti/debt/qualif was enumerated, then
tested against the live data rather than judged by name.

| column | verdict |
|---|---|
| **`loan_scenarios.total_monthly_income`, `total_monthly_debt`, `front_end_dti`, `back_end_dti`** | **THE HAZARD.** Written only by `_lsAutoSave` from the lead page. |
| `mortgage_applications.combined_monthly_income` | a cache, but **never wrong** — `mismo-import` computes it from the in-memory parse, so the duplicate rows never reached it. Held 14,798.67 throughout. |
| `mortgage_applications.total_monthly_income` | 10,118.67 = the primary's own total. Correct for its meaning. |
| `mortgage_applications.monthly_debt`, `combined_monthly_debt` | 283, correct. |
| `contacts.monthly_income`, `monthly_debt`, `annual_income` | **NULL** on both borrowers — not populated, not in use. |
| `contact_financials.monthly_income` | **0 rows** for either contact — table unused here. |
| `loan_borrowers.base_income`, `prev_monthly_income` | captured facts from the file, not aggregates. Not derivatives. |
| `mortgage_applications.base_income` | **5822.38 — the `employments` blob figure**, not the MISMO 5858.67. A different seam, already logged in `OPEN-DECISION-employments-blob-vs-mismo-2026-08-20.md`. |
| `mortgage_applications.co_borrower_base_income` | **0**, where her Base is 4,680. Same seam. |

### The list you asked for: one stale row, still wrong today

```
borrower                    scenario says   live household   verdict
Santana NAVARRO ROSALES        24,373.16        11,774.93     STALE   (updated 2026-06-13)
```

**This is the second instance of exactly the hazard, arrived at independently.**
Santana's application is the *other* one that was ever re-imported, and somebody
hand-deactivated its duplicate rows. The view corrected itself. `loan_scenarios`
kept the doubled figure and has held it since June — roughly 2×, the same shape
and the same direction as Garcia's.

**CORRECTED later the same day — see the section at the foot of this file.** When
first written this was left alone as another borrower's record, outside the
authorisation then given; it was authorised and fixed afterwards. The corrected
back-end DTI is **62.21%**, which clears no programme.

### Everything else in `loan_scenarios`

| verdict | rows | meaning |
|---|---|---|
| IN SYNC | 7 | includes Garcia, corrected today |
| STALE | **1** | Santana, above |
| no cached income | 10 | `total_monthly_income` NULL — nothing cached, so nothing stale |
| no live income to compare | 15 | a typed scenario income with **no `loan_income` rows at all** |

The last group is not this defect, but it is worth knowing: fifteen scenarios
carry a hand-typed income (Quintero 11,065; Lopez Gonzalez 17,500; Rene Duarte
25,000; Shelley Hurle 17,247) with no structured income behind it. Those numbers
cannot be checked against anything — they are neither stale nor verified.

**Incidental:** `Shelley Hurle` and `Xochitel Lara` each have **two** rows flagged
`is_primary`. `_lsAutoSave` picks a scenario by `_lsScenarioId` so it will keep
writing one of them; the other drifts silently. Not investigated further.

## The durable fix, which is not "remember to refresh"

`loan_scenarios` caches a value it does not own. Three options, in increasing
order of doing the job properly:

1. **Recompute on read** — have the page derive income from `loan_income` every
   time rather than trusting the stored column. Closest to what
   `renderBorrowerIncomeDebtCards` already does; the stored column becomes
   display-only history.
2. **A trigger on `loan_income`** that recomputes affected `loan_scenarios` rows.
   Makes the cache self-healing, at the cost of a write amplification and a
   trigger nobody sees.
3. **Stop storing it.** `front_end_dti` / `back_end_dti` are pure functions of
   PITIA, debt and income; a generated column or a view would make staleness
   structurally impossible.

Option 3 is the only one where this cannot recur. Options 1 and 2 both leave a
stored number that *can* disagree; they just make it disagree less often.

**Until one is done, the rule is: any change to `loan_income` rows requires an
explicit `loan_scenarios` update.** Deactivating three rows corrected the view and
left the cache wrong, and that is how Santana has been wrong since June.

---

# CORRECTED — Santana, 2026-08-20

Authorised and applied. Scenario `d307458a`, application
`78f2e8b4-…` (`EMC26050739-SantanaNAVARROROSALES`).

| | before | after |
|---|---|---|
| `total_monthly_income` | **24,373.16** | **11,774.93** |
| `front_end_dti` | 27.43% | **56.78%** |
| `back_end_dti` | **30.05%** | **62.21%** |
| PITIA / debt (unchanged) | 6,686.35 / 639 | 6,686.35 / 639 |
| last updated | 2026-06-13 | 2026-08-20 |

Recomputed the same way as Garcia's — from the live active income and the PITIA
and debt already stored on the scenario. Guarded: the update aborted unless the
live income equalled 11,774.93 and exactly one row changed.

**Post-sweep: 0 STALE rows remain.** 8 in sync, 10 with no cached income, 22 with
a typed income and no `loan_income` rows to compare against. (The last count reads
higher than the earlier sweep only because that query inner-joined `contacts` and
silently dropped scenarios whose contact row did not match; no data moved.)

## This one needs a human decision, and quickly

**A 62.21% back-end DTI exceeds every limit the panel itself checks** —
Conventional ≤50%, FHA ≤57%, VA ≤55%. The stored 30.05% read as comfortably
qualified under all three. This is the same error as Garcia's in direction and
cause, but Garcia's corrected figure (45.31%) still clears Conventional, and this
one does not clear anything.

**I am not saying this borrower does not qualify.** The corrected ratio is only as
good as its three inputs, and two of them are worth checking before anyone acts:

- **Income may be understated.** 11,774.93 is the sum of *active* `loan_income`
  rows. Two rows on this application were set `is_active = false` by hand at some
  point; if either was deactivated in error rather than as a duplicate, real income
  is missing. The deactivated rows are `Jose Navarro Base 2798` ×2 — both exact
  duplicates of a surviving active row, so on the evidence they were correctly
  retired. Worth confirming.
- **PITIA is from 2026-06-13** and reflects whatever loan structure was on screen
  then. If the scenario has since changed, 6,686.35 is stale in its own right —
  the DTI is now internally consistent, but consistent with a June structure.

What is not in doubt is that the *displayed* ratio was wrong by 32 points in the
direction that flatters the file, and it had been since June.

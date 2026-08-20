# `loan_scenarios` — what reads the stored ratio, and what actually breaks

Asked after the third wrong DTI in this table. Reported on its own terms rather
than correcting a fourth row.

---

## The direct answer: NOTHING reads the stored ratio

`front_end_dti` and `back_end_dti` are **write-only**. Searched both sides:

**Code** — one mention in the whole tree, and it is the write:

```
admin/lead-detail.html:29998   front_end_dti:frontDTI, back_end_dti:backDTI     (_lsAutoSave)
```

**Database** — nothing at all:

| | |
|---|---|
| functions referencing `loan_scenarios` | **(none)** |
| functions referencing `front_end_dti` / `back_end_dti` | **(none)** |
| views referencing `loan_scenarios` | **(none)** |
| rows carrying a stored `back_end_dti` | **40** |

**40 rows hold a computed debt-to-income ratio that nothing has ever read back.**
The same is true of `total_housing_payment`, `ltv` and `cash_to_close`.

### The two things that DO read `loan_scenarios`, and what they take

Both read **inputs**, never derivatives.

**1. `admin/lead-detail.html:30576`** — overlays saved values into the form:

```js
if (s.loan_amount) …            if (s.interest_rate) …      if (s.loan_term_months) …
if (s.property_taxes_monthly) … if (s.insurance_monthly) …  if (s.hoa_monthly) …
if (s.total_monthly_income) …   if (s.total_monthly_debt) … if (s.purchase_price) …
```

No `front_end_dti`, no `back_end_dti`, no `total_housing_payment`. `lsRecalc()`
recomputes all of those from the inputs on every load — **the page already
computes on read.** The stored copy is written and then ignored, including by the
page that wrote it.

**2. `supabase/functions/generate-mismo-data/index.ts:159`** — outbound export:

```ts
loanAmount: sNum(scen.loan_amount) ?? sNum(app.loan_amount),
propVal:    sNum(scen.appraised_value) ?? …,
rate:       sNum(scen.interest_rate) ?? …,
term:       scen.loan_term_months || app.loan_term_months || 360,
pi/taxes/insurance: scen.* ?? app.*
```

Again no DTI and no income — income comes from `loan_income` directly.

## So: would anything break if it were computed on read?

**No. Nothing reads it, so nothing can break.**

Stronger than that: the derived columns could be **dropped** with no code change
anywhere. The page already recomputes them; the export never wanted them. Options
1 and 3 from the earlier sweep collapse into the same act, and option 2 — a
trigger to keep the cache fresh — would be maintaining a value with no consumer.

The only cost of dropping them is losing a historical record of what a ratio was
at a point in time. Nothing currently uses that record, and it has been wrong on
three of the rows we looked at, so it is not a record worth keeping.

`total_monthly_income` and `total_monthly_debt` are different — they ARE read back
into the form. They should stay, but they are **inputs the user may override**, not
derivatives, and treating them as either has been the source of the confusion.

---

## The sharper finding, which the DTI question was hiding

The ratio is harmless because nobody reads it. **The inputs are not harmless,
because `generate-mismo-data` prefers the scenario over the application** —
`scen.loan_amount ?? app.loan_amount` — and the scenario is a scratchpad.

Measured across the book:

| | count |
|---|---|
| contacts with a scenario | 38 |
| comparable (both carry a loan amount) | 19 |
| **scenario disagrees with the application** | **11 of 19** |

| borrower | status | scenario | application | difference |
|---|---|---|---|---|
| Edgar Rodriguez | Contacted | 0 | 400,000 | (falls back — `sNum` treats 0 as null) |
| Dora Munoz Cruz | Closed | 0 | 324,000 | (falls back) |
| **Rafael Hernandez Andrade** | **Processing** | 515,200 | 699,999 | **−184,799** |
| Santana Navarro Rosales | Closed | 807,500 | 660,000 | +147,500 |
| **Daniel Garcia** | **Processing** | 815,425 | 674,500 | **+140,925** |
| **Vincent Solis** | **Pre-Approved** | 386,000 | 289,500 | **+96,500** |
| **Juan Pablo Davila** | **Processing** | 313,625 | 224,000 | **+89,625** |
| **Shelley Hurle** | **Pre-Approved** | 630,000 | 712,500 | **−82,500** |
| Tania Monje Flores | Closed | 798,750 | 852,000 | −53,250 |
| Rene Duarte | New Lead | 637,500 | 680,000 | −42,500 |
| Jorge Lopez Gonzalez | Closed | 650,000 | 629,000 | +21,000 |

**Six are live files** — Processing or Pre-Approved. For each, a MISMO export
today would carry the **scenario's** loan amount, not the application's.

**This is not automatically wrong.** A scenario legitimately models a structure
that differs from a recorded application; that is what scenarios are for, and
preferring the newer working figure may well be the intent. What is wrong is that
the preference is **silent** — nothing on the page or in the export says which
number won, and the two nearest disagreements (Garcia, Solis) were last touched on
the same day as their application, so "newer" does not disambiguate them either.

Santana is the proof that it matters: her scenario models an $807,500 loan against
an application recording $660,000, and every ratio on her panel was computed on the
larger one.

---

## Recommendation

1. **Drop `front_end_dti`, `back_end_dti`, `total_housing_payment`, `ltv`,
   `cash_to_close` from `loan_scenarios`.** Nothing reads them, the page already
   recomputes them, and they have been wrong three times. This is the decision
   asked for, and it is a strictly-remove change with no caller to migrate.
2. **Keep `total_monthly_income` / `total_monthly_debt`**, but treat them as
   overridable inputs, not cached aggregates. If the intent is "the live household
   total", the page should derive it and the column should go too; if the intent is
   "what Rene typed", it should never be silently overwritten by
   `renderBorrowerIncomeDebtCards`. Today it is both, which is why Garcia's and
   Santana's disagreed with `loan_income`.
3. **Make the export's preference explicit.** `generate-mismo-data` should either
   state in its `warnings[]` that the scenario overrode the application, or refuse
   when they disagree by more than a threshold. Six live files currently export a
   loan amount the application does not record, silently.
4. **Surface scenario-vs-application drift on the page.** A scenario whose
   `loan_amount` differs from its application's should say so. That one check would
   have made Santana visible in June without anyone auditing anything.

Items 1 and 3 are the two that remove a real failure mode. Item 1 is what stops a
fourth wrong ratio, because there will be no ratio to be wrong.

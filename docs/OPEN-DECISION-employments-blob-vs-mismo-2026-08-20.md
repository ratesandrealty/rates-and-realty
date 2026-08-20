# OPEN DECISION — which employment source is authoritative

**Not a bug to patch in passing. A decision about ownership.** Logged, not acted
on.

## The seam

There are two employment records per borrower and nothing reconciles them.

| | `loan_borrowers` flat columns | `mortgage_applications.employments` (jsonb) |
|---|---|---|
| written by | `mismo-import` | the 1003 employment editor in `admin/lead-detail.html` |
| read by | the 1003 panel, `generate-1003-pdf`, `generate-mismo-data` | **`voe-form-fill`** |
| shape | `employer_name`, `position_title`, `employment_start_date`, `employer_state`, `employer_zip`, … | `employer`, `title`, `start_date`, `state_zip`, `hr_first`, `hr_last`, `employer_email`, `commission`, `years_work` |
| per borrower? | yes — one row each | **no — a single array on the application** |

`grep -n "employments" supabase/functions/mismo-import/index.ts` → **no match.**
The importer has never read or written it.

## What that produces today, on EMC26071266

```
loan_borrowers   Tom's Truck Center North County, L   Mechanic   2017-01-03   CA 90670
employments[0]   TOM'S TRUCK CENTER NORTH COUNTY, LLC  title:""  start_date:""  state_zip:""
                 base 5822.38  bonus 2754.42  overtime 346.78
```

- Different capitalisation — two capture paths, neither normalising.
- The blob's numbers (5822.38 / 2754.42 / 346.78) match **neither** the MISMO file
  (5858.67 Base / 4260 Bonus) **nor** `loan_income`. Nothing has ever synchronised
  them.
- `title`, `start_date` and `state_zip` are empty in the blob while populated in
  `loan_borrowers` — so the *better* record is the one the VOE does not read.
- The blob holds **one** entry for a **two**-borrower file. The co-borrower has no
  employment in the structure the VOE is built from.

## Why this is the consequential half

`voe-form-fill` builds the Verification of Employment that goes **to the
employer**. So the outward-facing document is assembled from hand-entered figures
that a MISMO import will never correct, on a structure that cannot represent the
second borrower.

That is the opposite arrangement from everywhere else in this file: the
authoritative, machine-populated, per-borrower record feeds the internal panels,
and the hand-maintained, single-slot one feeds the third party.

## Why it must not be "fixed" by making MISMO overwrite the blob

The blob carries fields MISMO does not have at all — `hr_first`, `hr_last`,
`employer_email`, `employer_hr_contact`, `commission`, `years_work`. Several are
the point of a VOE: they are who to send it to. An overwrite would delete the
routing information in order to correct the pay figures.

Equally, leaving it is not neutral — it is choosing that VOEs are built from
whatever was last typed.

## The actual options

1. **Blob stays authoritative for VOE; MISMO fills only what is empty.** A merge,
   not an overwrite. Preserves HR routing, corrects blank pay/title/date fields.
   Leaves two records that can still disagree where both are populated.
2. **`loan_borrowers` becomes authoritative; the blob becomes VOE-only routing
   data** (HR contact, email). `voe-form-fill` reads employment from
   `loan_borrowers` and routing from the blob. Single source per fact. Needs
   `voe-form-fill` changed and the blob's pay fields retired.
3. **Blob becomes per-borrower** and MISMO writes it. Largest change; the only one
   that lets a co-borrower VOE exist at all.

Option 2 is the one I would argue for — it matches how liabilities and income
already work (structured child rows authoritative, panels derived) — but the
co-borrower question in option 3 is real and unresolved either way: **today no
VOE can be produced for a second borrower.**

## What needs deciding before any code moves

- Which record is the truth for pay figures on a VOE.
- Whether a co-borrower VOE is a requirement.
- Whether `voe-form-fill` may read `loan_borrowers` at all, or must stay on a
  single blob for auditability of what was sent.

**Related open item:** `borrower_qualifying_snapshot` attributes the whole
household to the co-borrower and reports the primary as `$0` — see
`docs/DTI-EXPOSURE-FROM-loan_income-2026-08-20.md`. Same family: a per-application
aggregate wearing one borrower's name.

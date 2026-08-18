# Five vocabularies for one question, 2026-08-18

Logged, not fixed. The Transaction Type work constrains the two CRM pickers on
`contacts.loan_purpose`; the three below are deliberately left alone this pass.
This file exists so that decision stays a decision rather than becoming a
discovery.

`loan_purpose` is the only purchase-vs-refinance discriminator in the project.
There is no `transaction_type` column anywhere — grepped case-insensitively
across the worktree and `C:\AI\test\api`: zero matches.

## The five

| # | where | values | stores |
|---|---|---|---|
| 1 | `admin/lead-detail.html:2392` Pricing & Lender | `purchase` `refinance` `construction` `other` | `contacts.loan_purpose` |
| 2 | `admin/lead-detail.html:3736` 1003 modal | `purchase` `refinance` `construction` `other` | `mortgage_applications.loan_purpose` |
| 3 | `auth/index.html:1833` borrower application | `purchase` `refinance` `construction` — **no `other`** | `mortgage_applications.loan_purpose` |
| 4 | `public/unified-portal.html:585` portal | `Purchase` `Refinance` `Cash-Out Refinance` | `mortgage_applications.loan_purpose` |
| 5 | `public/unified-portal.html:841` commercial intake | `Purchase` `Refinance` `Cash-Out Refinance` `Bridge` `Construction` `Rehab / Value-Add` `SBA` `Owner-User` `Hard Money` | `commercial_intakes.loan_purpose` |

**#4 and #5 use valueless `<option>` elements**, so the browser submits the
*label*. That is why Title Case exists in the data at all, and why
`Cash-Out Refinance` — a value no CRM picker can produce — appears alongside
lowercase `refinance`.

## No constraint anywhere

`contacts.loan_purpose` and `mortgage_applications.loan_purpose` are both plain
`text` with **no CHECK**. Verified against `pg_constraint`: the only CHECKs on
`contacts` are `pipeline_status`, `recording_consent_method` and the consent
pair. The option lists are the entire enforcement, and they disagree.

This is the `contacts.assigned_to` pattern from the working notes: an
unconstrained field that nothing depends on drifts into several spellings of one
value, and nothing breaks, so nobody notices.

## The consumers disagree too, and one of them is already wrong

| consumer | matching | consequence |
|---|---|---|
| `generate-1003-pdf/urla.js:43,59-61` | lowercases, then `=== 'purchase' / 'refinance' / 'other'` | case-robust; `Cash-Out Refinance` and `No Cash Out Refinance` tick **nothing** |
| `generate-1003/index.ts:171,608-609` | **case-sensitive** `=== 'Purchase'` / `=== 'Refinance'` | a lowercase `purchase` ticks **neither** box |
| `generate-1003/index.ts:171` | `v(d.loan_purpose,'Purchase')` defaults blank to `Purchase` | a contact with **no** stated purpose prints Purchase ticked |
| `dashboard_snapshot.sql:31-34` | `= 'purchase'`, `like 'refi%'`, else other | tolerant; counts all refi spellings together |
| `earnings-dashboard.html:486` | title-cases whatever it finds | `purchase`/`Purchase` collapse; `Cash-Out Refinance` becomes `Cash-out refinance` |

The last two rows of `generate-1003` are live defects independent of any change
made this pass — see the Transaction Type report.

## Why these three are being left

They write to `mortgage_applications` and `commercial_intakes`, which are
borrower-facing intake surfaces with their own review paths. Changing an option
list there changes what a borrower sees mid-application. The CRM pickers are
staff-facing and are the ones feeding the 1003 generators, so they are where a
constrained vocabulary buys something immediately.

**The consequence of leaving them: legacy free text keeps arriving.** Anything
that reads a purpose must therefore normalise rather than compare, and must
treat an unrecognised value as *unknown* — never as a default. A default is how
`generate-1003` came to print `Purchase` for 1032 contacts who never stated one.

Fix these three and the normaliser's legacy table can shrink. Until then it is
load-bearing.

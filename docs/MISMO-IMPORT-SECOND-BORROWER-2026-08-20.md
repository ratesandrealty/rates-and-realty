# MISMO import, second borrower — report before fixing

**Nothing was changed and the import was not re-run.** Read-only throughout.

Record: `EMC26071266-DanielRamiroGarcia-urla-fnm.xml`, imported
2026-08-19 19:42:28Z. Application `737a7f06-f826-43cc-b885-7c5382e958ec`.
`check-function-drift mismo-import` → **in sync**, so the repo source below is
what actually ran.

---

## Headline: the import read both borrowers, and almost everything landed

Five of the six reported symptoms are **not** import failures. The data is in the
database. What is wrong is (a) one real bug in `loan_income`, and (b) the
lead-detail panels being scoped to a single `contact_id`, so a co-borrower's rows
are invisible on the primary's page.

| reported | actual |
|---|---|
| only the first Borrower party is read | **both read.** `combined_borrower_count = 2` |
| `loan_borrowers` has 1 row for 2 borrowers | **2 rows**, order 1 and 2 |
| her income (Base 4680) is missing | **present**, `loan_income`, created 2026-08-19 |
| BANK OF AMERICA liability absent | **present**, attributed to her |
| Daniel's employment has no title / start_date | **both present** in `loan_borrowers` |
| income duplicates on re-import | **true — the one real bug** |

---

## 1. Does it iterate PARTY blocks, or take the first and stop?

**It iterates.** `parseMismo`, `supabase/functions/mismo-import/index.ts:352-383`:

```ts
const partiesBlock = tb(xml, 'PARTIES') || xml;
const partyBlocks: string[] = tbAll(partiesBlock, 'PARTY');

const borrowers: ReturnType<typeof parseParty>[] = [];
for (const party of partyBlocks) {
  const roleType = tv(party, 'PartyRoleType');
  if (roleType === 'PropertyOwner') continue;
  if (roleType === 'LoanOriginator') { … }
  else if (roleType === 'LoanOriginationCompany') { … }
  else if (roleType==='Borrower'||roleType==='CoBorrower'||
           party.includes('BORROWER_DETAIL')||party.includes('DECLARATION_DETAIL')) {
    const parsed = parseParty(party);
    if (parsed.first_name||parsed.last_name||parsed.email) borrowers.push(parsed);
  }
}
```

and the write path loops over every one of them (`:678`):

```ts
for (let i=1; i<borrowers.length; i++) {
  const cb = borrowers[i];
  … findOrCreate → contacts update → loan_income insert → loan_borrowers upsert
  if (i===1) { … co_borrower_* mirror … }
}
```

Measured against the stored XML: **5 `PARTY` blocks**, role types
`Borrower | Borrower | PropertyOwner | LoanOriginationCompany | LoanOriginator`.
Both borrowers were collected, and `combined_borrower_count = 2` on the
application confirms it at write time.

`loan_borrowers` holds **two** rows:

| order | role | employer | title | start | prev employer |
|---|---|---|---|---|---|
| 1 | Borrower | Tom's Truck Center North County, L | Mechanic | 2017-01-03 | — |
| 2 | CoBorrower | Families Together of Orange County | Health Access Specialist | 2026-07-22 | Community Health Initiative OF |

Her **two** employments both landed: the Current one in the main columns, the
Previous one in `prev_*` (`prev_position_title`, `prev_employment_start_date`
2024-03-01, `prev_employment_end_date` 2026-07-22, `prev_monthly_income` 4469).
The file carries three `EMPLOYER` blocks with statuses
`Current | Previous | Current`, which is exactly that.

## 2. Where `co_borrower_first_name/last_name` come from

Same loop, `:722-753` — the `i===1` branch writes the flat mirror onto
`mortgage_applications`. It is not a separate read of the second party; it is the
**same** `borrowers[1]` object the `loan_borrowers` row was built from. So the
mirror landing is evidence the whole co-borrower branch ran, not evidence of a
partial read.

Confirmed: `co_borrower_contact_id = 6b6644f2-…`, distinct from the primary's
`599b4b4a-…`. She has her own contact record; `findOrCreate` did not collapse her
onto Daniel.

## 3. Why it *looks* like only one borrower — the panels are contact-scoped

This is the explanation for three of the four "missing" symptoms.

The MISMO importer attributes co-borrower rows to the **co-borrower's own**
`contact_id` (v42 behaviour, driven by the `RELATIONSHIP` xlink arcs). The
lead-detail panels mostly query by a single contact:

```js
// admin/lead-detail.html:30690  losLoadLiabilities
.from('loan_liabilities').select('*').eq('contact_id', cid)

// admin/lead-detail.html:30819  losLoadIncome
.from('loan_income').select('*').eq('contact_id', cid)

// admin/lead-detail.html:28719
.from('loan_borrowers').select('*').eq('contact_id', cid).limit(1).maybeSingle()
```

Opened on Daniel, those return **his** rows only — 2 liabilities, his income, one
`loan_borrowers` row. America's sit on her contact and never appear.

The 1003 liabilities panel is the exception and already solves it (`:26988`):

```js
const { data: lbRows } = await _authClient().from('loan_borrowers')
  .select('contact_id').eq('application_id', appId);
contactIds = Array.from(new Set([contactId, ...extra]));
…
_liabQuery = _combined ? _liabQuery.in('contact_id', contactIds)
                       : _liabQuery.eq('contact_id', activeCid);
```

So **the fix for "three liabilities in the file, two in the CRM" is a UI
question, not an importer one** — and one panel already has the pattern the
others need.

## 4. The three liabilities — no threshold, all three imported

There is **no amount threshold anywhere.** The only parser filter is
`LIABILITY_SUMMARY` (`:434-435`):

```ts
const liabilities = tbAll(liabSection,'LIABILITY')
  .filter(l => !l.includes('LIABILITY_SUMMARY'))
```

File: **3 `LIABILITY` blocks + 1 `LIABILITY_SUMMARY`**. Database: all 3 present.

| owner | creditor | balance | payment |
|---|---|---|---|
| Daniel Garcia | SNAP-ON CREDIT LLC | 8322 | 218 |
| Daniel Garcia | JPMCB CARD | 1251 | 40 |
| **America Jaimes** | **BANK OF AMERICA** | **57** | **25** |

`combined_monthly_debt = 283` = 218+40+25, so all three were counted. BofA was
correctly attributed to her by the `RELATIONSHIP` arc and is invisible on
Daniel's page for the reason in §3. **Not a second bug.**

The one real skip condition is a dedup on account number (`:770-774`), which did
not fire here.

## 5. Which fields the employment mapper reads — and why the blob is empty

`parseParty`, `:213-227`, reads from each `EMPLOYER` block:

| target | MISMO element |
|---|---|
| `employer_name` | `extractEmployerName(emp)` |
| `employer_phone` | `ContactPointTelephoneValue` |
| `employer_street/city/state/zip` | `ADDRESS` → `AddressLineText`, `CityName`, `StateCode`, `PostalCode` |
| `position_title` | `EmploymentPositionDescription` |
| `employment_start_date` | `EmploymentStartDate` |
| `base_income` | `EmploymentMonthlyIncomeAmount` |
| `is_self_employed` | `EmploymentBorrowerSelfEmployedIndicator` |
| `months_in_line_of_work` | `EmploymentTimeInLineOfWorkMonthsCount` |

All of these landed for Daniel: title `Mechanic`, start `2017-01-03`, state `CA`,
zip `90670`, `months_in_line_of_work` 114.

`base_income` is null for **both** borrowers, and that is correct for this file:
`EmploymentMonthlyIncomeAmount` appears **once** in the whole document (4469, on
America's *previous* employment, which is why it landed as `prev_monthly_income`).
This file carries income in `CURRENT_INCOME_ITEM`, not on the employment.

**The empty `title` / `start_date` / `state_zip` are in a different structure.**

## 6. The `employments` blob — MISMO never writes it

`mortgage_applications.employments` currently holds ONE entry, Daniel's:

```json
{ "base": "5822.38", "bonus": "2754.42", "overtime": "346.78",
  "employer": "TOM'S TRUCK CENTER NORTH COUNTY, LLC", "city": "SANTA FE SPRINGS",
  "title": "", "start_date": "", "state_zip": "", "commission": "",
  "hr_first": "", "hr_last": "", "employer_email": "", … }
```

```
$ grep -n "employments" supabase/functions/mismo-import/index.ts
  (no match)
```

**`mismo-import` never reads or writes this column.** It is written by the 1003
employment editor in `admin/lead-detail.html` and read by the `voe-form-fill`
edge function — the only two files in the tree containing `state_zip`.

That accounts for every oddity in it:

- **Different shape.** `state_zip`, `hr_contact`, `years_work`, `commission`,
  `employer_email` are form fields, not MISMO elements.
- **Different casing.** `TOM'S TRUCK CENTER NORTH COUNTY, LLC` / `SANTA FE
  SPRINGS` in the blob vs `Tom's Truck Center North County, L` / `Santa Fe
  Springs` in `loan_borrowers` — two different capture paths.
- **Different numbers.** base 5822.38 / bonus 2754.42 / overtime 346.78 match
  neither the file (5858.67 / 4260) nor `loan_income`, because nothing has ever
  synchronised them.
- **Empty title/start_date/state_zip** — never typed in.

**Is MISMO supposed to overwrite them?** Today it does not, and there is no code
that ever intended to. The decision to make is whether it should, and it is a
real decision rather than an oversight to correct:

- **`voe-form-fill` reads this blob**, so the VOE sent to an employer is built
  from hand-entered figures that a MISMO import will never correct. That is the
  consequential half — a stale blob becomes a document sent to a third party.
- Overwriting it would discard hand-captured fields MISMO does not carry at all
  (HR contact, employer email, commission).
- It holds **one** entry for a two-borrower file, so the co-borrower has no
  employment in the structure the VOE is built from.

## 7. The one real bug: `loan_income` is append-only with no dedup

`:660` (primary) and `:704` (co-borrower) are plain inserts — no delete, no
`onConflict`, no existence check:

```ts
for (const row of (primary.incomeRows||[])) {
  const { error: incErr } = await sb.from('loan_income').insert({
    ...row, application_id:primaryAppId, contact_id:primaryCId,
    income_owner:primaryFullName, …
  });
  if (incErr) console.log('[mismo] primary income insert:', incErr.message);
}
```

**This is not append-only by design.** The same function dedups liabilities
twenty lines later (`:770`, on `account_number`). The author considered
duplicate-suppression for one child table and not the other; income was missed.

Current state — six rows where the file has three:

| owner | type | amount | created |
|---|---|---|---|
| Daniel Garcia | Base | 5858.67 | 2026-07-15 |
| Daniel Garcia | Base | 5858.67 | 2026-08-19 |
| Daniel Garcia | Bonus | 4260 | 2026-07-15 |
| Daniel Garcia | Bonus | 4260 | 2026-08-19 |
| America Jaimes | Base | **4106.27** | 2026-07-15 |
| America Jaimes | Base | **4680** | 2026-08-19 |

**The last pair is the sharper problem and is not a duplicate — it is a change.**
Her income went 4106.27 → 4680 between imports and **both rows are
`is_active = true`**. A duplicate is obvious on screen; a superseded-but-active
figure is not, and any sum over active rows is wrong in a way that looks
plausible. Summing the table gives 28,923.61 against a true 14,798.67.

`combined_monthly_income` on the application is correct (14,798.67) because it is
computed from the in-memory parse, not from the table — so the header and the
income panel disagree, and the header is the one that is right.

### Why delete-then-insert is not the obvious fix

`loan_income` also holds **hand-entered** rows (the LOS income editor at
`:30919` inserts, `:30905` updates). A blanket
`delete where application_id = … and contact_id = …` before re-inserting would
destroy manually captured income that MISMO never carried. The narrow version —
delete only `where source = 'mismo'` — is the shape that matches how liabilities
are already handled, and is what I would propose.

---

## Summary of what is actually broken

1. **`loan_income` duplicates on re-import**, and worse, keeps a superseded
   figure active alongside the new one. Real bug, in the importer. Fix scoped to
   `source = 'mismo'`.
2. **Lead-detail panels are single-contact scoped**, so a co-borrower's income,
   liabilities and borrower row are invisible on the primary's page. Real gap, in
   the UI. The 1003 liabilities panel already has the multi-contact pattern.
3. **The `employments` blob is disconnected from MISMO and feeds `voe-form-fill`.**
   Not a bug in the importer — an unowned seam, and the one with an outward-facing
   consequence.

Nothing here required re-running the import, and `mismo_raw_xml` is intact
(43,793 bytes) if a re-parse is wanted once a fix lands.

# `borrower_qualifying_snapshot` attributes income to the wrong borrower

Report only. Nothing changed. This survives the duplicate fix — it is a separate
defect and it is outward-facing, because `sms-assistant` answers from this view.

## The cause, in two lines of the view

```sql
income_agg AS (
  SELECT li.application_id, sum(li.monthly_amount) AS total_documented_monthly, …
  FROM loan_income li WHERE li.is_active = true
  GROUP BY li.application_id                                  -- ← grain: APPLICATION
),
classified AS (
  SELECT c.id AS contact_id, …
  FROM contacts c
    LEFT JOIN income_agg ia ON ia.application_id = c.linked_application_id   -- ← join key
)
```

**Income is aggregated per APPLICATION and then attached per CONTACT.**
`loan_income.contact_id` exists, is populated, and is never used by this view.

That produces two independent faults.

### Fault 1 — wrong grain: whoever is linked gets the whole household

Any contact whose `contacts.linked_application_id` matches receives the **entire
application's** income under their own name. It is a household figure wearing an
individual's label.

If both borrowers were linked, **both** would report the full household total, and
adding them would double-count. Today only one is linked per application, which
masks that.

### Fault 2 — `linked_application_id` is unset on the primary

```
Daniel Garcia   (primary)     linked_application_id = NULL   → LEFT JOIN misses → COALESCE(…,0)
America Jaimes  (co-borrower) linked_application_id = 737a7f06…
```

Daniel owns **two** active income rows totalling **10,118.67** and the view reports
him at **$0**. America owns **4,680** and the view reports her at **14,798.67**.

`sms-assistant` `query_loan_income` looks a borrower up **by name**. Asked about
the primary borrower on this file, it answers **zero income, $0 max PITI**.

## Scale — 8 of 12 contacts with income are misreported

| | count |
|---|---|
| contacts owning active `loan_income` rows | 12 |
| **report $0 despite having income** | **5** |
| **report the household under one name** | **3** |
| correct (single-borrower applications) | 4 |
| applications claimed by more than one contact | 1 |

**Reported as $0 while actually earning:**

| borrower | own income | view says |
|---|---|---|
| Daniel Garcia | 10,118.67 | 0 |
| Vincent Solis | 8,840.00 | 0 |
| Sean Lee | 6,875.00 | 0 |
| Aned Mendoza | 4,353.40 | 0 |
| Jose Navarro | 2,798.00 | 0 |

**Reported as the household:**

| borrower | own income | view says |
|---|---|---|
| America Jaimes | 4,680.00 | 14,798.67 |
| Jenny Liao | 6,486.00 | 13,361.00 |
| Santana Navarro Rosales | 4,623.53 | 11,774.93 |

The four correct ones are correct only because their applications have a single
borrower — the bug cannot show itself there.

## Which way is wrong is not obvious, and that is the design question

The over-reporting rows are not simply "wrong". A household total is the right
input for a **DTI** question and the wrong answer to a **"what does this person
earn"** question. The view answers both from one column, so it cannot be right for
both. What is unambiguously wrong is:

- attaching a household aggregate to **one** contact's name, and
- returning **$0** for a borrower who has income.

## Fix direction

The data already supports it — `loan_income.contact_id` is populated on every row,
including the co-borrower rows the MISMO importer writes.

1. **Group `income_agg` by `(application_id, contact_id)`** and join on
   `contact_id`, so each borrower reports their own income. This alone fixes both
   faults: the primary stops depending on `linked_application_id`, and the
   household stops being attributed to one name.
2. **If a household total is wanted, add it as a separate, clearly named column**
   (`household_documented_monthly`) computed at the application grain — never as
   the same column under a person's name.
3. `contacts.linked_application_id` being NULL on primaries is worth understanding
   independently, but step 1 removes this view's dependence on it.

Do not fix this by backfilling `linked_application_id` on the primaries. That
would swap "$0" for "the household total" on five more contacts — turning a
visibly wrong answer into a plausibly wrong one, which is worse.

## Related

- `docs/DTI-EXPOSURE-FROM-loan_income-2026-08-20.md` — the duplication bug, now
  corrected. This view picked the correction up automatically because it filters
  `is_active`.
- `docs/OPEN-DECISION-employments-blob-vs-mismo-2026-08-20.md` — same family: a
  per-application structure standing in for per-borrower facts.

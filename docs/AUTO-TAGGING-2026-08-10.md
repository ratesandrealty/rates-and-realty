# Auto-tagging email threads onto leads — recommendation, 2026-08-10

**Read-only. Nothing here was built.** The brief asked what exists beyond manual
`email_thread_tags` and `matchContact`, where auto-tagging would run, whether
`property_address` / `loan_orders.reference` / `loan_number` are safe to match
on, and whether any of it needs a model.

The short answer is that the question has a different shape than expected:
**auto-tagging is not a feature to be added. It already exists, it is already
doing effectively all of the filing, and nobody is watching it.**

---

## 1. The finding that reframes the rest

`lead_email_threads(p_contact_id)` — what the lead page shows as filed mail —
reads **`email_log.contact_id`**. It does not read `email_thread_tags` at all.

| | |
|---|---|
| threads filed on some lead | **199** |
| of those, with a manual `email_thread_tags` row | **1** |
| filed with no human involvement whatsoever | **198 (99.5%)** |

`email_thread_tags` has **one row in the entire database.**

So the manual tagging feature is, in practice, unused, and every "filed" thread
on every lead page got there from `gmail-inbox::matchContact`. A recommendation
about *adding* automatic tagging would be describing something already in
production.

Two comments in the repo disagreed about which table backs this list. The one in
`lead-detail.html` that said `email_thread_tags` was wrong; it has been
corrected, and the section heading changed from "Tagged to this lead" to **"Filed
on this lead"** — calling an unreviewed automatic match a tag credits a human
decision that did not happen.

## 2. What `matchContact` actually does

`supabase/functions/gmail-inbox/index.ts:325`. Two rules, first hit wins, over
every participant address on the thread:

1. **address → contact.** `contacts.email` or `secondary_email` matches
   (`ilike`). Exact, case-insensitive, safe.
2. **address → vendor → borrower.** The address matches
   `vendor_directory.email`; take that vendor's **most recent `loan_order`** and
   file the mail on its borrower.

It runs on `get_thread` — i.e. **when a human opens the thread** — and on send.

**Rule 2 is the false-positive risk the brief was worried about, and it already
ships.** An escrow officer or appraiser works several of our files. Their most
recent order decides where their mail lands, regardless of who the mail is
about. One vendor with two active borrowers files onto the wrong one roughly
half the time, silently, with no marker distinguishing it from a human's
decision. This is the "another borrower's mail on someone's loan file" failure,
in production, today.

It is also worth noting rule 2 writes to `email_log.contact_id`, which is what
the lead timeline reads. A wrong match is not a cosmetic mislabel — it puts
another borrower's correspondence into a loan file.

## 3. The proposed identifiers do not exist yet

Measured, not assumed:

| identifier | populated rows | verdict |
|---|---|---|
| `loan_orders.reference` | **0** | nothing to match on |
| `mortgage_applications.loan_number` | **0** | nothing to match on |
| `contacts.loan_number` | **2** (of ~1042) | and see below |
| `contacts.property_address` | **22** (of ~1042) | ~2% coverage |

`loan_orders.reference` is empty because the escrow-number field is still
unbuilt — it is a *consequence* of pending work, not a data problem.

**The two `loan_number` values are the argument against matching on them.** One
is **three characters long and all digits.** A `LIKE '%<loan_number>%'` on a
three-digit string matches a dollar amount, a street number, a date, a phone
fragment, an order id — in any email in the mailbox. There is no threshold that
makes a 3-character numeric token a safe identifier. If loan numbers are ever
matched on, the rule must require a **minimum length and a format** (say ≥6
characters with at least one non-digit, or a fixed prefix), and skip anything
that does not qualify rather than doing its best.

## 4. Which parts are a query, and which genuinely need a model

The brief's instinct is right, and stronger than stated: **none of this needs an
AI call per inbound email.**

**Exact, do it in SQL — no model:**
- participant address → contact. Already built (rule 1). Correct.
- a well-formed escrow/loan reference appearing in subject or body. This is a
  regex extract plus an equality join, not a similarity problem. It needs the
  field populated and a format rule first (§3).

**Fuzzy, and still does not need a model:**
- property address. The variance is formatting, not meaning — "1742 W Ave L" vs
  "1742 West Avenue L" vs "1742 W. Avenue L, Lancaster CA 93534". That is
  **normalisation**, solved by lowercasing, expanding a fixed abbreviation table
  (W→west, ave→avenue, st→street, apt/unit/#), stripping punctuation, and
  comparing the normalised strings — or `pg_trgm` similarity with a high
  threshold if partial credit is wanted. A language model would be a slower,
  more expensive, less predictable version of a lookup table, and would give a
  different answer to the same input on different days.
- At 22 populated addresses, this rule would reach 2% of the book anyway. It is
  not worth building until `property_address` is routinely populated.

**Genuinely needs judgement (and therefore should NOT auto-file):**
- "this thread is *about* the Hurle loan" with no address, no reference and no
  known participant — inferred from prose. This is the only case a model would
  add anything to, and it is precisely the case where being wrong is worst and
  confidence is lowest. A model here should at most **suggest**, never write.

The dividing line worth keeping: **a rule may file automatically only when it
can state the exact token it matched.** If the evidence cannot be quoted back to
the user, it is a suggestion, not a filing.

## 5. Where it should run

Not on `get_thread`. Filing only when a human happens to open a thread is why
this is invisible — the mail that most needs filing is the mail nobody opened.

Recommended shape, in order of value:

1. **Fix rule 2 before adding anything.** A vendor match should file only when
   the vendor has exactly **one** plausible open order, and otherwise record a
   *suggestion*. This removes an active source of wrong filings and costs
   nothing but a count.
2. **A sweep, not an ingest hook.** A pg_cron job over recent `email_log` rows
   with `contact_id is null`, applying the exact rules. Idempotent, re-runnable,
   and its output is inspectable before anyone trusts it — unlike a hook that
   has already written by the time you look. Dry-run it into a table first and
   read the proposed matches.
3. **On demand from the lead page** for the "find mail for this borrower" case —
   which the new `[ This borrower ]` toggle already covers by searching rather
   than filing, and searching is the safer default because it writes nothing.

## 6. Provenance and reversibility — the prerequisite, not the polish

The brief asked that auto-tags be visually distinct from manual ones and
reversible. **Neither is possible today**, and that gap predates any new work:
`email_log.contact_id` is a bare uuid. It records no actor, no rule, no matched
token, and no timestamp of the match. A human's decision and rule 2's guess are
the same value in the same column.

So the first change in any of this is not a matcher. It is:

- **`email_log.match_source`** — `'human'`, `'address'`, `'vendor'`,
  `'reference'`, `'address_norm'` — and **`match_evidence`** holding the literal
  token matched. Backfilling is not possible for the existing 199; they can only
  be marked `'unknown'`, honestly.
- `lead_email_threads` returns both, so the UI can mark an automatic filing
  differently from a chosen one. Until it does, any distinction in the UI would
  be invented.
- **Unfile must clear the same row and record that it was cleared**, or the next
  sweep re-files what somebody just rejected. A reversal that the matcher cannot
  see is not a reversal.

## 7. Recommendation, in order

1. Add `match_source` + `match_evidence` and surface them. Nothing else should
   be built first — without provenance, every later rule is unauditable.
2. Narrow `matchContact` rule 2 to unambiguous vendors. This is a bug fix.
3. Populate `loan_orders.reference` (the escrow field, already specified) and
   define a format. Only then match on it, exact, no model.
4. Address normalisation only once `property_address` is routinely populated.
   Lookup table, not a model.
5. A model, if ever, produces suggestions on a review queue. It does not write
   `contact_id`.

**Not built. No schema changed, no function deployed, nothing backfilled.**

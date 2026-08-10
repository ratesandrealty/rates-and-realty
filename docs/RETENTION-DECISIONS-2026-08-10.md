# Retention & compliance decisions — 2026-08-10

**Decision-maker for every item below: Rene Duarte**, who holds decision authority
on these. Recorded 2026-08-10.

These were open because nobody could tell, from the data alone, which of two
opposite handlings was correct. They are now closed by decision rather than by
discovery — which is a different thing, and the "what would reverse this" line on
each entry is there because a decision made without the missing fact should be
revisited if the fact arrives.

> **Count discrepancy, recorded rather than smoothed over.** The instruction
> referred to *six* compliance items and enumerated *five*. Five are recorded
> below. The sixth was not named and has NOT been invented — if there is one, it
> is still open and unrecorded. Candidates from this session's work that were
> never given a decision: the seven April–May contact deletions that made the
> `delete-contacts` audit gap unanswerable.

---

## 1. Twelve orphaned borrower files — **RETAIN**

**Decision.** Retain. Move under an `orphaned/` prefix rather than deleting.

**Why.** It cannot be established whether these came from an erasure request or
from ordinary CRM cleanup. The two readings call for opposite handling, and the
data cannot distinguish them. Retention is the reversible option: a file kept can
still be deleted once the answer is known; a file destroyed cannot be restored,
and its destruction also destroys the evidence of what it was.

**What would reverse it.** A confirmed erasure request covering any of these
files. Then deletion becomes not merely permitted but required, and it must be
recorded as fulfilment of that request — not as tidying.

---

## 2. Twenty-five orphan database rows — **RETAIN**

`loan_liabilities` 14 · `loan_scenarios` 7 · `loan_income` 3 ·
`lender_submissions` 1. From seven contacts deleted before 2026-06-19.

**Decision.** Retain, untouched.

**Why.** Identical reasoning to item 1, with a sharper edge: these rows carry
residual creditor account numbers. If any of those seven deletions was an erasure
request, those account numbers are precisely what the request was meant to
remove, and deleting them now without recording it as fulfilment would leave no
trace that the obligation was ever met. If it was CRM tidying, they are dead
weight and can go later at no cost. Same rows, opposite handling.

**What would reverse it.** The same answer as item 1, per contact.

**Consequence, and it is not incidental.** These rows are what block
`supabase/sql/STAGED_contact_fk_hardening_20260804.sql`: `ADD CONSTRAINT`
validates existing rows, so a constraint covering an orphaned table aborts.
Retaining them means that file cannot be applied *in full*. See the split
analysis appended to this document.

---

## 3. Eight historical e-sign records — **LEAVE AS EMAIL COPIES. DO NOT REGENERATE.**

**Decision.** The eight signature requests without a stored record PDF stay as
they are. The signed documents exist as email copies. Do not run a regeneration.

**Why.** A regenerated PDF is not the document that was signed — it is a document
produced later that resembles it. For a legally significant artefact that
distinction is the whole point, and an email copy contemporaneous with the
signature is better evidence than a fresh render dated 2026.

**THE TECHNICAL REASON A BLANKET REGENERATION IS DANGEROUS — verified, not
assumed.** `supabase/functions/esign-docs/index.ts` uploads with
**`upsert: true` on all seven upload paths**, including the one writing to an
`existing.storage_path` (line 156). So a regeneration run scoped by anything
broader than "only the eight with no PDF" would **overwrite the four
contemporaneous originals in place**, with no version history and no undo. The
four good records are at risk from the fix, not from the gap.

**What would reverse it.** A specific legal or investor request for a
regenerated record on a named file — handled one at a time, never as a sweep, and
never touching a request that already has a stored PDF.

---

## 4. Call recording — **PROCEED**

**Decision.** Proceed. Playback stays admin-only. The recording announcement
remains live.

**Why.** The disclosure is given and its ordering is verified: Twilio documents
`record-from-answer` and `record-from-answer-dual` with the identical trigger,
and this was checked against the recordings themselves — no transcript contains
the disclosure text, which it would if capture began before the whisper finished.
Access is controlled by column grants rather than RLS, because `calls_log` RLS is
`authenticated USING (true)`: `transcript`, `ai_summary` and `transcript_sid` are
not granted to `authenticated`, so reads go through `call-intelligence`, which is
admin-only.

**What would reverse it.** The announcement failing or being removed on any dial
path; a non-admin route to transcript or recording content appearing; or
single-party-consent assumptions ceasing to hold for a jurisdiction being called.

---

## 5. Legal inventory — **NOT CLOSED. REMAINS OPEN.**

**Decision.** Explicitly *not* closed, and explicitly not closable by the
authority that closed items 1–4.

**Why.** The open finding is incomplete consumer disclosures. That is not a
records-retention judgement, and delegated decision authority over retention does
not extend to it — an incomplete disclosure is not resolved by someone deciding
it is acceptable. It needs the disclosure completed, or a determination from
counsel or the sponsoring institution that the current form suffices.

**What would close it.** Completed disclosures, or a written determination from E
Mortgage / counsel. Not a decision recorded here.

---

## Related, still blocked elsewhere

- The three uncaptured Postgres functions and the merge-catalogue blind spot are
  engineering items, not compliance ones, and are tracked in `CLAUDE.md`.
- Items 1 and 2 share a single unanswered question — the disposition of seven
  contacts deleted before 2026-06-19. One answer closes both.

---

# Appendix — staged FK file: the split (read-only, 2026-08-10)

Because items 1 and 2 are RETAIN, the staged file cannot be applied in full. The
question is how much of it CAN be, and the answer was measured live rather than
read off the file's own header — which turns out to be out of date.

## 20 of 26 constraints would apply cleanly

Zero orphans, so `ADD CONSTRAINT` validates: `bot_queued_replies`,
`campaign_recipients`, `cma_snapshots`, `condition_attachments`,
`contact_financials`, `contacts.primary_borrower_contact_id`,
`email_link_clicks`, `email_thread_tags`, `fee_sheet_drafts`,
`fee_sheet_snapshots`, `listing_alert_sms_queue`, `loan_assets`,
`loan_borrowers`, `loan_reo`, `order_documents`,
`processing_items.related_contact_id`, `property_estimates`, `tracked_links`,
`videos`, `web_events`.

## 6 would abort — not 4

| table | orphans | in the file's header? |
|---|---|---|
| `loan_liabilities` | 14 | yes |
| `loan_scenarios` | 7 | yes |
| `loan_income` | 3 | yes |
| `lender_submissions` | 1 | yes |
| **`app_notifications`** | **1** | **NO** |
| **`esign_documents`** | **1** | **NO** |

**27 orphan rows across 6 tables, not 25 across 4.** The staged file's blocker
list was written 2026-08-04 and has not kept up.

The two extra rows are **not** from the seven contacts the retention decision
covers — different dangling contact ids entirely:

- `app_notifications` → contact `414506db…`, row created **2026-08-06**
- `esign_documents` → contact `7d9c0291…`, row created **2026-06-19**

So orphans are still being created, after the date the file was staged. That is
the finding: this is not a fixed set of 25 rows awaiting a decision, it is an
ongoing leak with no constraint to stop it — which is precisely what the file
exists to fix, and precisely why leaving it staged has a running cost.

## What this means for applying it

Applying the 20 clean constraints closes most of the merge-catalogue blind spot
— `contact_merge` discovers its work from foreign keys, so those 20 tables would
become visible to it — while leaving every retained row untouched. `videos` and
`property_estimates`, the two tables that actually held rows the 2026-08-08
merges missed, are both in the clean 20.

**Not applied. Awaiting approval, with the corrected split: 20 clean, 6 aborting.**

The two newly-found orphans need their own disposition. They are not covered by
the retention decision above, because that decision named seven specific
contacts and these are two others.


---

# APPLIED 2026-08-10 — 20 constraints in, 6 pending

Approved by Rene on the corrected 20/6 split. Migration
`contact_fk_hardening_clean_20`.

**Result:** FKs to `contacts` went 80 → **100** (65 cascade, 30 set null), and
`contact_fk_catalogue` now has **97 entries**. `videos` and
`property_estimates` — the two tables whose rows the 2026-08-08 merges actually
missed — are now in the catalogue, so a future merge repoints them automatically.

`ON DELETE` semantics were taken verbatim from the staged file, which had
reasoned about each: **cascade** where the row is part of the contact's working
set, **set null** where the row records OUR activity and should outlive the
contact.

## The 6 still pending, and why

**Covered by the retention decision (items 1–2 above) — do not apply until the
disposition of the seven pre-2026-06-19 deletions is known:**

| constraint | orphans |
|---|---|
| `loan_liabilities_contact_id_fkey` | 14 |
| `loan_scenarios_contact_id_fkey` | 7 |
| `loan_income_contact_id_fkey` | 3 |
| `lender_submissions_contact_id_fkey` | 1 |

**NOT covered by any decision — these need their own:**

| constraint | orphans | dangling contact | row created |
|---|---|---|---|
| `app_notifications_contact_id_fkey` | 1 | `414506db…` | 2026-08-06 |
| `esign_documents_contact_id_fkey` | 1 | `7d9c0291…` | 2026-06-19 |

Different contact ids from the seven. The retention decision names seven specific
contacts and these are two others, so it does not reach them.

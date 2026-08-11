# Contact merge — 2026-08-08

Four duplicate pairs merged. The tool is new, it is reversible, and **the read
filter is deliberately NOT applied yet**. Read the last section before touching
anything that queries `contacts`.

---

## The four merges

All four ran through `contact_merge(survivor, loser)`. Survivor first.

| pair | survivor | loser | moved | skipped |
|---|---|---|---|---|
| Andrea Cruz | `360640e0-0647-4078-ae55-a8b089dbeed2` | `418759bc-e256-4020-8fe5-a34870365b52` | 73 | 0 |
| Patricio Garces | `b5595809-5fad-40af-bcff-4561a661f437` | `45c01210-ab6c-4628-a805-28db7cea6ac2` | 68 | 0 |
| Moris Villalobos | `17a72222-4237-4773-b265-93f51ca355bb` | `396f0fbd-a703-44b9-8eea-a2ed2e20ca34` | 74 | 0 |
| Rene Duarte | `ce753903-c858-4ab3-b7a9-70697e06469f` | `93724c8a-8e26-453d-bf1c-7a335fc9845e` | 268 | **27** |

Snapshots: `merge_snap_contacts_20260808`, `merge_snap_census_20260808`. Every
merge is individually reversible via `contact_merge_undo(<merge_id>)`, which
restores both contact rows byte-identically and repoints every recorded child
row. Merge ids are in `contact_merges`.

**Rene's survivor was corrected during investigation.** The original instruction
had `93724c8a` surviving. The data was one-sided the other way: `ce753903` holds
the mortgage application, the `application_ssn` row, the portal login, the
documents, 33 loan conditions, the Drive folder, the ClickUp linkage and
Alexander Duarte's co-borrower link. `93724c8a` had 223 `email_log` rows and
little else.

### DO NOT MERGE — decided, not pending

- `2139100517` Salvador Alvarez / Kenia Lara Cazares — different people, shared
  household number.
- `7142965496` Jose Ibarra Padilla / Joe Padilla — two names, two unrelated
  mailboxes (`enedinaibarra06@` vs `joe.padilla714@`), one shared number. Moved
  out of the merge list during investigation.
- `2133214747` Roberto Alvarez / Roberto Almaraz — **not yet inventoried.** Next
  session starts here.

---

## The tool

`contact_merge_preview(survivor, loser)` · `contact_merge(survivor, loser, actor)`
· `contact_merge_undo(merge_id)` · view `contact_fk_catalogue`
· tables `contact_merges`, `contact_merge_moves`

Captured in `supabase/sql/db-functions/`. Not exposed to `anon` or
`authenticated` — `revoke all` on both mutating functions.

**Catalogue-driven.** `contacts.id` has **80** foreign-key references. Every one
is discovered from `information_schema` at run time, so a table added later is
covered without anyone remembering. Two tables the original hand-written list
missed — `appointments` and `processing_items` — turned up in Rene's census
purely because the catalogue found them.

**Repoint, never delete.** The loser is soft-deleted via
`merged_into_contact_id` + `merged_at`, per `PROJECT-soft-delete-contacts.md`.
Nothing cascades, nothing orphans.

**Per-row repointing, not bulk UPDATE.** Two tables use `contact_id` as their own
primary key (`contact_ssn_last4`, `lead_share_nudges`) and five have a UNIQUE FK
to contacts. A bulk `UPDATE` aborts the whole merge on one collision; per-row
records the collision and carries on. A skipped row stays on the loser —
visible, recorded with its reason in `contact_merge_moves`, never lost.

---

## Three defects found while building, all fixed

### 1. The Drive-folder trigger — caught on the fixture, not on a borrower

The merge advances the survivor's `pipeline_status` when the loser is further
along. On the fixture that fired `trg_borrower_foldering_upd`
(`WHEN old.pipeline_status IS DISTINCT FROM new.pipeline_status`), which posted
to the n8n foldering webhook, which **created a Google Drive folder** and wrote
its id back.

So the merge touched Drive — not in its own code, through a trigger its own
`UPDATE` fires — and `contact_merge_undo` **cannot** remove it, because the
folder is rene@-owned and the service account cannot trash it. A merge that
leaves an unremovable artefact is not reversible, whatever the row proof says.

**Fix:** `notify_borrower_foldering()` now returns early when
`current_setting('app.suppress_foldering', true) = 'on'`, and both
`contact_merge` and `contact_merge_undo` set that flag with
`set_config(..., is_local => true)` — transaction-scoped, so it dies with the
transaction. **Not** `ALTER TABLE ... DISABLE TRIGGER`, which takes an
`ACCESS EXCLUSIVE` lock and would also silence a concurrent unrelated write.

The status change is still written to `pipeline_stage_history`, so a human can
see the advance and create the folder deliberately if it is wanted.

*Residue:* the first rehearsal left a real folder,
`1LNgsaw8KZoM-VDAhDfmughgg2Hd7YCsj`, for a now-deleted ZZ-TEST fixture.
rene@-owned, so it is a Drive-UI cleanup job.

### 2. `lofty_id` / `crm_id` — unique columns in the field merge

The blanket field merge did `col = coalesce(survivor.col, loser.col)` across
every column. `contacts` has two single-column UNIQUE indexes besides the primary
key, and copying the loser's value onto the survivor **while the loser still held
it** raised:

```
23505 duplicate key value violates unique constraint "contacts_lofty_id_uniq"
      Key (lofty_id)=(1137264415501633) already exists
```

This failed on Patricio, the second real merge, and **rolled back atomically** —
nothing was half-applied.

`crm_id` has the same constraint and did not raise **only because the survivor
already had one**, so `coalesce` kept the survivor's. That was luck, not
correctness: a survivor with a null `crm_id` fails identically.

**Fix:** unique columns are discovered from `pg_index` (not hand-listed),
excluded from the blanket coalesce, and transferred explicitly — **clear on the
loser first, then set on the survivor**, and only when the survivor has none.
Order matters; the reverse raises `23505`. Still reversible, because the loser's
original value is in the merge snapshot.

### 3. The composite-unique blind spot in the preflight

Before Rene's merge a preflight predicted **one** skip (`contact_intelligence`).
The merge recorded **27**.

The preflight looked for single-column unique indexes (`indnatts = 1`) and so
missed `processing_items_template_uniq`, a **composite** unique index that
includes `contact_id`. Both contacts carry the same 26 standard processing-item
templates, so all 26 collided.

**The tool behaved correctly** — it recorded 27 skips with reasons and moved the
other 268. The preflight was wrong, not the merge. A future preflight must look
at composite unique indexes containing the FK column, not just single-column ones.

---

## Rene's recorded skips — benign, and why

| table | rows | reason |
|---|---|---|
| `processing_items` | 26 | `processing_items_template_uniq` — both sides hold the same standard checklist |
| `contact_intelligence` | 1 | `contact_intelligence_contact_id_key` — one AI summary per contact, both had one |

Nothing was lost. Both stay attached to the loser, which is **retained** (soft
deleted). The survivor keeps its own checklist and its own summary, both of which
are the current ones. `contact_intelligence` is derived data and regenerable.

Verified after Rene's merge: `portal_users` repointed (1 on survivor, 0 on
loser) and **not deleted**; `application_ssn` moved; Alexander Duarte
(`9b251094`) still resolves to `ce753903` with `is_co_borrower = true`;
`secondary_email` carries `reneduarte.homeside@gmail.com`; `lofty_id`
transferred; **no Drive folder created** on any of the four survivors.

---

## ~~THE READ FILTER IS NOT APPLIED~~ — SUPERSEDED 2026-08-10

> **This section is history.** The filter was applied on 2026-08-10; see
> "THE READ FILTER IS COMPLETE" below. The map and the rule in this section are
> still the reference for WHICH surfaces filter and which do not — that is why it
> is kept rather than deleted. Only the "not applied" status is out of date.

Four merged-away contacts still appear everywhere:

```
418759bc   Andrea Cruz
45c01210   Patricio Garces
396f0fbd   Moris Villalobos
93724c8a   Rene Duarte
```

This is **deliberate**. Rene's reasoning: the filter is a wide change across
every surface that reads contacts, and *miss one path and a merged borrower
reappears; over-apply it and live contacts vanish from a count nobody checks
daily.* Four named ghosts are the cheapest probe for finding the read paths.

**Scale of the change:** 60 Postgres functions reference `contacts`, plus 67
code paths (52 edge functions, 15 frontend files).

### The distinction that matters — do NOT filter everywhere

| filter `merged_into_contact_id is null` | do NOT filter |
|---|---|
| people list + tab counts, search, export | `email_log`, `sms_log` — messages were genuinely sent to/from the old contact; filtering rewrites history |
| pipeline board and stage counts | `activity_events`, `calls_log`, `call_log` — same reason |
| `dashboard_snapshot`, `dashboard_command_center` | `audit_log`, `contact_merges`, `contact_merge_moves` — the merge record itself |
| campaign audience + `campaign-audience-resolve` | `pipeline_stage_history` — the historical stage of the old id is true |
| `power_dialer_queue`, `power_dialer_counts`, `dialer_sources_list` | `signature_signers`, `signature_requests` — signed documents name the id that signed |
| `va_dashboard`, `va_daily_tasks`, `va_processing_board`, `va_shared_leads`, `va_task_list` | anything reached *through* an explicit `contact_id` the user already chose |
| `recipient_search`, `email_recipient_search`, `esign_people_search` | `share_recipients` — CORRECTED 2026-08-10, see below |
| `partner_leads`, `partners_overview_all`, `partner_overview` | |
| `insights-data`, `production_report`, `pipeline_velocity_report`, `surface_stale_leads` | |
| `lead-scorer`, `proactive-followups`, `refi-watch` and other cron sweeps | |

### CORRECTION 2026-08-10 — the list above contradicted the rule below

`share_recipients` was in the FILTER column. It should not be. It is
`share_recipients(p_contact_id)` — a **by-id lookup**, returning the borrower and
attached partner for one contact the user already opened. The rule says never
filter those, and filtering it would blank the share panel on a merged contact's
page: the "becomes unreachable" failure, not the "disappears from a list" one.

**When the list and the rule disagree, the rule wins.** The list was written by
scanning names; the rule was written by thinking about what each surface answers.

### 2026-08-11 — the ghosts caught their first WRITES, and that is a new class

Everything before this was a read: a merged contact showing up in a list it
should have left. These are rows CREATED after the merge that point at a dead
id. The record is then not merely untidy — it is invisible, because every
surface that would display it filters the ghost out.

Both were the same one-line miss, in resolvers written after the sweep:

| path | what it wrote | why it missed |
|---|---|---|
| `twilio-voice` `resolveContactByPhone` | `calls_log` a9eec719 — a 35s recorded call on 93724c8a | added for dial-pad attach after the sweep; never got the filter |
| `gmail-inbox` `matchContact` | 3 `email_log` rows on 93724c8a, incl. an inbound lender message | matches on `email` OR `secondary_email` with an unordered `.limit(1)` |

**The phone one is worth reading twice, because the obvious diagnosis is wrong.**
The multi-match refusal was NOT broken. Survivor `ce753903` and ghost `93724c8a`
BOTH carry `7144728508`, so the resolver saw two exact matches and correctly
refused to guess. It then handed the choice to the dialer's attach panel — which
renders name plus `pipeline_status` and nothing else, by design, so Rene was
shown two rows both reading `Rene Duarte · New Lead` and picked the wrong one.

So the missing filter caused BOTH symptoms: it put a corpse in the picker, AND
it turned what should have been a clean single-match auto-attach into an
ambiguous choice a human could only get right by luck. With the filter there is
exactly one match and nothing is asked.

**The email one shows why `email_log` being in the do-NOT-filter column is not
the whole answer.** That column is about READING the table — history is true and
must not be rewritten. `matchContact` is not a read of history; it decides who a
message arriving TODAY attaches to. `reneduarte.homeside@gmail.com` is the
ghost's PRIMARY email and only the survivor's SECONDARY, so an unordered
`.limit(1)` across both picked the dead one every time.

**The rule that generalises:** a resolver that turns a phone number, an email
address or a name into an identity is a SEARCH, whatever table it ultimately
writes to. Filter it. The do-NOT-filter column covers by-id lookups of a contact
the user already chose, and rows that record something that genuinely happened to
the old id — not the act of choosing an id in the first place.

Full sweep of all 100 `contact_id` columns for rows created after the last merge
(2026-08-08 04:33Z) found exactly these: `calls_log` ×1, `email_log` ×3, and the
`activity_events` ×1 derived from the call by trigger. No other write path has
leaked. The four named ghosts earned their keep.

Repointed: `calls_log` a9eec719 → `ce753903`. The `calls_log_sync_activity`
AFTER UPDATE trigger MOVED the existing `activity_events` row (same id 7ca4d5c0,
`contact_id` rewritten) rather than inserting a second one — the `v_ae_id is
null` branch is what inserts, and it was not taken.

**But the trigger did NOT stamp the survivor**, and this is the part to remember
when repointing anything else. `tg_calls_log_advance_contact` gates its
`contacts` update on `v_first_contact` — INSERT with a contact, or UPDATE from
NULL to a contact. A ghost→survivor repoint is neither, so `last_contact_date`,
`last_meaningful_activity_at` and the New Lead → Contacted advance are all
skipped, and the stamp stays on the ghost where the misattach put it. Stamped
`ce753903` by hand afterwards. The ghost keeps its incorrect
`last_contact_date`; it is a tombstone excluded from every roster, and there is
no correct earlier value to restore.

Every other entry in the filter column was re-checked by signature on 2026-08-10.
Two more take a uuid and are NOT the same shape, so they stay in the filter
column: `partner_leads(p_partner_id)` and `partner_overview(p_partner_id)` take a
**partner** id and then enumerate contacts. The caller chose a partner, not a
contact, so the contact list is still a roster read. The distinction the rule
draws is "an explicit **contact_id** the user chose", not "takes an id".

Signatures as verified: `dashboard_snapshot()`, `dashboard_command_center()`,
`va_dashboard()`, `va_daily_tasks()`, `va_processing_board()`, `va_shared_leads()`
take no arguments; `va_task_list(p_include_completed)`,
`production_report(p_from,p_to)`, `pipeline_velocity_report(p_from,p_to)` and
`partners_overview_all()` take no contact. None is a by-id lookup. The list is
correct for all of them.

The rule of thumb: **filter anything that answers "who are my contacts now";
never filter anything that answers "what happened".** A merged contact must
disappear from lists, counts, audiences and dialer queues, and must remain in
every log of something that actually occurred.

`contacts_secure` is the intended enforcement point for the read half — it
already exists as the PII-hiding read path, so it is the one place that covers
many callers at once. It does not cover direct readers of `public.contacts`,
and there are many.

---

## THE READ FILTER IS COMPLETE — 2026-08-10

Every surface on the map above is now either filtered or **deliberately excluded
with a recorded reason**. Six batches, each run the same way: the surface's
PREDICATE was evaluated against the four ghosts *before* any change, because
every cap encountered turned out to be an unordered slice where observing results
proved nothing.

Two views carry most of it. `contacts_live` (raw) and `contacts_secure_live`
(masked) are `contacts`/`contacts_secure` minus merged rows. Roster reads —
counts, lists, audiences, dashboards, the people grid, its CSV export, the
pipeline board — select from those. **Neither replaces the by-id path**:
`contacts_secure` itself is unfiltered on purpose, because lead-detail loads a
contact through it by id and a merged contact must stay reachable by direct link.

### What was NOT filtered, and why

- **`share_recipients`** — see the correction above. By-id lookup.
- **`email_log`, `sms_log`, `calls_log`, `activity_events`, `signature_*`,
  `pipeline_stage_history`, `audit_log`** — history. Those things really happened.
- **The scheduled-send sweeps** (`send-scheduled-emails`, `send-scheduled-sms`) —
  they read `email_log`/`sms_log` queues, and a scheduled row carries a
  contact_id someone chose. There are zero scheduled rows of either kind today,
  so this is a rule decision rather than a live one. If one ever exists for a
  merged contact, fix it at the point of scheduling — filtering the sweep would
  silently drop a message someone deliberately queued.
- **By-id reads inside otherwise-filtered functions** — e.g. `lead-scorer`'s
  single-contact scorer, `people-admin`'s bulk actions taking an explicit
  `contact_ids` array. Dropping one of those silently would make the UI lie about
  what it just did.

### Surfaces that never leaked

Recorded because "we filtered it" and "it was leaking" are different claims:
`refi-watch` (no ghost is `deal_outcome='won'`), `loan-date-nudges` (no ghost has
a `loan_key_dates` or `loan_orders` row), `surface_stale_leads`, the five VA
functions (no ghost is shared with anyone), the three partner rollups (no ghost
has a `referral_partner_id`), `pipeline_velocity_report`, and both dashboards'
stage counts. Those got the filter defensively. The ones that genuinely leaked:
the people list, the two recipient searches, the whole dialer, the campaign
audience, `lead-scorer`, `proactive-followups`, `esign_people_search`,
`insights-data`, and the two dashboard totals.

### The visible proof

`total_leads` 1046 → 1042 and `new_leads` 1005 → 1001. **Stage counts do not
move** — all four ghosts are `New Lead`, so Active Pipeline, Pre-Approved,
Follow Up and Closed are unchanged. Anyone watching those tiles for evidence will
correctly see nothing.

---

## The one row the merge missed — and the blind spot it exposed

`contact_merge` is catalogue-driven off `contact_fk_catalogue`, which is built
from FOREIGN KEYS. **A table with a `contact_id` column and no FK constraint is
invisible to it.** That is not a bug in the merge; it is the cost of the design,
and it was assumed away.

Surveyed 2026-08-10: 44 tables carry a contact-ish column with no FK, but only
**two held rows still pointing at a ghost**, and only one mattered.

- **`videos`** — one row, a screen recording made for Rene on 2026-08-05, sitting
  on the id merged away three days later. **Repointed by hand to `ce753903` on
  2026-08-10, in one transaction that wrote the `contact_merge_moves` row BEFORE
  moving anything**, so a failed record aborts the move rather than leaving an
  unrecorded hand-edit. An `audit_log` row records it as
  `MANUAL_MERGE_REPOINT` with the reason.
- **`contact_earnings`** — 4 rows, one per ghost, all zero/zero, and all four
  survivors already have their own row. **Left alone.** Repointing would collide
  on the PK and destroy a survivor's row to gain nothing.

**`contact_merge_undo` replays from `contact_merge_moves`, NOT from the
catalogue** — verified in the function body before that row was moved, not after:

```sql
for r in select * from contact_merge_moves where merge_id = p_merge_id and moved ...
  execute format('update public.%I set %I = $1 where %I::text = $2', r.table_name, r.fk_column, r.pk_column)
```

So the hand-written record is replayed exactly like a catalogue-driven one, and
undo is correct again. Had it read the catalogue at replay time, the record would
have been decorative and the row should not have been moved.

### THE BLIND SPOT IS STILL OPEN

**The next merge will miss the same way.** Nothing has changed about how
`contact_fk_catalogue` is built. Any table that gains a `contact_id` without an FK
is invisible, and the survey above is a snapshot, not a guard.

- **What closes it:** `supabase/sql/STAGED_contact_fk_hardening_20260804.sql`,
  which adds the missing FKs so the catalogue sees those tables.
- **What blocks the staged file:** 25 orphan rows — `loan_liabilities` (14),
  `loan_scenarios` (7), `loan_income` (3), `lender_submissions` (1) — from 7
  contacts deleted before 2026-06-19. `ADD CONSTRAINT` validates existing rows,
  so they abort it. They carry **residual creditor account numbers**, which makes
  their disposal a **retention/erasure decision for E Mortgage, not technical
  work**. Deleting them so a constraint validates would resolve the question by
  destroying the evidence of it. Same question as the 12 orphaned borrower Drive
  files and the seven April–May deletions; one compliance answer unblocks all
  three.
- **What applying it would NOT do:** fix anything retroactively. The catalogue is
  read at merge time and the four merges already ran.

Until that answer arrives, merges must stay rare and hand-checked. **This is what
blocks any bulk dedupe.**

---

## Still open

- Inventory `2133214747` Roberto Alvarez / Roberto Almaraz. Report only.
- Retention decision on the 25 orphan rows — unblocks the staged FK file, which
  closes the catalogue blind spot above. Compliance, not engineering.
- Fix the preflight to consider composite unique indexes.
- Decide whether unique-FK collisions (`contact_intelligence`,
  `processing_items`) should be resolved rather than skipped.
- Trash the orphaned rehearsal Drive folder `1LNgsaw8KZoM-VDAhDfmughgg2Hd7YCsj`.

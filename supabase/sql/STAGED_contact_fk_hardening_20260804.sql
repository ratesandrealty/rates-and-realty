-- STAGED. NOT RUN. NOT A MIGRATION YET.
--
-- Deliberately in supabase/sql/, not supabase/migrations/, so `supabase db push`
-- cannot pick it up. Move it into migrations/ with a dated name only when the
-- open questions below are answered.
--
-- ============================================================================
-- STATUS 2026-08-10 — STAGED ON PURPOSE. NOT FORGOTTEN. DECIDED, NOT DEFERRED.
-- ============================================================================
-- Reviewed 2026-08-10 during the contact-merge read-filter work and DELIBERATELY
-- LEFT STAGED. If you are reading this months from now, "never applied" is a
-- decision with a named blocker, not an oversight.
--
-- WHAT UNBLOCKS IT — one thing, and it is not technical:
--
--   The 25 orphan rows below must be resolved first, and resolving them is a
--   COMPLIANCE DECISION SITTING WITH E MORTGAGE, not a data-cleanup task.
--   ADD CONSTRAINT validates existing rows, so those 25 abort the script.
--   They carry residual creditor account numbers belonging to 7 contacts
--   deleted before 2026-06-19.
--
--   Deleting them so the constraint validates would be resolving a retention
--   question by destroying the evidence of it. If any of those 7 was an erasure
--   request, the creditor account numbers are precisely what the request was
--   meant to remove and their deletion needs recording as fulfilment. If it was
--   CRM tidying, they are dead weight and can go. Same rows, opposite handling,
--   and nobody in this repo can tell which from the data.
--
--   This is the SAME question as the 12 orphaned borrower Drive files and the
--   seven April–May contact deletions. Rene's compliance email to E Mortgage
--   covers all three. Answer arrives -> unblock all three together.
--
-- WHAT APPLYING IT WOULD *NOT* FIX — do not apply it hoping for this:
--
--   It changes nothing retroactively. contact_merge reads contact_fk_catalogue
--   at MERGE time, and the four merges of 2026-08-08 already ran. Adding FKs
--   makes FUTURE merges see these tables; it does not re-scan the past.
--
--   The one row the 2026-08-08 merges actually missed — a video on Rene's
--   loser id — was repointed by hand on 2026-08-10 and recorded in
--   contact_merge_moves, so contact_merge_undo replays it. Undo replays from
--   contact_merge_moves and never reads the catalogue, so that record is real.
--   Nothing else needed moving: property_estimates had zero ghost rows, and
--   contact_earnings is excluded from this script for the reason at the bottom.
--
-- THE COST OF LEAVING IT STAGED, stated so it is a choice and not a drift:
--
--   Any table with a contact_id and no FK stays invisible to contact_merge, so
--   the NEXT merge will miss the same way this one did. That is survivable
--   while merges are rare and hand-checked; it is not survivable if merging
--   becomes routine. If someone proposes a bulk dedupe, this file blocks it.
--
-- ============================================================================
-- WHY
-- ============================================================================
-- 27 columns reference contacts with NO foreign key. Nothing enforces them, so
-- "zero orphans" on 23 of them is luck, not design — no deleted contact happened
-- to have rows there yet. Four were not lucky: 25 orphan rows across
-- loan_liabilities (14), loan_scenarios (7), loan_income (3), lender_submissions (1),
-- from 7 contacts deleted before 2026-06-19.
--
-- ============================================================================
-- BLOCKERS — this script FAILS today. Both must be cleared first.
-- ============================================================================
-- 1. ADD CONSTRAINT validates existing rows. The 25 orphans will abort steps 2+.
--    Snapshotted in snapshots/contact-orphans-20260804.json and in Postgres as
--    <table>_orphan_cleanup_20260804. NOT deleted: Rene has to say why those 7
--    contacts were deleted first. If a borrower requested erasure, residual
--    creditor account numbers are the thing the request was meant to remove; if
--    it was CRM tidying, they are dead weight. Different answers, same rows.
--
-- 2. contact_earnings is NOT in this script at all. See the note at the bottom —
--    the FK is not what governs it and adding one would change nothing.
--
-- ============================================================================
-- STEP 1 — UNBLOCK DELETION (do this one first; it is the only user-visible bug)
-- ============================================================================
-- Contact deletion currently FAILS outright for anyone with call history or a
-- signature. Verified against the ZZ-TEST fixture:
--   ERROR: 23503: update or delete on table "contacts" violates foreign key
--   constraint "calls_log_contact_id_fkey" on table "calls_log"
-- 10 of 1038 live contacts cannot be deleted today: 9 via signature_signers,
-- 2 via calls_log (one overlaps). The 7 known deletions are only the ones that
-- happened to be deletable — the true count of attempted deletions is unknown.

-- signature_signers: SET NULL, NOT CASCADE. Deleting a signer row would gut a
-- COMPLETED legal envelope — signature_requests, its events and its certificate
-- would survive with a hole where the signer was. Nulling unblocks the delete
-- and leaves the envelope intact and auditable. Unblocks 9 of the 10.
alter table public.signature_signers
  drop constraint signature_signers_person_contact_id_fkey,
  add  constraint signature_signers_person_contact_id_fkey
       foreign key (person_contact_id) references public.contacts(id) on delete set null;

-- calls_log: CASCADE, to match call_log which is already CASCADE. A call record
-- is contact data.
--   NEW BEHAVIOUR: deleting a contact now also deletes their call history —
--   recordings metadata, voicemail URLs, outcomes and notes. Today the delete
--   simply fails instead, so nothing is lost silently; after this, it is.
alter table public.calls_log
  drop constraint calls_log_contact_id_fkey,
  add  constraint calls_log_contact_id_fkey
       foreign key (contact_id) references public.contacts(id) on delete cascade;

-- saved_listings: CASCADE. 0 rows today, so this is free to fix now and costs
-- nothing to get wrong later.
--   NEW BEHAVIOUR: a deleted contact's saved listings go with them. No rows exist.
alter table public.saved_listings
  drop constraint saved_listings_contact_id_fkey,
  add  constraint saved_listings_contact_id_fkey
       foreign key (contact_id) references public.contacts(id) on delete cascade;

-- lead_source_stats.lead_id references contacts(id) through a column named
-- lead_id. NOT TOUCHED — that naming suggests a modelling mistake rather than a
-- deliberate ON DELETE choice, and it deserves its own look before being locked in.

-- ============================================================================
-- STEP 2 — CASCADE: the row IS the borrower's data and is meaningless without them
-- ============================================================================
-- For every one of these, state the same thing plainly: a delete that today
-- leaves these rows behind will, after this, remove them. That is the point, and
-- it is also the risk — each line below is a new way for one click in the People
-- screen to destroy more than the person clicking expects.

-- Loan application detail. Currently orphans (14/7/3 rows prove it).
--   NEW BEHAVIOUR: deleting a contact removes their liabilities, income,
--   scenarios, assets, REO and borrower rows — the entire 1003 working set.
alter table public.loan_liabilities  add constraint loan_liabilities_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete cascade;
alter table public.loan_income       add constraint loan_income_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete cascade;
alter table public.loan_scenarios    add constraint loan_scenarios_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete cascade;
alter table public.loan_assets       add constraint loan_assets_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete cascade;
alter table public.loan_reo          add constraint loan_reo_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete cascade;
alter table public.loan_borrowers    add constraint loan_borrowers_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete cascade;

-- Derived / working documents.
--   NEW BEHAVIOUR: deleting a contact removes their fee sheet drafts, CMA
--   snapshots, property estimates and e-sign document rows. esign_documents is
--   the one to think twice about: it is the PDF-and-fields working copy, and
--   signature_requests (CASCADE already) goes at the same time, so a completed
--   envelope's document row disappears with the borrower. If signed PDFs must
--   outlive the contact, move this line to SET NULL.
alter table public.fee_sheet_drafts   add constraint fee_sheet_drafts_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete cascade;
alter table public.cma_snapshots      add constraint cma_snapshots_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete cascade;
alter table public.property_estimates add constraint property_estimates_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete cascade;
alter table public.esign_documents    add constraint esign_documents_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete cascade;

-- Transient queues and per-contact state.
--   NEW BEHAVIOUR: pending bot replies and in-app notifications for a deleted
--   contact disappear rather than firing at a person who no longer exists.
alter table public.bot_queued_replies    add constraint bot_queued_replies_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete cascade;
alter table public.app_notifications     add constraint app_notifications_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete cascade;
alter table public.condition_attachments add constraint condition_attachments_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete cascade;
alter table public.order_documents       add constraint order_documents_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete cascade;
alter table public.email_thread_tags     add constraint email_thread_tags_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete cascade;

-- contact_financials: income and credit score, split off contacts by
-- mirror_contact_financials(). CASCADE is correct AND redundant — the
-- trg_cleanup_contact_financials trigger already deletes it on contact delete.
-- Added so the invariant survives the trigger being changed or dropped.
--   NEW BEHAVIOUR: none today. It is a belt for an existing brace.
alter table public.contact_financials add constraint contact_financials_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete cascade;

-- ============================================================================
-- STEP 3 — SET NULL: business records that outlive the person
-- ============================================================================
-- These are records of what YOU did, not what the borrower is. They keep their
-- own copy of whatever identity they need.
--   NEW BEHAVIOUR: none of these rows are removed by a delete; their contact_id
--   simply goes null. Reporting that groups by contact_id will start seeing a
--   null bucket — that is the intended, visible cost.

-- A submission to a lender is a record of your activity and carries borrower_name
-- independently of the contact row.
alter table public.lender_submissions   add constraint lender_submissions_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete set null;
alter table public.fee_sheet_snapshots  add constraint fee_sheet_snapshots_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete set null;
alter table public.tracked_links        add constraint tracked_links_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete set null;
alter table public.email_link_clicks    add constraint email_link_clicks_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete set null;
alter table public.web_events           add constraint web_events_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete set null;
alter table public.campaign_recipients  add constraint campaign_recipients_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete set null;
alter table public.listing_alert_sms_queue add constraint listing_alert_sms_queue_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete set null;
alter table public.videos               add constraint videos_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete set null;
alter table public.processing_items     add constraint processing_items_related_contact_id_fkey
  foreign key (related_contact_id) references public.contacts(id) on delete set null;

-- contacts.primary_borrower_contact_id has no FK at all. delete-contacts NULLs it
-- in application code before deleting; this makes the database enforce it, so the
-- invariant no longer depends on one edge function remembering to.
--   NEW BEHAVIOUR: none. It formalises what the deployed function already does.
--   Keep the application-side is_co_borrower=false, which an FK cannot express.
alter table public.contacts add constraint contacts_primary_borrower_contact_id_fkey
  foreign key (primary_borrower_contact_id) references public.contacts(id) on delete set null;

-- ============================================================================
-- DELIBERATELY EXCLUDED
-- ============================================================================
-- uploaded_documents_typefix_20260731 — a dated snapshot per the repo convention.
--   Its whole job is to be a frozen record; an FK would let a later delete edit
--   history. Same for the *_orphan_cleanup_20260804 tables this work created.
--
-- contact_earnings — NOT given an FK, and the earlier recommendation to CASCADE it
--   is withdrawn. Three findings, in order:
--     a) contact_id is the PRIMARY KEY and NOT NULL, so SET NULL is impossible
--        without a surrogate key. CASCADE or nothing.
--     b) it is already emptied on contact delete by trg_cleanup_contact_financials,
--        which runs `delete from contact_earnings where contact_id = OLD.id`. So
--        CASCADE would change NOTHING — the data is destroyed either way, today.
--     c) it holds actual_earnings and estimated_earnings: Rene's commission per
--        contact, split off contacts by mirror_contact_financials() which NULLs the
--        six sensitive columns so "these six never persist on contacts again".
--   The FK is therefore the wrong lever entirely. The real question is whether
--   that TRIGGER should delete commission records when a borrower is deleted —
--   an accounting and tax question, not a referential-integrity one. Nothing has
--   been lost yet: all 29 contact_earnings rows deleted between 2026-06-19 and
--   2026-08-01 had null/zero earnings. A borrower deleted AFTER closing would be
--   the first real loss, and today nothing prevents it.
--   Retaining earnings past deletion needs a schema change, not an FK: with
--   contact_id as the PK there is nowhere to put a row whose contact is gone.

-- STAGED — NOT APPLIED. Read the ordering note before running any of this.
--
-- WHY
-- lead-detail.html:9966 lpSaveAppField() is a per-field autosave that does
-- check-then-act:
--
--     let appId = _activeBorrowerApp?.id ?? null
--     if (!appId) appId = (await _fetchAppRowForContact(cid))?.id
--     if (appId) UPDATE ... else INSERT { contact_id, [col]: value }
--
-- Save two fields quickly on a contact with no application row and BOTH lookups
-- finish before either insert commits, so both take the insert branch. Nothing
-- at the database level stops the second one.
--
-- Every duplicate then fires clickup_app_submitted (ROW-level AFTER INSERT on
-- mortgage_applications) a second time, producing a duplicate task AND a
-- duplicate ClickUp card. The trigger is behaving correctly; the duplicate row
-- is the fault.
--
-- OBSERVED 2026-08-05: 3 borrowers, 3 extra rows, gaps of 0.057s / 0.083s /
-- 0.110s. Every one under five seconds — there is no legitimate second
-- application in the data, only races.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ORDERING MATTERS. Step 1 FAILS while duplicates exist.
--
--   CREATE UNIQUE INDEX ... ON mortgage_applications (contact_id)
--   ERROR:  could not create unique index
--   DETAIL: Key (contact_id)=(...) is duplicated.
--
-- So the sequence is: resolve the 3 duplicate pairs FIRST, then create the
-- index, then change the call site. Creating the index before resolving them
-- does nothing except fail — harmlessly, but it will look like the migration is
-- broken when it is the data that is not ready.
--
-- Resolving them is RENE'S CALL and is deliberately not scripted here:
-- duplicate loan applications on a real borrower are a business record, and
-- three of the six affected tasks were already marked completed, meaning the
-- duplicate work may already have been done twice.
-- ─────────────────────────────────────────────────────────────────────────────

-- STEP 0 — confirm what is still duplicated at the time you run this.
select c.first_name || ' ' || coalesce(c.last_name,'') as borrower,
       ma.id, ma.created_at, ma.loan_type, ma.loan_amount, ma.status
from mortgage_applications ma
join contacts c on c.id = ma.contact_id
where ma.contact_id in (
  select contact_id from mortgage_applications
  where contact_id is not null group by contact_id having count(*) > 1)
order by borrower, ma.created_at;

-- STEP 1 — resolve. NOT scripted: decide per borrower which row survives.
-- The later row is not automatically the keeper. For Jesus Quintero the SECOND
-- row carried loan_type='conventional' while the first was entirely null, so
-- deleting "the newer one" would have discarded the only real data.
-- Check every pair before choosing.

-- STEP 2 — only after STEP 1 returns nothing.
-- Partial: contact_id is nullable and several rows legitimately have none.
-- create unique index concurrently if not exists mortgage_applications_one_per_contact
--   on public.mortgage_applications (contact_id)
--   where contact_id is not null;

-- STEP 3 — call site. The index makes the second insert FAIL rather than
-- silently duplicate, so lpSaveAppField must stop check-then-inserting:
--
--   await _authClient()
--     .from('mortgage_applications')
--     .upsert({ contact_id: cid, [col]: value }, { onConflict: 'contact_id' })
--
-- Without step 3 the index turns a silent duplicate into a visible error on a
-- routine field save, which is worse for the user than the bug. Steps 2 and 3
-- ship together or not at all.

-- ─────────────────────────────────────────────────────────────────────────────
-- RELATED, ALSO STAGED AND UNRUN: the video_chat_limits unique index on
-- bucket_key. Same family — a table used for idempotency with nothing enforcing
-- it. That one had 0 duplicates when last checked, so its index would apply
-- cleanly today; this one will not.
-- ─────────────────────────────────────────────────────────────────────────────

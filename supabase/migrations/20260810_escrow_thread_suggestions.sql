-- Escrow-number thread suggestion: the two durable stores.
--
-- See docs/ESCROW-THREAD-SUGGESTION-2026-08-10.md. The matcher itself holds no
-- state — it is a pure function over (thread text, the handful of populated
-- loan_orders.reference values). These two tables are the only things it needs
-- to remember, and they exist for opposite reasons:
--
--   dismissals    — so a REJECTED suggestion stays rejected
--   contradictions — so an UNREVIEWED disagreement survives nobody looking
--
-- Both are written by gmail-inbox with the service role, never by the browser.
-- The actor comes from the verified JWT, the way the mailbox boundary does.

-- ── 1. Dismissals ────────────────────────────────────────────────────────────
--
-- KEYED ON THE PAIR, NEVER ON THE THREAD ALONE. Dismissing "file this on Tania"
-- must not suppress a later, different, correct suggestion on the same thread.
-- Same reasoning as gdrive-health-monitor's digest alert key: the key is the
-- suggestion's IDENTITY, never its content.
--
-- The consequence is deliberate and worth stating: correcting a typo'd escrow
-- number changes which contact it resolves to, which changes the key, so the
-- thread prompts again. That is the desired behaviour — the earlier dismissal
-- rejected a DIFFERENT claim — not a leak in the suppression.
create table if not exists public.email_thread_suggestion_dismissals (
  gmail_thread_id      text        not null,
  suggested_contact_id uuid        not null references public.contacts(id) on delete cascade,
  -- Which rule proposed it. Only 'escrow_reference' today; present so a second
  -- suggester cannot silently inherit this one's dismissals.
  source               text        not null default 'escrow_reference',
  -- The literal token that was suggested on, kept for review. Not part of the
  -- key: a dismissal is of the CLAIM ("this thread is Tania's"), not of the
  -- string that raised it.
  evidence             text,
  dismissed_by         uuid        not null,
  dismissed_at         timestamptz not null default now(),
  primary key (gmail_thread_id, suggested_contact_id, source)
);

comment on table public.email_thread_suggestion_dismissals is
  'One row per rejected thread-filing suggestion. Keyed on (thread, suggested contact, source) so dismissing one claim never suppresses a different one on the same thread.';

-- ── 2. Contradictions ────────────────────────────────────────────────────────
--
-- WHY A ROW AND NOT JUST A BANNER: thread 19f964d623e8a4c0 ("Update Insurance
-- 947 N Alamo St") has been filed on the CC'd agent instead of the borrower for
-- weeks. It was found by reading, not by anything reporting it. A banner in the
-- thread view only ever helps the person who happens to open that thread.
--
-- This is ALSO the minimum viable match_source/match_evidence. Those columns do
-- not exist on email_log and are not added here — but a contradiction is
-- precisely the case where the evidence must be durable, so the evidence for
-- BOTH sides is captured on this row at the moment it is computed:
--
--   filed_via + filed_evidence   — what the automatic match used ('alex@tdgsells.com')
--   escrow_reference             — what the escrow number is
--
-- So a contradiction is reviewable in full from this table alone, without
-- reopening the thread and without the email_log columns. It is not a
-- substitute for them: it records only disagreements, not filings generally.
--
-- COVERAGE LIMIT, stated because it will otherwise be assumed away: rows are
-- written when a thread is OPENED, since that is when gmail-inbox has the
-- bodies. Threads nobody has opened produce no row. Unmatched mail is never
-- persisted at all (see §1 of the doc), so no sweep can close that gap either.
-- This table is "every contradiction anyone has ever loaded", which is strictly
-- more than "every contradiction someone happened to notice" and strictly less
-- than "every contradiction".
create table if not exists public.email_thread_match_contradictions (
  -- One OPEN contradiction per thread. Re-opening the thread updates last_seen_at
  -- rather than appending, so this table is a worklist, not a log.
  gmail_thread_id     text        primary key,
  thread_subject      text,
  mailbox             text,

  -- Where the thread is filed now, and on what evidence.
  filed_contact_id    uuid        not null references public.contacts(id) on delete cascade,
  filed_via           text        not null,
  filed_evidence      text,

  -- Where the escrow number says it belongs.
  escrow_contact_id   uuid        not null references public.contacts(id) on delete cascade,
  escrow_reference    text        not null,

  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),

  -- Null while open. Set when Rene acts on it in the thread view.
  resolved_at         timestamptz,
  resolution          text,
  resolved_by         uuid,

  -- Only an AUTOMATIC match can contradict loudly. A human's explicit
  -- email_thread_tags row is a decision, and re-litigating it is nagging — the
  -- thread view shows one quiet line and writes NO row. Enforced here too so a
  -- future caller cannot start recording them by accident.
  constraint etmc_filed_via_is_automatic
    check (filed_via in ('contact', 'vendor')),
  -- refiled    — Rene accepted the escrow number's answer
  -- kept       — he dismissed it and left the automatic filing alone
  -- superseded — he filed it on some THIRD contact, so neither side was right.
  --              Worth its own value: reading these back as 'kept' would credit
  --              the automatic match with an outcome it did not earn.
  constraint etmc_resolution_valid
    check (resolution is null or resolution in ('refiled', 'kept', 'superseded')),
  -- A resolution and its timestamp travel together or not at all. Same shape as
  -- the transcript_status CHECK constraints: a half-written outcome is the
  -- ambiguity these exist to remove.
  constraint etmc_resolution_complete
    check ((resolved_at is null) = (resolution is null))
);

comment on table public.email_thread_match_contradictions is
  'Threads where an escrow number disagrees with an AUTOMATIC contact match. A worklist, not a log: one row per thread, updated on re-open. Written only for filed_via in (contact, vendor) — contradicting a human tag is deliberately not recorded.';

comment on column public.email_thread_match_contradictions.filed_evidence is
  'The address matchContact matched to file this thread. This is match_evidence, scoped to the case that needs it — email_log has no such column.';

-- Open contradictions are the query anyone will actually run.
create index if not exists idx_etmc_open
  on public.email_thread_match_contradictions (last_seen_at desc)
  where resolved_at is null;

-- ── RLS ──────────────────────────────────────────────────────────────────────
--
-- Read: staff, matching ett_staff_read on email_thread_tags — the same people
-- who can see the filing can see why it is disputed.
-- Write: NO policy. Both tables are written by gmail-inbox with the service
-- role, which bypasses RLS, so the browser cannot forge a dismissal for
-- somebody else or silently resolve a contradiction it did not act on.
alter table public.email_thread_suggestion_dismissals enable row level security;
alter table public.email_thread_match_contradictions  enable row level security;

drop policy if exists etsd_staff_read on public.email_thread_suggestion_dismissals;
create policy etsd_staff_read on public.email_thread_suggestion_dismissals
  for select
  using (is_admin() or coalesce(current_app_role(), '') = any (array['va','loa','agent','staff']));

drop policy if exists etmc_staff_read on public.email_thread_match_contradictions;
create policy etmc_staff_read on public.email_thread_match_contradictions
  for select
  using (is_admin() or coalesce(current_app_role(), '') = any (array['va','loa','agent','staff']));

grant select on public.email_thread_suggestion_dismissals to authenticated;
grant select on public.email_thread_match_contradictions  to authenticated;

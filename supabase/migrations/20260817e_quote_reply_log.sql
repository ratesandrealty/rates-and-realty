-- One row per inbound quote reply the poller has seen, matched or not.
--
-- REVERT:
--   drop table if exists public.quote_reply_log;
--
-- ══ WHY UNMATCHED REPLIES GET A ROW ══
--
-- The obvious design records only replies that correlated. That produces a table
-- which cannot answer the one question worth asking — "is the correlation
-- working?" — because a ladder that matches nothing and a mailbox nobody replied
-- to look identical in it: both empty.
--
-- That is exactly how VOE's token rung went dead for its whole existence. The
-- send emitted a bare processing@ while the poll queried processing+<token>@, so
-- nothing ever matched, and because nothing was written on a miss there was no
-- growing pile of unattached replies to notice. It was found by reading the two
-- files side by side, not from any data.
--
-- So every message the poller considers gets a row carrying matched_by, which is
-- one of:
--
--   in_reply_to       matched the RFC Message-ID of what we sent   (primary)
--   token             matched hoi_/voe_ token                       (secondary)
--   address_unique    sender address identified exactly one row     (last)
--   ambiguous_address sender address is on MORE THAN ONE row — refused on purpose
--   unmatched         no signal matched
--
-- 'ambiguous_address' and 'unmatched' are legitimate outcomes, not errors, and
-- are never upgraded into a guess. They are the visible gap someone can act on;
-- the alternative is filing a reply about one borrower onto another's record.
--
-- ══ IDEMPOTENCY ══
--
-- UNIQUE on gmail_message_id, and the poller inserts with ON CONFLICT DO NOTHING.
-- Re-polling the same window is therefore a no-op rather than a duplicate — the
-- same property gmail-inbox already relies on for its own send log, and the
-- reason ONE shared poller was chosen over two that could disagree about whether
-- a reply had been handled.

create table if not exists public.quote_reply_log (
  id               uuid primary key default gen_random_uuid(),
  gmail_message_id text        not null unique,
  gmail_thread_id  text,
  mailbox          text,
  from_email       text,
  to_email         text,
  subject          text,
  snippet          text,
  in_reply_to      text,
  kind             text,
  row_id           uuid,
  contact_id       uuid,
  reply_token      text,
  matched_by       text        not null,
  received_at      timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists quote_reply_log_kind_row_idx
  on public.quote_reply_log (kind, row_id) where row_id is not null;

-- Partial, because the whole point of this index is finding the gap: the replies
-- that arrived and attached to nothing.
create index if not exists quote_reply_log_unattached_idx
  on public.quote_reply_log (created_at desc)
  where matched_by in ('unmatched','ambiguous_address');

alter table public.quote_reply_log enable row level security;

/* Read-only to staff. Nothing writes through this policy — the poller runs with
   the service role, which bypasses RLS — so there is deliberately no INSERT or
   UPDATE policy: a browser has no business editing what a mailbox actually
   received. Snippets can carry borrower NPI, so this is staff, not authenticated. */
drop policy if exists quote_reply_log_staff_read on public.quote_reply_log;
create policy quote_reply_log_staff_read on public.quote_reply_log
  for select to authenticated
  using (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff'));

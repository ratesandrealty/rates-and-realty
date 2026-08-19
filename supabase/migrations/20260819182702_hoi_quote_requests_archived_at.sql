-- Applied to production 2026-08-19 as migration 20260819182702.
-- Recorded here because a COLUMN is the one kind of change nothing else in this
-- repo captures: tools/recapture-db-functions.mjs covers functions, and there is
-- no equivalent for table DDL.

alter table public.hoi_quote_requests
  add column if not exists archived_at timestamptz;

comment on column public.hoi_quote_requests.archived_at is
$c$Set when Rene stops pursuing this quote request. NOT a status and NOT a delete.

'Not pursuing' and 'declined' are different facts: declined is something the agent
did, archived is something we decided, and a row can be both or neither. Squeezing
the second into hoi_quote_requests.status would destroy the first -- the same
conflation that cost twice before (recording_disposition stamped at dial time, and
transcript_status before it had its own vocabulary).

Archiving hides the card. It does NOT touch correlation: quote_reply_match never
reads this column, so a late reply on an archived request still sets
quote_reply_log.row_id and still attaches. That is deliberate -- a request you
stopped chasing is exactly the one where a surprise reply matters most, and a
filter applied at MATCH time instead of DISPLAY time would silently drop it.$c$;

-- Partial index: the only query shape is "the archived ones for this contact",
-- and archived rows are the small minority.
create index if not exists hoi_quote_requests_archived_idx
  on public.hoi_quote_requests (contact_id)
  where archived_at is not null;

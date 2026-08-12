-- Tour share links: expiry and revocation.
--
-- `showing_batches.share_token` is a 10-char token from generate_tour_share_token
-- (55^10 ≈ 2.5e17 — not guessable; duration and forwarding are the problem, not
-- entropy). Until now the public lookup was a bare `.eq("share_token", token)`
-- with no expiry and no revocation, so all 19 batches served in full forever —
-- and the newest tour was 2026-05-06, over three months ago.
--
-- `status = 'canceled'` was NOT revocation: renderHtml swapped a pill badge and
-- hid the actions bar, but stopsHtml is built before that check and rendered
-- regardless, so a canceled tour still handed over every address, time and photo.
--
-- NO BACKFILL. All 19 existing rows keep expires_at NULL = never expires. Every
-- one is months stale and arguably should be expired, but doing it here would
-- silently kill links that currently work; that is Rene's call to make
-- deliberately, not a side effect of this migration.

alter table public.showing_batches
  add column if not exists expires_at timestamptz,
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by uuid;

comment on column public.showing_batches.expires_at is
  'Public /tour/<token> stops resolving at this time. Set on send_to_lead and refreshed on schedule as scheduled_end + 7 days (the tail that lets the post-tour feedback path still work), or now() + 30 days for a tour with no date yet. NULL = never expires; true only of rows predating 2026-08-12.';
comment on column public.showing_batches.revoked_at is
  'Set by tours-admin revoke_link. The public view refuses BEFORE the view counter moves and before the lead scorer fires, so a revoked link stops accruing signal.';

-- The public lookup is by token; keep it a single index hit.
create index if not exists showing_batches_share_token_idx
  on public.showing_batches (share_token);

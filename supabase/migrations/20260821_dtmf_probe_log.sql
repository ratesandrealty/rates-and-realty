/* Where the DTMF probe's result lands.
 *
 * The probe dials a SENTINEL destination that twilio-voice answers with
 * <Gather> instead of <Dial>, so no PSTN call is placed and nobody's phone
 * rings. Twilio posts the digits it actually heard on the browser leg back to
 * the function, which writes them here; tools/dtmf-probe.mjs reads them back
 * and compares against what it pressed.
 *
 * This is the artifact the proof leaves behind. A DTMF check that reported
 * "looks fine" and stored nothing would be exactly the false-proof shape
 * CLAUDE.md records for 9f87ca6.
 *
 * No borrower data, no calls_log row, no contact. Trimmed to 50 rows by the
 * writer so it cannot grow.
 */
create table if not exists public.dtmf_probe_log (
  id          bigserial primary key,
  ref         text not null,
  digits      text,
  call_sid    text,
  received_at timestamptz not null default now()
);
create index if not exists dtmf_probe_log_ref_idx on public.dtmf_probe_log (ref, received_at desc);

alter table public.dtmf_probe_log enable row level security;
-- Read is admin-only; the function writes with the service role and bypasses RLS.
drop policy if exists dtmf_probe_log_admin_read on public.dtmf_probe_log;
create policy dtmf_probe_log_admin_read on public.dtmf_probe_log
  for select to authenticated using (public.is_admin());

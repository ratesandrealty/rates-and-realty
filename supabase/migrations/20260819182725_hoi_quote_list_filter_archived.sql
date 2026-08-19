-- Applied to production 2026-08-19 as migration 20260819182725.
-- The function BODY is captured authoritatively at
-- supabase/sql/db-functions/hoi_quote_list.sql by recapture-db-functions.mjs.
-- What that capture cannot record is the DROP and the GRANT restoration, which
-- are the two things that make this change safe -- so they live here.

-- DROP, not CREATE OR REPLACE. Adding a defaulted parameter to an existing
-- function does NOT replace it, it mints a second overload, and every existing
-- one-arg call keeps hitting the OLD body forever. Detection: recapture writes
-- two files for one name.
drop function if exists public.hoi_quote_list(uuid);

-- Body: see supabase/sql/db-functions/hoi_quote_list.sql (recaptured from
-- production after this ran). The only change from the previous version is the
-- extra parameter and one line in the WHERE clause:
--     and (p_include_archived or h.archived_at is null)
-- Filtered at DISPLAY and nowhere else: quote_reply_match does not read
-- archived_at and must not, so a late reply on an archived request still
-- correlates. Proven in both directions -- all four match tiers hit an archived
-- row, and a control with one live + one archived row returns 1 and 2.

-- The drop took the grants with it. Captured before, restored identically:
--   {=X/postgres,postgres=X,anon=X,authenticated=X,service_role=X}
-- Restored AS FOUND rather than tightened. The anon grant on a SECURITY DEFINER
-- function that reads borrower quote data predates this change and deserves a
-- deliberate frontend-first decision, not a silent narrowing folded into an
-- unrelated build. See docs/VENDOR-PICKERS-AND-QUOTE-ARCHIVE-2026-08-19.md.
grant execute on function public.hoi_quote_list(uuid, boolean) to public;
grant execute on function public.hoi_quote_list(uuid, boolean) to anon;
grant execute on function public.hoi_quote_list(uuid, boolean) to authenticated;
grant execute on function public.hoi_quote_list(uuid, boolean) to service_role;

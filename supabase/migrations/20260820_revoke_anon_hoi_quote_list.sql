-- Applied to production 2026-08-20 as migration revoke_anon_hoi_quote_list.
--
-- STEP 2 OF THE DISCLOSURE CHAIN. Step 1 (quote_reply_match) was closed on
-- 2026-08-19. Both calls were anonymous, read-only, and needed nothing but the
-- public anon key printed in every page:
--
--   1. quote_reply_match {"p_from_email":"<an agent's public address>"}
--        -> contact_id, matched_by=address_unique              CLOSED 2026-08-19
--   2. hoi_quote_list    {"p_contact_id":"<that id>"}
--        -> "Homeowners Insurance Quote Request — Daniel Garcia"   THIS ONE
--
-- It is not only vendor contact details. The `activity` array carries the email
-- subject and the subject carries the BORROWER'S NAME. Measured against a real
-- contact: 4 quote requests returned to an anonymous caller, all 4 with agent
-- email and phone, one with thread activity naming the borrower. Blast radius
-- at audit time: 11 quote requests across 4 contacts.
--
-- THE FRONTEND IS ALREADY CORRECT -- this does not need the frontend-first dance,
-- and the evidence is a working control in production rather than a prediction.
-- hoi_quote_list has exactly ONE caller in the tree:
--
--   admin/lead-detail.html:14097  lpHoiLoadList()  via _authClient()
--
-- _authClient() returns window._supabaseClient, the session-aware client
-- auth-guard.js mounts, so supabase-js sends the user's access token. No edge
-- function, no cron, no Worker route calls it. And hoi_quote_prefill(uuid) is
-- ALREADY in exactly the ACL state this migration produces --
-- {postgres=X,authenticated=X,service_role=X} -- while being called from the
-- SAME modal, twenty lines away, through the SAME _authClient(). That modal
-- works. A session-only grant is demonstrated sufficient for this caller, not
-- predicted.
--
-- WHY THE PROOF BAR IS STILL A PAGE CHECK. The caller swallows failure:
--   }catch(e){ console.warn('[hoi_quote_list]', e&&e.message); }     :14101
-- console.WARN, not error -- which render-check does not fail on. A broken grant
-- would render an EMPTY quote list, not an error. And the one render-check spec
-- that mentions hoi_quote_list drives lpHoiRenderList directly with a two-row
-- fixture to test the RENDERER, so it passes regardless of this grant. Nothing
-- automated covers this path; it is verified by hand with a real session.
--
-- Both lines needed: =X/postgres is the PUBLIC grant and anon inherits it, so
-- revoking anon alone returns success and changes nothing.
revoke execute on function public.hoi_quote_list(uuid, boolean) from public;
revoke execute on function public.hoi_quote_list(uuid, boolean) from anon;

-- authenticated MUST survive -- it is the only thing the page has. service_role
-- has no caller today but is kept for parity with the rest of the family.
do $verify$
begin
  if not has_function_privilege('authenticated',
       'public.hoi_quote_list(uuid,boolean)', 'EXECUTE') then
    raise exception 'authenticated lost EXECUTE — the HOI panel would render empty and only console.warn';
  end if;
  if not has_function_privilege('service_role',
       'public.hoi_quote_list(uuid,boolean)', 'EXECUTE') then
    raise exception 'service_role lost EXECUTE';
  end if;
  if has_function_privilege('anon',
       'public.hoi_quote_list(uuid,boolean)', 'EXECUTE') then
    raise exception 'anon STILL has EXECUTE — the PUBLIC grant was not removed';
  end if;
end
$verify$;

-- THIS REVOKE IS NOW SELF-MAINTAINING. Before today, a later CREATE OR REPLACE
-- of this function would have left the ACL alone (replace preserves proacl) but
-- any DROP + CREATE would have re-granted anon from pg_default_acl. The event
-- trigger rr_revoke_new_function_grants (shipped earlier today) strips
-- public+anon from every newly created function in public, and hoi_quote_list is
-- NOT on its allowlist -- so the closed state now survives a recreate.
--
-- PROVEN AFTERWARDS BY EXECUTION over HTTPS with the public anon key, not by
-- re-reading the catalogue. Control taken BEFORE the revoke with an all-zeros
-- uuid, so executability was proven without retrieving any borrower's data:
--
--   before:  HTTP 200  []                                    <- function ran
--   after:   HTTP 401  42501 permission denied for function hoi_quote_list
--
-- and the chain no longer completes at step 2 even for a caller who already
-- holds a contact_id.
--
-- ROLE LEVEL, by becoming the roles rather than re-reading the catalogue. The
-- contact used is the one with the most quote requests; only counts are recorded
-- here, never the borrower's details:
--
--   authenticated   table has 5 (1 archived)
--                   hoi_quote_list(cid,false) -> 4 elements
--                   hoi_quote_list(cid,true)  -> 5 elements
--   anon            permission denied (42501)
--
-- MEASUREMENT NOTE, because it briefly read as a defect. hoi_quote_list
-- RETURNS JSONB -- one array, not a set of rows -- so `select count(*) from
-- hoi_quote_list(...)` is 1 for any input, and looked like "4 requests collapsed
-- to 1, and p_include_archived does nothing". Use jsonb_array_length(). Nothing
-- was wrong with the function or the revoke; the measurement was wrong.

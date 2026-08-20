-- Applied to production 2026-08-20 as migration revoke_anon_voe_match_reply.
--
-- STEP 3 OF THE DISCLOSURE CHAIN, and the last of the three oracles.
--   step 1  quote_reply_match   closed 2026-08-19
--   step 2  hoi_quote_list      closed 2026-08-20
--   step 3  voe_match_reply     this one
--
-- Identical shape to step 1: hand it an email address and it returns a borrower.
-- Measured anonymously over HTTPS with the public anon key, no session, no uuid,
-- no secret -- the address is an employer HR contact, ordinary business
-- information:
--
--   POST /rest/v1/rpc/voe_match_reply {"p_from_email":"<an hr_contact_email>", ...}
--   HTTP 200
--   {"order_id":"f012081f-…","contact_id":"07b1e13d-…",
--    "matched_by":"hr_email","reply_token":null}
--
-- That contact_id is the pivot the whole chain is built on.
--
-- THE ONLY CALLER NO LONGER RUNS. voe-inbound-poll (formerly pg_cron job 37) is
-- the sole reference in the tree (supabase/functions/voe-inbound-poll:242), and
-- there is now NO cron job invoking it -- verified: no row in cron.job matches
-- 'voe' at all, and jobid 37 does not exist. Only job 50 quote-reply-poll
-- remains, and it calls quote_reply_match, not this function.
--
-- So unlike step 1, this revoke cannot break a live correlation path: there is no
-- live correlation path. service_role and authenticated are kept anyway, so a
-- manual invocation of the edge function still works and the retirement decision
-- in docs/RETIRING-VOE-INBOUND-POLL-2026-08-17.md stays open on its own merits
-- rather than being forced by a grant.
--
-- WORTH RECORDING: this matcher is a retirement candidate BECAUSE IT GUESSES.
-- It matches on hr_contact_email with no send-record restriction, and on
-- 2026-08-17 an insurance agent's reply from an address that is also an
-- hr_contact_email resolved to a DIFFERENT borrower's VOE order -- it would have
-- filed one borrower's insurance reply onto another's employment verification.
-- It was saved only by the poller's Gmail query shape, not by the matcher. A
-- function that mis-attributes across borrowers internally is a worse thing to
-- leave anonymously reachable, not a better one.
--
-- Both lines needed: =X/postgres is the PUBLIC grant and anon inherits it, so
-- revoking anon alone returns success and changes nothing.
revoke execute on function public.voe_match_reply(text,text,text,text,text,text) from public;
revoke execute on function public.voe_match_reply(text,text,text,text,text,text) from anon;

do $verify$
begin
  if not has_function_privilege('service_role',
       'public.voe_match_reply(text,text,text,text,text,text)', 'EXECUTE') then
    raise exception 'service_role lost EXECUTE';
  end if;
  if not has_function_privilege('authenticated',
       'public.voe_match_reply(text,text,text,text,text,text)', 'EXECUTE') then
    raise exception 'authenticated lost EXECUTE';
  end if;
  if has_function_privilege('anon',
       'public.voe_match_reply(text,text,text,text,text,text)', 'EXECUTE') then
    raise exception 'anon STILL has EXECUTE — the PUBLIC grant was not removed';
  end if;
end
$verify$;

-- Self-maintaining from today: voe_match_reply is not on the allowlist inside
-- rr_revoke_new_function_grants, so the closed state survives a drop-and-recreate
-- that pg_default_acl would previously have re-opened.
--
-- PROVEN AFTERWARDS BY EXECUTION, not by re-reading the catalogue:
--   before:  HTTP 200  order_id + contact_id + matched_by=hr_email
--   after:   HTTP 401  42501 permission denied for function voe_match_reply

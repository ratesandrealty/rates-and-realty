-- Applied to production 2026-08-19 as migration revoke_anon_loan_order_set.
--
-- Defence in depth, NOT a hole being closed. loan_order_set already refuses an
-- anonymous caller in-function ('staff only', measured before the revoke), so
-- this removes reach, not an exposure. Stated plainly because the opposite
-- claim would be a false proof of exactly the kind
-- docs/FALSE-PROOF-CLAIM-9f87ca6-2026-08-15.md describes.
--
-- BOTH lines are required. proacl carried =X/postgres -- an EXECUTE grant to
-- PUBLIC -- and anon INHERITS it, so revoking anon alone would change nothing
-- while appearing to work. Same shape as verify_jwt = true not being an access
-- control. Verified by RE-PROBING ANONYMOUSLY afterwards, never by the revoke
-- returning success:
--
--   before   ANON -> P0001 "staff only"            (in-function guard)
--            SESSION -> "dc010e75-…"               (works)
--   after    ANON -> 42501 "permission denied for function loan_order_set"
--            SESSION -> "dc010e75-…"               (same id, still works)
--
-- authenticated holds its OWN explicit grant (authenticated=X/postgres) and is
-- untouched by either line. Final proacl:
--   {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--
-- All seven callers are in admin/lead-detail.html and every one goes through
-- _authClient(), which sends the session JWT. No edge function, cron or Worker
-- route calls this.

revoke execute on function public.loan_order_set(uuid,text,text,uuid,text,text,text,text,text,text,uuid,uuid,text,timestamp with time zone,text,text,text) from public;
revoke execute on function public.loan_order_set(uuid,text,text,uuid,text,text,text,text,text,text,uuid,uuid,text,timestamp with time zone,text,text,text) from anon;

-- Applied to production 2026-08-19 as migration revoke_anon_quote_reply_match.
--
-- THIS ONE IS A FIX, NOT DEFENCE IN DEPTH. quote_reply_match has no in-function
-- guard, and anonymously it is an oracle: give it an agent's email address and it
-- returns that borrower's contact_id, which hoi_quote_list then turns into the
-- borrower's name. The input is public business information off the agent's own
-- website -- no uuid, no secret. Measured, both calls anonymous and read-only:
--
--   quote_reply_match {"p_from_email":"johnle.agency@gmail.com"}
--     -> {"kind":"hoi","contact_id":"599b4b4a-…","matched_by":"address_unique"}
--   hoi_quote_list    {"p_contact_id":"599b4b4a-…"}
--     -> "Homeowners Insurance Quote Request — Daniel Garcia"
--
-- ROOT CAUSE, AND IT IS NOT THIS FUNCTION. Nobody ever granted anon anything.
-- ALTER DEFAULT PRIVILEGES on schema public grants EXECUTE ON FUNCTIONS to anon,
-- authenticated and service_role (pg_default_acl, set by both postgres and
-- supabase_admin), so EVERY function in public is anon-executable the moment it
-- is created. Proven rather than asserted: a function created in a rollback
-- transaction had ACL
--     {=X/postgres,postgres=X,anon=X,authenticated=X,service_role=X}
-- straight after CREATE, BEFORE any grant statement ran -- and running
--     grant execute on function ... to authenticated, service_role;
-- left it byte-identical. 20260817d has exactly that line for this function. It
-- reads as a restriction and is a complete no-op.
--
-- Scope, measured: 502 functions in public, 434 anon-executable, 252 of those
-- SECURITY DEFINER, 61 of those with no visible in-function guard. The pattern
-- match that produces 61 has a known false-negative rate -- it classified
-- voe_employer_options as unguarded when it refuses with 'not authorized' -- so
-- 61 is an upper bound and every candidate needs probing, not reading.
--
-- Both lines needed: =X/postgres is the PUBLIC grant and anon inherits it, so
-- revoking anon alone changes nothing while returning success.
revoke execute on function public.quote_reply_match(text,text,text,text,text,text,text,text) from public;
revoke execute on function public.quote_reply_match(text,text,text,text,text,text,text,text) from anon;

-- service_role MUST survive. The only caller is the quote-reply-poll edge
-- function (cron job 50, */10) via svcHeaders(), and its failure branch is
--     if (!mrsp.ok) { results.push({ error: `match failed: …` }); continue }
-- inside a response body nothing reads: cron calls it with net.http_post, whose
-- default 5s timeout is SHORTER than the poller's runtime, so net._http_response
-- records a timeout rather than the result. A broken grant here would stop reply
-- correlation silently and indefinitely. Asserted in the migration itself:
do $verify$
begin
  if not has_function_privilege('service_role',
       'public.quote_reply_match(text,text,text,text,text,text,text,text)', 'EXECUTE') then
    raise exception 'service_role lost EXECUTE — the poller would silently stop correlating';
  end if;
  if not has_function_privilege('authenticated',
       'public.quote_reply_match(text,text,text,text,text,text,text,text)', 'EXECUTE') then
    raise exception 'authenticated lost EXECUTE';
  end if;
end $verify$;

-- PROVEN AFTERWARDS BY EXECUTION, not by re-reading the catalogue:
--   set local role service_role -> matched_by=address_unique, contact_id=599b4b4a-…
--   set local role anon         -> permission denied (42501)
--   anon over HTTPS with the public anon key:
--     42501 "permission denied for function quote_reply_match"
--     -> the chain no longer completes; step 1 returns no contact_id.
--
-- AND END TO END, which is the one that matters here because the caller fails
-- silently. The real poller was invoked AFTER the revoke the way cron invokes it
-- (net.http_post + internal_call_headers()), with timeout_milliseconds := 120000
-- so the response was readable at all -- the 5s default is why this is normally
-- invisible. Response id 429414, status 200:
--
--   {"ok":true,"lookback_days":14,
--    "mailboxes":["processing@ratesandrealty.com","rene@ratesandrealty.com"],
--    "counts":{"considered":120,"skipped_self":35,"recorded":1,"duplicate":84,
--              "in_reply_to":1,"token":0,"address_unique":0,
--              "ambiguous_address":0,"unmatched":84}}
--
-- in_reply_to = 1 means quote_reply_match was CALLED and MATCHED a real reply
-- after the revoke, and no result carries "match failed". Correlation is intact.
--
-- Final proacl: {postgres=X, authenticated=X, service_role=X}

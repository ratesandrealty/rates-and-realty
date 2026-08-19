# Stopped here — anon EXECUTE pass, 2026-08-19

Short note for whoever picks this up. Detail lives in
`ANON-EXECUTE-HOI-VOE-FAMILY-2026-08-19.md`,
`ANON-REVOKE-PASS-1-loan_order_set-2026-08-19.md` and
`ANON-REVOKE-PASS-2-quote_reply_match-2026-08-19.md`.

## Done

**`quote_reply_match` — anon and PUBLIC revoked.** Both directions proven at the
role level, by becoming the roles rather than re-reading the catalogue:

```
set local role service_role -> matched_by=address_unique, correct contact_id
set local role anon         -> permission denied (42501)
anon over HTTPS             -> 42501, chain does not complete
end to end                  -> real poller, status 200, in_reply_to:1, no "match failed"
```

Final `proacl`: `{postgres=X, authenticated=X, service_role=X}`.

`loan_order_set` was revoked in pass 1, but that was **defence in depth only** —
it already refused anon in-function (`staff only`). Same for `voe_form_set`,
which is still granted and still guarded.

## THE ROOT CAUSE — this is not 24 functions

`ALTER DEFAULT PRIVILEGES` on schema `public` grants `EXECUTE ON FUNCTIONS` to
`anon`, `authenticated` and `service_role` (`pg_default_acl`, set by both
`postgres` and `supabase_admin`). **Every function in `public` is anon-executable
at birth**, before anyone writes a grant.

Proven in a rollback transaction: straight after `CREATE`, ACL is already
`{=X,postgres=X,anon=X,authenticated=X,service_role=X}` — and running
`grant execute … to authenticated, service_role` left it **byte-identical**.
Those grant lines, which appear all over `supabase/migrations/`, read as
restrictions and are no-ops.

| | count |
|---|---|
| functions in `public` | 502 |
| anon-executable | 434 |
| …`SECURITY DEFINER` | **252** |
| …with no visible in-function guard | **61** (upper bound) |

61 is an upper bound because the pattern match has a known false-negative rate —
it called `voe_employer_options` unguarded when it refuses with `not authorized`.
**Probe each candidate; do not read them.**

**The durable fix is the default privilege plus an explicit `revoke` in the
function-creation template, not 61 one-off revokes.** Every new function will
otherwise be born the same way.

## The chain — step 1 closed, step 2 NOT

Both calls anonymous, read-only, public anon key, no uuid and no secret required:

```
1. quote_reply_match {"p_from_email":"<any agent address it has seen>"}
     -> contact_id, matched_by address_unique          ← NOW CLOSED (42501)
2. hoi_quote_list    {"p_contact_id":"<that id>"}
     -> borrower name in the email subject             ← STILL OPEN
```

The input to step 1 was an insurance agent's email address — public business
information off the agent's own website.

**Still open and unrevoked:**

- **`hoi_quote_list`** — step 2 of the chain. Has a browser caller
  (`admin/lead-detail.html:14097`, `_authClient()`, session JWT), so it needs the
  page re-checked after the revoke, not a poller run. `hoi_quote_prefill` is the
  working control: already anon-revoked, called from the same modal twenty lines
  away, and that modal works.
- **`voe_match_reply`** — identical oracle shape for VOE, same service-role caller
  pattern (`voe-inbound-poll`), same silent failure branch.
- Low sensitivity: `hoi_quote_meta`, `voe_form_get`, `order_document_status`.
- `voe_form_set` — guarded in-function; tidy-up only.

## The silence, which sets the proof bar

`quote-reply-poll` (cron job 50, `*/10`) is the only caller of
`quote_reply_match`. Its failure branch does **not** throw:

```ts
if (!mrsp.ok) { results.push({ error: `match failed: …` }); continue }
```

It records the error in a response body nothing reads — cron invokes it with
`net.http_post`, and **pg_net's 5-second default timeout is shorter than the
poller's runtime**, so `net._http_response` stores a timeout rather than the
result. Measured: request `429410` returned `Timeout of 5000 ms reached`.

**A permission failure on that path is completely silent.** Reply correlation
would simply stop, indefinitely, with nothing to see. That is why pass 2's proof
had to include a real poller run — invoked with
`timeout_milliseconds := 120000` so the response was readable at all — rather
than a catalogue check.

`voe-inbound-poll` has the same shape and deserves the same treatment when
`voe_match_reply` is done.

## Where things stand

`origin/main`, the branch and the deployed HEAD are aligned. Nothing is
half-applied: each revoke is its own migration with its grants asserted in the
migration body.

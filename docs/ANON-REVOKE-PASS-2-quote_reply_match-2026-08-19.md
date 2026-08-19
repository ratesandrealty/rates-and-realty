# Pass 2 — `quote_reply_match`, and the root cause of the whole family

## The root cause, because it is not this function

**Nobody ever granted `anon` anything.**

`ALTER DEFAULT PRIVILEGES` on schema `public` grants `EXECUTE ON FUNCTIONS` to
`anon`, `authenticated` and `service_role` — visible in `pg_default_acl`, set by
both `postgres` and `supabase_admin`. So **every function created in `public` is
anon-executable the moment it exists**, before anyone writes a `grant`.

Proven rather than assumed, in a rollback transaction:

```
straight after CREATE, before any grant statement:
  {=X/postgres,postgres=X,anon=X,authenticated=X,service_role=X}

after: grant execute on function ... to authenticated, service_role;
  {=X/postgres,postgres=X,anon=X,authenticated=X,service_role=X}      ← IDENTICAL

anon can execute?  t
```

`20260817d` carries exactly that grant line for `quote_reply_match`:

```sql
grant execute on function public.quote_reply_match(…) to authenticated, service_role;
```

**It reads as a restriction and is a complete no-op.** Every author who wrote one
believed they were scoping access. None of them were. This is the same family as
`verify_jwt = true` — a control that looks like one and is not — and it is why the
earlier audit's framing ("someone granted anon") was wrong.

### Scope, measured

| | count |
|---|---|
| functions in `public` | **502** |
| anon-executable | **434** |
| …of those, `SECURITY DEFINER` | **252** |
| …of those, no visible in-function guard | **61** |

The pattern match behind 61 has a **known false-negative rate** — it classified
`voe_employer_options` as unguarded when it in fact refuses with `not authorized`.
So 61 is an **upper bound**, and every candidate has to be probed, not read.

This is not a 24-function problem, and the next function anyone writes will be
born the same way. A durable fix is a default-privilege change plus an explicit
`revoke` in the function-creation template, not 61 one-off revokes.

## Why the proof bar was higher here

The only caller is the **`quote-reply-poll` edge function** (cron job 50, `*/10`)
via `svcHeaders()` — the service key. There is no browser caller.

Its failure branch:

```ts
if (!mrsp.ok) {
  results.push({ mailbox, gmail_message_id: id, error: `match failed: ${await mrsp.text()}` })
  continue
}
```

It does not throw. It records the error in a response body **that nothing reads** —
cron invokes the function with `net.http_post`, and pg_net's **5-second default
timeout is shorter than the poller's runtime**, so `net._http_response` stores a
timeout rather than the result. Measured directly: request `429410` came back
`Timeout of 5000 ms reached`.

**A broken grant here would have stopped reply correlation indefinitely, silently** —
the correlation that was only just built.

## Proof, three layers, none inferred from the revoke succeeding

**Role level** — becoming the roles rather than re-reading the catalogue I had
just written:

```
set local role service_role -> matched_by=address_unique  contact_id=599b4b4a-…
set local role anon         -> permission denied (42501)
```

**Over HTTPS**, the actual attack path, public anon key:

```
STEP 1  quote_reply_match -> 42501 "permission denied for function quote_reply_match"
        no contact_id returned — chain does not complete
```

**End to end**, which is the one that matters given the silent caller. The real
poller, invoked the way cron invokes it (`net.http_post` +
`internal_call_headers()`), with `timeout_milliseconds := 120000` so the response
was readable at all. Response `429414`, status **200**:

```json
{"ok":true,"lookback_days":14,
 "mailboxes":["processing@ratesandrealty.com","rene@ratesandrealty.com"],
 "counts":{"considered":120,"skipped_self":35,"recorded":1,"duplicate":84,
           "in_reply_to":1,"token":0,"address_unique":0,
           "ambiguous_address":0,"unmatched":84}}
```

**`in_reply_to: 1`** — `quote_reply_match` was called and matched a real reply
*after* the revoke, and no result carries `match failed`. Correlation is intact.

## The revoke

```sql
revoke execute on function public.quote_reply_match(…) from public;
revoke execute on function public.quote_reply_match(…) from anon;
```

Both lines required: `=X/postgres` is the PUBLIC grant and `anon` inherits it, so
revoking `anon` alone would have changed nothing while returning success.

The migration **asserts** in its own body that `service_role` and `authenticated`
still hold EXECUTE, so a future edit that drops them fails loudly rather than
quietly.

Final `proacl`: `{postgres=X, authenticated=X, service_role=X}`.

## Next

`voe_match_reply` is the identical shape — same oracle behaviour for VOE, same
service-role caller (`voe-inbound-poll`), same silent failure branch. Then
`hoi_quote_list`, which is the second half of the chain and has a browser caller,
so it needs the page re-checked rather than a poller run.

Then the three low-sensitivity reads (`hoi_quote_meta`, `voe_form_get`,
`order_document_status`) and `voe_form_set` as tidy-up.

**But the 61-candidate sweep and the default-privilege fix are the larger piece**,
and doing those first would make most of the individual revokes unnecessary.

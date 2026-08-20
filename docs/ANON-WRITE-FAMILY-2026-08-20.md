# The three anon-executable VOE writes — what each can actually do

Reported before any `voe_match_reply` retirement, as instructed. **Probed, not
read** — the family audit's own rule, because its guard-detection pattern has a
known false-negative rate.

## Result: all three refuse. The anon grant is defence-in-depth, not exposure.

Probed over HTTPS with the public anon key, all-zeros uuids so that an unguarded
`UPDATE` would match nothing:

```
voe_set_thread    ->  P0001  "staff only"
voe_request_log   ->  P0001  "staff only"
voe_log_inbound   ->  P0001  "not authorized"
```

**Nothing was written.** Verified afterwards: 0 rows in `email_log` matching the
probe, 0 in `loan_orders`, and no order exists at the all-zeros uuid.

`P0001` is a `raise exception` from inside the function — the guard firing — not
`42501`, which would be the grant refusing. That distinction is the whole point:
these functions are reachable by anon and stop it themselves.

## What each would do if the guard were ever removed

Worth stating, because the guard is now the *only* control on each.

| function | writes | what an anonymous caller would get |
|---|---|---|
| `voe_set_thread(order_id, …)` | `UPDATE loan_orders` — `gmail_message_id`, `gmail_thread_id`, `rfc_message_id`, `voe_reply_token` | **Hijack reply correlation.** Setting `voe_reply_token` on someone else's order redirects which replies bind to it. Needs a known `order_id`. |
| `voe_request_log(order_id, contact_id, hr_*, employer, subject, body)` | `UPDATE loan_orders` (employer + **HR name/email/phone**) + `INSERT email_log` | **Rewrite where a VOE gets sent.** Overwriting `hr_contact_email` redirects the employment verification for a real borrower to an attacker's address, and plants a log row. The sharpest of the three. |
| `voe_log_inbound(gmail_message_id, …)` | `INSERT email_log` (`direction='inbound'`, `template='voe_request'`) + touches `loan_orders.updated_at` | **Fabricate a reply.** Injects a message into a borrower's timeline attributed to a VOE thread. It calls `voe_match_reply` internally to decide whose record it lands on — the matcher documented as guessing wrong across borrowers. |

The guards themselves:

```sql
-- voe_set_thread, voe_request_log
if not (public.is_admin() or coalesce(public.current_app_role(),'')
        in ('va','loa','agent','staff')) then raise exception 'staff only'; end if;

-- voe_log_inbound  (additionally allows the poller)
v_role := current_setting('request.jwt.claims',true)::jsonb ->> 'role';
if not (public.is_admin() or v_role = 'service_role'
        or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff'))
   then raise exception 'not authorized'; end if;
```

All three are `SECURITY DEFINER` with `SET search_path TO 'public'`.

## So the retirement is not blocked

The hold was placed in case these were live anon writes. **They are not.** The
read-side oracles were genuinely open and are now closed; the write side was
guarded all along — the same finding as `loan_order_set` and `voe_form_set` in
pass 1, where the revoke was defence in depth rather than a fix.

`voe_match_reply` retirement can proceed on its own schedule per
`docs/RETIRING-voe_match_reply-2026-08-20.md`. One thing that report said is now
sharper: **`voe_log_inbound` is the reason to keep `voe_match_reply` around, or to
drop both together.** `voe_log_inbound` calls `voe_match_reply` internally, so
dropping the matcher breaks it. They retire as a pair, or not at all.

## What is still worth doing, in priority order

1. **Revoke anon+PUBLIC on all three anyway** — defence in depth, zero risk
   (no browser caller sends anon to any of them), and it removes the need for a
   future reader to re-derive that the guard is the only control. Same treatment
   `loan_order_set` received.
2. Decide `voe_log_inbound`'s fate together with `voe_match_reply`, not
   separately.
3. The remaining backlog is unchanged: **319 application functions are still
   anon-executable**, and the event trigger stops only new ones.

**Correction to the earlier framing.** I flagged these three as "anon-executable
WRITES — the write side is not closed", implying live exposure. That was reasoning
from the grant, which is exactly the mistake the audit warns against. Probed, all
three refuse. The grant is untidy; it is not a hole.

---

# CLOSED — 2026-08-20

`voe_set_thread` and `voe_request_log`: anon + PUBLIC revoked as defence in depth.
Both keep `authenticated`, asserted in the migration, because both have live
browser callers on a session JWT (`admin/lead-detail.html:14836` and `:15623`).

The proof that the revoke took is the **change in error class**:

```
before   voe_set_thread  ->  P0001  "staff only"                 (the in-function guard)
after    voe_set_thread  ->  42501  "permission denied for function voe_set_thread"
```

`voe_log_inbound` was not revoked — it was **dropped**, together with
`voe_match_reply`. See `docs/RETIRING-voe_match_reply-2026-08-20.md`.

`crm_health` (view): anon revoked. It was never a disclosure — it returned a
statement timeout — but an anonymous caller able to make the database run a query
to exhaustion is a small denial-of-service surface, and nothing in the tree reads
the view (`dashboard/admin.html` calls the *function* `crm_health_check_rpc()`).
Now 42501.

Public surface re-verified after all of it: `video_get_public`,
`get_cma_snapshot`, `get_fee_sheet_snapshot` all HTTP 200.

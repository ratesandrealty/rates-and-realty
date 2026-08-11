# Reports: dead-cron correction, escrow index design, masking sweep

## 1. The "three dead cron functions" — I WAS WRONG

I reported `refi-watch`, `critical-date-reminders` and `post-close-followups` as
having no caller and never having had one. **That was wrong, and the error was in
my method: I checked `cron.job` and the repo, and never enumerated n8n.**

All three are wired, active and scheduled — in n8n, not pg_cron:

| function | n8n workflow | schedule | active |
|---|---|---|---|
| `critical-date-reminders` | `f1udN0aJRWAb1wqw` Critical Date Reminders | daily 15:00Z | yes |
| `refi-watch` | `ytTeqc76TVymCQGN` Refi Opportunity Watch | Mon 15:00Z | yes |
| `post-close-followups` | `aI0ADzLLDDv0R1qM` 5-Month Post-Close Touchpoint | daily 15:00Z | yes |

Each is: schedule trigger → HTTP POST with `x-cron-key` → splitOut → **create a
ClickUp task** in list `901708416155`.

**What they do.** `critical-date-reminders` scans `loan_key_dates` and raises a
task at 3 days out, 1 day out and day-of, deduped through
`loan_key_dates.reminders_sent`. `refi-watch` compares each past client rate to
the latest `market_rates` row and raises a task for anyone 0.50%+ above market,
with an AI-written note. `post-close-followups` raises a 5-month touchpoint task
for closed loans.

**Is any of it happening another way?** Partly. `loan-date-nudges` (pg_cron 38)
covers similar ground for critical dates but delivers an SMS digest to staff
rather than ClickUp tasks, and writes `nudge_sent`, not `reminders_sent`. The
refi and post-close jobs have no other implementation.

**The tell I had and misread:** `loan_key_dates.reminders_sent` is populated on
14 of 22 rows, June–August, and nothing in the repo writes that column except
`critical-date-reminders`. I saw that data and still concluded the function was
dead. Evidence that something RAN should have outranked evidence that nothing
called it.

`refi_alert_last_at` and `post_close_task_at` are 0 rows — consistent with those
two running and finding nothing to do (6 closed loans, none 5 months old, none
0.50% above market), not with never running.

### Consequence: the key rotation broke all three, and it is repaired

The rotation killed the old literal. All three n8n HTTP nodes still carried it,
so each would have started returning 401 — silently, because nothing watches n8n
executions. Caught roughly 8 hours before the next daily run.

All three workflow nodes now send the vault value (recorded in n8n version
history). The secret lives in the vault and in n8n — the caller has to hold it —
and no longer in git.

**The general lesson: "no caller" only ever meant "no caller I looked for."**
n8n is a caller class I never enumerated, and it reaches edge functions over
plain HTTPS with a header. Anything else called uncalled should be re-checked
against n8n before being believed.

## 2. Second escrow/title per file — design only, NOT applied

Both dependencies must be fixed BEFORE the index changes.

### a) `lead-detail.html:10724` must fail loudly, not blank the field

```js
.eq('contact_id',cid).eq('order_type','escrow').maybeSingle()
```

`.maybeSingle()` errors on more than one row, and the surrounding
`catch(_){ _lpEscrowRef=''; }` swallows it — so the field renders an em dash and
the number simply disappears. Silent, and indistinguishable from "not entered
yet", which is the worst possible reading of "two escrow orders exist".

Replace with an explicit list and make ambiguity visible:

```js
const _eo = await _authClient().from('loan_orders')
  .select('id,reference,status').eq('contact_id',cid).eq('order_type','escrow')
  .order('ordered_at',{ ascending:false, nullsFirst:false });
if (_eo.error)                    -> render "could not load", not an em dash
else if ((_eo.data||[]).length>1) -> render a picker, labelled "2 escrow orders"
else                              -> today's behaviour
```

`nullsFirst:false` is deliberate: Postgres sorts NULLS FIRST under DESC, which is
how `matchContact` rule 2 picked an order that had never been placed.

### b) `loan_order_set` must refuse, not pick

Today it does `select id ... where contact_id = ... and order_type = ... limit 1`
and edits whatever comes back. With two rows that is an arbitrary choice, made
silently, on a row a human believes they are editing by name.

It must instead:

- `p_order_id` given → operate on exactly that row (already true today);
- exactly one row matches → operate on it;
- more than one matches → `raise exception` naming the count and requiring
  `p_order_id`.

Same rule as every other tie-break here: an ambiguous match is an error, not a
coin toss. Every UI path that lists orders already holds the id, so the exception
is only reachable from callers that genuinely cannot tell.

### Order

(a) and (b) shipped and confirmed first. Only then relax the index to
`(contact_id, order_type, borrower_contact_id)` or drop it. Not before — the
constraint is currently the only thing preventing both failures.

## 3. SECURITY DEFINER functions returning unmasked borrower contact details

24 SECURITY DEFINER functions in `public` read borrower email, phone or date of
birth. SECURITY DEFINER bypasses RLS and any masking, so each one is a path
around what the lead pages show a VA.

**17 carry a role check** (`is_admin()` / `current_app_role()`):
`contact_related_people`, `copilot_priority_leads`, `copilot_search_leads`,
`dashboard_command_center`, `dialer_sources_list`, `email_recipient_search`,
`esign_merge_resolve`, `esign_people_search`, `esign_signer_suggestions`,
`partner_leads`, `power_dialer_counts`, `power_dialer_match_count`,
`power_dialer_queue`, `recipient_search`, `share_recipients`, `sms_blast`,
`va_daily_tasks`.

A check is not the same as the RIGHT check — most of these deliberately allow
`va`, which is the point of the features — but they at least ask.

**7 have NO role check, and `authenticated` can EXECUTE all seven:**

| function | returns | why it matters |
|---|---|---|
| `get_lead_people(p_contact_id, p_application_id)` | **DOB + email + phone** | widest: any signed-in user, any contact_id |
| `hoi_quote_prefill(p_contact_id)` | **DOB + email + phone** | the one already flagged |
| `voe_prefill(p_contact_id)` | email + phone | |
| `app_notify_mentions(...)` | email + phone | trigger helper, but directly callable |
| `is_phone_suppressed(p_phone, p_contact_id)` | boolean | an oracle: confirms whether a number belongs to a contact |
| `sync_application_to_contact()` | — | trigger function, no args |
| `tg_loan_contacts_sync_directory()` | — | trigger function |

**So `hoi_quote_prefill` is not the only one — it is one of three that hand any
signed-in user a borrower date of birth and contact details for any contact_id
they name.** `get_lead_people` is the more serious of them: same argument shape,
already used by the lead page, and it returns DOB too.

This does not make the HOI change wrong — Rene confirmed consent and the modal
needs those fields. It does mean the masking on the lead pages is worth exactly
what these seven allow, which today is everything.

Cheapest fix, matching what the other 17 already do: add
`if not (is_admin() or coalesce(current_app_role(),'') in ('va','agent','loa'))
then raise exception 'staff only'; end if;` to the four directly-useful ones, and
`revoke execute ... from authenticated` on the two trigger functions.

**Not applied. This is a report.**

# The nightly lead scoring has never covered the book

Found while merging the two duplicate cron jobs. The duplicate was real and is
now fixed. It was not the important problem.

## The measurement

`contacts.last_scored_at` is the coverage signal. `lead_score_history` is not —
it records a row per scoring *call*, so it counts work done, not contacts
covered, and it double-counts when two jobs run at once.

| | |
|---|---|
| live contacts (`merged_into_contact_id is null`) | **1043** |
| scored in the 2026-08-11 12:00Z nightly window | **346** |
| **never scored at all** (`last_scored_at is null`) | **243** |
| oldest surviving score | 2026-06-15 |

243 contacts have no lead score and never have had one. Every consumer of
`lead_score` — `lead-tiers.js`, the pipeline board, `dashboard/admin`,
`ai-sms-bot`, `campaign-audience-resolve` — has been ranking a book with a
quarter of it missing, and nothing says so.

## The cause: the worker is killed, not timed out

Measured directly. One invocation, `{"action":"score_all","limit":5000}`,
`timeout_milliseconds := 300000`, fired 22:57:58Z:

```
status 546  {"code":"WORKER_RESOURCE_LIMIT",
             "message":"Function failed due to not having enough compute resources"}
```

It ran **89 seconds**, scored **339 of 1043**, and was killed by the Supabase
edge runtime. Throughput was steady at ~3.7 contacts/sec throughout — it did not
slow down, it stopped. At that rate 1043 contacts needs ~285s of a budget that
ends around 90.

This is why 2026-08-11's nightly wrote 586 history rows across two concurrent
invocations and stopped dead at 12:01:24: both were killed at the same limit.

**`timeout_milliseconds` is pg_net's patience, not a kill switch.** It governs
how long Postgres waits for a reply; the edge function keeps running either way.
So job 18's 60s timeout never truncated any work — it only meant the reply was
never recorded. What job 18 lost was *observability*, not coverage. My earlier
note that it "times out every night" described the symptom and named the wrong
mechanism.

## What the merge does and does not fix

Done as instructed: job 18 now carries the right body (`limit: 5000`) and the
right timeout (300000), job 12 is unscheduled, snapshot in
`public.cron_lead_scorer_merge_20260811`.

That is a real improvement — one job instead of two, no duplicate history rows,
and a response that gets recorded. **It does not fix coverage**, and tomorrow's
12:00Z run will not cover 1043. It will score ~339 and return 546. Config was
never the binding constraint.

Coverage will in fact drop slightly, from ~359 distinct to ~339: two overlapping
unordered passes happened to touch a few more contacts than one does. That is an
argument for fixing the batching, not for keeping the duplicate.

## The fix, MADE and proven 2026-08-12

Both changes shipped. Measured immediately after, calling the job's exact
mechanism:

```
200  {"success":true,"scored":200,"batch_size":200,"requested_limit":5000,
      "live_contacts":1043,"never_scored_remaining":19,"errors":0}
```

**200, not 546.** And `never_scored` fell from **219 to 19** in a single run —
the ordering put the never-scored first exactly as intended, so one batch of 200
consumed almost the entire backlog. (219 rather than the original 243 because
the diagnostic run that found this had already scored some of them.)

The clamp is visible in the response — `requested_limit: 5000, batch_size: 200`
— rather than silently ignoring what the caller asked for.

### How many nights to come round, and is that acceptable

**At 200 per night: 1043 ÷ 200 ≈ 6 nights.** That is not a nightly scorer, and
it is not acceptable as an end state. A lead scored six days ago has missed a
week of calls, texts and portal activity — which is the entire input to an
engagement score.

It IS acceptable as of tonight, because the thing that made it urgent is gone:
the never-scored backlog is down to 19, so nobody is invisible any more. The
remaining problem is staleness, not absence, and staleness degrades gracefully
where absence does not.

**This should be a chunked job, and the ordering means it needs no cursor.**
Because every run takes the stalest first, running the *same job more often*
walks the whole book with no state to keep:

| cadence | runs/day | capacity/day | vs 1043 |
|---|---|---|---|
| daily (now) | 1 | 200 | 6 days to come round |
| every 3 hours | 8 | 1600 | **full coverage daily, 53% headroom** |

That is a one-line schedule change to job 18 — `0 */3 * * *` — and no code. It
is NOT made: it changes cadence, which is the user's call, and 8× the runs is 8×
the compute.

## The original fix as scoped, for the record

`score_all` reads:

```js
const { data: ids } = await sb.from("contacts").select("id")
  .is("merged_into_contact_id", null).limit(body.limit || 1000);
```

There is no `ORDER BY`. PostgREST returns rows in whatever order Postgres
supplies, so each run scores an arbitrary ~339 and the same contacts can be
missed indefinitely — which is exactly how 243 have never been scored once.

Two changes, both small:

1. **`.order('last_scored_at', { ascending: true, nullsFirst: true })`** — the
   stalest contacts go first, so the 243 never-scored are scored tonight and the
   book rotates instead of resampling. This alone converts a permanent blind
   spot into a bounded staleness of about three days.
2. **A limit that fits the compute budget** (~300), so the function RETURNS 200
   instead of dying at 546. A run that reports what it did can be monitored; a
   run that is killed cannot.

Full nightly coverage needs the work split across invocations — a cursor, or the
job firing N times — and that is a larger change than either of the above. Order
first: it is three tokens, it is strictly better than random, and it makes the
gap shrink every night rather than persist.

## Watch this, not the job status

```sql
select count(*) filter (where last_scored_at >= current_date + time '12:00') as scored_today,
       count(*) filter (where last_scored_at is null)                        as never_scored,
       count(*)                                                              as live
from contacts where merged_into_contact_id is null;
```

`cron.job_run_details` says `succeeded` for a run that was killed at 89 seconds,
because it only means the request was queued. `net._http_response` shows the
546. Neither tells you how many contacts have a score.

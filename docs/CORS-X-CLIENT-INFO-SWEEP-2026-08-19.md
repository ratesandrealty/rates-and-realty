# The 25 latent CORS functions — closed 2026-08-19

Every edge function with a browser caller now allows `x-client-info` back on its
preflight. This closes the trap that took `voe-form-fill` off the page for eleven
days while every server-side check stayed green.

## What was latent, and why "latent" was the right word

`supabase-js` attaches `x-client-info` to every `functions.invoke()`. A preflight
that does not allow back **every** header the browser asked for fails, and the
browser then abandons the request and never sends the POST. What the user sees is
`Failed to send a request to the Edge Function` — a **client-side**
`FunctionsFetchError` that reads like the function is down, missing or
undeployed.

These 25 were not broken. Every one of them is called with a **hand-built
`fetch()`**, which sends only the headers the caller chose, so a narrow allow-list
survives. They were one refactor from breaking: converting a call to
`functions.invoke()` — the obvious tidy-up — breaks it instantly, **with no change
to the function to explain it**, and the error points at the server.

That asymmetry is the whole reason this was worth a pass of its own. The fix
costs one token per function. Diagnosing it costs eleven days.

## The 25

All were missing exactly one header, `x-client-info`, and nothing else.

| function | browser callers (raw `fetch`, unchanged) |
|---|---|
| `activity-tracker` | `admin/communications.html`, `admin/lead-detail.html` |
| `automation-config` | `admin/settings.html`, `dashboard/utils/clickup-automations.js` |
| `borrower-drive` | `admin/lead-detail.html` |
| `bot-admin` | `dashboard/admin.html` |
| `calendar-data` | `dashboard/utils/calendar.js` |
| `clickup-bridge` | `admin/js/task-capture.js`, `admin/lead-detail.html`, `admin/va-tasks.html`, +3 dashboard utils |
| `clickup-lender-sync` | `admin/lead-detail.html`, `admin/lenders.html` |
| `commercial-ai` | `admin/lead-detail.html` |
| `commercial-intake` | `admin/commercial-intakes.html` |
| `commercial-match` | `admin/lead-detail.html`, `admin/lenders.html` |
| `communications-admin` | `dashboard/admin.html` |
| `convert-to-pdf` | `admin/lead-detail.html`, `components/admin-dashboard.js` |
| `emc-lender-import` | `admin/emc-import.html` |
| `esign` | `admin/lead-detail.html` |
| `extract-conditions` | `admin/lead-detail.html` |
| `guidelines-ai` | `admin/lead-detail.html` |
| `insights-data` | `admin/insights.html`, `dashboard/utils/insights.js` |
| `lead-scorer` | `admin/lead-detail.html` |
| `lender-guidelines` | `admin/lead-detail.html` |
| `news-feed` | `dashboard/admin.html` |
| `people-admin` | `admin/people.html` |
| `save-document` | `admin/lead-detail.html` |
| `submit-lead` | `api/public-api.js` |
| `tours-admin` | `admin/lead-detail.html`, `admin/showings.html`, `admin/tour-builder.html` |
| `va-help` | `admin/va-tasks.html` |

## What was deliberately NOT done

**No caller was converted from `fetch()` to `functions.invoke()`.** That is the
change that would break these, and it is a separate deliberate decision per
caller. Doing both in one pass would mean that if a page broke, the header and
the call style both changed and neither could be ruled out — the same
two-things-at-once mistake `email-service` cost twelve minutes of 401s to learn.

The conversion is now *safe* to make, one caller at a time, with the page
exercised after each. It is not required by anything.

## One token per file, on purpose

The 25 functions quote, space, order and case their header lists differently. The
patch parses each list and rewrites it **in that file's own style**, so every hunk
in a 25-file diff is the same single addition. A canonical replacement line would
have produced 25 unrelated-looking diffs and hidden any real change among them.

## The part that was not free: 13 unpinned slugs

`tools/deploy-function.sh` refuses to ship a slug that is not pinned in
`supabase/config.toml`. Thirteen of the 25 were unpinned:

`automation-config`, `borrower-drive`, `bot-admin`, `clickup-lender-sync`,
`commercial-ai`, `commercial-intake`, `commercial-match`, `convert-to-pdf`,
`emc-lender-import`, `guidelines-ai`, `lender-guidelines`, `save-document`,
`submit-lead`.

**Each was read off the live function first** (`supabase functions list`: all
thirteen ACTIVE, `verify_jwt = false`) and pinned at that measured value. This
records what was already true and changes nothing about who can reach them. The
refusal is the rule working: an unpinned slug is one the CLI can silently default
to `true`, which is how every `send-scheduled-sms` cron run returned
`UNAUTHORIZED_NO_AUTH_HEADER` for days with nothing alerting.

**Re-read after deploying, because pinning at a measured value is only safe if
the deploy did not move it.** All 13 checked again once live: pre-deploy value ==
pin in `config.toml` == live value == `false`, all ACTIVE, and every version
incremented by exactly one (e.g. `submit-lead` v35→v36, `borrower-drive` v72→v73)
— one deploy each, no value moved. The wrapper asserts this per deploy too; this
is the independent read, because the thing being checked is precisely whether the
deploy changed what was pinned.

**A pin is not a guard.** Several of these are `false` with no in-function check,
which means open — `borrower-drive` and `save-document` both hold service-role
access to borrower records. Pinning them did not close them, and this pass did not
claim to. They remain tracked in `docs/PINNED-NOT-GUARDED.md` and
`docs/OPEN-ENDPOINTS-2026-08-11.md`.

## Verification

```
node tools/browser-cors-check.mjs
```

| | swept | ok | latent | blocked |
|---|---|---|---|---|
| before | 55 | 30 | **25** | 0 |
| after | 55 | **55** | **0** | 0 |
| after, with the discovery gap below closed | **63** | **63** | **0** | **0** |

### Reconciling with the 64 in `d90d1bc`

That figure was **`--all`**, not this sweep: 141 functions, 64 latent, *of which 25
had a real browser caller via raw `fetch()`*. Those 25 are exactly the ones fixed
here. The other 39 had no browser caller.

Today `--all` sweeps **128** functions and reports **38** latent. Both numbers
moved, for reasons that are individually accounted for:

- **141 → 128 functions.** Directory count, not a measurement — `supabase/functions`
  holds 128 dirs today.
- **64 → 38 latent.** −25 fixed here, and −1 for `generate-1003`, which was
  undeployed and deleted on 2026-08-19 and had been in the no-browser-caller half.
  64 − 25 − 1 = 38, which is what it reports.

All 25 deployed through `tools/deploy-function.sh`, one at a time, stopping at the
first failure. None failed. Each run re-read the live function afterwards and
confirmed deployed source matches this repo and `verify_jwt` matches its pin.

### The sweep was covering 8 fewer functions than it appeared to

Found while reconciling the count against the figure in `d90d1bc`. The tool
discovered browser callers with two patterns — `functions.invoke('slug')` and
`functions/v1/slug`. **`admin/js/fn-call.js` introduced a third**: `fnFetch('slug')`
names the function without the `/functions/v1/` path, so it matched neither.

Eight real browser callers had silently dropped out of the default sweep:
`call-intelligence`, `delete-contacts`, `generate-1003-pdf`, `generate-cma`,
`generate-deal-analysis`, `generate-mismo`, `generate-mismo-data`, `pull-comps`.
The run still printed OK, because a slug it never checked cannot fail.

**All eight allow `x-client-info` already**, so nothing was hidden — but nothing
would have *said* so if they had not, and that is the same shape as every other
trap in `CLAUDE.md`: the check reported fewer problems than existed, which reads
as good news and therefore survives. The irony is specific: `fn-call.js` exists to
migrate call sites off hand-rolled fetches, so **the more that migration
progressed, the blinder this checker became.**

`discoverSlugs()` now matches `fnFetch(` too, classified as `fetch` rather than
`invoke` — it builds a raw fetch and chooses its own headers, so it sends no
`x-client-info` and survives a narrow allow-list exactly like a hand-rolled one.

Default sweep: **55 → 63 slugs**, all ok.

### What `--all` still reports, and why it is not this list

`node tools/browser-cors-check.mjs --all` sweeps every function in the repo, not
just the ones a browser calls, and reports **38 latent**. Every one of those is
`[no browser caller found]` — the count went from 25-with-callers to 0, and these
38 are a different population, not a remainder of the same one.

Most of them *should* look like this. They are webhook and cron endpoints —
`twilio-inbound`, `stripe-webhook`, `calcom-webhook`, `send-scheduled-sms`,
`post-close-followups`, `market-rate` — whose callers are Twilio, Stripe, Cal.com
and pg_cron. **None of those is a browser, so none sends a preflight**, and the
several that answer `401`/`403`/`405`/`404` to an OPTIONS are behaving correctly.
Adding CORS headers there would be cargo-cult: it would not fix anything, and it
would imply a browser audience the endpoint does not have.

The distinction that matters is the one this pass acted on: **a function with an
existing browser caller and a narrow allow-list is one refactor from an outage.**
A function with no browser caller is not — giving it one is a deliberate act that
would surface the problem immediately.

**What a green sweep does NOT prove.** It reads one header off one preflight. It
says the browser will be allowed to send the request — not that the response is
correct, and not that any page works. The authoritative check is a real browser
making a real `supabase-js` call, which is what `tools/browser-fn-probe.mjs <slug>`
does through the page's own library. Since no caller changed here, no page
behaviour should have changed either; this pass removed a future failure, not a
present one.

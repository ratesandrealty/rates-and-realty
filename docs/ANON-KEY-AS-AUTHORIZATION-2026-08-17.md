# Staff pages that read as the ANONYMOUS role

Read-only. Nothing changed: no guard, no policy, no deploy, no frontend edit.

The question was whether `dashboard/admin.html:3817/:3823` is one instance of a
pattern. **It is** — inside that file and across the staff surfaces — and the
list matters now rather than after `public_read_showings` closes.

## The distinction

`apikey: <anon>` is correct on every call. It identifies the PROJECT.

`Authorization: Bearer <anon>` is the problem. That header is what identifies the
USER, and the anon key identifies nobody, so the call runs as the **anonymous
role no matter who is signed in**. RLS then answers as if a stranger asked.
Those calls work today only because the policies they hit still permit anon.

## The finding that changes the immediate plan

**There is a FIFTH showings reader, and it is not on the list we have been
working from.**

```
admin/lead-detail.html:21982   /rest/v1/showings?select=id,batch_id,…  headers:{apikey:SK_S, Authorization:'Bearer '+SK_S}
                               SK_S = window.APP_CONFIG?.SUPABASE_ANON_KEY
```

That is the tours/stops panel on the staff lead-detail page. It pulls
`agent_notes_for_lead`, `lead_rating`, `lead_feedback` and the listing agent's
contact details. **Closing anon SELECT on `showings` breaks it.**

The same function shows the pattern in miniature: fourteen lines earlier, at
`:21968`, the sibling call to `tours-admin` correctly sends
`'Bearer '+_tkS` from `await _getUserAccessToken()`. One call authenticates the
user, the next does not, inside one `Promise.all`.

So the blockers on closing `showings` reads are now **two**, both staff:

| | |
|---|---|
| `dashboard/admin.html:3817, :3823` | showings widget |
| `admin/lead-detail.html:21982` | tours / stops panel |

## dashboard/admin.html, in full

Ten Supabase call sites. **Six run as anonymous:**

| line | endpoint | how |
|---|---|---|
| `:1593` | `rpc/market_watch_strip` | `Authorization:'Bearer '+KEY` |
| `:3711` | `contacts` | `Bearer ${SB_KEY}` |
| `:3817` | `showings` | `Bearer ${SB_KEY}` |
| `:3823` | `showings` | `Bearer ${SB_KEY}` |
| `:4203` | `activity_events` | via `_SB_HEADERS` (`:4167`) |
| `:4819` | `contacts_secure` | via `_SB_HEADERS` (`:4167`) |

**Two correctly use the session**, and one of them already carries the argument
in a comment at `:3775`:

> *"Authorization must be the SIGNED-IN USER, not SB_KEY — that is the anon key
> … apikey stays anon: that is the project identifier."*

That comment is right and is the fix for all six. It just was not applied to
them.

## Across the staff surfaces

85 files scanned, 73 `/rest/v1/` call sites. Roughly **30 read as anonymous**.
Grouped by the header they use, because the fix is per-helper, not per-call:

**Shared helpers that hardcode the anon key** — fixing one helper fixes every
caller of it:

| helper | defined | callers |
|---|---|---|
| `H` | `admin/drip-builder.html:357` | `:385 :451 :471 :864 :872 :915` |
| `H()` | `admin/referral-partners.html:213` | `:366 :441 :446 :451` |
| `H` | `admin/communications.html:117` | `:165 :166 :167 :181` |
| `_SB_HEADERS` | `dashboard/admin.html:4167` | `:4203 :4819` |
| `hdr` | `admin/lead-detail.html:24366, :24431` | those two blocks |
| `_lhHdr()` | `admin/lead-detail.html:33962` | link-history panel |

**Inline anon, no helper:** `admin/commercial-intakes.html:95 :164 :238` ·
`admin/email-marketing.html:789 :1824` · `admin/js/dialer.js:453` ·
`admin/lead-detail.html:21982 :22721 :22770 :22809 :22847` ·
`assets/js/tour-builder.js:102 :116` · `assets/js/utils.js:62` ·
`components/admin-dashboard.js:1607` · `dashboard/admin.html:1593 :3711 :3817 :3823`

**No `Authorization` header at all** — also anonymous, and easy to miss because
there is nothing to read: `admin/communications.html:199 :216` ·
`admin/drip-builder.html:919 :933` · `admin/lead-detail.html:21130 :25437 :26032`
· `dashboard/utils/calendar.js:391 :402`

## Helpers that are already correct

Worth naming so nobody "fixes" them:

- `losHeaders()` — `admin/lead-detail.html:28633` — reads the session JWT from
  localStorage, falls back to anon only if there is no session.
- `_atHeaders()` — `admin/communications.html:133` — sends `_atTok`.
- `hdrs` — `admin/lead-detail.html:28523` and `:40827` — `_sjwt || anon`.
- `H` — `admin/earnings-dashboard.html:261` — **starts anon and is REASSIGNED to
  the session token at `:274`.** Correct once the token arrives; a call firing
  before that line runs would go out anonymous. Worth a look, not a listing.

## How this was produced, and where it is soft

`tools/_authaudit2.mjs` (not committed — a throwaway) scanned every tracked
`.html`/`.js` under `admin/`, `dashboard/`, `components/`, `assets/js/`, `api/`,
found `/rest/v1/` call sites and classified the identifier in `Authorization`.
Every shared helper it named was then **read by hand** and is quoted above.

Two things it got wrong first, both worth knowing because both under-reported:

1. The glob was passed through `execSync`, which uses cmd.exe on Windows where
   single quotes are literal. It matched nothing and printed **"0 call sites"** —
   a clean bill of health produced by a broken query.
2. The classifier captured the literal word `Bearer` instead of the identifier
   after it, filing 42 resolvable sites as "unknown".

Counts here are approximate at the margins; the named sites are verified.

## What this does not say

Not every anon read is a vulnerability. Several of these tables have policies
that permit anon deliberately, and the pages work today. What the list is FOR is
narrower: **these are the call sites that change behaviour the moment an anon
policy is tightened**, and `showings` is the one about to be tightened.

The fix in each case is the same and is already written down at
`dashboard/admin.html:3775`: keep `apikey` anon, put the user's session token in
`Authorization`. Doing that for the two showings blockers is the prerequisite for
closing `public_read_showings`; the rest can follow at their own pace, each
confirmed on its own page.

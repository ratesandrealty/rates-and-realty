# Edge function capability map

The 109 edge functions that `docs/PINNED-NOT-GUARDED.md` does not cover, grouped
by what each one can actually **do** — because the order they get worked in
should follow blast radius, not alphabet.

Generated 2026-08-07. **Read-only audit: nothing here was changed or deployed.**

## How the scope was derived

```
directories in supabase/functions/              129
minus _shared (no index.ts, not a function)      -1
= actual edge functions                         128
minus the 19 tiered in PINNED-NOT-GUARDED.md    -19
= in scope                                      109
```

**This is 109, not the 53 previously quoted.** That figure was mine and it was
wrong: I subtracted the doc's 19 from the 72 functions with no in-function auth,
but those are different sets measured by different criteria — the doc's 19 are
pinned `verify_jwt = true` and unguarded, which is not the same as "has no
in-function check". Only 5 of the 19 appear in the no-auth set at all, so the
subtraction was meaningless. The honest number is every function minus the ones
already documented: **109**.

## What counts as "auth found"

Only a check that **validates a claim**. Per the brief, and applied literally,
these do NOT count and are recorded as `none`:

- `verify_jwt` in `config.toml` — the anon key satisfies it and is public
- merely constructing a Supabase client
- reading an `Authorization` header without validating it
- testing that a header is non-empty

Four things were miscredited on earlier passes and are corrected here. Each is
the same mistake — matching text that mentions a control rather than performs
one:

| function | what matched | why it is not authorization |
|---|---|---|
| `proactive-followups` | `// Authorized via x-cron-secret header…` | a comment |
| `gdrive-health-monitor` | `.from("auth_user_roles")` | inside `notifyInCrm()` — finds admins to NOTIFY |
| `loan-date-nudges` | `sms_authorized_phones` | it is `summary.recipients` — who to text, not who may call |
| `sms-assistant` | `x-cron-secret` | a header it SENDS to ocr-mms-upload, not one it checks |

Comments are stripped before matching; string literals are deliberately kept,
because the evidence lives in them (`'x-cron-secret'` as a header name,
`'https://api.anthropic.com'` as a spend signal).

## Buckets

Most severe wins where a function spans several: **A > B > C > D**.

| | meaning |
|---|---|
| **A** | Sends messages — SMS, email, voice. Leaves the system under the business identity |
| **B** | Writes borrower data — database, Drive or storage mutations |
| **C** | Spends money or AI credits — a paid third-party API on every call |
| **D** | Read-only — no send, write or paid call found |

## Known limits of this audit

- **n8n workflows were not searched.** The n8n MCP is available but was not
  queried, so a caller living only in an n8n workflow would show as "none
  found". Treat the internal-caller column as "repo + Postgres + pg_cron", not
  as exhaustive.
- Bucket assignment is pattern-based over source. It is right about the ones
  spot-checked by hand (every bucket A row, plus the four corrections above),
  but a function that reaches a capability through an unusual helper could be
  filed one bucket too low.
- **`twilio-voice` is PARTIALLY guarded, not guarded. Corrected 2026-08-07.**
  Its bucket A row credits the signature check at L114. That check is real, but
  it sits inside `if (_isTwilioShape)` — form-encoded bodies or
  `play_voicemail` only. The five JSON admin actions (`get_token`, `make_call`,
  `voicemail_drop`, `call_status`, `log_call`) never reach it and have **no
  check of any kind**, while `verify_jwt = false` means the gateway asks for
  nothing either. Verified live: an unauthenticated POST carrying no apikey and
  no Authorization reaches the JSON dispatch and gets the function's own
  `{"error":"Unknown action: …"}` at HTTP 400, not a gateway 401.
  **The detector cannot see this class at all** — it looks for the presence of
  a check in a file, never for which code paths that check governs. Any other
  bucket A row where one function serves two caller shapes deserves the same
  re-read; `twilio-voice` was found by hand, not by the tool.
- "no browser caller found" means the string `functions/v1/<name>`,
  `invoke('<name>')` or `fnFetch('<name>')` does not appear under `admin/`,
  `dashboard/`, `public/`, `auth/`, `components/`, `assets/`, `tools/` or the
  root HTML. A dynamically assembled URL would be missed.

---

| function | bucket | auth found | credential | browser callers | internal callers |
|---|---|---|---|---|---|
| `ai-sms-bot` | A | **none** | service_role | no browser caller found | fn:bot-process-queue, fn:twilio-inbound |
| `calcom-webhook` | A | shared secret compare � L28: return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(body)); | service_role | no browser caller found | none found |
| `campaign-send-now` | A | **none** | service_role | no browser caller found | none found |
| `click-to-call` | A | **none** | service_role | no browser caller found | none found |
| `communications-admin` | A | getUser() � L49: const { data: { user } } = await u.auth.getUser(); \|\| require* helper � L39: async function requireAdmin(req: Request): Promise<{ ok: boolean; userId: string \| null; status?: number; msg? \|\| service-key comparison � L43: if (token === SERVICE_KEY) return { ok: true, userId: null }; | service_role + anon + user JWT | .claude/worktrees/conditions-doc-linking/dashboard/admin.html:3601, dashboard/admin.html:4204 | none found |
| `email-service` | A | getUser() � L43: const { data: { user } } = await u.auth.getUser(); \|\| require* helper � L24: async function requireAdmin(req: Request): Promise<{ ok: boolean; status?: number; msg?: string; uid?: string  \|\| service-key comparison � L35: if (apikey && apikey === SERVICE_KEY) return { ok: true }; | service_role + anon + user JWT | .claude/worktrees/conditions-doc-linking/admin/email-marketing.html:918, .claude/worktrees/conditions-doc-linking/admin/email-marketing.html:1553, .claude/worktrees/conditions-doc-linking/admin/js/staff-chat.js:564, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:9774, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:9805, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:11090, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:11538, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:31206, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:32388, .claude/worktrees/conditions-doc-linking/public/unified-portal.html:2989, admin/email-marketing.html:948, admin/email-marketing.html:1586, admin/js/staff-chat.js:651, admin/lead-detail.html:10163, admin/lead-detail.html:10194, admin/lead-detail.html:11573, admin/lead-detail.html:12299, admin/lead-detail.html:12886, admin/lead-detail.html:32898, admin/lead-detail.html:34080, admin/lead-detail.html:34486, public/unified-portal.html:3034 | db app_notify_mentions, send_daily_digest, send_stalled_deals_digest, tg_app_notifications_chat, tg_app_notifications_email; fn:communications-admin, fn:esign, fn:send-scheduled-emails, fn:tour-public-view, fn:tours-admin, fn:tours-send-reminders |
| `esign` | A | getUser() � L38: const { data: { user } } = await u.auth.getUser(); \|\| require* helper � L31: async function requireAdmin(req: Request): Promise<{ ok: boolean; userId: string\|null; status?: number; msg?:  | service_role + anon + user JWT | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:11507, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:12641, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:12667, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:12753, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:12801, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:12923, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:13315, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:13335, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:14752, .claude/worktrees/conditions-doc-linking/sign.html:183, admin/lead-detail.html:11992, admin/lead-detail.html:12267, admin/lead-detail.html:13665, admin/lead-detail.html:13691, admin/lead-detail.html:13777, admin/lead-detail.html:13825, admin/lead-detail.html:13947, admin/lead-detail.html:14339, admin/lead-detail.html:14359, admin/lead-detail.html:15776, sign.html:183, sign.html:183 | fn:loe-send |
| `gdrive-health-monitor` | A | **none** | service_role + user JWT | no browser caller found | cron gdrive-health-monitor-6h [7 * * * *] |
| `listing-alert-actions` | A | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:17840, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:17913, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:17923, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:18115, .claude/worktrees/conditions-doc-linking/public/listing-alerts.js:4, .claude/worktrees/conditions-doc-linking/public/unified-portal.html:2118, admin/lead-detail.html:18995, admin/lead-detail.html:19068, admin/lead-detail.html:19078, admin/lead-detail.html:19270, public/listing-alerts.js:4, public/unified-portal.html:2143 | none found |
| `listing-alert-matcher` | A | **none** | service_role | no browser caller found | none found |
| `loan-date-nudges` | A | **none** | service_role | no browser caller found | cron loan-date-nudges-daily [0 15 * * *] |
| `loe-send` | A | getUser() � L20: const { data: { user } } = await u.auth.getUser() \|\| require* helper � L13: async function requireAdmin(req: Request) { | service_role + anon + user JWT | no browser caller found | none found |
| `newsletter-signup` | A | **none** | service_role | no browser caller found | none found |
| `ocr-mms-upload` | A | shared secret compare � L112: if (secret !== SHARED_SECRET) return new Response('Forbidden', { status: 403 }) | service_role | no browser caller found | db trigger_ocr_on_uploaded_document; fn:sms-assistant |
| `portal-auth` | A | getUser() � L33: const { data, error } = await sb.auth.getUser(jwt); | service_role + user JWT | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:6609, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:25359, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:25391, .claude/worktrees/conditions-doc-linking/public/portal-auth-modal.js:6, .claude/worktrees/conditions-doc-linking/public/portal.html:790, .claude/worktrees/conditions-doc-linking/public/search-homes.html:2245, .claude/worktrees/conditions-doc-linking/public/search-homes.html:2573, .claude/worktrees/conditions-doc-linking/public/unified-portal.html:1082, .claude/worktrees/conditions-doc-linking/public/unified-portal.html:1100, .claude/worktrees/conditions-doc-linking/public/unified-portal.html:1148, .claude/worktrees/conditions-doc-linking/public/unified-portal.html:2644, admin/lead-detail.html:6957, admin/lead-detail.html:27010, admin/lead-detail.html:27042, public/portal-auth-modal.js:6, public/portal.html:791, public/search-homes.html:2257, public/search-homes.html:2633, public/unified-portal.html:1089, public/unified-portal.html:1107, public/unified-portal.html:1155, public/unified-portal.html:2689 | none found |
| `proactive-followups` | A | vault-secret check � L36: const { data } = await (db as any).rpc('cron_secret_get', { p_name: 'proactive_followups_secret' }) | service_role | no browser caller found | cron proactive-followups-digest [0 15 * * *], -urgent [0 */6 * * *] |
| `send-listing-alerts` | A | **none** | service_role + user JWT | no browser caller found | cron send-listing-alerts [*/30 * * * *] |
| `send-scheduled-emails` | A | **none** | service_role | no browser caller found | cron send-scheduled-emails [* * * * *] |
| `send-scheduled-sms` | A | **none** | service_role | no browser caller found | none found |
| `sms-assistant` | A | Twilio signature � L1104: const auth = await verifyTwilioRequest(req, rawBody, { authToken: TWILIO_AUTH_TOKEN, testKey: SMS_TEST_KEY }); | service_role + anon + user JWT | no browser caller found | none found |
| `sms-inbound-reconcile` | A | **none** | service_role | no browser caller found | cron sms-inbound-reconcile-daily [20 13 * * *] |
| `tour-public-view` | A | **none** | service_role | .claude/worktrees/conditions-doc-linking/src/worker.js:154, src/worker.js:383 | none found |
| `tours-admin` | A | **none** | service_role + user JWT | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:17713, .claude/worktrees/conditions-doc-linking/admin/showings.html:144, admin/lead-detail.html:18868, admin/showings.html:144 | none found |
| `tours-send-reminders` | A | **none** | service_role | no browser caller found | cron tours-send-reminders [*/5 * * * *] |
| `twilio-inbound` | A | Twilio signature � L139: const _sig = await verifyTwilioRequest(req, rawText, { authToken: Deno.env.get("TWILIO_AUTH_TOKEN") \|\| "", tes | service_role | no browser caller found | none found |
| `twilio-voice` | A | Twilio signature � L114: const _sig = await verifyTwilioRequest(req, _raw, { authToken: AUTH_TOKEN, testKey: Deno.env.get('SMS_TEST_KEY | service_role | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:34415, .claude/worktrees/conditions-doc-linking/admin/power-dialer.html:500, .claude/worktrees/conditions-doc-linking/admin/power-dialer.html:528, .claude/worktrees/conditions-doc-linking/admin/power-dialer.html:989, .claude/worktrees/conditions-doc-linking/admin/power-dialer.html:1078, admin/lead-detail.html:36533, admin/power-dialer.html:501, admin/power-dialer.html:529, admin/power-dialer.html:990, admin/power-dialer.html:1079 | fn:click-to-call |
| `activity-tracker` | B | getUser() � L35: const { data, error } = await sb.auth.getUser(raw); | service_role + user JWT | .claude/worktrees/conditions-doc-linking/admin/communications.html:267, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:19137, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:31004, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:32584, .claude/worktrees/conditions-doc-linking/public/unified-portal.html:2724, admin/communications.html:316, admin/lead-detail.html:20358, admin/lead-detail.html:32692, admin/lead-detail.html:34276, public/unified-portal.html:2769 | none found |
| `admin-users` | B | getUser() � L34: const { data: callerData, error: callerErr } = await admin.auth.getUser(token); | service_role + user JWT | .claude/worktrees/conditions-doc-linking/admin/settings.html:471, admin/settings.html:584 | none found |
| `automation-config` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/settings.html:749, .claude/worktrees/conditions-doc-linking/admin/settings.html:772, .claude/worktrees/conditions-doc-linking/dashboard/utils/clickup-automations.js:187, .claude/worktrees/conditions-doc-linking/dashboard/utils/clickup-automations.js:270, admin/settings.html:862, admin/settings.html:885, dashboard/utils/clickup-automations.js:187, dashboard/utils/clickup-automations.js:270 | none found |
| `borrower-drive` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:5613, admin/lead-detail.html:5961 | none found |
| `bot-admin` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/dashboard/admin.html:4175, dashboard/admin.html:4808 | none found |
| `bot-process-queue` | B | **none** | service_role | no browser caller found | cron bot-process-queue-every-minute [* * * * *] |
| `cal-webhook` | B | **none** | service_role | no browser caller found | none found |
| `calendar-data` | B | getUser() � L40: const { data: userData } = await userClient.auth.getUser(); \|\| require* helper � L28: async function requireStaff(req: Request): Promise<{ ok: boolean; status?: number; msg?: string; role?: string \|\| service-key comparison � L32: if (apikey && apikey === SERVICE_KEY) return { ok: true, role: "service" }; | service_role + anon + user JWT | .claude/worktrees/conditions-doc-linking/dashboard/utils/calendar.js:4, .claude/worktrees/conditions-doc-linking/dashboard/utils/calendar.js:99, .claude/worktrees/conditions-doc-linking/dashboard/utils/calendar.js:465, dashboard/utils/calendar.js:4, dashboard/utils/calendar.js:106, dashboard/utils/calendar.js:469 | fn:crm-copilot |
| `campaign-ai-generate` | B | **none** | service_role | no browser caller found | none found |
| `campaign-audience-resolve` | B | **none** | service_role | no browser caller found | none found |
| `canva-generate` | B | **none** | none detected | no browser caller found | none found |
| `chat-ai` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/public/js/chat-widget.js:4, .claude/worktrees/conditions-doc-linking/public/js/chat-widget.js:10, public/js/chat-widget.js:4, public/js/chat-widget.js:10 | none found |
| `chunk-guidelines` | B | **none** | service_role | no browser caller found | fn:gdrive-health-monitor |
| `chunk-guidelines-large` | B | **none** | service_role | no browser caller found | cron chunk-large-resume [*/5 * * * *]; fn:chunk-guidelines, fn:gdrive-health-monitor |
| `clickup-auto-create` | B | **none** | service_role | no browser caller found | db fire_clickup_automation, fire_lender_automation; fn:generate-preapproval |
| `clickup-bridge` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:9674, .claude/worktrees/conditions-doc-linking/admin/va-tasks.html:740, .claude/worktrees/conditions-doc-linking/dashboard/utils/clickup-automations.js:318, .claude/worktrees/conditions-doc-linking/dashboard/utils/clickup-tasks.js:25, .claude/worktrees/conditions-doc-linking/dashboard/utils/clickup-widget.js:52, admin/js/task-capture.js:458, admin/lead-detail.html:10063, admin/va-tasks.html:831, dashboard/utils/clickup-automations.js:318, dashboard/utils/clickup-tasks.js:25, dashboard/utils/clickup-widget.js:52 | cron clickup-bridge-sync [*/15 * * * *]; fn:clickup-auto-create, fn:sms-assistant |
| `clickup-lender-sync` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:28859, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:30310, .claude/worktrees/conditions-doc-linking/admin/lenders.html:1686, admin/lead-detail.html:30516, admin/lead-detail.html:31967, admin/lenders.html:1724 | none found |
| `clickup-setup` | B | **none** | service_role | no browser caller found | none found |
| `clickup-sync` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:28873, .claude/worktrees/conditions-doc-linking/admin/lenders.html:1906, .claude/worktrees/conditions-doc-linking/components/admin-dashboard.js:98, admin/lead-detail.html:30530, admin/lenders.html:1944, components/admin-dashboard.js:98 | none found |
| `commercial-ai` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:19503, admin/lead-detail.html:20754 | none found |
| `commercial-docs` | B | row-held token � L199: .eq('form_token', token).single(); | service_role | no browser caller found | none found |
| `commercial-intake` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/commercial-intakes.html:83, .claude/worktrees/conditions-doc-linking/admin/commercial-intakes.html:155, .claude/worktrees/conditions-doc-linking/admin/commercial-intakes.html:248, .claude/worktrees/conditions-doc-linking/public/unified-portal.html:2774, admin/commercial-intakes.html:83, admin/commercial-intakes.html:155, admin/commercial-intakes.html:248, public/unified-portal.html:2819 | none found |
| `commercial-match` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:19526, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:19557, .claude/worktrees/conditions-doc-linking/admin/lenders.html:2315, .claude/worktrees/conditions-doc-linking/admin/lenders.html:2362, admin/lead-detail.html:20777, admin/lead-detail.html:20808, admin/lenders.html:2457, admin/lenders.html:2504 | none found |
| `contact-intelligence` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:31023, admin/lead-detail.html:32715 | none found |
| `critical-date-reminders` | B | **none** | service_role | no browser caller found | none found |
| `delete-contacts` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/people.html:1627, admin/people.html:2043 | none found |
| `drive-folder-migrator` | B | shared secret compare � L50: if (secret !== SHARED_SECRET) return new Response('Forbidden', { status: 403 }) | service_role + user JWT | no browser caller found | none found |
| `emc-lender-import` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/emc-import.html:240, admin/emc-import.html:240 | none found |
| `esign-docs` | B | getUser() � L123: const { data: { user } } = await u.auth.getUser(); \|\| require* helper � L116: async function requireAdmin(req: Request): Promise<{ ok: boolean; userId: string\|null; status?: number; msg?:  | service_role + anon + user JWT | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:11507, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:12641, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:13315, admin/lead-detail.html:11992, admin/lead-detail.html:12267, admin/lead-detail.html:13665, admin/lead-detail.html:14339 | fn:esign |
| `extract-conditions` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:16670, admin/lead-detail.html:17817 | none found |
| `gdrive-proxy` | B | **none** | service_role + user JWT | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:8159, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:8196, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:8465, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:8542, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:10819, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:10826, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:10860, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:16913, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:17020, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:22505, admin/lead-detail.html:8531, admin/lead-detail.html:8568, admin/lead-detail.html:8837, admin/lead-detail.html:8914, admin/lead-detail.html:11294, admin/lead-detail.html:11301, admin/lead-detail.html:11338, admin/lead-detail.html:17261, admin/lead-detail.html:17268, admin/lead-detail.html:17283, admin/lead-detail.html:18060, admin/lead-detail.html:18167, admin/lead-detail.html:23972, admin/lead-detail.html:34382 | fn:gdrive-sync |
| `gdrive-sync` | B | **none** | service_role + user JWT | no browser caller found | cron gdrive-sync-borrower-docs-10min [*/10 * * * *]; fn:gdrive-health-monitor, fn:portal-data, fn:upload-guideline |
| `gdrive-sync-guideline` | B | **none** | service_role + user JWT | no browser caller found | cron gdrive-sync-guidelines-nightly [30 3 * * *]; fn:gdrive-health-monitor, fn:upload-guideline |
| `gmail-inbox` | B | getUser() � L329: const { data: userData, error: authErr } = await svc.auth.getUser(jwt) | service_role + anon + user JWT | dashboard/admin.html:3898 | none found |
| `google-account-email` | B | **none** | service_role + user JWT | no browser caller found | none found |
| `google-calendar-auth` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/auth/index.html:854, auth/index.html:854 | fn:gdrive-health-monitor, fn:gdrive-sync-guideline, fn:google-calendar-sync, fn:google-token-refresh, fn:lender-email-sync |
| `google-calendar-sync` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/js/staff-chat.js:616, .claude/worktrees/conditions-doc-linking/api/admin-api-v2.js:330, .claude/worktrees/conditions-doc-linking/components/admin-dashboard.js:67, .claude/worktrees/conditions-doc-linking/components/admin-dashboard.js:5518, .claude/worktrees/conditions-doc-linking/dashboard/utils/calendar.js:498, admin/js/staff-chat.js:703, api/admin-api-v2.js:330, components/admin-dashboard.js:67, components/admin-dashboard.js:5536, dashboard/utils/calendar.js:502 | fn:calendar-data, fn:tour-public-view, fn:tours-admin |
| `google-token-refresh` | B | **none** | service_role | no browser caller found | cron google-token-refresh-30min [*/30 * * * *]; fn:calendar-data |
| `guidelines-ai` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:29281, .claude/worktrees/conditions-doc-linking/admin/lenders.html:1974, admin/lead-detail.html:30938 | none found |
| `guidelines-library` | B | **none** | service_role | no browser caller found | none found |
| `lead-scorer` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:16645, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:25136, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:25142, admin/lead-detail.html:17792, admin/lead-detail.html:26750, admin/lead-detail.html:26756 | cron lead-scorer-nightly, nightly-lead-score-recalc [0 12 * * *]; db trigger_score_recalc; fn:generate-preapproval, fn:tour-public-view, fn:tours-admin, fn:track-event |
| `lender-email-sync` | B | **none** | service_role + user JWT | no browser caller found | none found |
| `lender-guidelines` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:30132, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:30218, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:30233, admin/lead-detail.html:31789, admin/lead-detail.html:31875, admin/lead-detail.html:31890 | none found |
| `lender-upload` | B | row-held token � L76: .select('id,name,form_token') | service_role | public/lender-form.html:561 | none found |
| `listing-alerts` | B | **none** | service_role + user JWT | no browser caller found | none found |
| `news-feed` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/dashboard/admin.html:1422, dashboard/admin.html:1533 | cron refresh-market-news [30 */4 * * *] |
| `people-admin` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/people.html:748, admin/people.html:808 | none found |
| `portal-data` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/public/unified-portal.html:1368, .claude/worktrees/conditions-doc-linking/public/unified-portal.html:1417, .claude/worktrees/conditions-doc-linking/public/unified-portal.html:1740, .claude/worktrees/conditions-doc-linking/public/unified-portal.html:1782, .claude/worktrees/conditions-doc-linking/public/unified-portal.html:1823, .claude/worktrees/conditions-doc-linking/public/unified-portal.html:1904, .claude/worktrees/conditions-doc-linking/public/unified-portal.html:2376, .claude/worktrees/conditions-doc-linking/public/unified-portal.html:2502, .claude/worktrees/conditions-doc-linking/public/unified-portal.html:2533, .claude/worktrees/conditions-doc-linking/public/unified-portal.html:2590, public/unified-portal.html:1375, public/unified-portal.html:1424, public/unified-portal.html:1747, public/unified-portal.html:1789, public/unified-portal.html:1830, public/unified-portal.html:1929, public/unified-portal.html:2416, public/unified-portal.html:2547, public/unified-portal.html:2578, public/unified-portal.html:2635 | none found |
| `portal-profile` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/public/portal.html:741, public/portal.html:742 | none found |
| `post-close-followups` | B | **none** | service_role | no browser caller found | none found |
| `refi-watch` | B | **none** | service_role | no browser caller found | none found |
| `save-document` | B | getUser() � L70: const { data: userData, error: authErr } = await sb.auth.getUser(jwt); | service_role + user JWT | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:8603, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:8845, admin/lead-detail.html:8975, admin/lead-detail.html:9217 | none found |
| `send-push` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/public/unified-portal.html:1238, public/unified-portal.html:1245 | fn:listing-alert-actions |
| `short-link` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:18448, .claude/worktrees/conditions-doc-linking/src/worker.js:248, admin/lead-detail.html:19603, src/worker.js:477 | fn:send-listing-alerts |
| `stripe-webhook` | B | **none** | service_role | no browser caller found | none found |
| `submit-lead` | B | none (Turnstile bot-check only, L6) | service_role | .claude/worktrees/conditions-doc-linking/api/public-api.js:5, .claude/worktrees/conditions-doc-linking/public/contact.html:288, api/public-api.js:5, public/contact.html:289 | none found |
| `track-event` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/src/worker.js:105, src/worker.js:334 | fn:ai-sms-bot, fn:email-service, fn:tours-admin |
| `treasury-yields` | B | **none** | service_role | no browser caller found | cron refresh-treasury-yields [15 22 * * 1-5] |
| `upload-guideline` | B | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/guideline-ai.html:1959, admin/guideline-ai.html:1970 | none found |
| `va-help` | B | getUser() � L51: const { data: { user } } = await u.auth.getUser(); \|\| require* helper � L41: async function requireAdmin(req: Request): Promise<boolean> { \|\| service-key comparison � L45: if (token === SERVICE_KEY) return true; | service_role + anon + user JWT | .claude/worktrees/conditions-doc-linking/admin/va-tasks.html:790, admin/va-tasks.html:881 | none found |
| `video-chat` | B | **none** | service_role | no browser caller found | none found |
| `video-track` | B | getUser() � L82: const { data, error } = await sb.auth.getUser(jwt); | service_role + user JWT | no browser caller found | fn:video-chat |
| `weekly-backup` | B | **none** | service_role + user JWT | no browser caller found | cron weekly-crm-backup [0 8 * * 0] |
| `ai-chat` | C | **none** | none detected | .claude/worktrees/conditions-doc-linking/auth/index.html:1408, auth/index.html:1408 | none found |
| `canva-proxy` | C | **none** | none detected | no browser caller found | none found |
| `claude-ai` | C | **none** | none detected | .claude/worktrees/conditions-doc-linking/api/ai-api.js:3, api/ai-api.js:3 | none found |
| `compose-ai` | C | getUser() � L241: const { data: userData, error: authErr } = await svc.auth.getUser(jwt) | service_role + user JWT | admin/js/inbox.js:2573 | none found |
| `crm-copilot` | C | getUser() � L166: const { data: userData } = await userClient.auth.getUser(); | service_role + anon + user JWT | .claude/worktrees/conditions-doc-linking/admin/js/staff-chat.js:743, admin/js/staff-chat.js:830 | none found |
| `extract-lead-from-image` | C | **none** | none detected | .claude/worktrees/conditions-doc-linking/admin/people.html:1847, .claude/worktrees/conditions-doc-linking/admin/people.html:1936, admin/people.html:2263, admin/people.html:2352 | none found |
| `guideline-ai` | C | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/guideline-ai.html:1456, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:28370, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:28517, .claude/worktrees/conditions-doc-linking/admin/lenders.html:1884, admin/guideline-ai.html:1467, admin/lead-detail.html:30025, admin/lead-detail.html:30172, admin/lenders.html:1922 | fn:ai-sms-bot |
| `scan-doc-to-1003` | C | **none** | none detected | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:7223, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:22392, admin/lead-detail.html:7585, admin/lead-detail.html:23859 | none found |
| `sms-draft-assist` | C | **none** | service_role | no browser caller found | none found |
| `trestle-proxy` | C | **none** | user JWT | .claude/worktrees/conditions-doc-linking/assets/js/tour-builder.js:2501, .claude/worktrees/conditions-doc-linking/assets/js/tour-builder.js:2512, .claude/worktrees/conditions-doc-linking/assets/js/tour-builder.js:2966, .claude/worktrees/conditions-doc-linking/public/property-detail.html:752, .claude/worktrees/conditions-doc-linking/public/property-detail.html:799, .claude/worktrees/conditions-doc-linking/public/property-detail.html:1365, .claude/worktrees/conditions-doc-linking/public/property-detail.html:1454, .claude/worktrees/conditions-doc-linking/public/search-homes.html:1818, .claude/worktrees/conditions-doc-linking/public/search-homes.html:1937, assets/js/tour-builder.js:2501, assets/js/tour-builder.js:2512, assets/js/tour-builder.js:2966, public/property-detail.html:753, public/property-detail.html:800, public/property-detail.html:1366, public/property-detail.html:1455, public/search-homes.html:1821, public/search-homes.html:1940 | fn:listing-alert-matcher, fn:pull-comps, fn:send-listing-alerts |
| `trestle-scope` | C | **none** | user JWT | no browser caller found | none found |
| `clickup-mention-ping` | D | **none** | none detected | no browser caller found | db tg_app_notifications_chat, tg_app_notifications_email |
| `convert-to-pdf` | D | **none** | none detected | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:6846, .claude/worktrees/conditions-doc-linking/components/admin-dashboard.js:2442, .claude/worktrees/conditions-doc-linking/components/admin-dashboard.js:3203, admin/lead-detail.html:7208, components/admin-dashboard.js:2460, components/admin-dashboard.js:3221 | none found |
| `generate-1003` | D | **none** | none detected | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:23198, .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:24939 | none found |
| `generate-fee-sheet` | D | **none** | none detected | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:32620, admin/lead-detail.html:34312 | none found |
| `generate-heloc-sheet` | D | **none** | none detected | no browser caller found | none found |
| `generate-preapproval` | D | **none** | service_role | .claude/worktrees/conditions-doc-linking/admin/lead-detail.html:23403, admin/lead-detail.html:25015 | none found |
| `mortgage-calc` | D | **none** | service_role | no browser caller found | fn:ai-sms-bot |
| `voe-form-fill` | D | require* helper � L59: const auth = await requireStaff(req, { what: 'Filling the VOE form' }); | service_role | admin/lead-detail.html:11975, admin/lead-detail.html:12245 | none found |
| `voe-inbound-poll` | D | **requireStaff({ allowInternal: true })** since 2026-08-11. WAS recorded here as "shared secret compare" on the strength of `if (s !== POLL_SECRET) … 401` — but that line sat inside `if (POLL_SECRET) { … }` and `VOE_POLL_SECRET` was never set, so it never ran and the function was OPEN. The detector read the comparison and not the enclosing condition; a fail-open gate greps identically to a working one. | service_role + user JWT | no browser caller found | cron voe-inbound-poll-10min [every 10 min] |

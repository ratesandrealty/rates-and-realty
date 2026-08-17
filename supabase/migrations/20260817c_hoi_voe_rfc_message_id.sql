-- HOI + VOE reply threading: store the RFC Message-ID, which is NOT the Gmail id.
--
-- WRITTEN BEFORE IT WAS APPLIED, unlike 20260817b. That one was applied through
-- the MCP first and written second; this file existed before anything ran.
--
-- REVERT:
--   drop index if exists public.hoi_quote_requests_rfc_message_id_key;
--   drop index if exists public.loan_orders_rfc_message_id_key;
--   drop index if exists public.loan_orders_gmail_message_id_key;
--   drop index if exists public.loan_orders_gmail_thread_id_idx;
--   alter table public.hoi_quote_requests drop column if exists rfc_message_id;
--   alter table public.loan_orders
--     drop column if exists gmail_message_id,
--     drop column if exists gmail_thread_id,
--     drop column if exists rfc_message_id;
--
-- ══ WHY THIS EXISTS: 20260817b's stated correlation could never have matched ══
--
-- 20260817b says, in its own comments and in the handoff:
--
--     "gmail_message_id is the RFC Message-ID of the request we sent. A reply
--      carries it in In-Reply-To/References, and that is the PRIMARY correlation"
--
-- IT IS NOT, AND IT DOES NOT. Two different strings:
--
--     Gmail API id      19ff76c7c7610398                 <- what send returns
--     RFC Message-ID    <CAF...@mail.gmail.com>          <- what In-Reply-To carries
--
-- Measured, not reasoned: every gmail_message_id in email_log is 16 hex chars,
-- because messageToRow() stores `gmail_message_id: msg.id` — the API id. That is
-- what the name means everywhere in this codebase, so the HOI column named to
-- match it holds the API id too.
--
-- So a poller matching a reply's In-Reply-To against gmail_message_id would have
-- compared <...@mail.gmail.com> to 19ff76c7c7610398 and matched NOTHING, ever.
-- The primary correlation would have been dead on arrival — the identical failure
-- to VOE's plus-token, which 20260817b correctly diagnoses and then reproduces in
-- its own primary path. A token nobody emits and a header nobody stores fail the
-- same way, and both fail silently: the reply simply never attaches.
--
-- Fixed by storing BOTH, because they do different jobs:
--
--     gmail_message_id  API id   -> idempotency, and re-fetching the message
--     rfc_message_id    header   -> what In-Reply-To/References actually match
--     gmail_thread_id   thread   -> corroboration against Gmail's own grouping
--
-- gmail-inbox's send now returns rfc_message_id alongside message_id. It always
-- had the value — the post-send format=full fetch reads real headers — it just
-- never surfaced it. That is an additive response field, so no existing caller
-- changed behaviour.
--
-- ══ VOE ══
--
-- loan_orders carried NO threading columns at all: voe_reply_token and
-- hr_contact_email only. It gets the same three, so one poller can serve both
-- tables with one correlation ladder and one idempotency key.
--
-- NOT BACKFILLED, for the same reason as 20260817b: the six HOI rows and five
-- VOE orders were sent through MailerSend, which returned no id to store. They
-- cannot be threaded from data we hold, and inventing an id to make them look
-- threaded would be manufacturing the evidence. History starts at the next send.
--
-- The unique indexes are PARTIAL because null must stay repeatable — every
-- pre-existing row has one, and there is no unique-null to collide on.

alter table public.hoi_quote_requests
  add column if not exists rfc_message_id text;

alter table public.loan_orders
  add column if not exists gmail_message_id text,
  add column if not exists gmail_thread_id  text,
  add column if not exists rfc_message_id   text;

create unique index if not exists hoi_quote_requests_rfc_message_id_key
  on public.hoi_quote_requests (rfc_message_id) where rfc_message_id is not null;

create unique index if not exists loan_orders_rfc_message_id_key
  on public.loan_orders (rfc_message_id) where rfc_message_id is not null;

/* The unique index on the API id is what makes re-polling the same reply a no-op
   rather than a duplicate — the property gmail-inbox already relies on for its
   own send log, and the reason one shared poller can hold one idempotency key
   instead of two that disagree. */
create unique index if not exists loan_orders_gmail_message_id_key
  on public.loan_orders (gmail_message_id) where gmail_message_id is not null;

create index if not exists loan_orders_gmail_thread_id_idx
  on public.loan_orders (gmail_thread_id) where gmail_thread_id is not null;

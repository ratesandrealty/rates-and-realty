-- HOI quote requests: carry the Gmail ids so replies can be correlated.
--
-- APPLIED to production 2026-08-17 as migration `hoi_quote_requests_gmail_threading`.
-- This file is the repo's copy of it. It was applied first and written second,
-- which is the wrong order and worth admitting: for a few minutes production held
-- schema the repo had no record of, which is the exact drift shape
-- check-function-drift exists to catch on the function side.
--
-- REVERT:
--   drop index if exists public.hoi_quote_requests_gmail_message_id_key;
--   drop index if exists public.hoi_quote_requests_gmail_thread_id_idx;
--   drop index if exists public.hoi_quote_requests_reply_token_key;
--   alter table public.hoi_quote_requests
--     drop column if exists gmail_message_id,
--     drop column if exists gmail_thread_id,
--     drop column if exists reply_token;
--
-- WHY THESE COLUMNS
-- gmail_message_id is the RFC Message-ID of the request we sent. A reply carries
-- it in In-Reply-To/References, and that is the PRIMARY correlation — the only
-- one that survives an agent whose mail system strips plus-addressing or who
-- composes a fresh message rather than hitting reply.
--
-- It is available at all only because the send moves onto gmail-inbox's existing
-- send action, which returns Gmail's real message and thread ids. The current
-- path (email-service -> MailerSend) returns no id we store, which is why the
-- six existing rows cannot be threaded.
--
-- reply_token stays as a SECONDARY signal, emitted in reply-to as a plus-address.
-- Secondary because it is trivially lost, and because VOE already demonstrates
-- how it fails: voe-inbound-poll queries to:processing+<token>@ while the send
-- emits a bare processing@, so that path has never matched anything.
--
-- gmail_thread_id is stored so a correlated reply can be checked against the
-- thread Gmail itself groups, rather than trusting our own matching alone.
--
-- DELIBERATELY NOT BACKFILLED. The six existing hoi_quote_requests rows and five
-- VOE orders predate this and hold no Message-ID, because MailerSend never gave
-- us one to store. Threading history starts at the next send, and the UI states
-- that rather than rendering an empty thread that reads as broken.

alter table public.hoi_quote_requests
  add column if not exists gmail_message_id text,
  add column if not exists gmail_thread_id  text,
  add column if not exists reply_token      text;

/* The unique index on gmail_message_id is what makes re-polling the same reply a
   no-op instead of a duplicate — the same property gmail-inbox already relies on
   for its own send log. Partial, because null must stay repeatable: every row
   sent before this change has one. */
create unique index if not exists hoi_quote_requests_gmail_message_id_key
  on public.hoi_quote_requests (gmail_message_id) where gmail_message_id is not null;

create index if not exists hoi_quote_requests_gmail_thread_id_idx
  on public.hoi_quote_requests (gmail_thread_id) where gmail_thread_id is not null;

create unique index if not exists hoi_quote_requests_reply_token_key
  on public.hoi_quote_requests (reply_token) where reply_token is not null;

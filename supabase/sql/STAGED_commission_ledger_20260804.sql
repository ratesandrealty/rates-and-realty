-- STAGED. NOT RUN. Deliberately in supabase/sql/, not supabase/migrations/, so
-- `supabase db push` cannot pick it up.
--
-- WHY IT IS NOT RUN: the backfill would have to write real commission figures,
-- and the two existing sources disagree on 4 of 9 closed deals (see AUDIT below).
-- Choosing one silently would encode a guess about money into an accounting
-- record. That is Rene's call, not a default. Everything else here is ready.
--
-- ============================================================================
-- THE PROBLEM
-- ============================================================================
-- contact_earnings holds commission keyed on contact_id, which is its PRIMARY KEY.
-- cleanup_contact_financials() deletes the row on every contact delete. So the
-- record of what Rene earned dies with the CRM contact — an ordinary tidy-up
-- destroys an accounting record. Nothing lost yet (all 29 audited deletions
-- carried actual_earnings = 0) but 3 Closed contacts hold $42,531 today with
-- nothing protecting them.
--
-- ============================================================================
-- AUDIT OF THE EXISTING WRITE PATH — read this before trusting closed_deals
-- ============================================================================
-- A ledger half-exists: closed_deals(contact_id, loan_amount, commission_rate,
-- commission_earned, close_date, loan_type, outcome). It is written by
-- fn_track_deal_outcome(), an AFTER UPDATE OF pipeline_status trigger on contacts
-- that fires when pipeline_status becomes 'Closed'. It is NOT reliable:
--
--  1. THE COMMISSION IS INVENTED. commission_earned := loan_amount * 0.01. It
--     never reads contact_earnings.actual_earnings. Any real figure Rene enters
--     lives in a different table that this trigger does not consult.
--  2. THE TWO SOURCES DISAGREE on 4 of 9 closed deals. e.g. 2026-07-29:
--     closed_deals says 8,520 (1% of 852,000); contact_earnings says actual 0,
--     estimated 19,170. 2026-06-17: closed_deals 2,500 — not 1% of anything, so
--     hand-edited. Neither table is authoritative and nothing reconciles them.
--  3. close_date := CURRENT_DATE — the day someone changed a dropdown in the CRM,
--     not the day the loan closed. Update the status a week late and the figure
--     lands in the wrong period.
--  4. UNIQUE (contact_id) with ON CONFLICT DO UPDATE. One closing per contact,
--     EVER. A repeat borrower — refi after purchase — silently OVERWRITES the
--     first closing and its commission. This is a live data-loss path today,
--     independent of deletion.
--  5. IT NEVER REVERSES. One row has outcome='closed' while its contact is back
--     at 'New Lead': moved to Closed, moved back, ledger row left behind.
--  6. commission_rate is 1.0 on eight rows and 0.01 on one. Percent or fraction
--     is not decided.
--  7. NO IDENTITY SNAPSHOT. closed_deals.contact_id is ON DELETE SET NULL, so the
--     row survives a delete and becomes anonymous — a number with no borrower.
--
-- So: "what event marks closed" = a pipeline_status dropdown change, and no, it
-- is not reliable. A ledger written from it inherits every fault above.
--
-- There is also no loan/closing ENTITY to key on. loan_orders is VOE, appraisal
-- and inspection orders, not loans. mortgage_applications is the nearest thing.
-- The ledger below therefore carries its own key and snapshots identity.
--
-- ============================================================================
-- STEP 1 — the ledger
-- ============================================================================
create table if not exists public.commission_ledger (
  id                  uuid primary key default gen_random_uuid(),

  -- Identity SNAPSHOT. Copied at write time and never updated afterwards. This is
  -- the whole point: the row must reconcile to a 1099 with the contact deleted.
  borrower_name       text not null,
  borrower_email      text,
  loan_amount         numeric,
  loan_type           text,

  -- The closing.
  close_date          date not null,          -- the ACTUAL closing date, not CURRENT_DATE
  commission_earned   numeric not null,
  commission_rate     numeric,                -- store as a fraction, e.g. 0.01 = 1%
  earnings_source     text not null,          -- 'contact_earnings' | 'closed_deals' | 'manual' | 'backfill'

  -- Provenance. Nullable and SET NULL: the ledger outlives all of them.
  source_contact_id   uuid references public.contacts(id) on delete set null,
  application_id      uuid references public.mortgage_applications(id) on delete set null,
  closed_deal_id      uuid references public.closed_deals(id) on delete set null,

  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Deliberately NO unique constraint on source_contact_id. That constraint is
-- exactly what makes closed_deals lose a repeat borrower's first closing.
create index if not exists commission_ledger_contact_idx on public.commission_ledger (source_contact_id);
create index if not exists commission_ledger_close_date_idx on public.commission_ledger (close_date);

alter table public.commission_ledger enable row level security;
-- No policy: service-role only, like the *_orphan_cleanup_20260804 tables.
-- Add an admin read policy deliberately if the CRM needs to display it.

-- Not deleted when a contact is. That is the entire reason this table exists.
comment on table public.commission_ledger is
  'Commission earned per CLOSING, not per contact. Survives contact deletion by design: borrower_name and loan_amount are snapshots, and every FK is ON DELETE SET NULL. Written at close. See supabase/sql/STAGED_commission_ledger_20260804.sql for why closed_deals and contact_earnings could not serve this purpose.';

-- ============================================================================
-- STEP 2 — write at close
-- ============================================================================
-- Written at CLOSE, not at delete. A delete-time write only ever protects the
-- contacts that happen to get deleted, and says nothing about the 1,038 that do
-- not; it also puts an accounting write on the least-tested path in the system.
--
-- OPEN DECISION 1 — where does commission_earned come from? This function reads
-- contact_earnings.actual_earnings and falls back to the closed_deals 1% rule,
-- recording which in earnings_source. If Rene enters the real figure somewhere
-- else, point it there instead. It must NOT silently invent 1%.
-- OPEN DECISION 2 — close_date. Uses CURRENT_DATE, inheriting fault (3), because
-- no actual closing date is stored anywhere today. A real close_date field on
-- contacts or mortgage_applications would fix this properly.
create or replace function public.fn_write_commission_ledger()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actual   numeric;
  v_name     text;
  v_source   text;
begin
  if NEW.pipeline_status is not distinct from OLD.pipeline_status then return NEW; end if;
  if NEW.pipeline_status <> 'Closed' then return NEW; end if;

  select actual_earnings into v_actual from public.contact_earnings where contact_id = NEW.id;

  if coalesce(v_actual, 0) <> 0 then
    v_source := 'contact_earnings';
  else
    v_actual := coalesce(NEW.loan_amount, 0) * 0.01;
    v_source := 'closed_deals_rule';   -- flagged so it can be corrected later
  end if;

  v_name := nullif(trim(coalesce(NEW.first_name,'') || ' ' || coalesce(NEW.last_name,'')), '');

  insert into public.commission_ledger (
    borrower_name, borrower_email, loan_amount, loan_type,
    close_date, commission_earned, commission_rate, earnings_source,
    source_contact_id, notes
  ) values (
    coalesce(v_name, '(name not recorded at close)'), NEW.email,
    NEW.loan_amount, NEW.loan_type,
    current_date, v_actual,
    case when coalesce(NEW.loan_amount,0) <> 0 then round(v_actual / NEW.loan_amount, 6) end,
    v_source, NEW.id,
    'Written by fn_write_commission_ledger on pipeline_status -> Closed'
  );
  return NEW;
end;
$$;

create trigger trg_write_commission_ledger
  after update of pipeline_status on public.contacts
  for each row execute function public.fn_write_commission_ledger();

-- ============================================================================
-- STEP 3 — BACKFILL. THIS IS THE PART THAT IS NOT READY.
-- ============================================================================
-- 9 closed_deals rows and 3 contact_earnings rows with non-zero actual. They
-- agree on 2 and disagree on 4; the rest are zero on both sides. Running the
-- statement below would pick contact_earnings where non-zero and the closed_deals
-- 1% rule otherwise — a defensible default, and still a guess about money.
--
-- Reconcile these four by hand first (closed_deals vs contact_earnings.actual):
--     2026-06-10   19,075  vs  19,075   agree, estimated differs (19,867)
--     2026-06-17    2,500  vs       0   hand-edited, not 1% of 724,000
--     2026-07-11    6,600  vs       0
--     2026-07-11    3,225  vs       0   contact_earnings estimated 16,125
--     2026-07-29    8,520  vs       0   contact_earnings estimated 19,170
--
-- insert into public.commission_ledger (
--   borrower_name, borrower_email, loan_amount, loan_type, close_date,
--   commission_earned, commission_rate, earnings_source,
--   source_contact_id, closed_deal_id, notes)
-- select
--   coalesce(nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''),
--            '(contact deleted before backfill)'),
--   c.email, d.loan_amount, d.loan_type, d.close_date,
--   coalesce(nullif(e.actual_earnings,0), d.commission_earned, 0),
--   case when coalesce(d.loan_amount,0) <> 0
--        then round(coalesce(nullif(e.actual_earnings,0), d.commission_earned, 0) / d.loan_amount, 6) end,
--   case when coalesce(e.actual_earnings,0) <> 0 then 'backfill:contact_earnings'
--        else 'backfill:closed_deals' end,
--   d.contact_id, d.id,
--   'Backfilled 2026-08-04 from closed_deals + contact_earnings'
-- from public.closed_deals d
-- left join public.contacts c on c.id = d.contact_id
-- left join public.contact_earnings e on e.contact_id = d.contact_id
-- where d.outcome = 'closed';
--
-- Source data preserved regardless of what is decided:
--   snapshots/contact-earnings-20260804.json            1038 rows, full copy
--   contact_earnings_ledger_backfill_20260804           1038 rows, in Postgres
--
-- ============================================================================
-- DELIBERATELY NOT DONE HERE
-- ============================================================================
-- cleanup_contact_financials() is NOT changed. It still deletes contact_earnings
-- on contact delete. Once the ledger holds the closed figures that is the right
-- behaviour — contact_earnings becomes working state, the ledger becomes the
-- record. Changing it before the ledger is populated would just move the problem.
--
-- fn_track_deal_outcome() and closed_deals are NOT changed. Two writers to one
-- concept is worse than one bad writer. Once the ledger is the record, retire
-- closed_deals.commission_earned or make it a view over the ledger — a follow-up
-- with its own review, not a rider on this.

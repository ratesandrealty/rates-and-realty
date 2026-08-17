-- One definition of the third-party order vocabulary, referenced by both sides.
--
-- REVERT:
--   alter table public.email_thread_tags drop column if exists order_kind;
--   alter table public.loan_orders drop constraint if exists loan_orders_order_type_fkey;
--   alter table public.loan_orders add constraint loan_orders_order_type_check
--     check (order_type = any (array['title','hoi','escrow','appraisal','voe','voa',
--                                   'flood','payoff','cpl','mi','other']));
--   drop table if exists public.order_kinds;
--
-- ══ WHY A TABLE AND NOT A SECOND CHECK ══
--
-- The vocabulary already existed, as `loan_orders_order_type_check` — eleven
-- values, of which six are in use. Constraining a new tag column with a CHECK
-- carrying the same eleven would have been A PARALLEL LIST BY DEFINITION: two
-- places to edit, and the first person to add a kind to one side creates a state
-- where a tag can name a kind no order can have, or the reverse. That is the
-- exact failure this codebase spent today removing from three separate SELF sets
-- that had drifted apart.
--
-- So the list becomes a table, the CHECK is DROPPED rather than kept alongside
-- it, and both sides carry a foreign key. There is now one place to add a kind
-- and nowhere for the two to disagree.
--
-- The picker reads this table. It must not hardcode the list in JavaScript —
-- that would reintroduce the parallel list in a third place, and the one place
-- nobody thinks to check when the constraint rejects a value.
--
-- ══ NULL MEANS "KIND NOT RECORDED", AND MATCHES NO ORDER ══
--
-- email_thread_tags.order_kind is NULLABLE on purpose: the ten tags that exist
-- were filed before kinds existed and carry a contact only. Backfilling them by
-- guessing from subject keywords would manufacture exactly the confident,
-- unearned data this work has been removing — and these are real borrower
-- threads.
--
-- The property that matters more than the prompt: MATCHING LOGIC MUST TREAT
-- NULL AS MATCHING NO ORDER, NEVER AS A WILDCARD. A NULL that behaves like "any
-- kind" would attach every untyped thread to every order on that contact. Any
-- join must be written `t.order_kind = o.order_type`, which excludes NULL by
-- construction — never `t.order_kind is null or t.order_kind = o.order_type`.

create table if not exists public.order_kinds (
  kind        text primary key,
  label       text not null,
  sort_order  int  not null default 100,
  active      boolean not null default true
);

comment on table public.order_kinds is
  'The third-party order vocabulary. THE single definition: loan_orders.order_type and '
  'email_thread_tags.order_kind both FK here, and any picker must populate from a query '
  'against this table rather than a hardcoded list.';

insert into public.order_kinds (kind, label, sort_order) values
  ('escrow',    'Escrow',                          10),
  ('title',     'Title',                           20),
  ('hoi',       'Homeowners Insurance (HOI)',      30),
  ('voe',       'Verification of Employment (VOE)',40),
  ('payoff',    'Mortgage Payoff',                 50),
  ('appraisal', 'Appraisal',                       60),
  ('voa',       'Verification of Assets (VOA)',    70),
  ('flood',     'Flood Certification',             80),
  ('cpl',       'Closing Protection Letter (CPL)', 90),
  ('mi',        'Mortgage Insurance (MI)',        100),
  ('other',     'Other',                          999)
on conflict (kind) do nothing;

/* Drop the CHECK and replace it with the FK. Keeping both would leave the
   parallel list this migration exists to remove. Every value currently in
   loan_orders is among the eleven seeded above, so the FK validates without
   touching a row. */
alter table public.loan_orders
  drop constraint if exists loan_orders_order_type_check;

alter table public.loan_orders
  add constraint loan_orders_order_type_fkey
  foreign key (order_type) references public.order_kinds(kind);

alter table public.email_thread_tags
  add column if not exists order_kind text references public.order_kinds(kind);

comment on column public.email_thread_tags.order_kind is
  'Which third-party order kind this thread is about. FK to order_kinds, so it can never '
  'name a kind no order can have. NULL means KIND NOT RECORDED — the ten tags filed before '
  'kinds existed. NULL MUST MATCH NO ORDER: join as t.order_kind = o.order_type, which '
  'excludes NULL by construction. Treating NULL as a wildcard would attach every untyped '
  'thread to every order on the contact.';

create index if not exists email_thread_tags_order_kind_idx
  on public.email_thread_tags (order_kind) where order_kind is not null;

/* A lookup table with no borrower data in it. Readable by any signed-in staff
   member so a picker can populate; writable by nobody through the API — adding a
   kind is a migration, which is what keeps the vocabulary reviewable. */
alter table public.order_kinds enable row level security;

drop policy if exists order_kinds_staff_read on public.order_kinds;
create policy order_kinds_staff_read on public.order_kinds
  for select to authenticated
  using (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff','lender'));

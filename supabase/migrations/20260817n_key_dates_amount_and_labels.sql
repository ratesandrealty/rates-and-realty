-- Critical Dates: an amount alongside the date, and labels that live in the row.
--
-- REVERT:
--   alter table public.loan_key_dates drop column if exists amount;
--   update public.loan_key_dates set label = null;
--   -- and restore sync_appraisal_inspection_date's label literal to 'Appraisal Due'
--   -- from supabase/sql/db-functions/sync_appraisal_inspection_date.sql at 52a8718.
--
-- WHY label IS NOW WRITTEN, having been NULL on all 28 rows.
--
-- The panel's labels lived only in LP_KEY_DATES in admin/lead-detail.html, so
-- every consumer that renders a date from the DATABASE fell back to the machine
-- key. Measured before this change:
--
--   critical-date-reminders/index.ts  label = r.label || r.date_key
--       -> ClickUp tasks read "* appraisal_due in 3 days - <borrower>"
--   loan_health.sql:23  coalesce(nullif(label,''), initcap(replace(date_key,'_',' ')))
--       -> the health banner reads "Appraisal Due"
--
-- So a frontend-only rename would have produced three different names for one
-- date: "Appraisal Contingency" in the panel, "Appraisal Due" in the banner and
-- "appraisal_due" in ClickUp. The label belongs in the row because that is where
-- every non-browser consumer reads it from.
--
-- KEYS ARE NOT RENAMED, ONLY LABELS. loan_date_nudge_scan filters
--   kd.date_key in ('close_of_escrow','loan_contingency','appraisal_due','inspection_deadline')
-- and loan_health/sync_appraisal_inspection_date hardcode keys too. A key rename
-- matches nothing and raises no error -- the SMS nudge would simply stop, which
-- is the failure mode this repo keeps rediscovering.

-- 1. The amount that belongs with a date. Null for every key except emd_due.
--    Deliberately on loan_key_dates rather than a second table: the
--    (contact_id,'emd_due') row already IS the earnest-money record, and a
--    dedicated home would be a second place amounts can live.
alter table public.loan_key_dates
  add column if not exists amount numeric;

comment on column public.loan_key_dates.amount is
  'Optional money value stored with the date. Only emd_due uses it today (earnest money deposit). Null elsewhere.';

-- 2. Backfill label from the canonical list, carrying the NEW display names.
--    Rows are matched on date_key; nothing else is touched.
with canon(date_key, label) as (
  values
    ('contract_acceptance', 'Contract Acceptance'),
    ('emd_due',             'Earnest Money Due'),
    ('inspection_deadline', 'Inspection Deadline'),
    ('appraisal_due',       'Appraisal Contingency'),
    ('loan_contingency',    'Loan Contingency'),
    ('disclosures_due',     'Disclosure Contingency'),
    ('cd_out',              'Need CD Out By'),
    ('signing',             'Signing'),
    ('funding',             'Funding'),
    ('close_of_escrow',     'Close of Escrow')
)
update public.loan_key_dates k
   set label = c.label,
       updated_at = now()
  from canon c
 where c.date_key = k.date_key
   and coalesce(k.label,'') is distinct from c.label;

-- 3. sync_appraisal_inspection_date upserts appraisal_due and writes the label
--    with it. Left alone it would stamp 'Appraisal Due' back over the row the
--    moment an appraisal inspection date was set -- silently undoing step 2 for
--    exactly the date that has an automated writer.
CREATE OR REPLACE FUNCTION public.sync_appraisal_inspection_date(p_contact_id uuid, p_inspection_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (is_admin() or coalesce((select role from public.auth_user_roles where user_id=auth.uid() limit 1),'') in ('admin','agent','loa','va')) then
    raise exception 'not authorized';
  end if;
  -- update the appraisal loan_order inspection_date
  update public.loan_orders set inspection_date = p_inspection_date, updated_at = now()
    where contact_id = p_contact_id and order_type = 'appraisal';
  -- mirror into loan_key_dates as appraisal_due (upsert)
  -- The label must match the canonical list in the 20260817n migration and
  -- LP_KEY_DATES; this function is the only automated writer of a label.
  if p_inspection_date is not null then
    insert into public.loan_key_dates(contact_id, date_key, label, date_value)
    values (p_contact_id, 'appraisal_due', 'Appraisal Contingency', p_inspection_date)
    on conflict (contact_id, date_key) do update set date_value = excluded.date_value, updated_at = now();
  end if;
  return jsonb_build_object('ok', true, 'inspection_date', p_inspection_date);
end; $function$;

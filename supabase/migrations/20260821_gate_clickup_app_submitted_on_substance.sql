-- trg_clickup_app_submitted()
-- language: plpgsql
-- Captured from production 2026-08-21. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.trg_clickup_app_submitted()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  /* GATE: do not announce a submission for a row that is not one.
   *
   * This trigger is AFTER INSERT, and "a mortgage_applications row was created"
   * has never meant "a borrower submitted an application". Measured 2026-08-21,
   * over the whole history: 39 app_submitted events, 39 ClickUp tasks created,
   * and 22 of them defensibly not submissions -- 2 for the ZZ-TEST fixture, 7 for
   * a contact and row that no longer exist, 4 same-day duplicates, 7 for rows
   * that were entirely empty, 2 for contacts still at New Lead. Each task said
   * "Mortgage application submitted. Package documents, run AUS, send to
   * underwriting", at high priority, assigned to Rene.
   *
   * THERE IS NO POSITIVE "SUBMITTED" CONDITION TO KEY ON. mortgage_applications
   * .status is null on 30 of 35 rows and 'draft' on the other 5; no row has ever
   * held 'submitted', and nothing in the codebase writes that value. So this gate
   * is a NEGATIVE one, built only from conditions that already exist:
   *
   *   status = 'draft'  is written by mismo-import (index.ts:478). Those rows are
   *                     LOS file imports, not submissions.
   *   no ssn, no dob, no loan_amount  is a row with no application content in it.
   *
   * The immediate reason it exists: the Subject Property popup is being changed to
   * write the 1003 address columns, and without this gate a row created that way
   * would announce an application nobody filled in.
   *
   * If a real "submitted" flag is ever introduced, REPLACE this with it rather
   * than adding to it -- a positive condition is the honest test and this is a
   * proxy for one.
   *
   * Deliberately NOT gated on pipeline_status: that lives on contacts, and reading
   * it here would make an insert depend on a second table's state at trigger time. */
  if (NEW.status is distinct from 'draft'
      and (NEW.ssn is not null or NEW.date_of_birth is not null or NEW.loan_amount is not null)) then
    perform fire_clickup_automation('app_submitted', NEW.contact_id, NEW.id::text, '{}'::jsonb);
  end if;
  return NEW;
end;
$function$;

-- tg_borrower_documents_stamp_reviewed()
-- language: plpgsql   SECURITY DEFINER
-- Added 2026-08-11. Captured on creation — see the note in
-- tg_loan_conditions_stamp_cleared.sql.
--
-- PRE-EMPTIVE. borrower_documents.reviewed_by has NEVER been written: 0
-- populated rows, and no writer anywhere in the repo. The column is text, so
-- whatever wrote it first would have repeated the completed_by bug on exactly
-- the kind of record a lender or auditor asks about later.
--
-- The signal is reviewed_at going null -> set; there is no review-status column.
-- No reviewed_source companion, unlike loan_conditions: that one has a
-- demonstrated service-role writer and this has no writer at all, so a source
-- column here would be speculation about a path nobody has built.

CREATE OR REPLACE FUNCTION public.tg_borrower_documents_stamp_reviewed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if NEW.reviewed_at is not null and (TG_OP = 'INSERT' or OLD.reviewed_at is null) then
    NEW.reviewed_by_user_id := auth.uid();
  elsif TG_OP = 'UPDATE' and NEW.reviewed_at is null and OLD.reviewed_at is not null then
    NEW.reviewed_by_user_id := null; NEW.reviewed_by := null;
  elsif TG_OP = 'UPDATE' then
    NEW.reviewed_by_user_id := OLD.reviewed_by_user_id;
  end if;
  return NEW;
end; $function$;

-- create trigger trg_borrower_documents_stamp_reviewed
--   before insert or update on public.borrower_documents
--   for each row execute function public.tg_borrower_documents_stamp_reviewed();

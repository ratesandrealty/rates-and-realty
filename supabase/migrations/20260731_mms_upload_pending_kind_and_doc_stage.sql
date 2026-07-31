-- MMS document upload: allow the pending kind the SMS assistant actually writes,
-- and give uploaded_documents a stage separate from its type.
--
-- WHY: pending_clarifications' kind check constraint listed only 'mms_upload' and
-- 'contact_disambiguation'. sms-assistant writes 'doc_upload_target', so EVERY
-- insert on the document-upload path was rejected. writePending never read the
-- error, returned null, and the caller went on to ask "which borrower?" with
-- nothing recorded — the answer had nowhere to land.
--
-- loan_stage is a SECOND field, not a replacement for document_type. A pay stub
-- sent for the initial submission and one sent to clear a condition are the same
-- TYPE at different STAGES. Values mirror LP_TIMELINE in admin/lead-detail.html
-- so nothing here invents a third vocabulary.

alter table pending_clarifications drop constraint if exists pending_clarifications_kind_check;
alter table pending_clarifications add constraint pending_clarifications_kind_check
  check (kind in ('mms_upload', 'doc_upload_target', 'contact_disambiguation'));

alter table uploaded_documents add column if not exists loan_stage text;
alter table uploaded_documents drop constraint if exists uploaded_documents_loan_stage_check;
alter table uploaded_documents add constraint uploaded_documents_loan_stage_check
  check (loan_stage is null or loan_stage in (
    'Intake', 'Docs In', 'Submitted to Lender', 'Disclosures Out', 'Underwriting',
    'Conditional Approval', 'Conditions / Docs In', 'Clear to Close',
    'Docs Out / Signing', 'Funded', 'Purchased'
  ));

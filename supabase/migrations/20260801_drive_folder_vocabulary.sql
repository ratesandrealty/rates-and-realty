-- loan_stage -> drive_folder, LP_TIMELINE -> the Drive subfolder template.
--
-- WHY: the column was created against LP_TIMELINE, the Loan Processing pipeline
-- stages. That is the wrong taxonomy for a document. Where a document lives is
-- the ten-folder template every borrower folder already has — and one of those
-- folders is literally "Initial Loan Submission", which is the phrase Rene used
-- unprompted in the caption that started this. The pipeline stage of the LOAN
-- and the folder a DOCUMENT belongs in are different facts.
--
-- The rename is done now because nothing reads the column yet. Once a UI binds
-- to `loan_stage` it stops being free.

alter table uploaded_documents drop constraint if exists uploaded_documents_loan_stage_check;

-- Translate the values written under the old vocabulary.
update uploaded_documents set loan_stage = 'Initial Loan Submission' where loan_stage = 'Submitted to Lender';
update uploaded_documents set loan_stage = 'Final Loan Conditions'   where loan_stage = 'Conditions / Docs In';
-- Anything else from LP_TIMELINE has no folder equivalent; null it rather than
-- guess a destination.
update uploaded_documents set loan_stage = null
 where loan_stage is not null
   and loan_stage not in ('Initial Loan Submission','Final Loan Conditions','Lender Docs',
                          'Compensation Compliance Docs','LOEs','Appraisal','Invoices',
                          'Real Estate Docs','HOI','Escrow & Title');

alter table uploaded_documents rename column loan_stage to drive_folder;

alter table uploaded_documents add constraint uploaded_documents_drive_folder_check
  check (drive_folder is null or drive_folder in (
    'Initial Loan Submission','Final Loan Conditions','Lender Docs',
    'Compensation Compliance Docs','LOEs','Appraisal','Invoices',
    'Real Estate Docs','HOI','Escrow & Title'));

comment on column uploaded_documents.drive_folder is
  'Which subfolder of the borrower''s Google Drive folder this document belongs in. The ten-folder template, not a pipeline stage.';

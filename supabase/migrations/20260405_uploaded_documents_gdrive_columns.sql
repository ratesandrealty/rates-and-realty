-- Add Google Drive sync columns to uploaded_documents
ALTER TABLE uploaded_documents
  ADD COLUMN IF NOT EXISTS gdrive_file_id TEXT,
  ADD COLUMN IF NOT EXISTS gdrive_file_url TEXT;

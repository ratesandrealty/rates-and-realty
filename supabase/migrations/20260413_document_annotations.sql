-- Document annotations: overlay text notes stored separately from the PDF binary.
-- document_id is TEXT (not a FK to uploaded_documents) because the admin Documents
-- tab reads files straight from Google Drive, so document_id holds Drive file IDs
-- (strings like "1tTAEsB91vQ...") rather than uploaded_documents UUIDs.
CREATE TABLE IF NOT EXISTS document_annotations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id text        NOT NULL,
  contact_id  uuid        REFERENCES contacts(id) ON DELETE SET NULL,
  page        integer     NOT NULL DEFAULT 1,
  x           float       NOT NULL,
  y           float       NOT NULL,
  text        text        NOT NULL,
  font_size   integer     NOT NULL DEFAULT 12,
  color       text        NOT NULL DEFAULT '#000000',
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text
);

CREATE INDEX IF NOT EXISTS document_annotations_document_id_idx
  ON document_annotations (document_id);

CREATE INDEX IF NOT EXISTS document_annotations_contact_id_idx
  ON document_annotations (contact_id);

-- ============================================================================
-- Make the `borrower-documents` storage bucket PRIVATE + authenticated-only.
--
-- Context: this bucket holds borrower PII (pay stubs, W2s, IDs, bank statements).
-- It was public, so any object was fetchable by URL with no auth. All read paths
-- were migrated to short-lived signed URLs (frontend `_signedDocUrl`/`_docFileUrl`,
-- portal-data `get_documents`, google-drive-upload) BEFORE this flip, so nothing
-- breaks. Access model afterwards:
--   * admin (lead-detail.html)  -> authenticated session -> createSignedUrl
--   * borrower portal           -> portal-data (service role, bypasses RLS)
--   * sms-assistant / gdrive-sync / google-drive-upload -> service role
--   * gdrive-sync reads via service-role .download() (bypasses the public flag)
--
-- These statements mirror the changes applied live via MCP on 2026-07-23 so the
-- repo and the database stay in sync. They ALTER the existing storage policies
-- (created outside migrations) — only the role list is narrowed; the
-- qual/with_check (bucket_id = 'borrower-documents') is unchanged.
-- ============================================================================

-- 1) Bucket is no longer public: /object/public/borrower-documents/... now 400s.
update storage.buckets set public = false where id = 'borrower-documents';

-- 2) Drop `anon` from all three borrower-documents policies (was {anon,authenticated}).
--    Read: only authenticated can create signed URLs (service role bypasses RLS).
--    Write: no legitimate path writes as anon, so anon can no longer upload junk.
alter policy "Public read borrower-documents"   on storage.objects to authenticated;
alter policy "Public upload borrower-documents" on storage.objects to authenticated;
alter policy "Public update borrower-documents" on storage.objects to authenticated;

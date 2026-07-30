-- Applied remotely as migration version 20260730022900
-- lender-guidelines was the last bucket still granting storage writes TO public.
-- Verified before this change: an anon-key caller could INSERT a new object AND
-- overwrite an existing one (x-upsert) anywhere in the bucket. Combined with the
-- public /object/public/ read, that made the whole RAG guideline corpus
-- attacker-writable.
--
-- Outside-lender uploads now go through the lender-upload edge function, which
-- validates lenders.form_token and mints a signed upload URL scoped to a single
-- path inside that lender's own prefix. Signed upload tokens are authorized by
-- the token itself and bypass RLS, so they keep working after this lock.
--
-- Public SELECT stays for now: View links in lenders.html / guideline-ai.html
-- and textract-ocr still resolve /object/public/ URLs.

drop policy if exists lender_guidelines_insert on storage.objects;
drop policy if exists lender_guidelines_update on storage.objects;

create policy lender_guidelines_auth_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'lender-guidelines');

create policy lender_guidelines_auth_update on storage.objects
  for update to authenticated
  using (bucket_id = 'lender-guidelines')
  with check (bucket_id = 'lender-guidelines');

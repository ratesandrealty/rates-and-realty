-- Applied remotely as migration version 20260730050208
-- Composer attachments. PRIVATE: these are outbound business documents, frequently
-- borrower paperwork, so there is no public-read case for them at all.
--
-- Follows the storage policy standard used across this project: writes and reads are
-- granted TO authenticated only, never TO public. Retrieval is via createSignedUrl(),
-- which needs SELECT — hence an authenticated SELECT policy rather than a public one.
--
-- Flow: the composer uploads here with the authenticated client, then sends only the
-- storage paths to gmail-inbox, which downloads them with the service role to build the
-- multipart/mixed MIME and writes the same list onto email_log.attachments. Sending
-- bytes as base64 JSON instead would mean a ~27MB request body for a 20MB attachment.
insert into storage.buckets (id, name, public, file_size_limit)
values ('email-attachments', 'email-attachments', false, 20971520)
on conflict (id) do update
  set public = false, file_size_limit = 20971520;

drop policy if exists email_attachments_auth_insert on storage.objects;
drop policy if exists email_attachments_auth_select on storage.objects;
drop policy if exists email_attachments_auth_update on storage.objects;
drop policy if exists email_attachments_auth_delete on storage.objects;

create policy email_attachments_auth_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'email-attachments');

-- Needed by createSignedUrl(); the bucket stays non-public so there is no
-- unauthenticated /object/public/ route to these objects.
create policy email_attachments_auth_select on storage.objects
  for select to authenticated
  using (bucket_id = 'email-attachments');

create policy email_attachments_auth_update on storage.objects
  for update to authenticated
  using (bucket_id = 'email-attachments')
  with check (bucket_id = 'email-attachments');

create policy email_attachments_auth_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'email-attachments');

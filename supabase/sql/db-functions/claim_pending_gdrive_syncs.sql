-- claim_pending_gdrive_syncs(p_limit integer, p_contact uuid)
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.claim_pending_gdrive_syncs(p_limit integer DEFAULT 50, p_contact uuid DEFAULT NULL::uuid)
 RETURNS SETOF uploaded_documents
 LANGUAGE plpgsql
AS $function$
begin
  -- Claim-then-upload. sync_all_pending used to SELECT ... WHERE gdrive_file_id
  -- IS NULL, upload, then UPDATE. Between the select and the update, a
  -- concurrent run (the 10-minute cron overlapping a manual backfill) saw the
  -- same rows still unclaimed and uploaded them again. That is why Marlon has
  -- three copies of every SMS file and Santana five of one PDF.
  --
  -- SKIP LOCKED makes concurrent callers take disjoint sets. The claim stamp
  -- makes the exclusion outlive the transaction, and a claim older than 10
  -- minutes is reclaimable so a run that dies mid-upload strands nothing.
  return query
  with c as (
    select u.id
    from uploaded_documents u
    where u.gdrive_file_id is null
      and u.file_path is not null
      and (p_contact is null or u.contact_id = p_contact)
      and (u.gdrive_sync_claimed_at is null or u.gdrive_sync_claimed_at < now() - interval '10 minutes')
    order by u.created_at
    for update skip locked
    limit p_limit
  )
  update uploaded_documents u
     set gdrive_sync_claimed_at = now()
    from c
   where u.id = c.id
  returning u.*;
end
$function$;

-- save_fee_sheet_draft(p_contact_id uuid, p_data jsonb)
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.save_fee_sheet_draft(p_contact_id uuid, p_data jsonb)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  insert into public.fee_sheet_drafts (contact_id, data, updated_at)
  values (p_contact_id, coalesce(p_data, '{}'::jsonb), now())
  on conflict (contact_id)
  do update set data = excluded.data, updated_at = now();
$function$;

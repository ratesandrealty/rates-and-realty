-- crm_remediation(p_area text, p_check text)
-- language: sql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.crm_remediation(p_area text, p_check text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when p_area='outbound_http' then
      'An edge function or external API is exceeding pg_net''s 5s timeout. Find the slow endpoint in Supabase → Edge Functions → Logs; if it''s a heavy job (OCR/chunking) or a slow third-party API, make that call async or raise its timeout. To fix via Claude: paste this task and say "trace and fix the timeout."'
    when p_area='cron' then
      'A scheduled job failed on its last run. Inspect it: select status,return_message,start_time from cron.job_run_details order by start_time desc limit 20; then fix the function it calls or re-run the job.'
    when p_area='objects' then
      'A critical trigger/function/cron is MISSING — an automation or VA lock is currently inactive (likely dropped by a migration). Recreate it; paste this task into Claude to restore it.'
    when p_area='automations' then
      'ClickUp task creation is failing. Check the clickup_automation_log "error" column for the cause, verify the ClickUp API token, and confirm the clickup-bridge / clickup-auto-create edge functions are healthy.'
    when p_area='guidelines' then
      'Guideline sync looks stale. Confirm the gdrive-sync-guidelines-nightly job ran and the Google Drive connection is valid. Benign if no guideline files have changed recently.'
    else
      'Review the detail above. Paste this task into Claude (CRM tools connected) and ask it to investigate and fix.'
  end;
$function$;

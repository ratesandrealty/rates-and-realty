-- _task_clickup_sync(p_task_id uuid)
-- language: plpgsql
-- Captured from production 2026-08-14.

CREATE OR REPLACE FUNCTION public._task_clickup_sync(p_task_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  /* ── THE ONE SERVER-SIDE CLICKUP SEAM. DELIBERATELY A NO-OP. ─────────────
   * This is not dead code and should not be deleted as such.
   *
   * Step 4 replaces this body with an outbox insert that a five-minute cron
   * drains through clickup-bridge. It exists NOW so that every write path
   * already calls it: task_upsert and task_set_status both do.
   *
   * The failure mode being designed out is "every future author has to
   * remember to sync". That is how order_reminders_run, surface_stale_leads
   * and stripe-webhook came to create 63 tasks ClickUp has never seen — 38 of
   * them still open. One seam means Step 4 is a change to one function body
   * rather than a change to every caller, and a caller added next month gets
   * the sync without knowing it needed to ask.
   *
   * NOT a net.http_post yet, on purpose. pg_net returns a request id
   * immediately and cron.job_run_details reports 'succeeded' for a request
   * that was merely QUEUED (see CLAUDE.md on net._http_response). Shipping a
   * fire-and-forget POST that cannot be verified end to end would be a sync
   * that reports success and does nothing — the exact class of bug this whole
   * step is unwinding. */
  perform 1 where p_task_id is not null;
  return;
end; $function$;

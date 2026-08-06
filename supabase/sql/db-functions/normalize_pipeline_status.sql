-- normalize_pipeline_status()
-- language: plpgsql
-- Captured from production 2026-08-06. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.normalize_pipeline_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
/* Folds LEGACY pipeline_status values onto canonical ones. Runs BEFORE the
 * CHECK constraint, so anything it rewrites never reaches the constraint —
 * which is why an unrecognised stage does not error, it silently becomes
 * 'New Lead'.
 *
 * That is how the People page dropdown behaved until 2026-08-06: it offered
 * Qualified / Pre-Qualified / Application, none of which are stages, and
 * selecting one moved the contact BACKWARDS to New Lead without any error.
 * Worse than failing, because it looked like it worked and lost the stage.
 *
 * 'Follow Up' added to the canonical list. Without it this trigger would have
 * rewritten every Follow Up to New Lead and the new stage would have been
 * unusable while appearing to save — the same failure, one day old.
 *
 * STRICT: no aliases for Follow Up. This function exists for legacy values and
 * Follow Up has no legacy; inventing follow_up / Follow-Up would make the
 * canonical value ambiguous from day one. */
begin
  if new.pipeline_status is not null and new.pipeline_status not in
     ('New Lead','Contacted','Follow Up','Pre-Approved','Under Contract','Processing','Clear to Close','Closed','Lost')
  then
    new.pipeline_status := case
      when lower(new.pipeline_status) like 'new lead%' then 'New Lead'
      when lower(new.pipeline_status) like '%contacted%' then 'Contacted'
      else 'New Lead' end;
  end if;
  return new;
end; $function$;

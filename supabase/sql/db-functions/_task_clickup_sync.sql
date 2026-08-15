-- _task_clickup_sync(p_task_id uuid)
-- language: plpgsql
-- Captured from production 2026-08-15.

CREATE OR REPLACE FUNCTION public._task_clickup_sync(p_task_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* THE CLICKUP SEAM. Called by task_upsert and task_set_status; deliberately no
   new call sites were added for Step 4.
 *
 * It was a no-op from Step 3 until now. Its body is an ENQUEUE, not an HTTP
 * call, for the same reason the trigger's is: these run inside other people's
 * transactions and must not be able to fail them or block on a third party.
 *
 * clickup_enqueue is idempotent (unique on task_id) and self-filtering, so
 * calling this on a task that is already in ClickUp, already queued, terminal,
 * or not SQL-created costs one indexed lookup and does nothing. */
begin
  begin
    perform public.clickup_enqueue(p_task_id);
  exception when others then
    null;
  end;
end;
$function$;

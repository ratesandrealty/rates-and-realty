-- resolve_chat_task_ids()
-- language: plpgsql
-- Captured from production 2026-08-11.

CREATE OR REPLACE FUNCTION public.resolve_chat_task_ids()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_n int := 0;
begin
  with pend as (
    select a.id, (substring(a.external_task_id from 9))::bigint as req
    from public.app_notifications a
    where a.external_task_id like 'pending:%'
  ), resolved as (
    select p.id,
           (r.content::jsonb ->> 'clickup_task_id') as task_id
    from pend p
    join net._http_response r on r.id = p.req
    where r.status_code = 200 and r.content is not null
  )
  update public.app_notifications a
     set external_task_id = resolved.task_id
    from resolved
   where a.id = resolved.id and resolved.task_id is not null;
  get diagnostics v_n = row_count;
  return v_n;
end; $function$;

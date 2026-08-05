-- log_ae_task_notes()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.log_ae_task_notes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare v_actor text; v_cid uuid;
begin
  if auth.uid() is null or coalesce(new.kind,'') <> 'note' then return null; end if;
  select contact_id into v_cid from public.tasks where id = new.task_id;
  select email into v_actor from auth.users where id = auth.uid();
  begin
    insert into activity_events(contact_id,type,title,description,created_by,channel,metadata)
    values (v_cid,'note','Task note by '||coalesce(v_actor,'staff'),
            left(coalesce(new.note,''),200),auth.uid(),'system',
            jsonb_build_object('task_id',new.task_id,'source','task'));
  exception when others then null; end;
  return null;
end; $function$;

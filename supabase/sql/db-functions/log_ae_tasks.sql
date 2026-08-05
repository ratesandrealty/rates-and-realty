-- log_ae_tasks()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.log_ae_tasks()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare v_actor text;
begin
  if auth.uid() is null then return null; end if;                 -- skip system/bot writes
  select email into v_actor from auth.users where id = auth.uid();
  begin
    if TG_OP='INSERT' then
      insert into activity_events(contact_id,type,title,description,created_by,channel,metadata)
      values (new.contact_id,'task_created','Task created: '||left(coalesce(new.title,''),120),
              'by '||coalesce(v_actor,'staff'),auth.uid(),'system',
              jsonb_build_object('task_id',new.id,'actor_email',v_actor));
    elsif TG_OP='UPDATE'
      and lower(coalesce(new.status,'')) in ('completed','complete','done')
      and lower(coalesce(old.status,'')) not in ('completed','complete','done') then
      insert into activity_events(contact_id,type,title,description,created_by,channel,metadata)
      values (new.contact_id,'task_completed','Task completed: '||left(coalesce(new.title,''),120),
              'by '||coalesce(v_actor,'staff'),auth.uid(),'system',
              jsonb_build_object('task_id',new.id,'actor_email',v_actor));
    end if;
  exception when others then null; end;
  return null;
end; $function$;

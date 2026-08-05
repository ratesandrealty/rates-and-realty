-- log_ae_contact_notes()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.log_ae_contact_notes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare v_actor text;
begin
  if auth.uid() is null then return null; end if;
  select email into v_actor from auth.users where id = auth.uid();
  begin
    insert into activity_events(contact_id,type,title,description,created_by,channel,metadata)
    values (new.contact_id,'note','Note by '||coalesce(v_actor,'staff'),
            left(coalesce(new.note_text,''),200),auth.uid(),'system',
            jsonb_build_object('note_id',new.id,'source','lead'));
  exception when others then null; end;
  return null;
end; $function$;

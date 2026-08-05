-- log_ae_lead_shares()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.log_ae_lead_shares()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare v_actor text; v_target text; v_row public.lead_shares;
begin
  if auth.uid() is null then return null; end if;
  v_row := case when TG_OP='DELETE' then old else new end;
  select email into v_actor  from auth.users where id = auth.uid();
  select email into v_target from auth.users where id = v_row.shared_with_user_id;
  begin
    insert into activity_events(contact_id,type,title,description,created_by,channel,metadata)
    values (v_row.contact_id,
            case when TG_OP='DELETE' then 'lead_unshared' else 'lead_shared' end,
            case when TG_OP='DELETE' then 'Unshared from '||coalesce(v_target,'staff')
                 else 'Shared with '||coalesce(v_target,'staff') end,
            'by '||coalesce(v_actor,'staff'),auth.uid(),'system',
            jsonb_build_object('target_user',v_row.shared_with_user_id));
  exception when others then null; end;
  return null;
end; $function$;

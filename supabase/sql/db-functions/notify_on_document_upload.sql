-- notify_on_document_upload()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.notify_on_document_upload()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner uuid; v_cell text; v_name text; v_file text; v_preview text;
  v_link text; v_recent_text int;
begin
  if NEW.type is distinct from 'document_uploaded' then return NEW; end if;
  if NEW.contact_id is null then return NEW; end if;

  select value::uuid into v_owner from app_config where key = 'owner_user_id';
  select value        into v_cell  from app_config where key = 'owner_cell_phone';

  select nullif(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')),'')
    into v_name from contacts where id = NEW.contact_id;
  v_name := coalesce(v_name, 'A borrower');

  v_file := coalesce(nullif(trim(NEW.metadata->>'file_name'),''),
                     nullif(trim(NEW.title),''), 'a document');

  v_link := 'https://admin.ratesandrealty.com/admin/lead-detail?contact_id='
            || NEW.contact_id || '#documents';

  -- 1) dashboard bell (every upload)
  if v_owner is not null then
    v_preview := left(v_name || ' uploaded ' || v_file, 140);
    insert into app_notifications(recipient_user_id, actor_display, kind, source_kind,
                                  contact_id, preview, is_read)
    values (v_owner, v_name, 'doc_uploaded', 'document', NEW.contact_id, v_preview, false);
  end if;

  -- 2) text to cell — BATCHED: max one per borrower per hour
  if v_cell is not null then
    select count(*) into v_recent_text
    from sms_log
    where contact_id = NEW.contact_id
      and trigger_type = 'doc_upload_alert'
      and created_at > now() - interval '1 hour';

    if v_recent_text = 0 then
      insert into sms_log(contact_id, to_phone, body, direction, status,
                          scheduled_at, trigger_type, created_at)
      values (NEW.contact_id, v_cell,
              '📄 ' || v_name || ' uploaded a document (' || left(v_file, 40) || '). View: ' || v_link,
              'outbound', 'scheduled', now(), 'doc_upload_alert', now());
    end if;
  end if;

  return NEW;
end; $function$;

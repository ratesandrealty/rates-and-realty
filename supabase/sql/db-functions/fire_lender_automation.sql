-- fire_lender_automation()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.fire_lender_automation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_trigger text;
  v_contact uuid;
  v_lender  text;
  v_source  text;
  v_status  text := lower(coalesce(NEW.status, ''));
  v_url     text := 'https://ljywhvbmsibwnssxpesh.supabase.co/functions/v1/clickup-auto-create';
  v_anon    text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxqeXdodmJtc2lid25zc3hwZXNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNjE2NTUsImV4cCI6MjA4OTYzNzY1NX0.QaewUhTWdATj35VewvmfQcHB_b3I9FhhwXSRuqNBKvw';
begin
  if (TG_OP = 'INSERT') then
    v_trigger := 'lender_submitted';
    v_source  := NEW.id::text;
  else
    if (NEW.status is not distinct from OLD.status) then
      return NEW;
    end if;
    if v_status ~ '(suspend|den|declin|reject|withdraw|cancel)' then
      v_trigger := 'lender_denied';
    elsif v_status ~ 'condition' then
      v_trigger := 'lender_conditions';
    elsif v_status ~ '(clear|ctc|approv|fund)' then
      v_trigger := 'lender_cleared';
    elsif v_status ~ '(submit|sent|pending)' then
      v_trigger := 'lender_submitted';
    else
      return NEW;
    end if;
    v_source := NEW.id::text || ':' || v_trigger;
  end if;

  v_contact := coalesce(NEW.contact_id, NEW.lead_id);

  select name into v_lender from public.lenders where id = NEW.lender_id;
  v_lender := coalesce(v_lender, 'the lender');

  begin
    perform net.http_post(
      url     := v_url,
      body    := jsonb_build_object(
                   'trigger_type', v_trigger,
                   'contact_id',   v_contact,
                   'source_id',    v_source,
                   'context',      jsonb_build_object('lender', v_lender)
                 ),
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'apikey',        v_anon,
                   'Authorization', 'Bearer ' || v_anon
                 )
    );
  exception when others then
    null; -- never block the submission write if the automation call fails
  end;

  return NEW;
end;
$function$;

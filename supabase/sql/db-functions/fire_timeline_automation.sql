-- fire_timeline_automation()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.fire_timeline_automation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  tl        text;
  trig      text;
  ctx       jsonb;
  last_note text;
  important text;
begin
  if TG_OP = 'UPDATE' and (NEW.timeline is not distinct from OLD.timeline) then
    return NEW;
  end if;
  tl := lower(coalesce(NEW.timeline, ''));
  if tl = '' then return NEW; end if;

  if tl like '%asap%' then               trig := 'timeline_asap';
  elsif tl ~ '6[ _–-]*12' then            trig := 'timeline_6_12mo';
  elsif tl ~ '3[ _–-]*6'  then            trig := 'timeline_3_6mo';
  elsif tl ~ '1[ _–-]*3'  then            trig := 'timeline_1_3mo';
  else
    return NEW;
  end if;

  select note_text into last_note
    from contact_notes where contact_id = NEW.id order by created_at desc limit 1;
  if last_note is null then last_note := NEW.notes; end if;

  important := coalesce(nullif(NEW.ai_summary,''), nullif(NEW.next_action,''), '—');

  ctx := jsonb_build_object(
    'timeline_label', NEW.timeline,
    'loan_type',      coalesce(nullif(NEW.closing_loan_type,''), nullif(NEW.loan_type,''), '—'),
    'loan_amount',    case when NEW.loan_amount is not null then '$'||to_char(NEW.loan_amount,'FM999,999,999') else '—' end,
    'purchase_price', case when NEW.purchase_price is not null then '$'||to_char(NEW.purchase_price,'FM999,999,999') else '—' end,
    'ltv',            case when NEW.ltv is not null then trim(trailing '.00' from NEW.ltv::text)||'%' else '—' end,
    'pipeline',       coalesce(nullif(NEW.pipeline_status,''),'—'),
    'lead_source',    coalesce(nullif(NEW.source,''), nullif(NEW.lead_source,''), '—'),
    'priority',       coalesce(nullif(NEW.priority,''),'—'),
    'important_info', important,
    'last_note',      coalesce(nullif(last_note,''),'—'),
    'lead_url',       'https://admin.ratesandrealty.com/admin/lead-detail.html?contact_id='||NEW.id::text
  );

  perform public.fire_clickup_automation(trig, NEW.id, tl, ctx);
  return NEW;
end;
$function$;

-- loan_health(p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.loan_health(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dates jsonb; v_overdue int:=0; v_soon int:=0;
  v_cond_pending int; v_cond_cleared int;
  v_items_done int; v_items_total int;
  v_urgent jsonb; v_warn jsonb:='[]'; v_status text;
  v_has_coe boolean; v_has_signing boolean; v_has_funding boolean;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'date_key', date_key,
           'label', coalesce(nullif(label,''), initcap(replace(date_key,'_',' '))),
           'date_value', date_value, 'completed', completed,
           'days_until', (date_value - current_date),
           'urgency', case
             when completed then 'met'
             when date_value is null then 'unset'
             when date_value < current_date then 'overdue'
             when date_value <= current_date + 2 then 'red'
             when date_value <= current_date + 5 then 'amber'
             else 'ok' end
         ) order by date_value nulls last), '[]')
    into v_dates
  from public.loan_key_dates where contact_id = p_contact_id;

  select count(*) filter (where (e->>'urgency')='overdue'),
         count(*) filter (where (e->>'urgency') in ('red','amber'))
    into v_overdue, v_soon
  from jsonb_array_elements(v_dates) e;

  select count(*) filter (where status='pending'), count(*) filter (where status='cleared')
    into v_cond_pending, v_cond_cleared
  from public.loan_conditions where contact_id = p_contact_id;

  select count(*) filter (where completed), count(*)
    into v_items_done, v_items_total
  from public.processing_items where contact_id = p_contact_id and coalesce(dismissed,false)=false;

  select bool_or(date_key='close_of_escrow' and (date_value is not null or completed)),
         bool_or(date_key='signing' and (date_value is not null or completed)),
         bool_or(date_key='funding' and (date_value is not null or completed))
    into v_has_coe, v_has_signing, v_has_funding
  from public.loan_key_dates where contact_id = p_contact_id;

  -- urgent items now carry target + date_key for exact click-navigation
  select coalesce(jsonb_agg(jsonb_build_object('type','date','target','date','date_key', e->>'date_key','label', e->>'label','date', e->>'date_value','urgency', e->>'urgency')),'[]')
    into v_urgent
  from jsonb_array_elements(v_dates) e where (e->>'urgency') in ('overdue','red');

  if v_cond_pending > 0 then
    v_urgent := v_urgent || jsonb_build_array(jsonb_build_object('type','conditions','target','conditions','label', v_cond_pending||' conditions still pending','urgency', case when v_cond_pending>=10 then 'red' else 'amber' end));
  end if;

  -- warnings also carry a date_key so "…not set" rows navigate to the right field
  if not coalesce(v_has_coe,false) then v_warn := v_warn || jsonb_build_array(jsonb_build_object('text','Close of Escrow date not set','date_key','close_of_escrow')); end if;
  if not coalesce(v_has_signing,false) then v_warn := v_warn || jsonb_build_array(jsonb_build_object('text','Signing date not set','date_key','signing')); end if;
  if not coalesce(v_has_funding,false) then v_warn := v_warn || jsonb_build_array(jsonb_build_object('text','Funding date not set','date_key','funding')); end if;

  v_status := case when v_overdue > 0 then 'behind' when v_soon > 0 or v_cond_pending >= 10 then 'at_risk' else 'on_track' end;

  return jsonb_build_object(
    'status', v_status, 'dates', v_dates,
    'overdue_count', v_overdue, 'soon_count', v_soon,
    'conditions', jsonb_build_object('pending', v_cond_pending, 'cleared', v_cond_cleared),
    'checklist', jsonb_build_object('done', v_items_done, 'total', v_items_total),
    'urgent_items', v_urgent, 'warnings', v_warn
  );
end; $function$;

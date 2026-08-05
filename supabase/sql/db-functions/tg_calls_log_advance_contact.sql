-- tg_calls_log_advance_contact()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.tg_calls_log_advance_contact()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_out text := lower(coalesce(new.outcome,'')); v_title text;
begin
  if new.contact_id is null then return new; end if;

  -- advance the contact based on outcome
  update contacts set
    last_contact_date           = coalesce(new.created_at, now()),
    last_meaningful_activity_at = coalesce(new.created_at, now()),
    pipeline_status  = case when v_out in ('contacted','connected','interested','answered','reached')
                              and pipeline_status = 'New Lead' then 'Contacted' else pipeline_status end,
    deal_outcome     = case when v_out = 'not_interested' then 'lost' else deal_outcome end,
    lost_reason      = case when v_out = 'not_interested'
                              then coalesce(nullif(trim(coalesce(new.notes,'')),''), lost_reason) else lost_reason end,
    do_not_call      = case when v_out in ('bad_number','wrong_number','do_not_call','dnc') then true else do_not_call end,
    next_followup_at = case when v_out in ('callback','call_back','scheduled')
                              then coalesce(next_followup_at, coalesce(new.created_at, now()) + interval '1 day')
                              else next_followup_at end,
    updated_at = now()
  where id = new.contact_id;

  -- surface the call in the activity feed (so dialer calls show on the dashboard)
  v_title := 'Call'
    || case when nullif(v_out,'') is not null then ': ' || initcap(replace(v_out,'_',' '))
            when new.status is not null then ' (' || new.status || ')' else '' end
    || case when coalesce(new.duration,0) > 0 then ' · ' || new.duration || 's' else '' end;

  insert into activity_events(contact_id, lead_id, type, title, description, direction, channel, status, created_at, metadata)
  values (new.contact_id, new.contact_id, 'call', v_title,
          nullif(trim(coalesce(new.notes,'')),''),
          new.direction, 'phone', new.status, coalesce(new.created_at, now()),
          jsonb_build_object('outcome', new.outcome, 'duration', new.duration,
                             'recording_url', new.recording_url, 'twilio_call_sid', new.twilio_call_sid,
                             'calls_log_id', new.id));
  return new;
end; $function$;

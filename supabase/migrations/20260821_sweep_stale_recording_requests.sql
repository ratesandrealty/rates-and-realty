-- sweep_stale_recording_requests()
-- language: plpgsql
-- Captured from production 2026-08-21.

CREATE OR REPLACE FUNCTION public.sweep_stale_recording_requests()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_n integer;
begin
  with stale as (
    select id from calls_log
     where recording_disposition = 'requested'
       and recording_url is null
       and (
         case
           when coalesce(status,'') in ('completed','no-answer','busy','failed','canceled','blocked_calling_hours')
             then created_at + make_interval(secs => coalesce(duration, 0)) < now() - interval '15 minutes'
           else created_at < now() - interval '4 hours'
         end
       )
  )
  update calls_log c
     set recording_disposition = 'unavailable'
    from stale s
   where c.id = s.id;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    raise log 'sweep_stale_recording_requests: % row(s) downgraded requested -> unavailable', v_n;
  end if;
  return v_n;
end;
$function$;


revoke execute on function public.sweep_stale_recording_requests() from public, anon;

-- Every 15 minutes. Nothing watches Twilio's recording callbacks, and an
-- absence cannot trigger a handler -- see the note inside the function.
select cron.schedule(
  'recording-request-sweep',
  '*/15 * * * *',
  $$select public.sweep_stale_recording_requests();$$
);

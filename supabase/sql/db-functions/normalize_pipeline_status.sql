-- normalize_pipeline_status()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.normalize_pipeline_status()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.pipeline_status is not null
     and new.pipeline_status not in
       ('New Lead','Contacted','Pre-Approved','Under Contract','Processing','Clear to Close','Closed','Lost')
  then
    new.pipeline_status := case
      when lower(new.pipeline_status) like 'new lead%' then 'New Lead'
      when lower(new.pipeline_status) like '%contacted%' then 'Contacted'
      else 'New Lead'
    end;
  end if;
  return new;
end;
$function$;

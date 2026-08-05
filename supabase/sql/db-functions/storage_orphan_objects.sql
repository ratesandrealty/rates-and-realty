-- storage_orphan_objects(p_bucket text, p_refs text[])
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.storage_orphan_objects(p_bucket text, p_refs text[])
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'storage'
AS $function$
declare
  cond text := '';
  r text; parts text[];
  n bigint;
begin
  foreach r in array p_refs loop
    parts := string_to_array(r, '.');
    cond := cond || format(
      ' and not exists (select 1 from public.%I t where t.%I = o.name)',
      parts[1], parts[2]);
  end loop;
  execute format('select count(*) from storage.objects o where o.bucket_id = %L %s', p_bucket, cond) into n;
  return n;
end $function$;

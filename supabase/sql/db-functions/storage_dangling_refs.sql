-- storage_dangling_refs(p_table text, p_column text, p_bucket text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.storage_dangling_refs(p_table text, p_column text, p_bucket text)
 RETURNS TABLE(path text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'storage'
AS $function$
begin
  return query execute format(
    'select t.%I::text from public.%I t
      where t.%I is not null
        and not exists (select 1 from storage.objects o
                        where o.bucket_id = %L and o.name = t.%I)
      limit 200',
    p_column, p_table, p_column, p_bucket, p_column);
end $function$;

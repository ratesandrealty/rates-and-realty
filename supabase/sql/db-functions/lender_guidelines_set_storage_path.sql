-- lender_guidelines_set_storage_path()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.lender_guidelines_set_storage_path()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  raw text;
  bin bytea := '';
  chunk text;
begin
  if new.storage_path is not null and new.storage_path <> '' then
    return new;
  end if;
  if new.file_url is null then
    return new;
  end if;

  raw := substring(new.file_url from '/storage/v1/object/(?:public/)?lender-guidelines/(.+)$');
  if raw is null then
    return new;
  end if;

  -- Percent-decode: lender-form.html historically encoded '/' as %2F.
  for chunk in select (regexp_matches(raw, '(%[0-9a-fA-F]{2}|.)', 'g'))[1] loop
    if length(chunk) = 3 and left(chunk, 1) = '%' then
      bin := bin || decode(substring(chunk, 2, 2), 'hex');
    else
      bin := bin || convert_to(chunk, 'utf8');
    end if;
  end loop;

  new.storage_path := convert_from(bin, 'utf8');
  return new;
end $function$;

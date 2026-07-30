-- Applied remotely as migration version 20260730023605
-- Guarantee storage_path is populated regardless of which writer created the row.
-- Writers today: the lender-upload edge function (sets it explicitly) and
-- textract-ocr (does not). Rather than redeploy every producer and hope the next
-- one remembers, derive it here whenever it is missing but file_url is present.
--
-- This is what makes the eventual private-bucket migration a policy flip: once
-- every row carries the key, no consumer needs the /object/public/ URL shape.

create or replace function public.lender_guidelines_set_storage_path()
returns trigger language plpgsql as $$
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
end $$;

drop trigger if exists trg_lender_guidelines_storage_path on public.lender_guidelines;
create trigger trg_lender_guidelines_storage_path
  before insert or update of file_url, storage_path on public.lender_guidelines
  for each row execute function public.lender_guidelines_set_storage_path();

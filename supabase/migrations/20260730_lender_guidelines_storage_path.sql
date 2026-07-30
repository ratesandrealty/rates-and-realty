-- Applied remotely as migration version 20260730022333
-- Decouple the delete path from public-URL string parsing.
-- guideline-ai.html and lenders.html both regex the public URL out of file_url to
-- recover the storage key. That breaks the moment the bucket goes private (the
-- /object/public/ marker disappears), so store the key explicitly instead.
alter table public.lender_guidelines add column if not exists storage_path text;

-- Backfill needs real percent-decoding: lender-form.html built its URL with
-- encodeURIComponent(path), which encodes the '/' separators as %2F, while
-- lenders.html encoded only the bare filename. Both must decode correctly.
create or replace function public._lg_url_decode(input text) returns text
language plpgsql immutable as $$
declare bin bytea := ''; chunk text;
begin
  if input is null then return null; end if;
  for chunk in select (regexp_matches(input, '(%[0-9a-fA-F]{2}|.)', 'g'))[1] loop
    if length(chunk) = 3 and left(chunk, 1) = '%' then
      bin := bin || decode(substring(chunk, 2, 2), 'hex');
    else
      bin := bin || convert_to(chunk, 'utf8');
    end if;
  end loop;
  return convert_from(bin, 'utf8');
end $$;

update public.lender_guidelines
set storage_path = public._lg_url_decode(
  substring(file_url from '/storage/v1/object/public/lender-guidelines/(.+)$')
)
where storage_path is null
  and file_url like '%/storage/v1/object/public/lender-guidelines/%';

drop function public._lg_url_decode(text);

comment on column public.lender_guidelines.storage_path is
  'Storage object key within the lender-guidelines bucket. Authoritative for deletes; do not re-parse file_url.';

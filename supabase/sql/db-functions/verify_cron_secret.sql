-- verify_cron_secret(p_name text, p_secret text)
-- language: plpgsql
-- Captured from production 2026-08-07.

CREATE OR REPLACE FUNCTION public.verify_cron_secret(p_name text, p_secret text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
declare
  v_expected text;
begin
  if p_secret is null or p_secret = '' then
    return false;
  end if;

  select decrypted_secret into v_expected
  from vault.decrypted_secrets
  where name = p_name;

  -- A missing secret is a NO. Returning true when unconfigured would make the
  -- guard evaporate the moment someone renamed a vault entry.
  if v_expected is null then
    return false;
  end if;

  -- Length first, then a fixed-cost comparison over the whole string, so the
  -- time taken does not reveal how many leading characters were right.
  if length(p_secret) <> length(v_expected) then
    return false;
  end if;

  return (
    select bool_and(substr(p_secret, i, 1) = substr(v_expected, i, 1))
    from generate_series(1, length(v_expected)) as g(i)
  );
end;
$function$;

-- cron_secret_get(p_name text)
-- language: plpgsql
-- Captured from production 2026-08-06.

CREATE OR REPLACE FUNCTION public.cron_secret_get(p_name text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
/* Read a cron credential out of vault. SERVICE ROLE ONLY.
 *
 * vault.decrypted_secrets is not reachable through PostgREST, and it must not
 * become reachable — this returns exactly one named secret to a caller that
 * already holds the service key, so it grants nothing the caller did not have.
 * A session user, the anon key, or any authenticated role gets nothing.
 *
 * Named allowlist rather than "any secret": a future caller cannot pass an
 * arbitrary name and read something unrelated. */
declare v text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role only';
  end if;
  if p_name not in ('proactive_followups_secret', 'market_rate_cron_secret') then
    raise exception 'unknown secret name';
  end if;
  select decrypted_secret into v from vault.decrypted_secrets where name = p_name;
  return v;
end; $function$;

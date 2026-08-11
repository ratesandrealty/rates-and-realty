-- internal_call_headers()
-- language: sql
-- Captured from production 2026-08-11.
--
-- Headers for a net.http_post made BY POSTGRES, proving where it came from.
--
-- Postgres cannot hold the service key: it is an edge-function environment
-- variable. The two DB functions that already send an Authorization header
-- (trigger_score_recalc, fire_lender_automation) solve that by pasting a JWT
-- into pg_proc in cleartext, where anyone with database read access can lift it.
-- This does not.
--
-- internal_db_caller_secret was minted server-side by gen_random_bytes straight
-- into the vault and has never been printed. This reads it at call time;
-- _shared/require-staff.ts hands it back to verify_cron_secret(), which answers
-- only true or false. The value exists in exactly one place.
--
-- Used by app_notify_mentions, send_daily_digest, send_stalled_deals_digest,
-- tg_app_notifications_chat and tg_app_notifications_email — eleven call sites
-- that previously sent Content-Type and nothing else.

CREATE OR REPLACE FUNCTION public.internal_call_headers()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
  select jsonb_build_object(
    'Content-Type', 'application/json',
    'x-internal-secret',
      (select decrypted_secret from vault.decrypted_secrets
        where name = 'internal_db_caller_secret')
  );
$function$;

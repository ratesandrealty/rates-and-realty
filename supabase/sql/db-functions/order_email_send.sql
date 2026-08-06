-- order_email_send(p_order_id uuid, p_to_email text, p_subject text, p_html text, p_from_key text, p_to_name text, p_cc text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-06. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.order_email_send(p_order_id uuid, p_to_email text, p_subject text, p_html text, p_from_key text DEFAULT 'processing'::text, p_to_name text DEFAULT NULL::text, p_cc text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* RETIRED 2026-08-06. Do not restore.
 *
 * This used net.http_post — fire-and-forget, so no HTTP result is knowable here
 * — inside `exception when others then null`, and then wrote an order_note
 * reading "📧 Emailed <name>" and returned success:true UNCONDITIONALLY. Every
 * failure was indistinguishable from a send, on a path where the note is the
 * only record anyone reads.
 *
 * Replaced by: order_email_envelope() to resolve from/cc/bcc/reply_to, the
 * CALLER invoking email-service and seeing a real result, then
 * order_email_note() to record what actually happened.
 *
 * It raises rather than being dropped so that any caller I did not find fails
 * LOUDLY instead of silently reporting a success it cannot observe. */
begin
  raise exception 'order_email_send is retired — use order_email_envelope() + email-service + order_email_note()';
end; $function$;

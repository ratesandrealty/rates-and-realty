-- partner_activity(p_partner_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.partner_activity(p_partner_id uuid)
 RETURNS TABLE(id uuid, type text, channel text, direction text, title text, description text, email_subject text, sms_body text, status text, duration_seconds integer, created_at timestamp without time zone, created_by uuid, editable boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_email text; v_phone text;
begin
  if auth.role() = 'authenticated' and not public.is_admin() then raise exception 'admin only'; end if;
  select lower(coalesce(rp.email,'')), regexp_replace(coalesce(rp.phone,''), '\D', '', 'g')
    into v_email, v_phone
  from referral_partners rp where rp.id = p_partner_id;
  return query
  select ae.id, ae.type, ae.channel, ae.direction, ae.title, ae.description,
         ae.email_subject, ae.sms_body, ae.status, ae.duration_seconds,
         ae.created_at, ae.created_by,
         (ae.partner_id = p_partner_id) as editable
  from activity_events ae
  where ae.partner_id = p_partner_id
     or (ae.partner_id is null and v_email <> '' and lower(coalesce(ae.email_to,'')) = v_email)
     or (ae.partner_id is null and v_phone <> '' and regexp_replace(coalesce(ae.sms_to,''), '\D', '', 'g') = v_phone)
  order by ae.created_at desc
  limit 200;
end;
$function$;

-- is_phone_suppressed(p_phone text, p_contact_id uuid)
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.is_phone_suppressed(p_phone text, p_contact_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.sms_suppressions s
     where length(public.sms_norm_phone(p_phone)) >= 10
       and s.phone = public.sms_norm_phone(p_phone)
  ) or exists (
    select 1 from public.contacts c
     where c.sms_opt_in is false
       and (
         (p_contact_id is not null and c.id = p_contact_id)
         or (length(public.sms_norm_phone(p_phone)) >= 10 and (
              public.sms_norm_phone(c.phone) = public.sms_norm_phone(p_phone)
           or public.sms_norm_phone(c.secondary_phone) = public.sms_norm_phone(p_phone)))
       )
  )
$function$;

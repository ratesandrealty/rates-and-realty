-- contact_set_dnc(p_contact_id uuid, p_value boolean, p_reason text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.contact_set_dnc(p_contact_id uuid, p_value boolean DEFAULT true, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_disp text := coalesce((select coalesce(nullif(raw_user_meta_data->>'full_name',''), email) from auth.users where id=auth.uid()),'Admin');
begin
  if auth.role()='authenticated' and not public.is_admin() then raise exception 'admin only'; end if;
  update contacts set do_not_call = coalesce(p_value,true) where id = p_contact_id;
  insert into contact_notes (id, contact_id, author_user_id, author_display, note_text, source, created_at)
  values (gen_random_uuid(), p_contact_id, auth.uid(), v_disp,
          case when coalesce(p_value,true) then 'Marked DO NOT CALL' else 'Cleared Do-Not-Call' end
            || coalesce(' — '||p_reason,''), 'dnc', now());
end;
$function$;

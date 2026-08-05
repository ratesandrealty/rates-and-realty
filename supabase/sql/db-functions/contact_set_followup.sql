-- contact_set_followup(p_contact_id uuid, p_when timestamp with time zone, p_note text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.contact_set_followup(p_contact_id uuid, p_when timestamp with time zone, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_disp text := coalesce((select coalesce(nullif(raw_user_meta_data->>'full_name',''), email) from auth.users where id=auth.uid()),'Admin');
begin
  if auth.role()='authenticated' and not public.is_admin() then raise exception 'admin only'; end if;
  update contacts set next_followup_at = p_when where id = p_contact_id;
  if nullif(trim(coalesce(p_note,'')),'') is not null then
    insert into contact_notes (id, contact_id, author_user_id, author_display, note_text, source, created_at)
    values (gen_random_uuid(), p_contact_id, auth.uid(), v_disp,
            'Callback set for '||to_char(p_when,'Mon DD, YYYY HH24:MI')||' — '||p_note, 'callback', now());
  end if;
end;
$function$;

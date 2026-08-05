-- add_contact_note(p_contact_id uuid, p_note text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.add_contact_note(p_contact_id uuid, p_note text)
 RETURNS contact_notes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare v_row public.contact_notes; v_email text;
begin
  if p_contact_id is null or nullif(trim(coalesce(p_note,'')),'') is null then
    raise exception 'contact and note required';
  end if;
  if not (is_admin() or coalesce(current_app_role(),'') <> 'va' or is_lead_shared_with_me(p_contact_id)) then
    raise exception 'not authorized for this lead';
  end if;
  select email into v_email from auth.users where id = auth.uid();
  insert into public.contact_notes(contact_id, note_text, author_user_id, author_display, source, created_at, updated_at)
  values (p_contact_id, trim(p_note), auth.uid(), coalesce(v_email,'Staff'), 'crm', now(), now())
  returning * into v_row;
  return v_row;
end; $function$;

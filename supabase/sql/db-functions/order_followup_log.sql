-- order_followup_log(p_order_id uuid, p_note_text text, p_author_display text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.order_followup_log(p_order_id uuid, p_note_text text DEFAULT NULL::text, p_author_display text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_id uuid; v_lead uuid; v_text text;
begin
  if auth.role() = 'authenticated'
     and not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','lender','staff')) then
    raise exception 'staff only';
  end if;

  select contact_id into v_lead from public.loan_orders where id = p_order_id;

  -- empty note is allowed here: default to a simple marker so the log shows the touch
  v_text := nullif(trim(coalesce(p_note_text,'')), '');
  if v_text is null then v_text := '↻ Followed up'; end if;

  insert into public.order_notes(order_id, contact_id, note_text, is_follow_up,
                                 author_user_id, author_display, source, created_at)
  values(p_order_id, v_lead, v_text, true,
         auth.uid(), coalesce(p_author_display,'Rene'), 'processing', now())
  returning id into v_id;

  return v_id;
end; $function$;

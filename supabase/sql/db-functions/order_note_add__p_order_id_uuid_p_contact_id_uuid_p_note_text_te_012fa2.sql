-- order_note_add(p_order_id uuid, p_contact_id uuid, p_note_text text, p_is_request boolean)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.order_note_add(p_order_id uuid, p_contact_id uuid, p_note_text text, p_is_request boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_id uuid; v_disp text;
begin
  v_role := coalesce(public.current_app_role(),'');
  if not (public.is_admin() or v_role in ('va','loa','agent','staff')) then
    raise exception 'not authorized';
  end if;
  if coalesce(trim(p_note_text),'') = '' then raise exception 'note text required'; end if;
  select coalesce(nullif(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')),''), email)
    into v_disp from auth_user_roles aur left join contacts c on false where aur.user_id = auth.uid() limit 1;

  insert into public.order_notes(order_id, contact_id, note_text, is_follow_up, author_user_id, author_display, source)
  values (p_order_id, p_contact_id, case when p_is_request then '🔔 REQUEST: '||p_note_text else p_note_text end,
          false, auth.uid(), coalesce(v_disp,'Staff'),
          case when p_is_request then 'update_request' else 'note' end)
  returning id into v_id;
  update public.loan_orders set last_note_at = now() where id = p_order_id;
  return jsonb_build_object('id', v_id, 'ok', true);
end; $function$;

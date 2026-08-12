-- order_note_add(p_order_id uuid, p_note_text text, p_is_follow_up boolean, p_author_display text)
-- language: plpgsql
-- Captured from production 2026-08-12.

CREATE OR REPLACE FUNCTION public.order_note_add(p_order_id uuid, p_note_text text, p_is_follow_up boolean DEFAULT false, p_author_display text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_id uuid; v_lead uuid;
begin
  if coalesce(auth.role(),'') is distinct from 'service_role'
     and not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','lender','staff')) then
    raise exception 'staff only';
  end if;
  if coalesce(trim(p_note_text),'') = '' then raise exception 'note text required'; end if;

  select contact_id into v_lead from public.loan_orders where id = p_order_id;

  insert into public.order_notes(order_id, contact_id, note_text, is_follow_up,
                                 author_user_id, author_display, source, created_at)
  values(p_order_id, v_lead, p_note_text, coalesce(p_is_follow_up,false),
         auth.uid(), coalesce(p_author_display,'Rene'), 'processing', now())
  returning id into v_id;

  return v_id;
end; $function$;

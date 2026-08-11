-- order_notes_list(p_order_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.order_notes_list(p_order_id uuid)
 RETURNS TABLE(id uuid, note_text text, is_follow_up boolean, author_display text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if coalesce(auth.role(),'') is distinct from 'service_role'
     and not (public.is_admin() or coalesce(public.current_app_role(),'') in ('va','loa','agent','lender','staff')) then
    raise exception 'staff only';
  end if;
  return query
  select n.id, n.note_text, n.is_follow_up, n.author_display, n.created_at
  from public.order_notes n
  where n.order_id = p_order_id
  order by n.created_at desc;
end; $function$;

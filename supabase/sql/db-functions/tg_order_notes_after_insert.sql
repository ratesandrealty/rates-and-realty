-- tg_order_notes_after_insert()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.tg_order_notes_after_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_lead uuid;
begin
  -- resolve the lead contact_id from the order if not supplied on the note
  v_lead := new.contact_id;
  if v_lead is null then
    select contact_id into v_lead from public.loan_orders where id = new.order_id;
  end if;

  -- bump the order's last_note_at, and last_follow_up_at when this note is a follow-up touch
  update public.loan_orders
    set last_note_at = new.created_at,
        last_follow_up_at = case when new.is_follow_up then new.created_at else last_follow_up_at end,
        updated_at = now()
  where id = new.order_id;

  -- fire the @-mention pipeline (staff/self/partner), with the LEAD as contact context
  begin
    perform public.app_notify_mentions(
      'order_note', new.id, new.note_text,
      new.author_user_id, coalesce(new.author_display,'Rene'), v_lead);
  exception when others then null; end;

  return new;
end; $function$;

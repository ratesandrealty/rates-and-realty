-- lead_email_threads(p_contact_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.lead_email_threads(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v jsonb;
begin
  v_role := coalesce(public.current_app_role(),'');
  if not (public.is_admin() or v_role in ('va','loa','agent','staff')) then
    raise exception 'not authorized';
  end if;
  select coalesce(jsonb_agg(t order by t.last_at desc), '[]'::jsonb) into v from (
    select el.gmail_thread_id as thread_id,
           max(el.created_at) as last_at,
           count(*) as message_count,
           (array_agg(el.subject order by el.created_at desc))[1] as subject,
           (array_agg(coalesce(el.from_name, el.from_email) order by el.created_at desc))[1] as last_from,
           (array_agg(el.direction order by el.created_at desc))[1] as last_direction,
           (array_agg(el.mailbox order by el.created_at desc))[1] as mailbox
    from public.email_log el
    where el.contact_id = p_contact_id and el.gmail_thread_id is not null
    group by el.gmail_thread_id
  ) t;
  return v;
end; $function$;

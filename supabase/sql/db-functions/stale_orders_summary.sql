-- stale_orders_summary()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.stale_orders_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v jsonb;
begin
  v_role := coalesce(public.current_app_role(),'');
  if not (public.is_admin() or v_role in ('va','loa','agent','staff')) then
    raise exception 'not authorized'; end if;
  select jsonb_build_object(
    'not_ordered_count', (select count(*) from loan_orders where coalesce(status,'not_ordered') in ('not_ordered','pending')),
    'items', (select coalesce(jsonb_agg(x order by x.age_days desc nulls last),'[]'::jsonb) from (
       select lo.id, lo.order_type, lo.contact_id,
              nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'') as borrower,
              coalesce(lo.status,'not_ordered') as status,
              extract(day from now() - coalesce(lo.updated_at, now()))::int as age_days
       from loan_orders lo left join contacts c on c.id = lo.contact_id
       where coalesce(lo.status,'not_ordered') in ('not_ordered','pending')
       limit 10) x)
  ) into v;
  return v;
end; $function$;

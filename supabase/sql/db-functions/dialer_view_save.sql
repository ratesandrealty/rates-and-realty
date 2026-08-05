-- dialer_view_save(p_name text, p_filter text, p_stage text, p_partner_id uuid, p_sort text, p_source text, p_tag_ids uuid[], p_callable_only boolean, p_min_loan numeric)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.dialer_view_save(p_name text, p_filter text, p_stage text DEFAULT NULL::text, p_partner_id uuid DEFAULT NULL::uuid, p_sort text DEFAULT 'priority'::text, p_source text DEFAULT NULL::text, p_tag_ids uuid[] DEFAULT NULL::uuid[], p_callable_only boolean DEFAULT false, p_min_loan numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'must be signed in'; end if;
  if coalesce(trim(p_name),'')='' then raise exception 'view name required'; end if;
  insert into dialer_saved_views(owner_user_id, name, filter, stage, partner_id, sort, source, tag_ids, callable_only, min_loan)
  values (auth.uid(), trim(p_name), p_filter, p_stage, p_partner_id, p_sort, p_source, p_tag_ids, coalesce(p_callable_only,false), p_min_loan)
  on conflict (owner_user_id, name) do update set
    filter=excluded.filter, stage=excluded.stage, partner_id=excluded.partner_id, sort=excluded.sort,
    source=excluded.source, tag_ids=excluded.tag_ids, callable_only=excluded.callable_only, min_loan=excluded.min_loan
  returning id into v_id;
  return v_id;
end;
$function$;

-- contact_merge_preview(p_survivor uuid, p_loser uuid)
-- language: plpgsql
-- Captured from production 2026-08-08.

CREATE OR REPLACE FUNCTION public.contact_merge_preview(p_survivor uuid, p_loser uuid)
 RETURNS TABLE(table_name text, fk_column text, rows_on_loser bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; n bigint;
begin
  for r in select * from contact_fk_catalogue loop
    execute format('select count(*) from public.%I where %I = $1', r.table_name, r.fk_column)
      into n using p_loser;
    if n > 0 then
      table_name := r.table_name; fk_column := r.fk_column; rows_on_loser := n; return next;
    end if;
  end loop;
  for r in select 'contacts'::text t, c c from (values ('referred_by_contact_id'),('primary_borrower_contact_id')) c(c) loop
    execute format('select count(*) from public.contacts where %I = $1', r.c) into n using p_loser;
    if n > 0 then table_name := 'contacts'; fk_column := r.c; rows_on_loser := n; return next; end if;
  end loop;
end $function$;

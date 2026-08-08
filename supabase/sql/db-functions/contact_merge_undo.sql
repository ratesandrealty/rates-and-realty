-- contact_merge_undo(p_merge_id uuid)
-- language: plpgsql
-- Captured from production 2026-08-08.

CREATE OR REPLACE FUNCTION public.contact_merge_undo(p_merge_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m contact_merges%rowtype; r record; v_back int := 0; v_setlist text;
begin
  perform set_config('app.suppress_foldering', 'on', true);   -- an undo must not fire it either
  select * into m from contact_merges where id = p_merge_id;
  if not found then raise exception 'merge % not found', p_merge_id; end if;
  if m.status = 'reversed' then raise exception 'merge % is already reversed', p_merge_id; end if;

  for r in select * from contact_merge_moves where merge_id = p_merge_id and moved order by id desc loop
    execute format('update public.%I set %I = $1 where %I::text = $2', r.table_name, r.fk_column, r.pk_column)
      using m.loser_id, r.pk_value;
    v_back := v_back + 1;
  end loop;

  select string_agg(format('%1$I = s.%1$I', column_name), ', ') into v_setlist
    from information_schema.columns
   where table_schema='public' and table_name='contacts' and column_name <> 'id';
  execute format('update contacts t set %s from jsonb_populate_record(null::contacts, $1) s where t.id = $2', v_setlist)
    using m.survivor_snapshot, m.survivor_id;
  execute format('update contacts t set %s from jsonb_populate_record(null::contacts, $1) s where t.id = $2', v_setlist)
    using m.loser_snapshot, m.loser_id;

  update contact_merges set status='reversed', reversed_at=now() where id = p_merge_id;
  insert into audit_log (table_name, row_id, operation, new_data)
  values ('contacts', m.loser_id::text, 'MERGE_REVERSED',
          jsonb_build_object('merge_id', p_merge_id, 'rows_restored', v_back));
  return jsonb_build_object('merge_id', p_merge_id, 'rows_restored', v_back);
end $function$;

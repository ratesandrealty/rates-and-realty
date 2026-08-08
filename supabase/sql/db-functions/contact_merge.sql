-- contact_merge(p_survivor uuid, p_loser uuid, p_actor uuid)
-- language: plpgsql
-- Captured from production 2026-08-08.

CREATE OR REPLACE FUNCTION public.contact_merge(p_survivor uuid, p_loser uuid, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record; v_merge_id uuid;
  v_surv contacts%rowtype; v_lose contacts%rowtype;
  v_moved int := 0; v_skipped int := 0;
  v_pk text; v_status_before text; v_status_after text; v_setlist text;
  STAGE_ORDER constant text[] :=
    array['Lost','New Lead','Contacted','Follow Up','Pre-Approved','Under Contract','Processing','Clear to Close','Closed'];
begin
  perform set_config('app.suppress_foldering', 'on', true);   -- transaction-local

  if p_survivor = p_loser then raise exception 'survivor and loser are the same contact'; end if;
  select * into v_surv from contacts where id = p_survivor;
  if not found then raise exception 'survivor % not found', p_survivor; end if;
  select * into v_lose from contacts where id = p_loser;
  if not found then raise exception 'loser % not found', p_loser; end if;
  if v_lose.merged_into_contact_id is not null then raise exception 'loser % is already merged', p_loser; end if;
  if v_surv.merged_into_contact_id is not null then raise exception 'survivor % is itself merged away', p_survivor; end if;

  insert into contact_merges (survivor_id, loser_id, performed_by, survivor_snapshot, loser_snapshot)
  values (p_survivor, p_loser, p_actor, to_jsonb(v_surv), to_jsonb(v_lose)) returning id into v_merge_id;

  for r in select * from contact_fk_catalogue loop
    for v_pk in execute format('select %I::text from public.%I where %I = $1', r.pk_column, r.table_name, r.fk_column) using p_loser
    loop
      begin
        execute format('update public.%I set %I = $1 where %I::text = $2', r.table_name, r.fk_column, r.pk_column)
          using p_survivor, v_pk;
        insert into contact_merge_moves (merge_id, table_name, fk_column, pk_column, pk_value)
        values (v_merge_id, r.table_name, r.fk_column, r.pk_column, v_pk);
        v_moved := v_moved + 1;
      exception when others then
        insert into contact_merge_moves (merge_id, table_name, fk_column, pk_column, pk_value, moved, skip_reason)
        values (v_merge_id, r.table_name, r.fk_column, r.pk_column, v_pk, false, sqlerrm);
        v_skipped := v_skipped + 1;
      end;
    end loop;
  end loop;

  for r in select unnest(array['referred_by_contact_id','primary_borrower_contact_id']) as col loop
    for v_pk in execute format('select id::text from contacts where %I = $1 and id <> $2', r.col) using p_loser, p_loser
    loop
      execute format('update contacts set %I = $1 where id::text = $2', r.col) using p_survivor, v_pk;
      insert into contact_merge_moves (merge_id, table_name, fk_column, pk_column, pk_value)
      values (v_merge_id, 'contacts', r.col, 'id', v_pk);
      v_moved := v_moved + 1;
    end loop;
  end loop;

  select string_agg(format('%1$I = coalesce(t.%1$I, s.%1$I)', column_name), ', ') into v_setlist
    from information_schema.columns
   where table_schema='public' and table_name='contacts'
     and column_name not in ('id','created_at','updated_at','merged_into_contact_id','merged_at',
                             'pipeline_status','email','secondary_email',
                             'gdrive_folder_id','gdrive_folder_url','gdrive_folder_name',
                             'google_drive_folder_id','google_drive_folder_url','drive_folder_created_at');
  execute format('update contacts t set %s from (select * from contacts where id = $2) s where t.id = $1', v_setlist)
    using p_survivor, p_loser;

  v_status_before := v_surv.pipeline_status;
  v_status_after := case
    when coalesce(array_position(STAGE_ORDER, v_lose.pipeline_status), -1)
       > coalesce(array_position(STAGE_ORDER, v_surv.pipeline_status), -1)
    then v_lose.pipeline_status else v_surv.pipeline_status end;

  update contacts set
    pipeline_status = v_status_after,
    secondary_email = case
      when v_lose.email is not null and lower(coalesce(v_lose.email,'')) <> lower(coalesce(v_surv.email,''))
        then coalesce(v_surv.secondary_email, v_lose.email) else secondary_email end,
    updated_at = now()
  where id = p_survivor;

  if v_status_after is distinct from v_status_before then
    insert into pipeline_stage_history (contact_id, from_stage, to_stage, changed_at)
    values (p_survivor, v_status_before, v_status_after, now());
  end if;

  update contacts set merged_into_contact_id = p_survivor, merged_at = now(), updated_at = now()
   where id = p_loser;

  insert into audit_log (table_name, row_id, operation, old_data, new_data, changed_by)
  values ('contacts', p_loser::text, 'MERGE', to_jsonb(v_lose),
          jsonb_build_object('merged_into', p_survivor, 'merge_id', v_merge_id,
                             'rows_moved', v_moved, 'rows_skipped', v_skipped), p_actor);

  update contact_merges set report = jsonb_build_object(
    'rows_moved', v_moved, 'rows_skipped', v_skipped,
    'status_before', v_status_before, 'status_after', v_status_after,
    'loser_gdrive_folder_id', v_lose.gdrive_folder_id,
    'survivor_gdrive_folder_id', v_surv.gdrive_folder_id,
    'loser_email_kept_as_secondary', v_lose.email,
    'foldering_suppressed', true
  ) where id = v_merge_id;

  return jsonb_build_object('merge_id', v_merge_id, 'rows_moved', v_moved, 'rows_skipped', v_skipped,
                            'status_after', v_status_after);
end $function$;

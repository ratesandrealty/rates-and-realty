-- fn_audit_row()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-21. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.fn_audit_row()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_old jsonb; v_new jsonb;
  v_old_diff jsonb; v_new_diff jsonb;
  v_changed int := 0;
  v_row_id text;
  v_skip boolean := false;
begin
  /* WHAT THIS STORES, AND WHY IT CHANGED (2026-08-21)
   *
   * It used to store to_jsonb(OLD) and to_jsonb(NEW) in FULL on every UPDATE.
   * Measured over the 1,293 mortgage_applications updates then on file: an
   * average of 2.2 keys actually changed, while each row cost ~7.9 KB. The same
   * history holding only the changed keys is 1,129 kB against 9,987 kB -- 11.3%.
   * 14 of those rows recorded an update where NOTHING changed at all.
   *
   * So an UPDATE now stores only the keys that differ, with old_data holding the
   * prior value of exactly those keys, and a no-op UPDATE writes no row.
   * INSERT and DELETE still store the whole row: there is no prior state to diff
   * an insert against, and a deleted row's full contents are the entire point of
   * auditing the delete.
   *
   * TRADE-OFF, stated because it is real: a diff row no longer carries the rest
   * of the record. `row_id` identifies the row (id, falling back to contact_id),
   * so a diff is still traceable, but a column that did not change is not in the
   * row and must be read from the table -- or from the INSERT/DELETE capture.
   * Rows written before this change keep their full-snapshot shape and were
   * deliberately NOT rewritten: a mixed-shape log is honest, and rewriting one
   * would destroy the original capture to save 9 MB.
   *
   * IT MUST NEVER THROW. This is an AFTER trigger inside the caller's
   * transaction, so an exception here aborts the write it was auditing -- the
   * audit would become the outage. Both halves are wrapped and downgraded to a
   * warning. The cost is that a failure to audit is quiet; the alternative is a
   * failure to audit that also loses the borrower's data.
   */
  begin
    v_old := case when tg_op in ('UPDATE','DELETE') then to_jsonb(OLD) else null end;
    v_new := case when tg_op in ('UPDATE','INSERT') then to_jsonb(NEW) else null end;

    v_row_id := coalesce(
      case when tg_op = 'DELETE' then v_old->>'id'         else v_new->>'id'         end,
      case when tg_op = 'DELETE' then v_old->>'contact_id' else v_new->>'contact_id' end
    );

    if tg_op = 'UPDATE' then
      /* Union of both key sets, not just NEW's: identical for an ordinary update,
       * but a column added or dropped between the two would otherwise vanish from
       * the diff silently. Compared with -> (jsonb), not ->> (text), so a JSON
       * null and the string "null" are not treated as the same value. */
      select count(*),
             coalesce(jsonb_object_agg(u.k, coalesce(v_old -> u.k, 'null'::jsonb)), '{}'::jsonb),
             coalesce(jsonb_object_agg(u.k, coalesce(v_new -> u.k, 'null'::jsonb)), '{}'::jsonb)
        into v_changed, v_old_diff, v_new_diff
      from (
        select k from jsonb_object_keys(v_old) k
        union
        select k from jsonb_object_keys(v_new) k
      ) u
      where (v_old -> u.k) is distinct from (v_new -> u.k);

      if v_changed = 0 then
        v_skip := true;                 -- nothing changed: record nothing
      else
        v_old := v_old_diff;
        v_new := v_new_diff;
      end if;
    end if;

    if not v_skip then
      insert into public.audit_log(table_name, row_id, operation, old_data, new_data, changed_by)
      values (tg_table_name, v_row_id, tg_op, v_old, v_new, auth.uid());
    end if;
  exception when others then
    raise warning 'fn_audit_row: could not record % on %: %', tg_op, tg_table_name, sqlerrm;
  end;

  /* RETENTION, INSIDE THE WRITER -- the monitor_runs argument. A separate cron
   * job can be disabled, paused, or fail silently, and a retention job that
   * stops leaves a table growing with nobody watching. Keeping it here means the
   * cleanup cannot outlive the thing that maintains it.
   *
   *   mortgage_applications  7 years   -- the borrower record. Mortgage files
   *                                       carry record-keeping obligations
   *                                       measured in years; over-keeping beats
   *                                       finding a gap during an audit.
   *   everything else        90 days   -- operational noise.
   *
   * Bounded to 500 rows so a large backlog cannot stall the write that triggered
   * it; the next audited write continues. Its own exception block: a trim that
   * fails must not cost the audit row that was just written, let alone the
   * business write. */
  begin
    delete from public.audit_log
     where ctid in (
       select ctid from public.audit_log
        where (table_name =  'mortgage_applications' and changed_at < now() - interval '7 years')
           or (table_name <> 'mortgage_applications' and changed_at < now() - interval '90 days')
        limit 500
     );
  exception when others then
    raise warning 'fn_audit_row: retention trim failed: %', sqlerrm;
  end;

  return case when tg_op = 'DELETE' then OLD else NEW end;
end;
$function$;


-- Supports the retention trim above: leading table_name, then changed_at.
create index if not exists audit_log_retention_idx
  on public.audit_log (table_name, changed_at);

-- INSERT was absent, which is why the 39 app_submitted events could not be
-- replayed: creation is the event that fires ClickUp and it left no record.
drop trigger if exists trg_audit_mortgage_applications on public.mortgage_applications;
create trigger trg_audit_mortgage_applications
  after insert or update or delete on public.mortgage_applications
  for each row execute function public.fn_audit_row();

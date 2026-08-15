-- clickup_enqueue(p_task_id uuid)
-- language: plpgsql
-- Captured from production 2026-08-15.

CREATE OR REPLACE FUNCTION public.clickup_enqueue(p_task_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_t public.tasks;
begin
  select * into v_t from public.tasks where id = p_task_id;
  if v_t.id is null then return false; end if;

  if v_t.clickup_task_id is not null then return false; end if;   -- already in ClickUp
  if v_t.related_table is null then return false; end if;         -- not a SQL-created task
  if coalesce(v_t.status,'open') in ('completed','cancelled') then return false; end if;

  insert into public.clickup_outbox (task_id) values (p_task_id)
  on conflict (task_id) do nothing;                               -- idempotent by construction
  return found;
end;
$function$;

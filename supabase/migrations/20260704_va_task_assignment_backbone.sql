alter table public.tasks
  add column if not exists assigned_to uuid,
  add column if not exists assigned_by uuid;

comment on column public.tasks.assigned_to is 'Staff/VA auth user id this task is assigned to; null = unassigned';
comment on column public.tasks.assigned_by is 'Staff/VA auth user id who created the assignment';

create index if not exists tasks_assigned_to_status_due_idx
  on public.tasks (assigned_to, status, due_date);

create policy tasks_select_assignee on public.tasks
  for select to authenticated
  using (assigned_to = auth.uid());

create policy tasks_update_assignee on public.tasks
  for update to authenticated
  using (assigned_to = auth.uid())
  with check (assigned_to = auth.uid());

create or replace function public.tasks_set_assigned_by()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_by is null and auth.uid() is not null then
    new.assigned_by := auth.uid();
  end if;
  return new;
end $$;

drop trigger if exists trg_tasks_set_assigned_by on public.tasks;
create trigger trg_tasks_set_assigned_by
  before insert on public.tasks
  for each row execute function public.tasks_set_assigned_by();

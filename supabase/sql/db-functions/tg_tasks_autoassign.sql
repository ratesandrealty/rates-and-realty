-- tg_tasks_autoassign()
-- language: plpgsql   SECURITY DEFINER
-- Captured 2026-08-05.

CREATE OR REPLACE FUNCTION public.tg_tasks_autoassign()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Third-party order follow-ups belong to the VA account without Rene assigning
 * each one. loan_order_set creates them with related_table='loan_orders' and no
 * assignee, so before this they landed unassigned — invisible to everyone but an
 * admin browsing all tasks.
 *
 * A trigger rather than editing loan_order_set: that function is ~100 lines with
 * two task branches (insert and update), and any future order path gets this for
 * free. Only fills a NULL — an explicit assignee always wins.
 *
 * va_account_uid() returns null unless there is exactly one va, so a second VA
 * or a recreated account leaves the task unassigned rather than guessing. */
begin
  if new.assigned_to is null and new.related_table = 'loan_orders' then
    new.assigned_to := public.va_account_uid();
  end if;
  return new;
end; $function$;

-- task_upsert(p_id uuid, p_title text, p_description text, p_priority text, p_due_date timestamp without time zone, p_contact_id uuid, p_assigned_to uuid, p_status text, p_referral_partner_id uuid, p_loan_order_id uuid)
-- language: plpgsql
-- Captured from production 2026-08-19.

CREATE OR REPLACE FUNCTION public.task_upsert(p_id uuid DEFAULT NULL::uuid, p_title text DEFAULT NULL::text, p_description text DEFAULT NULL::text, p_priority text DEFAULT 'normal'::text, p_due_date timestamp without time zone DEFAULT NULL::timestamp without time zone, p_contact_id uuid DEFAULT NULL::uuid, p_assigned_to uuid DEFAULT NULL::uuid, p_status text DEFAULT NULL::text, p_referral_partner_id uuid DEFAULT NULL::uuid, p_loan_order_id uuid DEFAULT NULL::uuid)
 RETURNS tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_row public.tasks; v_existing public.tasks;
  v_is_admin boolean := is_admin() or coalesce(auth.role(),'') = 'service_role';
  v_role text := coalesce(current_app_role(),'');
  v_uid uuid := auth.uid();
  v_status text := nullif(trim(coalesce(p_status,'')),'');
begin
  if not (v_is_admin or v_role in ('va','agent','loa','staff')) then
    raise exception 'staff only';
  end if;
  if v_status is not null and v_status not in ('open','pending','question','completed','cancelled') then
    raise exception 'status must be one of open, pending, question, completed, cancelled';
  end if;

  /* A tag must point at something that exists. The FKs enforce this anyway; the
     check is here so the caller gets a sentence rather than a constraint name. */
  if p_referral_partner_id is not null
     and not exists (select 1 from public.referral_partners rp where rp.id = p_referral_partner_id) then
    raise exception 'no such referral partner';
  end if;
  if p_loan_order_id is not null
     and not exists (select 1 from public.loan_orders lo where lo.id = p_loan_order_id) then
    raise exception 'no such order';
  end if;

  if p_id is null then
    if nullif(trim(coalesce(p_title,'')),'') is null then
      raise exception 'title required';
    end if;
    /* related_table / related_id are STILL not set here, and that has not
       changed: setting them filed every hand-typed task as automation output.
       The tags are subject; origin remains provenance, and tg_tasks_set_origin
       stamps it 'user' for anything a signed-in human creates — so a tagged task
       is still never enqueued to ClickUp. */
    insert into tasks(title, description, priority, due_date, contact_id, lead_id,
                      assigned_to, assigned_by, status,
                      referral_partner_id, loan_order_id, created_at, updated_at)
    values (trim(p_title), p_description, coalesce(nullif(trim(coalesce(p_priority,'')),''),'normal'),
            p_due_date, p_contact_id, p_contact_id,
            p_assigned_to, case when p_assigned_to is not null then v_uid end,
            coalesce(v_status,'open'),
            p_referral_partner_id, p_loan_order_id, now(), now())
    returning * into v_row;
  else
    select * into v_existing from tasks where id = p_id;
    if v_existing.id is null then raise exception 'task not found'; end if;
    if not (v_is_admin
            or v_existing.assigned_to = v_uid
            or (v_existing.contact_id is not null and is_lead_shared_with_me(v_existing.contact_id))) then
      raise exception 'not authorized for this task';
    end if;
    update tasks set
      title        = coalesce(nullif(trim(coalesce(p_title,'')),''), tasks.title),
      description  = coalesce(p_description, tasks.description),
      priority     = coalesce(nullif(trim(coalesce(p_priority,'')),''), tasks.priority),
      due_date     = p_due_date,
      assigned_to  = p_assigned_to,
      assigned_by  = case when p_assigned_to is not null and p_assigned_to is distinct from tasks.assigned_to
                          then v_uid else tasks.assigned_by end,
      contact_id   = coalesce(p_contact_id, tasks.contact_id),
      status       = coalesce(v_status, tasks.status),
      /* Preserved unless supplied — see the note at the top of this function. */
      referral_partner_id = coalesce(p_referral_partner_id, tasks.referral_partner_id),
      loan_order_id       = coalesce(p_loan_order_id, tasks.loan_order_id),
      updated_at   = now()
    where tasks.id = p_id
    returning * into v_row;
  end if;

  perform _task_clickup_sync(v_row.id);
  return v_row;
end; $function$;

-- task_list(p_scope text, p_filters jsonb)
-- language: plpgsql
-- Captured from production 2026-08-19.

CREATE OR REPLACE FUNCTION public.task_list(p_scope text DEFAULT 'all'::text, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(id uuid, title text, description text, status text, priority text, due_date timestamp without time zone, contact_id uuid, lead_id uuid, contact_name text, contact_phone text, assigned_to uuid, assignee_email text, assigned_by uuid, clickup_url text, related_table text, related_id uuid, bucket text, assignee_state text, provenance text, question_pending boolean, created_at timestamp without time zone, referral_partner_id uuid, referral_partner_label text, loan_order_id uuid, loan_order_label text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role     text := coalesce(current_app_role(), '');
  v_is_admin boolean := is_admin() or coalesce(auth.role(),'') = 'service_role';
  v_scope    text := lower(coalesce(nullif(trim(p_scope),''), 'all'));
  v_group    text := lower(coalesce(nullif(trim(p_filters->>'status_group'),''), 'live'));
  v_due      text := lower(coalesce(nullif(trim(p_filters->>'due'),''), 'any'));
  v_contact  uuid := nullif(p_filters->>'contact_id','')::uuid;
  v_limit    int  := least(greatest(coalesce((p_filters->>'limit')::int, 500), 1), 2000);
  v_uid      uuid := auth.uid();
begin
  if not (v_is_admin or v_role in ('va','agent','loa','staff')) then
    raise exception 'staff only';
  end if;
  if v_scope not in ('all','mine','other','unassigned','lead') then
    raise exception 'unknown scope: %', p_scope;
  end if;
  if v_group not in ('live','completed','all') then
    raise exception 'unknown status_group: %', v_group;
  end if;
  if v_scope = 'lead' and v_contact is null then
    raise exception 'scope=lead needs filters.contact_id';
  end if;

  return query
  select t.id, t.title, t.description, t.status, t.priority, t.due_date,
         t.contact_id, t.lead_id,
         nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),'') as contact_name,
         case when v_role = 'va' and not v_is_admin then mask_phone(c.phone) else c.phone end as contact_phone,
         t.assigned_to,
         (select u.email::text from auth.users u where u.id = t.assigned_to) as assignee_email,
         t.assigned_by, t.clickup_url, t.related_table, t.related_id,
         case when t.due_date is null then 'no_date'
              when t.due_date::date < (now() at time zone 'UTC')::date then 'overdue'
              when t.due_date::date = (now() at time zone 'UTC')::date then 'today'
              else 'upcoming' end as bucket,
         case when t.assigned_to is null then 'unassigned'
              when t.assigned_to = v_uid then 'mine'
              else 'other' end as assignee_state,
         /* ONE provenance mechanism, not two. tasks.origin holds the answer
            directly, so related_table and a clickup_automation_log lookup can no
            longer drift apart. */
         case when t.origin = 'user' then 'human' else 'auto' end as provenance,
         (coalesce(t.status,'open') = 'question') as question_pending,
         t.created_at,
         /* THE TAGS — subject, never provenance. A human tagging a task to an
            order still has origin='user' and is still never enqueued to ClickUp.
            Labels are resolved HERE rather than in the browser: the alternative
            is every consumer joining these two tables itself to render a chip,
            which is three places to disagree about what an order is called.
            Left joins, so a tag whose target was deleted (the FK sets it null)
            renders nothing instead of erroring. */
         t.referral_partner_id,
         nullif(trim(
           coalesce(nullif(trim(coalesce(rp.company,'')),''), '')
           || case
                when nullif(trim(coalesce(rp.first_name,'')||' '||coalesce(rp.last_name,'')),'') is null then ''
                when nullif(trim(coalesce(rp.company,'')),'') is null
                  then trim(coalesce(rp.first_name,'')||' '||coalesce(rp.last_name,''))
                else ' — ' || trim(coalesce(rp.first_name,'')||' '||coalesce(rp.last_name,''))
              end
         ), '')::text as referral_partner_label,
         t.loan_order_id,
         nullif(trim(
           coalesce(upper(lo.order_type),'')
           || coalesce(' · ' || nullif(trim(coalesce(lo.label, lo.employer_name,'')),''), '')
         ), '')::text as loan_order_label
  from tasks t
  left join contacts c on c.id = t.contact_id
  left join referral_partners rp on rp.id = t.referral_partner_id
  left join loan_orders lo on lo.id = t.loan_order_id
  where
    (v_is_admin
     or t.assigned_to = v_uid
     or exists (select 1 from lead_shares s
                 where s.contact_id = t.contact_id and s.shared_with_user_id = v_uid))
    and (v_group = 'all'
         or (v_group = 'live'      and coalesce(t.status,'open') not in ('completed','cancelled'))
         or (v_group = 'completed' and t.status = 'completed'))
    and (v_scope = 'all'
         or (v_scope = 'mine'       and t.assigned_to = v_uid)
         or (v_scope = 'other'      and t.assigned_to is not null and t.assigned_to <> v_uid)
         or (v_scope = 'unassigned' and t.assigned_to is null)
         or (v_scope = 'lead'       and t.contact_id = v_contact))
    and (v_contact is null or v_scope = 'lead' or t.contact_id = v_contact)
    and (v_due = 'any'
         or (v_due = 'none'     and t.due_date is null)
         or (v_due = 'overdue'  and t.due_date is not null and t.due_date::date <  (now() at time zone 'UTC')::date)
         or (v_due = 'today'    and t.due_date is not null and t.due_date::date =  (now() at time zone 'UTC')::date)
         or (v_due = 'upcoming' and t.due_date is not null and t.due_date::date >  (now() at time zone 'UTC')::date))
  order by (coalesce(t.status,'open') = 'question') desc,
           t.due_date asc nulls last, t.created_at desc
  limit v_limit;
end; $function$;

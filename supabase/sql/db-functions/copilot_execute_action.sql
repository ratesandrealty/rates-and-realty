-- copilot_execute_action(p_type text, p_payload jsonb)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.copilot_execute_action(p_type text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare v_cid uuid; v_res jsonb; v_role text;
begin
  select role into v_role from public.auth_user_roles where user_id = auth.uid() limit 1;
  if not (coalesce(is_admin(),false) or coalesce(v_role,'') in ('admin','agent','loa')) then
    raise exception 'not authorized';
  end if;

  v_cid := nullif(p_payload->>'contact_id','')::uuid;

  if p_type = 'note' then
    if v_cid is null then raise exception 'contact_id required'; end if;
    perform public.add_contact_note(v_cid, coalesce(p_payload->>'text',''));
    v_res := jsonb_build_object('ok',true,'type','note');

  elsif p_type = 'task' then
    if v_cid is null then raise exception 'contact_id required'; end if;
    perform public.va_task_add(
      coalesce(p_payload->>'title','Task'),
      coalesce(p_payload->>'priority','normal'),
      nullif(p_payload->>'due_date','')::timestamp,
      v_cid,
      nullif(p_payload->>'description',''),
      auth.uid()
    );
    v_res := jsonb_build_object('ok',true,'type','task');

  elsif p_type = 'status' then
    if v_cid is null then raise exception 'contact_id required'; end if;
    update public.contacts set
      pipeline_status = coalesce(nullif(p_payload->>'pipeline_status',''), pipeline_status),
      lead_status     = coalesce(nullif(p_payload->>'lead_status',''), lead_status),
      next_follow_up  = coalesce(nullif(p_payload->>'next_follow_up','')::date, next_follow_up),
      updated_at      = now()
    where id = v_cid;
    v_res := jsonb_build_object('ok',true,'type','status');

  elsif p_type = 'appointment' then
    declare v_apt uuid; v_start timestamptz; v_name text; v_email text;
    begin
      v_start := nullif(p_payload->>'start','')::timestamptz;
      if v_start is null then raise exception 'start datetime required'; end if;
      if v_cid is not null then
        select nullif(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')),''), email
          into v_name, v_email from public.contacts where id = v_cid;
      end if;
      insert into public.appointments(contact_id, title, appointment_time, scheduled_at,
          duration_minutes, notes, status, attendee_name, attendee_email, type)
      values (v_cid, coalesce(p_payload->>'title','Appointment'), v_start, v_start,
          coalesce(nullif(p_payload->>'duration_minutes','')::int, 30),
          nullif(p_payload->>'notes',''), 'scheduled', v_name, v_email,
          coalesce(nullif(p_payload->>'type',''),'appointment'))
      returning id into v_apt;
      v_res := jsonb_build_object('ok',true,'type','appointment','appointment_id',v_apt);
    end;

  else
    raise exception 'unknown action type %', p_type;
  end if;

  insert into public.copilot_action_log(action_type, payload, result) values (p_type, p_payload, v_res);
  return v_res;
end; $function$;

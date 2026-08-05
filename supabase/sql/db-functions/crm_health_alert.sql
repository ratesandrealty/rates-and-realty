-- crm_health_alert()
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.crm_health_alert()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  rec record;
  v_fails jsonb := '[]'::jsonb;
  v_warns jsonb := '[]'::jsonb;
  v_fail_count int := 0;
  v_warn_count int := 0;
  v_ok_count int := 0;
  v_fail_names text[] := '{}';
  v_warn_names text[] := '{}';
  v_fail_md text := '';
  v_fingerprint text;
  v_source text;
  v_ctx jsonb;
  v_run_id uuid;
  v_prev_fail int;
begin
  select fail_count into v_prev_fail from public.crm_health_runs order by run_at desc limit 1;

  for rec in select * from public.crm_health_check() loop
    if rec.severity = 'fail' then
      v_fail_count := v_fail_count + 1;
      v_fails := v_fails || jsonb_build_object('area',rec.area,'check',rec.check_name,'detail',rec.detail);
      v_fail_names := array_append(v_fail_names, rec.area||'/'||rec.check_name);
      v_fail_md := v_fail_md
        || '- **['||rec.area||'] '||rec.check_name||'**'||E'\n'
        || '    • What: '||coalesce(rec.detail,'')||E'\n'
        || '    • 🔧 Fix: '||public.crm_remediation(rec.area, rec.check_name)||E'\n';
    elsif rec.severity = 'warn' then
      v_warn_count := v_warn_count + 1;
      v_warns := v_warns || jsonb_build_object('area',rec.area,'check',rec.check_name,'detail',rec.detail);
      v_warn_names := array_append(v_warn_names, rec.check_name);
    else
      v_ok_count := v_ok_count + 1;
    end if;
  end loop;

  v_fingerprint := coalesce((select string_agg(x,'|' order by x) from unnest(v_fail_names) x),'none');

  insert into public.crm_health_runs(fail_count,warn_count,ok_count,fails,warns,fingerprint)
  values (v_fail_count,v_warn_count,v_ok_count,v_fails,v_warns,v_fingerprint)
  returning id into v_run_id;

  if v_fail_count > 0 then
    v_source := left(md5(v_fingerprint),12) || ':W' || to_char(now(),'IYYY-IW');
    v_ctx := jsonb_build_object(
      'fail_count',   v_fail_count::text,
      'scan_date',    to_char(now() at time zone 'America/Los_Angeles','Mon DD, YYYY HH12:MI AM')||' PT',
      'fail_list',    rtrim(v_fail_md, E'\n'),
      'warn_summary', case when v_warn_count=0 then 'none'
                          else v_warn_count::text||' ('||array_to_string(v_warn_names,', ')||')' end,
      'dashboard_url','https://admin.ratesandrealty.com/dashboard/admin.html'
    );
    perform public.fire_clickup_automation('system_health_alert', null, v_source, v_ctx);
    update public.crm_health_runs set alerted=true where id=v_run_id;
  end if;

  return jsonb_build_object('run_id',v_run_id,'fail',v_fail_count,'warn',v_warn_count,'ok',v_ok_count,
                            'alerted',v_fail_count>0,'recovered',(coalesce(v_prev_fail,0)>0 and v_fail_count=0));
end;
$function$;

-- fire_rate_lock_reminders()
-- language: plpgsql
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.fire_rate_lock_reminders()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r record;
  v_ctx jsonb;
begin
  for r in
    select distinct on (ma.contact_id)
      ma.contact_id,
      ma.locked_rate,
      ma.rate_lock_expiry::date as expiry,
      (ma.rate_lock_expiry::date - current_date) as days_left,
      c.first_name, c.last_name, c.closing_lender, c.loan_amount,
      c.property_address, c.pipeline_status
    from mortgage_applications ma
    join contacts c on c.id = ma.contact_id
    where ma.rate_lock_expiry is not null
      and ma.locked_rate is not null
      and ma.rate_lock_expiry::date >= current_date
      and coalesce(c.pipeline_status,'') not in
          ('Closed','Lost','Closed Won','Closed Lost','Funded','Dead','Denied')
    order by ma.contact_id, ma.rate_lock_expiry desc
  loop
    -- 5 days before, and the expiry day itself
    if r.days_left not in (5,0) then
      continue;
    end if;

    v_ctx := jsonb_build_object(
      'lender',      coalesce(nullif(r.closing_lender,''),'—'),
      'locked_rate', to_char(r.locked_rate,'FM990.000')||'%',
      'lock_expiry', to_char(r.expiry,'Mon DD, YYYY'),
      'loan_amount', case when r.loan_amount is not null
                         then '$'||to_char(r.loan_amount,'FM999,999,999')
                         else '—' end,
      'property',    coalesce(nullif(r.property_address,''),'—'),
      'anchor_date', r.expiry::text
    );

    if r.days_left = 5 then
      perform fire_clickup_automation('rate_lock_5d', r.contact_id, r.expiry::text, v_ctx);
    elsif r.days_left = 0 then
      perform fire_clickup_automation('rate_lock_day_of', r.contact_id, r.expiry::text, v_ctx);
    end if;
  end loop;
end;
$function$;

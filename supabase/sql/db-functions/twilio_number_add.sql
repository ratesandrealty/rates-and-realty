-- twilio_number_add(p_number text, p_label text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.twilio_number_add(p_number text, p_label text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_id uuid; v_d text; v_area text;
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not public.is_admin() then raise exception 'admin only'; end if;
  v_d := regexp_replace(coalesce(p_number,''),'\D','','g');
  v_area := case when length(v_d)=11 and left(v_d,1)='1' then substr(v_d,2,3)
                 when length(v_d)=10 then left(v_d,3) else null end;
  insert into twilio_numbers(phone_number, area_code, label)
  values (case when left(coalesce(p_number,''),1)='+' then p_number
               when length(v_d)=10 then '+1'||v_d
               when length(v_d)=11 then '+'||v_d else p_number end,
          v_area, p_label)
  on conflict (phone_number) do update set area_code=excluded.area_code, label=excluded.label, active=true
  returning id into v_id;
  return v_id;
end;
$function$;

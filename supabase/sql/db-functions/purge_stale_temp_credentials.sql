-- purge_stale_temp_credentials()
-- language: plpgsql
-- Captured from production 2026-08-11.

CREATE OR REPLACE FUNCTION public.purge_stale_temp_credentials()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n integer;
begin
  with gone as (
    delete from public.user_temp_credentials t
    using auth.users u
    where u.id = t.user_id
      and (t.set_at < now() - interval '7 days'                 -- never used, expired
           or (u.last_sign_in_at is not null                     -- used
               and t.set_at <= u.last_sign_in_at))
    returning 1)
  select count(*) into n from gone;
  return n;
end $function$;

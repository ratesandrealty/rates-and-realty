-- share_lead(p_contact_id uuid, p_user_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.share_lead(p_contact_id uuid, p_user_id uuid)
 RETURNS lead_shares
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare v_row public.lead_shares;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if p_contact_id is null or p_user_id is null then raise exception 'contact_id and user_id required'; end if;
  if not exists (select 1 from public.auth_user_roles r where r.user_id = p_user_id and r.role in ('va','loa','agent')) then
    raise exception 'target is not a shareable staff user';
  end if;
  select * into v_row from public.lead_shares where contact_id = p_contact_id and shared_with_user_id = p_user_id limit 1;
  if v_row.id is null then
    insert into public.lead_shares(contact_id, shared_with_user_id, shared_by)
    values (p_contact_id, p_user_id, auth.uid()) returning * into v_row;
  end if;
  return v_row;
end; $function$;

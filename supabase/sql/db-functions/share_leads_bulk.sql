-- share_leads_bulk(p_contact_ids uuid[], p_user_id uuid)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.share_leads_bulk(p_contact_ids uuid[], p_user_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare v_count int := 0; v_cid uuid;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if not exists (select 1 from public.auth_user_roles r where r.user_id = p_user_id and r.role in ('va','loa','agent')) then
    raise exception 'target is not a shareable staff user';
  end if;
  foreach v_cid in array coalesce(p_contact_ids, '{}') loop
    if not exists (select 1 from public.lead_shares where contact_id = v_cid and shared_with_user_id = p_user_id) then
      insert into public.lead_shares(contact_id, shared_with_user_id, shared_by)
      values (v_cid, p_user_id, auth.uid());
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end; $function$;

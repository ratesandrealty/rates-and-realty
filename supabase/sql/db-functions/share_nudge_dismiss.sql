-- share_nudge_dismiss(p_contact_id uuid)
-- language: plpgsql
-- Captured from production 2026-08-06.

CREATE OR REPLACE FUNCTION public.share_nudge_dismiss(p_contact_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Permanent per lead. Deliberately NOT cleared when the lead is later shared:
 * once shared the trigger cannot fire (it requires no lead_shares row), so the
 * flag is moot. If the lead is later unshared, that is a deliberate choice and
 * re-nudging would second-guess the decision this row records. */
begin
  if not exists (select 1 from auth_user_roles r where r.user_id = auth.uid() and r.role = 'admin') then
    raise exception 'admin only';
  end if;
  update lead_share_nudges set dismissed_at = now()
   where contact_id = p_contact_id and dismissed_at is null;
  return found;
end; $function$;

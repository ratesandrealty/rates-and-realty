-- tg_unshared_lead_nudge()
-- language: plpgsql
-- Captured from production 2026-08-06.

CREATE OR REPLACE FUNCTION public.tg_unshared_lead_nudge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Nudge Rene to share a lead once real work has started on it.
 *
 * ACTIVE SET IS DELIBERATELY NARROWER THAN order_reminders_run's.
 *   here:                 ordered | acknowledged | scheduled | needs_revision
 *   order_reminders_run:  everything except received/not_required/cancelled/
 *                         complete/completed  -- which INCLUDES not_ordered
 * That is a decision, not an oversight. A reminder chases an order that ought to
 * be placed; this nudge fires only once an order has actually STARTED, because
 * 'not_ordered' is a placeholder and nudging on it would fire for leads where
 * nothing is happening yet. needs_revision IS included: an order that came back
 * for correction is still outstanding work.
 *
 * ONCE PER LEAD, not per order. Rafael Hernandez Andrade already has two active
 * orders (VOE + title); keyed on the order this would have fired twice for one
 * decision. The lead_share_nudges primary key on contact_id is what enforces it.
 *
 * QUIET HOURS are NOT checked here, on purpose. app_notify_system only inserts a
 * row -- the bell is silent and passive, so writing it at 02:00 wakes nobody.
 * Suppressing it here would instead LOSE the nudge permanently, because the
 * lead_share_nudges row is what stops it firing again. Quiet hours is applied to
 * the POPUP, which is the intrusive surface, in admin/js/share-nudge.js. */
declare
  v_shared   boolean;
  v_nudged   boolean;
  v_name     text;
  v_label    text;
  v_body     text;
  v_active   constant text[] := array['ordered','acknowledged','scheduled','needs_revision'];
begin
  -- only a transition INTO an active state
  if new.contact_id is null then return new; end if;
  if not (new.status = any(v_active)) then return new; end if;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then return new; end if;
  if tg_op = 'UPDATE' and old.status = any(v_active) then return new; end if;  -- already active

  select exists (select 1 from lead_shares  s where s.contact_id = new.contact_id) into v_shared;
  if v_shared then return new; end if;

  select exists (select 1 from lead_share_nudges n where n.contact_id = new.contact_id) into v_nudged;
  if v_nudged then return new; end if;

  select coalesce(nullif(trim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''), 'this lead')
    into v_name from contacts c where c.id = new.contact_id;

  v_label := coalesce(nullif(trim(new.label),''), upper(new.order_type));

  insert into lead_share_nudges (contact_id, first_order_id, notified_at)
  values (new.contact_id, new.id, now())
  on conflict (contact_id) do nothing;

  v_body := v_label || ' started on ' || v_name || ', which is not shared with the VA.';

  perform app_notify_system(
    'unshared_lead_nudge', new.id, v_body, 'System', new.contact_id,
    array['admin'],
    '/admin/lead-detail?contact_id=' || new.contact_id::text
  );

  return new;
end; $function$;

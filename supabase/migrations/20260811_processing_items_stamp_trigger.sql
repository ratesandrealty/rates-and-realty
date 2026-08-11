-- processing_items: stamp the completer from the verified session.
--
-- STEP 2 of 2. 20260811_processing_items_completed_by_user.sql added the
-- columns; this adds the trigger that fills them.
--
-- SPLIT ON PURPOSE, and the order is the point. lpLoadChecklist auto-completes
-- the Drive-folder step in the browser under the signed-in user's session. With
-- this trigger live and the OLD page still deployed, that auto-detection would
-- be stamped with whoever happened to open the lead — a wrong claim about a
-- specific human, which is worse than the role string it replaces. So the page
-- ships first, declaring completed_source='system' on that path, and only then
-- does this land.

/* Stamps the completer server-side, modelled on tg_tasks_stamp_completion().
 *
 * SECURITY DEFINER + auth.uid(): the browser writes processing_items directly
 * through PostgREST, so anything the CLIENT supplies for attribution is
 * forgeable. The client no longer sends it at all, and this trigger makes that
 * structural rather than a convention:
 *
 *   - on the transition INTO completed, the uid is overwritten from auth.uid()
 *   - on any other update, it is pinned to its OLD value
 *
 * so there is no path by which a browser can name someone else as the completer. */
create or replace function public.tg_processing_items_stamp_completion()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  entering boolean;
  leaving  boolean;
begin
  entering := coalesce(NEW.completed, false)
              and (TG_OP = 'INSERT' or coalesce(OLD.completed, false) is distinct from coalesce(NEW.completed, false));
  leaving  := TG_OP = 'UPDATE'
              and coalesce(OLD.completed, false) and not coalesce(NEW.completed, false);

  if entering then
    if NEW.completed_at is null then NEW.completed_at := now(); end if;

    /* An explicit 'system' write (the Drive auto-detect) names no person. Any
     * other completion is a person's, and auth.uid() is the only acceptable
     * source for who. A null uid with no declared source is recorded as
     * 'system' rather than silently looking like an anonymous human. */
    if NEW.completed_source = 'system' or auth.uid() is null then
      NEW.completed_source     := 'system';
      NEW.completed_by_user_id := null;
    else
      NEW.completed_source     := 'user';
      NEW.completed_by_user_id := auth.uid();
    end if;

  elsif leaving then
    -- No longer completed: every completion stamp goes, including the legacy
    -- role string, which would otherwise outlive the completion it described.
    NEW.completed_at         := null;
    NEW.completed_by_user_id := null;
    NEW.completed_source     := null;
    NEW.completed_by         := null;

  elsif TG_OP = 'UPDATE' then
    -- Not a completion transition, so attribution is immutable. This is what
    -- stops a client PATCHing completed_by_user_id on an unrelated field edit.
    NEW.completed_by_user_id := OLD.completed_by_user_id;
    NEW.completed_source     := OLD.completed_source;
  end if;

  return NEW;
end;
$function$;

drop trigger if exists trg_processing_items_stamp_completion on public.processing_items;
create trigger trg_processing_items_stamp_completion
  before insert or update on public.processing_items
  for each row execute function public.tg_processing_items_stamp_completion();


-- tg_processing_items_stamp_completion()
-- language: plpgsql   SECURITY DEFINER
-- Added 2026-08-11. Captured here on creation rather than discovered later:
-- observe-db-functions diffs production against THIS DIRECTORY, so a function
-- with no file here registers as movement on every run.
--
-- WHY: processing_items.completed_by held a ROLE, not a person — the browser
-- hardcoded the literal 'admin' in lpToggle/lpStatus and never consulted the
-- session, so a VA's completion recorded 'admin' and rendered as a named human.
-- Modelled on tg_tasks_stamp_completion(), which already does this for tasks.
--
-- The client writes processing_items directly through PostgREST, so anything it
-- supplies for attribution is forgeable. Hence: overwritten from auth.uid() on
-- the transition INTO completed, and pinned to its OLD value on every other
-- update. Both forgery paths were probed on the ZZ-TEST fixture and overwritten.
--
-- 'system' exists because lpLoadChecklist auto-completes the Drive-folder step
-- in the browser under the user's own session: auth.uid() is set, and stamping
-- it would claim a person did work a machine detected.

CREATE OR REPLACE FUNCTION public.tg_processing_items_stamp_completion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

    if NEW.completed_source = 'system' or auth.uid() is null then
      NEW.completed_source     := 'system';
      NEW.completed_by_user_id := null;
    else
      NEW.completed_source     := 'user';
      NEW.completed_by_user_id := auth.uid();
    end if;

  elsif leaving then
    NEW.completed_at         := null;
    NEW.completed_by_user_id := null;
    NEW.completed_source     := null;
    NEW.completed_by         := null;

  elsif TG_OP = 'UPDATE' then
    NEW.completed_by_user_id := OLD.completed_by_user_id;
    NEW.completed_source     := OLD.completed_source;
  end if;

  return NEW;
end;
$function$;

-- processing_items.completed_by records a ROLE, not a person.
--
-- Rene, in a VA session, checked off "Pull & review credit" and the row recorded
-- 'admin'. Not because the role was misread — because the writer is a LITERAL:
--
--   admin/lead-detail.html  lpToggle():  patch.completed_by = 'admin';
--   admin/lead-detail.html  lpStatus():  patch.completed_by = 'admin';
--
-- It never consulted the session at all. All 39 populated rows say 'admin',
-- 2026-06-15 → 2026-08-11, and the UI mapped that string to a person through
-- LP_PERSON_LABEL = { admin:'Rene Duarte (Admin)' } — correct only while there
-- is exactly one admin, and a lie the moment there are two.
--
-- Same shape as sms_log.actor_user_id / calls_log.actor_user_id, and the exact
-- shape of tasks.completed_by, which is already a uuid stamped by
-- tg_tasks_stamp_completion() from auth.uid().

alter table public.processing_items
  add column if not exists completed_by_user_id uuid references auth.users(id) on delete set null;

/* Mirrors tasks.completed_source, and it is NOT optional here.
 *
 * lpLoadChecklist auto-completes the "Google Drive folder" step when the folder
 * already exists, writing notes '✓ Auto-detected'. That runs IN THE BROWSER
 * under the signed-in user's session, so auth.uid() is set and a trigger that
 * stamped it unconditionally would attribute a machine's detection to whichever
 * person happened to open the page. That is a worse bug than the one being
 * fixed: 'admin' was at least never a claim about a specific human.
 *
 * The precedent is load-bearing elsewhere too — va_productivity_report counts
 * only `coalesce(completed_source,'user') <> 'system'`, so system completions
 * already corrupt a real report when they are mistaken for a person's work. */
alter table public.processing_items
  add column if not exists completed_source text;

alter table public.processing_items
  drop constraint if exists processing_items_completed_source_check;
alter table public.processing_items
  add constraint processing_items_completed_source_check
  check (completed_source is null or completed_source in ('user', 'system'));

comment on column public.processing_items.completed_by_user_id is
  'WHO completed this item, from auth.uid() at the moment of completion. Stamped server-side by tg_processing_items_stamp_completion and immutable to the client. Null with completed=true means either a system completion (see completed_source) or a legacy row predating 2026-08-11 — read completed_by for those, and do not resolve it to a person.';

comment on column public.processing_items.completed_by is
  'LEGACY, superseded by completed_by_user_id. Holds a ROLE STRING, never a person: all 39 rows written 2026-06-15..2026-08-11 say ''admin'' because the browser hardcoded it. NOT backfilled — the person behind those rows cannot be identified and inventing a uid would be a guess. New completions leave this null.';

comment on column public.processing_items.completed_source is
  '''user'' = a person completed it (completed_by_user_id is set). ''system'' = detected automatically, e.g. the Drive-folder auto-complete; completed_by_user_id is deliberately null and no person may be shown.';

/* Resolve staff uids to a display identity, ADMINS INCLUDED.
 *
 * staff_assignees() deliberately returns only va/agent/loa, which is right for
 * an assignee picker and wrong for "who completed this" — Rene's own
 * completions would resolve to nothing. The workaround already in the page for
 * @-mentions (lead-detail.html: `list.unshift({ local:'rene', ... })`) is the
 * same one-admin assumption that produced this bug, so this does not repeat it:
 * no name is hardcoded and every admin is returned.
 *
 * Same authorization gate as staff_assignees(). Returns email and role only —
 * the identity already visible in the assignee and @-mention pickers — and only
 * for uids the caller asks about. */
create or replace function public.staff_display_names(p_ids uuid[])
returns table(user_id uuid, email text, role text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not (is_admin() or coalesce(current_app_role(),'') in ('va','agent','loa')) then
    raise exception 'not authorized';
  end if;
  return query
  select r.user_id, u.email::text, r.role
  from auth_user_roles r
  join auth.users u on u.id = r.user_id
  where r.user_id = any(coalesce(p_ids, '{}'::uuid[]));
end;
$function$;

revoke all on function public.staff_display_names(uuid[]) from public;
grant execute on function public.staff_display_names(uuid[]) to authenticated;

-- Deliberately NOT backfilled. The 39 rows say 'admin' because that is what was
-- recorded; resolving them to the one current admin would be inventing a person
-- from a role, which is the guess this whole change exists to stop.

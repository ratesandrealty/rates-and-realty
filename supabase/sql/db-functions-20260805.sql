-- Postgres functions written or changed on 2026-08-05.
-- Captured because nothing captures them automatically: check-function-drift.mjs
-- covers EDGE functions only and never looks at the database. Until this file
-- existed, every one of these lived solely in production.
--
-- Re-run safe: all are CREATE OR REPLACE.
-- See README-db-functions.md for how to re-capture after a change.

-- ─────────────────────────────────────────────────────────────────────────────
-- app_notify_system — notifications for events with no human author.
--
-- app_notify_mentions is NOT a general notifier despite the name: it scans
-- p_body for @handles, so a machine-generated body with no @ iterates zero
-- times, returns 0 and inserts nothing. Three callers (video-track, video-chat's
-- failure alert, sms-inbound-reconcile) had never delivered a single
-- notification and nobody could tell.
--
-- NOTE: a pre-p_link overload (text,uuid,text,text,uuid,text[]) also existed and
-- was DROPPED on 2026-08-05 — a caller omitting p_link resolved to it and
-- silently produced a notification with no link, reintroducing the dead-click
-- bug through overload resolution rather than through code.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.app_notify_system(
  p_source_kind text, p_source_id uuid, p_body text,
  p_actor_display text DEFAULT 'System'::text,
  p_contact_id uuid DEFAULT NULL::uuid,
  p_roles text[] DEFAULT ARRAY['admin'::text],
  p_link text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_preview text;
  n int := 0;
begin
  if coalesce(trim(p_body),'') = '' then return 0; end if;
  v_preview := left(regexp_replace(p_body, '\s+', ' ', 'g'), 180);

  insert into public.app_notifications
    (recipient_user_id, actor_user_id, actor_display, kind,
     source_kind, source_id, contact_id, preview, link)
  select aur.user_id, null,
         coalesce(nullif(trim(p_actor_display),''), 'System'),
         'system', p_source_kind, p_source_id, p_contact_id, v_preview,
         nullif(trim(coalesce(p_link,'')),'')
  from auth_user_roles aur
  where aur.role = any(p_roles);

  get diagnostics n = row_count;
  return n;
end; $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- staff_message_delete — soft-delete one staff chat message. Admin only, own
-- messages only.
--
-- The check is HERE and not in RLS deliberately: staff_messages has no UPDATE or
-- DELETE policy, so RLS already denies both — but PostgREST reports that denial
-- as HTTP 200 [] or 204, which reads as SUCCESS. A VA clicking delete would see
-- the message vanish and return on reload.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.staff_message_delete(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sender uuid;
  v_deleted timestamptz;
begin
  if not is_admin() then
    raise exception 'admin only';
  end if;

  select sender_user_id, deleted_at into v_sender, v_deleted
  from public.staff_messages where id = p_id;

  if v_sender is null then
    raise exception 'message not found';
  end if;

  -- Own messages only. An admin deleting someone else's words is a different
  -- decision from redacting their own, and was not the one made.
  if v_sender <> auth.uid() then
    raise exception 'you can only delete your own messages';
  end if;

  if v_deleted is not null then
    return;   -- already gone; deleting twice is not an error
  end if;

  update public.staff_messages
     set deleted_at = now(), deleted_by = auth.uid()
   where id = p_id;
end;
$function$;

REVOKE ALL ON FUNCTION public.staff_message_delete(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.staff_message_delete(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- staff_thread_messages — deleted rows still return, BLANKED and flagged, so the
-- thread can render a "message deleted" tombstone. Body and attachments are
-- stripped server-side so deleted content never reaches the browser.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.staff_thread_messages(p_thread uuid, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, sender_user_id uuid, sender_email text, body text,
               created_at timestamp with time zone, mine boolean,
               attachments jsonb, is_deleted boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  if not is_thread_member(p_thread) then raise exception 'not a participant'; end if;
  return query
  select m.id, m.sender_user_id, u.email::text,
         case when m.deleted_at is null then m.body else null end,
         m.created_at, (m.sender_user_id = auth.uid()),
         case when m.deleted_at is null then coalesce((select jsonb_agg(jsonb_build_object(
             'id',a.id,'storage_path',a.storage_path,'file_name',a.file_name,
             'mime_type',a.mime_type,'size_bytes',a.size_bytes,'kind',a.kind) order by a.created_at)
           from public.staff_message_attachments a where a.message_id=m.id),'[]'::jsonb)
           else '[]'::jsonb end,
         (m.deleted_at is not null)
  from public.staff_messages m
  left join auth.users u on u.id=m.sender_user_id
  where m.thread_id=p_thread
  order by m.created_at desc
  limit greatest(1, least(coalesce(p_limit,50),200));
end; $function$;

GRANT EXECUTE ON FUNCTION public.staff_thread_messages(uuid, integer) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- staff_threads_list — ALL THREE reads of staff_messages filter deleted_at.
-- Missing any one has its own symptom:
--   last_message → the sidebar preview keeps quoting a deleted message
--   last_sender  → the preview attributes it to the wrong person
--   unread       → the thread stays badged FOREVER, because the message making
--                  it unread no longer renders and so can never be read.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.staff_threads_list()
 RETURNS TABLE(thread_id uuid, is_group boolean, title text,
               last_message_at timestamp with time zone, last_message text,
               last_sender uuid, unread integer, others jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  return query
  select t.id, t.is_group, t.title, t.last_message_at,
    (select m.body from public.staff_messages m
      where m.thread_id=t.id and m.deleted_at is null
      order by m.created_at desc limit 1),
    (select m.sender_user_id from public.staff_messages m
      where m.thread_id=t.id and m.deleted_at is null
      order by m.created_at desc limit 1),
    (select count(*)::int from public.staff_messages m
      where m.thread_id=t.id and m.deleted_at is null
        and m.created_at > me.last_read_at and m.sender_user_id <> auth.uid()),
    (select coalesce(jsonb_agg(jsonb_build_object('user_id',p.user_id,'email',u.email,'role',ar.role)),'[]'::jsonb)
      from public.staff_thread_participants p
      join auth.users u on u.id=p.user_id
      left join public.auth_user_roles ar on ar.user_id=p.user_id
      where p.thread_id=t.id and p.user_id <> auth.uid())
  from public.staff_threads t
  join public.staff_thread_participants me on me.thread_id=t.id and me.user_id=auth.uid()
  order by t.last_message_at desc;
end; $function$;

GRANT EXECUTE ON FUNCTION public.staff_threads_list() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- chat_attachment_delete — now soft-deletes the empty shell message rather than
-- hard-deleting it, so one feature has one deletion semantics. The ATTACHMENT
-- row is still hard-deleted: that is this function's job, and the caller uses
-- the returned storage_path to remove the object.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.chat_attachment_delete(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_path text; v_msg uuid;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  select storage_path, message_id into v_path, v_msg from public.staff_message_attachments where id = p_id;
  if v_path is null then raise exception 'attachment not found'; end if;
  delete from public.staff_message_attachments where id = p_id;
  update public.staff_messages m
     set deleted_at = now(), deleted_by = auth.uid()
   where m.id = v_msg
     and m.deleted_at is null
     and coalesce(trim(m.body),'') = ''
     and not exists (select 1 from public.staff_message_attachments a where a.message_id = m.id);
  return jsonb_build_object('deleted', true, 'storage_path', v_path);
end; $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Schema changes made the same day (idempotent):
--   alter table public.app_notifications add column if not exists link text;
--   alter table public.staff_messages
--     add column if not exists deleted_at timestamptz,
--     add column if not exists deleted_by uuid references auth.users(id);
-- ─────────────────────────────────────────────────────────────────────────────

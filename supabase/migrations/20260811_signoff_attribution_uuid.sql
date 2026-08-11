-- borrower_documents.reviewed_by / loan_conditions.cleared_by → a real person.
--
-- Same treatment as processing_items.completed_by (20260811_processing_items_*),
-- and for a sharper reason: these two record who SIGNED OFF on something a lender
-- or an auditor may later ask about. A row that cannot name a person must not
-- name one.
--
-- What was actually there, measured 2026-08-11:
--
--   loan_conditions.cleared_by      9 rows, every one the literal 'Rene'
--   borrower_documents.reviewed_by  0 rows — nothing has ever written it
--
-- loan_conditions.cleared_by is worse than the processing_items case, because
-- THREE writers disagree about what the column even holds:
--
--   extract-conditions/index.ts:228   cleared_by = cleared_by || 'Rene'
--                                     — a CLIENT-SUPPLIED string, defaulting to
--                                       a person's name. This produced the 9 rows.
--   condition_set_status.sql:27       cleared_by = auth.uid()
--   condition_attach.sql:38           cleared_by = auth.uid()
--
-- So the text column is a union of names and uuids, and which one a given row
-- holds depends on which code path cleared it. Nothing in the frontend renders
-- either column today, so this was invisible.

-- ── loan_conditions ─────────────────────────────────────────────────────────
alter table public.loan_conditions
  add column if not exists cleared_by_user_id uuid references auth.users(id) on delete set null;

/* extract-conditions runs with the service role, so a clear can genuinely happen
 * with no session behind it. Same three-outcome rule as everywhere else in this
 * project: cleared by a person, cleared by the system, or not cleared. A null
 * uid with no source would be indistinguishable from an unattributed human. */
alter table public.loan_conditions
  add column if not exists cleared_source text;

alter table public.loan_conditions
  drop constraint if exists loan_conditions_cleared_source_check;
alter table public.loan_conditions
  add constraint loan_conditions_cleared_source_check
  check (cleared_source is null or cleared_source in ('user', 'system'));

comment on column public.loan_conditions.cleared_by_user_id is
  'WHO cleared this condition, from auth.uid() at the moment of clearing. Stamped by tg_loan_conditions_stamp_cleared and immutable to the client. Null with status=''cleared'' means a system clear (see cleared_source) or a legacy row — read cleared_by, and do not resolve it to a person.';

comment on column public.loan_conditions.cleared_by is
  'LEGACY, superseded by cleared_by_user_id. Held EITHER a free-text name OR a uuid depending on the code path: extract-conditions defaulted it to the literal ''Rene'' (all 9 populated rows, to 2026-08-11) while condition_set_status and condition_attach wrote auth.uid() into it. NOT backfilled — ''Rene'' names a person but not verifiably THE person, and a uuid here is the same fact stored in the wrong column. New clears leave this null.';

comment on column public.loan_conditions.cleared_source is
  '''user'' = a person cleared it (cleared_by_user_id set). ''system'' = cleared with no session, e.g. a service-role call through extract-conditions; no person may be shown.';

create or replace function public.tg_loan_conditions_stamp_cleared()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  entering boolean;
  leaving  boolean;
begin
  entering := NEW.status = 'cleared'
              and (TG_OP = 'INSERT' or OLD.status is distinct from NEW.status);
  leaving  := TG_OP = 'UPDATE' and OLD.status = 'cleared' and NEW.status is distinct from 'cleared';

  if entering then
    if NEW.cleared_at is null then NEW.cleared_at := now(); end if;
    if NEW.cleared_source = 'system' or auth.uid() is null then
      NEW.cleared_source     := 'system';
      NEW.cleared_by_user_id := null;
    else
      NEW.cleared_source     := 'user';
      NEW.cleared_by_user_id := auth.uid();
    end if;

  elsif leaving then
    -- Un-clearing drops every sign-off stamp, the legacy string included: it
    -- described a clearing that no longer stands.
    NEW.cleared_at         := null;
    NEW.cleared_by_user_id := null;
    NEW.cleared_source     := null;
    NEW.cleared_by         := null;

  elsif TG_OP = 'UPDATE' then
    -- Attribution is immutable outside the transition, so no client PATCH on an
    -- unrelated field can rewrite who signed off.
    NEW.cleared_by_user_id := OLD.cleared_by_user_id;
    NEW.cleared_source     := OLD.cleared_source;
  end if;

  return NEW;
end;
$function$;

drop trigger if exists trg_loan_conditions_stamp_cleared on public.loan_conditions;
create trigger trg_loan_conditions_stamp_cleared
  before insert or update on public.loan_conditions
  for each row execute function public.tg_loan_conditions_stamp_cleared();

-- ── borrower_documents ──────────────────────────────────────────────────────
--
-- PRE-EMPTIVE, and deliberately so: reviewed_by has never been written, and
-- there is no reviewer UI. The column is text, so the first thing to write it
-- would have repeated the bug — a document review is exactly the sign-off a
-- lender asks about later. The signal is reviewed_at going from null to set,
-- since there is no review-status column.
--
-- No reviewed_source column here, unlike loan_conditions: that one has a
-- demonstrated service-role writer (extract-conditions) and this has no writer
-- at all. A source column for a path nobody has built would be speculation.
alter table public.borrower_documents
  add column if not exists reviewed_by_user_id uuid references auth.users(id) on delete set null;

comment on column public.borrower_documents.reviewed_by_user_id is
  'WHO reviewed this document, from auth.uid() when reviewed_at is first set. Stamped by tg_borrower_documents_stamp_reviewed and immutable to the client. Null with reviewed_at set means no session was behind the write — treat as unattributed, never as a person.';

comment on column public.borrower_documents.reviewed_by is
  'LEGACY, superseded by reviewed_by_user_id. Text, and never written by anything: 0 populated rows as of 2026-08-11. Kept only so a future discovery of an old writer is not silently lost.';

create or replace function public.tg_borrower_documents_stamp_reviewed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if NEW.reviewed_at is not null
     and (TG_OP = 'INSERT' or OLD.reviewed_at is null) then
    NEW.reviewed_by_user_id := auth.uid();
  elsif TG_OP = 'UPDATE' and NEW.reviewed_at is null and OLD.reviewed_at is not null then
    NEW.reviewed_by_user_id := null;
    NEW.reviewed_by         := null;
  elsif TG_OP = 'UPDATE' then
    NEW.reviewed_by_user_id := OLD.reviewed_by_user_id;
  end if;
  return NEW;
end;
$function$;

drop trigger if exists trg_borrower_documents_stamp_reviewed on public.borrower_documents;
create trigger trg_borrower_documents_stamp_reviewed
  before insert or update on public.borrower_documents
  for each row execute function public.tg_borrower_documents_stamp_reviewed();

-- ── stop the old writers polluting the legacy columns ───────────────────────
--
-- Both RPCs wrote auth.uid() into the TEXT column. The trigger now owns
-- attribution, so writing it twice — once correctly typed, once as a string in
-- a column documented as legacy — would keep the ambiguity alive.
-- Both bodies below are the DEPLOYED ones verbatim, with only the cleared_by
-- assignment removed. The guard in particular is copied exactly: it admits
-- service_role and 'staff' and raises 'staff only', which a from-memory rewrite
-- would have quietly narrowed.
create or replace function public.condition_set_status(p_condition_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_role text;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  if p_status not in ('pending','in_review','cleared','waived') then
    raise exception 'invalid status %', p_status;
  end if;
  update public.loan_conditions
     set status = p_status,
         cleared_at = case when p_status='cleared' then now() else null end,
         -- cleared_by NOT set: tg_loan_conditions_stamp_cleared stamps
         -- cleared_by_user_id from auth.uid(). This used to write that uuid into
         -- the legacy TEXT column, which is how the column came to hold both
         -- names and uuids depending on the path taken.
         updated_at = now()
   where id = p_condition_id;
  return jsonb_build_object('condition_id', p_condition_id, 'status', p_status);
end; $function$;

create or replace function public.condition_attach(p_condition_id uuid, p_docs jsonb, p_clear boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_role text; v_contact uuid; d jsonb; v_total int;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  select contact_id into v_contact from public.loan_conditions where id = p_condition_id;
  if v_contact is null then raise exception 'condition not found'; end if;

  for d in select * from jsonb_array_elements(coalesce(p_docs, '[]'::jsonb)) loop
    insert into public.condition_attachments(
      condition_id, contact_id, uploaded_document_id, gdrive_file_id, file_name, file_url, attached_by)
    values(p_condition_id, v_contact,
      nullif(d->>'uploaded_document_id','')::uuid,
      nullif(d->>'gdrive_file_id',''),
      coalesce(nullif(trim(d->>'file_name'),''), 'Document'),
      nullif(d->>'file_url',''),
      auth.uid())
    on conflict do nothing;
  end loop;

  if p_clear then
    update public.loan_conditions
       set status='cleared', cleared_at=now(), updated_at=now()   -- cleared_by: see above
     where id = p_condition_id;
  end if;

  select count(*) into v_total from public.condition_attachments where condition_id = p_condition_id;
  return jsonb_build_object('condition_id', p_condition_id, 'total_attachments', v_total, 'cleared', p_clear);
end; $function$;

-- Deliberately NOT backfilled. The 9 'Rene' rows say what was recorded; the one
-- admin is the likely person but "likely" is the guess this refuses to make.

-- Recording consent, recorded on the contact.
--
-- WHY THIS EXISTS NOW. The outbound recording announcement was removed
-- 2026-08-12, and the basis for recording moved from "a sentence played on every
-- call" to "consent obtained at intake". That is a stronger position only if
-- there is a record behind it. Without one, "we get consent at intake" is a
-- practice, not evidence.
--
-- THE SMALLEST VERSION THAT IS ACTUALLY A RECORD — three columns, no table:
--
--   recording_consent_at      WHEN. Null means no consent recorded. There is no
--                             "unknown vs no" distinction to draw: both mean we
--                             cannot evidence consent for this contact.
--   recording_consent_method  HOW, from a CLOSED set. Free text would decay into
--                             "yes", "ok", "told them" — none of which is
--                             evidence of anything, and no two of which can be
--                             counted together.
--   recording_consent_by      WHO attested it. This is the one that might look
--                             like scope creep and is not: a consent record with
--                             no attribution is a checkbox. "Rene recorded on
--                             2026-08-12 that consent was given verbally at
--                             intake" is a statement someone stands behind;
--                             "consent: true" is not.
--
-- NOT A HISTORY TABLE, deliberately. Consent is obtained once, at intake. If it
-- is ever re-obtained the newer fact replaces the older one, and nothing in the
-- current process produces a sequence worth keeping. A table can be added later
-- without moving these columns; building it now would be inventing a workflow.
--
-- NO BACKFILL. All 1,042 existing contacts stay NULL. Rene may well have consent
-- from most of them, but stamping an assumption onto every row would manufacture
-- exactly the evidence this is supposed to be — and a fabricated consent record
-- is worse than an absent one.

alter table public.contacts
  add column if not exists recording_consent_at     timestamptz,
  add column if not exists recording_consent_method text,
  add column if not exists recording_consent_by     uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'contacts_recording_consent_method_chk'
  ) then
    alter table public.contacts
      add constraint contacts_recording_consent_method_chk
      check (recording_consent_method is null
             or recording_consent_method in ('verbal_intake','signed','portal'));
  end if;
end $$;

/* A method with no date is a half-written record — it says how without saying
   whether. Enforced rather than trusted to the UI, since the columns are also
   reachable by anything with table access. */
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'contacts_recording_consent_pair_chk'
  ) then
    alter table public.contacts
      add constraint contacts_recording_consent_pair_chk
      check ((recording_consent_at is null) = (recording_consent_method is null));
  end if;
end $$;

comment on column public.contacts.recording_consent_at is
  'When recording consent was obtained. NULL = none on record. Since 2026-08-12 this is the basis for recording OUTBOUND calls; inbound still announces per call because an inbound caller may not be in the database at all.';
comment on column public.contacts.recording_consent_method is
  'How consent was obtained: verbal_intake | signed | portal. Closed set — free text is not evidence.';
comment on column public.contacts.recording_consent_by is
  'Staff user who attested it. A consent record with no attribution is a checkbox.';

/* ── SETTER ──────────────────────────────────────────────────────────────────
 * An RPC rather than a direct table write, for one reason that matters: `by` is
 * stamped from auth.uid() SERVER-SIDE and cannot be supplied by the caller. A
 * client-set attester is not an attestation.
 *
 * Clearing is allowed (p_method null) — a consent recorded in error must be
 * removable, and leaving it in place because the setter only ever writes is how
 * a wrong record becomes permanent. */
CREATE OR REPLACE FUNCTION public.set_recording_consent(
  p_contact_id uuid,
  p_method     text DEFAULT NULL,
  p_at         timestamptz DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_at timestamptz; v_row public.contacts;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;

  if p_method is null then
    update public.contacts
       set recording_consent_at = null, recording_consent_method = null, recording_consent_by = null
     where id = p_contact_id returning * into v_row;
  else
    if p_method not in ('verbal_intake','signed','portal') then
      raise exception 'unknown consent method: %', p_method;
    end if;
    /* Default to now(), but allow an explicit date — consent is often recorded
       after the fact, and forcing today's date onto an intake that happened last
       week would make the record say something untrue. */
    v_at := coalesce(p_at, now());
    if v_at > now() + interval '1 day' then
      raise exception 'consent date is in the future';
    end if;
    update public.contacts
       set recording_consent_at = v_at, recording_consent_method = p_method, recording_consent_by = auth.uid()
     where id = p_contact_id returning * into v_row;
  end if;

  if v_row.id is null then raise exception 'no such contact'; end if;
  return jsonb_build_object(
    'contact_id', v_row.id,
    'recording_consent_at', v_row.recording_consent_at,
    'recording_consent_method', v_row.recording_consent_method);
end; $function$;

REVOKE ALL ON FUNCTION public.set_recording_consent(uuid, text, timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION public.set_recording_consent(uuid, text, timestamptz) TO authenticated;

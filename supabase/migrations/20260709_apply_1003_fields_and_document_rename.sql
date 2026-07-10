-- Backfill of two RPCs that were deployed to the live DB via MCP but never tracked in the repo
-- (same source-drift gap that lost sms-assistant). Definitions pulled verbatim via
-- pg_get_functiondef on 2026-07-09.
--
--  • apply_1003_fields — applies OCR/scan fields to the newest mortgage_applications row for a
--    contact. Staff-only. Server-side WHITELIST: only the listed 1003 columns are writable, and
--    null/blank values are ignored — so callers may pass the whole approved object safely. The
--    6 "context-only" scan keys (ytd_gross_income, pay_frequency, bank_name, account_type,
--    account_last4, ending_balance) are intentionally NOT in the whitelist.
--  • document_rename — renames an uploaded_documents row (file_name only; the Drive copy is not
--    renamed yet). Returns gdrive_file_id so a future gdrive-proxy rename can be wired.
-- Used by admin/lead-detail.html (Scan → 1003 + inline document rename).

CREATE OR REPLACE FUNCTION public.apply_1003_fields(p_fields jsonb, p_application_id uuid DEFAULT NULL::uuid, p_contact_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text; v_app_id uuid; k text; sets text := ''; v_applied text[] := '{}';
  -- whitelist: only these mortgage_applications columns may be written from OCR
  allowed text[] := array[
    'first_name','middle_name','last_name','suffix','ssn','date_of_birth','marital_status','citizenship',
    'home_phone','cell_phone','email',
    'current_address_street','current_address_unit','current_address_city','current_address_state','current_address_zip',
    'dl_number','dl_state','dl_expiry',
    'employer_name','employer_phone','employer_street','employer_city','employer_state','employer_zip',
    'position_title','employment_start_date','is_self_employed',
    'base_income','overtime_income','bonus_income','commission_income','total_monthly_income',
    'property_address_street','property_address_city','property_address_state','property_address_zip',
    'purchase_price','property_value','credit_score'
  ];
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;

  v_app_id := p_application_id;
  if v_app_id is null and p_contact_id is not null then
    select id into v_app_id from public.mortgage_applications
     where contact_id = p_contact_id order by created_at desc limit 1;
  end if;
  if v_app_id is null then raise exception 'no application found'; end if;

  for k in select jsonb_object_keys(p_fields) loop
    if k = any(allowed)
       and p_fields->k is not null
       and jsonb_typeof(p_fields->k) <> 'null'
       and nullif(trim(p_fields->>k),'') is not null then
      sets := sets || format('%I = %L, ', k, p_fields->>k);
      v_applied := v_applied || k;
    end if;
  end loop;

  if sets = '' then return jsonb_build_object('applied', 0, 'application_id', v_app_id); end if;

  execute format('update public.mortgage_applications set %s updated_at = now() where id = %L',
                 sets, v_app_id);

  return jsonb_build_object('applied', array_length(v_applied,1), 'fields', v_applied, 'application_id', v_app_id);
end; $function$;

CREATE OR REPLACE FUNCTION public.document_rename(p_id uuid, p_new_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_row uploaded_documents;
begin
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','');
  if not (public.is_admin() or v_role='service_role'
          or coalesce(public.current_app_role(),'') in ('va','loa','agent','staff')) then
    raise exception 'staff only';
  end if;
  if coalesce(trim(p_new_name),'') = '' then raise exception 'name required'; end if;

  update public.uploaded_documents
     set file_name = trim(p_new_name)
   where id = p_id
   returning * into v_row;

  if v_row.id is null then raise exception 'document not found'; end if;
  return jsonb_build_object('id', v_row.id, 'file_name', v_row.file_name,
                            'gdrive_file_id', v_row.gdrive_file_id);
end; $function$;

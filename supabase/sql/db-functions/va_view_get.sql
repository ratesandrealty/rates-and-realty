-- va_view_get(p_role text)
-- language: plpgsql   SECURITY DEFINER
-- Captured from production 2026-08-11. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.va_view_get(p_role text DEFAULT 'va'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare v jsonb;
begin
  if coalesce(auth.role(),'') is distinct from 'service_role' and not public.is_admin() then
    raise exception 'admin only';
  end if;
  select jsonb_agg(jsonb_build_object(
           'capability', c.cap, 'label', c.label, 'description', c.descr,
           'grp', c.grp, 'allowed', coalesce(rv.allowed, false)) order by c.ord)
    into v
  from (values
    ('ssn',                 'Social Security / TIN', 'See full SSN/TIN on borrowers',            'Fields', 1),
    ('financials',          'Income & assets',       'See income, assets and financial detail',  'Fields', 2),
    ('earnings',            'Earnings',              'See earnings figures',                     'Fields', 3),
    ('tab_lead_details',    'Lead Details tab',      'See the Lead Details tab',                 'Lead tabs', 10),
    ('tab_loan_processing', 'Loan Processing tab',   'See the Loan Processing tab',              'Lead tabs', 11),
    ('tab_1003',            '1003 Application tab',  'See the 1003 Application tab',             'Lead tabs', 12),
    ('tab_documents',       'Documents tab',         'See the Documents tab',                    'Lead tabs', 13),
    ('tab_conditions',      'Conditions tab',        'See the Conditions tab',                   'Lead tabs', 14),
    ('tab_tasks',           'Tasks tab',             'See the Tasks tab',                        'Lead tabs', 15),
    ('tab_activity',        'Activity tab',          'See the Activity timeline tab',            'Lead tabs', 16),
    ('tab_alerts',          'Alerts tab',            'See the Alerts tab',                       'Lead tabs', 17),
    ('tab_showings',        'Showings tab',          'See the Showings tab',                     'Lead tabs', 18)
  ) as c(cap, label, descr, grp, ord)
  left join public.role_visibility rv on rv.role = p_role and rv.capability = c.cap;
  return jsonb_build_object('role', p_role, 'capabilities', coalesce(v,'[]'::jsonb));
end; $function$;

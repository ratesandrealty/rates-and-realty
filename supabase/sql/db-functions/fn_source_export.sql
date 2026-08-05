-- fn_source_export()
-- language: sql   SECURITY DEFINER
-- Captured from production 2026-08-05. This layer had NO git history:
-- check-function-drift.mjs compares deployed EDGE functions and never
-- opens the database, so 5 of 307 were recorded and the rest existed only
-- in production. Re-capture after any change.

CREATE OR REPLACE FUNCTION public.fn_source_export()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Every public function's source, for the nightly drift OBSERVATION in
   tools/observe-db-functions.mjs.
 *
 * Exists because there is no other repeatable read path: `supabase db dump`
 * needs Docker (unavailable here), the CLI's management token lives in the
 * Windows credential store and cannot be read, and PostgREST cannot reach
 * pg_catalog. The first capture used a throwaway view; recreating and dropping
 * one nightly is schema churn, so this is the stable replacement.
 *
 * EXECUTE is service_role only. Function source can embed table names, column
 * names and business logic, and 252 of these are SECURITY DEFINER — this is not
 * something an anon or authenticated caller should be able to read.
 *
 * Extension-owned functions are excluded via pg_depend deptype='e', which is
 * what makes the count 307 rather than several thousand. */
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', p.proname,
           'args', pg_get_function_identity_arguments(p.oid),
           'secdef', p.prosecdef,
           'lang', l.lanname,
           'def', pg_get_functiondef(p.oid)
         ) order by p.proname, pg_get_function_identity_arguments(p.oid)), '[]'::jsonb)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
  where n.nspname = 'public' and d.objid is null and p.prokind = 'f';
$function$;

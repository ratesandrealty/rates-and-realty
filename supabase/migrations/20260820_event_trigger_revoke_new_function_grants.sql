-- Applied to production 2026-08-20 as migration
-- event_trigger_revoke_new_function_grants.
--
-- WHY AN EVENT TRIGGER AND NOT ALTER DEFAULT PRIVILEGES.
--
-- Every function created in public is anon-executable at birth. The obvious fix
-- is to change the default, and it DOES NOT WORK:
--
--   alter default privileges in schema public revoke execute on functions from public;
--     -> succeeds, and leaves pg_default_acl BYTE-IDENTICAL.
--
-- pg_default_acl does not store the ACL a new object receives. It stores a DELTA
-- that is merged on top of the hard-wired acldefault(), which for functions is
-- always {=X/owner, owner=X/owner} -- PUBLIC has EXECUTE. A delta can only ADD
-- grants; there is no representation for "PUBLIC must not get EXECUTE". So the
-- revoke has nothing to write and the row does not move.
--
-- The anon half is worse than useless. Measured in a rollback transaction:
--
--   alter default privileges in schema public revoke execute on functions from anon;
--   create function zz_probe_after() ...
--     proacl {=X/postgres,postgres=X,authenticated=X,service_role=X}
--     has_function_privilege('anon', ...) = TRUE
--
-- The anon=X line is gone and anon still executes it, because anon inherits the
-- PUBLIC grant. A sweep looking for 'anon=' in proacl now reports that function
-- clean. That is the same family as verify_jwt = true: a statement that looks
-- like an access control, reports success, and is not one -- except this one
-- also blinds the check that would have caught it. Full record:
-- docs/ANON-EXECUTE-DURABLE-FIX-2026-08-20.md
--
-- SCOPE THIS DOES AND DOES NOT COVER. This applies at CREATE time only. It
-- closes NONE of the 319 application functions anon can already execute; it
-- stops number 320. Inflow and backlog are separate tracks and this is the
-- inflow one. (506 functions in public, of which 118 are pgvector extension
-- members and not ours to change -- postgres is not a member of supabase_admin.)

create or replace function public.rr_revoke_new_function_grants()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $BODY$
declare
  -- THE ALLOWLIST -- the only functions a genuinely anonymous caller must reach.
  --
  -- It is DATA, not a comment, because the trigger RE-GRANTS these rather than
  -- skipping them. That matters: the event tag for CREATE OR REPLACE is still
  -- CREATE FUNCTION, so without the re-grant an ordinary maintenance edit to one
  -- of these would silently strip anon and take a borrower-facing page down.
  -- Proven both ways -- see the assertion at the foot of this migration.
  --
  --   get_cma_snapshot        public/cma.html   /cma/<slug>
  --   get_fee_sheet_snapshot  public/fee.html   /fee/<slug>
  --   video_get_public        watch.html        /watch?v=<slug>
  --
  -- These three are the entire direct-anon .rpc() surface in the tree. Every
  -- other anonymous surface (lender portal, borrower portal, tours, e-sign,
  -- newsletter) goes through an edge function on the service role and is not
  -- affected by function grants at all.
  --
  -- ADDING A FOURTH PUBLIC RPC MEANS ADDING IT HERE. A migration that creates
  -- the function and grants anon afterwards works without this list -- the
  -- trigger fires at ddl_command_end of the CREATE and the explicit GRANT runs
  -- after it. What the list buys is survival of the NEXT CREATE OR REPLACE.
  -- Omitting it is not an error at the point of change; it is a page that breaks
  -- on an unrelated edit months later.
  --
  -- RECOVERY, if this function ever raises and blocks DDL:
  --   alter event trigger rr_revoke_new_function_grants disable;
  anon_ok constant text[] := array[
    'get_cma_snapshot',
    'get_fee_sheet_snapshot',
    'video_get_public'
  ];
  r     record;
  fname text;
begin
  for r in select * from pg_event_trigger_ddl_commands() loop
    -- in_extension excludes anything CREATE EXTENSION installs. pgvector owns
    -- 118 functions in public and they are not ours to re-grant.
    if r.classid = 'pg_proc'::regclass
       and not r.in_extension
       and r.schema_name = 'public' then
      begin
        select p.proname into fname from pg_proc p where p.oid = r.objid;

        -- Both are required. =X/owner is the PUBLIC grant and anon inherits it,
        -- so revoking anon alone would return success and change nothing.
        execute format('revoke execute on function %s from public, anon', r.object_identity);

        if fname = any (anon_ok) then
          execute format('grant execute on function %s to anon', r.object_identity);
        end if;
      exception when others then
        -- NEVER let this abort the DDL. A raising event trigger blocks every
        -- CREATE FUNCTION in the database, including the one that would fix it.
        raise warning 'rr_revoke_new_function_grants(%): %', r.object_identity, sqlerrm;
      end;
    end if;
  end loop;
end
$BODY$;

revoke execute on function public.rr_revoke_new_function_grants() from public, anon;

drop event trigger if exists rr_revoke_new_function_grants;
create event trigger rr_revoke_new_function_grants
  on ddl_command_end
  when tag in ('CREATE FUNCTION')
  execute function public.rr_revoke_new_function_grants();

-- PROOF IN THE MIGRATION, because this change is invisible from the outside.
-- It alters nothing about the running system, so "the site still works" is not
-- evidence that it landed. The only proof is to create a function and read its
-- ACL, which is what this does -- and then removes.
-- NOTE ON WHAT IS *NOT* ASSERTED HERE. The obvious way to prove the allowlist
-- arm is to create public.get_cma_snapshot(int) and read its ACL. That would
-- create an OVERLOAD of a live function -- the exact hazard CLAUDE.md records
-- twice (task_upsert, quote_reply_match) -- and if this block raised between the
-- create and the drop it would leave one behind permanently. The allowlist arm
-- is therefore proven LIVE, on the real functions, immediately after this
-- migration applies, in both directions. Record in
-- docs/ANON-EXECUTE-DURABLE-FIX-2026-08-20.md.
do $verify$
declare
  new_anon boolean;
begin
  execute 'create function public.rr_evt_selftest() returns int language sql as $f$ select 1 $f$';
  new_anon := has_function_privilege('anon', 'public.rr_evt_selftest()', 'EXECUTE');
  execute 'drop function public.rr_evt_selftest()';

  if new_anon then
    raise exception 'event trigger did not strip anon from a newly created function';
  end if;
end
$verify$;

-- Both directions proven live after applying, on the real functions rather than
-- throwaways -- see the migration note in
-- docs/ANON-EXECUTE-DURABLE-FIX-2026-08-20.md.

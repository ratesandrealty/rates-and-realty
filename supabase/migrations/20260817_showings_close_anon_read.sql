-- showings: close anonymous SELECT (step 2b — the last one)
--
-- BEFORE (captured 2026-08-17, both PERMISSIVE):
--
--   public_insert_showings  INSERT  {public}  WITH CHECK (true)
--   public_read_showings    SELECT  {public}  USING ((COALESCE(current_app_role(), ''::text) <> 'va'::text)
--                                                     OR is_admin() OR is_lead_shared_with_me(contact_id))
--
-- REVERT — one statement, restoring the exact policy this replaces:
--
--   DROP POLICY IF EXISTS staff_read_showings ON public.showings;
--   CREATE POLICY public_read_showings ON public.showings
--     AS PERMISSIVE FOR SELECT TO public
--     USING ((COALESCE(current_app_role(), ''::text) <> 'va'::text)
--            OR is_admin() OR is_lead_shared_with_me(contact_id));
--
-- WHY THE OLD ONE GRANTED ANONYMOUS READ
-- Its first clause is `COALESCE(current_app_role(),'') <> 'va'`. For an
-- anonymous caller current_app_role() is NULL, COALESCE makes that '', and
-- '' <> 'va' is TRUE — so the whole OR short-circuits to true before is_admin()
-- or is_lead_shared_with_me() is ever consulted. Combined with role {public},
-- which includes anon, that clause WAS the anonymous grant. Dropping
-- open_showings earlier changed nothing about reads for exactly this reason.
--
-- WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT
-- The expression is carried over verbatim. The only change is WHO it applies
-- to: TO authenticated instead of TO public. Staff semantics are therefore
-- untouched — admin and loa/agent keep full read, va still sees only shared
-- leads via is_lead_shared_with_me(). Rewriting the predicate at the same time
-- as changing the audience would have made a regression impossible to attribute.
--
-- RENAMED public_read_showings -> staff_read_showings. A policy called "public"
-- that excludes the public is a trap for the next reader, and this table has
-- already cost two passes to reasoning about which clause granted what.
--
-- ANONYMOUS INSERT SURVIVES, UNTOUCHED. public_insert_showings stays exactly as
-- it was: the public showing-request form posts through submit-showing, and
-- search-homes.html:942 inserts directly with the anon key when adding a home to
-- an existing tour. Both need it.
--
-- EVERYTHING THAT USED TO READ THIS TABLE ANONYMOUSLY HAS MOVED, and each move
-- was confirmed working in production by Rene before this landed:
--   unified-portal.html  six call sites   -> portal-data           (a609926)
--   portal.html:606      showings list    -> portal-data           (25382ce)
--   search-homes.html:878 batch context   -> portal-data           (25382ce)
--   dashboard/index.html:304              -> deleted, dead code    (25382ce)
--   dashboard/admin.html:3817,:3823       -> session token         (264a2f0)
--   admin/lead-detail.html:21982          -> session token         (264a2f0)
-- portal-data runs on the service role, which bypasses RLS entirely, so the
-- borrower portal is unaffected by this policy.
--
-- KNOWN, AND NOT ADDRESSED HERE. For an authenticated user with no row in
-- auth_user_roles, current_app_role() returns NULL and the first clause is true
-- again — they would read every showing. No such user exists today: borrowers
-- are portal_users, not auth.users. That changes the day the Supabase Auth
-- migration lands, and this policy must be revisited in the same pass. Written
-- down because it is the same shape as the bug being fixed: a NULL role reading
-- as "not va" rather than as "no role".

DROP POLICY IF EXISTS public_read_showings ON public.showings;

CREATE POLICY staff_read_showings ON public.showings
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    (COALESCE(current_app_role(), ''::text) <> 'va'::text)
    OR is_admin()
    OR is_lead_shared_with_me(contact_id)
  );

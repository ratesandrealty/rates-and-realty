-- contact_fk_catalogue (view)
-- Captured from production by tools/recapture-db-views.mjs. Do not hand-edit.
--
-- security_invoker: false
--   DEFINER: this view runs as its OWNER and is NOT subject to the base
--   tables' RLS. Anything granted SELECT here reads past that protection.
-- base_tables_with_rls: (none)
-- base_tables_without_rls: (none)
-- select_granted_to: anon, authenticated, service_role
--

create or replace view public.contact_fk_catalogue as
 SELECT tc.table_name,
    kcu.column_name AS fk_column,
    ( SELECT a.attname
           FROM pg_constraint c
             JOIN LATERAL unnest(c.conkey) k(attnum) ON true
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          WHERE c.conrelid = ('public.'::text || tc.table_name::text)::regclass::oid AND c.contype = 'p'::"char"
         LIMIT 1) AS pk_column
   FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu ON kcu.constraint_name::name = tc.constraint_name::name
     JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name::name = tc.constraint_name::name
  WHERE tc.constraint_type::text = 'FOREIGN KEY'::text AND ccu.table_name::name = 'contacts'::name AND ccu.column_name::name = 'id'::name AND tc.table_name::name <> 'contacts'::name;

-- Expresso — post-flight verification for 20261017120000_auth_profiles_rls.sql
--
-- Run each statement in the Supabase Dashboard -> SQL Editor AFTER applying the
-- migration. All are read-only.

-- 1. The authorized admin must be RETAILER_ADMIN and active.
select id, role, is_active from public.profiles
 where id = 'bdd8f73c-fd23-4d76-9d23-7f4942300c36';

-- 2. The catalogue row count must equal the pre-migration count.
select count(*) as package_count from public.packages;

-- 3. Exactly the intended policies (plus packages_anon_no_select if the anon-fix
--    was re-applied afterwards).
select policyname from pg_policies
 where schemaname = 'public' and tablename in ('profiles','packages')
 order by policyname;

-- 4. The client may update only these three columns.
select column_name from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'profiles'
   and grantee = 'authenticated' and privilege_type = 'UPDATE'
 order by column_name;

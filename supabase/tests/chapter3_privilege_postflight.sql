-- Expresso Chapter 3: manual preflight/postflight checks
-- Run only on a disposable isolated test database after applying the candidate.
-- These checks are read-only.

-- 1) Confirm schema/table row counts were not changed by privilege migration.
select 'profiles' as table_name, count(*) as row_count from public.profiles
union all
select 'packages', count(*) from public.packages
union all
select 'bundle_allocations', count(*) from public.bundle_allocations;

-- 2) Client roles must not be able to TRUNCATE protected tables.
select r.rolname, c.relname,
       has_table_privilege(r.rolname, c.oid, 'TRUNCATE') as can_truncate
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join pg_roles r
where n.nspname = 'public'
  and c.relname in ('profiles', 'packages', 'bundle_allocations')
  and r.rolname in ('anon', 'authenticated')
order by c.relname, r.rolname;

-- 3) Inspect active package SELECT policies.
select policyname, roles, cmd, qual
from pg_policies
where schemaname = 'public' and tablename = 'packages'
order by policyname;

-- 4) Inspect relevant table grants.
select table_name, grantee, privilege_type
from information_schema.table_privileges
where table_schema = 'public'
  and table_name in ('profiles', 'packages', 'bundle_allocations')
  and grantee in ('anon', 'authenticated', 'PUBLIC')
order by table_name, grantee, privilege_type;

-- Expresso — pre-flight checks for 20261017120000_auth_profiles_rls.sql
--
-- Run this in the Supabase Dashboard -> SQL Editor BEFORE applying the migration.
-- It is read-only. It prints one row per check.
--
-- Do not run the migration unless steps 1, 3, 4 and 5 all say PASS.

with admin as (
  select 'bdd8f73c-fd23-4d76-9d23-7f4942300c36'::uuid as id
)
select '1. admin account exists in auth.users' as step,
       case when exists (select 1 from auth.users u join admin a on u.id = a.id)
            then 'PASS' else 'FAIL - check the UUID' end as result
union all
select '2. admin profile role',
       coalesce((select case when p.role = 'RETAILER_ADMIN' then 'PASS'
                             else 'FAIL - role is ' || p.role end
                 from public.profiles p join admin a on p.id = a.id),
                'FAIL - no profiles row yet (will be created)')
union all
select '3. admin is_active',
       coalesce((select case when p.is_active then 'PASS'
                             else 'FAIL - false locks the admin out' end
                 from public.profiles p join admin a on p.id = a.id),
                'FAIL - no profiles row yet (will be created)')
union all
select '4. profiles.id is unique',
       case when exists (
              select 1 from pg_index i
              join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
              where i.indrelid = 'public.profiles'::regclass
                and i.indisunique and i.indnatts = 1 and a.attname = 'id')
            then 'PASS' else 'FAIL - run: ALTER TABLE public.profiles ADD PRIMARY KEY (id);' end
union all
select '5. catalogue authored only by the admin',
       case when exists (select 1 from public.packages p join admin a on true
                         where p.created_by is not null and p.created_by <> a.id)
            then 'FAIL - another account authored a bundle' else 'PASS' end
union all
select '6. role values inside the domain',
       case when exists (select 1 from public.profiles
                         where role is null or role not in ('CUSTOMER','RETAILER_ADMIN'))
            then 'NOTE - odd values are normalised to CUSTOMER' else 'PASS' end
order by step;

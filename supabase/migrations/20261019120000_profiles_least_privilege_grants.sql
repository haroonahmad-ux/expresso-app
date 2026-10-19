-- Expresso — corrective grants-only migration for public.profiles
-- ---------------------------------------------------------------------------
-- Purpose: converge public.profiles to least privilege on a database whose live
-- grants are still the legacy broad set, WITHOUT touching schema, policies,
-- data or the authorized retailer-admin account.
--
-- Scope: privileges on public.profiles only. Nothing else is changed.
--
-- Why a standalone corrective exists: the full migration
-- (20261017120000_auth_profiles_rls.sql) already performs this revoke/grant in
-- its section 7, and it converges to exactly the same state. This file exists
-- for the case where you want the least-privilege grants fixed on their own,
-- independently of the rest of that migration.
--
-- Safe to run repeatedly.

begin;

-- 1. Drop every privilege the client roles and PUBLIC hold on the table.
--    Column-level grants are included: REVOKE ALL ON TABLE clears the column
--    ACLs as well (verified on PostgreSQL 15 and 17).
revoke all on public.profiles from public, anon, authenticated;

-- 2. Re-grant the minimum the application needs.
grant select on public.profiles to authenticated;

-- 3. Column-scoped UPDATE. `role`, `is_active`, `email`, `id` and `created_at`
--    are deliberately absent, so a client can never change them.
--    `phone` is added by the full migration; on a database that has not run it
--    yet the column does not exist, so grant it only when present instead of
--    failing.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'phone'
  ) then
    grant update (full_name, msisdn, phone) on public.profiles to authenticated;
  else
    grant update (full_name, msisdn) on public.profiles to authenticated;
  end if;
end $$;

-- 4. Assert the outcome. Any leftover broad grant aborts the transaction rather
--    than leaving a silently permissive state.
do $$
declare
  v_bad text;
begin
  select string_agg(distinct grantee, ', ') into v_bad
  from information_schema.table_privileges
  where table_schema = 'public'
    and table_name = 'profiles'
    and privilege_type = 'UPDATE'
    and grantee in ('authenticated', 'anon', 'PUBLIC');

  if v_bad is not null then
    raise exception
      'Expresso corrective: table-level UPDATE on public.profiles still held by %', v_bad;
  end if;

  select string_agg(distinct column_name, ', ' order by column_name) into v_bad
  from information_schema.column_privileges
  where table_schema = 'public'
    and table_name = 'profiles'
    and privilege_type = 'UPDATE'
    and grantee = 'authenticated'
    and column_name not in ('full_name', 'msisdn', 'phone');

  if v_bad is not null then
    raise exception
      'Expresso corrective: authenticated can still update protected column(s): %', v_bad;
  end if;

  select string_agg(distinct privilege_type, ', ') into v_bad
  from information_schema.table_privileges
  where table_schema = 'public'
    and table_name = 'profiles'
    and grantee in ('anon', 'PUBLIC');

  if v_bad is not null then
    raise exception
      'Expresso corrective: anon/PUBLIC still hold privileges on public.profiles: %', v_bad;
  end if;
end $$;

commit;

-- Expresso — close C-1: anonymous SELECT on public.packages
-- ---------------------------------------------------------------------------
-- Smallest correct fix for the live finding: an anonymous caller can read
-- public.packages (HTTP 200, 5 rows) because the table is still exposed to the
-- `anon` role. The owner decision (Chapter 2, Q-8) is authenticated-only.
--
-- Additive, idempotent and data-preserving: it creates no table, drops no
-- column, and changes no row. It is a no-op if the base migration
-- 20261017120000_auth_profiles_rls.sql has already removed anonymous access,
-- and it is safe to apply on its own if that migration has not been applied.
--
-- Apply with the Supabase SQL editor or:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/20261018120000_packages_anon_select_fix.sql

begin;

-- 0. Policies only take effect while RLS is enabled on the table. Assert it
--    here so this migration cannot silently do nothing.
alter table public.packages enable row level security;
alter table public.profiles enable row level security;

-- 1. Remove every anonymous privilege on the catalogue and profile tables.
--    This is the change that actually denies the read: a role without the
--    SELECT privilege cannot read the table regardless of its policies.
revoke all on public.packages from anon, public;
revoke all on public.profiles from anon, public;

-- 2. Explicit deny for anonymous readers. RLS policies are OR-ed, so a
--    surviving legacy `for select to anon using (true)` policy would re-expose
--    the table; an explicit `using (false)` policy documents the intent and
--    makes the denial visible in pg_policies. The hard REVOKE in step 1 is
--    what guarantees it, because a permissive policy can never remove rows.
drop policy if exists packages_anon_no_select on public.packages;
create policy packages_anon_no_select on public.packages
  for select to anon
  using (false);

-- 3. Post-conditions: fail loudly rather than report a silent success.
do $$
declare
  v_bad text;
begin
  select string_agg(distinct privilege_type, ', ') into v_bad
  from information_schema.table_privileges
  where table_schema = 'public'
    and table_name in ('packages', 'profiles')
    and grantee in ('anon', 'PUBLIC');

  if v_bad is not null then
    raise exception
      'Expresso migration: anon/PUBLIC still hold privileges on packages/profiles: %', v_bad;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'packages'
      and policyname = 'packages_anon_no_select'
  ) then
    raise exception 'Expresso migration: packages_anon_no_select policy was not created';
  end if;
end $$;

commit;

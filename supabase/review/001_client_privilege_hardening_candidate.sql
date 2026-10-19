-- Expresso Chapter 3: client privilege hardening candidate
-- REVIEW STATUS: NOT APPLIED TO ANY DATABASE.
-- Must be tested against an isolated database matching the current live schema.
-- Does not modify customer records, roles, or bundle allocation rows.

begin;

-- RLS does not restrict TRUNCATE; remove it from client roles.
revoke truncate on table public.profiles from anon, authenticated;
revoke truncate on table public.packages from anon, authenticated;
revoke truncate on table public.bundle_allocations from anon, authenticated;

-- Remove broad/contradictory package visibility policy.
drop policy if exists "Anyone can view packages" on public.packages;
drop policy if exists packages_select_authenticated on public.packages;
drop policy if exists packages_anon_no_select on public.packages;

-- Public/anonymous clients receive no table privileges on package catalogue.
revoke all privileges on table public.packages from anon, public;

-- Authenticated users can read enabled packages; retailer admin may also
-- inspect disabled packages. Existing admin write policy is left untouched.
create policy packages_select_authenticated
  on public.packages
  for select
  to authenticated
  using (is_enabled = true or public.is_retailer_admin());

-- Defensive assertions. A failure aborts the transaction.
do $$
begin
  if has_table_privilege('anon', 'public.packages', 'SELECT') then
    raise exception 'anon still has SELECT privilege on public.packages';
  end if;
  if has_table_privilege('anon', 'public.profiles', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE')
     or has_table_privilege('anon', 'public.packages', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.packages', 'TRUNCATE')
     or has_table_privilege('anon', 'public.bundle_allocations', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.bundle_allocations', 'TRUNCATE') then
    raise exception 'Client TRUNCATE privilege remains on protected table';
  end if;
end $$;

commit;

-- Expresso — Supabase Auth, profiles and Row Level Security
-- ---------------------------------------------------------------------------
-- Idempotent and additive: safe to run more than once and never drops data
-- (only policies, which are recreated, and grants, which are re-issued).
--
-- Apply with the Supabase SQL editor or:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/20261017120000_auth_profiles_rls.sql
--
-- Roles are owned by the database. The client can never choose or escalate a
-- role: signup always lands on CUSTOMER, and only a privileged (service role /
-- SQL) actor can promote an account to RETAILER_ADMIN.
--
-- This migration is defensive: it assumes the target project may already have
-- legacy permissive policies and broad table-level grants, and it removes both
-- before installing the least-privilege configuration. See sections 5 and 7.

begin;

-- ---------------------------------------------------------------------------
-- 0. Guard rails
-- ---------------------------------------------------------------------------
-- Every object below lives in the `public` schema. Resolve it explicitly so the
-- migration cannot be redirected by a caller-controlled search_path.
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'public') then
    raise exception 'Expresso migration: schema "public" not found';
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'auth') then
    raise exception
      'Expresso migration: Supabase auth schema not found; run this against the '
      'Supabase database (the auth.users trigger cannot be installed otherwise)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. profiles — additive shape only (never drops or rewrites existing columns)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'CUSTOMER',
  full_name text,
  msisdn text,
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists full_name  text;
alter table public.profiles add column if not exists msisdn     text;
alter table public.profiles add column if not exists role       text;
alter table public.profiles add column if not exists created_at timestamptz not null default now();
alter table public.profiles add column if not exists updated_at timestamptz not null default now();
alter table public.profiles add column if not exists email      text;
alter table public.profiles add column if not exists is_active  boolean not null default true;
-- phone is groundwork for the phone-OTP identity design (Chapter 2, section 3).
-- It is additive and nullable, so existing rows are untouched.
alter table public.profiles add column if not exists phone      text;
-- Allow missing optional contact details in existing profiles.
alter table public.profiles
  alter column full_name DROP NOT NULL,
  alter column msisdn DROP NOT NULL;

-- Normalise any legacy/invalid role values before locking the domain down.
update public.profiles set role = 'CUSTOMER'
  where role is null or role not in ('CUSTOMER', 'RETAILER_ADMIN');

alter table public.profiles alter column role set default 'CUSTOMER';
alter table public.profiles alter column role set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_role_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_role_check
      check (role in ('CUSTOMER', 'RETAILER_ADMIN'));
  end if;
end $$;

create index if not exists profiles_role_idx on public.profiles (role);

-- ---------------------------------------------------------------------------
-- 1b. packages — existing catalogue. Created only if absent; columns are added
--     additively so live data is never rewritten.
-- ---------------------------------------------------------------------------
create table if not exists public.packages (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null default 'DAILY',
  validity_days integer not null default 1,
  price_pkr numeric not null default 0,
  data_mb integer not null default 0,
  minutes integer not null default 0,
  sms_count integer not null default 0,
  is_enabled boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table public.packages add column if not exists title         text;
alter table public.packages add column if not exists category      text not null default 'DAILY';
alter table public.packages add column if not exists validity_days integer not null default 1;
alter table public.packages add column if not exists price_pkr     numeric not null default 0;
alter table public.packages add column if not exists data_mb       integer not null default 0;
alter table public.packages add column if not exists minutes       integer not null default 0;
alter table public.packages add column if not exists sms_count     integer not null default 0;
alter table public.packages add column if not exists is_enabled    boolean not null default true;
alter table public.packages add column if not exists created_by    uuid;
alter table public.packages add column if not exists created_at    timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- 2. helper: keep updated_at fresh.
--    SECURITY INVOKER on purpose — it only touches the row being written, so it
--    needs no elevated rights and must not become a privilege boundary.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.set_updated_at() from public;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Independent barrier for the authorization fields. The column grants in
-- section 7 already omit role/is_active/email, so a client cannot write them;
-- this trigger is a second, grant-independent line of defence, in case a future
-- migration or dashboard action reintroduces a table-level UPDATE grant.
-- SECURITY INVOKER on purpose: current_user must reflect the *calling* role, so
-- a client role is rejected while the privileged migration/service role is not.
create or replace function public.guard_profile_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.role is distinct from old.role
     or new.is_active is distinct from old.is_active
     or new.email is distinct from old.email then
    if current_user in ('anon', 'authenticated', 'authenticator') then
      raise exception
        'Expresso: role, is_active and email are server-managed on public.profiles';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_profile_role() from public;

drop trigger if exists profiles_guard_role on public.profiles;
create trigger profiles_guard_role
  before update on public.profiles
  for each row execute function public.guard_profile_role();

-- ---------------------------------------------------------------------------
-- 3. new auth users get a CUSTOMER profile automatically.
--    raw_user_meta_data is user-controlled, so the role is hard-coded and any
--    client-supplied role/meta is ignored.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, role, full_name, msisdn, email, phone)
  values (
    new.id,
    'CUSTOMER',
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'msisdn', ''),
    new.email,
    new.phone
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Trigger EXECUTE is checked when the trigger is created, not when it fires, so
-- revoking it from PUBLIC does not break signup.
revoke all on function public.handle_new_user() from public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 4. backfill profiles for auth users that predate the trigger (additive).
-- ---------------------------------------------------------------------------
insert into public.profiles (id, role, full_name, email)
select
  u.id,
  'CUSTOMER',
  nullif(u.raw_user_meta_data ->> 'full_name', ''),
  u.email
from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 5. role helper — SECURITY DEFINER so it can read profiles without tripping
--    the profiles RLS policy (avoids recursive policy evaluation).
-- ---------------------------------------------------------------------------
create or replace function public.is_retailer_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'RETAILER_ADMIN'
      and coalesce(p.is_active, true)
  );
$$;

-- SECURITY DEFINER functions owned by a client role would let any client
-- escalate by redefining them. Assert the definers are privileged roles.
do $$
declare
  v_bad text;
begin
  select string_agg(format('%s owned by %s', proname, pg_get_userbyid(proowner)), ', ')
    into v_bad
  from pg_proc
  where pronamespace = 'public'::regnamespace
    and proname in ('is_retailer_admin', 'handle_new_user')
    and pg_get_userbyid(proowner) in ('anon', 'authenticated', 'authenticator');

  if v_bad is not null then
    raise exception
      'Expresso migration: SECURITY DEFINER function owned by a client role: %', v_bad;
  end if;

  if (select count(*) from pg_proc
      where pronamespace = 'public'::regnamespace
        and proname = 'is_retailer_admin') = 0 then
    raise exception 'Expresso migration: public.is_retailer_admin() was not created';
  end if;
end $$;

revoke all on function public.is_retailer_admin() from public;
grant execute on function public.is_retailer_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.packages enable row level security;

-- Remove EVERY policy on these tables, including legacy permissive ones created
-- outside this migration. RLS policies are OR-ed, so a single surviving
-- `using (true)` policy would silently defeat all of the policies below.
do $$
declare
  pol record;
begin
  for pol in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('profiles', 'packages')
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      pol.policyname, pol.schemaname, pol.tablename
    );
  end loop;
end $$;

-- profiles: a user reads only their own row; retailer admins read every row.
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_retailer_admin());

-- profiles: a user edits only their own row. The column grants in section 7
-- make role, is_active and email non-writable from the client, so a client
-- cannot self-promote even though the row itself is updatable.
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- packages: everyone signed in can read enabled bundles; admins read all.
create policy packages_select_authenticated on public.packages
  for select to authenticated
  using (is_enabled or public.is_retailer_admin());

-- packages: only retailer admins may create, edit or remove bundles.
create policy packages_admin_write on public.packages
  for all to authenticated
  using (public.is_retailer_admin())
  with check (public.is_retailer_admin());

-- ---------------------------------------------------------------------------
-- 7. Table privileges — least privilege.
--    `revoke all` first: column-level GRANTs are additive, so without this a
--    pre-existing table-level UPDATE would keep role/is_active/email writable.
-- ---------------------------------------------------------------------------
revoke all on public.profiles from public, anon, authenticated;
revoke all on public.packages from public, anon, authenticated;

grant select on public.profiles to authenticated;
-- Column-scoped update: role/is_active/email are deliberately absent, so the
-- client can never change them.
grant update (full_name, msisdn, phone) on public.profiles to authenticated;

grant select, insert, update, delete on public.packages to authenticated;

-- Post-conditions: fail loudly if the hardening above did not take effect.
do $$
declare
  v_bad text;
begin
  -- No table-level UPDATE may remain for a client role.
  select string_agg(distinct grantee, ', ') into v_bad
  from information_schema.table_privileges
  where table_schema = 'public'
    and table_name = 'profiles'
    and privilege_type = 'UPDATE'
    and grantee in ('authenticated', 'anon', 'PUBLIC');

  if v_bad is not null then
    raise exception
      'Expresso migration: table-level UPDATE on public.profiles still held by %', v_bad;
  end if;

  -- Only full_name and msisdn may be updatable by authenticated.
  select string_agg(distinct column_name, ', ' order by column_name) into v_bad
  from information_schema.column_privileges
  where table_schema = 'public'
    and table_name = 'profiles'
    and privilege_type = 'UPDATE'
    and grantee = 'authenticated'
    and column_name not in ('full_name', 'msisdn', 'phone');

  if v_bad is not null then
    raise exception
      'Expresso migration: authenticated can still update protected profile column(s): %', v_bad;
  end if;

  -- anon must hold nothing on either table.
  select string_agg(distinct table_name || '.' || privilege_type, ', ') into v_bad
  from information_schema.table_privileges
  where table_schema = 'public'
    and table_name in ('profiles', 'packages')
    and grantee in ('anon', 'PUBLIC');

  if v_bad is not null then
    raise exception
      'Expresso migration: anon/PUBLIC still hold privileges: %', v_bad;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Preserve the authorized retailer-admin account.
--    The account is verified before promotion: it must exist in auth.users and
--    it must be the sole author of the existing bundle catalogue. If it cannot
--    be verified the migration fails safely instead of promoting a wrong or
--    non-existent identity. Override the expected id with:
--      select set_config('expresso.retailer_admin_id', '<uuid>', true);
-- ---------------------------------------------------------------------------
do $$
declare
  v_default_admin uuid := 'bdd8f73c-fd23-4d76-9d23-7f4942300c36';
  v_admin uuid;
  v_authors int;
  v_other_author int;
  v_exists boolean;
begin
  v_admin := coalesce(
    nullif(current_setting('expresso.retailer_admin_id', true), '')::uuid,
    v_default_admin
  );

  select exists (select 1 from auth.users u where u.id = v_admin) into v_exists;
  if not v_exists then
    raise exception
      'Expresso migration: authorized retailer-admin % has no auth.users row. '
      'Verify the account (see README) or set expresso.retailer_admin_id. '
      'Refusing to promote an unverified identity.', v_admin;
  end if;

  -- Evidence check: the authorized account must own the catalogue and no other
  -- account may have authored a bundle. An empty catalogue (fresh project) is
  -- allowed; a catalogue authored by someone else is not.
  select count(distinct created_by) into v_authors
  from public.packages where created_by is not null;

  select count(distinct created_by) into v_other_author
  from public.packages where created_by is not null and created_by <> v_admin;

  if v_other_author > 0 then
    raise exception
      'Expresso migration: public.packages contains bundles authored by accounts '
      'other than the expected retailer-admin %. Refusing to guess the admin '
      'identity; verify the account and set expresso.retailer_admin_id.',
      v_admin;
  end if;

  if v_authors = 0 then
    raise warning
      'Expresso migration: public.packages is empty, so the retailer-admin id % '
      'could not be corroborated by catalogue authorship. Promoting on the '
      'strength of the configured id only.', v_admin;
  end if;

  insert into public.profiles (id, role, full_name)
  values (v_admin, 'RETAILER_ADMIN', 'Authorized Retailer Admin')
  on conflict (id) do update set role = 'RETAILER_ADMIN';
end $$;

-- ---------------------------------------------------------------------------
-- 9. Final verification — the policies we intend to exist, exist.
-- ---------------------------------------------------------------------------
do $$
declare
  v_missing text;
begin
  select string_agg(need, ', ') into v_missing
  from (
    values ('profiles_select_own'), ('profiles_update_own'),
           ('packages_select_authenticated'), ('packages_admin_write')
  ) as required(need)
  where not exists (
    select 1 from pg_policies
    where schemaname = 'public' and policyname = required.need
  );

  if v_missing is not null then
    raise exception 'Expresso migration: expected policy/policies missing: %', v_missing;
  end if;
end $$;

commit;

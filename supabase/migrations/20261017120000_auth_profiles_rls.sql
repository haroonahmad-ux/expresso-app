-- Expresso — Supabase Auth, profiles and Row Level Security
-- ---------------------------------------------------------------------------
-- Idempotent and additive: safe to run more than once and never drops data.
-- Apply with the Supabase SQL editor or:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/20261017120000_auth_profiles_rls.sql
--
-- Roles are owned by the database. The client can never choose or escalate a
-- role: signup always lands on CUSTOMER, and only a privileged (service role /
-- SQL) actor can promote an account to RETAILER_ADMIN.

begin;

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
-- 2. keep updated_at fresh
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. new auth users get a CUSTOMER profile automatically.
--    raw_user_meta_data is user-controlled, so the role is hard-coded and any
--    client-supplied role/meta is ignored.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, role, full_name, msisdn, email)
  values (
    new.id,
    'CUSTOMER',
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'msisdn', ''),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

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
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'RETAILER_ADMIN'
      and coalesce(p.is_active, true)
  );
$$;

revoke all on function public.is_retailer_admin() from public;
grant execute on function public.is_retailer_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.packages enable row level security;

-- profiles: a user reads only their own row; retailer admins read every row.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_retailer_admin());

-- profiles: a user edits only their own row. Column grants below make role,
-- is_active and email non-writable from the client, so self-promotion fails.
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- packages: everyone signed in can read enabled bundles; admins read all.
drop policy if exists packages_select_authenticated on public.packages;
create policy packages_select_authenticated on public.packages
  for select to authenticated
  using (is_enabled or public.is_retailer_admin());

-- packages: only retailer admins may create, edit or remove bundles.
drop policy if exists packages_admin_write on public.packages;
create policy packages_admin_write on public.packages
  for all to authenticated
  using (public.is_retailer_admin())
  with check (public.is_retailer_admin());

-- ---------------------------------------------------------------------------
-- 7. Table privileges (least privilege; anon has no access to either table)
-- ---------------------------------------------------------------------------
revoke all on public.profiles from anon;
revoke all on public.packages from anon;

grant select on public.profiles to authenticated;
-- Column-scoped update: role/is_active/email can never be changed by a client.
grant update (full_name, msisdn) on public.profiles to authenticated;

grant select, insert, update, delete on public.packages to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Preserve the authorized retailer-admin account.
--    Single-row, idempotent promotion of the account that seeded the bundle
--    catalogue. No client-side PIN is involved.
-- ---------------------------------------------------------------------------
do $$
declare
  v_admin uuid := 'bdd8f73c-fd23-4d76-9d23-7f4942300c36';
begin
  if exists (select 1 from auth.users u where u.id = v_admin) then
    insert into public.profiles (id, role, full_name)
    values (v_admin, 'RETAILER_ADMIN', 'Authorized Retailer Admin')
    on conflict (id) do update set role = 'RETAILER_ADMIN';
  end if;
end $$;

commit;

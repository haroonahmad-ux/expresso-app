// Live-schema compatibility for the Chapter 2 auth/RLS migration.
//
// The live project differs from the harness in ways that matter: profiles.id is
// assumed unique, full_name/msisdn are NOT NULL, the authorized retailer-admin
// already exists and is already RETAILER_ADMIN, and the packages anon-fix may
// already be applied. This suite replays those exact conditions against a real
// Postgres engine (PGlite) and asserts the migration is safe.
//
//   node tests/migration-live-schema.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRunner } from './helpers/runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, '..', 'supabase', 'migrations', f), 'utf8');
const BASE = read('20261017120000_auth_profiles_rls.sql');
const FIX = read('20261018120000_packages_anon_select_fix.sql');

const ADMIN_ID = 'bdd8f73c-fd23-4d76-9d23-7f4942300c36';
const CUST_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_ID = 'aaaaaaaa-0000-0000-0000-0000000000ff';

const { check, report } = createRunner('Migration compatibility with the live schema');

const SHIM = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key, email text unique, phone text unique,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
grant usage on schema public, auth to anon, authenticated;
grant select on auth.users to authenticated;
`;

// profiles.id uuid PRIMARY KEY, full_name/msisdn NOT NULL — as reported live.
const LIVE_SCHEMA = `
create table public.profiles (
  id uuid primary key,
  role text not null default 'CUSTOMER',
  full_name text not null,
  msisdn text not null,
  created_at timestamptz not null default now(),
  email text,
  is_active boolean not null default true,
  updated_at timestamptz default now()
);
create table public.packages (
  id uuid primary key default gen_random_uuid(),
  title text not null, category text default 'DAILY', validity_days integer default 1,
  price_pkr numeric default 0, data_mb integer default 0, minutes integer default 0,
  sms_count integer default 0, is_enabled boolean default true, created_by uuid,
  created_at timestamptz default now()
);
alter table public.profiles enable row level security;
alter table public.packages enable row level security;
create policy "Enable read access for all users" on public.packages for select using (true);
grant select on public.packages to anon;
grant select, insert, update, delete on public.packages to authenticated;
grant all on public.profiles to authenticated;
`;

const TITLES = [
  'Social WhatsApp & YT', 'Weekly Mega Pro', 'Weekly Voice Plus',
  'Monthly Supreme 40GB', 'Daily Super Internet',
];

async function liveProject({ adminRole = 'RETAILER_ADMIN', adminActive = true, adminProfile = true } = {}) {
  const db = new PGlite();
  await db.exec(SHIM);
  await db.exec(LIVE_SCHEMA);
  await db.exec(`insert into auth.users (id, email) values ('${ADMIN_ID}', 'admin@expresso.pk');`);
  await db.exec(`insert into auth.users (id, email) values ('${CUST_ID}', 'cust@example.com');`);
  if (adminProfile) {
    await db.exec(
      `insert into public.profiles (id, role, full_name, msisdn, is_active)
       values ('${ADMIN_ID}', '${adminRole}', 'Authorized Retailer Admin', '+923001234567', ${adminActive});`
    );
  }
  await db.exec(
    `insert into public.profiles (id, role, full_name, msisdn)
     values ('${CUST_ID}', 'CUSTOMER', 'Hamza', '+923009876543');`
  );
  for (const t of TITLES) {
    await db.exec(
      `insert into public.packages (title, category, price_pkr, is_enabled, created_by)
       values ('${t}', 'DAILY', 65, true, '${ADMIN_ID}');`
    );
  }
  return db;
}

async function asRole(db, role, uid, fn) {
  await db.exec(`set role ${role};`);
  await db.exec(`select set_config('request.jwt.claim.role', '${role}', false);`);
  await db.exec(`select set_config('request.jwt.claim.sub', ${uid ? `'${uid}'` : `''`}, false);`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}

async function apply(db, sql) {
  try { await db.exec(sql); return null; } catch (e) { return e; }
}

console.log('1. Migration applies over the live-shaped schema, twice');
{
  const db = await liveProject();
  const first = await apply(db, BASE);
  check('base migration applies over the live schema', first === null, first?.message);
  const second = await apply(db, BASE);
  check('base migration is idempotent', second === null, second?.message);

  const admin = (await db.query(
    `select role, full_name, msisdn, is_active from public.profiles where id='${ADMIN_ID}';`
  )).rows[0];
  check('authorized admin keeps RETAILER_ADMIN', admin?.role === 'RETAILER_ADMIN', JSON.stringify(admin));
  check('admin contact fields are preserved', admin?.full_name === 'Authorized Retailer Admin' && admin?.msisdn === '+923001234567', JSON.stringify(admin));
  check('admin is_active is preserved', admin?.is_active === true, String(admin?.is_active));
  check('all five bundles are preserved', (await db.query(`select count(*)::int n from public.packages;`)).rows[0].n === 5);
  check('customer row is untouched', (await db.query(`select full_name from public.profiles where id='${CUST_ID}';`)).rows[0].full_name === 'Hamza');

  const notNull = (await db.query(
    `select is_nullable from information_schema.columns
     where table_schema='public' and table_name='profiles' and column_name in ('full_name','msisdn')
     order by column_name;`
  )).rows.map((r) => r.is_nullable);
  check('full_name and msisdn are now nullable', notNull.every((v) => v === 'YES'), notNull.join(','));
  await db.close();
}

console.log('\n2. Admin profile missing, contact columns NOT NULL');
{
  const db = await liveProject({ adminProfile: false });
  const err = await apply(db, BASE);
  check('migration succeeds when the admin profile row is absent', err === null, err?.message);
  const admin = (await db.query(
    `select role, full_name, msisdn, is_active from public.profiles where id='${ADMIN_ID}';`
  )).rows[0];
  check('missing admin is created as RETAILER_ADMIN', admin?.role === 'RETAILER_ADMIN', JSON.stringify(admin));
  check('created admin has null contact fields', admin?.full_name === null && admin?.msisdn === null, JSON.stringify(admin));
  check('created admin is active', admin?.is_active === true, String(admin?.is_active));
  await db.close();
}

console.log('\n3. is_active=false admin is reported, not silently locked out');
{
  const db = await liveProject({ adminActive: false });
  const err = await apply(db, BASE);
  check('migration still applies when the admin is deactivated', err === null, err?.message);
  const isAdmin = await asRole(db, 'authenticated', ADMIN_ID, async () =>
    (await db.query('select public.is_retailer_admin() as a;')).rows[0].a
  );
  check('a deactivated admin is not an admin (documented behaviour)', isAdmin === false, String(isAdmin));
  await db.close();
}

console.log('\n4. Deployment order: anon-fix already applied, then base');
{
  const db = await liveProject();
  check('anon-fix applies first', (await apply(db, FIX)) === null);
  check('base applies after the anon-fix', (await apply(db, BASE)) === null);
  const anonRows = await asRole(db, 'anon', null, async () => {
    try { return (await db.query('select count(*)::int n from public.packages;')).rows[0].n; }
    catch { return 'denied'; }
  });
  check('anon still cannot read packages after base', anonRows === 'denied' || anonRows === 0, String(anonRows));
  const admin = (await db.query(`select role from public.profiles where id='${ADMIN_ID}';`)).rows[0];
  check('admin still promoted after the anon-fix ran first', admin?.role === 'RETAILER_ADMIN', admin?.role);
  check('anon-fix can be re-applied after base', (await apply(db, FIX)) === null);
  await db.close();
}

console.log('\n5. profiles.id must be unique (actionable failure)');
{
  const db = new PGlite();
  await db.exec(SHIM);
  await db.exec(`
    create table public.profiles (id uuid, role text default 'CUSTOMER', full_name text,
      msisdn text, created_at timestamptz default now(), email text,
      is_active boolean default true, updated_at timestamptz default now());
    create table public.packages (id uuid primary key default gen_random_uuid(), title text,
      category text, price_pkr numeric, is_enabled boolean, created_by uuid,
      created_at timestamptz default now());
    alter table public.profiles enable row level security;
    alter table public.packages enable row level security;
  `);
  await db.exec(`insert into auth.users (id, email) values ('${ADMIN_ID}', 'admin@expresso.pk');`);
  const err = await apply(db, BASE);
  check('migration fails when profiles.id has no unique constraint', err !== null);
  check(
    'the failure names the missing primary key',
    !!err && /PRIMARY KEY|UNIQUE constraint/.test(err.message),
    err?.message?.slice(0, 90)
  );
  await db.close();
}

console.log('\n6. Role domain is guaranteed, not assumed');
{
  const db = await liveProject();
  await db.exec('alter table public.profiles drop constraint if exists profiles_role_check;');
  await db.exec(`alter table public.profiles add constraint profiles_role_check
    check (role in ('CUSTOMER','RETAILER_ADMIN','SUPER_ADMIN','VENDOR'));`);
  check('a wider legacy role constraint is replaced', (await apply(db, BASE)) === null);
  const def = (await db.query(
    `select pg_get_constraintdef(oid) as def from pg_constraint
     where conname='profiles_role_check' and conrelid='public.profiles'::regclass;`
  )).rows[0]?.def || '';
  check('the role constraint now admits only the two real roles',
    /CUSTOMER/.test(def) && /RETAILER_ADMIN/.test(def) && !/SUPER_ADMIN/.test(def), def);
  const bad = await apply(db, `insert into public.profiles (id, role) values ('${OTHER_ID}','SUPER_ADMIN');`);
  check('an unknown role is rejected', bad !== null);
  await db.close();
}

console.log('\n7. A catalogue authored by someone else is refused');
{
  const db = await liveProject();
  await db.exec(`insert into auth.users (id, email) values ('${OTHER_ID}', 'other@example.com');`);
  await db.exec(`update public.packages set created_by='${OTHER_ID}' where title='Weekly Mega Pro';`);
  const err = await apply(db, BASE);
  check('migration fails safely on foreign catalogue authorship', err !== null);
  check('the failure is explicit about authorship', !!err && /authored by accounts other than/.test(err.message), err?.message?.slice(0, 90));
  await db.close();
}

process.exit(report());

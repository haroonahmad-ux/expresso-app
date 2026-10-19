// Regression test for C-1: anonymous SELECT on public.packages.
//
// Runs the focused fix migration against a real Postgres engine (PGlite) in the
// state the live project is actually in — anon holds a table-level SELECT grant
// and a permissive policy — and proves the migration removes anonymous access
// without disturbing authenticated readers or existing rows.
//
//   node tests/packages-anon-select.test.mjs
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
const CUSTOMER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

const { check, report } = createRunner('C-1 regression: anonymous SELECT on public.packages');

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
create role anon nologin;
create role authenticated nologin;
grant usage on schema public, auth to anon, authenticated;
grant select on auth.users to authenticated;
`;

// The live project as observed: RLS on, but a permissive policy and a table-level
// SELECT grant let anonymous callers read the catalogue.
const LIVE_STATE = `
create table public.profiles (
  id uuid primary key, role text not null default 'CUSTOMER', full_name text,
  msisdn text, created_at timestamptz not null default now(),
  email text, is_active boolean not null default true, updated_at timestamptz default now(),
  phone text
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
create policy "Enable read access for all users" on public.packages
  for select using (true);
grant select on public.packages to anon;
grant select, insert, update, delete on public.packages to authenticated;
`;

const db = new PGlite();

async function asRole(role, uid, fn) {
  await db.exec(`set role ${role};`);
  await db.exec(`select set_config('request.jwt.claim.role', '${role}', false);`);
  await db.exec(`select set_config('request.jwt.claim.sub', ${uid ? `'${uid}'` : `''`}, false);`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role;');
  }
}

// Returns { blocked, rows } — a denied read is either a privilege error or zero rows.
async function anonRead() {
  try {
    const r = await asRole('anon', null, () =>
      db.query('select id, title from public.packages;')
    );
    return { blocked: r.rows.length === 0, rows: r.rows.length };
  } catch (e) {
    return { blocked: true, rows: 0, error: e.message };
  }
}

console.log('Setup: live-shaped project (permissive policy + anon SELECT grant)');
await db.exec(SHIM);
await db.exec(LIVE_STATE);
await db.exec(`insert into auth.users (id, email) values ('${ADMIN_ID}', 'admin@expresso.pk');`);
await db.exec(`insert into auth.users (id, email) values ('${CUSTOMER_ID}', 'cust@example.com');`);
await db.exec(`insert into public.packages (title, category, price_pkr, is_enabled, created_by)
  values ('Daily Super Internet', 'DAILY', 65, true, '${ADMIN_ID}'),
         ('Weekly Mega Pro', 'WEEKLY', 350, true, '${ADMIN_ID}');`);

const before = await anonRead();
check(
  'precondition: anon CAN read public.packages before the fix (reproduces C-1)',
  !before.blocked,
  `rows=${before.rows}`
);

console.log('\nApply the fix migration');
await db.exec(FIX);
check('fix migration applies cleanly', true);

const after = await anonRead();
check(
  'anon can no longer read public.packages (C-1 closed)',
  after.blocked,
  `rows=${after.rows}${after.error ? ` error=${after.error}` : ''}`
);

check(
  'anon holds no privilege on public.packages',
  (await db.query(
    `select count(*)::int as n from information_schema.table_privileges
     where table_schema='public' and table_name='packages'
       and grantee in ('anon','PUBLIC');`
  )).rows[0].n === 0
);

check(
  'an explicit anon deny policy is present and visible',
  (await db.query(
    `select count(*)::int as n from pg_policies
     where schemaname='public' and tablename='packages'
       and policyname='packages_anon_no_select' and qual='false';`
  )).rows[0].n === 1
);

console.log('\nNo regression for authenticated readers');
const authRead = await asRole('authenticated', CUSTOMER_ID, () =>
  db.query('select id, title from public.packages;')
);
check(
  'authenticated user can still read the catalogue',
  authRead.rows.length === 2,
  `rows=${authRead.rows.length}`
);
check(
  'authenticated still holds SELECT on public.packages',
  (await db.query(
    `select count(*)::int as n from information_schema.table_privileges
     where table_schema='public' and table_name='packages'
       and grantee='authenticated' and privilege_type='SELECT';`
  )).rows[0].n === 1
);

console.log('\nData preservation and idempotency');
const rowCount = (await db.query('select count(*)::int as n from public.packages;')).rows[0].n;
check('existing package rows preserved', rowCount === 2, `n=${rowCount}`);
await db.exec(FIX);
check('fix migration is idempotent (re-apply is a no-op)', true);
check(
  'row count unchanged after re-apply',
  (await db.query('select count(*)::int as n from public.packages;')).rows[0].n === 2
);

console.log('\nComposition with the base migration');
const db2 = new PGlite();
await db2.exec(SHIM);
await db2.exec(LIVE_STATE);
await db2.exec(`insert into auth.users (id, email) values ('${ADMIN_ID}', 'admin@expresso.pk');`);
await db2.exec(`insert into public.packages (title, created_by) values ('P', '${ADMIN_ID}');`);
await db2.exec(BASE);
await db2.exec(FIX);
const composed = await db2.query(
  `select count(*)::int as n from information_schema.table_privileges
   where table_schema='public' and table_name='packages' and grantee in ('anon','PUBLIC');`
);
check('base migration then fix: anon still holds nothing', composed.rows[0].n === 0);
const policies = (await db2.query(
  `select count(*)::int as n from pg_policies where schemaname='public' and tablename='packages';`
)).rows[0].n;
check('base migration then fix: packages policies coexist', policies >= 3, `n=${policies}`);

// Reverse order: the base migration drops every policy on the table, including
// the explicit anon deny policy. The REVOKE must still hold on its own.
const db3 = new PGlite();
await db3.exec(SHIM);
await db3.exec(LIVE_STATE);
await db3.exec(`insert into auth.users (id, email) values ('${ADMIN_ID}', 'admin@expresso.pk');`);
await db3.exec(`insert into public.packages (title, created_by) values ('P', '${ADMIN_ID}');`);
await db3.exec(FIX);
await db3.exec(BASE);
check(
  'fix then base migration: anon still holds nothing',
  (await db3.query(
    `select count(*)::int as n from information_schema.table_privileges
     where table_schema='public' and table_name='packages' and grantee in ('anon','PUBLIC');`
  )).rows[0].n === 0
);
const anonAfter = await (async () => {
  await db3.exec('set role anon;');
  try {
    const r = await db3.query('select id from public.packages;');
    return r.rows.length;
  } catch {
    return 0;
  } finally {
    await db3.exec('reset role;');
  }
})();
check('fix then base migration: anon read still blocked', anonAfter === 0, `rows=${anonAfter}`);

process.exit(report());

// Live-grant diagnosis and corrective-migration coverage.
//
// Live findings showed authenticated holding a table-level UPDATE on
// public.profiles, with information_schema.column_privileges listing
// created_at, full_name, id, msisdn and role. This suite pins the cause and the
// fix, on the engine the harness uses.
//
//   node tests/profiles-grants.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRunner } from './helpers/runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, '..', 'supabase', 'migrations', f), 'utf8');
const FULL = read('20261017120000_auth_profiles_rls.sql');
const CORRECTIVE = read('20261019120000_profiles_least_privilege_grants.sql');

const ADMIN_ID = 'bdd8f73c-fd23-4d76-9d23-7f4942300c36';
const { check, report } = createRunner('public.profiles privileges: cause and corrective');

const SHIM = `
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
grant usage on schema public to anon, authenticated;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text unique, phone text unique,
  raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz not null default now());
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
`;

// The reported live shape: no is_active/email/phone/updated_at, NOT NULL contacts,
// table-level UPDATE plus a column-level UPDATE on five columns.
const LIVE = `
create table public.profiles (
  id uuid primary key,
  role text not null default 'CUSTOMER'
    constraint profiles_role_check check (role in ('CUSTOMER','RETAILER_ADMIN')),
  full_name text not null,
  msisdn text not null,
  created_at timestamptz default now()
);
create table public.packages (
  id uuid primary key default gen_random_uuid(), title text not null,
  category text default 'DAILY', price_pkr numeric default 0,
  is_enabled boolean default true, created_by uuid, created_at timestamptz default now()
);
alter table public.profiles enable row level security;
alter table public.packages enable row level security;
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "packages_read_all" on public.packages for select using (true);
grant select on public.profiles to authenticated;
grant update on public.profiles to authenticated;
grant update (id, role, full_name, msisdn, created_at) on public.profiles to authenticated;
grant select, insert, update, delete on public.packages to authenticated;
`;

async function liveDb() {
  const db = new PGlite();
  await db.exec(SHIM);
  await db.exec(LIVE);
  await db.exec(`insert into auth.users (id, email) values ('${ADMIN_ID}','admin@expresso.pk');`);
  await db.exec(`insert into public.profiles (id, role, full_name, msisdn)
    values ('${ADMIN_ID}','RETAILER_ADMIN','Authorized Retailer Admin','+923001234567');`);
  await db.exec(`insert into public.packages (title, created_by) values ('Daily Super Internet','${ADMIN_ID}');`);
  return db;
}

const tableUpdate = (db) => db.query(
  `select count(*)::int n from information_schema.table_privileges
   where table_schema='public' and table_name='profiles' and grantee='authenticated' and privilege_type='UPDATE';`
).then((r) => r.rows[0].n);

const colUpdates = (db) => db.query(
  `select column_name from information_schema.column_privileges
   where table_schema='public' and table_name='profiles' and grantee='authenticated' and privilege_type='UPDATE'
   order by column_name;`
).then((r) => r.rows.map((x) => x.column_name));

const attaclRows = (db) => db.query(
  `select count(*)::int n from pg_attribute
   where attrelid='public.profiles'::regclass and attacl is not null;`
).then((r) => r.rows[0].n);

const apply = async (db, sql) => { try { await db.exec(sql); return null; } catch (e) { return e; } };

console.log('1. A table-level grant is expanded across every column');
{
  const db = new PGlite();
  await db.exec(SHIM);
  await db.exec(`create table public.profiles (id uuid, role text, full_name text, msisdn text, created_at timestamptz);`);
  await db.exec('grant update on public.profiles to authenticated;');
  check('a single table-level grant is reported as a table privilege', (await tableUpdate(db)) === 1);
  const cols = await colUpdates(db);
  check('column_privileges expands it to all five columns',
    cols.join(',') === 'created_at,full_name,id,msisdn,role', cols.join(','));
  check('but no column-level ACL was actually granted', (await attaclRows(db)) === 0, String(await attaclRows(db)));
  await db.close();
}

console.log('\n2. Live state: one table-level grant explains the reported column list');
{
  const db = await liveDb();
  check('live has a table-level UPDATE', (await tableUpdate(db)) === 1);
  check('live column list matches the reported five',
    (await colUpdates(db)).join(',') === 'created_at,full_name,id,msisdn,role', (await colUpdates(db)).join(','));
  await db.close();
}

console.log('\n3. The latent escalation when columns are added under a broad grant');
{
  const db = await liveDb();
  await db.exec('alter table public.profiles add column is_active boolean not null default true;');
  const cols = await colUpdates(db);
  check('a newly added column silently inherits UPDATE', cols.includes('is_active'), cols.join(','));
  await db.close();
}

console.log('\n4. The corrective migration converges to least privilege');
{
  const db = await liveDb();
  const err = await apply(db, CORRECTIVE);
  check('corrective applies on the live shape (no phone column yet)', err === null, err?.message);
  check('no table-level UPDATE remains', (await tableUpdate(db)) === 0);
  check('column UPDATE is exactly full_name, msisdn',
    (await colUpdates(db)).join(',') === 'full_name,msisdn', (await colUpdates(db)).join(','));
  check('attacl now holds exactly the two columns', (await attaclRows(db)) === 2);
  check('corrective is idempotent', (await apply(db, CORRECTIVE)) === null);
  await db.close();
}

console.log('\n5. The corrective changes nothing but profiles grants');
{
  const db = await liveDb();
  await apply(db, CORRECTIVE);
  const admin = (await db.query(`select role, full_name from public.profiles where id='${ADMIN_ID}';`)).rows[0];
  check('authorized admin row is untouched', admin?.role === 'RETAILER_ADMIN' && admin?.full_name === 'Authorized Retailer Admin', JSON.stringify(admin));
  check('packages still has its four authenticated grants', (await db.query(
    `select count(*)::int n from information_schema.table_privileges
     where table_schema='public' and table_name='packages' and grantee='authenticated';`)).rows[0].n === 4);
  check('policies are untouched', (await db.query(
    `select count(*)::int n from pg_policies where schemaname='public';`)).rows[0].n === 2);
  check('package rows are untouched', (await db.query(`select count(*)::int n from public.packages;`)).rows[0].n === 1);
  await db.close();
}

console.log('\n6. After the full migration, the corrective is a no-op');
{
  const db = await liveDb();
  check('full migration applies on the live shape', (await apply(db, FULL)) === null);
  check('full migration yields three columns', (await colUpdates(db)).join(',') === 'full_name,msisdn,phone', (await colUpdates(db)).join(','));
  check('corrective on top is a no-op', (await apply(db, CORRECTIVE)) === null);
  check('still exactly three columns', (await colUpdates(db)).join(',') === 'full_name,msisdn,phone', (await colUpdates(db)).join(','));
  check('admin preserved through both', (await db.query(`select role from public.profiles where id='${ADMIN_ID}';`)).rows[0].role === 'RETAILER_ADMIN');
  await db.close();
}

process.exit(report());

// Exercises the Supabase migration against a real Postgres engine (PGlite).
//
// The harness deliberately starts from a *dirty* legacy state — permissive
// `using (true)` policies and broad table-level grants, as left behind by an
// earlier dashboard "quick start" — so the migration is tested for the ability
// to clean up a real project, not just to build from scratch.
//
//   node tests/auth-rls.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(here, '..', 'supabase', 'migrations', '20261017120000_auth_profiles_rls.sql'),
  'utf8'
);

const ADMIN_ID = 'bdd8f73c-fd23-4d76-9d23-7f4942300c36';
const CUSTOMER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_ID = 'aaaaaaaa-0000-0000-0000-000000000002';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- Supabase runtime shim: auth schema, auth.uid(), and anon/authenticated roles
const SHIM = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text unique,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon');
$$;
do $$ begin
  create role anon nologin;
exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated nologin;
exception when duplicate_object then null; end $$;
grant usage on schema public, auth to anon, authenticated;
grant select on auth.users to authenticated;
`;

// A pre-existing, badly-secured project: legacy permissive policies plus broad
// table-level grants. This mirrors the live project before the migration.
const LEGACY_STATE = `
create table public.profiles (
  id uuid primary key,
  role text not null default 'CUSTOMER',
  full_name text,
  msisdn text,
  created_at timestamptz not null default now(),
  email text,
  is_active boolean not null default true
);
create table public.packages (
  id uuid primary key default gen_random_uuid(),
  title text, category text, price_pkr numeric default 0,
  is_enabled boolean default true, created_by uuid
);
alter table public.profiles enable row level security;
alter table public.packages enable row level security;

create policy "Enable read access for all users" on public.profiles
  for select using (true);
create policy "Enable insert for authenticated users" on public.profiles
  for insert with check (true);
create policy "Enable update for all users" on public.profiles
  for update using (true) with check (true);
create policy "profiles_admin_all" on public.packages
  for all using (true) with check (true);

grant select, insert, update, delete on public.profiles to authenticated;
grant all on public.profiles to public;
grant select, insert, update, delete on public.packages to authenticated;
`;

const db = new PGlite();

async function asRole(role, uid, fn) {
  await db.exec(`set role ${role};`);
  await db.exec(`select set_config('request.jwt.claim.role', '${role}', false);`);
  await db.exec(
    `select set_config('request.jwt.claim.sub', ${uid ? `'${uid}'` : `''`}, false);`
  );
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;`);
  }
}

async function expectError(sql, params = []) {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e;
  }
}

console.log('Expresso auth/RLS migration tests\n');
console.log('Setup: dirty legacy project');
await db.exec(SHIM);
await db.exec(LEGACY_STATE);
// The authorized retailer-admin account already exists in the live project,
// and it is the sole author of the existing catalogue.
await db.exec(
  `insert into auth.users (id, email) values ('${ADMIN_ID}', 'admin@expresso.pk');`
);
await db.exec(
  `insert into auth.users (id, email) values ('${CUSTOMER_ID}', 'cust@example.com');`
);
await db.exec(`insert into public.profiles (id, role) values ('${ADMIN_ID}', 'CUSTOMER');`);
await db.exec(`insert into public.profiles (id, role, email) values ('${CUSTOMER_ID}', 'CUSTOMER', 'cust@example.com');`);
await db.exec(`insert into public.packages (title, category, price_pkr, is_enabled, created_by)
  values ('Daily Super Internet', 'DAILY', 65, true, '${ADMIN_ID}');`);

// Show the escalation is real before the migration runs.
await db.exec(`set role authenticated;`);
await db.exec(`select set_config('request.jwt.claim.sub','${CUSTOMER_ID}',false);`);
const preEsc = await db.query(
  `update public.profiles set role='RETAILER_ADMIN' where id='${CUSTOMER_ID}' returning role;`
);
await db.exec(`reset role;`);
check(
  'legacy state really allowed self-promotion (precondition)',
  preEsc.rows[0]?.role === 'RETAILER_ADMIN',
  JSON.stringify(preEsc.rows)
);
// put it back so later assertions start from a clean role
await db.query(`update public.profiles set role='CUSTOMER' where id='${CUSTOMER_ID}';`);

await db.exec(migration);
// Re-apply to prove the migration is idempotent.
await db.exec(migration);
check('migration applies cleanly over legacy state and is idempotent', true);

console.log('\nLegacy policy cleanup');
const policies = (await db.query(
  `select policyname, cmd from pg_policies
   where schemaname='public' and tablename in ('profiles','packages')
   order by policyname;`
)).rows;
const names = policies.map((p) => p.policyname);
check(
  'legacy permissive profiles policies removed',
  !names.some((n) => /Enable read access for all users|Enable insert for authenticated users|Enable update for all users/.test(n)),
  names.join(', ')
);
check(
  'legacy permissive packages policy removed',
  !names.includes('profiles_admin_all'),
  names.join(', ')
);
check(
  'exactly the intended policies remain',
  policies.length === 4 &&
    ['packages_admin_write', 'packages_select_authenticated', 'profiles_select_own', 'profiles_update_own']
      .every((n) => names.includes(n)),
  names.join(', ')
);
check(
  'no policy grants an unconditional USING(true) to authenticated',
  (await db.query(
    `select count(*)::int as n from pg_policies
     where schemaname='public' and tablename in ('profiles','packages')
       and qual = 'true';`
  )).rows[0].n === 0
);

console.log('\nEffective privileges (least privilege)');
const colPriv = (await db.query(
  `select grantee, privilege_type, column_name
   from information_schema.column_privileges
   where table_schema='public' and table_name='profiles'
     and grantee='authenticated' and privilege_type='UPDATE'
   order by column_name;`
)).rows.map((r) => r.column_name);
check(
  'authenticated can update only full_name and msisdn',
  colPriv.length === 2 && colPriv.includes('full_name') && colPriv.includes('msisdn'),
  JSON.stringify(colPriv)
);

const tblPriv = (await db.query(
  `select privilege_type from information_schema.table_privileges
   where table_schema='public' and table_name='profiles'
     and grantee in ('authenticated','anon','PUBLIC') and privilege_type='UPDATE';`
)).rows;
check('no table-level UPDATE remains on profiles', tblPriv.length === 0, JSON.stringify(tblPriv));

const anonPriv = (await db.query(
  `select table_name, privilege_type from information_schema.table_privileges
   where table_schema='public' and table_name in ('profiles','packages')
     and grantee in ('anon','PUBLIC');`
)).rows;
check('anon/PUBLIC hold no privileges on either table', anonPriv.length === 0, JSON.stringify(anonPriv));

console.log('\nTrigger: signup profile provisioning');
await db.exec(
  `insert into auth.users (id, email, raw_user_meta_data) values
     ('${OTHER_ID}', 'sara@example.com',
      '{"full_name":"Sara Khan","msisdn":"+923001234567"}'::jsonb);`
);
const custRow = (await db.query(
  `select id, role, full_name, msisdn from public.profiles where id='${OTHER_ID}';`
)).rows[0];
check('new auth user gets a profile', !!custRow);
check('profile role defaults to CUSTOMER', custRow?.role === 'CUSTOMER', custRow?.role);
check('profile copies full_name metadata', custRow?.full_name === 'Sara Khan');
check('profile copies msisdn metadata', custRow?.msisdn === '+923001234567');

const MALICIOUS_ID = 'aaaaaaaa-0000-0000-0000-000000000003';
await db.exec(
  `insert into auth.users (id, email, raw_user_meta_data) values
     ('${MALICIOUS_ID}', 'attacker@example.com',
      '{"role":"RETAILER_ADMIN","is_active":true,"full_name":"Mallory"}'::jsonb);`
);
const attacker = (await db.query(
  `select role from public.profiles where id='${MALICIOUS_ID}';`
)).rows[0];
check(
  'client-supplied role metadata is ignored',
  attacker?.role === 'CUSTOMER',
  attacker?.role
);

console.log('\nPrivilege escalation (regression)');
for (const [label, sql] of [
  ['role', `update public.profiles set role='RETAILER_ADMIN' where id='${CUSTOMER_ID}';`],
  ['is_active', `update public.profiles set is_active=false where id='${CUSTOMER_ID}';`],
  ['email', `update public.profiles set email='hacked@example.com' where id='${CUSTOMER_ID}';`],
]) {
  const err = await asRole('authenticated', CUSTOMER_ID, () => expectError(sql));
  check(`customer cannot update own ${label}`, !!err, err ? 'allowed' : 'no error raised');
}
const stillCustomer = (await db.query(
  `select role, is_active, email from public.profiles where id='${CUSTOMER_ID}';`
)).rows[0];
check('customer role unchanged after escalation attempts', stillCustomer?.role === 'CUSTOMER', stillCustomer?.role);
check('customer is_active unchanged', stillCustomer?.is_active === true);
check('customer email unchanged', stillCustomer?.email === 'cust@example.com', stillCustomer?.email);

console.log('\nCustomer profile updates (allowed path)');
const rename = await asRole('authenticated', CUSTOMER_ID, async () => {
  await db.query(
    `update public.profiles set full_name='Sara K.', msisdn='+923009999999' where id='${CUSTOMER_ID}';`
  );
  return (await db.query(
    `select full_name, msisdn, updated_at from public.profiles where id='${CUSTOMER_ID}';`
  )).rows[0];
});
check('customer can update own full_name', rename?.full_name === 'Sara K.', rename?.full_name);
check('customer can update own msisdn', rename?.msisdn === '+923009999999', rename?.msisdn);
check('updated_at trigger fires on update', !!rename?.updated_at);

const changeOther = await asRole('authenticated', CUSTOMER_ID, async () =>
  (await db.query(
    `update public.profiles set full_name='x' where id='${OTHER_ID}';`
  )).affectedRows
);
check('customer cannot edit another profile', changeOther === 0, `affected=${changeOther}`);

console.log('\nRLS: profiles reads');
const anonRead = await asRole('anon', null, () => expectError(`select * from public.profiles;`));
check('anon cannot read profiles', !!anonRead, anonRead?.message);

const anonInsert = await asRole('anon', null, () =>
  expectError(`insert into public.profiles (id, role) values ('${OTHER_ID}','CUSTOMER');`)
);
check('anon cannot insert profiles', !!anonInsert, anonInsert?.message);

const ownRead = await asRole('authenticated', CUSTOMER_ID, async () =>
  (await db.query(`select id from public.profiles;`)).rows
);
check(
  'customer reads exactly one profile row',
  ownRead.length === 1 && ownRead[0].id === CUSTOMER_ID,
  `rows=${ownRead.length}`
);

const otherRead = await asRole('authenticated', CUSTOMER_ID, async () =>
  (await db.query(`select id from public.profiles where id='${OTHER_ID}';`)).rows.length
);
check('customer cannot read another profile', otherRead === 0);

console.log('\nRLS: packages');
await db.query(
  `insert into public.packages (title, category, price_pkr, is_enabled, created_by)
   values ('Hidden Bundle', 'DAILY', 99, false, '${ADMIN_ID}');`
);

const pkgAnon = await asRole('anon', null, () => expectError(`select * from public.packages;`));
check('anon cannot read packages', !!pkgAnon, pkgAnon?.message);

const pkgCust = await asRole('authenticated', CUSTOMER_ID, async () =>
  (await db.query(`select title from public.packages order by title;`)).rows.map((x) => x.title)
);
check(
  'customer sees only enabled packages',
  pkgCust.length === 1 && pkgCust[0] === 'Daily Super Internet',
  JSON.stringify(pkgCust)
);

console.log('\nUnauthorized package writes (regression)');
const pkgInsert = await asRole('authenticated', CUSTOMER_ID, () =>
  expectError(
    `insert into public.packages (title, category, price_pkr, created_by)
     values ('Sneaky', 'DAILY', 1, '${CUSTOMER_ID}');`
  )
);
check('customer cannot create packages', !!pkgInsert, pkgInsert?.message);

const pkgUpdate = await asRole('authenticated', CUSTOMER_ID, async () => {
  await db.query(`update public.packages set price_pkr=1 where title='Daily Super Internet';`);
  return Number((await db.query(
    `select price_pkr from public.packages where title='Daily Super Internet';`
  )).rows[0].price_pkr);
});
check('customer cannot update packages', pkgUpdate === 65, `price=${pkgUpdate}`);

const pkgDelete = await asRole('authenticated', CUSTOMER_ID, async () =>
  (await db.query(`delete from public.packages where title='Daily Super Internet';`))
    .affectedRows
);
// Verify as superuser: RLS would hide rows from the customer's own SELECT.
const pkgStillThere = (await db.query(
  `select count(*)::int as n from public.packages where title='Daily Super Internet';`
)).rows[0].n;
check(
  'customer cannot delete packages',
  pkgDelete === 0 && pkgStillThere === 1,
  `affected=${pkgDelete}, remaining=${pkgStillThere}`
);

console.log('\nAuthorized retailer-admin');
const admin = (await db.query(
  `select role, full_name from public.profiles where id='${ADMIN_ID}';`
)).rows[0];
check(
  'authorized retailer-admin promoted to RETAILER_ADMIN',
  admin?.role === 'RETAILER_ADMIN',
  admin?.role
);

const adminRead = await asRole('authenticated', ADMIN_ID, async () =>
  (await db.query(`select id from public.profiles;`)).rows.length
);
check('retailer admin can read all profiles', adminRead === 4, `rows=${adminRead}`);

const adminWrite = await asRole('authenticated', ADMIN_ID, async () => {
  const before = (await db.query(`select count(*)::int as n from public.packages;`)).rows[0].n;
  await db.query(
    `insert into public.packages (title, category, price_pkr, created_by)
     values ('Admin Bundle','WEEKLY',500,'${ADMIN_ID}');`
  );
  await db.query(`update public.packages set price_pkr=75 where title='Daily Super Internet';`);
  const after = (await db.query(`select count(*)::int as n from public.packages;`)).rows[0].n;
  return { before, after };
});
check('retailer admin sees all packages', adminWrite.before === 2, `rows=${adminWrite.before}`);
check('retailer admin can create packages', adminWrite.after === 3, `rows=${adminWrite.after}`);

const adminPrice = (await db.query(
  `select price_pkr from public.packages where title='Daily Super Internet';`
)).rows[0].price_pkr;
check('retailer admin can update packages', Number(adminPrice) === 75, `price=${adminPrice}`);

console.log('\nSECURITY DEFINER hardening');
const fnOwner = (await db.query(
  `select p.proname, pg_get_userbyid(p.proowner) as owner, p.prosecdef,
          array_to_string(p.proconfig, ',') as cfg
   from pg_proc p where p.pronamespace='public'::regnamespace
     and p.proname in ('is_retailer_admin','handle_new_user','set_updated_at');`
)).rows;
check('all three helper functions exist', fnOwner.length === 3, JSON.stringify(fnOwner.map((f) => f.proname)));
check(
  'no SECURITY DEFINER function is owned by a client role',
  fnOwner.every((f) => !['anon', 'authenticated', 'authenticator'].includes(f.owner)),
  JSON.stringify(fnOwner.map((f) => `${f.proname}:${f.owner}`))
);
check(
  'search_path is pinned to empty for every helper',
  fnOwner.every((f) => (f.cfg || '').replace(/"/g, '') === 'search_path='),
  JSON.stringify(fnOwner.map((f) => `${f.proname}:${f.cfg}`))
);
check(
  'is_retailer_admin and handle_new_user are SECURITY DEFINER',
  fnOwner.filter((f) => f.proname !== 'set_updated_at').every((f) => f.prosecdef === true)
);

const execPub = (await db.query(
  `select p.proname,
          case when r.grantee = 0 then 'PUBLIC'
               else pg_get_userbyid(r.grantee) end as grantee
   from pg_proc p
   cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) r
   where p.pronamespace='public'::regnamespace
     and p.proname in ('is_retailer_admin','handle_new_user','set_updated_at')
     and r.privilege_type = 'EXECUTE';`
)).rows.filter((r) => r.grantee === 'PUBLIC' || r.grantee === 'anon');
check('no helper is executable by PUBLIC/anon', execPub.length === 0, JSON.stringify(execPub));

const custExec = await asRole('authenticated', CUSTOMER_ID, () =>
  expectError(`select public.is_retailer_admin();`)
);
check('authenticated may call is_retailer_admin', custExec === null, custExec?.message);

const fnResult = await asRole('authenticated', CUSTOMER_ID, async () =>
  (await db.query(`select public.is_retailer_admin() as a;`)).rows[0].a
);
check('is_retailer_admin() is false for a customer', fnResult === false, String(fnResult));

const adminFn = await asRole('authenticated', ADMIN_ID, async () =>
  (await db.query(`select public.is_retailer_admin() as a;`)).rows[0].a
);
check('is_retailer_admin() is true for the retailer admin', adminFn === true, String(adminFn));

// Trigger must still fire after EXECUTE was revoked from PUBLIC.
const TRIGGER_ID = 'aaaaaaaa-0000-0000-0000-000000000004';
await db.exec(
  `insert into auth.users (id, email) values ('${TRIGGER_ID}', 'post-revoke@example.com');`
);
check(
  'signup trigger still fires after EXECUTE revoke',
  (await db.query(`select role from public.profiles where id='${TRIGGER_ID}';`)).rows[0]?.role === 'CUSTOMER'
);

console.log('\nAdmin identity verification (fail-safe)');
// A project whose catalogue was authored by someone else must not be silently
// re-labelled: the promotion block has to raise.
const db2 = new PGlite();
await db2.exec(SHIM);
await db2.exec(`
  create table public.profiles (id uuid primary key, role text not null default 'CUSTOMER',
    full_name text, msisdn text, created_at timestamptz default now(),
    email text, is_active boolean not null default true);
  create table public.packages (id uuid primary key default gen_random_uuid(), title text,
    category text, price_pkr numeric default 0, is_enabled boolean default true, created_by uuid);
`);
await db2.exec(
  `insert into auth.users (id, email) values ('${ADMIN_ID}','admin@expresso.pk');`
);
await db2.exec(
  `insert into public.packages (title, created_by)
   values ('Foreign Bundle','aaaaaaaa-0000-0000-0000-0000000000ff');`
);
let foreignErr = null;
try {
  await db2.exec(migration);
} catch (e) {
  foreignErr = e;
}
check(
  'migration fails safely when the catalogue was authored by another account',
  !!foreignErr && /authored by accounts other than/.test(foreignErr.message),
  foreignErr ? foreignErr.message.split('\n')[0] : 'no error raised'
);

// A project whose configured admin has no auth.users row must also fail.
const db3 = new PGlite();
await db3.exec(SHIM);
await db3.exec(`
  create table public.profiles (id uuid primary key, role text not null default 'CUSTOMER',
    full_name text, msisdn text, created_at timestamptz default now(),
    email text, is_active boolean not null default true);
  create table public.packages (id uuid primary key default gen_random_uuid(), title text,
    category text, price_pkr numeric default 0, is_enabled boolean default true, created_by uuid);
`);
let missingErr = null;
try {
  await db3.exec(migration);
} catch (e) {
  missingErr = e;
}
check(
  'migration fails safely when the authorized admin account is absent',
  !!missingErr && /has no auth.users row/.test(missingErr.message),
  missingErr ? missingErr.message.split('\n')[0] : 'no error raised'
);

// An explicit override must let an operator nominate the verified account.
const db4 = new PGlite();
await db4.exec(SHIM);
const ALT_ADMIN = 'aaaaaaaa-0000-0000-0000-0000000000ab';
await db4.exec(`
  create table public.profiles (id uuid primary key, role text not null default 'CUSTOMER',
    full_name text, msisdn text, created_at timestamptz default now(),
    email text, is_active boolean not null default true);
  create table public.packages (id uuid primary key default gen_random_uuid(), title text,
    category text, price_pkr numeric default 0, is_enabled boolean default true, created_by uuid);
`);
await db4.exec(`insert into auth.users (id, email) values ('${ALT_ADMIN}','ops@expresso.pk');`);
await db4.exec(`insert into public.packages (title, created_by) values ('Ops Bundle','${ALT_ADMIN}');`);
await db4.exec(`select set_config('expresso.retailer_admin_id','${ALT_ADMIN}', false);`);
await db4.exec(migration);
check(
  'expresso.retailer_admin_id override promotes the verified account',
  (await db4.query(`select role from public.profiles where id='${ALT_ADMIN}';`)).rows[0]?.role === 'RETAILER_ADMIN'
);

console.log('\nRole domain');
check(
  'profiles_role_check constraint exists',
  (await db.query(`select 1 from pg_constraint where conname='profiles_role_check';`)).rows.length === 1
);
const dbCheck = await expectError(
  `update public.profiles set role='SUPERUSER' where id='${CUSTOMER_ID}';`
);
check('role check constraint rejects unknown roles', !!dbCheck, dbCheck?.message);

console.log('\nData preservation');
const pkgCount = (await db.query(`select count(*)::int as n from public.packages;`)).rows[0].n;
check('existing packages preserved (2 seeded + 1 admin-created)', pkgCount === 3, `rows=${pkgCount}`);
const profCount = (await db.query(`select count(*)::int as n from public.profiles;`)).rows[0].n;
check('existing profiles preserved and new ones added', profCount === 5, `rows=${profCount}`);

await db.close();
await db2.close();
await db3.close();
await db4.close();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}

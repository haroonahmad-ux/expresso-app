// Exercises the Supabase migration against a real Postgres engine (PGlite).
// Verifies the auth trigger, role ownership and RLS policies end-to-end.
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
console.log('Setup');
await db.exec(SHIM);
// The authorized retailer-admin account already exists in the live project.
await db.exec(
  `insert into auth.users (id, email, raw_user_meta_data)
   values ('${ADMIN_ID}', 'admin@expresso.pk', '{}'::jsonb);`
);
await db.exec(migration);
// Re-apply to prove the migration is idempotent.
await db.exec(migration);
check('migration applies cleanly and is idempotent', true);

console.log('\nTrigger: signup profile provisioning');
await db.exec(
  `insert into auth.users (id, email, raw_user_meta_data) values
     ('${CUSTOMER_ID}', 'cust@example.com',
      '{"full_name":"Sara Khan","msisdn":"+923001234567"}'::jsonb);`
);

const created = await db.query(
  `select id, role, full_name, msisdn from public.profiles order by email nulls last;`
);
const custRow = created.rows.find((r) => r.id === CUSTOMER_ID);
check('new auth user gets a profile', !!custRow);
check('profile role defaults to CUSTOMER', custRow?.role === 'CUSTOMER', custRow?.role);
check('profile copies full_name metadata', custRow?.full_name === 'Sara Khan');
check('profile copies msisdn metadata', custRow?.msisdn === '+923001234567');

// A malicious signup tries to self-assign RETAILER_ADMIN through user metadata.
await db.exec(
  `insert into auth.users (id, email, raw_user_meta_data) values
     ('${OTHER_ID}', 'attacker@example.com',
      '{"role":"RETAILER_ADMIN","full_name":"Mallory"}'::jsonb);`
);
const attacker = await db.query(
  `select role from public.profiles where id = '${OTHER_ID}';`
);
check(
  'client-supplied role metadata is ignored',
  attacker.rows[0]?.role === 'CUSTOMER',
  attacker.rows[0]?.role
);

// Authorized retailer-admin preserved by the migration.
const admin = await db.query(
  `select role from public.profiles where id = '${ADMIN_ID}';`
);
check(
  'authorized retailer-admin promoted to RETAILER_ADMIN',
  admin.rows[0]?.role === 'RETAILER_ADMIN',
  admin.rows[0]?.role
);

console.log('\nRLS: profiles');
const anonRead = await asRole('anon', null, () =>
  expectError(`select * from public.profiles;`)
);
check('anon cannot read profiles', !!anonRead, anonRead?.message);

const anonWrite = await asRole('anon', null, () =>
  expectError(
    `insert into public.profiles (id, role) values ('${OTHER_ID}', 'CUSTOMER');`
  )
);
check('anon cannot insert profiles', !!anonWrite, anonWrite?.message);

const ownRead = await asRole('authenticated', CUSTOMER_ID, async () => {
  const r = await db.query(`select id, role from public.profiles;`);
  return r.rows;
});
check(
  'customer reads exactly one profile row',
  ownRead.length === 1 && ownRead[0].id === CUSTOMER_ID,
  `rows=${ownRead.length}`
);

const otherRead = await asRole('authenticated', CUSTOMER_ID, async () => {
  const r = await db.query(
    `select id from public.profiles where id = '${OTHER_ID}';`
  );
  return r.rows.length;
});
check('customer cannot read another profile', otherRead === 0);

const adminRead = await asRole('authenticated', ADMIN_ID, async () => {
  const r = await db.query(`select id from public.profiles;`);
  return r.rows.length;
});
check('retailer admin can read all profiles', adminRead === 3, `rows=${adminRead}`);

console.log('\nRLS: privilege escalation is blocked');
const selfPromote = await asRole('authenticated', CUSTOMER_ID, () =>
  expectError(
    `update public.profiles set role = 'RETAILER_ADMIN' where id = '${CUSTOMER_ID}';`
  )
);
check('customer cannot change own role', !!selfPromote, selfPromote?.message);

const changeOther = await asRole('authenticated', CUSTOMER_ID, async () => {
  const r = await db.query(
    `update public.profiles set full_name = 'x' where id = '${OTHER_ID}';`
  );
  return r.affectedRows;
});
check('customer cannot edit another profile', changeOther === 0, `affected=${changeOther}`);

const rename = await asRole('authenticated', CUSTOMER_ID, async () => {
  await db.query(
    `update public.profiles set full_name = 'Sara K.' where id = '${CUSTOMER_ID}';`
  );
  const r = await db.query(
    `select full_name, updated_at from public.profiles where id = '${CUSTOMER_ID}';`
  );
  return r.rows[0];
});
check('customer can edit own full_name', rename?.full_name === 'Sara K.');
check('updated_at trigger fires on update', !!rename?.updated_at);

const reactivate = await asRole('authenticated', CUSTOMER_ID, () =>
  expectError(
    `update public.profiles set is_active = false where id = '${CUSTOMER_ID}';`
  )
);
check('customer cannot toggle is_active', !!reactivate, reactivate?.message);

console.log('\nRLS: packages');
await db.query(
  `insert into public.packages (title, category, price_pkr, is_enabled, created_by)
   values ('Seed Bundle', 'DAILY', 65, true, '${ADMIN_ID}');`
);
await db.query(
  `insert into public.packages (title, category, price_pkr, is_enabled, created_by)
   values ('Hidden Bundle', 'DAILY', 99, false, '${ADMIN_ID}');`
);

const pkgAnon = await asRole('anon', null, () =>
  expectError(`select * from public.packages;`)
);
check('anon cannot read packages', !!pkgAnon, pkgAnon?.message);

const pkgCust = await asRole('authenticated', CUSTOMER_ID, async () => {
  const r = await db.query(`select title from public.packages order by title;`);
  return r.rows.map((x) => x.title);
});
check(
  'customer sees only enabled packages',
  pkgCust.length === 1 && pkgCust[0] === 'Seed Bundle',
  JSON.stringify(pkgCust)
);

const pkgCustWrite = await asRole('authenticated', CUSTOMER_ID, () =>
  expectError(
    `insert into public.packages (title, category, price_pkr, created_by)
     values ('Sneaky', 'DAILY', 1, '${CUSTOMER_ID}');`
  )
);
check('customer cannot create packages', !!pkgCustWrite, pkgCustWrite?.message);

const pkgCustUpdate = await asRole('authenticated', CUSTOMER_ID, async () => {
  await db.query(`update public.packages set price_pkr = 1 where title = 'Seed Bundle';`);
  const r = await db.query(`select price_pkr from public.packages where title = 'Seed Bundle';`);
  return Number(r.rows[0].price_pkr);
});
check('customer cannot update packages', pkgCustUpdate === 65, `price=${pkgCustUpdate}`);

const pkgAdmin = await asRole('authenticated', ADMIN_ID, async () => {
  const all = await db.query(`select title from public.packages;`);
  await db.query(
    `insert into public.packages (title, category, price_pkr, created_by)
     values ('Admin Bundle', 'WEEKLY', 500, '${ADMIN_ID}');`
  );
  const after = await db.query(`select title from public.packages;`);
  return { before: all.rows.length, after: after.rows.length };
});
check('retailer admin sees all packages', pkgAdmin.before === 2, `rows=${pkgAdmin.before}`);
check('retailer admin can create packages', pkgAdmin.after === 3, `rows=${pkgAdmin.after}`);

const pkgAdminUpdate = await asRole('authenticated', ADMIN_ID, async () => {
  await db.query(`update public.packages set price_pkr = 75 where title = 'Seed Bundle';`);
  const r = await db.query(`select price_pkr from public.packages where title = 'Seed Bundle';`);
  return Number(r.rows[0].price_pkr);
});
check('retailer admin can update packages', pkgAdminUpdate === 75, `price=${pkgAdminUpdate}`);

console.log('\nRole domain');
const badRole = await db.query(
  `select conname from pg_constraint where conname = 'profiles_role_check';`
);
check('profiles_role_check constraint exists', badRole.rows.length === 1);

const dbCheck = await expectError(
  `update public.profiles set role = 'SUPERUSER' where id = '${CUSTOMER_ID}';`
);
check('role check constraint rejects unknown roles', !!dbCheck, dbCheck?.message);

await db.close();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}

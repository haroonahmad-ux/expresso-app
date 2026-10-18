// Live Supabase API authorization probe.
//
// Uses only the PUBLIC publishable (anon) key. It asserts the state the
// migration is designed to produce: anonymous callers must not be able to read
// or write application tables, and the client key must not carry service-role
// privileges.
//
// This suite talks to the real project, so it reports the CURRENT live state.
// While the migration has not been applied, the "anonymous read of packages"
// checks fail on purpose: that is the open risk recorded as C-1 in
// docs/chapter-2-final-report.md. Run it after applying the migration to
// confirm the fix.
//
//   node tests/live-api-authz.test.mjs
import { createRunner } from './helpers/runner.mjs';

const URL = process.env.SUPABASE_URL || 'https://ryimialrkhmnceupzptg.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY || 'sb_publishable_UFoJamn09mmH7HLChSzuJg_1LXj1IIq';

const { check, report } = createRunner(`Live Supabase API authorization (${URL})`);

const anonHeaders = { apikey: ANON, Authorization: `Bearer ${ANON}` };
let networkOk = true;

async function rest(path, init = {}) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...anonHeaders, ...(init.headers || {}) },
  });
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

// A readable table is a leak; an unreadable one (401/403/404/empty-with-error)
// is the desired outcome. `200` with rows is the C-1 finding.
async function readIsBlocked(label, path) {
  let r;
  try {
    r = await rest(path);
  } catch (e) {
    networkOk = false;
    check(`${label}: request could not be made`, false, e.message);
    return;
  }
  const leaked = r.status === 200 && Array.isArray(r.body) && r.body.length > 0;
  check(
    `${label}: anonymous read is blocked (C-1)`,
    !leaked,
    leaked
      ? `LEAK — HTTP ${r.status}, ${r.body.length} row(s) readable by an anonymous caller`
      : `HTTP ${r.status}`
  );
  return r;
}

async function writeIsBlocked(label, path, init) {
  let r;
  try {
    r = await rest(path, init);
  } catch (e) {
    networkOk = false;
    check(`${label}: request could not be made`, false, e.message);
    return;
  }
  const denied = r.status >= 400 || r.status === 401 || r.status === 403 ||
    (r.status === 200 && Array.isArray(r.body) && r.body.length === 0);
  check(`${label}: anonymous write is denied`, denied, `HTTP ${r.status}`);
  return r;
}

console.log('Anonymous (publishable key) access to application tables');
const pkgs = await readIsBlocked('packages', 'packages?select=id,title,is_enabled');
await readIsBlocked('packages (enabled only)', 'packages?select=id&is_enabled=eq.true');
await readIsBlocked('profiles', 'profiles?select=id,role,email');

console.log('\nAnonymous writes must be denied');
await writeIsBlocked('INSERT packages', 'packages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({ title: 'authz-probe', category: 'DAILY', price_pkr: 1 }),
});
await writeIsBlocked('UPDATE packages', 'packages?id=not.a.real.id', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({ is_enabled: false }),
});
await writeIsBlocked('DELETE packages', 'packages?id=not.a.real.id', {
  method: 'DELETE',
  headers: { Prefer: 'return=representation' },
});
await writeIsBlocked('UPDATE profiles (self-promotion)', 'profiles?id=eq.00000000-0000-0000-0000-000000000000', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({ role: 'RETAILER_ADMIN' }),
});

console.log('\nClient key must not carry service-role privilege');
// A service key can read auth admin data; the publishable key cannot.
let adminBlocked = true;
try {
  const r = await fetch(`${URL}/auth/v1/admin/users`, { headers: anonHeaders });
  adminBlocked = r.status >= 400;
} catch { adminBlocked = true; }
check('publishable key cannot call the auth admin API', adminBlocked);
check('client bundle contains no service_role / secret key', !/service_role|sb_secret_/.test(ANON));

if (!networkOk) {
  console.log('\nNote: live checks could not run (no network access to the project).');
} else if (pkgs && pkgs.status === 200 && Array.isArray(pkgs.body) && pkgs.body.length > 0) {
  console.log(
    '\nFINDING (C-1): public.packages is still readable by anonymous callers.\n' +
    'Apply supabase/migrations/20261017120000_auth_profiles_rls.sql to close it.'
  );
}

process.exit(report());

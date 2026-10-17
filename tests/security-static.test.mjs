// Static security assertions for the Expresso client.
// Guards against the demo authentication regressing back into index.html.
//
//   node tests/security-static.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

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

console.log('Expresso static security checks\n');

console.log('Demo authentication is gone');
check('no demo OTP value 482910', !html.includes('482910'));
check('no hardcoded admin PIN', !/EXP-ADMIN-2026/.test(html));
check('no client-side admin checkbox', !/adminCheck/.test(html));
check('no client-side requestOtp/verifyOtp', !/requestOtp|verifyOtp/.test(html));
check(
  'no client-side role assignment from UI',
  !/state\.role\s*=\s*(isAdmin|\()/.test(html)
);
check('no "TEST AUTHENTICATION MODE" banner', !/TEST AUTHENTICATION MODE/.test(html));
check(
  'legacy demo localStorage key is purged',
  /localStorage\.removeItem\(\s*["']expresso_app_state["']\s*\)/.test(html)
);

console.log('\nReal Supabase Auth is wired up');
check('uses signInWithPassword', /auth\.signInWithPassword\(/.test(html));
check('uses signUp', /auth\.signUp\(/.test(html));
check('uses signOut', /auth\.signOut\(/.test(html));
check('reads existing session on boot', /auth\.getSession\(/.test(html));
check('subscribes to auth state changes', /onAuthStateChange\(/.test(html));
check('persists the session', /persistSession:\s*true/.test(html));
check('auto-refreshes the token', /autoRefreshToken:\s*true/.test(html));

console.log('\nRoles come from the database');
check('role is read from the profiles table', /from\(\s*["']profiles["']\s*\)/.test(html));
check('admin check uses profile.role', /profile\.role\s*===\s*["']RETAILER_ADMIN["']/.test(html));
check(
  'role is never taken from user metadata',
  !/user_metadata[^\n]*\.role/.test(html)
);
check(
  'signUp does not send a role',
  !/options:\s*\{[^}]*data:\s*\{[^}]*role/.test(html)
);

console.log('\nPackages come from the database');
check('packages are loaded from the packages table', /from\(\s*["']packages["']\s*\)/.test(html));
check('customer queries filter to enabled rows', /\.eq\(\s*["']is_enabled["']\s*,\s*true\s*\)/.test(html));

console.log('\nSecrets and injection safety');
check('no service_role key in the client', !/service_role/.test(html));
check('no secret/private key material', !/sb_secret_/.test(html));
check('uses the publishable key only', /sb_publishable_/.test(html));
check('output is HTML-escaped', /function escapeHtml\(/.test(html));
check(
  'user-controlled values are escaped in templates',
  (html.match(/escapeHtml\(/g) || []).length > 20,
  `escapeHtml calls=${(html.match(/escapeHtml\(/g) || []).length}`
);

console.log('\nInline script parses');
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join('\n');
try {
  new Function(inline);
  check('inline JavaScript is syntactically valid', true);
} catch (e) {
  check('inline JavaScript is syntactically valid', false, e.message);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}

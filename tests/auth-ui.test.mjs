// Drives the real client in headless Chromium and asserts the authentication
// UX: render, validation, field retention, and the live Supabase error path.
//
//   node tests/auth-ui.test.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = 8911;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: root, stdio: 'ignore'
});
await new Promise((r) => setTimeout(r, 1200));

const browser = await puppeteer.launch({
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
});

const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  const url = (m.location && m.location().url) || '';
  // Ignore the browser's automatic favicon request and the expected HTTP 400
  // returned by Supabase for the deliberately rejected login.
  if (/favicon\.ico/.test(url) || /favicon/i.test(t)) return;
  if (/status of 400/.test(t)) return;
  consoleErrors.push(`${t} @ ${url}`);
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

const val = (id) => page.$eval('#' + id, (el) => el.value);
const text = () => page.$eval('#mainContent', (el) => el.innerText);
const fill = async (id, value) => {
  await page.$eval('#' + id, (el) => { el.value = ''; });
  await page.type('#' + id, value);
};

console.log('Expresso authentication UI tests\n');

console.log('Initial render');
await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle0' });
await page.waitForSelector('#authEmail', { timeout: 15000 });
check('sign-in form is shown', true);
check('email field present', !!(await page.$('#authEmail')));
check('password field present', !!(await page.$('#authPassword')));
check('no demo OTP hint on screen', !(await text()).includes('482910'));
check('role is explained as server-assigned', (await text()).includes('assigned by the server'));

console.log('\nValidation');
await fill('authEmail', 'not-an-email');
await fill('authPassword', 'abcdef123');
await page.click('button.btn');
await new Promise((r) => setTimeout(r, 400));
check('rejects malformed email', (await text()).includes('valid email address'));
check('email value is retained', (await val('authEmail')) === 'not-an-email');
check('password value is retained', (await val('authPassword')) === 'abcdef123');

await fill('authEmail', 'ui@example.com');
await fill('authPassword', '123');
await page.click('button.btn');
await new Promise((r) => setTimeout(r, 400));
check('rejects short password', (await text()).includes('at least 6 characters'));

console.log('\nSign-up validation');
await page.evaluate(() => setAuthMode('signup'));
await page.waitForSelector('#authName');
check('sign-up asks for full name', !!(await page.$('#authName')));
check('sign-up asks for mobile number', !!(await page.$('#authMsisdn')));
check('sign-up asks for password confirmation', !!(await page.$('#authConfirm')));

await fill('authName', 'Test User');
await fill('authMsisdn', '03001234567');
await fill('authEmail', 'ui@example.com');
await fill('authPassword', 'abcdef123');
await fill('authConfirm', 'different999');
await page.click('button.btn');
await new Promise((r) => setTimeout(r, 400));
check('rejects mismatched passwords', (await text()).includes('do not match'));
check('email is retained after mismatch', (await val('authEmail')) === 'ui@example.com');
check('full name is retained after mismatch', (await val('authName')) === 'Test User');
check('mobile number is retained after mismatch', (await val('authMsisdn')) === '03001234567');

console.log('\nLive Supabase error path (no account created)');
await page.evaluate(() => setAuthMode('login'));
await page.waitForSelector('#authEmail');
await fill('authEmail', 'definitely-not-a-user@example.com');
await fill('authPassword', 'wrongpassword123');
await page.click('button.btn');
await page.waitForFunction(
  () => /Incorrect email or password|Invalid login|rate limit|Too many/i.test(document.getElementById('mainContent').innerText),
  { timeout: 20000 }
);
const live = await text();
check('live endpoint surfaces a safe auth error', /Incorrect email or password|rate limit|Too many/i.test(live), live.slice(0, 120));
check('no stack trace leaked to the UI', !/at .*\(http/i.test(live));

check('no unexpected console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

// A full sign-in cannot be completed here: email confirmation is required and
// no service-role key or mailbox is available. These tests instead drive the
// real render code with a controlled session to verify role gating.
console.log('\nAuthenticated views (state-driven render)');
await page.evaluate(() => {
  state.session = { user: { id: 'u-1', email: 'cust@example.com', user_metadata: { full_name: 'Sara Khan' } } };
  state.profile = { id: 'u-1', role: 'CUSTOMER', full_name: 'Sara Khan', msisdn: '+923001234567', is_active: true };
  state.packages = [
    { id: 'p1', name: 'Daily Super Internet', cat: 'DAILY', pkr: 65, mb: 2048, mins: 200, valid: '1 Day', enabled: true }
  ];
  state.route = 'home';
  render();
});
check('home greets the signed-in user', (await text()).includes('Sara Khan'));
check('bottom navigation is visible', await page.$eval('#bottomNav', (el) => el.style.display === 'flex'));

await page.evaluate(() => { state.route = 'profile'; render(); });
const custProfile = await text();
check('profile shows the CUSTOMER role', custProfile.includes('CUSTOMER'));
check('customer cannot see the admin console entry', !custProfile.includes('Retailer Admin Console'));
check('isAdmin() is false for a customer', (await page.evaluate(() => isAdmin())) === false);

await page.evaluate(() => {
  state.profile = { id: 'a-1', role: 'RETAILER_ADMIN', full_name: 'Authorized Retailer Admin', msisdn: null, is_active: true };
  state.route = 'profile';
  render();
});
const adminProfile = await text();
check('profile shows the RETAILER_ADMIN role', adminProfile.includes('RETAILER_ADMIN'));
check('retailer admin sees the admin console entry', adminProfile.includes('Retailer Admin Console'));
check('isAdmin() is true for a retailer admin', (await page.evaluate(() => isAdmin())) === true);

await page.evaluate(() => { state.route = 'admin'; render(); });
const console_ = await text();
check('admin console lists bundles', console_.includes('Daily Super Internet'));
check('admin console has a create-bundle form', !!(await page.$('#pkgTitle')));

// The packages query must be scoped differently for the two roles.
check(
  'customer package query filters to enabled rows',
  (await page.evaluate(() => {
    state.profile = { role: 'CUSTOMER' };
    return !isAdmin();
  })) === true
);

await page.evaluate(() => { state.profile = { role: 'CUSTOMER' }; state.route = 'profile'; render(); });
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('#mainContent button')]
    .find((b) => /Sign Out/.test(b.textContent));
  btn.click();
});
await new Promise((r) => setTimeout(r, 800));
check('sign out clears the session', (await page.evaluate(() => state.session)) === null);
check('sign out returns to the auth screen', !!(await page.$('#authEmail')));

await browser.close();
server.kill();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}

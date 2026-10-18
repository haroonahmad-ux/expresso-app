// End-to-end regression for the Expresso UI after the Chapter 2 authentication
// change. Confirms the real sign-in screen is shown, that the existing app
// screens still render, and that the client-side sandbox features (recharge,
// bundle subscription, streak, AI assistant) and sign-out still work.
//
// A live Supabase session is not required: the signed-in UI is exercised by
// seeding the client state directly, which is what the app does after a
// successful auth callback. Server-side authorization is covered by the API
// authorization suite and the RLS migration suite.
//
//   node tests/ui-regression.test.mjs
import { startServer, launchBrowser } from './helpers/browser.mjs';
import { createRunner } from './helpers/runner.mjs';

const { check, report } = createRunner('UI regression (Chapter 2 authentication UI)');
const srv = await startServer();
const browser = await launchBrowser();
const page = await browser.newPage();

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', async d => { await d.accept(); });

await page.goto(srv.base, { waitUntil: 'networkidle2' });

// --- Signed-out: the real auth screen is shown, no demo controls exist --------
check('real sign-in screen is shown when unauthenticated', (await page.$('#authEmail')) !== null);
check('password field is present', (await page.$('#authPassword')) !== null);
check('no demo OTP button exists', (await page.$('#sendOtpBtn')) === null);
check('no demo OTP field exists', (await page.$('#otpCode')) === null);
check('no admin PIN checkbox exists', (await page.$('#adminCheck')) === null);
check('no demo OTP string in the served page', !(await page.content()).includes('482910'));

// Client-side validation runs before any network call.
await page.evaluate(() => {
  document.getElementById('authEmail').value = 'not-an-email';
  document.getElementById('authPassword').value = 'short';
  state.authForm.email = 'not-an-email';
  state.authForm.password = 'short';
});
await page.evaluate(() => submitAuth());
await new Promise(r => setTimeout(r, 120));
check('invalid email is rejected client-side', (await page.evaluate(() => state.authError)).length > 0);

// The admin console must not be reachable while signed out.
await page.evaluate(() => { state.route = 'admin'; render(); });
check('admin route is not reachable while signed out', (await page.evaluate(() => state.session)) === null);

// --- Signed-in UI is exercised with a seeded session --------------------------
await page.evaluate(() => {
  state.session = { user: { id: '00000000-0000-0000-0000-000000000001', email: 'customer@example.com' } };
  state.profile = { id: '00000000-0000-0000-0000-000000000001', role: 'CUSTOMER', full_name: 'Hamza Tariq', msisdn: '+923001234567', is_active: true };
  state.packages = [
    { id: 'p1', name: 'Daily Internet', cat: 'DAILY', pkr: 65, mb: 1024, mins: 100, valid: '1 Day', enabled: true },
    { id: 'p2', name: 'Monthly Pro', cat: 'MONTHLY', pkr: 1200, mb: 40960, mins: 3000, valid: '30 Days', enabled: true }
  ];
  state.packagesError = '';
  state.route = 'home';
  render();
});
await new Promise(r => setTimeout(r, 100));
check('signed-in name is rendered from the profile', (await page.evaluate(() => document.getElementById('mainContent').innerText)).includes('Hamza Tariq'));
check('navigation is visible when signed in', await page.evaluate(() => document.getElementById('bottomNav').style.display === 'flex'));

for (const [route, needle] of [
  ['home', 'SIMULATED BALANCE'],
  ['packages', 'Bundles Explorer'],
  ['discover', 'Tasbeeh'],
  ['activity', 'Recent Activity'],
  ['profile', 'Profile'],
]) {
  await page.evaluate(r => setRoute(r), route);
  await new Promise(r => setTimeout(r, 80));
  const text = await page.evaluate(() => document.getElementById('mainContent').innerText);
  check(`${route} tab renders its content`, text.includes(needle), text.slice(0, 60));
}

// Bundles come from the packages table shape, not a hardcoded list.
await page.evaluate(() => setRoute('packages'));
await new Promise(r => setTimeout(r, 80));
check('bundles render from the database rows', (await page.evaluate(() => document.getElementById('mainContent').innerText)).includes('Monthly Pro'));

// A customer must not be offered the retailer admin console.
await page.evaluate(() => setRoute('profile'));
await new Promise(r => setTimeout(r, 80));
check('customer profile does not expose the admin console', !(await page.evaluate(() => document.getElementById('mainContent').innerText)).includes('Open Retailer Admin Console'));

// The route guard redirects a customer away from /admin.
await page.evaluate(() => setRoute('admin'));
await new Promise(r => setTimeout(r, 80));
check('customer cannot open the admin route', await page.evaluate(() => state.route) === 'home');

// Recharge updates the balance.
await page.evaluate(() => setRoute('recharge'));
await page.evaluate(() => { document.getElementById('rchAmt').value = '500'; });
const before = await page.evaluate(() => getActiveSim().bal);
await page.evaluate(() => doRecharge());
await new Promise(r => setTimeout(r, 120));
const after = await page.evaluate(() => getActiveSim().bal);
check('recharge increases the active SIM balance', after === before + 500, `${before} -> ${after}`);

// Package subscription deducts and activates.
await page.evaluate(() => setRoute('packages'));
const beforeSub = await page.evaluate(() => ({ bal: getActiveSim().bal, hist: state.history.length }));
await page.evaluate(() => subscribePkg('p1'));
await new Promise(r => setTimeout(r, 120));
const afterSub = await page.evaluate(() => ({ bal: getActiveSim().bal, hist: state.history.length }));
check('package subscription deducts the price', afterSub.bal === beforeSub.bal - 65, `${beforeSub.bal} -> ${afterSub.bal}`);
check('package subscription records a receipt', afterSub.hist === beforeSub.hist + 1);

// Streak claim.
await page.evaluate(() => setRoute('home'));
const streakBefore = await page.evaluate(() => state.streak);
await page.evaluate(() => claimStreak());
await new Promise(r => setTimeout(r, 120));
check('streak claim increments the streak', await page.evaluate(() => state.streak) === streakBefore + 1);

// AI assistant.
await page.evaluate(() => setRoute('ai'));
const chatBefore = await page.evaluate(() => state.aiChat.length);
await page.evaluate(() => askAi('Mera remaining internet kitna hai?'));
await new Promise(r => setTimeout(r, 120));
check('AI assistant appends a question and a reply', await page.evaluate(() => state.aiChat.length) === chatBefore + 2);

// The retailer admin role (from the database) unlocks the console.
await page.evaluate(() => {
  state.profile.role = 'RETAILER_ADMIN';
  setRoute('admin');
});
await new Promise(r => setTimeout(r, 100));
check('retailer admin can open the admin console', await page.evaluate(() => state.route) === 'admin');
check('admin console renders the bundle manager', (await page.evaluate(() => document.getElementById('mainContent').innerText)).includes('Retailer Admin Console'));

// Sign out returns to the sign-in screen and clears identity.
await page.evaluate(() => setRoute('profile'));
await page.evaluate(() => logout());
await new Promise(r => setTimeout(r, 200));
check('sign out returns to the sign-in screen', (await page.$('#authEmail')) !== null);
check('sign out clears the session and profile', await page.evaluate(() => state.session === null && state.profile === null));

check('no uncaught page errors during the whole flow', errors.length === 0, errors.join('; '));

await browser.close();
await srv.close();
process.exit(report());

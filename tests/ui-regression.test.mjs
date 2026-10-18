// End-to-end regression for the existing demo UI: demo sign-in, the five primary
// tabs, recharge, package subscription, streak claim, AI assistant, and sign-out.
// Confirms Chapter 1 hardening did not remove working functionality.
//
//   node tests/ui-regression.test.mjs
import { startServer, launchBrowser } from './helpers/browser.mjs';
import { createRunner } from './helpers/runner.mjs';

const { check, report } = createRunner('UI regression (existing demo features)');
const srv = await startServer();
const browser = await launchBrowser();
const page = await browser.newPage();

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', async d => { await d.accept(); });

await page.goto(srv.base, { waitUntil: 'networkidle2' });

// Demo sign-in flow (unchanged behaviour, still test OTP 482910).
check('sign-in screen is shown when unauthenticated', (await page.$('#sendOtpBtn')) !== null);
await page.click('#sendOtpBtn');
check('OTP field appears after requesting OTP', await page.evaluate(() => document.getElementById('otpSection').style.display === 'block'));
await page.type('#loginName', 'Hamza Tariq');
await page.type('#otpCode', '482910');
await page.evaluate(() => verifyOtp());
await new Promise(r => setTimeout(r, 150));
check('demo OTP signs the user in', await page.evaluate(() => document.getElementById('bottomNav').style.display === 'flex'));
check('signed-in name is rendered', (await page.evaluate(() => document.getElementById('mainContent').innerText)).includes('Hamza Tariq'));

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

// Sign out returns to the login screen.
await page.evaluate(() => setRoute('profile'));
await page.evaluate(() => logout());
await new Promise(r => setTimeout(r, 120));
check('sign out returns to the sign-in screen', (await page.$('#sendOtpBtn')) !== null);

check('no uncaught page errors during the whole flow', errors.length === 0, errors.join('; '));

await browser.close();
await srv.close();
process.exit(report());

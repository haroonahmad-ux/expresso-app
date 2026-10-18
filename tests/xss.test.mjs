// XSS regression suite. Proves that attacker-controlled values reaching the DOM
// (via localStorage, the app's only untrusted persistence layer) cannot execute
// script. Execution is detected directly, not by scanning source for keywords.
//
//   node tests/xss.test.mjs
import { startServer, launchBrowser } from './helpers/browser.mjs';
import { createRunner } from './helpers/runner.mjs';

const ROUTES = ['home', 'packages', 'discover', 'activity', 'profile', 'ai', 'recharge'];
const PAYLOADS = [
  '<img src=x onerror="window.__xss=(window.__xss||0)+1">',
  '"><img src=x onerror="window.__xss=(window.__xss||0)+1">',
  "'><img src=x onerror=\"window.__xss=(window.__xss||0)+1\">",
  '</textarea><img src=x onerror="window.__xss=(window.__xss||0)+1">',
  '</script><script>window.__xss=(window.__xss||0)+1</script>',
  '<svg onload="window.__xss=(window.__xss||0)+1"></svg>',
  '<iframe src="javascript:window.__xss=1"></iframe>',
  'javascript:window.__xss=1',
  '<a href="javascript:window.__xss=1">x</a>',
];

const BASE_STATE = {
  auth: true, userName: 'Customer', msisdn: '+923001234567', role: 'CUSTOMER',
  route: 'home', selectedSim: '+923001234567', selectedCat: 'ALL', tasbeeh: 0,
  streak: 4, claimedToday: false,
  sims: [
    { num: '+923001234567', name: 'Primary SIM', bal: 840, dataMb: 28672, totMb: 40960, mins: 2450, sms: 2800 },
    { num: '+923019876543', name: 'Family SIM', bal: 210, dataMb: 0, totMb: 0, mins: 0, sms: 0 },
  ],
  history: [{ id: 'EXP-RCH-8842', type: 'Top-up', amt: 1000, desc: 'Sandbox Wallet Top-up' }],
  aiChat: [{ sender: 'Expresso', text: 'hello' }],
};

// Every user-influenced field that is interpolated into rendered HTML.
const TARGETS = [
  { name: 'userName', apply: (s, v) => { s.userName = v; } },
  { name: 'role', apply: (s, v) => { s.role = v; } },
  { name: 'selectedSim', apply: (s, v) => { s.selectedSim = v; } },
  { name: 'sims[0].name', apply: (s, v) => { s.sims[0].name = v; } },
  { name: 'sims[0].num', apply: (s, v) => { s.sims[0].num = v; } },
  { name: 'sims[1].name', apply: (s, v) => { s.sims[1].name = v; } },
  { name: 'history[0].type', apply: (s, v) => { s.history[0].type = v; } },
  { name: 'history[0].id', apply: (s, v) => { s.history[0].id = v; } },
  { name: 'history[0].desc', apply: (s, v) => { s.history[0].desc = v; } },
  { name: 'aiChat[0].sender', apply: (s, v) => { s.aiChat[0].sender = v; } },
  { name: 'aiChat[0].text', apply: (s, v) => { s.aiChat[0].text = v; } },
];

const { check, report } = createRunner('XSS regression');
const srv = await startServer();

// A fresh browser per target keeps the run within Chromium's per-process page
// budget; a single long-lived browser accumulates 90+ contexts and the renderer
// session is dropped mid-run, which would mask a real result as an error.
async function scanTarget(target) {
  const browser = await launchBrowser();
  let executed = null;
  try {
    for (const payload of PAYLOADS) {
      const page = await browser.newPage();
      const state = JSON.parse(JSON.stringify(BASE_STATE));
      target.apply(state, payload);
      await page.evaluateOnNewDocument(s => {
        localStorage.setItem('expresso_app_state', JSON.stringify(s));
      }, state);
      await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
      for (const route of ROUTES) {
        await page.evaluate(r => { try { setRoute(r); } catch (e) {} }, route);
        await new Promise(res => setTimeout(res, 40));
        const hits = await page.evaluate(() => window.__xss || 0);
        if (hits > 0) { executed = { payload, route }; break; }
      }
      await page.close();
      if (executed) break;
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return executed;
}

for (const target of TARGETS) {
  const executed = await scanTarget(target);
  check(
    `payload in ${target.name} does not execute`,
    executed === null,
    executed ? `executed via ${executed.route} with ${executed.payload}` : ''
  );
}

console.log('\nUntrusted state cannot break rendering');
const browser = await launchBrowser();
for (const [label, mutate] of [
  ['sims: null', s => { s.sims = null; }],
  ['sims: []', s => { s.sims = []; }],
  ['sims: "x"', s => { s.sims = 'x'; }],
  ['history: null', s => { s.history = null; }],
  ['aiChat: null', s => { s.aiChat = null; }],
  ['unknown route', s => { s.route = 'evil'; }],
]) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const state = JSON.parse(JSON.stringify(BASE_STATE));
  mutate(state);
  await page.evaluateOnNewDocument(s => {
    localStorage.setItem('expresso_app_state', JSON.stringify(s));
  }, state);
  await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
  await new Promise(res => setTimeout(res, 150));
  const rendered = await page.evaluate(() => document.getElementById('mainContent').innerHTML.length);
  check(`${label} renders without throwing`, rendered > 0 && errors.length === 0, errors.join('; '));
  await page.close();
}

await browser.close();
await srv.close();
process.exit(report());

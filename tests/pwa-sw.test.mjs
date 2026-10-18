// PWA and service-worker behaviour under the GitHub Pages project path
// (/expresso-app/). Runs against a real Chromium via puppeteer-core.
//
//   node tests/pwa-sw.test.mjs
import { startServer, launchBrowser } from './helpers/browser.mjs';
import { createRunner } from './helpers/runner.mjs';

const { check, report } = createRunner('PWA & service worker (served at /expresso-app/)');
const srv = await startServer();
const browser = await launchBrowser();

// --- Registration, scope, and manifest under the project path ---
{
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(srv.base, { waitUntil: 'networkidle2' });
  const reg = await page.evaluate(() => navigator.serviceWorker.ready.then(r => ({ scope: r.scope, active: !!r.active })));
  check('service worker registers and activates', reg.active === true);
  check('scope is confined to /expresso-app/', new URL(reg.scope).pathname === '/expresso-app/');
  check('app boots without page errors', errors.length === 0, errors.join('; '));

  const manifest = await page.evaluate(async () => {
    const r = await fetch('./manifest.json');
    return { status: r.status, type: r.headers.get('content-type'), body: await r.json() };
  });
  check('manifest.json is reachable from the app', manifest.status === 200);
  check('manifest.json is served as JSON', /application\/json/.test(manifest.type || ''));
  check('manifest start_url resolves inside /expresso-app/', new URL(manifest.body.start_url, srv.base).pathname === '/expresso-app/');

  const icon = await page.evaluate(async () => (await fetch('./icon-192.png')).status);
  check('icon-192.png loads under the project path', icon === 200);

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const c = await caches.open(names.find(n => n.includes('shell')));
    return (await c.keys()).map(r => new URL(r.url).pathname);
  });
  check('app shell is precached', cached.includes('/expresso-app/index.html') && cached.includes('/expresso-app/manifest.json'));
  await page.close();
}

// --- Offline app shell after a successful first visit ---
{
  const page = await browser.newPage();
  await page.goto(srv.base, { waitUntil: 'networkidle2' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await new Promise(r => setTimeout(r, 500));

  await page.setOfflineMode(true);
  const reload = await page.reload({ waitUntil: 'domcontentloaded' }).catch(e => null);
  const title = await page.title().catch(() => '');
  const rendered = await page.evaluate(() => document.getElementById('mainContent')?.innerHTML.length || 0).catch(() => 0);
  check('offline reload still returns a document', reload !== null);
  check('offline reload serves the app shell', title.includes('Expresso') && rendered > 0, `title="${title}" rendered=${rendered}`);
  check('app shell is still interactive offline (nav present)', await page.evaluate(() => !!document.getElementById('bottomNav')).catch(() => false));
  await page.setOfflineMode(false);
  await page.close();
}

// --- Failed network requests do not break the shell ---
{
  const page = await browser.newPage();
  await page.goto(srv.base, { waitUntil: 'networkidle2' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await new Promise(r => setTimeout(r, 400));
  await page.setOfflineMode(true);
  const missing = await page.evaluate(async () => {
    try {
      const r = await fetch('./does-not-exist.png');
      return `status:${r.status}`;
    } catch (e) {
      return 'rejected:' + e.name;
    }
  });
  const stillOk = await page.evaluate(() => document.getElementById('mainContent').innerHTML.length > 0);
  check('missing asset fetch fails cleanly (no hang, no crash)', missing.startsWith('status:404') || missing.startsWith('rejected:'), missing);
  check('app remains rendered after a failed request', stillOk === true);
  await page.setOfflineMode(false);
  await page.close();
}

// --- Cache versioning: a stale v1 cache is evicted by the v2 worker ---
{
  const page = await browser.newPage();
  // Seed an "old release" cache before the current worker activates.
  await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const c = await caches.open('expresso-shell-v1-shell');
    await c.put('./stale-marker', new Response('old'));
  });
  const ctx = await browser.createBrowserContext();
  const p2 = await ctx.newPage();
  await p2.goto(srv.base, { waitUntil: 'networkidle2' });
  await p2.evaluate(() => navigator.serviceWorker.ready);
  await new Promise(r => setTimeout(r, 800));
  const names = await p2.evaluate(() => caches.keys());
  check('current cache version is present', names.includes('expresso-shell-v2-shell'), names.join(', '));
  check('stale cache version is deleted on activate', !names.includes('expresso-shell-v1-shell'), names.join(', '));
  await ctx.close();
  await page.close();
}

// --- Navigation still works after installation ---
{
  const page = await browser.newPage();
  await page.goto(srv.base, { waitUntil: 'networkidle2' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await new Promise(r => setTimeout(r, 400));
  const nav = await page.evaluate(async () => {
    const results = {};
    for (const r of ['home', 'packages', 'discover', 'activity', 'profile']) {
      setRoute(r);
      results[r] = document.getElementById('mainContent').innerHTML.length > 0;
    }
    return results;
  });
  check('all primary routes render after SW install', Object.values(nav).every(Boolean), JSON.stringify(nav));
  await page.close();
}

await browser.close();
await srv.close();
process.exit(report());

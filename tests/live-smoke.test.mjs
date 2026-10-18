// Live deployment smoke test against the GitHub Pages project site.
// Verifies status codes, content types, and that the deployed bytes match the
// working tree. Network access is required; run with `node tests/live-smoke.test.mjs`.
//
//   node tests/live-smoke.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRunner } from './helpers/runner.mjs';

const BASE = process.env.LIVE_BASE || 'https://haroonahmad-ux.github.io/expresso-app/';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const { check, report } = createRunner(`Live deployment smoke (${BASE})`);

const RESOURCES = [
  { path: '', type: /text\/html/, file: 'index.html' },
  { path: 'manifest.json', type: /application\/json/, file: 'manifest.json' },
  { path: 'sw.js', type: /(application|text)\/javascript/, file: 'sw.js' },
  { path: 'icon-192.png', type: /image\/png/, file: 'icon-192.png' },
  { path: 'icon-512.png', type: /image\/png/, file: 'icon-512.png' },
];

let networkOk = true;
for (const res of RESOURCES) {
  const url = BASE + res.path;
  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (e) {
    networkOk = false;
    check(`${res.path || '/'} is reachable`, false, e.message);
    continue;
  }
  const buf = Buffer.from(await response.arrayBuffer());
  check(`${res.path || '/'} returns 200`, response.status === 200, `status=${response.status}`);
  check(`${res.path || '/'} has an expected content type`, res.type.test(response.headers.get('content-type') || ''), response.headers.get('content-type') || '');
  const local = createHash('sha256').update(readFileSync(join(root, res.file))).digest('hex');
  const remote = createHash('sha256').update(buf).digest('hex');
  check(`${res.path || '/'} matches the committed source`, local === remote, `local=${local.slice(0, 12)} remote=${remote.slice(0, 12)}`);
}

if (networkOk) {
  const sw = await (await fetch(BASE + 'sw.js')).text();
  const local = readFileSync(join(root, 'sw.js'), 'utf8');
  check('deployed service worker equals the committed service worker', sw === local);
}

if (!networkOk) console.log('\nNote: live checks could not run (no network access to the deployment).');

process.exit(report());

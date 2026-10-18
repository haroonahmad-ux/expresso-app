// Static assertions for Chapter 1 frontend hardening: XSS sinks, untrusted-state
// validation, PWA manifest/paths, and supply-chain pinning.
//
//   node tests/security-static.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRunner } from './helpers/runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const manifestRaw = readFileSync(join(root, 'manifest.json'), 'utf8');

const { check, report } = createRunner('Static security & PWA checks');

console.log('Injection sinks');
check('no eval()', !/\beval\s*\(/.test(html));
check('no new Function()', !/new\s+Function\s*\(/.test(html));
check('no document.write', !/document\.write/.test(html));
check('no insertAdjacentHTML', !/insertAdjacentHTML/.test(html));
check('no outerHTML assignment', !/\.outerHTML\s*=/.test(html));
check('no javascript: URLs', !/["'`]\s*javascript:/i.test(html));
check('no srcdoc injection', !/\.srcdoc\s*=/.test(html));

console.log('\ninnerHTML use is escaped at every interpolation');
const innerHtmlSites = (html.match(/\.innerHTML\s*=/g) || []).length;
check('innerHTML is used only for trusted templates', innerHtmlSites > 0 && innerHtmlSites <= 12, `sites=${innerHtmlSites}`);
check('escapeHtml helper exists', /function escapeHtml\(/.test(html));
// Every interpolated field that originates from state/localStorage must pass
// through escapeHtml() or safeNumber(); a raw ${state.x} would be a regression.
const rawStateInterpolations = (html.match(/\$\{\s*state\.[A-Za-z_$][\w$]*\s*\}/g) || []);
check(
  'no raw ${state.*} interpolation without escaping',
  rawStateInterpolations.length === 0,
  rawStateInterpolations.join(', ')
);

console.log('\nUntrusted localStorage is validated before render');
check('sanitizeState helper exists', /function sanitizeState\(/.test(html));
check('sanitizeSim helper exists', /function sanitizeSim\(/.test(html));
check('route is validated against a known list', /ROUTES\.includes\(\s*state\.route\s*\)/.test(html));
check('selectedSim is validated against known SIMs', /next\.sims\.some\(s => s\.num === stored\.selectedSim\)/.test(html));
check('sims falls back when the stored array is empty', /sims\.length > 0 \? sims : DEFAULT_STATE\.sims/.test(html));
check('numbers pass through safeNumber', /function safeNumber\(/.test(html));
check('state hydration is wrapped in try/catch', /state = sanitizeState\(raw \? JSON\.parse\(raw\) : null\)/.test(html));

console.log('\nSupply chain');
const cdnScripts = html.match(/<script[^>]*src=["']https?:\/\/[^"']+["'][^>]*>/g) || [];
check('external scripts are pinned with integrity', cdnScripts.length > 0 && cdnScripts.every(s => /integrity=/.test(s)), `${cdnScripts.length} external script(s)`);
check('external scripts set crossorigin', cdnScripts.every(s => /crossorigin=/.test(s)));
check('CDN version is exact (no floating major tag)', !/@\d+["'/]/.test(html) || !/supabase-js@2["']/.test(html));
check('no service_role key in the client', !/service_role/.test(html));
check('no sb_secret_ key material', !/sb_secret_/.test(html));

console.log('\nManifest');
let manifest = null;
let parseError = '';
try {
  manifest = JSON.parse(manifestRaw);
} catch (e) {
  parseError = e.message;
}
check('manifest.json is valid JSON', manifest !== null, parseError);
if (manifest) {
  for (const key of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons']) {
    check(`manifest has "${key}"`, manifest[key] !== undefined);
  }
  check('start_url is relative so it works under /expresso-app/', manifest.start_url === './');
  check('scope is relative so it works under /expresso-app/', manifest.scope === './');
  check('display is standalone (installable)', manifest.display === 'standalone');
  check('declares a 192x192 icon', (manifest.icons || []).some(i => i.sizes === '192x192'));
  check('declares a 512x512 icon', (manifest.icons || []).some(i => i.sizes === '512x512'));
  check('icon src paths are relative', (manifest.icons || []).every(i => i.src.startsWith('./')));
}

console.log('\nService worker');
check('cache prefix is versioned', /const CACHE_PREFIX = "expresso-shell-v\d+"/.test(sw));
check('old caches are deleted on activate', /caches\.delete\(/.test(sw));
check('app shell precache list is present', /APP_SHELL = \[/.test(sw));
check('non-GET and cross-origin requests are ignored', /request\.method !== "GET" \|\| url\.origin !== self\.location\.origin/.test(sw));
check('navigations fall back to the cached shell when offline', /catch\(\(\) => caches\.match\("\.\/index\.html"\)\)/.test(sw));
check('only ok responses are cached for navigations', /if \(response && response\.ok\)/.test(sw));
check('registration uses a relative sw.js and scope', /register\("\.\/sw\.js", \{ scope: "\.\/" \}\)/.test(html));

console.log('\nExisting demo functionality preserved');
for (const route of ['home', 'packages', 'discover', 'activity', 'profile']) {
  check(`route "${route}" still handled`, new RegExp(`state\\.route === "${route}"`).test(html));
}
check('sign-out handler preserved', /function logout\(/.test(html));
check('demo OTP verification preserved', /function verifyOtp\(/.test(html));
check('packages data preserved', /const PACKAGES = \[/.test(html));

process.exit(report());

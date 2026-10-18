// JavaScript syntax validation for the service worker and every inline script
// block in index.html. Uses vm.Script, which parses without executing.
//
//   node tests/syntax.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { createRunner } from './helpers/runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const sw = readFileSync(join(root, 'sw.js'), 'utf8');

const { check, report } = createRunner('JavaScript syntax');

function parses(code) {
  try {
    new vm.Script(code);
    return '';
  } catch (e) {
    return e.message;
  }
}

check('sw.js parses as valid JavaScript', parses(sw) === '', parses(sw));

// Inline <script> blocks (those without a src attribute).
const inlineBlocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
check('index.html contains inline scripts', inlineBlocks.length > 0, `found ${inlineBlocks.length}`);
inlineBlocks.forEach((code, i) => {
  const err = parses(code);
  check(`inline script #${i + 1} parses`, err === '', err);
});

// External script references must be complete enough for the browser to load.
const externals = [...html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)].map(m => m[1]);
check('external script URLs are absolute https', externals.every(u => u.startsWith('https://')), externals.join(', '));
check('external scripts carry a sha384 integrity digest', externals.length === 0 || /integrity="sha384-[A-Za-z0-9+/=]+"/.test(html));

process.exit(report());

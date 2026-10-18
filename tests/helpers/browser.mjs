// Shared real-browser helpers for the Chapter 1 test suite.
// Uses the system Chromium through puppeteer-core (no bundled browser download).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// The app is deployed as a GitHub Pages project site, so it must be served
// from a sub-path. Serving at the origin root would hide base-path defects.
export const BASE_PATH = '/expresso-app';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

export function findChromium() {
  for (const c of CANDIDATES) if (existsSync(c)) return c;
  throw new Error('No Chromium binary found. Set CHROME_PATH.');
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
};

// Minimal static server that mimics GitHub Pages: serves the repo at
// BASE_PATH/ and returns 404 for anything outside it.
export function startServer() {
  const hits = [];
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    hits.push(urlPath);
    if (!urlPath.startsWith(BASE_PATH + '/') && urlPath !== BASE_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    let rel = urlPath.slice(BASE_PATH.length).replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const full = normalize(join(ROOT, rel));
    if (!full.startsWith(normalize(ROOT))) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    try {
      const body = await readFile(full);
      res.writeHead(200, {
        'content-type': TYPES[extname(full)] || 'application/octet-stream',
        'cache-control': 'max-age=600',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        base: `http://127.0.0.1:${port}${BASE_PATH}/`,
        hits,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

export async function launchBrowser() {
  return puppeteer.launch({
    executablePath: findChromium(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-insecure-localhost'],
  });
}

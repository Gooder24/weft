// Shared setup for the accessibility checks: serves app/ on 127.0.0.1 and runs Chromium so that nothing leaves the
// static server. Every request that is not to that origin is aborted; every write (non-GET) is answered with a fake.
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const APP = path.resolve(__dirname, '..', '..', 'app');
const CHROME_CANDIDATES = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webp': 'image/webp' };

function chromePath() {
  const found = process.env.CHROME_PATH || CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) throw new Error('No Chrome/Chromium found: set CHROME_PATH (checked ' + CHROME_CANDIDATES.join(', ') + ')');
  return found;
}

/** Starts the static server on a free port of 127.0.0.1 and returns { base, close }. */
function serveApp() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let file = path.join(APP, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
    if (!file.startsWith(APP + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** Fake answer for a write. The login gets a refusal, so no session is ever created; everything else gets an empty success. */
function fakeWrite(req) {
  const url = new URL(req.url());
  if (url.pathname.endsWith('/login')) {
    return { status: 403, contentType: 'application/json', body: JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'fake: login refused by test harness' }) };
  }
  return { status: 200, contentType: 'application/json', body: '{}' };
}

/** Opens a page on the static app with interception on. Returns { browser, page, base, close }. */
async function openApp() {
  const { base, close: closeServer } = await serveApp();
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    args: process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : ['--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setBypassServiceWorker(true);
  await page.setRequestInterception(true);
  const blocked = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return req.continue();
    if (url.origin !== base) { blocked.push(req.method() + ' ' + req.url()); return req.abort('blockedbyclient'); }
    if (req.method() !== 'GET') return req.respond(fakeWrite(req));
    return req.continue();
  });
  const close = async () => { await browser.close(); await closeServer(); };
  return { browser, page, base, blocked, close };
}

module.exports = { openApp };

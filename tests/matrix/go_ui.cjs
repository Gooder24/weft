// Weft's client against the Matrix bridge in Go (github.com/Gooder24/matrix-matrix), between two throwaway Tuwunel
// homeservers on 127.0.0.1: "weft.test" (Weft's, with the bridge's appservice) and "remote.test" (the other server,
// with Karchi's account there and a friend). Nothing federates and nothing leaves the machine.
//
//   BRIDGE_BIN=/path/to/matrix-matrix TUWUNEL=~/matrix-spike/bin/tuwunel \
//     NODE_PATH=/tmp/acc-test/node_modules tools/browser-slot node tests/matrix/go_ui.cjs
//
// Without BRIDGE_BIN it builds MATRIX_MATRIX (default ~/matrix-matrix) with the `go` on PATH. Checks, all through
// the page: the sign-in form in Slovak, signing in by password, the chat's network, joining a room by #alias, a
// message there and back, a new DM by @name:server, and signing out ending the device on the other server.
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '../..');
const TUWUNEL = (process.env.TUWUNEL || 'tuwunel').replace(/^~/, os.homedir());
const secret = () => crypto.randomBytes(16).toString('hex');
let failed = 0;
const check = (name, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, seconds = 30) {
  const end = Date.now() + seconds * 1e3;
  let v;
  while (Date.now() < end) {
    try { v = await fn(); } catch { v = undefined; }
    if (v) return v;
    await pause(200);
  }
  return v;
}
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'weft-matrix-go-'));
const procs = [];
function start(cmd, args, log) {
  const out = fs.openSync(path.join(base, log), 'a');
  const p = spawn(cmd, args, { stdio: ['ignore', out, out] });
  procs.push(p);
  return p;
}

function homeserver(name, port, token, appservices) {
  fs.mkdirSync(path.join(base, name));
  const conf = path.join(base, name, 'tuwunel.toml');
  fs.writeFileSync(conf, ['[global]', `server_name = "${name}"`, `database_path = "${path.join(base, name, 'db')}"`,
    'address = ["127.0.0.1"]', `port = ${port}`, 'allow_registration = true', `registration_token = "${token}"`,
    'allow_federation = false', 'new_user_displayname_suffix = ""', 'log = "warn"', 'log_colors = false',
    ...(appservices ? [`appservice_dir = "${appservices}"`] : []), ''].join('\n'));
  start(TUWUNEL, ['-c', conf], `${name}.log`);
  return `http://127.0.0.1:${port}`;
}

async function api(url, method, p, body, token) {
  const res = await fetch(url + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function register(url, user, reg) {
  const body = { username: user, password: `pw-${user}-${reg}`, initial_device_display_name: 'test' };
  let r = await api(url, 'POST', '/_matrix/client/v3/register', body);
  if (r.status === 401) r = await api(url, 'POST', '/_matrix/client/v3/register', { ...body, auth: { type: 'm.login.registration_token', token: reg, session: r.data.session } });
  if (r.status !== 200) throw new Error(`register ${user}: ${JSON.stringify(r.data)}`);
  return { id: r.data.user_id, token: r.data.access_token, password: body.password };
}

function bridgeBinary() {
  if (process.env.BRIDGE_BIN) return process.env.BRIDGE_BIN;
  const src = (process.env.MATRIX_MATRIX || '~/matrix-matrix').replace(/^~/, os.homedir());
  const bin = path.join(base, 'matrix-matrix');
  execFileSync('go', ['build', '-o', bin, './cmd/matrix-matrix'], { cwd: src, stdio: 'inherit' });
  return bin;
}

const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', json: 'application/json', png: 'image/png', ico: 'image/x-icon', webp: 'image/webp', woff2: 'font/woff2' };

(async () => {
  let browser;
  try {
    const bin = bridgeBinary();
    const [p1, p2, pb] = [await freePort(), await freePort(), await freePort()];
    const reg = secret();
    const apps = path.join(base, 'appservices');
    fs.mkdirSync(apps);
    const [asToken, hsToken, dpToken, provSecret] = [secret(), secret(), secret(), secret()];
    fs.writeFileSync(path.join(apps, 'matrix.yaml'), `id: matrix
url: http://127.0.0.1:${pb}
as_token: ${asToken}
hs_token: ${hsToken}
sender_localpart: matrixbot
rate_limited: false
receive_ephemeral: true
de.sorunome.msc2409.push_ephemeral: true
namespaces:
  users:
  - regex: '^@matrixbot:weft\\.test$'
    exclusive: true
  - regex: '^@matrix_.*:weft\\.test$'
    exclusive: true
`);
    fs.writeFileSync(path.join(apps, 'doublepuppet.yaml'), `id: doublepuppet
url: null
as_token: ${dpToken}
hs_token: ${secret()}
sender_localpart: doublepuppet
rate_limited: false
namespaces:
  users:
  - regex: '@.*:weft\\.test'
    exclusive: false
`);
    const local = homeserver('weft.test', p1, reg, apps);
    const remote = homeserver('remote.test', p2, reg, null);
    const up = (u) => until(async () => (await fetch(`${u}/_matrix/client/versions`)).ok);
    check('both homeservers start', (await up(local)) && (await up(remote)));
    const karchi = await register(local, 'karchi', reg);
    const there = await register(remote, 'karchi', reg);
    const friend = await register(remote, 'friend', reg);

    // The same settings as asus's ~/matrix-spike/matrix-go/config.yaml, with this test's servers and secrets.
    const config = path.join(base, 'config.yaml');
    fs.writeFileSync(config, `network:
    device_name: Weft
    crypto_dir: ${path.join(base, 'crypto')}
    max_file_size: 26214400
    members_at_once: 20
bridge:
    personal_filtering_spaces: false
    permissions:
        "${karchi.id}": admin
    cleanup_on_logout:
        enabled: true
        manual:
            private: delete
            relayed: delete
            shared_no_users: delete
            shared_has_users: delete
matrix:
    message_status_events: true
database:
    type: sqlite3-fk-wal
    uri: file:${path.join(base, 'bridge.db')}?_txlock=immediate
homeserver:
    address: ${local}
    domain: weft.test
appservice:
    address: http://127.0.0.1:${pb}
    hostname: 127.0.0.1
    port: ${pb}
    id: matrix
    bot:
        username: matrixbot
        displayname: Matrix
    as_token: ${asToken}
    hs_token: ${hsToken}
    username_template: matrix_{{.}}
double_puppet:
    secrets:
        weft.test: as_token:${dpToken}
provisioning:
    shared_secret: ${provSecret}
    allow_matrix_auth: true
backfill:
    enabled: false
logging:
    min_level: debug
    writers:
    - type: stdout
      format: json
`);
    start(bin, ['-c', config, '-n'], 'bridge.log');
    const PROV = `http://127.0.0.1:${pb}/_matrix/provision/v3`;
    check('the bridge starts', await until(async () => (await fetch(`${PROV}/whoami?user_id=${encodeURIComponent(karchi.id)}`, { headers: { Authorization: `Bearer ${karchi.token}` } })).ok));

    // Weft as on asus: the app from this tree, the homeserver behind it, /_bridges/matrix/ to the bridge; every other
    // Weft service answers 404 (not offered).
    // A copy of app/ with one test-only line that hands the page's state to the checks.
    const stage = path.join(base, 'app');
    fs.cpSync(process.env.APP_DIR || path.join(ROOT, 'app'), stage, { recursive: true }); // APP_DIR: another tree's app/
    fs.appendFileSync(path.join(stage, 'app.js'), '\nwindow.__weft = { S, LINKS, startLink, unlink };\n');
    browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--lang=sk-SK'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept());
    await page.setViewport({ width: 1342, height: 800 });
    await page.evaluateOnNewDocument((t, u) => {
      if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new Error('test'));
      localStorage.setItem('ep_token', t); localStorage.setItem('ep_user', u); localStorage.setItem('ep_show_all', '1');
    }, karchi.token, karchi.id);
    await page.setRequestInterception(true);
    page.on('request', async (r) => {
      const u = new URL(r.url());
      if (u.origin !== local) return r.continue();
      if (u.pathname.startsWith('/_bridges/matrix/')) {
        try {
          const res = await fetch(`http://127.0.0.1:${pb}${u.pathname.slice('/_bridges/matrix'.length)}${u.search}`, {
            method: r.method(), headers: r.headers(), body: r.postData() ?? undefined,
          });
          return r.respond({ status: res.status, contentType: res.headers.get('content-type') || 'application/json', body: Buffer.from(await res.arrayBuffer()) });
        } catch (err) { return r.respond({ status: 502, body: String(err) }); }
      }
      if (u.pathname.startsWith('/_matrix/')) return r.continue();
      if (u.pathname.startsWith('/_') || u.pathname === '/release.json') return r.respond({ status: 404, contentType: 'application/json', body: '{"errcode":"M_NOT_FOUND"}' });
      const file = path.join(stage, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1)));
      if (file.startsWith(stage) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return r.respond({ status: 200, contentType: TYPES[file.split('.').pop()] || 'application/octet-stream', body: fs.readFileSync(file) });
      }
      return r.respond({ status: 404, body: '' });
    });
    await page.goto(`${local}/`, { waitUntil: 'domcontentloaded' });
    const ready = await until(() => page.evaluate(() => !!document.querySelector('.compose, .inbox, .rooms, main')), 30);
    check('Weft opens', !!ready);

    // Settings → Účty → Matrix → Pripojiť.
    const opened = await until(() => page.evaluate(() => {
      const w = window.__weft;
      if (!w) return false;
      const app = w.LINKS.find((a) => a.id === 'matrix');
      if (!w.S.links || !('matrix' in w.S.links)) return false;
      w.startLink(app);
      return true;
    }), 30);
    check('the Matrix sign-in starts', !!opened);
    await until(() => page.$('input[name=username]'), 20);
    const form = await page.evaluate(() => ({
      labels: [...document.querySelectorAll('form.inpanel label')].map((l) => l.firstChild?.textContent?.trim()),
      text: document.querySelector('form.inpanel')?.innerText || '',
    }));
    check('the sign-in form speaks Slovak', ['Server', 'Používateľ', 'Heslo'].every((x) => form.labels.includes(x)) && form.text.includes('Weft si pridá vlastné zariadenie'), JSON.stringify(form.labels));
    await page.type('input[name=homeserver]', remote);
    await page.type('input[name=username]', there.id);
    await page.type('input[name=password]', there.password);
    await page.keyboard.press('Enter');
    const login = await until(() => page.evaluate(() => {
      const l = window.__weft.S.links?.matrix?.[0];
      return l?.state?.state_event === 'CONNECTED' ? l : null;
    }), 60);
    check('signing in by password connects the account', !!login, JSON.stringify(login?.state?.state_event));
    const devices = async () => (await api(remote, 'GET', '/_matrix/client/v3/devices', undefined, there.token)).data.devices || [];
    check('the bridge has its own device "Weft" there', (await devices()).some((d) => d.display_name === 'Weft'));

    // Joining a room there by its #alias (Ctrl+N), a message each way.
    const lobby = (await api(remote, 'POST', '/_matrix/client/v3/createRoom', { preset: 'public_chat', room_alias_name: 'lobby', name: 'Lobby' }, friend.token)).data.room_id;
    await page.keyboard.down('Control'); await page.keyboard.press('n'); await page.keyboard.up('Control');
    await until(() => page.$('.cmd.new .cmdinput'), 10);
    await page.type('.cmd.new .cmdinput', '#lobby:remote.test');
    await pause(300);
    await page.keyboard.press('Enter');
    const joined = await until(() => page.evaluate(() => {
      const { S } = window.__weft;
      const r = S.selected && S.rooms.get(S.selected);
      return r && r.app === 'matrix' && document.body.innerText.includes('Lobby') ? S.selected : null;
    }), 45);
    const seen = () => page.evaluate(() => {
      const { S } = window.__weft;
      return JSON.stringify({ selected: S.selected, rooms: [...S.rooms.values()].map((r) => [r.id, r.app, r.name]) });
    });
    check('Ctrl+N joins #lobby:remote.test and opens it as a Matrix chat', !!joined, joined ? '' : await seen());
    await api(remote, 'PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(lobby)}/send/m.room.message/t1`, { msgtype: 'm.text', body: 'Ahoj z druhej strany' }, friend.token);
    check('a message there shows in Weft', !!(await until(() => page.evaluate(() => document.body.innerText.includes('Ahoj z druhej strany')), 30)));
    await page.focus(`textarea[data-root="${joined}"]`);
    await page.keyboard.type('Odpoveď z Weftu');
    await page.keyboard.press('Enter');
    const arrived = await until(async () => {
      const m = await api(remote, 'GET', `/_matrix/client/v3/rooms/${encodeURIComponent(lobby)}/messages?dir=b&limit=20`, undefined, friend.token);
      return (m.data.chunk || []).find((e) => e.content?.body === 'Odpoveď z Weftu' && e.sender === there.id);
    }, 30);
    check('a message from Weft arrives there as Karchi', !!arrived);
    // The bridge's send status turns the plane into ✓ beside it (sendMark in app.js).
    const tick = await until(() => page.evaluate(() => [...document.querySelectorAll('.msg.mine')].some((m) => m.textContent.includes('Odpoveď z Weftu') && m.querySelector('.mstate.sent, .mstate.delivered, .mstate.seen'))), 30);
    check('the bridge\'s send status gives it ✓ in Weft', !!tick);
    const features = await page.evaluate((room) => [...(window.__weft.S.rooms.get(room)?.state?.keys() || [])].some((k) => k.startsWith('com.beeper.room_features')), joined);
    check('the chat carries the bridge\'s room features', features);

    // A new DM by @name:server.
    await page.keyboard.down('Control'); await page.keyboard.press('n'); await page.keyboard.up('Control');
    await until(() => page.$('.cmd.new .cmdinput'), 10);
    await page.type('.cmd.new .cmdinput', friend.id);
    await pause(300);
    await page.keyboard.press('Enter');
    const dm = await until(() => page.evaluate((lobbyRoom) => {
      const { S } = window.__weft;
      return S.selected && S.selected !== lobbyRoom && S.rooms.get(S.selected)?.app === 'matrix' ? S.selected : null;
    }, joined), 45);
    check('Ctrl+N starts a DM with @friend:remote.test', !!dm);
    const invited = await until(async () => {
      const s = await api(remote, 'GET', '/_matrix/client/v3/sync?timeout=0', undefined, friend.token);
      return Object.keys(s.data.rooms?.invite || {}).length > 0;
    }, 30);
    check('the friend is invited there', !!invited);

    // Signing out ends the device there.
    await page.evaluate(() => { const w = window.__weft; const app = w.LINKS.find((a) => a.id === 'matrix'); return w.unlink(app, w.S.links.matrix[0]); });
    const out = await until(() => page.evaluate(() => window.__weft.S.links?.matrix?.length === 0), 30);
    check('signing out leaves no Matrix account in Weft', !!out);
    check('signing out ends the device "Weft" there', !!(await until(async () => !(await devices()).some((d) => d.display_name === 'Weft'), 40)));
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (err) {
    check('the run finishes', false, err.stack || String(err));
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const p of procs) p.kill('SIGTERM');
    await pause(500);
    if (failed && process.env.KEEP_LOGS) fs.cpSync(base, process.env.KEEP_LOGS, { recursive: true });
    fs.rmSync(base, { recursive: true, force: true });
    console.log(failed ? `${failed} FAILED` : 'all passed');
    process.exit(failed ? 1 : 0);
  }
})();

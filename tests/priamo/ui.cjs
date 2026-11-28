// Weft Priamo in Weft's client (docs/navrhy/2026-11-priamo/, step 3): the Matrix bridge (github.com/Gooder24/matrix-matrix)
// signed in to two accounts of Karchi, one on "remote.test" (another Matrix server, like matrix.org) and one on a Priamo
// server named "[201:db8::1]", the way a Yggdrasil address names it. Bea has an account on both. Four throwaway
// Tuwunels on 127.0.0.1 would be too many: Weft's own "weft.test" with the bridge, and the two others; nothing
// federates and nothing leaves the machine.
//
//   BRIDGE_BIN=/path/to/matrix-matrix TUWUNEL=~/matrix-spike/bin/tuwunel \
//     NODE_PATH=/tmp/acc-test/node_modules tools/browser-slot node tests/priamo/ui.cjs
//
// Checks, through the page: Bea's invitation on Priamo is taken (and the one on remote.test is not), her Priamo chat is
// the network "Priamo", it merges with her Matrix chat by her name, a message from Weft goes through Priamo although she
// last wrote on Matrix, with the Priamo server down it goes the other way, and Ctrl+N offers a Priamo address only
// through the Priamo account.
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '../..');
const TUWUNEL = (process.env.TUWUNEL || 'tuwunel').replace(/^~/, os.homedir());
const PRIAMO = '[201:db8::1]';
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'weft-priamo-'));
const procs = [];
function start(cmd, args, log) {
  const out = fs.openSync(path.join(base, log), 'a');
  const p = spawn(cmd, args, { stdio: ['ignore', out, out] });
  procs.push(p);
  return p;
}

function homeserver(name, port, token, appservices) {
  const dir = path.join(base, name.replace(/[^a-z0-9.]/gi, '_'));
  fs.mkdirSync(dir);
  const conf = path.join(dir, 'tuwunel.toml');
  fs.writeFileSync(conf, ['[global]', `server_name = "${name}"`, `database_path = "${path.join(dir, 'db')}"`,
    'address = ["127.0.0.1"]', `port = ${port}`, 'allow_registration = true', `registration_token = "${token}"`,
    'allow_federation = false', 'new_user_displayname_suffix = ""', 'log = "warn"', 'log_colors = false',
    ...(appservices ? [`appservice_dir = "${appservices}"`] : []), ''].join('\n'));
  const proc = start(TUWUNEL, ['-c', conf], `${path.basename(dir)}.log`);
  return { url: `http://127.0.0.1:${port}`, proc };
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

async function register(url, user, reg, name) {
  const body = { username: user, password: `pw-${user}-${reg}`, initial_device_display_name: 'test' };
  let r = await api(url, 'POST', '/_matrix/client/v3/register', body);
  if (r.status === 401) r = await api(url, 'POST', '/_matrix/client/v3/register', { ...body, auth: { type: 'm.login.registration_token', token: reg, session: r.data.session } });
  if (r.status !== 200) throw new Error(`register ${user}: ${JSON.stringify(r.data)}`);
  const me = { id: r.data.user_id, token: r.data.access_token, password: body.password, url };
  if (name) await api(url, 'PUT', `/_matrix/client/v3/profile/${encodeURIComponent(me.id)}/displayname`, { displayname: name }, me.token);
  return me;
}
const send = (who, room, body) => api(who.url, 'PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${secret()}`, { msgtype: 'm.text', body }, who.token);
const bodies = async (who, room) => ((await api(who.url, 'GET', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages?dir=b&limit=50`, undefined, who.token)).data.chunk || [])
  .filter((e) => e.type === 'm.room.message').map((e) => e.content.body);
// The bridge made her Matrix chat encrypted, and she reads it without keys: what counts there is that Karchi sent.
const fromHim = async (who, room, him) => ((await api(who.url, 'GET', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages?dir=b&limit=50`, undefined, who.token)).data.chunk || [])
  .filter((e) => e.sender === him && (e.type === 'm.room.message' || e.type === 'm.room.encrypted')).length;
const invites = async (who) => Object.keys((await api(who.url, 'GET', '/_matrix/client/v3/sync?timeout=0', undefined, who.token)).data.rooms?.invite || {});

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
    const [p1, p2, p3, pb] = [await freePort(), await freePort(), await freePort(), await freePort()];
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
    const local = homeserver('weft.test', p1, reg, apps).url;
    const remote = homeserver('remote.test', p2, reg, null).url;
    const priamoHs = homeserver(PRIAMO, p3, reg, null);
    const priamo = priamoHs.url;
    const up = (u) => until(async () => (await fetch(`${u}/_matrix/client/versions`)).ok);
    check('the three homeservers start', (await up(local)) && (await up(remote)) && (await up(priamo)));
    const karchi = await register(local, 'karchi', reg);
    const karchiThere = await register(remote, 'karchi', reg);
    const karchiPriamo = await register(priamo, 'karchi', reg);
    const bea = await register(remote, 'bea', reg, 'Bea Nová');
    const beaPriamo = await register(priamo, 'bea', reg, 'Bea Nová');

    // asus's ~/matrix-spike/matrix-go/config.yaml, with accept_invites_on naming the Priamo server.
    const config = path.join(base, 'config.yaml');
    fs.writeFileSync(config, `network:
    device_name: Weft
    crypto_dir: ${path.join(base, 'crypto')}
    max_file_size: 26214400
    members_at_once: 20
    accept_invites_on: ["${priamo}"]
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
    const prov = async (method, p, body) => {
      const res = await fetch(`${PROV}${p}${p.includes('?') ? '&' : '?'}user_id=${encodeURIComponent(karchi.id)}`, {
        method, headers: { Authorization: `Bearer ${karchi.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(data)}`);
      return data;
    };
    check('the bridge starts', await until(async () => !!(await prov('GET', '/whoami'))));
    // Both accounts signed in the way Settings → Účty → Matrix does it (tests/matrix/go_ui.cjs checks that form).
    for (const [hs, who] of [[remote, karchiThere], [priamo, karchiPriamo]]) {
      const first = await prov('POST', '/login/start/password', {});
      const done = await prov('POST', `/login/step/${first.login_id}/${first.step_id}/user_input`, { homeserver: hs, username: who.id, password: who.password });
      if (done.type !== 'complete') throw new Error(`sign-in ${who.id}: ${JSON.stringify(done)}`);
    }
    const connected = await until(async () => {
      const logins = (await prov('GET', '/whoami')).logins || [];
      return logins.length === 2 && logins.every((l) => l.state?.state_event === 'CONNECTED') ? logins : null;
    }, 60);
    check('both accounts connect', !!connected);
    const priamoLoginId = connected?.find((l) => l.id.endsWith(`:${PRIAMO}`))?.id;

    // Bea's chats: on remote.test the bridge starts it (an invitation there is never taken), on Priamo she invites.
    const strange = (await api(remote, 'POST', '/_matrix/client/v3/createRoom', { preset: 'trusted_private_chat', is_direct: true, invite: [karchiThere.id] }, bea.token)).data.room_id;
    const mxRoom = (await prov('POST', `/create_dm/${encodeURIComponent(bea.id)}?login_id=${encodeURIComponent(connected[0].id === priamoLoginId ? connected[1].id : connected[0].id)}`, {})).dm_room_mxid;
    const beaRooms = await until(async () => { const inv = await invites(bea); return inv.length ? inv : null; }, 30);
    for (const room of beaRooms || []) await api(remote, 'POST', `/_matrix/client/v3/join/${encodeURIComponent(room)}`, {}, bea.token);
    const pRoom = (await api(priamo, 'POST', '/_matrix/client/v3/createRoom', { preset: 'trusted_private_chat', is_direct: true, invite: [karchiPriamo.id] }, beaPriamo.token)).data.room_id;
    const joinedP = await until(async () => {
      const m = await api(priamo, 'GET', `/_matrix/client/v3/rooms/${encodeURIComponent(pRoom)}/joined_members`, undefined, beaPriamo.token);
      return Object.keys(m.data.joined || {}).includes(karchiPriamo.id);
    }, 30);
    check('Bea\'s invitation on the Priamo server is taken', !!joinedP);
    await send(beaPriamo, pRoom, 'Ahoj cez Priamo');
    await pause(1500); // her Matrix message is the newer one: Weft must still answer through Priamo
    const thereRooms = (await api(remote, 'GET', '/_matrix/client/v3/joined_rooms', undefined, bea.token)).data.joined_rooms || [];
    const beaMx = thereRooms.find((r) => r !== strange) || '';
    await send(bea, beaMx, 'Ahoj z Matrixu');
    const strangeMembers = (await api(remote, 'GET', `/_matrix/client/v3/rooms/${encodeURIComponent(strange)}/joined_members`, undefined, bea.token)).data.joined || {};
    check('her invitation on remote.test is not taken', !(karchiThere.id in strangeMembers));

    // Weft as on asus.
    const stage = path.join(base, 'app');
    fs.cpSync(process.env.APP_DIR || path.join(ROOT, 'app'), stage, { recursive: true });
    fs.appendFileSync(path.join(stage, 'app.js'), '\nwindow.__weft = { S, select, mergeData, refreshLinks, render, downAccounts };\n');
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
    check('Weft opens', !!(await until(() => page.evaluate(() => !!window.__weft?.S.homeSynced), 40)));

    const nets = await until(() => page.evaluate(() => {
      const nets = [...window.__weft.S.rooms.values()].filter((r) => r.app === 'priamo' || r.app === 'matrix').map((r) => [r.id, r.app]);
      return nets.length >= 2 ? nets : null;
    }), 45);
    const pPortal = nets?.find(([, a]) => a === 'priamo')?.[0];
    const mPortal = nets?.find(([, a]) => a === 'matrix')?.[0];
    check('her Priamo chat is the network Priamo, her other one Matrix', !!pPortal && !!mPortal, JSON.stringify(nets));
    const group = await until(() => page.evaluate((a, b) => (window.__weft.mergeData().groups || []).find((g) => g.rooms.includes(a) && g.rooms.includes(b)) || null, pPortal, mPortal), 30);
    check('the two merge into one chat by her name', !!group);
    const row = await page.evaluate(() => [...document.querySelectorAll('[data-key^="merge:"]')].map((e) => e.innerText).join(' | '));
    check('the inbox row says Priamo', /Priamo/.test(row) || !!(await page.$('[data-key^="merge:"] img[src$="priamo.svg"]')), row.slice(0, 200));

    // Weft answers in the merged chat: through Priamo, though her newest message came on Matrix.
    const say = async (text) => {
      await page.evaluate((id) => { window.__weft.select(`merge:${id}`); window.__weft.render(); }, group.id);
      const box = await until(() => page.evaluate(() => {
        const room = window.__weft.S.selected;
        return document.querySelector(`textarea[data-root="${room}"]`) ? room : null;
      }), 15);
      await page.focus(`textarea[data-root="${box}"]`);
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
      return box;
    };
    const before = await fromHim(bea, beaMx, karchiThere.id);
    await say('Odpoveď cez Priamo');
    const viaPriamo = await until(async () => (await bodies(beaPriamo, pRoom)).includes('Odpoveď cez Priamo'), 30);
    check('a message from Weft goes through Priamo', !!viaPriamo);
    await pause(2000); // a copy through Matrix would be there by now
    check('and not through Matrix', (await fromHim(bea, beaMx, karchiThere.id)) === before);

    // The Priamo server down: the account is not connected, and Weft writes the usual way.
    priamoHs.proc.kill('SIGTERM');
    const down = await until(async () => {
      await page.evaluate(() => window.__weft.refreshLinks());
      return page.evaluate((id) => window.__weft.S.links.matrix?.find((l) => l.id === id)?.state?.state_event !== 'CONNECTED', priamoLoginId);
    }, 60);
    check('with the Priamo server down its account is not connected', !!down);
    await page.evaluate(() => { window.__weft.S.selected = null; });
    const second = await say('Odpoveď bez Priamo');
    const viaMatrix = await until(async () => (await fromHim(bea, beaMx, karchiThere.id)) > before, 30);
    check('then the message goes through Matrix', !!viaMatrix, viaMatrix ? '' : `${second === mPortal ? 'Matrix' : second === pPortal ? 'Priamo' : second} chosen, ${await page.evaluate(() => JSON.stringify(window.__weft.downAccounts().map((d) => d.id)))}`);

    // Ctrl+N: a Priamo address through the Priamo account.
    await page.keyboard.down('Control'); await page.keyboard.press('n'); await page.keyboard.up('Control');
    await until(() => page.$('.cmd.new .cmdinput'), 10);
    await page.type('.cmd.new .cmdinput', `@cyril:${PRIAMO}`);
    const offer = await until(() => page.evaluate(() => document.querySelector('.cmd.new')?.innerText.includes('Nový chat cez Priamo s')), 10);
    check('Ctrl+N offers a chat through Priamo for a Priamo address', !!offer);
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

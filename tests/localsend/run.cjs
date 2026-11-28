// The board's LocalSend (desktop/localsend.js) against itself and against a fake HTTPS receiver that answers the
// way the LocalSend app does. Everything listens on 127.0.0.1; nothing leaves the machine.
// Usage: node tests/localsend/run.cjs   (needs openssl for the HTTPS receiver's certificate)
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createPeer, tailnetIp, safeParts, derInt } = require('../../desktop/localsend.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weft-localsend-'));
const API = '/api/localsend/v2';
let failed = 0;
const results = [];
// A request a check started but did not wait for yet must not end the run unnamed: it counts as a failure.
process.on('unhandledRejection', (err) => { failed++; results.push(`FAIL a request nobody waited for: ${err.stack || err}`); });
/** A request a check waits for only later: its failure then fails that check, not the whole run. */
const later = (p) => { p.catch(() => {}); return p; };
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); } catch (err) { failed++; results.push(`FAIL ${name}: ${err.stack || err}`); }
}
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setImmediate(r));
  }
};
const freePort = () => new Promise((resolve) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
/** A request to a board as a LocalSend sender without a certificate would make it (the board speaks HTTPS). */
const raw = (port, method, p, body, tls = {}) => new Promise((resolve, reject) => {
  const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const req = https.request({ host: '127.0.0.1', port, method, path: p, rejectUnauthorized: false, agent: false, ...tls, headers: { 'Content-Length': data ? data.length : 0 } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => { const t = Buffer.concat(chunks).toString(); let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, data: j }); });
  });
  req.on('error', reject);
  req.end(data);
});

const raw2 = (port) => raw(port, 'GET', `${API}/info`);
/** Holds the first call of obj[key] that pick(args) chooses until release(), the way a slow disk would; inside
 *  resolves once it is held. Async functions only; restore() puts the original back. */
function hold(obj, key, pick) {
  const orig = obj[key];
  let entered, release, held = false;
  const inside = new Promise((r) => { entered = r; });
  const gate = new Promise((r) => { release = r; });
  obj[key] = async (...args) => { if (!held && pick(...args)) { held = true; entered(); await gate; } return orig.apply(obj, args); };
  return { inside, release, restore: () => { release(); obj[key] = orig; } };
}
/** A board off the local network whose own address is at.ip (a test may change it) and whose senders are all its own. */
async function lone(name, at = { ip: '127.0.0.250' }) {
  const events = [];
  const k = createPeer({ dir: path.join(tmp, name, 'in'), statePath: path.join(tmp, `${name}.json`), alias: `Weft ${name}`, lan: false, hosts: ['127.0.0.1'],
    port: await freePort(), trusted: () => true, tailnet: async () => ({ self: at.ip, peers: [] }), onEvent: (ev) => events.push(ev), log: () => {} });
  await k.start();
  return Object.assign(k, { inbox: path.join(tmp, name, 'in'), events, saved: () => { try { return JSON.parse(fs.readFileSync(path.join(tmp, `${name}.json`), 'utf8')); } catch { return { items: [] }; } } }); // not yet written, or being written
}
const twoFiles = (fp) => ({ info: { alias: 'mobil', fingerprint: fp }, files: { a: { id: 'a', fileName: 'a.txt', size: 1, fileType: 'text/x' }, b: { id: 'b', fileName: 'b.txt', size: 1, fileType: 'text/x' } } });
const uploadTo = (k, prep, id, body, host = '127.0.0.1') => raw(k.port, 'POST', `${API}/upload?sessionId=${prep.data.sessionId}&fileId=${id}&token=${prep.data.files[id]}`, Buffer.from(body), { host });
const left = (k) => fs.readdirSync(k.inbox).filter((n) => n.includes('a.txt'));
/** A peer on 127.0.0.1 whose tailnet is the given ports' peers (its own Tailscale address stands in as 127.0.0.250);
 *  off the local network, so nothing reaches a real one. */
async function peer(name, { trusted = () => true, peers = [], probePort, port } = {}) {
  const events = [];
  const p = createPeer({
    dir: path.join(tmp, name, 'in'), statePath: path.join(tmp, `${name}.json`), alias: `Weft ${name}`, lan: false,
    tailnet: async () => ({ self: '127.0.0.250', peers }), hosts: ['127.0.0.1'], trusted, probePort, port: port || await freePort(),
    onEvent: (ev) => events.push(ev), log: () => {},
  });
  await p.start();
  return Object.assign(p, { events, name });
}
const sendFile = (name, data) => {
  const file = path.join(tmp, 'src', crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return { path: file, name, size: data.length, type: 'application/octet-stream' };
};
const item = (p, id) => p.state().items.find((x) => x.id === id);
const settled = (p, id) => until(() => { const it = item(p, id); return it && !['sending', 'receiving'].includes(it.status) && it; });

(async () => {
  const a = await peer('a');
  const b = await peer('b', { peers: [{ ip: '127.0.0.1', online: true }], probePort: a.port });

  await check('names never leave the folder', () => {
    assert.deepEqual(safeParts('../../etc/passwd'), ['etc', 'passwd']);
    assert.deepEqual(safeParts('/abs/x'), ['abs', 'x']);
    assert.deepEqual(safeParts('..'), ['subor']);
    assert.deepEqual(safeParts('.bashrc'), ['_bashrc']);
    assert.deepEqual(safeParts('a\\b/c.txt'), ['a', 'b', 'c.txt']);
    assert.equal(tailnetIp('100.101.102.103'), true);
    assert.equal(tailnetIp('100.128.0.1'), false);
    assert.equal(tailnetIp('192.168.1.5'), false);
  });

  await check('its fingerprint is its certificate\'s SHA-256, as LocalSend\'s', async () => {
    const r = await new Promise((resolve, reject) => https.get({ host: '127.0.0.1', port: a.port, path: `${API}/info`, rejectUnauthorized: false, agent: false }, (res) => {
      resolve({ cert: res.socket.getPeerCertificate().raw, status: res.statusCode }); res.resume();
    }).on('error', reject));
    assert.equal(r.status, 200);
    assert.equal(a.info().fingerprint, crypto.createHash('sha256').update(r.cert).digest('hex').toUpperCase());
    assert.equal(a.info().protocol, 'https');
  });

  await check('finds a LocalSend device of the tailnet over HTTPS and makes it a default', async () => {
    await b.scan();
    const devs = b.state().devices;
    assert.equal(devs.length, 1);
    assert.equal(devs[0].alias, 'Weft a');
    assert.equal(devs[0].protocol, 'https');
    assert.equal(devs[0].fingerprint, a.info().fingerprint);
    assert.equal(devs[0].default, true);
    assert.equal(devs[0].online, true);
    // a heard of b through its register call
    assert.equal(a.state().devices[0]?.alias, 'Weft b');
  });

  await check('files reach the default device, in folders, without climbing out', async () => {
    const big = crypto.randomBytes(1 << 20);
    const r = await b.send({ files: [sendFile('notes.txt', Buffer.from('ahoj')), sendFile('../../evil.txt', Buffer.from('x')), sendFile('sub/dir/big.bin', big)] });
    assert.ok(r.id);
    const out = await settled(b, r.id);
    assert.equal(out.status, 'done', JSON.stringify(out.targets));
    assert.equal(out.got, 4 + 1 + big.length);
    const got = await until(() => a.state().items.find((x) => x.dir === 'in' && x.status === 'done' && x.files?.length === 3));
    const dir = path.join(tmp, 'a', 'in');
    assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'ahoj');
    assert.equal(fs.readFileSync(path.join(dir, 'evil.txt'), 'utf8'), 'x');
    assert.ok(fs.readFileSync(path.join(dir, 'sub', 'dir', 'big.bin')).equals(big));
    assert.ok(!fs.existsSync(path.join(tmp, 'evil.txt')));
    assert.deepEqual(got.files.map((f) => f.name), ['notes.txt', 'evil.txt', path.join('sub', 'dir', 'big.bin')]);
    assert.equal(got.device.alias, 'Weft b');
    assert.equal(a.fileOf(got.id, 2), path.join(dir, 'sub', 'dir', 'big.bin'));
    assert.ok(a.events.some((e) => e.type === 'arrived' && e.item.id === got.id), 'the window hears of it');
    assert.ok(fs.readdirSync(dir).every((n) => !n.endsWith('.part')));
  });

  await check('a folder that is a link out of the downloads gets nothing; a file named like a staging one stays', async () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(tmp, 'a', 'in', 'odkaz'));
    const r = await b.send({ files: [sendFile('odkaz/hlbšie/von.txt', Buffer.from('von'))] });
    assert.notEqual((await settled(b, r.id)).status, 'done');
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing made behind the link');
    fs.writeFileSync(path.join(tmp, 'a', 'in', 'drz.txt.part'), 'moje');
    const k = await b.send({ files: [sendFile('drz.txt', Buffer.from('nové'))] });
    assert.equal((await settled(b, k.id)).status, 'done');
    assert.equal(fs.readFileSync(path.join(tmp, 'a', 'in', 'drz.txt.part'), 'utf8'), 'moje');
    assert.equal(fs.readFileSync(path.join(tmp, 'a', 'in', 'drz.txt'), 'utf8'), 'nové');
    assert.deepEqual(fs.readdirSync(path.join(tmp, 'a', 'in')).filter((n) => n.endsWith('.part') && n !== 'drz.txt.part'), []);
  });

  await check('the same name again gets „ (1)“', async () => {
    const r = await b.send({ files: [sendFile('notes.txt', Buffer.from('druhy'))] });
    assert.equal((await settled(b, r.id)).status, 'done');
    assert.equal(fs.readFileSync(path.join(tmp, 'a', 'in', 'notes (1).txt'), 'utf8'), 'druhy');
  });

  await check('a text arrives as text, nothing is uploaded', async () => {
    const r = await b.send({ text: 'kód 1234 a odkaz https://example.com' });
    assert.equal((await settled(b, r.id)).status, 'done');
    const got = a.state().items.find((x) => x.dir === 'in' && x.text);
    assert.equal(got.text, 'kód 1234 a odkaz https://example.com');
    assert.equal(got.status, 'done');
  });

  await check('a device outside the tailnet waits for Prijať: no means 403, yes receives', async () => {
    const c = await peer('c', { trusted: () => false });
    // b hears c's multicast announcement (c is on the local network only)
    b.onMulticast(Buffer.from(JSON.stringify({ ...c.info(), announce: false })), { address: '127.0.0.1' });
    const cfp = c.info().fingerprint;
    const no = await b.send({ files: [sendFile('ask.txt', Buffer.from('1'))], to: [cfp] });
    const ask = await until(() => c.state().ask);
    assert.equal(ask.count, 1);
    assert.deepEqual(ask.names, ['ask.txt']);
    c.respond(ask.id, false);
    assert.equal((await settled(b, no.id)).status, 'declined');
    const yes = await b.send({ files: [sendFile('ask.txt', Buffer.from('2'))], to: [cfp] });
    c.respond((await until(() => c.state().ask)).id, true);
    assert.equal((await settled(b, yes.id)).status, 'done');
    assert.equal(fs.readFileSync(path.join(tmp, 'c', 'in', 'ask.txt'), 'utf8'), '2');
    await c.stop();
  });

  await check('one session at a time; cancel frees it and drops the half file', async () => {
    const body = (n) => ({ info: { alias: 'raw', fingerprint: 'raw-fp', port: 1, protocol: 'http' }, files: { f1: { id: 'f1', fileName: `half${n}.bin`, size: 10, fileType: 'application/octet-stream' } } });
    const p1 = await raw(a.port, 'POST', `${API}/prepare-upload`, body(1));
    assert.equal(p1.status, 200);
    assert.ok(p1.data.sessionId && p1.data.files.f1);
    assert.equal((await raw(a.port, 'POST', `${API}/prepare-upload`, body(2))).status, 409);
    assert.equal((await raw(a.port, 'POST', `${API}/upload?sessionId=${p1.data.sessionId}&fileId=f1&token=wrong`, Buffer.from('x'))).status, 403);
    assert.equal((await raw(a.port, 'POST', `${API}/upload?sessionId=${p1.data.sessionId}`, Buffer.from('x'))).status, 400);
    assert.equal((await raw(a.port, 'POST', `${API}/cancel?sessionId=${p1.data.sessionId}`)).status, 200);
    const p3 = await raw(a.port, 'POST', `${API}/prepare-upload`, body(3));
    assert.equal(p3.status, 200);
    // a wrong checksum is refused and leaves nothing
    const sum = { info: { alias: 'raw', fingerprint: 'raw-fp' }, files: { s: { id: 's', fileName: 'sum.bin', size: 3, fileType: 'x', sha256: '00'.repeat(32) } } };
    await raw(a.port, 'POST', `${API}/cancel?sessionId=${p3.data.sessionId}`);
    const p4 = await raw(a.port, 'POST', `${API}/prepare-upload`, sum);
    assert.equal((await raw(a.port, 'POST', `${API}/upload?sessionId=${p4.data.sessionId}&fileId=s&token=${p4.data.files.s}`, Buffer.from('abc'))).status, 422);
    assert.ok(!fs.existsSync(path.join(tmp, 'a', 'in', 'sum.bin')));
    const right = crypto.createHash('sha256').update('abc').digest('hex');
    const p5body = { info: { alias: 'raw', fingerprint: 'raw-fp' }, files: { s: { id: 's', fileName: 'sum.bin', size: 3, fileType: 'x', sha256: right.toUpperCase() } } };
    await raw(a.port, 'POST', `${API}/cancel?sessionId=${p4.data.sessionId}`);
    const p5 = await raw(a.port, 'POST', `${API}/prepare-upload`, p5body);
    assert.equal((await raw(a.port, 'POST', `${API}/upload?sessionId=${p5.data.sessionId}&fileId=s&token=${p5.data.files.s}`, Buffer.from('abc'))).status, 200);
    assert.equal(fs.readFileSync(path.join(tmp, 'a', 'in', 'sum.bin'), 'utf8'), 'abc');
    assert.equal((await raw(a.port, 'POST', `${API}/prepare-upload`, { nope: 1 })).status, 400);
    assert.ok(fs.readdirSync(path.join(tmp, 'a', 'in')).every((n) => !n.startsWith('half')));
  });

  const selfSigned = (name) => {
    const certDir = path.join(tmp, `cert-${name}`);
    fs.mkdirSync(certDir);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=LocalSend User',
      '-keyout', path.join(certDir, 'k.pem'), '-out', path.join(certDir, 'c.pem')], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(certDir, 'k.pem')), cert: fs.readFileSync(path.join(certDir, 'c.pem')) };
  };
  const fpOf = (raw) => crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();

  await check('sends to an HTTPS LocalSend 1.19 device: shows its own certificate, pins the device\'s', async () => {
    const got = {};
    const hits = [];
    let prepared = null;
    // As LocalSend 1.19 (mutual TLS): a client without a certificate, or claiming another fingerprint, gets nothing.
    const handler = (req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const u = new URL(req.url, 'https://x');
        const body = Buffer.concat(chunks);
        const client = req.socket.getPeerCertificate()?.raw;
        hits.push(u.pathname);
        if (!client) { res.writeHead(401); return res.end(); }
        const claimed = /\/(register|prepare-upload)$/.test(u.pathname) ? (JSON.parse(body).info || JSON.parse(body)).fingerprint : null;
        if (claimed && claimed !== fpOf(client)) { res.writeHead(403); return res.end(); }
        if (u.pathname === `${API}/register`) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ alias: 'iPhone', version: '2.0', deviceModel: 'iPhone', deviceType: 'mobile', fingerprint: 'CERTHASH', download: false })); }
        if (u.pathname === `${API}/prepare-upload`) {
          prepared = JSON.parse(body);
          const files = Object.values(prepared.files);
          if (files.length === 1 && files[0].fileType === 'text/plain') { got.text = files[0].preview; res.writeHead(204); return res.end(); }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ sessionId: 'S', files: Object.fromEntries(files.map((f) => [f.id, `t-${f.id}`])) }));
        }
        if (u.pathname === `${API}/upload`) {
          const f = prepared.files[u.searchParams.get('fileId')];
          if (u.searchParams.get('token') !== `t-${f.id}`) { res.writeHead(403); return res.end(); }
          got[f.fileName] = body;
          res.writeHead(200); return res.end();
        }
        res.writeHead(404); res.end();
      });
    };
    const phoneTls = selfSigned('phone');
    const srv = https.createServer({ ...phoneTls, requestCert: true, rejectUnauthorized: false }, handler);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const d = await peer('d', { peers: [{ ip: '127.0.0.1', online: true }], probePort: port });
    await d.scan();
    const phone = d.state().devices.find((x) => x.alias === 'iPhone');
    assert.ok(phone, 'found');
    assert.equal(phone.protocol, 'https');
    assert.equal(phone.deviceType, 'mobile');
    assert.equal(phone.fingerprint, fpOf(new crypto.X509Certificate(phoneTls.cert).raw), 'known by its certificate, not by what it says');
    const data = crypto.randomBytes(200_000);
    const r = await d.send({ files: [sendFile('foto.jpg', data)] });
    assert.equal((await settled(d, r.id)).status, 'done');
    assert.ok(got['foto.jpg'].equals(data));
    assert.equal(prepared.info.protocol, 'https');
    assert.equal(prepared.info.fingerprint, d.info().fingerprint);
    const t = await d.send({ text: 'ahoj mobil' });
    assert.equal((await settled(d, t.id)).status, 'done');
    assert.equal(got.text, 'ahoj mobil');
    await new Promise((res) => { srv.close(res); srv.closeAllConnections(); });
    // Someone else at its address (another certificate): not even the file names go there.
    hits.length = 0;
    const other = https.createServer({ ...selfSigned('other'), requestCert: true, rejectUnauthorized: false }, handler);
    await new Promise((res) => other.listen(port, '127.0.0.1', res));
    const x = await d.send({ text: 'tajné' });
    const out = await settled(d, x.id);
    assert.equal(out.status, 'failed');
    assert.equal(out.targets[0].note, 'another certificate');
    assert.deepEqual(hits, []);
    assert.notEqual(got.text, 'tajné');
    await d.stop();
    other.close();
  });

  await check('a device that asks its user waits on the device as long as it takes, then gets it; Delete and quitting stop the wait', async () => {
    const held = []; // prepare-upload requests not answered yet: the device's user has not decided (or closed the text)
    const closed = new Set();
    const srv = https.createServer({ ...selfSigned('slow'), requestCert: true, rejectUnauthorized: false }, (req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const u = new URL(req.url, 'https://x');
        if (u.pathname === `${API}/register`) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ alias: 'Pomalý', version: '2.1', deviceModel: 'iPhone', deviceType: 'mobile', fingerprint: 'x', download: false })); }
        if (u.pathname === `${API}/prepare-upload`) { const one = { body: JSON.parse(Buffer.concat(chunks)), res }; held.push(one); req.socket.once('close', () => closed.add(one)); return; }
        if (u.pathname === `${API}/upload`) { res.writeHead(200); return res.end(); }
        res.writeHead(404); res.end();
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const s = await peer('slow', { peers: [{ ip: '127.0.0.1', online: true }], probePort: srv.address().port });
    await s.scan();
    // A text: the device shows it at once and answers once it is closed there.
    const t = await s.send({ text: 'ahoj' });
    await until(() => held.length === 1 && item(s, t.id).targets[0].status === 'waiting');
    assert.equal(item(s, t.id).status, 'sending');
    held[0].res.writeHead(204); held[0].res.end();
    assert.equal((await settled(s, t.id)).status, 'done');
    // Files: they wait for Accept, then flow.
    const f = await s.send({ files: [sendFile('a.bin', Buffer.from('abc'))] });
    await until(() => held.length === 2 && item(s, f.id).targets[0].status === 'waiting');
    held[1].res.writeHead(200, { 'Content-Type': 'application/json' });
    held[1].res.end(JSON.stringify({ sessionId: 'S', files: { [Object.keys(held[1].body.files)[0]]: 'tok' } }));
    assert.equal((await settled(s, f.id)).status, 'done');
    // Delete while it waits: the item goes and the device's request is dropped; the page hears no outcome of it.
    const g = await s.send({ text: 'zabudnuté' });
    await until(() => held.length === 3 && item(s, g.id).targets[0].status === 'waiting');
    const from = s.events.length;
    assert.ok(s.remove(g.id));
    assert.equal(item(s, g.id), undefined);
    await until(() => closed.has(held[2]));
    const h2 = await s.send({ text: 'ďalší' }); // its outcome comes after the deleted one's would have
    await until(() => held.length === 4);
    held[3].res.writeHead(204); held[3].res.end();
    await settled(s, h2.id);
    assert.deepEqual(s.events.slice(from).filter((e) => e.type === 'sent').map((e) => e.item.id), [h2.id]);
    // Quitting the app drops a wait too, and the next start says the item and its device were cut off.
    const q = await s.send({ text: 'pri zatvorení' });
    await until(() => held.length === 5 && item(s, q.id).targets[0].status === 'waiting');
    await s.stop();
    await until(() => closed.has(held[4]));
    const again = await peer('slow');
    assert.equal(item(again, q.id).status, 'stopped');
    assert.deepEqual(item(again, q.id).targets.map((x) => x.status), ['stopped']);
    await again.stop();
    await new Promise((r) => { srv.close(r); srv.closeAllConnections(); });
  });

  await check('with two devices the page hears the one that answered while the other still waits; quitting mid-upload tells the device', async () => {
    // Two phones on one port, at 127.0.0.1 and 127.0.0.2, each with its own certificate.
    const port = await freePort();
    const phones = await Promise.all(['127.0.0.1', '127.0.0.2'].map(async (host, n) => {
      const ph = { host, held: [], hits: [] };
      ph.srv = https.createServer({ ...selfSigned(`two${n}`), requestCert: true, rejectUnauthorized: false }, (req, res) => {
        const chunks = [];
        const u = new URL(req.url, 'https://x');
        ph.hits.push(u.pathname + (u.pathname.endsWith('/cancel') ? `?${u.searchParams}` : ''));
        if (u.pathname === `${API}/upload`) { ph.held.push({ res, upload: true }); req.resume(); return; } // takes the bytes, never says done
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          if (u.pathname === `${API}/register`) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ alias: `Mobil ${n}`, version: '2.1', deviceModel: 'x', deviceType: 'mobile', fingerprint: 'x', download: false })); }
          if (u.pathname === `${API}/prepare-upload`) return ph.held.push({ body: JSON.parse(Buffer.concat(chunks)), res });
          res.writeHead(200); res.end();
        });
      });
      await new Promise((r) => ph.srv.listen(port, host, r));
      return ph;
    }));
    const w = await peer('two', { peers: phones.map((x) => ({ ip: x.host, online: true })), probePort: port });
    await w.scan();
    assert.equal(w.state().devices.filter((d) => d.default).length, 2);
    // What the page gets is a copy made when the event is sent (the shell sends it over IPC); the events keep live items.
    const copies = [];
    w.events.push = (e) => { copies.push(JSON.parse(JSON.stringify(e))); return Array.prototype.push.call(w.events, e); };
    const t = await w.send({ text: 'obom' });
    await until(() => phones.every((x) => x.held.length === 1));
    phones[0].held[0].res.writeHead(204); phones[0].held[0].res.end();
    const told = await until(() => copies.find((e) => e.type === 'state' && e.state.items.find((i) => i.id === t.id)?.targets.map((x) => x.status).sort().join() === 'done,waiting'));
    assert.equal(told.state.items.find((i) => i.id === t.id).status, 'sending');
    phones[1].held[0].res.writeHead(204); phones[1].held[0].res.end();
    assert.equal((await settled(w, t.id)).status, 'done');
    // A file both accept; while its bytes go, the app quits: by the time stop() is done each device heard /cancel.
    const f = await w.send({ files: [sendFile('velky.bin', crypto.randomBytes(300_000))] });
    await until(() => phones.every((x) => x.held.length === 2));
    for (const [n, x] of phones.entries()) { x.held[1].res.writeHead(200, { 'Content-Type': 'application/json' }); x.held[1].res.end(JSON.stringify({ sessionId: `S${n}`, files: { [Object.keys(x.held[1].body.files)[0]]: 'tok' } })); }
    await until(() => phones.every((x) => x.held.some((h) => h.upload)) && item(w, f.id).targets.every((x) => x.status === 'sending'));
    await w.stop();
    assert.deepEqual(phones.map((x) => x.hits.filter((h) => h.includes('/cancel'))), [['/api/localsend/v2/cancel?sessionId=S0'], ['/api/localsend/v2/cancel?sessionId=S1']]);
    for (const x of phones) await new Promise((r) => { x.srv.close(r); x.srv.closeAllConnections(); });
  });

  await check('a device that takes the connection but never finishes TLS is unreachable within seconds, not minutes', async () => {
    const net = require('node:net');
    const fast = https.createServer({ ...selfSigned('mute'), requestCert: true, rejectUnauthorized: false }, (req, res) => {
      req.resume();
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ alias: 'Tichý', version: '2.1', deviceModel: 'x', deviceType: 'mobile', fingerprint: 'x', download: false })); });
    });
    await new Promise((r) => fast.listen(0, '127.0.0.1', r));
    const port = fast.address().port;
    const m = await peer('mute', { peers: [{ ip: '127.0.0.1', online: true }], probePort: port });
    await m.scan();
    await new Promise((r) => { fast.close(r); fast.closeAllConnections(); });
    const socks = [];
    const mute = net.createServer((c) => socks.push(c)); // takes the connection, never answers the handshake
    await new Promise((r) => mute.listen(port, '127.0.0.1', r));
    const started = Date.now();
    const x = await m.send({ text: 'haló' });
    const out = await until(() => { const it = item(m, x.id); return it.status !== 'sending' && it; }, 9000);
    assert.equal(out.status, 'offline');
    assert.ok(Date.now() - started < 8000, `${Date.now() - started} ms`);
    await m.stop();
    for (const c of socks) c.destroy();
    mute.close();
  });

  await check('a sender showing a certificate must claim its fingerprint', async () => {
    const tls = selfSigned('liar');
    const body = { info: { alias: 'liar', fingerprint: a.info().fingerprint }, files: { f: { id: 'f', fileName: 'x.txt', size: 1, fileType: 'x' } } };
    assert.equal((await raw(a.port, 'POST', `${API}/prepare-upload`, body, tls)).status, 403);
    const honest = { ...body, info: { alias: 'honest', fingerprint: fpOf(new crypto.X509Certificate(tls.cert).raw) } };
    const ok = await raw(a.port, 'POST', `${API}/prepare-upload`, honest, tls);
    assert.equal(ok.status, 200);
    await raw(a.port, 'POST', `${API}/cancel?sessionId=${ok.data.sessionId}`, null, tls);
    const before = a.state().devices.length;
    await raw(a.port, 'POST', `${API}/register`, { alias: 'liar2', fingerprint: 'AB'.repeat(32) }, tls);
    assert.equal(a.state().devices.some((x) => x.alias === 'liar2'), false);
    assert.ok(a.state().devices.length >= before);
  });

  await check('a device known by its certificate moves only when that certificate proves it', async () => {
    const afp = a.info().fingerprint;
    const known = () => b.state().devices.find((x) => x.fingerprint === afp);
    assert.equal(known().protocol, 'https');
    const hits = [];
    const trap = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
    await new Promise((r) => trap.listen(0, '127.0.0.1', r));
    const claim = { alias: 'Weft a', fingerprint: afp, port: trap.address().port, protocol: 'http' };
    // Its fingerprint claimed without its certificate: by register and by a multicast announcement.
    assert.equal((await raw(b.port, 'POST', `${API}/register`, claim)).status, 200);
    b.onMulticast(Buffer.from(JSON.stringify({ ...claim, announce: true })), { address: '127.0.0.1' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(known().port, a.port);
    assert.equal(known().protocol, 'https');
    const t = await b.send({ text: 'len pre a', to: [afp] });
    assert.equal((await settled(b, t.id)).status, 'done');
    assert.ok(a.state().items.some((x) => x.text === 'len pre a'));
    assert.deepEqual(hits, []);
    trap.close();
    // The same board again on another port (its certificate kept): an announcement from there is checked and moves it.
    const e = await peer('g');
    const efp = e.info().fingerprint;
    b.onMulticast(Buffer.from(JSON.stringify({ ...e.info(), announce: false })), { address: '127.0.0.1' });
    await e.stop();
    const e2 = await peer('g');
    assert.equal(e2.info().fingerprint, efp);
    b.onMulticast(Buffer.from(JSON.stringify({ ...e2.info(), announce: false })), { address: '127.0.0.1' });
    await until(() => b.state().devices.find((x) => x.fingerprint === efp)?.port === e2.port).catch((err) => { throw new Error(`${err.message} ${JSON.stringify(b.state().devices.find((x) => x.fingerprint === efp))} e2=${e2.port}`); });
    await e2.stop();
  });

  await check('a fingerprint written in small letters is the same device, still pinned', async () => {
    const afp = a.info().fingerprint;
    const before = b.state().devices.length;
    assert.equal((await raw(b.port, 'POST', `${API}/register`, { alias: 'iný', fingerprint: afp.toLowerCase(), port: 9, protocol: 'http' })).status, 200);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(b.state().devices.length, before);
    const known = b.state().devices.find((x) => x.fingerprint === afp);
    assert.equal(known.protocol, 'https');
    assert.equal(known.port, a.port);
  });

  await check('an earlier state with one certificate under two spellings loads as one record, off if one was off', async () => {
    const fpUp = 'AB'.repeat(32);
    const dev = (fingerprint, on, seen) => ({ fingerprint, alias: 'starý', ip: '127.0.0.9', port: 9, protocol: 'https', via: 'tailnet', seen, default: on });
    fs.writeFileSync(path.join(tmp, 'old.json'), JSON.stringify({ lan: false, items: [], devices: { [fpUp.toLowerCase()]: dev(fpUp.toLowerCase(), false, 1), [fpUp]: dev(fpUp, true, 2) } }));
    const o = await peer('old');
    const all = o.state().devices.filter((x) => x.fingerprint.toUpperCase() === fpUp);
    assert.deepEqual(all.map((x) => [x.fingerprint, x.default, x.chosen]), [[fpUp, false, true]]);
    o.setDefault(fpUp.toLowerCase(), true);
    assert.equal(o.state().devices.find((x) => x.fingerprint === fpUp).default, true);
    await o.stop();
    // Of an HTTPS and a newer HTTP spelling, the HTTPS one stays: it keeps the certificate pinned.
    fs.writeFileSync(path.join(tmp, 'old2.json'), JSON.stringify({ lan: false, items: [], devices: {
      [fpUp.toLowerCase()]: dev(fpUp.toLowerCase(), true, 1), [fpUp]: { ...dev(fpUp, true, 2), protocol: 'http', port: 7 } } }));
    const o2 = await peer('old2');
    const one = o2.state().devices.filter((x) => x.fingerprint.toUpperCase() === fpUp);
    assert.deepEqual(one.map((x) => [x.protocol, x.port]), [['https', 9]]);
    await o2.stop();
  });

  await check('a device first heard on the local network becomes a default once the tailnet shows it', async () => {
    const peers = []; // the tailnet shows a only later
    const h = await peer('h', { trusted: (ip) => ip === '127.0.0.1', peers, probePort: a.port });
    const afp = a.info().fingerprint;
    h.onMulticast(Buffer.from(JSON.stringify({ ...a.info(), announce: false })), { address: '127.0.0.2' });
    const lan = h.state().devices.find((x) => x.fingerprint === afp);
    assert.equal(lan.via, 'lan');
    assert.equal(lan.default, false);
    peers.push({ ip: '127.0.0.1', online: true });
    await h.scan();
    const now = h.state().devices.find((x) => x.fingerprint === afp);
    assert.deepEqual([now.via, now.ip, now.default], ['tailnet', '127.0.0.1', true]);
    // Taken off by hand, it stays off.
    h.setDefault(afp, false);
    await h.scan();
    assert.equal(h.state().devices.find((x) => x.fingerprint === afp).default, false);
    await h.stop();
  });

  await check('a question to Karchi does not hold back his own devices', async () => {
    const h = await peer('h2', { trusted: (ip) => ip === '127.0.0.1' });
    const stranger = later(raw(h.port, 'POST', `${API}/prepare-upload`, { info: { alias: 'Cudzí', fingerprint: 'cudzi' }, files: { f: { id: 'f', fileName: 'x.txt', size: 1, fileType: 'text/x' } } }, { localAddress: '127.0.0.2' }));
    const ask = await until(() => h.state().ask);
    assert.equal(ask.device.alias, 'Cudzí');
    b.onMulticast(Buffer.from(JSON.stringify({ ...h.info(), announce: false })), { address: '127.0.0.1' });
    const t = await b.send({ text: 'aj tak prejde', to: [h.info().fingerprint] });
    assert.equal((await settled(b, t.id)).status, 'done');
    const f = await b.send({ files: [sendFile('aj.txt', Buffer.from('aj'))], to: [h.info().fingerprint] });
    assert.equal((await settled(b, f.id)).status, 'done');
    h.respond(ask.id, false);
    assert.equal((await stranger).status, 403);
    await h.stop();
  });

  await check('a file gone before it is sent fails that item and nothing else', async () => {
    const gone = sendFile('zmizne.txt', Buffer.from('x'));
    fs.rmSync(gone.path);
    const afp = a.info().fingerprint;
    const r = await b.send({ files: [gone], to: [afp] });
    const out = await settled(b, r.id);
    assert.equal(out.status, 'failed');
    const t = await b.send({ text: 'stále žije', to: [afp] });
    assert.equal((await settled(b, t.id)).status, 'done');
  });

  await check('a text from outside the tailnet waits for Prijať too', async () => {
    const c = await peer('c2', { trusted: () => false });
    b.onMulticast(Buffer.from(JSON.stringify({ ...c.info(), announce: false })), { address: '127.0.0.1' });
    const cfp = c.info().fingerprint;
    const no = await b.send({ text: 'cudzí text', to: [cfp] });
    const ask = await until(() => c.state().ask);
    assert.equal(ask.text, 'cudzí text');
    assert.equal(c.state().items.length, 0);
    c.respond(ask.id, false);
    assert.equal((await settled(b, no.id)).status, 'declined');
    assert.equal(c.state().items.length, 0);
    const yes = await b.send({ text: 'prijatý text', to: [cfp] });
    c.respond((await until(() => c.state().ask)).id, true);
    assert.equal((await settled(b, yes.id)).status, 'done');
    assert.equal(c.state().items[0].text, 'prijatý text');
    await c.stop();
  });

  await check('an announcement on the local network is answered by HTTP register', async () => {
    let registered = null;
    const srv = http.createServer((req, res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => { registered = { path: req.url, body: JSON.parse(Buffer.concat(c)) }; res.writeHead(200); res.end('{}'); }); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    a.onMulticast(Buffer.from(JSON.stringify({ alias: 'Android', version: '2.0', fingerprint: 'fp-android', port: srv.address().port, protocol: 'http', announce: true })), { address: '::ffff:127.0.0.1' });
    await until(() => registered);
    assert.equal(registered.path, `${API}/register`);
    assert.equal(registered.body.fingerprint, a.info().fingerprint);
    assert.ok(a.state().devices.some((d) => d.alias === 'Android' && d.ip === '127.0.0.1'));
    a.onMulticast(Buffer.from(JSON.stringify({ ...a.info(), announce: true })), { address: '127.0.0.1' }); // itself: ignored
    assert.ok(!a.state().devices.some((d) => d.fingerprint === a.info().fingerprint));
    srv.close();
  });

  await check('a nobody-there default device is „offline“ and Retry reaches it once it is back', async () => {
    const e = await peer('e');
    const port = e.port;
    const efp = e.info().fingerprint;
    await raw(port, 'POST', `${API}/register`, b.info());
    b.onMulticast(Buffer.from(JSON.stringify({ ...e.info(), announce: false })), { address: '127.0.0.1' });
    b.setDefault(efp, true);
    await e.stop();
    const r = await b.send({ files: [sendFile('later.txt', Buffer.from('later'))], to: [efp] });
    const out = await settled(b, r.id);
    assert.equal(out.status, 'offline');
    const e2 = await peer('e', { port });
    assert.equal(b.retry(r.id), true);
    assert.equal((await settled(b, r.id)).status, 'done');
    assert.equal(fs.readFileSync(path.join(tmp, 'e', 'in', 'later.txt'), 'utf8'), 'later');
    await e2.stop();
  });

  await check('a retry of a half-delivered item reaches only the missing device, and the item ends „done“', async () => {
    const e = await peer('e3');
    const port = e.port;
    const efp = e.info().fingerprint;
    const afp = a.info().fingerprint;
    b.onMulticast(Buffer.from(JSON.stringify({ ...e.info(), announce: false })), { address: '127.0.0.1' });
    await e.stop();
    const r = await b.send({ text: 'čiastočne', to: [efp, afp] }); // the missing one first
    assert.equal((await settled(b, r.id)).status, 'partial');
    const e2 = await peer('e3', { port });
    assert.equal(b.retry(r.id), true);
    const out = await settled(b, r.id);
    assert.equal(out.status, 'done');
    assert.deepEqual(out.targets.map((t) => t.status), ['done', 'done']);
    assert.equal(a.state().items.filter((x) => x.text === 'čiastočne').length, 1);
    assert.equal(e2.state().items.filter((x) => x.text === 'čiastočne').length, 1);
    assert.equal(b.retry(r.id), false);
    await e2.stop();
  });

  await check('LocalSend has 53317 (here: the port taken): the next free one, and the board says so', async () => {
    const port = await freePort();
    const blocker = http.createServer().listen(port, '127.0.0.1');
    await new Promise((r) => blocker.once('listening', r));
    const f = await peer('f', { port });
    assert.equal(f.port, port + 1);
    assert.equal(f.info().port, port + 1);
    assert.equal(f.state().me.listening, true);
    await f.stop();
    blocker.close();
  });

  await check('by default only a device tailnet() lists, over the Tailscale address, gets in without Prijať; on the local network its certificate does', async () => {
    // 127.0.0.1 stands in for this machine's Tailscale address and 127.0.0.3 for its local network's; tailnet() lists
    // 127.0.0.5. A local device may hold an address of Tailscale's range, like 127.0.0.5 coming in over 127.0.0.3.
    const z = createPeer({ dir: path.join(tmp, 'z', 'in'), statePath: path.join(tmp, 'z.json'), alias: 'Weft z', lan: false, hosts: ['127.0.0.3'],
      port: await freePort(), tailnet: async () => ({ self: '127.0.0.1', peers: [{ ip: '127.0.0.5', online: false }] }), log: () => {} });
    await z.start();
    const text = (t, fp) => ({ info: { alias: fp, fingerprint: fp }, files: { f: { id: 'f', fileName: 't.txt', size: t.length, fileType: 'text/plain', preview: t } } });
    const to = (host, from, p, body, tls = {}) => raw(z.port, 'POST', `${API}/${p}`, body, { host, localAddress: from, ...tls });
    const waits = async (host, from, body, tls) => {
      const r = later(to(host, from, 'prepare-upload', body, tls));
      const ask = await until(() => z.state().ask);
      z.respond(ask.id, false);
      assert.equal((await r).status, 403);
    };
    assert.equal((await to('127.0.0.1', '127.0.0.5', 'prepare-upload', text('môj', 'fp-moj'))).status, 204);
    assert.equal(z.state().items[0].text, 'môj');
    await waits('127.0.0.3', '127.0.0.5', text('zvonka', 'fp-cez-lan'));
    await waits('127.0.0.1', '127.0.0.6', text('zvonka', 'fp-neznamy'));
    assert.equal(z.state().items.length, 1);
    await to('127.0.0.3', '127.0.0.5', 'register', { alias: 'lan', fingerprint: 'fp-lan', port: 1, protocol: 'http' });
    z.onMulticast(Buffer.from(JSON.stringify({ alias: 'mc', fingerprint: 'fp-mc', port: 1, protocol: 'http', announce: false })), { address: '127.0.0.5' });
    await to('127.0.0.1', '127.0.0.5', 'register', { alias: 'ts', fingerprint: 'fp-ts', port: 1, protocol: 'http' });
    const by = (fp) => { const d = z.state().devices.find((x) => x.fingerprint === fp); return d && [d.via, d.default]; };
    assert.deepEqual([by('fp-lan'), by('fp-mc'), by('fp-ts'), by('fp-moj')], [['lan', false], ['lan', false], ['tailnet', true], ['tailnet', true]]);
    // fp-ts has no certificate (HTTP): a claim of its name from the local network does not move it there.
    await to('127.0.0.3', '127.0.0.9', 'register', { alias: 'podvrh', fingerprint: 'fp-ts', port: 2, protocol: 'http' });
    z.onMulticast(Buffer.from(JSON.stringify({ alias: 'podvrh', fingerprint: 'fp-ts', port: 2, protocol: 'http', announce: false })), { address: '127.0.0.9' });
    const ts = z.state().devices.find((x) => x.fingerprint === 'fp-ts');
    assert.deepEqual([ts.ip, ts.port, ts.alias, ts.default], ['127.0.0.5', 1, 'ts', true]);
    // His phone, seen on the tailnet with its certificate, sends at home over the local network (its own address there).
    const phone = selfSigned('z-phone');
    const pfp = fpOf(new crypto.X509Certificate(phone.cert).raw);
    await to('127.0.0.1', '127.0.0.5', 'register', { alias: 'iPhone', fingerprint: pfp, port: 1, protocol: 'https' }, phone);
    assert.equal((await to('127.0.0.3', '127.0.0.7', 'prepare-upload', text('z domu', pfp), phone)).status, 204);
    assert.ok(z.state().items.some((x) => x.text === 'z domu'));
    // Naming its fingerprint without its certificate is not enough; a stranger's own certificate is not either.
    await waits('127.0.0.3', '127.0.0.7', text('podvrh', pfp));
    const stranger = selfSigned('z-stranger');
    await waits('127.0.0.3', '127.0.0.8', text('cudzí', fpOf(new crypto.X509Certificate(stranger.cert).raw)), stranger);
    assert.equal(z.state().items.filter((x) => x.text === 'podvrh' || x.text === 'cudzí').length, 0);
    await z.stop();
  });

  await check('a tailnet default saved by an earlier build waits for a scan; what Karchi clicked stays', async () => {
    const statePath = path.join(tmp, 'legacy.json');
    fs.writeFileSync(statePath, JSON.stringify({ items: [], devices: {
      'leg-a': { fingerprint: 'leg-a', alias: 'a', ip: '100.90.0.5', port: 1, protocol: 'http', via: 'tailnet', default: true, chosen: false },
      'leg-b': { fingerprint: 'leg-b', alias: 'b', ip: '192.168.1.5', port: 1, protocol: 'http', via: 'lan', default: true, chosen: true } } }));
    const l = createPeer({ dir: path.join(tmp, 'legacy', 'in'), statePath, alias: 'Weft l', lan: false, log: () => {} });
    assert.deepEqual(l.state().devices.map((d) => [d.fingerprint, d.default]).sort(), [['leg-a', false], ['leg-b', true]]);
    await l.stop();
  });

  await check('without Tailscale running its peers are not probed; with it they are', async () => {
    let hits = 0;
    const phone = http.createServer((req, res) => { req.resume(); req.on('end', () => { hits++; res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ alias: 'mobil', fingerprint: 'fp-probe', port: phone.address().port, protocol: 'http' })); }); });
    await new Promise((r) => phone.listen(0, '127.0.0.5', r));
    const mk = async (name, self) => createPeer({ dir: path.join(tmp, name, 'in'), statePath: path.join(tmp, `${name}.json`), alias: name, lan: false, hosts: ['127.0.0.1'],
      port: await freePort(), probePort: phone.address().port, tailnet: async () => ({ self, peers: [{ ip: '127.0.0.5', online: true }] }), log: () => {} });
    const off = await mk('p-off', null);
    await off.start();
    assert.equal(hits, 0);
    assert.equal(off.state().devices.length, 0);
    await off.stop();
    const on = await mk('p-on', '127.0.0.1');
    await on.start();
    assert.ok(hits > 0);
    assert.deepEqual(on.state().devices.map((d) => [d.fingerprint, d.via, d.default]), [['fp-probe', 'tailnet', true]]);
    await on.stop();
    phone.close();
  });

  await check('a connection kept open over an address the board left is refused, not asked about', async () => {
    let self = '127.0.0.20';
    const k = createPeer({ dir: path.join(tmp, 'k', 'in'), statePath: path.join(tmp, 'k.json'), alias: 'Weft k', lan: false, hosts: ['127.0.0.1'],
      port: await freePort(), trusted: (ip) => ip === '127.0.0.9', tailnet: async () => ({ self, peers: [] }), log: () => {} });
    await k.start();
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    const body = { info: { alias: 'Cudzí', fingerprint: 'cudzi-k' }, files: { f: { id: 'f', fileName: 'x.txt', size: 1, fileType: 'text/x' } } };
    const first = later(raw(k.port, 'POST', `${API}/prepare-upload`, body, { host: '127.0.0.20', agent }));
    const ask = await until(() => k.state().ask);
    self = '127.0.0.21';
    await k.scan(); // its Tailscale address moved: the old listener closes, this connection stays open
    k.respond(ask.id, false);
    assert.equal((await first).status, 403);
    const again = await raw(k.port, 'POST', `${API}/prepare-upload`, body, { host: '127.0.0.20', agent });
    assert.deepEqual([again.status, again.data?.message, k.state().ask], [403, 'Not listening here', null]);
    agent.destroy();
    await k.stop();
  });

  await check('numbers in its certificate are minimal DER, so TLS takes every certificate it makes', async () => {
    const hex = (b) => derInt(Buffer.from(b)).toString('hex');
    assert.deepEqual([hex([0x00, 0x71]), hex([0x80]), hex([0, 0, 5]), hex([0]), hex([0, 0x80, 1])], ['020171', '02020080', '020105', '020100', '0203008001']);
  });

  await check('a certificate TLS refuses, saved by an earlier build, is replaced and the board listens', async () => {
    const good = createPeer({ dir: path.join(tmp, 'bad', 'in'), statePath: path.join(tmp, 'bad0.json'), alias: 'x', lan: false, log: () => {} });
    await good.stop();
    const { tls: t } = JSON.parse(fs.readFileSync(path.join(tmp, 'bad0.json'), 'utf8'));
    const raw = Buffer.from(t.cert.replace(/-----[^-]+-----|\s/g, ''), 'base64');
    assert.equal(raw[13], 0x02); // the serial number: INTEGER after the version
    raw[15] = 0x00; raw[16] = 0x71; // a leading zero before a byte under 0x80, as the earlier build sometimes wrote
    const bad = { ...t, cert: `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n` };
    assert.throws(() => require('node:tls').createSecureContext({ cert: bad.cert, key: bad.key }));
    fs.writeFileSync(path.join(tmp, 'bad.json'), JSON.stringify({ tls: bad, fingerprint: 'OLD', items: [], devices: {} }));
    const b2 = createPeer({ dir: path.join(tmp, 'bad', 'in'), statePath: path.join(tmp, 'bad.json'), alias: 'x', lan: false, hosts: ['127.0.0.1'], port: await freePort(), log: () => {} });
    await b2.start();
    assert.notEqual(b2.info().fingerprint, 'OLD');
    assert.equal(b2.state().me.listening, true);
    assert.equal((await raw2(b2.port)).status, 200);
    await b2.stop();
  });

  await check('a request whose body comes after the board left its address is refused, not asked about', async () => {
    let self = '127.0.0.30';
    const k = createPeer({ dir: path.join(tmp, 'k2', 'in'), statePath: path.join(tmp, 'k2.json'), alias: 'Weft k2', lan: false, hosts: ['127.0.0.1'],
      port: await freePort(), trusted: (ip) => ip === '127.0.0.9', tailnet: async () => ({ self, peers: [] }), log: () => {} });
    await k.start();
    const body = Buffer.from(JSON.stringify({ info: { alias: 'Cudzí', fingerprint: 'cudzi-k2' }, files: { f: { id: 'f', fileName: 'x.txt', size: 1, fileType: 'text/x' } } }));
    let req;
    const res = later(new Promise((resolve, reject) => {
      req = https.request({ host: '127.0.0.30', port: k.port, method: 'POST', path: `${API}/prepare-upload`, rejectUnauthorized: false, agent: false,
        headers: { 'Content-Length': body.length, Expect: '100-continue' } }, (r) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => resolve({ status: r.statusCode, data: JSON.parse(Buffer.concat(c)) })); });
      req.on('error', reject);
    }));
    await new Promise((r) => req.once('continue', r)); // the board took the headers: the request is in its hands
    self = '127.0.0.31';
    await k.scan();
    req.end(body);
    const r = await res;
    assert.deepEqual([r.status, r.data?.message, k.state().ask], [403, 'Not listening here', null]);
    await k.stop();
  });

  await check('a transfer over an address the board left ends, so his devices can send again', async () => {
    let self = '127.0.0.40';
    const k = createPeer({ dir: path.join(tmp, 'k3', 'in'), statePath: path.join(tmp, 'k3.json'), alias: 'Weft k3', lan: false, hosts: ['127.0.0.1'],
      port: await freePort(), trusted: () => true, tailnet: async () => ({ self, peers: [] }), log: () => {} });
    await k.start();
    const two = { info: { alias: 'mobil', fingerprint: 'fp-k3' }, files: { a: { id: 'a', fileName: 'a.txt', size: 1, fileType: 'text/x' }, b: { id: 'b', fileName: 'b.txt', size: 1, fileType: 'text/x' } } };
    const prep = await raw(k.port, 'POST', `${API}/prepare-upload`, two, { host: '127.0.0.40' });
    assert.equal(prep.status, 200);
    assert.equal((await raw(k.port, 'POST', `${API}/upload?sessionId=${prep.data.sessionId}&fileId=a&token=${prep.data.files.a}`, Buffer.from('a'), { host: '127.0.0.40' })).status, 200);
    self = '127.0.0.41';
    await k.scan();
    assert.equal(k.state().items.find((x) => x.files?.[0]?.name === 'a.txt')?.status, 'partial');
    assert.equal((await raw(k.port, 'POST', `${API}/prepare-upload`, { ...two, info: { alias: 'mobil', fingerprint: 'fp-k3b' } })).status, 200);
    await k.stop();
  });

  await check('a transfer over an address the board left that its sender breaks off ends too', async () => {
    let self = '127.0.0.44';
    const k = createPeer({ dir: path.join(tmp, 'k4', 'in'), statePath: path.join(tmp, 'k4.json'), alias: 'Weft k4', lan: false, hosts: ['127.0.0.1'],
      port: await freePort(), trusted: () => true, tailnet: async () => ({ self, peers: [] }), log: () => {} });
    await k.start();
    const two = { info: { alias: 'mobil', fingerprint: 'fp-k4' }, files: { a: { id: 'a', fileName: 'a.txt', size: 2, fileType: 'text/x' }, b: { id: 'b', fileName: 'b.txt', size: 1, fileType: 'text/x' } } };
    const prep = await raw(k.port, 'POST', `${API}/prepare-upload`, two, { host: '127.0.0.44' });
    assert.equal(prep.status, 200);
    const item = () => k.state().items.find((x) => x.files?.[0]?.name === 'a.txt');
    const up = https.request({ host: '127.0.0.44', port: k.port, method: 'POST', path: `${API}/upload?sessionId=${prep.data.sessionId}&fileId=a&token=${prep.data.files.a}`,
      rejectUnauthorized: false, agent: false, headers: { 'Content-Length': 2 } });
    up.on('error', () => {});
    up.write('a');
    await until(() => item()?.got === 1);
    self = '127.0.0.45';
    await k.scan();
    assert.equal(item().status, 'receiving'); // its byte came: it may still finish
    up.destroy(); // the sender gives up, and can no longer reach the board to cancel
    await until(() => item().status !== 'receiving');
    assert.equal(item().status, 'stopped');
    assert.equal((await raw(k.port, 'POST', `${API}/prepare-upload`, { ...two, info: { alias: 'mobil', fingerprint: 'fp-k4b' } })).status, 200);
    await k.stop();
  });

  await check('an upload whose sender left while the board named its file ends, also over an address it left', async () => {
    let self = '127.0.0.46';
    const k = createPeer({ dir: path.join(tmp, 'k5', 'in'), statePath: path.join(tmp, 'k5.json'), alias: 'Weft k5', lan: false, hosts: ['127.0.0.1'],
      port: await freePort(), trusted: () => true, tailnet: async () => ({ self, peers: [] }), log: () => {} });
    await k.start();
    const two = { info: { alias: 'mobil', fingerprint: 'fp-k5' }, files: { a: { id: 'a', fileName: 'a.txt', size: 2, fileType: 'text/x' }, b: { id: 'b', fileName: 'b.txt', size: 1, fileType: 'text/x' } } };
    const prep = await raw(k.port, 'POST', `${API}/prepare-upload`, two, { host: '127.0.0.46' });
    assert.equal(prep.status, 200);
    // Hold the board while it makes a.txt, the way a slow disk would.
    const fsp = require('node:fs/promises');
    const open = fsp.open;
    let naming, release, named;
    const inside = new Promise((r) => { naming = r; });
    const gate = new Promise((r) => { release = r; });
    const after = new Promise((r) => { named = r; });
    fsp.open = async (file, ...rest) => {
      const h = await open(file, ...rest);
      if (path.basename(String(file)) !== 'a.txt') return h;
      return { close: async () => { naming(); await gate; await h.close(); setImmediate(named); } }; // named: once the upload went on
    };
    try {
      const up = https.request({ host: '127.0.0.46', port: k.port, method: 'POST', path: `${API}/upload?sessionId=${prep.data.sessionId}&fileId=a&token=${prep.data.files.a}`,
        rejectUnauthorized: false, agent: false, headers: { 'Content-Length': 2 } });
      up.on('error', () => {});
      up.write('a');
      await inside;
      up.destroy();
      await raw2(k.port); // a whole new TLS connection: the board has seen the first one close
      release();
      await after;
    } finally { fsp.open = open; }
    const item = k.state().items.find((x) => x.files?.[0]?.name === 'a.txt');
    self = '127.0.0.47';
    await k.scan();
    await until(() => item && k.state().items.find((x) => x.id === item.id).status === 'stopped'); // once its leftovers are gone
    assert.equal((await raw(k.port, 'POST', `${API}/prepare-upload`, { ...two, info: { alias: 'mobil', fingerprint: 'fp-k5b' } })).status, 200);
    await until(() => !fs.readdirSync(path.join(tmp, 'k5', 'in')).some((n) => n.includes('a.txt'))); // nothing half left behind
    await k.stop();
  });

  await check('an upload whose sender left while its file was opening leaves nothing behind', async () => {
    const k = createPeer({ dir: path.join(tmp, 'k6', 'in'), statePath: path.join(tmp, 'k6.json'), alias: 'Weft k6', lan: false, hosts: ['127.0.0.1'],
      port: await freePort(), trusted: () => true, tailnet: async () => ({ self: '127.0.0.250', peers: [] }), log: () => {} });
    await k.start();
    const prep = await raw(k.port, 'POST', `${API}/prepare-upload`, { info: { alias: 'mobil', fingerprint: 'fp-k6' }, files: { a: { id: 'a', fileName: 'a.txt', size: 2, fileType: 'text/x' } } });
    assert.equal(prep.status, 200);
    // Hold the board while it opens the file it writes into, the way a slow disk would.
    const open = fs.open;
    let opening, release;
    const inside = new Promise((r) => { opening = r; });
    const gate = new Promise((r) => { release = r; });
    fs.open = (file, ...rest) => { if (String(file).endsWith('.part')) { opening(); gate.then(() => open(file, ...rest)); } else open(file, ...rest); };
    try {
      const up = https.request({ host: '127.0.0.1', port: k.port, method: 'POST', path: `${API}/upload?sessionId=${prep.data.sessionId}&fileId=a&token=${prep.data.files.a}`,
        rejectUnauthorized: false, agent: false, headers: { 'Content-Length': 2 } });
      up.on('error', () => {});
      up.write('a');
      await inside;
      up.destroy();
      await raw2(k.port); // a whole new TLS connection: the board has seen the first one close
      release();
      await until(() => !fs.readdirSync(path.join(tmp, 'k6', 'in')).some((n) => n.includes('a.txt')));
    } finally { release(); fs.open = open; }
    await k.stop();
  });

  await check('while a whole file gets its name its session goes on: none other starts, and it ends no other', async () => {
    let self = '127.0.0.48';
    const k = createPeer({ dir: path.join(tmp, 'k7', 'in'), statePath: path.join(tmp, 'k7.json'), alias: 'Weft k7', lan: false, hosts: ['127.0.0.1'],
      port: await freePort(), trusted: () => true, tailnet: async () => ({ self, peers: [] }), log: () => {} });
    await k.start();
    const prep = await raw(k.port, 'POST', `${API}/prepare-upload`, { info: { alias: 'mobil', fingerprint: 'fp-k7' }, files: { a: { id: 'a', fileName: 'a.txt', size: 1, fileType: 'text/x' } } }, { host: '127.0.0.48' });
    assert.equal(prep.status, 200);
    const other = { info: { alias: 'mobil', fingerprint: 'fp-k7b' }, files: { c: { id: 'c', fileName: 'c.txt', size: 1, fileType: 'text/x' } } };
    // Hold the board while it gives a.txt its name, the way a slow disk would.
    const fsp = require('node:fs/promises');
    const rename = fsp.rename;
    let renaming, release;
    const inside = new Promise((r) => { renaming = r; });
    const gate = new Promise((r) => { release = r; });
    fsp.rename = async (from, to) => { if (path.basename(String(to)) === 'a.txt') { renaming(); await gate; } return rename(from, to); };
    try {
      const up = later(raw(k.port, 'POST', `${API}/upload?sessionId=${prep.data.sessionId}&fileId=a&token=${prep.data.files.a}`, Buffer.from('a'), { host: '127.0.0.48' }));
      await inside;
      self = '127.0.0.49';
      await k.scan(); // the address it came over is gone
      assert.equal((await raw(k.port, 'POST', `${API}/prepare-upload`, other)).status, 409);
      release();
      assert.equal((await up).status, 200);
    } finally { release(); fsp.rename = rename; }
    assert.equal(k.state().items.find((x) => x.files?.[0]?.name === 'a.txt')?.status, 'done');
    const next = await raw(k.port, 'POST', `${API}/prepare-upload`, other);
    assert.equal(next.status, 200);
    assert.equal((await raw(k.port, 'POST', `${API}/upload?sessionId=${next.data.sessionId}&fileId=c&token=${next.data.files.c}`, Buffer.from('c'))).status, 200);
    await k.stop();
  });

  await check('a file that cannot get its name is removed, and its session can still end', async () => {
    const at = { ip: '127.0.0.50' };
    const k = await lone('k8', at);
    const prep = await raw(k.port, 'POST', `${API}/prepare-upload`, twoFiles('fp-k8'), { host: at.ip });
    const fsp = require('node:fs/promises');
    const rename = fsp.rename;
    fsp.rename = async (from, to) => { if (path.basename(String(to)) === 'a.txt') throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return rename(from, to); };
    try { assert.equal((await uploadTo(k, prep, 'a', 'a', at.ip)).status, 500); } finally { fsp.rename = rename; }
    assert.deepEqual(left(k), []);
    assert.equal(k.state().items.find((x) => x.files?.[0]?.name === 'a.txt')?.got, 0);
    at.ip = '127.0.0.51';
    await k.scan();
    assert.equal(k.state().items.find((x) => x.files?.[0]?.name === 'a.txt')?.status, 'stopped');
    assert.equal((await raw(k.port, 'POST', `${API}/prepare-upload`, twoFiles('fp-k8b'))).status, 200);
    await k.stop();
  });

  await check('a file whose closing fails is not taken', async () => {
    const k = await lone('k9');
    const prep = await raw(k.port, 'POST', `${API}/prepare-upload`, twoFiles('fp-k9'));
    const { open, close } = fs;
    const parts = new Set();
    fs.open = (file, ...rest) => { const cb = rest.pop(); open(file, ...rest, (err, fd) => { if (!err && String(file).endsWith('.part')) parts.add(fd); cb(err, fd); }); };
    fs.close = (fd, cb) => close(fd, (err) => cb(err || (parts.has(fd) ? Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) : null)));
    try { assert.equal((await uploadTo(k, prep, 'a', 'a')).status, 500); } finally { Object.assign(fs, { open, close }); }
    assert.deepEqual(left(k), []);
    assert.equal((await uploadTo(k, prep, 'a', 'a')).status, 200); // tried again, it lands
    await k.stop();
  });

  await check('a file that arrived whole stays when its sender cancels while it gets its name', async () => {
    const k = await lone('k10');
    const prep = await raw(k.port, 'POST', `${API}/prepare-upload`, twoFiles('fp-k10'));
    const h = hold(require('node:fs/promises'), 'rename', (from, to) => path.basename(String(to)) === 'a.txt');
    try {
      const up = later(uploadTo(k, prep, 'a', 'a'));
      await h.inside;
      assert.equal((await raw(k.port, 'POST', `${API}/cancel?sessionId=${prep.data.sessionId}`)).status, 200);
      h.release();
      assert.equal((await up).status, 200);
    } finally { h.restore(); }
    assert.equal(k.state().items.find((x) => x.files?.[0]?.name === 'a.txt')?.status, 'partial');
    assert.deepEqual(left(k), ['a.txt']);
    assert.deepEqual(k.events.filter((e) => e.type === 'arrived').at(-1)?.item.files.map((x) => x.name), ['a.txt']); // the corner window says what came
    await k.stop();
  });

  await check('while a file gets its name a left address or a cancel cuts it off cleanly', async () => {
    const at = { ip: '127.0.0.52' };
    const k = await lone('k11', at);
    const fsp = require('node:fs/promises');
    let prep = await raw(k.port, 'POST', `${API}/prepare-upload`, twoFiles('fp-k11'), { host: at.ip });
    let h = hold(fsp, 'open', (file) => path.basename(String(file)) === 'a.txt');
    try {
      const up = later(uploadTo(k, prep, 'a', 'a', at.ip));
      await h.inside;
      at.ip = '127.0.0.53';
      await k.scan(); // the address it came over is gone, but the file is on its way
      assert.equal((await raw(k.port, 'POST', `${API}/prepare-upload`, twoFiles('fp-k11b'))).status, 409);
      h.release();
      assert.equal((await up).status, 200);
    } finally { h.restore(); }
    assert.equal(k.state().items.find((x) => x.files?.[0]?.name === 'a.txt')?.status, 'partial'); // b can no longer come
    prep = await raw(k.port, 'POST', `${API}/prepare-upload`, twoFiles('fp-k11c'));
    assert.equal(prep.status, 200);
    h = hold(fsp, 'open', (file) => path.basename(String(file)) === 'a (1).txt');
    try {
      const up = later(uploadTo(k, prep, 'a', 'a'));
      await h.inside;
      assert.equal((await raw(k.port, 'POST', `${API}/cancel?sessionId=${prep.data.sessionId}`)).status, 200);
      h.release();
      await up.catch(() => {}); // cancelling cut the connection
      await until(() => !fs.readdirSync(k.inbox).some((n) => n.includes('a (1).txt')));
    } finally { h.restore(); }
    await k.stop();
  });

  await check('quitting while a file comes leaves no half file, and keeps one that is being named', async () => {
    const k = await lone('k12');
    const prep = await raw(k.port, 'POST', `${API}/prepare-upload`, twoFiles('fp-k12'));
    const up = https.request({ host: '127.0.0.1', port: k.port, method: 'POST', path: `${API}/upload?sessionId=${prep.data.sessionId}&fileId=a&token=${prep.data.files.a}`,
      rejectUnauthorized: false, agent: false, headers: { 'Content-Length': 2 } });
    up.on('error', () => {});
    up.write('a');
    await until(() => k.state().items.find((x) => x.files?.[0]?.name === 'a.txt')?.got === 1);
    await k.stop();
    assert.deepEqual(left(k), []); // gone by the time stop() is done, before the app exits
    const k2 = await lone('k13');
    const prep2 = await raw(k2.port, 'POST', `${API}/prepare-upload`, twoFiles('fp-k13'));
    const h = hold(require('node:fs/promises'), 'rename', (from, to) => path.basename(String(to)) === 'a.txt');
    try {
      later(uploadTo(k2, prep2, 'a', 'a'));
      await h.inside;
      const stopping = k2.stop();
      h.release();
      await stopping;
    } finally { h.restore(); }
    assert.deepEqual(left(k2), ['a.txt']);
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'k13.json'), 'utf8')).items.find((x) => x.files?.[0]?.name === 'a.txt');
    assert.deepEqual([saved.status, saved.files[0].done], ['partial', true]);
  });

  await check('one upload of a file at a time: a second one meanwhile is refused, and one copy lands', async () => {
    const k = await lone('k14');
    const prep = await raw(k.port, 'POST', `${API}/prepare-upload`, twoFiles('fp-k14'));
    const h = hold(require('node:fs/promises'), 'rename', (from, to) => path.basename(String(to)) === 'a.txt');
    try {
      const first = later(uploadTo(k, prep, 'a', 'a'));
      await h.inside;
      assert.equal((await uploadTo(k, prep, 'a', 'a')).status, 409);
      h.release();
      assert.equal((await first).status, 200);
    } finally { h.restore(); }
    assert.deepEqual(left(k), ['a.txt']);
    assert.equal(k.state().items.find((x) => x.files?.[0]?.name === 'a.txt')?.got, 1);
    await k.stop();
  });

  await check('a name whose reservation cannot be closed is not left behind', async () => {
    const k = await lone('k15');
    const prep = await raw(k.port, 'POST', `${API}/prepare-upload`, twoFiles('fp-k15'));
    const fsp = require('node:fs/promises');
    const open = fsp.open;
    fsp.open = async (file, ...rest) => {
      const h = await open(file, ...rest);
      if (path.basename(String(file)) !== 'a.txt') return h;
      return { close: async () => { await h.close(); throw Object.assign(new Error('EIO'), { code: 'EIO' }); } };
    };
    try { assert.equal((await uploadTo(k, prep, 'a', 'a')).status, 500); } finally { fsp.open = open; }
    assert.deepEqual(left(k), []);
    await k.stop();
  });

  await check('what came of a cancelled batch is announced, and bytes that did not stay are not kept saved', async () => {
    const k = await lone('k16');
    let prep = await raw(k.port, 'POST', `${API}/prepare-upload`, twoFiles('fp-k16'));
    assert.equal((await uploadTo(k, prep, 'a', 'a')).status, 200);
    assert.equal((await raw(k.port, 'POST', `${API}/cancel?sessionId=${prep.data.sessionId}`)).status, 200);
    assert.deepEqual(k.events.filter((e) => e.type === 'arrived').at(-1)?.item.files.map((x) => x.name), ['a.txt']);
    // Cancelled while its file gets a name, which then fails: the byte counted for it goes from board.json too.
    prep = await raw(k.port, 'POST', `${API}/prepare-upload`, twoFiles('fp-k16b'));
    const fsp = require('node:fs/promises');
    const rename = fsp.rename;
    let entered, release;
    const inside = new Promise((r) => { entered = r; });
    const gate = new Promise((r) => { release = r; });
    fsp.rename = async (from, to) => {
      if (path.basename(String(to)) !== 'a (1).txt') return rename(from, to);
      entered(); await gate; throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    try {
      const up = later(uploadTo(k, prep, 'a', 'a'));
      await inside;
      await raw(k.port, 'POST', `${API}/cancel?sessionId=${prep.data.sessionId}`);
      await until(() => k.saved().items.find((x) => x.status === 'cancelled')?.got === 1); // written with its byte
      release();
      await up.catch(() => {});
    } finally { release(); fsp.rename = rename; }
    await until(() => k.saved().items.find((x) => x.status === 'cancelled')?.got === 0);
    await k.stop();
  });

  await check('while it stops the board takes nothing new', async () => {
    const k = await lone('k17');
    const prep = await raw(k.port, 'POST', `${API}/prepare-upload`, twoFiles('fp-k17'));
    const h = hold(require('node:fs/promises'), 'rename', (from, to) => path.basename(String(to)) === 'a.txt');
    let late, bad;
    try {
      later(uploadTo(k, prep, 'a', 'a'));
      await h.inside;
      // A register already in the board's hands, whose body (not even JSON) comes only once it stops.
      let req;
      const reg = later(new Promise((resolve, reject) => {
        req = https.request({ host: '127.0.0.1', port: k.port, method: 'POST', path: `${API}/register`, rejectUnauthorized: false, agent: false,
          headers: { 'Content-Length': 4, Expect: '100-continue' } }, (r) => { r.resume(); resolve(r.statusCode); });
        req.on('error', reject);
      }));
      await new Promise((r) => req.once('continue', r));
      const stopping = k.stop(); // waits for a.txt to get its name
      req.end('{bad');
      late = await raw(k.port, 'POST', `${API}/prepare-upload`, twoFiles('fp-k17-late'));
      bad = await reg;
      h.release();
      await stopping;
    } finally { h.restore(); }
    assert.deepEqual([late.status, bad], [403, 403]);
    assert.equal(k.saved().items.filter((x) => x.dir === 'in').length, 1);
  });

  await check('where it listens is told at once, before its first probes end', async () => {
    let held = null;
    const phone = require('node:net').createServer((c) => { held = c; });
    await new Promise((r) => phone.listen(0, '127.0.0.7', r));
    const events = [];
    const s = createPeer({ dir: path.join(tmp, 's3', 'in'), statePath: path.join(tmp, 's3.json'), alias: 'Weft s3', lan: false, hosts: ['127.0.0.1'], port: await freePort(),
      probePort: phone.address().port, tailnet: async () => ({ self: '127.0.0.250', peers: [{ ip: '127.0.0.7', online: true }] }), onEvent: (ev) => events.push(ev), log: () => {} });
    const starting = s.start();
    await until(() => held); // its first probe hangs, as a sleeping phone's does
    const told = events.some((e) => e.state.me.listening);
    held.destroy();
    await starting;
    await s.stop();
    phone.close();
    assert.ok(told, 'the page heard nothing while the probe hung');
  });

  await check('while it moves to another address the page hears it is not listening, then where it is', async () => {
    const at = { ip: '127.0.0.60' };
    const k = await lone('k18', at);
    const from = k.events.length;
    at.ip = '127.0.0.61';
    await k.scan();
    const seen = k.events.slice(from).map((e) => e.state.me.listening);
    assert.deepEqual([seen[0], seen.at(-1)], [false, true], JSON.stringify(seen));
    await k.stop();
  });

  await check('a scan that changes nothing tells the page nothing', async () => {
    // Without Tailscale (nowhere to listen), and with Tailscale and an online device without LocalSend (probed in vain).
    const closed = await freePort();
    const boards = [
      { name: 'k19', tailnet: async () => ({ self: null, peers: [] }), want: '"error":"no-tailnet"' },
      { name: 'k20', hosts: ['127.0.0.1'], tailnet: async () => ({ self: '127.0.0.250', peers: [{ ip: '127.0.0.8', online: true }] }), want: '"listening":true' },
    ];
    for (const b of boards) {
      const events = [];
      const k = createPeer({ dir: path.join(tmp, b.name, 'in'), statePath: path.join(tmp, `${b.name}.json`), alias: `Weft ${b.name}`, lan: false, hosts: b.hosts, port: await freePort(),
        probePort: closed, trusted: () => true, tailnet: b.tailnet, onEvent: (ev) => events.push(ev), log: () => {} });
      await k.start();
      const from = events.length;
      await k.scan();
      await k.scan();
      const seen = events.slice(from).filter((e) => e.type === 'state').map((e) => JSON.stringify(e.state.me));
      const me = JSON.stringify(k.state().me);
      await k.stop();
      assert.ok(from > 0, `${b.name}: start told nothing`);
      assert.deepEqual(seen, [], b.name);
      assert.ok(me.includes(b.want), me);
    }
  });

  await check('a scan that took longer than a newer one does not undo where the newer one listens', async () => {
    let call = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const k = createPeer({ dir: path.join(tmp, 'k21', 'in'), statePath: path.join(tmp, 'k21.json'), alias: 'Weft k21', lan: false, port: await freePort(), trusted: () => true,
      tailnet: async () => { const n = ++call; if (n === 2) { await gate; return { self: '127.0.0.70', peers: [] }; } return { self: n === 1 ? '127.0.0.70' : '127.0.0.71', peers: [] }; }, log: () => {} });
    await k.start(); // Tailscale at .70
    const slow = k.scan(); // asked before the address moved, answers after
    await k.scan(); // Tailscale now at .71
    release();
    await slow;
    const knock = (host) => new Promise((r) => { const c = require('node:net').connect(k.port, host); c.once('connect', () => { c.destroy(); r(true); }); c.once('error', () => r(false)); });
    const at = { new: await knock('127.0.0.71'), old: await knock('127.0.0.70') };
    await k.stop();
    assert.deepEqual(at, { new: true, old: false });
  });

  await check('an older scan answering after a newer one failed does not undo where it listens', async () => {
    let call = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const k = createPeer({ dir: path.join(tmp, 'k22', 'in'), statePath: path.join(tmp, 'k22.json'), alias: 'Weft k22', lan: false, port: await freePort(), trusted: () => true,
      tailnet: async () => { const n = ++call; if (n === 2) { await gate; return { self: '127.0.0.72', peers: [] }; } if (n === 3) throw new Error('tailscale status failed'); return { self: '127.0.0.73', peers: [] }; }, log: () => {} });
    await k.start(); // Tailscale at .73
    const slow = k.scan(); // asked first, answers last
    await k.scan(); // fails
    release();
    await slow;
    const knock = (host) => new Promise((r) => { const c = require('node:net').connect(k.port, host); c.once('connect', () => { c.destroy(); r(true); }); c.once('error', () => r(false)); });
    const at = { kept: await knock('127.0.0.73'), stale: await knock('127.0.0.72') };
    await k.stop();
    assert.deepEqual(at, { kept: true, stale: false });
  });

  await check('an older scan whose bind waited probes nothing once a newer scan says Tailscale is gone', async () => {
    let asked = 0;
    const phone = http.createServer((req, res) => { if (req.url.endsWith('/register')) asked++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ alias: 'Telefón', fingerprint: 'fp-k23', deviceType: 'mobile', protocol: 'http' })); });
    await new Promise((r) => phone.listen(0, '127.0.0.9', r));
    let call = 0;
    const k = createPeer({ dir: path.join(tmp, 'k23', 'in'), statePath: path.join(tmp, 'k23.json'), alias: 'Weft k23', lan: false, port: await freePort(), probePort: phone.address().port, trusted: () => true,
      tailnet: async () => { const n = ++call; if (n === 1) return { self: '127.0.0.74', peers: [] }; if (n === 2) return { self: '127.0.0.75', peers: [{ ip: '127.0.0.9', online: true }] }; return { self: null, peers: [] }; }, log: () => {} });
    await k.start(); // Tailscale at .74, no devices
    const netm = require('node:net');
    const listenOrig = netm.Server.prototype.listen;
    let entered = false;
    let open;
    const held = new Promise((r) => { open = r; });
    netm.Server.prototype.listen = function (...a) { if (a[1] === '127.0.0.75') { entered = true; held.then(() => listenOrig.apply(this, a)); return this; } return listenOrig.apply(this, a); };
    try {
      const older = k.scan(); // Tailscale moved to .75 with the phone online; its bind waits
      await until(() => entered);
      const newer = k.scan(); // Tailscale is gone
      open();
      await Promise.all([older, newer]);
    } finally { netm.Server.prototype.listen = listenOrig; }
    const devices = k.state().devices.map((d) => d.alias);
    const me = k.state().me;
    await k.stop();
    phone.close();
    assert.deepEqual({ asked, devices, error: me.error }, { asked: 0, devices: [], error: 'no-tailnet' });
  });

  await check('a newer scan that fails lets an older one, whose bind waited, tell the page where it listens', async () => {
    let call = 0;
    const events = [];
    const k = createPeer({ dir: path.join(tmp, 'k24', 'in'), statePath: path.join(tmp, 'k24.json'), alias: 'Weft k24', lan: false, port: await freePort(), trusted: () => true,
      tailnet: async () => { const n = ++call; if (n === 3) throw new Error('tailscale status failed'); return { self: n === 1 ? '127.0.0.76' : '127.0.0.77', peers: [] }; },
      onEvent: (ev) => events.push(ev), log: () => {} });
    await k.start(); // Tailscale at .76
    const netm = require('node:net');
    const listenOrig = netm.Server.prototype.listen;
    let entered = false;
    let open;
    const held = new Promise((r) => { open = r; });
    netm.Server.prototype.listen = function (...a) { if (a[1] === '127.0.0.77') { entered = true; held.then(() => listenOrig.apply(this, a)); return this; } return listenOrig.apply(this, a); };
    try {
      const older = k.scan(); // Tailscale moved to .77; its bind waits
      await until(() => entered);
      await k.scan(); // fails
      open();
      await older;
    } finally { netm.Server.prototype.listen = listenOrig; }
    const told = events.filter((e) => e.type === 'state').at(-1)?.state.me;
    const me = k.state().me;
    await k.stop();
    assert.deepEqual({ listening: me.listening, told: told?.listening }, { listening: true, told: true });
  });

  await check('a probe that stop() caught midway asks nothing more', async () => {
    let held = null, afterStop = 0, done = false;
    const phone = require('node:net').createServer((c) => { if (done) { afterStop++; c.destroy(); } else held = c; });
    await new Promise((r) => phone.listen(0, '127.0.0.6', r));
    let peers = [];
    const s = createPeer({ dir: path.join(tmp, 's2', 'in'), statePath: path.join(tmp, 's2.json'), alias: 'Weft s2', lan: false, hosts: ['127.0.0.1'], port: await freePort(),
      probePort: phone.address().port, tailnet: async () => ({ self: '127.0.0.250', peers }), log: () => {} });
    await s.start();
    peers = [{ ip: '127.0.0.6', online: true }];
    const scanning = s.scan();
    await until(() => held); // its HTTPS ask is open
    await s.stop();
    done = true;
    held.destroy(); // HTTPS fails only now: it must not try HTTP after the board stopped
    await scanning;
    assert.equal(afterStop, 0);
    phone.close();
  });

  await check('stop() ends at once, also with a connection still in TLS, and a scan it caught probes nothing', async () => {
    let hits = 0;
    const phone = http.createServer((req, res) => { req.resume(); hits++; res.writeHead(200); res.end('{}'); });
    await new Promise((r) => phone.listen(0, '127.0.0.5', r));
    let release;
    const gate = new Promise((r) => { release = r; });
    let gated = false;
    const s = createPeer({ dir: path.join(tmp, 's', 'in'), statePath: path.join(tmp, 's.json'), alias: 'Weft s', lan: false, hosts: ['127.0.0.1'], port: await freePort(),
      probePort: phone.address().port, tailnet: async () => { if (gated) await gate; return { self: '127.0.0.250', peers: [{ ip: '127.0.0.5', online: true }] }; }, log: () => {} });
    await s.start();
    hits = 0;
    const open = require('node:net').connect(s.port, '127.0.0.1');
    await new Promise((r) => open.once('connect', r));
    open.on('error', () => {});
    open.write(Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00, 0x01])); // a ClientHello that never finishes
    const closed = new Promise((r) => open.once('close', r));
    gated = true;
    const scanning = s.scan();
    await s.stop();
    await closed; // the board ended it; it did not wait for TLS to time out
    release();
    await scanning;
    assert.equal(hits, 0);
    phone.close();
  });

  await check('turning the local network off answers a question asked over it at once', async () => {
    const h = await peer('h3', { trusted: (ip) => ip === '127.0.0.1' });
    const stranger = later(raw(h.port, 'POST', `${API}/prepare-upload`, { info: { alias: 'Cudzí', fingerprint: 'cudzi3' }, files: { f: { id: 'f', fileName: 'x.txt', size: 1, fileType: 'text/x' } } }, { localAddress: '127.0.0.2' }));
    await until(() => h.state().ask);
    await h.setLan(false);
    assert.equal(h.state().ask, null);
    assert.equal((await stranger).status, 403);
    await h.stop();
  });

  await check('a first start is in the local network, also after an earlier build saved it off; turned off it stays off', async () => {
    // Never started and never switched on, so it listens nowhere: only the setting is looked at.
    const opts = { dir: path.join(tmp, 'n', 'in'), statePath: path.join(tmp, 'n.json'), alias: 'Weft n', log: () => {} };
    const n = createPeer(opts);
    assert.equal(n.state().me.lan, true);
    await n.stop();
    const saved = JSON.parse(fs.readFileSync(opts.statePath, 'utf8'));
    fs.writeFileSync(opts.statePath, JSON.stringify({ ...saved, lan: false, lanChosen: undefined })); // as the earlier build wrote it
    const old = createPeer(opts);
    assert.equal(old.state().me.lan, true);
    await old.setLan(false);
    await old.stop();
    const n2 = createPeer(opts);
    assert.equal(n2.state().me.lan, false);
    await n2.stop();
    const off = JSON.parse(fs.readFileSync(opts.statePath, 'utf8'));
    assert.equal(off.lanChosen, true);
    fs.writeFileSync(opts.statePath, JSON.stringify({ ...off, lan: true })); // he switched it on (setLan(true) would listen)
    const n3 = createPeer({ ...opts, lan: false });
    assert.equal(n3.state().me.lan, true, 'his choice beats a caller\'s default');
    await n3.stop();
  });

  await check('the board survives a restart; an unfinished send says „stopped“', async () => {
    const before = a.state().items.length;
    a.state().items[0].status = 'sending';
    await a.stop();
    const a2 = await peer('a');
    assert.equal(a2.state().items.length, before);
    assert.equal(a2.state().items[0].status, 'stopped');
    assert.equal(a2.remove(a2.state().items[0].id)?.status, 'stopped');
    assert.equal(a2.state().items.length, before - 1);
    await a2.stop();
  });

  await b.stop();
  console.log(results.join('\n'));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();

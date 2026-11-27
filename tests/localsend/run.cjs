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
const { createPeer, tailnetIp, safeParts } = require('../../desktop/localsend.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weft-localsend-'));
const API = '/api/localsend/v2';
let failed = 0;
const results = [];
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

/** A peer on 127.0.0.1 whose tailnet is the given ports' peers; off the local network, so nothing reaches a real one. */
async function peer(name, { trusted = () => true, peers = [], probePort, port } = {}) {
  const events = [];
  const p = createPeer({
    dir: path.join(tmp, name, 'in'), statePath: path.join(tmp, `${name}.json`), alias: `Weft ${name}`, lan: false,
    tailnet: async () => ({ self: null, peers }), hosts: ['127.0.0.1'], trusted, probePort, port: port || await freePort(),
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
    const r = await new Promise((resolve) => https.get({ host: '127.0.0.1', port: a.port, path: `${API}/info`, rejectUnauthorized: false, agent: false }, (res) => {
      resolve({ cert: res.socket.getPeerCertificate().raw, status: res.statusCode }); res.resume();
    }));
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
    const stranger = raw(h.port, 'POST', `${API}/prepare-upload`, { info: { alias: 'Cudzí', fingerprint: 'cudzi' }, files: { f: { id: 'f', fileName: 'x.txt', size: 1, fileType: 'text/x' } } }, { localAddress: '127.0.0.2' });
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
      const r = to(host, from, 'prepare-upload', body, tls);
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

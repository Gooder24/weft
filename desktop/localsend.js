// LocalSend (protocol v2, github.com/localsend/protocol) inside Weft's desktop shell: the board („Nástenka“) sends
// files and text to Karchi's own devices that run the LocalSend app, and keeps what they send in Downloads/Weft.
//
// It listens only on this machine's Tailscale address, so only devices of the tailnet reach it, and takes what they
// send without asking. „Aj v miestnej sieti“ (st.lan) adds every interface and LocalSend's multicast discovery, like
// the LocalSend app itself; files and text from a device outside the tailnet then wait for Prijať on the board.
//
// Plain Node, no Electron: main.js wires it to the window, tests/localsend/run.cjs runs it against itself and a fake
// HTTPS receiver.
'use strict';
const http = require('node:http');
const https = require('node:https');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');

const API = '/api/localsend/v2';
const PORT = 53317;
const GROUP = '224.0.0.167';
const VERSION = '2.1';
const MAX_ITEMS = 200; // the board keeps the newest; files stay on the disk
const ASK_MS = 60_000; // files and text from outside the tailnet wait this long for Prijať
const CERT_FP = /^[0-9a-f]{64}$/i; // a fingerprint that is a certificate's SHA-256, as LocalSend's
const IDLE_MS = 5 * 60_000; // a receive session nobody writes to ends
const ONLINE_MS = 3 * 60_000; // a device seen this recently counts as there
const PREPARE_MS = 120_000; // the other side may wait for its own Accept

/** Tailscale's addresses: 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
const tailnetIp = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(ip) || /^fd7a:115c:a1e0:/i.test(ip);
const bare = (ip) => String(ip || '').replace(/^::ffff:/, '');
const newId = () => crypto.randomBytes(12).toString('hex');

/** A received name as a path under `dir`: LocalSend sends folders as „folder/file“; no part may climb out. */
function safeParts(name) {
  const parts = String(name || '').split(/[/\\]+/).map((p) => p.replace(/[\x00-\x1f\x7f]/g, '').trim())
    .filter((p) => p && p !== '.' && p !== '..').map((p) => p.replace(/^\.+/, '_').slice(0, 180));
  return parts.length ? parts : ['subor'];
}

/** Claims a file name nobody has (adds „ (1)“ before the extension) by creating it empty. Folders are made one by
 *  one, and one that is a link (made by someone else) is refused before anything is made behind it. */
async function claim(dir, parts) {
  await fsp.mkdir(dir, { recursive: true });
  const root = await fsp.realpath(dir);
  let folder = root;
  for (const part of parts.slice(0, -1)) {
    folder = path.join(folder, part);
    try { await fsp.mkdir(folder); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    if ((await fsp.realpath(folder)) !== folder) throw Object.assign(new Error('bad name'), { status: 400 });
  }
  const name = parts[parts.length - 1];
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || name;
  for (let i = 0; i < 1000; i++) {
    const file = path.join(folder, i ? `${stem} (${i})${ext}` : name);
    if (!file.startsWith(root + path.sep)) throw Object.assign(new Error('bad name'), { status: 400 });
    try { await (await fsp.open(file, 'wx')).close(); return file; } catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  throw new Error('no free name');
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- identity
// A LocalSend device over HTTPS is known by the SHA-256 of its certificate (uppercase hex), and LocalSend 1.19 lets
// only a client that shows its own certificate in, with that hash as its fingerprint. The board makes one self-signed
// certificate like LocalSend's (RSA 2048, „LocalSend User“), once, and keeps it in its state file.

const derLen = (n) => { if (n < 128) return Buffer.from([n]); const b = []; for (; n; n >>= 8) b.unshift(n & 255); return Buffer.from([0x80 | b.length, ...b]); };
const der = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]); };
const seq = (...p) => der(0x30, ...p);
const derInt = (b) => der(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const oid = (dotted) => {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (let v of rest) { const enc = [v & 127]; for (v >>= 7; v; v >>= 7) enc.unshift((v & 127) | 128); out.push(...enc); }
  return der(0x06, Buffer.from(out));
};
const derTime = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return d.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(String(d.getUTCFullYear()).slice(2) + rest)) : der(0x18, Buffer.from(d.getUTCFullYear() + rest));
};
const certHash = (raw) => crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();

/** A self-signed X.509 v3 certificate: { cert, key } as PEM and its fingerprint. */
function makeIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algo = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00])); // sha256WithRSAEncryption
  const name = seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from('LocalSend User')))));
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const now = Date.now();
  const tbs = seq(der(0xa0, derInt(Buffer.from([2]))), derInt(serial), algo, name,
    seq(derTime(new Date(now - 864e5)), derTime(new Date(now + 20 * 365 * 864e5))), name, publicKey.export({ type: 'spki', format: 'der' }));
  const raw = seq(tbs, algo, der(0x03, Buffer.from([0]), crypto.sign('sha256', tbs, privateKey)));
  const cert = `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }), fingerprint: certHash(raw) };
}
/** The fingerprint a TLS peer proved with its certificate, or null (plain HTTP, no certificate). */
const provenBy = (socket) => { const raw = socket?.getPeerCertificate?.()?.raw; return raw ? certHash(raw) : null; };
const sameFp = (a, b) => String(a || '').toUpperCase() === String(b || '').toUpperCase();

/** One HTTP(S) request to a LocalSend device: `json` or a file `stream` of `length` bytes. HTTPS shows `tls` (the
 *  board's certificate) and accepts the device's self-signed one, as LocalSend does; with `expect` (a fingerprint) it
 *  sends nothing unless the certificate is that one. `proven` in the result is the certificate's fingerprint.
 *  Resolves { status, data, proven }. */
function request(dev, method, pathq, { json, stream, length, timeout = 10_000, tls, expect, onBytes } = {}) {
  return new Promise((resolve, reject) => {
    const lib = dev.protocol === 'https' ? https : http;
    const body = json === undefined ? null : Buffer.from(JSON.stringify(json));
    const headers = body ? { 'Content-Type': 'application/json', 'Content-Length': body.length }
      : stream ? { 'Content-Type': 'application/octet-stream', 'Content-Length': length } : { 'Content-Length': 0 };
    const secure = dev.protocol === 'https' ? { rejectUnauthorized: false, cert: tls?.cert, key: tls?.key, agent: false } : {};
    const req = lib.request({ host: dev.ip, port: dev.port, method, path: pathq, headers, timeout, ...secure }, (res) => {
      const chunks = [];
      const proven = provenBy(res.socket);
      res.on('data', (c) => { if (chunks.length < 256) chunks.push(c); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        resolve({ status: res.statusCode, data, proven });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => { stream?.destroy(); reject(err); });
    // A file that is gone or unreadable fails the request, also before the handshake lets it flow.
    stream?.on('error', (err) => req.destroy(err));
    const go = () => {
      if (!stream) return req.end(body);
      if (onBytes) stream.on('data', (c) => onBytes(c.length));
      stream.pipe(req);
    };
    if (dev.protocol !== 'https') return go();
    // Nothing (not even the headers) goes before the handshake shows who answers.
    req.once('socket', (sock) => sock.once('secureConnect', () => {
      if (expect && !sameFp(provenBy(sock), expect)) return req.destroy(Object.assign(new Error('another certificate'), { code: 'ECERT' }));
      go();
    }));
  });
}

/**
 * opts: dir (where received files go), statePath (the board's JSON), alias, tailnet() → { self, peers: [{ ip, name,
 * online }] }, onEvent({ type, state, ... }), log(...), and for tests: port, hosts (extra addresses to listen on),
 * trusted(ip) (default: a Tailscale address), probePort.
 */
function createPeer(opts) {
  const { dir, statePath, alias, deviceModel = 'Weft', onEvent = () => {}, log = () => {} } = opts;
  const tailnet = opts.tailnet || (async () => ({ self: null, peers: [] }));
  const trusted = opts.trusted || ((ip) => tailnetIp(ip));
  const wantPort = opts.port || PORT;
  const probePort = opts.probePort || PORT;
  const extraHosts = opts.hosts || [];

  let st = { fingerprint: newId(), lan: false, devices: {}, items: [] };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }; } catch { /* a first start */ }
  if (!st.tls?.cert || !st.tls?.key) { st.tls = makeIdentity(); st.fingerprint = st.tls.fingerprint; }
  for (const it of st.items) if (['sending', 'receiving'].includes(it.status)) it.status = 'stopped'; // the app quit midway

  let selfIp = null;
  let servers = [];
  let listeningOn = [];
  let port = wantPort;
  let listenError = '';
  let sock = null; // multicast, only with st.lan
  let session = null; // the one transfer being received
  let asking = null; // { id, resolve, ... } files from outside the tailnet waiting for Prijať
  let saveTimer = null;
  let stateTimer = null;
  let stopped = false;

  // One write at a time (two would race for the .tmp file); a change during a write is written right after it.
  let saving = null;
  let dirty = false;
  const flush = () => {
    if (saving) { dirty = true; return saving; }
    saving = (async () => {
      do {
        dirty = false;
        const tmp = `${statePath}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(st), { mode: 0o600 });
        await fsp.rename(tmp, statePath);
      } while (dirty && !stopped);
    })().catch((err) => log('board save', err.message)).finally(() => { saving = null; });
    return saving;
  };
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 300);
  };
  const info = () => ({ alias, version: VERSION, deviceModel, deviceType: 'desktop', fingerprint: st.fingerprint, port, protocol: 'https', download: false });
  // A device known by a certificate's fingerprint (64 hex digits, as LocalSend's) must show that certificate again.
  const call = (dev, method, pathq, o = {}) => request(dev, method, pathq, { ...o, tls: st.tls, expect: CERT_FP.test(dev.fingerprint || '') ? dev.fingerprint : null });
  const snapshot = () => ({
    me: { alias, port, lan: st.lan, tailnet: !!selfIp, listening: listeningOn.length > 0, error: listenError, dir },
    devices: Object.values(st.devices).map((d) => ({ ...d, online: Date.now() - d.seen < ONLINE_MS })).sort((a, b) => b.seen - a.seen),
    items: st.items,
    ask: asking && { id: asking.id, device: asking.device, count: asking.count, size: asking.size, names: asking.names, text: asking.text },
  });
  const emit = (type, extra = {}) => { if (!stopped) onEvent({ type, state: snapshot(), ...extra }); };
  // Progress comes in many small pieces: the window hears of it at most four times a second.
  const emitSoon = () => { if (!stateTimer) stateTimer = setTimeout(() => { stateTimer = null; emit('state'); }, 250); };

  /** A device that announced itself, registered or answered a probe; keyed by its fingerprint. Devices of the tailnet
   *  are default targets from the start, ones of the local network only once Karchi says so. `proven` is the hash of
   *  the certificate the claim came with (the client certificate of its request, or the server's of our probe). */
  function remember(body, ip, how, proven = null) {
    const said = String(body?.fingerprint || `${ip}:${body?.port || PORT}`);
    const fp = CERT_FP.test(said) ? said.toUpperCase() : said; // one record per certificate, however it is written
    if (fp === st.fingerprint) return null;
    const was = st.devices[fp];
    const port = Number(body?.port) || was?.port || PORT;
    const protocol = body?.protocol === 'https' ? 'https' : body?.protocol === 'http' ? 'http' : was?.protocol || 'https';
    // A device known by its certificate moves (address, port) or drops encryption only on a claim that certificate
    // proves. Anyone can name its fingerprint (LocalSend announces it), so another claim only makes us ask the claimed
    // address over HTTPS, pinned to that certificate, and changes nothing meanwhile.
    if (was && CERT_FP.test(fp) && was.protocol === 'https' && !sameFp(proven, fp)) {
      if (was.ip !== ip || was.port !== port || protocol !== 'https') { confirm(fp, ip, port); return null; }
      was.seen = Date.now();
      save();
      return was;
    }
    const via = trusted(ip) ? 'tailnet' : 'lan';
    const dev = {
      fingerprint: fp, alias: String(body?.alias || was?.alias || ip).slice(0, 80), ip, port, protocol,
      deviceType: body?.deviceType || was?.deviceType || null, deviceModel: body?.deviceModel || was?.deviceModel || null,
      via, seen: Date.now(),
      // Seen on the tailnet it becomes a default, unless Karchi took it off himself; never the other way by itself.
      default: was ? was.default || (!was.chosen && via === 'tailnet') : via === 'tailnet', chosen: was?.chosen || false,
    };
    st.devices[fp] = dev;
    save();
    if (!was || was.ip !== ip || was.alias !== dev.alias) log('board device', how, dev.alias, ip);
    return dev;
  }
  const who = (dev) => ({ fingerprint: dev?.fingerprint || '', alias: dev?.alias || '?' });
  /** Whether the device of a certificate now answers at another address: a register there that must show it. */
  const confirming = new Set();
  function confirm(fp, ip, port) {
    const key = `${fp} ${ip} ${port}`;
    if (stopped || confirming.has(key)) return;
    confirming.add(key);
    call({ fingerprint: fp, ip, port, protocol: 'https' }, 'POST', `${API}/register`, { json: info(), timeout: 3000 })
      .then((r) => {
        if (r.status === 200 && r.data && typeof r.data === 'object' && remember({ ...r.data, fingerprint: fp, port, protocol: 'https' }, ip, 'confirm', r.proven)) emitSoon();
      })
      .catch(() => { /* not that device */ })
      .finally(() => confirming.delete(key));
  }

  function addItem(item) {
    const it = { id: newId(), at: Date.now(), ...item };
    st.items.unshift(it);
    st.items.length = Math.min(st.items.length, MAX_ITEMS);
    save();
    return it;
  }

  // ---------------------------------------------------------------- receiving

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localsend');
    const ip = bare(req.socket.remoteAddress);
    const proven = provenBy(req.socket);
    const reply = (code, body) => {
      if (res.headersSent) return;
      res.writeHead(code, body ? { 'Content-Type': 'application/json' } : {});
      res.end(body ? JSON.stringify(body) : undefined);
    };
    try {
      const route = `${req.method} ${url.pathname}`;
      if (route === `GET ${API}/info`) return reply(200, info());
      if (route === `POST ${API}/register`) {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        if ((!proven || sameFp(proven, body?.fingerprint)) && remember(body, ip, 'register', proven)) emitSoon();
        return reply(200, info());
      }
      if (route === `POST ${API}/prepare-upload`) return await prepare(req, ip, reply, proven);
      if (route === `POST ${API}/upload`) return await upload(req, url, ip, reply);
      if (route === `POST ${API}/cancel`) {
        if (session && session.id === url.searchParams.get('sessionId') && session.ip === ip) endSession('cancelled');
        return reply(200);
      }
      reply(404);
    } catch (err) {
      log('board request', err.message);
      reply(err.status || (err instanceof SyntaxError ? 400 : 500), { message: err.message });
    }
  }

  const sessionLive = () => session && Date.now() - session.touched < IDLE_MS;

  async function prepare(req, ip, reply, proven) {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const files = Object.values(body?.files && typeof body.files === 'object' ? body.files : {})
      .filter((f) => f && typeof f.id === 'string' && typeof f.fileName === 'string');
    if (!body?.info || !files.length) return reply(400, { message: 'Invalid body' });
    if (proven && !sameFp(proven, body.info.fingerprint)) return reply(403, { message: 'Fingerprint does not match the client certificate' });
    const dev = remember(body.info, ip, 'upload', proven) || { fingerprint: '', alias: ip };
    // LocalSend's „Message“: one text file whose text is its preview; nothing is uploaded.
    const text = files.length === 1 && /^text\//.test(files[0].fileType || '') && typeof files[0].preview === 'string' ? files[0].preview.slice(0, 100_000) : null;
    // A question to Karchi holds back only others from outside; his own devices go on.
    if ((asking && !trusted(ip)) || (text == null && sessionLive())) return reply(409, { message: 'Blocked by another session' });
    const size = files.reduce((n, f) => n + (Number(f.size) || 0), 0);
    // Files and text from outside the tailnet wait for Prijať.
    if (!trusted(ip)) {
      const ok = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ASK_MS);
        asking = { id: newId(), device: who(dev), count: files.length, size, names: text == null ? files.slice(0, 5).map((f) => f.fileName) : [],
          text: text == null ? undefined : text.slice(0, 300), resolve: (yes) => { clearTimeout(timer); resolve(yes); } };
        emit('ask');
      });
      asking = null;
      emit('state');
      if (!ok) return reply(403, { message: 'Rejected' });
      if (text == null && sessionLive()) return reply(409, { message: 'Blocked by another session' });
    }
    if (text != null) {
      const item = addItem({ dir: 'in', device: who(dev), text, status: 'done' });
      emit('arrived', { item });
      return reply(204);
    }
    if (session) endSession('stopped');
    const id = newId();
    const item = addItem({ dir: 'in', device: who(dev), status: 'receiving', got: 0, total: size,
      files: files.map((f) => ({ name: safeParts(f.fileName).join('/'), size: Number(f.size) || 0, type: String(f.fileType || '') })) });
    session = { id, ip, item, touched: Date.now(), streams: new Set(),
      files: new Map(files.map((f, i) => [f.id, { token: newId(), index: i, name: f.fileName, sha256: typeof f.sha256 === 'string' ? f.sha256.toLowerCase() : null, done: false }])) };
    emit('state');
    reply(200, { sessionId: id, files: Object.fromEntries([...session.files].map(([fid, f]) => [fid, f.token])) });
  }

  async function upload(req, url, ip, reply) {
    const [sid, fid, token] = ['sessionId', 'fileId', 'token'].map((k) => url.searchParams.get(k));
    if (!sid || !fid || !token) return reply(400, { message: 'Missing parameters' });
    if (!session || session.id !== sid) return reply(sessionLive() ? 409 : 403, { message: 'Invalid session' });
    const f = session.files.get(fid);
    if (!f || f.token !== token || session.ip !== ip) return reply(403, { message: 'Invalid token or IP address' });
    if (f.done) { req.resume(); return reply(200); }
    const s = session;
    s.touched = Date.now();
    const target = await claim(dir, safeParts(f.name));
    // Written beside it under a name of its own, never over an existing file, and renamed once whole.
    const part = path.join(path.dirname(target), `.${path.basename(target)}.${newId()}.part`);
    const hash = crypto.createHash('sha256');
    let got = 0;
    const ok = await new Promise((resolve) => {
      const out = fs.createWriteStream(part, { flags: 'wx', mode: 0o644 });
      let settled = false;
      const done = (yes) => { if (settled) return; settled = true; if (!yes) out.destroy(); resolve(yes); };
      s.streams.add(req);
      req.on('data', (c) => { hash.update(c); got += c.length; s.item.got += c.length; s.touched = Date.now(); emitSoon(); });
      req.on('close', () => { if (!req.complete) done(false); });
      out.on('error', () => done(false));
      out.on('finish', () => done(req.complete));
      req.pipe(out);
    });
    s.streams.delete(req);
    if (!ok || session !== s) {
      await fsp.rm(part, { force: true });
      await fsp.rm(target, { force: true });
      s.item.got -= got;
      return reply(500, { message: 'Upload failed' });
    }
    if (f.sha256 && hash.digest('hex') !== f.sha256) {
      await fsp.rm(part, { force: true });
      await fsp.rm(target, { force: true });
      s.item.got -= got;
      return reply(422, { message: 'Checksum mismatch' });
    }
    await fsp.rename(part, target);
    f.done = true;
    Object.assign(s.item.files[f.index], { path: target, name: path.relative(dir, target), done: true });
    if ([...s.files.values()].every((x) => x.done)) {
      s.item.status = 'done';
      session = null;
      save();
      emit('arrived', { item: s.item });
    } else {
      save();
      emitSoon();
    }
    reply(200);
  }

  /** The sender cancelled or went quiet: what arrived whole stays, the rest goes. */
  function endSession(status) {
    if (!session) return;
    const s = session;
    session = null;
    for (const r of s.streams) r.destroy();
    s.item.status = s.item.files.some((x) => x.done) ? 'partial' : status;
    save();
    emit('state');
  }

  // ---------------------------------------------------------------- sending

  /** Sends files ({ path, name, size, type }) or a text to one device; resolves its status. */
  async function sendOne(dev, payload, onBytes) {
    const files = payload.text != null
      ? [{ id: newId(), fileName: `${newId()}.txt`, size: Buffer.byteLength(payload.text), fileType: 'text/plain', sha256: null, preview: payload.text }]
      : payload.files.map((f) => ({ id: newId(), fileName: f.name, size: f.size, fileType: f.type || 'application/octet-stream', sha256: null, preview: null, path: f.path }));
    const meta = Object.fromEntries(files.map(({ path: _p, ...f }) => [f.id, f]));
    let r;
    try {
      r = await call(dev, 'POST', `${API}/prepare-upload`, { json: { info: info(), files: meta }, timeout: PREPARE_MS });
    } catch (err) {
      // Someone else answers at its address: nothing was sent to them.
      if (err.code === 'ECERT') return { status: 'failed', note: 'another certificate' };
      return { status: 'offline', note: err.code || err.message };
    }
    if (r.status === 204) return { status: 'done' };
    if (r.status === 403) return { status: 'declined' };
    if (r.status === 409 || r.status === 429) return { status: 'busy' };
    if (r.status === 401) return { status: 'pin' };
    if (r.status !== 200 || !r.data?.sessionId || typeof r.data.files !== 'object') return { status: 'failed', note: `HTTP ${r.status}` };
    const { sessionId, files: tokens } = r.data;
    // A file that failed ends the session there too, so the device is not left „busy“ until it gives up.
    const cancel = () => call(dev, 'POST', `${API}/cancel?sessionId=${encodeURIComponent(sessionId)}`, { timeout: 3000 }).catch(() => {});
    for (const f of files) {
      const token = tokens[f.id];
      if (!token) continue; // the receiver took only some
      const q = `sessionId=${encodeURIComponent(sessionId)}&fileId=${encodeURIComponent(f.id)}&token=${encodeURIComponent(token)}`;
      const stream = f.path ? fs.createReadStream(f.path) : Readable.from([Buffer.from(payload.text)]);
      let up;
      try {
        up = await call(dev, 'POST', `${API}/upload?${q}`, { stream, length: f.size, timeout: 60_000, onBytes });
      } catch (err) {
        await cancel();
        return { status: 'failed', note: err.code || err.message };
      }
      if (up.status !== 200 && up.status !== 204) { await cancel(); return { status: 'failed', note: `HTTP ${up.status}` }; }
    }
    return { status: 'done' };
  }

  const STATUS_ORDER = ['done', 'busy', 'declined', 'pin', 'offline', 'failed'];
  /** One board item to every default device (or `to`, fingerprints); files are { path, name, size, type }. */
  async function send({ files, text, to }) {
    const targets = (to?.length ? to.map((fp) => st.devices[fp]) : Object.values(st.devices).filter((d) => d.default)).filter(Boolean);
    if (!targets.length) return { error: 'no-device' };
    const one = text != null ? null : files.reduce((n, f) => n + f.size, 0);
    const item = addItem({ dir: 'out', device: who(targets[0]), text: text ?? undefined, status: 'sending', got: 0,
      total: (one ?? Buffer.byteLength(text)) * targets.length,
      files: files?.map((f) => ({ name: f.name, size: f.size, type: f.type, path: f.path })),
      targets: targets.map((d) => ({ ...who(d), status: 'sending' })) });
    emit('state');
    run(item, targets);
    return { id: item.id };
  }

  async function run(item, targets) {
    const payload = item.text != null ? { text: item.text } : { files: item.files };
    await Promise.all(targets.map(async (dev, i) => {
      const res = await sendOne(dev, payload, (n) => { item.got += n; emitSoon(); });
      Object.assign(item.targets[i], res);
      if (res.status !== 'offline') { dev.seen = Date.now(); }
    }));
    const states = item.targets.map((t) => t.status);
    item.status = states.every((s) => s === 'done') ? 'done' : states.some((s) => s === 'done') ? 'partial'
      : STATUS_ORDER.find((s) => states.includes(s)) || 'failed';
    save();
    emit('sent', { item });
  }

  /** Sends an item again to the devices it did not reach. */
  function retry(id) {
    const item = st.items.find((x) => x.id === id && x.dir === 'out');
    if (!item || item.status === 'sending') return false;
    const targets = item.targets.filter((t) => t.status !== 'done').map((t) => st.devices[t.fingerprint]).filter(Boolean);
    if (!targets.length) return false;
    if (item.files?.some((f) => !fs.existsSync(f.path))) return false;
    item.targets = item.targets.filter((t) => t.status === 'done').concat(targets.map((d) => ({ ...who(d), status: 'sending' })));
    item.status = 'sending';
    item.got = 0;
    emit('state');
    run(item, targets).catch((err) => log('board retry', err.message));
    return true;
  }

  // ---------------------------------------------------------------- finding devices

  /** Asks each online device of the tailnet whether LocalSend runs there (HTTPS first, LocalSend's default). */
  async function probe(ip) {
    for (const protocol of ['https', 'http']) {
      try {
        const r = await call({ ip, port: probePort, protocol }, 'POST', `${API}/register`, { json: info(), timeout: 2500 });
        // Over HTTPS the device is who its certificate says, whatever its answer claims.
        if (r.status === 200 && r.data && typeof r.data === 'object') return remember({ ...r.data, fingerprint: r.proven || r.data.fingerprint, port: probePort, protocol }, ip, 'probe', r.proven);
      } catch { /* nothing there, or not this protocol */ }
    }
    return null;
  }

  async function scan() {
    try {
      const t = await tailnet();
      selfIp = t.self || null;
      await listen();
      await Promise.all((t.peers || []).filter((p) => p.online && p.ip && p.ip !== selfIp).map((p) => probe(p.ip)));
    } catch (err) {
      log('board scan', err.message);
    }
    if (sock) announce();
    emit('state');
  }

  // ---------------------------------------------------------------- the local network (st.lan)

  function announce() {
    try { sock?.send(Buffer.from(JSON.stringify({ ...info(), announce: true })), PORT, GROUP); } catch { /* no network */ }
  }
  function onMulticast(buf, rinfo) {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || typeof m !== 'object' || !m.fingerprint || m.fingerprint === st.fingerprint) return;
    const dev = remember(m, bare(rinfo.address), 'multicast');
    if (!dev) return;
    emitSoon();
    // An announcement wants an answer: by HTTP to it, else by multicast.
    if (m.announce) {
      call(dev, 'POST', `${API}/register`, { json: info(), timeout: 3000 })
        .catch(() => { try { sock?.send(Buffer.from(JSON.stringify({ ...info(), announce: false })), PORT, GROUP); } catch { /* gone */ } });
    }
  }
  function multicast(on) {
    if (!on) { try { sock?.close(); } catch { /* closed */ } sock = null; return; }
    if (sock) return;
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock = s;
    s.on('message', onMulticast);
    s.on('error', (err) => { log('board multicast', err.message); if (sock === s) sock = null; try { s.close(); } catch { /* closed */ } });
    s.bind(PORT, () => {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !tailnetIp(a.address)) { try { s.addMembership(GROUP, a.address); } catch { /* not this one */ } }
      }
      announce();
    });
  }

  // ---------------------------------------------------------------- listening

  /** Listens where it should now; calls queue, so a quick on/off of „Aj v miestnej sieti“ ends as the last one says. */
  let listening = Promise.resolve();
  function listen() {
    listening = listening.then(rebind, rebind);
    return listening;
  }
  async function rebind() {
    if (stopped) return;
    const want = st.lan ? ['0.0.0.0'] : [selfIp, ...extraHosts].filter(Boolean);
    if (want.join() === listeningOn.join() && servers.length) return;
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    servers = [];
    listeningOn = [];
    listenError = want.length ? '' : 'no-tailnet';
    // 53317 is LocalSend's; when the LocalSend app has it, the next free one (the board says which).
    for (const candidate of [wantPort, wantPort + 1, wantPort + 2, wantPort + 3]) {
      const opened = [];
      try {
        for (const host of want) {
          // HTTPS like the LocalSend app; a sender that shows a certificate must claim its fingerprint.
          const s = https.createServer({ cert: st.tls.cert, key: st.tls.key, requestCert: true, rejectUnauthorized: false }, (req, res) => { handle(req, res); });
          s.requestTimeout = 0; // a big file takes long
          await new Promise((resolve, reject) => { s.once('error', reject); s.listen(candidate, host, () => { s.off('error', reject); resolve(); }); });
          opened.push(s);
        }
        servers = opened;
        listeningOn = want;
        port = candidate;
        break;
      } catch (err) {
        await Promise.all(opened.map((s) => new Promise((r) => s.close(r))));
        listenError = err.code === 'EADDRINUSE' ? 'port' : err.code || err.message;
        if (err.code !== 'EADDRINUSE') break;
      }
    }
    if (listeningOn.length) listenError = '';
    else if (want.length) log('board listen', listenError);
  }

  async function setLan(on) {
    st.lan = !!on;
    save();
    await listen();
    multicast(st.lan);
    emit('state');
  }

  function setDefault(fp, on) {
    if (!st.devices[fp]) return;
    st.devices[fp].default = !!on;
    st.devices[fp].chosen = true;
    save();
    emit('state');
  }

  function forget(fp) {
    delete st.devices[fp];
    save();
    emit('state');
  }

  function remove(id) {
    const at = st.items.findIndex((x) => x.id === id);
    if (at < 0 || st.items[at].status === 'sending' || st.items[at].status === 'receiving') return null;
    const [gone] = st.items.splice(at, 1);
    save();
    emit('state');
    return gone;
  }

  function respond(id, yes) {
    if (asking?.id === id) asking.resolve(!!yes);
  }

  /** A received or sent file's path, for the shell to open; never a path the window names. */
  function fileOf(id, index) {
    const f = st.items.find((x) => x.id === id)?.files?.[index];
    return f?.path && (f.done || st.items.find((x) => x.id === id).dir === 'out') ? f.path : null;
  }

  async function start() {
    await fsp.mkdir(dir, { recursive: true });
    await scan();
    if (st.lan) multicast(true);
  }

  async function stop() {
    stopped = true;
    clearTimeout(stateTimer);
    multicast(false);
    if (session) endSession('stopped');
    if (asking) asking.resolve(false);
    clearTimeout(saveTimer);
    await saving; // a write in flight must not land after the last one
    try { fs.writeFileSync(statePath, JSON.stringify(st), { mode: 0o600 }); } catch { /* no disk */ }
    await listening;
    await Promise.all(servers.map((s) => new Promise((r) => { s.close(r); s.closeAllConnections?.(); })));
    servers = [];
  }

  return { start, stop, scan, send, retry, setLan, setDefault, forget, remove, respond, fileOf, state: snapshot, info, onMulticast, get port() { return port; } };
}

module.exports = { createPeer, tailnetIp, safeParts, PORT };

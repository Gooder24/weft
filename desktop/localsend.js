// LocalSend (protocol v2, github.com/localsend/protocol) inside Weft's desktop shell: the board („Nástenka“) sends
// files and text to Karchi's own devices that run the LocalSend app, and keeps what they send in Downloads/Weft.
//
// It takes what devices of the tailnet send without asking. „Aj v miestnej sieti“ (st.lan, on until Karchi switches
// it: st.lanChosen; opts.lan until then, for tests) listens on every interface with LocalSend's multicast discovery, like the LocalSend
// app itself, and files and text from a device outside the tailnet wait for Prijať on the board; off, it listens only
// on this machine's Tailscale address.
//
// Plain Node, no Electron: main.js wires it to the window, tests/localsend/run.cjs runs it against itself and a fake
// HTTPS receiver.
'use strict';
const http = require('node:http');
const https = require('node:https');
const dgram = require('node:dgram');
const nodeTls = require('node:tls');
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
/** The key a device is kept under: a certificate's fingerprint in capitals, however it was written. */
const fpKey = (fp) => (CERT_FP.test(String(fp || '')) ? String(fp).toUpperCase() : String(fp || ''));
const IDLE_MS = 5 * 60_000; // a receive session nobody writes to ends
const ONLINE_MS = 3 * 60_000; // a device seen this recently counts as there
// Reaching a device (TCP and TLS's handshake) takes at most this; its answer to a send then waits as long as its user
// does (Accept, or Close on a text it shows at once), as LocalSend's own sender waits. Delete stops the wait.
const CONNECT_MS = 5_000;
const KEEPALIVE_MS = 15_000; // a device gone while its answer is awaited is noticed by the kernel's keepalive
const CANCEL_MS = 3_000; // telling a device a send ended takes at most this, also when it answers byte by byte
/** How long quitting may wait for stop(): it ends within CANCEL_MS of being called, so the wait never cuts a /cancel. */
const STOP_MS = CANCEL_MS + 1_000;

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
    let h;
    try { h = await fsp.open(file, 'wx'); } catch (err) { if (err.code === 'EEXIST') continue; throw err; }
    try { await h.close(); } catch (err) { await fsp.rm(file, { force: true }).catch(() => {}); throw err; }
    return file;
  }
  throw new Error('no free name');
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const gone = () => reject(Object.assign(new Error('sender gone'), { status: 400 }));
    if (req.destroyed) return gone(); // it ended before anyone read it: no 'end' or 'error' comes any more
    const chunks = [];
    let size = 0;
    req.on('close', () => { if (!req.readableEnded) gone(); });
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
// An INTEGER as DER wants it, minimal: a leading zero byte only before a byte with its top bit set (OpenSSL refuses
// any other).
const derInt = (b) => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0 && !(b[i + 1] & 0x80)) i++;
  const v = b.subarray(i);
  return der(0x02, v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
};
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
 *  `timeout` is how long the connection may stay silent (0: no limit); `connect` bounds reaching the device, after which
 *  keepalive watches it; `signal` aborts; `onSent` hears that the whole request went out. Resolves { status, data, proven }. */
function request(dev, method, pathq, { json, stream, length, timeout = 10_000, connect, signal, onSent, tls, expect, onBytes } = {}) {
  return new Promise((resolve, reject) => {
    const lib = dev.protocol === 'https' ? https : http;
    const body = json === undefined ? null : Buffer.from(JSON.stringify(json));
    const headers = body ? { 'Content-Type': 'application/json', 'Content-Length': body.length }
      : stream ? { 'Content-Type': 'application/octet-stream', 'Content-Length': length } : { 'Content-Length': 0 };
    const secure = dev.protocol === 'https' ? { rejectUnauthorized: false, cert: tls?.cert, key: tls?.key, agent: false } : {};
    const req = lib.request({ host: dev.ip, port: dev.port, method, path: pathq, headers, timeout, signal, ...secure }, (res) => {
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
    if (connect) {
      const t = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), connect);
      req.once('close', () => clearTimeout(t));
      req.once('socket', (sock) => {
        const up = () => { clearTimeout(t); sock.setKeepAlive(true, KEEPALIVE_MS); };
        if (dev.protocol === 'https') sock.once('secureConnect', up); else if (sock.connecting) sock.once('connect', up); else up();
      });
    }
    if (onSent) req.once('finish', onSent);
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
 * trusted(ip, local) (default: see below), probePort, lan.
 */
function createPeer(opts) {
  const { dir, statePath, alias, deviceModel = 'Weft', onEvent = () => {}, log = () => {} } = opts;
  const tailnet = opts.tailnet || (async () => ({ self: null, peers: [] }));
  // A device of the tailnet is one tailnet() lists, and what it sends comes in over this machine's Tailscale address
  // (local; undefined when the board itself dialled it): in a local network a device may hold an address of
  // Tailscale's range, and over the Tailscale address only a listed one gets an answer back.
  const trusted = opts.trusted || ((ip, local) => peerIps.has(ip) && (local === undefined || (!!selfIp && local === selfIp)));
  const wantPort = opts.port || PORT;
  const probePort = opts.probePort || PORT;
  const extraHosts = opts.hosts || [];

  let st = { fingerprint: newId(), lan: true, lanChosen: false, devices: {}, items: [] };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }; } catch { /* a first start */ }
  if (!st.lanChosen) st.lan = opts.lan ?? true; // an earlier build saved its default (off), not Karchi's choice
  // An earlier build made about one certificate in 256 that TLS refuses (its serial number badly encoded): such a board
  // never listened, so it gets a new one.
  const usable = (t) => { try { nodeTls.createSecureContext({ cert: t.cert, key: t.key }); return true; } catch { return false; } };
  if (!st.tls?.cert || !st.tls?.key || !usable(st.tls)) { st.tls = makeIdentity(); st.fingerprint = st.tls.fingerprint; }
  for (const it of st.items) { // the app quit midway: the item and every device it had not finished with
    if (!['sending', 'receiving'].includes(it.status)) continue;
    it.status = 'stopped';
    for (const t of it.targets || []) if (['connecting', 'sending', 'waiting'].includes(t.status)) t.status = 'stopped';
  }
  // State of an earlier version may hold one certificate under two spellings: one record (the HTTPS one, which pins
  // the certificate, else the newer), a default only if both were.
  const better = (x, y) => ((x.protocol === 'https') !== (y.protocol === 'https') ? (x.protocol === 'https' ? x : y) : x.seen > y.seen ? x : y);
  st.devices = Object.values(st.devices || {}).reduce((all, d) => {
    const k = fpKey(d.fingerprint);
    const had = all[k];
    all[k] = had ? { ...better(had, d), fingerprint: k, default: had.default && d.default, chosen: had.chosen || d.chosen || had.default !== d.default }
      : { ...d, fingerprint: k };
    return all;
  }, {});
  // A record of an earlier build has no `tailnet`: that build took any address of Tailscale's range for the tailnet, so
  // its defaults wait until a scan shows them on the tailnet again; what Karchi clicked himself stays.
  for (const d of Object.values(st.devices)) if (d.tailnet === undefined) { d.tailnet = false; if (!d.chosen) d.default = false; }

  let selfIp = null;
  let peerIps = new Set(); // the tailnet's devices at the last scan
  let servers = [];
  let listeningOn = [];
  let port = wantPort;
  let listenError = '';
  let sock = null; // multicast, only with st.lan
  let sockReady = false; // its bind is done: it hears and announces
  let joined = new Map(); // interface → the address it hears the group by
  let away = new Map(); // joined interfaces whose address went away: the kernel keeps them in the group
  let outbox = []; // announcements waiting: each goes out on every joined interface before the next
  let scans = 0; // scans started
  let latest = 0; // the newest scan that answered or failed: an older answer is stale
  let applied = 0; // the scan whose answer is in use: it finishes what that answer needs (listen, multicast, probes)
  let session = null; // the one transfer being received
  const jobs = new Map(); // files being received (and their requests), which stop() cuts off and waits for
  const running = new Map(); // item id → AbortController of its send, which Delete and stop() abort
  const sends = new Set(); // sends under way; stop() waits for them to tell a device they were cut off
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
    if (stopped) return; // stop() wrote the last state
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 300);
  };
  const info = () => ({ alias, version: VERSION, deviceModel, deviceType: 'desktop', fingerprint: st.fingerprint, port, protocol: 'https', download: false });
  // A device known by a certificate's fingerprint (64 hex digits, as LocalSend's) must show that certificate again.
  const call = (dev, method, pathq, o = {}) => request(dev, method, pathq, { ...o, tls: st.tls, expect: CERT_FP.test(dev.fingerprint || '') ? dev.fingerprint : null });
  const snapshot = () => ({
    // Listening only where the setting wants it: while it moves (Tailscale only ↔ every interface), not yet.
    me: { alias, port, lan: st.lan, multicast: !!sock && sockReady && joined.size > 0, tailnet: !!selfIp, listening: listeningOn.length > 0 && listeningOn.join() === wanted().join(), error: listenError, dir },
    devices: Object.values(st.devices).map((d) => ({ ...d, online: Date.now() - d.seen < ONLINE_MS })).sort((a, b) => b.seen - a.seen),
    items: st.items,
    ask: asking && { id: asking.id, device: asking.device, count: asking.count, size: asking.size, names: asking.names, text: asking.text },
  });
  // The page hears each state once: a state event that would repeat the last one it heard is not sent.
  let told = '';
  const emit = (type, extra = {}) => {
    if (stopped) return;
    const state = snapshot();
    const now = JSON.stringify(state);
    if (type === 'state' && now === told) return;
    told = now;
    onEvent({ type, state, ...extra });
  };
  // Progress comes in many small pieces: the window hears of it at most four times a second.
  const emitSoon = () => { if (!stateTimer) stateTimer = setTimeout(() => { stateTimer = null; emit('state'); }, 250); };

  /** A device that announced itself, registered or answered a probe; keyed by its fingerprint. Devices of the tailnet
   *  are default targets from the start, ones of the local network only once Karchi says so. `proven` is the hash of
   *  the certificate the claim came with (the client certificate of its request, or the server's of our probe). */
  function remember(body, ip, how, proven = null, local = undefined) {
    if (stopped) return null;
    const fp = fpKey(body?.fingerprint || `${ip}:${body?.port || PORT}`);
    if (fp === st.fingerprint) return null;
    const was = st.devices[fp];
    const port = Number(body?.port) || was?.port || PORT;
    const protocol = body?.protocol === 'https' ? 'https' : body?.protocol === 'http' ? 'http' : was?.protocol || 'https';
    // A device known by its certificate moves (address, port) or drops encryption only on a claim that certificate
    // proves. Anyone can name its fingerprint (LocalSend announces it), so another claim only makes us ask the claimed
    // address over HTTPS, pinned to that certificate, and changes nothing meanwhile.
    const via = how !== 'multicast' && trusted(ip, local) ? 'tailnet' : 'lan'; // multicast never crosses Tailscale
    if (was && CERT_FP.test(fp) && was.protocol === 'https' && !sameFp(proven, fp)) {
      if (was.ip !== ip || was.port !== port || protocol !== 'https') { confirm(fp, ip, port); return null; }
      was.seen = Date.now();
      save();
      return was;
    }
    // One of his devices without a certificate (LocalSend over HTTP) has nothing to prove itself with: only the tailnet
    // moves or renames it; from outside, its name is someone else's claim.
    if (was?.tailnet && via !== 'tailnet' && !sameFp(proven, fp)) return null;
    const dev = {
      fingerprint: fp, alias: String(body?.alias || was?.alias || ip).slice(0, 80), ip, port, protocol,
      deviceType: body?.deviceType || was?.deviceType || null, deviceModel: body?.deviceModel || was?.deviceModel || null,
      via, seen: Date.now(), tailnet: !!was?.tailnet || via === 'tailnet', // once seen on the tailnet, Karchi's own
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
    const local = bare(req.socket.localAddress);
    const proven = provenBy(req.socket);
    const reply = (code, body) => {
      if (res.headersSent) return;
      res.writeHead(code, body ? { 'Content-Type': 'application/json' } : {});
      res.end(body ? JSON.stringify(body) : undefined);
    };
    // Off the local network, what still comes over it (on a connection kept open from before) is refused.
    if (!heard(local)) { res.shouldKeepAlive = false; return reply(403, { message: 'Not listening here' }); }
    try {
      const route = `${req.method} ${url.pathname}`;
      if (route === `GET ${API}/info`) return reply(200, info());
      if (route === `POST ${API}/register`) {
        const data = await readBody(req);
        if (!heard(local)) { res.shouldKeepAlive = false; return reply(403, { message: 'Not listening here' }); } // switched off meanwhile
        const body = JSON.parse(data.toString() || '{}');
        if ((!proven || sameFp(proven, body?.fingerprint)) && remember(body, ip, 'register', proven, local)) emitSoon();
        return reply(200, info());
      }
      if (route === `POST ${API}/prepare-upload`) return await prepare(req, res, ip, reply, proven, local);
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
  /** Whether the board listens where a request came in: off the local network only on its Tailscale address (and hosts);
   *  once stopping, nowhere (a request let in then would outlive stop()). */
  const heard = (local) => !stopped && (st.lan || (!!selfIp && local === selfIp) || extraHosts.includes(local));
  /** A transfer over an address the board stopped listening on cannot go on: its next file would be refused. */
  function dropUnheard() {
    if (session && !heard(session.local) && !session.streams.size) endSession('stopped');
  }

  async function prepare(req, res, ip, reply, proven, local) {
    const data = await readBody(req);
    if (!heard(local)) { res.shouldKeepAlive = false; return reply(403, { message: 'Not listening here' }); } // switched off meanwhile
    const body = JSON.parse(data.toString() || '{}');
    const files = Object.values(body?.files && typeof body.files === 'object' ? body.files : {})
      .filter((f) => f && typeof f.id === 'string' && typeof f.fileName === 'string');
    if (!body?.info || !files.length) return reply(400, { message: 'Invalid body' });
    if (proven && !sameFp(proven, body.info.fingerprint)) return reply(403, { message: 'Fingerprint does not match the client certificate' });
    // His own device may also come over the local network, proving the certificate it showed on the tailnet.
    const own = trusted(ip, local) || (!!proven && !!st.devices[fpKey(proven)]?.tailnet);
    const dev = remember(body.info, ip, 'upload', proven, local) || { fingerprint: '', alias: ip };
    // LocalSend's „Message“: one text file whose text is its preview; nothing is uploaded.
    const text = files.length === 1 && /^text\//.test(files[0].fileType || '') && typeof files[0].preview === 'string' ? files[0].preview.slice(0, 100_000) : null;
    // A question to Karchi holds back only others from outside; his own devices go on.
    if ((asking && !own) || (text == null && sessionLive())) return reply(409, { message: 'Blocked by another session' });
    const size = files.reduce((n, f) => n + (Number(f.size) || 0), 0);
    // Files and text from outside the tailnet wait for Prijať.
    if (!own) {
      const ok = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ASK_MS);
        asking = { id: newId(), device: who(dev), count: files.length, size, overLan: !selfIp || local !== selfIp, names: text == null ? files.slice(0, 5).map((f) => f.fileName) : [],
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
    session = { id, ip, local, item, touched: Date.now(), streams: new Set(),
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
    // One upload of a file at a time (LocalSend sends each once): a second would land beside the first.
    if (f.busy) return reply(409, { message: 'Already receiving this file' });
    const s = session;
    s.touched = Date.now();
    // This session's transfer until it ends here: meanwhile nothing ends the session for it (endSession() still cuts
    // it off) and no other starts. stop() waits for it, so a quit leaves no half file behind.
    s.streams.add(req);
    f.busy = true;
    const job = receive(s, f, req);
    jobs.set(job, req);
    const r = await job.finally(() => { jobs.delete(job); f.busy = false; });
    reply(r.status, r.message && { message: r.message });
  }

  /** Receives one file of session s: written beside its name under one of its own, renamed once whole and closed. */
  async function receive(s, f, req) {
    let target = null, part = null, got = 0;
    const no = (status, message) => Object.assign(new Error(message), { status });
    try {
      target = await claim(dir, safeParts(f.name));
      part = path.join(path.dirname(target), `.${path.basename(target)}.${newId()}.part`);
      // A sender gone while its file got a name sends no 'close' any more.
      if (req.destroyed || session !== s) throw no(500, 'Upload failed');
      const hash = crypto.createHash('sha256');
      const ok = await new Promise((resolve) => {
        const out = fs.createWriteStream(part, { flags: 'wx', mode: 0o644 });
        let settled = false, broke = false;
        // Either way it waits until its file is closed: a failed one still opening is then there to be removed, and a
        // whole one is renamed only once closed (Windows refuses to rename an open file) and only if closing went well.
        const done = (yes) => {
          if (settled) return;
          settled = true;
          if (out.closed) return resolve(yes && !broke);
          out.once('close', () => resolve(yes && !broke));
          if (!yes) out.destroy();
        };
        req.on('data', (c) => { hash.update(c); got += c.length; s.item.got += c.length; s.touched = Date.now(); emitSoon(); });
        req.on('close', () => { if (!req.readableEnded) done(false); }); // gone before all of it was read
        out.on('error', () => { broke = true; done(false); });
        out.on('finish', () => done(req.complete));
        req.pipe(out);
      });
      if (!ok) throw no(500, 'Upload failed');
      if (f.sha256 && hash.digest('hex') !== f.sha256) throw no(422, 'Checksum mismatch');
      await fsp.rename(part, target);
    } catch (err) {
      if (part) await fsp.rm(part, { force: true }).catch(() => {});
      if (target) await fsp.rm(target, { force: true }).catch(() => {});
      s.item.got -= got;
      s.streams.delete(req);
      save();
      dropUnheard(); // its sender may no longer reach the board to cancel
      return { status: err.status || 500, message: err.status ? err.message : 'Upload failed' };
    }
    s.streams.delete(req);
    // It arrived whole, so it stays, also when the session ended meanwhile (cancelled, stopped).
    f.done = true;
    Object.assign(s.item.files[f.index], { path: target, name: path.relative(dir, target), done: true });
    const all = [...s.files.values()].every((x) => x.done);
    const ended = session !== s;
    if (ended) s.item.status = all ? 'done' : 'partial';
    else if (all) { s.item.status = 'done'; session = null; }
    save();
    if (all || ended) arrived(s.item);
    else { emitSoon(); dropUnheard(); }
    return { status: 200 };
  }

  /** The sender cancelled or went quiet: what arrived whole stays, the rest goes. */
  function endSession(status) {
    if (!session) return;
    const s = session;
    session = null;
    for (const r of s.streams) r.destroy();
    s.item.status = s.item.files.some((x) => x.done) ? 'partial' : status;
    save();
    if (s.item.status === 'partial') arrived(s.item);
    else emit('state');
  }
  /** Tells the page what came, for its corner window and notification: of a partial item only the files that did. */
  const arrived = (item) => emit('arrived', { item: { ...item, files: item.files?.filter((x) => x.done) } });

  // ---------------------------------------------------------------- sending

  /** Sends files ({ path, name, size, type }) or a text to one device (its target „connecting“ until then); resolves its
   *  status. `stage` hears „waiting“ once the device has the request (it asks its user, or shows the text) and „sending“ when files flow. */
  async function sendOne(dev, payload, onBytes, { signal, stage = () => {} } = {}) {
    const files = payload.text != null
      ? [{ id: newId(), fileName: `${newId()}.txt`, size: Buffer.byteLength(payload.text), fileType: 'text/plain', sha256: null, preview: payload.text }]
      : payload.files.map((f) => ({ id: newId(), fileName: f.name, size: f.size, fileType: f.type || 'application/octet-stream', sha256: null, preview: null, path: f.path }));
    const meta = Object.fromEntries(files.map(({ path: _p, ...f }) => [f.id, f]));
    let r;
    try {
      r = await call(dev, 'POST', `${API}/prepare-upload`, { json: { info: info(), files: meta }, timeout: 0, connect: CONNECT_MS, signal, onSent: () => stage('waiting') });
    } catch (err) {
      if (signal?.aborted) return { status: 'stopped' };
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
    const cancel = () => call(dev, 'POST', `${API}/cancel?sessionId=${encodeURIComponent(sessionId)}`, { timeout: CANCEL_MS, signal: AbortSignal.timeout(CANCEL_MS) }).catch(() => {});
    stage('sending');
    for (const f of files) {
      const token = tokens[f.id];
      if (!token) continue; // the receiver took only some
      const q = `sessionId=${encodeURIComponent(sessionId)}&fileId=${encodeURIComponent(f.id)}&token=${encodeURIComponent(token)}`;
      const stream = f.path ? fs.createReadStream(f.path) : Readable.from([Buffer.from(payload.text)]);
      let up;
      try {
        up = await call(dev, 'POST', `${API}/upload?${q}`, { stream, length: f.size, timeout: 60_000, signal, onBytes });
      } catch (err) {
        await cancel();
        return signal?.aborted ? { status: 'stopped' } : { status: 'failed', note: err.code || err.message };
      }
      if (up.status !== 200 && up.status !== 204) { await cancel(); return { status: 'failed', note: `HTTP ${up.status}` }; }
    }
    return { status: 'done' };
  }

  const STATUS_ORDER = ['done', 'busy', 'declined', 'pin', 'offline', 'failed'];
  /** One board item to every default device (or `to`, fingerprints); files are { path, name, size, type }. */
  async function send({ files, text, to }) {
    const targets = (to?.length ? to.map((fp) => st.devices[fpKey(fp)]) : Object.values(st.devices).filter((d) => d.default)).filter(Boolean);
    if (!targets.length) return { error: 'no-device' };
    const one = text != null ? null : files.reduce((n, f) => n + f.size, 0);
    const item = addItem({ dir: 'out', device: who(targets[0]), text: text ?? undefined, status: 'sending', got: 0,
      total: (one ?? Buffer.byteLength(text)) * targets.length,
      files: files?.map((f) => ({ name: f.name, size: f.size, type: f.type, path: f.path })),
      targets: targets.map((d) => ({ ...who(d), status: 'connecting' })) });
    emit('state');
    go(item, targets);
    return { id: item.id };
  }
  const go = (item, targets) => {
    const p = run(item, targets).catch((err) => log('board send', err.message)).finally(() => sends.delete(p));
    sends.add(p);
  };

  async function run(item, targets) {
    const payload = item.text != null ? { text: item.text } : { files: item.files };
    const ctl = new AbortController();
    running.set(item.id, ctl);
    await Promise.all(targets.map(async (dev) => {
      // By the device, not the position: a retry sends only to some of the item's targets.
      const target = () => item.targets.find((t) => fpKey(t.fingerprint) === dev.fingerprint) || {};
      const stage = (status) => { if (!ctl.signal.aborted && target().status !== status) { target().status = status; emit('state'); } };
      const res = await sendOne(dev, payload, (n) => { item.got += n; emitSoon(); }, { signal: ctl.signal, stage });
      Object.assign(target(), res);
      if (res.status !== 'offline' && res.status !== 'stopped') { dev.seen = Date.now(); }
      if (!ctl.signal.aborted) emit('state'); // the page hears each device's outcome while others still wait
    }));
    running.delete(item.id);
    if (stopped || !st.items.includes(item)) return; // deleted while it went, or the app quits (it starts „stopped“)
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
    const targets = item.targets.filter((t) => t.status !== 'done').map((t) => st.devices[fpKey(t.fingerprint)]).filter(Boolean);
    if (!targets.length) return false;
    if (item.files?.some((f) => !fs.existsSync(f.path))) return false;
    item.targets = item.targets.filter((t) => t.status === 'done').concat(targets.map((d) => ({ ...who(d), status: 'connecting' })));
    item.status = 'sending';
    item.got = 0;
    item.total = (item.text != null ? Buffer.byteLength(item.text) : item.files.reduce((n, f) => n + f.size, 0)) * targets.length;
    emit('state');
    go(item, targets);
    return true;
  }

  // ---------------------------------------------------------------- finding devices

  /** Asks each online device of the tailnet whether LocalSend runs there (HTTPS first, LocalSend's default). */
  async function probe(ip) {
    for (const protocol of ['https', 'http']) {
      if (stopped || !peerIps.has(ip)) return null; // the address left the tailnet meanwhile
      try {
        const r = await call({ ip, port: probePort, protocol }, 'POST', `${API}/register`, { json: info(), timeout: 2500 });
        if (!peerIps.has(ip)) return null;
        // Over HTTPS the device is who its certificate says, whatever its answer claims.
        if (r.status === 200 && r.data && typeof r.data === 'object') return remember({ ...r.data, fingerprint: r.proven || r.data.fingerprint, port: probePort, protocol }, ip, 'probe', r.proven);
      } catch { /* nothing there, or not this protocol */ }
    }
    return null;
  }

  async function scan() {
    const n = ++scans;
    try {
      // The newest question decides: an older answer that comes after it (or after its failure) is dropped.
      const t = await tailnet().catch((err) => { latest = Math.max(latest, n); throw err; });
      if (stopped) return;
      if (n < latest) return;
      latest = applied = n;
      selfIp = t.self || null;
      // Without Tailscale running (no own address) its peers' addresses lead into the local network, if anywhere.
      const peers = selfIp ? (t.peers || []).filter((p) => p.ip && p.ip !== selfIp) : [];
      peerIps = new Set(peers.map((p) => p.ip));
      await listen();
      if (stopped || n !== applied) return; // a newer answer has its own listen, multicast and probes
      syncMulticast();
      dropUnheard();
      const asked = peers.filter((p) => p.online);
      if (asked.length) emit('state'); // where it listens now, before the probes take their time (it says so again after)
      await Promise.all(asked.map((p) => probe(p.ip)));
    } catch (err) {
      log('board scan', err.message);
    }
    if (sock && !stopped) announce();
    emit('state');
  }

  // ---------------------------------------------------------------- the local network (st.lan)

  /** Announces itself (`announce: false` answers an announcement) on every local network it joined, one interface at a
   *  time: the system's multicast route alone would pick one, maybe Tailscale's. */
  function announce(flag = true) {
    if (!sock || !sockReady) return;
    outbox.push(Buffer.from(JSON.stringify({ ...info(), announce: flag })));
    if (outbox.length === 1) sendOut(sock);
  }
  function sendOut(s) {
    const via = [...joined.values()];
    const next = () => {
      if (sock !== s) return; // closed: its outbox went with it
      if (!via.length) { outbox.shift(); if (outbox.length) sendOut(s); return; }
      try { s.setMulticastInterface(via.shift()); s.send(outbox[0], PORT, GROUP, next); } catch { next(); }
    };
    next();
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
        .catch(() => announce(false));
    }
  }
  /** Multicast while in the local network and listening (an announcement names a port that answers). */
  const syncMulticast = () => multicast(st.lan && listeningOn.includes('0.0.0.0'));
  function multicast(on) {
    if (!on) { try { sock?.close(); } catch { /* closed */ } sock = null; sockReady = false; joined = new Map(); away = new Map(); outbox = []; return; }
    if (sock) { join(); return; } // already on: interfaces and the Tailscale address may have changed since
    if (stopped) return;
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock = s;
    s.on('message', onMulticast);
    s.on('error', (err) => {
      log('board multicast', err.message);
      try { s.close(); } catch { /* closed */ }
      if (sock !== s) return;
      sock = null; sockReady = false; joined = new Map(); away = new Map(); outbox = [];
      emit('state'); // not multicasting (the next scan tries again)
    });
    s.bind(PORT, () => {
      if (sock !== s) return; // turned off meanwhile
      sockReady = true;
      join();
      announce();
      emit('state');
    });
  }
  /** Joins the group on every local network's interface (by its first IPv4 address) and leaves the ones gone. A local
   *  network may hand out addresses of Tailscale's range too: only the interface with Tailscale's own address is left
   *  out. Joining again where the kernel already has the interface (EADDRINUSE) counts as joined. Linux leaves by any
   *  address the interface has now; a leave by an address it no longer has is taken but keeps the interface in the
   *  group for good, so an interface without an address waits in `away` until it has one. */
  function join() {
    if (!sock || !sockReady) return;
    const now = new Map();
    const addrs = new Map(); // interface → its IPv4 addresses now
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      const v4 = (list || []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address);
      if (!v4.length) continue;
      addrs.set(name, v4);
      if (!v4.includes(selfIp)) now.set(name, v4[0]);
    }
    const left = new Map();
    for (const [name, a] of [...away, ...joined]) {
      if (now.has(name)) continue; // joined again below
      const have = addrs.get(name);
      if (!have) { left.set(name, a); continue; }
      for (const x of have) { try { sock.dropMembership(GROUP, x); break; } catch { /* not by this one */ } }
    }
    const kept = new Map();
    for (const [name, a] of now) {
      try { sock.addMembership(GROUP, a); kept.set(name, a); } catch (err) { if (err.code === 'EADDRINUSE') kept.set(name, a); /* else tried again at the next scan */ }
    }
    joined = kept;
    away = left;
  }

  // ---------------------------------------------------------------- listening

  /** Listens where it should now; calls queue, so a quick on/off of „Aj v miestnej sieti“ ends as the last one says. */
  let listening = Promise.resolve();
  const retired = new Set(); // servers that stopped listening and still hold connections
  const conns = new Set(); // every open connection, so stop() ends them all at once
  function listen() {
    listening = listening.then(rebind, rebind);
    return listening;
  }
  /** Where the board listens: in the local network on every interface, else on its Tailscale address (and hosts). */
  function wanted() { return st.lan ? ['0.0.0.0'] : [...new Set([selfIp, ...extraHosts].filter(Boolean))]; }
  async function rebind() {
    if (stopped) return;
    const want = wanted();
    if (want.join() === listeningOn.join() && servers.length) return;
    const had = servers.length > 0;
    // Closing stops listening at once; what is still open on it (a transfer) ends on its own, or at stop().
    for (const s of servers) { retired.add(s); s.close(() => retired.delete(s)); s.closeIdleConnections?.(); }
    servers = [];
    listeningOn = [];
    listenError = want.length ? '' : 'no-tailnet';
    if (had) emit('state'); // not listening until the new bind is done (a retry where nothing listened changes nothing)
    // 53317 is LocalSend's; when the LocalSend app has it, the next free one (the board says which).
    for (const candidate of [wantPort, wantPort + 1, wantPort + 2, wantPort + 3]) {
      const opened = [];
      try {
        for (const host of want) {
          // HTTPS like the LocalSend app; a sender that shows a certificate must claim its fingerprint.
          const s = https.createServer({ cert: st.tls.cert, key: st.tls.key, requestCert: true, rejectUnauthorized: false }, (req, res) => { handle(req, res); });
          s.on('connection', (c) => { conns.add(c); c.once('close', () => conns.delete(c)); }); // also ones still in TLS
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
    st.lanChosen = true;
    save();
    if (!st.lan) {
      multicast(false);
      if (asking?.overLan) asking.resolve(false); // asked over the local network, which it no longer hears
    }
    await listen();
    syncMulticast(); // on: once listening, so its announcement names the port it got
    dropUnheard();
    emit('state');
  }

  function setDefault(fp, on) {
    fp = fpKey(fp);
    if (!st.devices[fp]) return;
    st.devices[fp].default = !!on;
    st.devices[fp].chosen = true;
    save();
    emit('state');
  }

  function forget(fp) {
    delete st.devices[fpKey(fp)];
    save();
    emit('state');
  }

  /** Deletes an item from the board; one still going out (or waiting for the device's answer) is stopped with it. */
  function remove(id) {
    const at = st.items.findIndex((x) => x.id === id);
    if (at < 0 || st.items[at].status === 'receiving') return null;
    running.get(id)?.abort();
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
  }

  async function stop() {
    stopped = true;
    clearTimeout(stateTimer);
    multicast(false);
    if (session) endSession('stopped');
    if (asking) asking.resolve(false);
    for (const c of running.values()) c.abort();
    const leaving = [...sends]; // a device that was taking files hears /cancel, so it is not left „receiving“
    for (const r of jobs.values()) r.destroy();
    await Promise.all([...jobs.keys()]); // cut off, they only clean up or name a file that arrived whole
    clearTimeout(saveTimer);
    await saving; // a write in flight must not land after the last one
    try { fs.writeFileSync(statePath, JSON.stringify(st), { mode: 0o600 }); } catch { /* no disk */ }
    await Promise.all(leaving);
    await listening;
    for (const c of conns) c.destroy();
    await Promise.all([...servers, ...retired].map((s) => new Promise((r) => { s.close(r); s.closeAllConnections?.(); })));
    servers = [];
  }

  return { start, stop, scan, send, retry, setLan, setDefault, forget, remove, respond, fileOf, state: snapshot, info, onMulticast, get port() { return port; } };
}

module.exports = { createPeer, tailnetIp, safeParts, derInt, PORT, STOP_MS };

// The board's LocalSend (desktop/localsend.js) against the official LocalSend CLI, both ways: the board finds the CLI
// and sends it a file and a text; the CLI finds the board by multicast and sends it a file and a text. Run by cli.sh
// inside its own network namespace (dummy interfaces only, nothing reaches a real network): d0 is the local network,
// d1 a local network that hands out addresses of Tailscale's range, d2 stands in for Tailscale itself.
'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPeer } = require('../../desktop/localsend.js');
const D = process.env.D;
const CLI = `${D}/x/localsend-cli`;
let failed = 0;
const check = (n, ok, info = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${info ? ' · ' + info : ''}`); };
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise((r) => setTimeout(r, 100)); } };
const env = (extra) => ({ ...process.env, XDG_CONFIG_HOME: `${D}/cfg`, HOME: `${D}/home`, ...extra });

console.log('runtime', process.versions.electron ? `Electron ${process.versions.electron}` : `Node ${process.version}`);
(async () => {
  for (const d of ['cfg', 'home', 'recv', 'mine', 'src']) fs.mkdirSync(`${D}/${d}`, { recursive: true });
  // 1. The CLI receives on 53317 (in a pty, so its keys work); the board finds it and sends.
  let log = '';
  const rx = spawn('script', ['-qfec', `${CLI} --alias ls-cli --port 53317 --destination ${D}/recv`, '/dev/null'], { env: env({ TERM: 'xterm', COLUMNS: '120', LINES: '40' }), stdio: ['pipe', 'pipe', 'pipe'] });
  let accepted = 0;
  rx.stdout.on('data', (c) => { log += c.toString(); if (/Accept\?/.test(c.toString())) { accepted++; rx.stdin.write('y'); } });
  rx.stderr.on('data', (c) => { log += c.toString(); });
  for (let i = 0; i < 300 && !/Ready to accept/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
  const events = [];
  const peer = createPeer({ dir: `${D}/mine`, statePath: `${D}/board.json`, alias: 'Weft test', port: 53318, hosts: ['10.77.0.1'], trusted: () => true, lan: false,
    tailnet: async () => ({ self: '127.0.0.1', peers: [{ ip: '10.77.0.1', online: true }] }), probePort: 53317, onEvent: (e) => events.push(e), log: (...a) => console.log('  board:', ...a) });
  await peer.start();
  const dev = peer.state().devices.find((d) => d.alias === 'ls-cli');
  check('board finds the LocalSend CLI on 53317', !!dev, JSON.stringify(peer.state().devices));
  if (dev) console.log('  device:', JSON.stringify(dev));
  const bytes = crypto.randomBytes(500_000);
  fs.writeFileSync(`${D}/src/fotka.jpg`, bytes);
  const sent = await peer.send({ files: [{ path: `${D}/src/fotka.jpg`, name: 'fotka.jpg', size: bytes.length, type: 'image/jpeg' }] });
  // The CLI asks; Y accepts.
  const asked = await until(() => accepted > 0, 10000);
  const item = await until(() => { const it = peer.state().items.find((x) => x.id === sent.id); return it && it.status !== 'sending' && it; }, 20000);
  const recvFile = () => { try { return execFileSync('find', [`${D}/recv`, '-type', 'f']).toString().trim().split('\n').filter(Boolean); } catch { return []; } };
  const files = await until(() => recvFile().length && recvFile(), 5000);
  check('the CLI asked and, after Y, has the file whole', asked && item?.status === 'done' && files.length === 1 && fs.readFileSync(files[0]).equals(bytes), `${item?.status} ${JSON.stringify(item?.targets)} ${files}`);
  const text = await peer.send({ text: 'ahoj z nástenky https://example.com' });
  await new Promise((r) => setTimeout(r, 1500));
  const titem = await until(() => { const it = peer.state().items.find((x) => x.id === text.id); return it && it.status !== 'sending' && it; }, 20000);
  check('a text reaches the CLI', titem?.status === 'done' && /ahoj z nástenky/.test(log), `${titem?.status} ${JSON.stringify(titem?.targets)}`);
  await peer.stop();
  rx.kill('SIGINT');
  await new Promise((r) => setTimeout(r, 800));
  try { rx.kill('SIGKILL'); } catch {}
  console.log('--- CLI receiver log (tail) ---\n' + log.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').split('\n').filter((l) => l.trim()).slice(-25).join('\n'));

  // 2. The CLI sends to the board on 53317. A first start is in the local network, so the CLI finds it by multicast.
  const p2events = [];
  const p2 = createPeer({ dir: `${D}/mine2`, statePath: `${D}/board2.json`, alias: 'Weft test', port: 53317, hosts: ['10.77.0.1'], trusted: () => true,
    tailnet: async () => ({ self: '100.101.0.1', peers: [] }), onEvent: (e) => p2events.push(e), log: (...a) => console.log('  board:', ...a) });
  await p2.start();
  check('a first start listens in the local network', p2.state().me.lan === true && p2.state().me.listening, JSON.stringify(p2.state().me));
  // /proc/net/igmp: a line per interface, then its groups; 224.0.0.167 is A70000E0 there.
  const joined = () => { const by = {}; let dev = null; for (const l of fs.readFileSync('/proc/net/igmp', 'utf8').split('\n')) { const m = /^\d+\s+(\S+)\s*:/.exec(l); if (m) { dev = m[1]; by[dev] = []; } else if (dev && l.trim()) by[dev].push(l.trim().split(/\s+/)[0]); } return by; };
  const groups = await until(() => { const g = joined(); return g.d0?.includes('A70000E0') && g; }, 5000);
  check('multicast on every local network, one with addresses of Tailscale\'s range too, but not on Tailscale', !!groups && groups.d1?.includes('A70000E0') && !groups.d2?.includes('A70000E0'), JSON.stringify(groups));
  const b2 = crypto.randomBytes(200_000);
  fs.writeFileSync(`${D}/src/z-cli.bin`, b2);
  const run = (args) => new Promise((resolve) => {
    let out = '';
    const c = spawn('script', ['-qfec', `${CLI} --alias ls-cli --port 53399 send --to 10.77.0.1 ${args}`, '/dev/null'], { env: env({ TERM: 'xterm' }) });
    c.stdout.on('data', (x) => { out += x; });
    const t = setTimeout(() => c.kill('SIGKILL'), 30000);
    c.on('exit', (code) => { clearTimeout(t); resolve({ code, out: out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') }); });
  });
  const r1 = await run(`${D}/src/z-cli.bin`);
  const got = path.join(D, 'mine2', 'z-cli.bin');
  check('the CLI sends a file to the board, it lands whole', fs.existsSync(got) && fs.readFileSync(got).equals(b2) && p2events.some((e) => e.type === 'arrived'), `exit ${r1.code} ${r1.out.split('\n').slice(-6).join(' | ')}`);
  const r2 = await run(`--text 'správa z CLI'`);
  const tin = p2.state().items.find((x) => x.text != null);
  check('the CLI sends a text, the board has it', tin?.text === 'správa z CLI', `exit ${r2.code} ${r2.out.split('\n').slice(-6).join(' | ')}`);
  check('the board learnt the CLI as a device', p2.state().devices.some((d) => d.alias === 'ls-cli'), JSON.stringify(p2.state().devices.map((d) => [d.alias, d.port, d.protocol])));

  // 3. „Aj v miestnej sieti“ off, on and off again at once ends off: only its own address (here 10.77.0.1) answers.
  const knock = (host) => new Promise((resolve) => {
    const s = require('node:net').connect(53317, host);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
  const everywhere = await knock('127.0.0.1');
  // A transfer halfway through (over the local network) does not hold the switch back, and still lands whole.
  const https = require('node:https');
  const ask = (p, headers, cb) => https.request({ host: '127.0.0.1', port: 53317, method: 'POST', path: `/api/localsend/v2/${p}`, rejectUnauthorized: false, agent: false, headers }, cb);
  const json = (p, o) => new Promise((resolve, reject) => { const b = Buffer.from(JSON.stringify(o));
    const r = ask(p, { 'Content-Length': b.length }, (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve(JSON.parse(Buffer.concat(c)))); });
    r.on('error', reject); r.end(b); });
  const big = crypto.randomBytes(2000);
  const prep = await json('prepare-upload', { info: { alias: 'mobil', fingerprint: 'fp-up' }, files: { f: { id: 'f', fileName: 'napoly.bin', size: big.length, fileType: 'application/octet-stream' } } });
  let upStatus = null;
  let up = null;
  const done = new Promise((resolve) => { up = ask(`upload?sessionId=${prep.sessionId}&fileId=f&token=${prep.files.f}`, { 'Content-Length': big.length },
    (res) => { upStatus = res.statusCode; res.resume(); res.on('end', resolve); }); up.on('error', resolve); up.write(big.subarray(0, 1000)); });
  const half = await until(() => p2.state().items.find((x) => x.files?.[0]?.name === 'napoly.bin' && x.got >= 1000), 5000);
  await Promise.all([p2.setLan(false), p2.setLan(true), p2.setLan(false)]);
  const after = [await knock('127.0.0.1'), await knock('10.77.0.1'), await knock('100.101.0.1'), p2.state().me.lan];
  check('a quick off/on/off of the local network ends listening only on its own addresses, with a transfer halfway', everywhere && !!half && after.join() === 'false,true,true,false', JSON.stringify({ everywhere, half: !!half, after }));
  up.end(big.subarray(1000));
  await done;
  const landed = path.join(D, 'mine2', 'napoly.bin');
  check('the transfer halfway then still lands whole', upStatus === 200 && fs.existsSync(landed) && fs.readFileSync(landed).equals(big), String(upStatus));

  // Off, and on again while off still binds its Tailscale address: until every interface listens, no state says it
  // listens in the local network or multicasts (an announcement would name a port that refuses), then both do.
  await p2.setLan(true);
  const netm = require('node:net');
  const listenOrig = netm.Server.prototype.listen;
  let entered = false;
  let open;
  const held = new Promise((r) => { open = r; });
  netm.Server.prototype.listen = function (...a) {
    if (a[1] === '0.0.0.0' && typeof a[2] === 'function') { const cb = a[2]; a[2] = (...x) => { p2events.push({ type: 'bound-everywhere' }); cb(...x); }; }
    if (a[1] === '100.101.0.1') { entered = true; held.then(() => listenOrig.apply(this, a)); return this; }
    return listenOrig.apply(this, a);
  };
  const from = p2events.length;
  const toggled = p2.setLan(false);
  await until(() => entered, 5000);
  const back = p2.setLan(true);
  open();
  await Promise.all([toggled, back]);
  netm.Server.prototype.listen = listenOrig;
  const seen = p2events.slice(from);
  const bound = seen.findIndex((e) => e.type === 'bound-everywhere');
  const early = seen.slice(0, bound < 0 ? seen.length : bound).filter((e) => e.state?.me.lan && (e.state.me.multicast || e.state.me.listening)).map((e) => e.state.me);
  const end = p2.state().me;
  check('off and at once on again: nothing says local network or multicasts before every interface listens, then both', entered && bound >= 0 && !early.length && end.lan && end.listening && end.multicast && await knock('127.0.0.1'),
    JSON.stringify({ entered, bound, early, end: { lan: end.lan, listening: end.listening, multicast: end.multicast } }));
  await p2.stop();

  // 4. Turned on where its port is taken on the local network, it announces the port it got instead.
  const dgram = require('node:dgram');
  const heard = [];
  const cap = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  cap.on('message', (b) => { try { heard.push(JSON.parse(b)); } catch { /* not LocalSend */ } });
  await new Promise((r) => cap.bind(53317, r));
  cap.addMembership('224.0.0.167', '10.77.0.1');
  const blocker = require('node:net').createServer().listen(53500, '10.77.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const p3 = createPeer({ dir: `${D}/mine3`, statePath: `${D}/board3.json`, alias: 'Weft p3', port: 53500, lan: false, trusted: () => true,
    tailnet: async () => ({ self: '100.101.0.1', peers: [] }), log: () => {} });
  await p3.start();
  const before = p3.port;
  await p3.setLan(true);
  const said = await until(() => heard.find((m) => m.alias === 'Weft p3'), 5000);
  check('turned on where its port is taken, it announces the port it got', before === 53500 && p3.port === 53501 && said?.port === 53501, JSON.stringify({ before, now: p3.port, said: said?.port }));
  await p3.stop();
  blocker.close();
  cap.close();

  // 5. Turned on where every port it tries is taken on the local network, it announces nothing: no port answers.
  const blockers = await Promise.all([53520, 53521, 53522, 53523].map((port) => new Promise((r) => { const b = require('node:net').createServer().listen(port, '10.77.0.1', () => r(b)); })));
  const p5events = [];
  const p5 = createPeer({ dir: `${D}/mine5`, statePath: `${D}/board5.json`, alias: 'Weft p5', port: 53520, lan: false, trusted: () => true,
    tailnet: async () => ({ self: '100.101.0.1', peers: [] }), onEvent: (e) => p5events.push(e), log: () => {} });
  await p5.start();
  await p5.setLan(true);
  check('turned on where every port is taken, it announces nothing', p5.state().me.listening === false && p5.state().me.multicast === false, JSON.stringify(p5.state().me));
  // Its next scans try the ports again; the page keeps hearing „ports taken“, never „starting“ in between.
  const p5from = p5events.length;
  await p5.scan();
  await p5.scan();
  const p5said = p5events.slice(p5from).map((e) => e.state.me.error);
  check('while every port stays taken, a scan never says it is starting', p5said.length > 0 && p5said.every((x) => x === 'port'), JSON.stringify(p5said));
  await p5.stop();
  for (const b of blockers) b.close();

  // 6. Stopped while it starts (the app quit at once), it opens no multicast afterwards.
  let release;
  const gate = new Promise((r) => { release = r; });
  const p4 = createPeer({ dir: `${D}/mine4`, statePath: `${D}/board4.json`, alias: 'Weft p4', port: 53510, trusted: () => true,
    tailnet: async () => { await gate; return { self: '100.101.0.1', peers: [] }; }, log: () => {} });
  const starting = p4.start();
  await p4.stop();
  release();
  await starting;
  check('stopped while it starts, it opens no multicast afterwards', p4.state().me.multicast === false && p4.state().me.lan === true, JSON.stringify(p4.state().me));
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

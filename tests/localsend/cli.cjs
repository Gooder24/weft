// The board's LocalSend (desktop/localsend.js) against the official LocalSend CLI, both ways: the board finds the CLI
// and sends it a file and a text; the CLI finds the board by multicast and sends it a file and a text. Run by cli.sh
// inside its own network namespace (one dummy interface, nothing reaches a real network).
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
  const peer = createPeer({ dir: `${D}/mine`, statePath: `${D}/board.json`, alias: 'Weft test', port: 53318, hosts: ['10.77.0.1'], trusted: () => true,
    tailnet: async () => ({ self: null, peers: [{ ip: '10.77.0.1', online: true }] }), probePort: 53317, onEvent: (e) => events.push(e), log: (...a) => console.log('  board:', ...a) });
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

  // 2. The CLI sends to the board on 53317.
  const p2events = [];
  const p2 = createPeer({ dir: `${D}/mine2`, statePath: `${D}/board2.json`, alias: 'Weft test', port: 53317, hosts: ['10.77.0.1'], trusted: () => true,
    tailnet: async () => ({ self: null, peers: [] }), onEvent: (e) => p2events.push(e), log: (...a) => console.log('  board:', ...a) });
  await p2.start();
  await p2.setLan(true); // the CLI finds devices by multicast
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
  await p2.stop();
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

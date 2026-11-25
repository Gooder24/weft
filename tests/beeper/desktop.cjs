// „Prejsť z Beeperu“ in the desktop app (desktop/main.js beeper-*) on this computer's own system, with a fake electron
// and a made-up Beeper folder where Beeper Desktop keeps it here: Linux ~/.config/BeeperTexts, macOS
// ~/Library/Application Support/BeeperTexts, Windows %APPDATA%\BeeperTexts. It checks that a running Beeper is seen
// (Linux and macOS: its SingletonLock link to a live process; Windows: the lockfile it holds open), that a closed one
// is copied, that only the media files asked for are read from its cache, and that Beeper's folder stays as it was.
// Run: node tests/beeper/desktop.cjs (CI: .github/workflows/beeper-desktop.yml on Windows, macOS and Linux)
const Module = require('module');
const fs = require('fs'), os = require('os'), path = require('path'), { spawn, execFileSync } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-home-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-tmp-'));
process.env.HOME = home; process.env.USERPROFILE = home; process.env.TMPDIR = tmp; process.env.TEMP = tmp; process.env.TMP = tmp;
process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
process.env.SPRAVY_URL = 'https://weft.example:8443/';
os.homedir = () => home; os.tmpdir = () => tmp;
const dir = process.platform === 'win32' ? path.join(process.env.APPDATA, 'BeeperTexts')
  : path.join(home, process.platform === 'darwin' ? 'Library/Application Support/BeeperTexts' : '.config/BeeperTexts');

const leftover = path.join(tmp, 'weft-beeper-old'); fs.mkdirSync(leftover); fs.writeFileSync(path.join(leftover, 'index.db'), 'old');
const handlers = {}, ready = [];
const fake = new Proxy({}, { get: () => fakeFn });
function fakeFn() { return fake; }
const app = { on: () => {}, whenReady: () => ({ then: (f) => ready.push(f) }), requestSingleInstanceLock: () => true, commandLine: { appendSwitch() {} },
  getPath: () => home, setName() {}, quit() {}, setAppUserModelId() {} };
const electron = { app: new Proxy(app, { get: (t, k) => (k in t ? t[k] : () => fake) }), ipcMain: { handle: (n, f) => { handlers[n] = f; }, on: () => {} },
  BrowserWindow: function () { return fake; }, dialog: fake, session: fake, shell: fake };
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? electron : load.call(this, req, ...rest); };

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && extra ? ` · ${extra}` : ''}`); };
// Beeper's files, without its lock (the test swaps that one).
const tree = (d) => fs.readdirSync(d, { recursive: true }).filter((n) => !['SingletonLock', 'lockfile'].includes(n)).sort().map((n) => {
  const st = fs.lstatSync(path.join(d, n));
  return `${n}:${st.isFile() ? st.size : st.isSymbolicLink() ? 'link' : 'dir'}`;
}).join('|');

(async () => {
  try { require('../../desktop/main.js'); } catch (e) { console.log('load:', e.message); }
  for (const f of ready) { try { await f(); } catch {} }
  check('a copy left by an earlier run is swept at start', !fs.existsSync(leftover));
  let refused = false;
  try { await handlers['beeper-find']({ sender: null, senderFrame: { parent: null, origin: 'x' } }); } catch { refused = true; }
  check('another page is refused', refused);

  // As the app window (main.js's window is the fake, so its webContents is fakeFn).
  const ev = { sender: fakeFn, senderFrame: { parent: null, origin: 'https://weft.example:8443' } };
  check('no Beeper on this computer: said so', (await handlers['beeper-find'](ev)).found === false);
  const cache = path.join(dir, 'media', 'local.beeper.com');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.db'), 'SQLite format 3\0' + 'x'.repeat(100));
  fs.writeFileSync(path.join(dir, 'index.db-wal'), Buffer.from([0x37, 0x7f, 0x06, 0x82, 0x77, 0x61, 0x6c]));
  fs.writeFileSync(path.join(cache, 'u_photo1'), 'photo-bytes-0123456789');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'not for the app');
  let linked = true;
  try { fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(cache, 'u_link')); } catch { linked = false; } // Windows without the right

  // Beeper running: its lock, as Beeper (Chromium) keeps it on this system.
  let holder = null;
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'lockfile'), '');
    // Beeper holds its lockfile open without sharing; PowerShell does the same until it is killed.
    holder = spawn('powershell', ['-NoProfile', '-Command',
      `$f = [System.IO.File]::Open('${path.join(dir, 'lockfile')}', 'Open', 'ReadWrite', 'None'); Write-Output held; Start-Sleep 120`]);
    await new Promise((r) => holder.stdout.once('data', r));
  } else {
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(dir, 'SingletonLock'));
  }
  const before = tree(dir);
  const running = await handlers['beeper-find'](ev);
  check('a running Beeper is seen and nothing is copied', running.found && running.running
    && !fs.readdirSync(tmp).some((n) => n.startsWith('weft-beeper-')), JSON.stringify(running));
  if (holder) { holder.kill(); await new Promise((r) => holder.once('exit', r)); }
  else {
    fs.unlinkSync(path.join(dir, 'SingletonLock'));
    // A lock left by a Beeper that crashed: a process that no longer runs.
    const dead = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)']).toString());
    fs.symlinkSync(`${os.hostname()}-${dead}`, path.join(dir, 'SingletonLock'));
  }

  const got = await handlers['beeper-find'](ev);
  check('a closed Beeper is copied, index.db and its -wal', got.found && !got.running && got.files['index.db'] === 116 && got.files['index.db-wal'] === 7,
    JSON.stringify(got));
  const media = await handlers['beeper-media'](ev, ['u_photo1', 'u_missing', '../secret.txt', '..\\secret.txt', 'u_link', '.hidden', 5]);
  check('only cached files by their plain id are found, no link', JSON.stringify(media) === JSON.stringify({ u_photo1: 22 }), JSON.stringify(media));
  const head = Buffer.from(await handlers['beeper-piece'](ev, 'index.db', 0, 15)).toString();
  check('index.db is read from the copy', head === 'SQLite format 3');
  await handlers['beeper-done'](ev);
  const piece = Buffer.from(await handlers['beeper-piece'](ev, 'media/u_photo1', 6, 5)).toString();
  check('a media file is read in place after the copy is gone', piece === 'bytes');
  let bad = 0;
  const names = ['media/../secret.txt', 'media/..\\secret.txt', 'media/u_missing', 'media/u_link', 'index.db', '../index.db', 'media/__proto__'];
  for (const name of names) { try { await handlers['beeper-piece'](ev, name, 0, 10); } catch { bad++; } }
  check('nothing else is read', bad === names.length);
  check('the copy is deleted', !fs.readdirSync(tmp).some((n) => n.startsWith('weft-beeper-')));
  check('Beeper\'s folder is as it was', tree(dir) === before, `${tree(dir)} vs ${before}`);
  await handlers['beeper-find'](ev);
  let reset = false; try { await handlers['beeper-piece'](ev, 'media/u_photo1', 0, 5); } catch { reset = true; }
  check('a new find forgets the files listed before', reset);
  console.log(`${process.platform}${linked ? '' : ' (no symlink right: the link check ran without a link)'}: ${fails ? `${fails} failed` : 'all good'}`);
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})();

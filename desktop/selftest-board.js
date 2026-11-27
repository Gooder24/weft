// Self-test of the board in the shell (main.js, preload.js, localsend.js) without a real device: SPRAVY_SELFTEST=board.
// A local page stands in for Weft, a local server for a phone with the LocalSend app; files go through a real file
// input (its path, as a drop would give it) and a pasted picture (its bytes). Nothing leaves 127.0.0.1, and Downloads is
// a temporary folder. Prints PASS/FAIL lines, exits 1 on any FAIL. Run under Xvfb with a throwaway profile:
//   XDG_CONFIG_HOME=/tmp/x SPRAVY_URL=http://127.0.0.1:18433/ SPRAVY_SELFTEST=board xvfb-run -a electron --no-sandbox desktop
const { app } = require('electron');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const API = '/api/localsend/v2';

module.exports = async function selftestBoard(t) {
  let fails = 0;
  const check = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
  const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise((r) => setTimeout(r, 50)); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weft-board-selftest-'));
  app.setPath('downloads', path.join(tmp, 'Downloads'));
  const servers = [];
  const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); servers.push(s); s.listen(0, '127.0.0.1', () => resolve(s.address().port)); });
  const body = (req) => new Promise((resolve) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => resolve(Buffer.concat(c))); });

  // The page of Weft: a file input and the board bridge, nothing else.
  const page = `<!doctype html><meta charset="utf-8"><title>board</title><input type="file" id="f" multiple>
    <script>window.events = []; window.desktop?.board?.on((ev) => window.events.push({ type: ev.type, item: ev.item }));</script>`;
  const appPort = Number(new URL(t.APP_URL).port);
  const appServer = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(page); });
  servers.push(appServer);
  await new Promise((r) => appServer.listen(appPort, '127.0.0.1', r));

  // The phone: LocalSend over HTTP, as with its encryption off (HTTPS is tests/localsend/); it takes everything.
  const got = { files: {}, texts: [], registered: 0 };
  let prepared = null;
  const phonePort = await listen(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const data = await body(req);
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === `${API}/register`) { got.registered++; return json(200, { alias: 'Telefón', version: '2.1', deviceModel: 'Test', deviceType: 'mobile', fingerprint: 'phone-fp', port: phonePort, protocol: 'http', download: false }); }
    if (u.pathname === `${API}/prepare-upload`) {
      prepared = JSON.parse(data);
      const files = Object.values(prepared.files);
      if (files.length === 1 && files[0].fileType === 'text/plain' && files[0].preview != null) { got.texts.push(files[0].preview); res.writeHead(204); return res.end(); }
      return json(200, { sessionId: 'S1', files: Object.fromEntries(files.map((f) => [f.id, `tok-${f.id}`])) });
    }
    if (u.pathname === `${API}/upload`) {
      const f = prepared?.files[u.searchParams.get('fileId')];
      if (!f || u.searchParams.get('token') !== `tok-${f.id}`) { res.writeHead(403); return res.end(); }
      got.files[f.fileName] = data;
      res.writeHead(200); return res.end();
    }
    res.writeHead(404); res.end();
  });

  let main = null;
  try {
    const boardPort = await listen(() => {}).then((p) => { servers.pop().close(); return p; }); // a free port for the board
    t.startBoard({ tailnet: async () => ({ self: null, peers: [{ ip: '127.0.0.1', online: true }] }), hosts: ['127.0.0.1'], port: boardPort, probePort: phonePort, trusted: () => true, lan: false,
      statePath: path.join(tmp, 'board.json') }); // its own state: a profile's saved „Aj v miestnej sieti“ must not count
    t.openMain();
    main = t.getMain();
    await new Promise((r) => main.webContents.once('did-finish-load', r));
    const run = (js) => main.webContents.executeJavaScript(js);
    check('okno má nástenku (preload)', await run(`typeof window.desktop?.board?.send === 'function' && typeof window.desktop.board.call === 'function'`));
    const st = await until(async () => { const s = await run(`window.desktop.board.call('scan')`); return s.devices.find((d) => d.alias === 'Telefón') && s; });
    const phone = st?.devices.find((d) => d.alias === 'Telefón');
    check('nájde LocalSend na zariadení v tailnete a je predvolené', !!phone && phone.default && phone.online && got.registered > 0, JSON.stringify(phone));
    check('stav hovorí, kde prijíma a kam ukladá', st?.me.listening && st.me.port === boardPort && st.me.dir === path.join(tmp, 'Downloads', 'Weft'), JSON.stringify(st?.me));

    // A file picked in the input: its path goes, the shell reads it from the disk.
    const photo = path.join(tmp, 'foto z výletu.jpg');
    const bytes = crypto.randomBytes(300_000);
    fs.writeFileSync(photo, bytes);
    const dbg = main.webContents.debugger;
    dbg.attach('1.3');
    const { result } = await dbg.sendCommand('Runtime.evaluate', { expression: 'document.getElementById("f")' });
    await dbg.sendCommand('DOM.setFileInputFiles', { files: [photo], objectId: result.objectId });
    dbg.detach();
    const sent = await run(`window.desktop.board.send({ files: [...document.getElementById('f').files] })`);
    await until(() => got.files['foto z výletu.jpg']);
    check('súbor z výberu (cesta) príde do mobilu celý', !!sent?.id && got.files['foto z výletu.jpg']?.equals(bytes), JSON.stringify(sent));
    const done = await until(async () => (await run(`window.desktop.board.call('state')`)).items.find((x) => x.id === sent.id && x.status === 'done'));
    check('položka je „doručené“ a okno to počulo', !!done && await run(`window.events.some((e) => e.type === 'sent' && e.item.id === ${JSON.stringify(sent.id)})`));

    // A pasted picture has no path: its bytes go, kept in userData/board-out until the item is deleted.
    const pasted = await run(`window.desktop.board.send({ files: [new File([new Uint8Array([1, 2, 3, 4])], 'obrazok.png', { type: 'image/png' })] })`);
    await until(() => got.files['obrazok.png']);
    check('vložený obrázok (bajty) príde', got.files['obrazok.png']?.equals(Buffer.from([1, 2, 3, 4])));
    const out = path.join(app.getPath('userData'), 'board-out');
    const copies = () => (fs.existsSync(out) ? fs.readdirSync(out) : []);
    check('jeho kópia čaká v board-out', copies().length === 1);
    await until(async () => (await run(`window.desktop.board.call('state')`)).items.find((x) => x.id === pasted.id && x.status === 'done'));
    check('Zmazať ho dá preč z nástenky aj s kópiou', (await run(`window.desktop.board.call('remove', ${JSON.stringify(pasted.id)})`)) === true && copies().length === 0);

    const text = await run(`window.desktop.board.send({ text: 'kód 4821 https://example.com' })`);
    await until(() => got.texts.length);
    check('text ide ako správa LocalSendu', !!text?.id && got.texts[0] === 'kód 4821 https://example.com');

    // The page names no path of its own: not through call, not through send.
    const forged = await run(`Promise.allSettled([
      window.desktop.board.call('send', { files: [{ path: '/etc/hostname' }] }),
      window.desktop.board.send({ files: [{ path: '/etc/hostname' }] }),
    ]).then((r) => r.map((x) => x.status))`);
    await new Promise((r) => setTimeout(r, 500));
    check('stránka nepošle cestu, ktorú si sama vymyslí', forged.every((s) => s === 'rejected') && !got.files.hostname, JSON.stringify(forged));
    check('a nemá ipcRenderer', await run(`typeof window.ipcRenderer === 'undefined' && typeof window.require === 'undefined'`));

    // The phone sends a file: it lands in Downloads/Weft and the window hears of it.
    const meta = { info: { alias: 'Telefón', fingerprint: 'phone-fp', port: phonePort, protocol: 'http' }, files: { a: { id: 'a', fileName: 'z mobilu.txt', size: 5, fileType: 'text/plain' } } };
    const post = (p, data) => new Promise((resolve, reject) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
      const req = https.request({ host: '127.0.0.1', port: boardPort, method: 'POST', path: p, rejectUnauthorized: false, agent: false, headers: { 'Content-Length': buf.length } }, (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, data: c.length ? JSON.parse(Buffer.concat(c)) : null })); });
      req.on('error', reject); req.end(buf);
    });
    const prep = await post(`${API}/prepare-upload`, meta);
    const up = await post(`${API}/upload?sessionId=${prep.data.sessionId}&fileId=a&token=${prep.data.files.a}`, Buffer.from('ahoj!'));
    const landed = path.join(tmp, 'Downloads', 'Weft', 'z mobilu.txt');
    check('súbor z mobilu je v Stiahnutých/Weft', up.status === 200 && fs.existsSync(landed) && fs.readFileSync(landed, 'utf8') === 'ahoj!');
    check('okno počulo, že prišiel', await until(() => run(`window.events.some((e) => e.type === 'arrived' && e.item.files?.[0]?.name === 'z mobilu.txt')`)));
  } catch (err) {
    check('beh testu', false, err.stack);
  } finally {
    for (const s of servers) s.close();
    // Quitting right after a change keeps it: will-quit waits for the board's last write (main.js).
    const statePath = path.join(tmp, 'board.json');
    let last = null;
    try { last = (await main?.webContents.executeJavaScript(`window.desktop.board.send({ text: 'posledné pred zatvorením' })`))?.id; } catch { /* checked below */ }
    process.on('exit', () => {
      let kept = false;
      try { kept = !!last && JSON.parse(fs.readFileSync(statePath, 'utf8')).items.some((x) => x.id === last); } catch { /* not written */ }
      check('zatvorenie hneď po zmene ju uloží', kept);
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log(fails ? `FAILED ${fails}` : 'ALL PASS');
      process.exitCode = fails ? 1 : 0;
    });
    app.quit();
  }
};

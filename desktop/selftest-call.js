// Self-test of the call windows (main.js) without a call or a login: SPRAVY_SELFTEST=call|call-again|call-notunnel|call-discord.
// A local page stands in for Messenger; the camera is Chromium's fake device. Prints PASS/FAIL lines, exits 1 on any FAIL.
// Run under Xvfb with a throwaway profile, e.g. (overenie/hovory/selftest.sh does all three):
//   XDG_CONFIG_HOME=/tmp/x SPRAVY_URL=http://127.0.0.1:18431/ SPRAVY_SELFTEST=call xvfb-run -a electron --no-sandbox desktop
const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const path = require('node:path');

module.exports = async function selftestCall(t) {
  const mode = process.env.SPRAVY_SELFTEST;
  let fails = 0;
  const check = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const port = Number(new URL(t.APP_URL).port);
  const origin = `http://127.0.0.1:${port}`;
  const other = `http://localhost:${port}`;

  // The real rules first: which Messenger pages a call window may show and open.
  const real = t.CALL_NETS.messenger;
  const allows = (url) => real.chatId(new URL(url)) === '123' || real.allows(new URL(url));
  check('Messenger: chat, šifrovaný chat a hovor áno', ['https://www.messenger.com/t/123', 'https://www.messenger.com/t/123/', 'https://www.messenger.com/e2ee/t/123', 'https://www.messenger.com/groupcall/ROOM:1/?x=1', 'https://www.messenger.com/login/', 'https://www.facebook.com/checkpoint/1', 'https://www.facebook.com/login.php'].every(allows));
  const no = ['https://www.messenger.com/t/124', 'https://www.messenger.com/t/1234', 'https://www.messenger.com/e2ee/t/9', 'https://www.messenger.com/marketplace', 'https://www.messenger.com.evil.net/t/123', 'http://www.messenger.com/t/123', 'https://messenger.com/t/123', 'https://www.facebook.com/', 'https://www.facebook.com/messages/t/123', 'https://www.instagram.com/'];
  check('Messenger: iný chat, iný web, http a podobné meno nie', no.every((u) => !allows(u)), no.filter(allows).join(' '));
  check('Messenger: zoznam chatov (/) len cestou, nie na zostanie', real.passes(new URL('https://www.messenger.com/')) && !allows('https://www.messenger.com/') && !real.passes(new URL('https://www.messenger.com/marketplace')));
  check('Messenger: popup len hovor', real.popup(new URL('https://www.messenger.com/groupcall/ROOM:1/')) && real.popup(new URL('https://www.messenger.com/groupcall?x=1')) && !real.popup(new URL('https://www.messenger.com/t/124')) && !real.popup(new URL('https://evil.example/groupcall/')));
  // Instagram: the same lock, its own addresses.
  const ig = t.CALL_NETS.instagram;
  const igOk = (u) => ig.chatId(new URL(u)) === '123' || ig.allows(new URL(u));
  const igYes = ['https://www.instagram.com/direct/t/123/', 'https://www.instagram.com/direct/t/123', 'https://www.instagram.com/accounts/login/', 'https://www.instagram.com/challenge/x/', 'https://www.facebook.com/login.php', 'https://www.instagram.com/call/?thread=123', 'https://www.instagram.com/call/x/y'];
  const igNo = ['https://www.instagram.com/direct/t/124/', 'https://www.instagram.com/direct/t/1234/', 'https://www.instagram.com/', 'https://www.instagram.com/direct/inbox/', 'https://www.instagram.com/reels/', 'https://www.instagram.com/explore/', 'https://www.instagram.com/someone/', 'https://www.instagram.com.evil.net/direct/t/123/', 'http://www.instagram.com/direct/t/123/', 'https://instagram.com/direct/t/123/', 'https://www.facebook.com/'];
  check('Instagram: chat, prihlásenie a hovor áno', igYes.every(igOk), igYes.filter((u) => !igOk(u)).join(' '));
  check('Instagram: iný chat, feed, Reels, iný web, http a podobné meno nie', igNo.every((u) => !igOk(u)), igNo.filter(igOk).join(' '));
  check('Instagram: feed a zoznam chatov len cestou', ['https://www.instagram.com/', 'https://www.instagram.com/direct/inbox/'].every((u) => ig.passes(new URL(u))) && !ig.passes(new URL('https://www.instagram.com/reels/')));
  check('Instagram: popup len hovor', ['https://www.instagram.com/call/?x=1', 'https://www.instagram.com/call?thread=1'].every((u) => ig.popup(new URL(u))) && !ig.popup(new URL('https://www.instagram.com/direct/t/124/')) && !ig.popup(new URL('https://www.instagram.com/caller/')));
  // Discord (beta): only a DM or group DM, its message links, and the login page.
  const dc = t.CALL_NETS.discord;
  const dcOk = (u) => dc.chatId(new URL(u)) === '123' || dc.allows(new URL(u));
  const dcYes = ['https://discord.com/channels/@me/123', 'https://discord.com/channels/@me/123/', 'https://discord.com/channels/@me/123/456', 'https://discord.com/login'];
  const dcNo = ['https://discord.com/channels/@me/124', 'https://discord.com/channels/@me/1234', 'https://discord.com/channels/111/123', 'https://discord.com/channels/@me', 'https://discord.com/app', 'https://discord.com/', 'https://discord.com/store', 'https://discord.com/channels/@me/123/456/7', 'https://discord.com.evil.net/channels/@me/123', 'http://discord.com/channels/@me/123', 'https://www.discord.com/channels/@me/123'];
  check('Discord: DM, odkaz na jeho správu a prihlásenie áno', dcYes.every(dcOk), dcYes.filter((u) => !dcOk(u)).join(' '));
  check('Discord: iný DM, server, zoznam, obchod, iný web a http nie', dcNo.every((u) => !dcOk(u)), dcNo.filter(dcOk).join(' '));
  check('Discord: zoznam DM a /app len cestou, popup žiadny, kamera len discord.com', ['https://discord.com/channels/@me', 'https://discord.com/app', 'https://discord.com/'].every((u) => dc.passes(new URL(u))) && !dc.passes(new URL('https://discord.com/store'))
    && !dc.popup(new URL('https://discord.com/channels/@me/123')) && dc.popups === false && dc.aliases === false && JSON.stringify(dc.media) === '["https://discord.com"]');
  const fakeMain = { webContents: {} };
  t.setMain(fakeMain);
  const ev = (frame, sender = fakeMain.webContents) => ({ sender, senderFrame: frame });
  check('IPC: len hlavný rámec appky', t.fromApp(ev({ parent: null, origin: t.APP_ORIGIN })) && !t.fromApp(ev({ parent: {}, origin: t.APP_ORIGIN }))
    && !t.fromApp(ev({ parent: null, origin: other })) && !t.fromApp(ev({ parent: null, origin: t.APP_ORIGIN }, {})));
  t.setMain(null);

  // A stand-in for Messenger on this machine: the chat, its call, a login that redirects away, and a frame of another origin.
  const page = (body) => `<!doctype html><meta charset="utf-8"><title>test</title><body>${body}<script>
    window.probe = () => navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then((s) => { s.getTracks().forEach((x) => x.stop()); return 'ok'; }, (e) => e.name);
  </script></body>`;
  const hits = {};
  const rang = []; // presses of a stand-in Discord call button: { id, trusted, moves }
  const server = http.createServer((q, r) => {
    const u = new URL(q.url, origin);
    hits[u.pathname] = (hits[u.pathname] || 0) + 1;
    if (u.pathname === '/login/away') { r.writeHead(302, { location: '/marketplace' }); return r.end(); }
    if (u.pathname === '/login/done') { r.writeHead(302, { location: '/' }); return r.end(); }
    if (u.pathname === '/t/555') { r.writeHead(302, { location: '/e2ee/t/556' }); return r.end(); }
    // A chat that commits at once but finishes loading 1.5 s later.
    if (u.pathname === '/t/50') { r.setHeader('content-type', 'text/html; charset=utf-8'); r.write(`<!doctype html><title>slow</title><body>${' '.repeat(2048)}`); setTimeout(() => r.end('slow chat</body>'), 1500); return; }
    // A chat that sends a signed-out window to a sign-in page answering 1.5 s later.
    if (u.pathname === '/t/70') { r.writeHead(302, { location: '/login/slow' }); return r.end(); }
    if (u.pathname === '/login/slow') { setTimeout(() => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(page('sign in')); }, 1500); return; }
    if (u.pathname === '/groupcall/slow/') { setTimeout(() => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(page('late call')); }, 1500); return; }
    // A chat whose server answers only 1.5 s later.
    if (u.pathname === '/t/60') { setTimeout(() => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(page('late chat')); }, 1500); return; }
    if (u.pathname === '/t/80') { r.writeHead(302, { location: '/login/check' }); return r.end(); }
    if (u.pathname === '/login/check') { r.writeHead(302, { location: '/t/81' }); return r.end(); }
    // Discord stand-in: the call button appears like in the real SPA, a little after the page.
    if (u.pathname === '/rang') { rang.push({ ...Object.fromEntries(u.searchParams), at: Date.now() }); return r.end(''); }
    if (u.pathname === '/channels/@me/90') { r.writeHead(302, { location: '/login' }); return r.end(); }
    // 20: Discord's server sending the DM on to another DM (21) is another person, not the same chat.
    if (u.pathname === '/channels/@me/20') { r.writeHead(302, { location: '/channels/@me/21' }); return r.end(); }
    // 82: signed out, the server sends the DM through /login and straight back (no login page is ever shown).
    if (u.pathname === '/channels/@me/82' && !u.searchParams.has('back')) { r.writeHead(302, { location: '/login?back=82' }); return r.end(); }
    // An image that keeps DM 68 loading for 2.5 s (well inside the click's time).
    if (u.pathname === '/slow.png') { setTimeout(() => r.end(''), 2500); return; }
    // 77: a sign-in the page goes to that answers without a page (204): the DM stays on screen.
    if (u.pathname === '/login' && u.searchParams.has('nc')) { r.writeHead(204); return r.end(); }
    if (u.pathname === '/login' && u.searchParams.get('back') === '82') { r.writeHead(302, { location: '/channels/@me/82?back=1' }); return r.end(); }
    const dm = /^\/channels\/@me\/(\d+)$/.exec(u.pathname)?.[1];
    // 97 answers 1.5 s later, 89 only after the click's time to call is over.
    if ((dm === '97' || dm === '89') && !q.headers['x-late']) { setTimeout(() => { q.headers['x-late'] = '1'; server.emit('request', q, r); }, dm === '89' ? 6000 : 1500); return; }
    if (dm || u.pathname === '/login') {
      const id = dm || 'login';
      const label = id === '92' ? 'Start Video Call' : 'Start Voice Call';
      // 73: the page itself moves on to DM 74 once and draws 74's call button; the window puts the address back.
      const shows = id === '73' ? '74' : id;
      // 83: pressing the button moves the page to DM 991 at once, the same button now 991's; other clicks are recorded
      // with the element they reached.
      const swap = id === '83' ? `b.addEventListener('mousedown', () => { window.swapped = 1; history.pushState({}, '', '/channels/@me/991'); });
          document.addEventListener('click', (e) => { if (!e.target.closest('button')) fetch('/rang?id=stray83&on=' + e.target.tagName); });` : '';
      // 81: a hidden copy of the button (display: none) comes before the one to be seen.
      const twin = id === '81' ? `<button aria-label="Start Voice Call" style="display:none">☎</button>` : '';
      // 84: the button is there but see-through (its header has opacity 0).
      const header = id === '84' ? 'opacity:0;' : id === '79' ? 'filter:opacity(0);' : '';
      // 78: the button sits in a disabled fieldset for its first 1.5 s.
      const [fsOpen, fsClose, fsLater] = id === '78' ? ['<fieldset disabled style="display:inline;border:0;padding:0;margin:0">', '</fieldset>', `setTimeout(() => document.querySelector('fieldset').disabled = false, 1500);`] : ['', '', ''];
      const cover = id === '93' ? '<div style="position:fixed;inset:0;background:#000a"></div>' : '';
      // 96: signed out, the SPA itself moves to /login (no server redirect). 98: the button comes late.
      // 77: goes to a sign-in that never shows; 75: blanks itself once (about:blank) before the button.
      const away = id === '77' ? `setTimeout(() => { location.href = '/login?nc=1'; }, 300);` : id === '75' ? `if (!sessionStorage.blanked) { sessionStorage.blanked = 1; setTimeout(() => { location.href = 'about:blank'; }, 300); }` : '';
      const spa = id === '96' ? `setTimeout(() => history.replaceState({}, '', '/login'), 300);` : id === '73' ? `if (!sessionStorage.moved) { sessionStorage.moved = 1; setTimeout(() => history.pushState({}, '', '/channels/@me/74'), 200); }` : '';
      // 85: the button comes just before the click's time is over, and the page stalls a moment while the cursor comes
      // (at its 6th move over a page with the button: the cursor resting there may send one or two of its own).
      // 68 and 69: the button is there at once (68 keeps loading for 2.5 s), for Karchi to press it himself.
      const late = id === '98' ? 1800 : id === '85' ? 4300 : id === '68' || id === '69' ? 0 : 800;
      const slow = id === '68' ? '<img src="/slow.png">' : '';
      const stall = id === '85' ? `document.addEventListener('mousemove', () => { if (document.querySelector('button') && ++window.seen === 6) { const end = Date.now() + 900; while (Date.now() < end); } }); window.seen = 0;` : '';
      // 86: a banner over the button leaves only its very centre free; a click on the banner is recorded.
      const banner = id === '86' ? `const r = document.querySelector('button').getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          for (const [x, y, w, h] of [[r.left, r.top, cx - 1 - r.left, r.height], [cx + 1, r.top, r.right - cx - 1, r.height], [cx - 1, r.top, 2, cy - 1 - r.top], [cx - 1, cy + 1, 2, r.bottom - cy - 1]]) {
            const d = document.createElement('div');
            d.style.cssText = 'position:fixed;z-index:9;background:#f00a;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px';
            d.addEventListener('click', () => fetch('/rang?id=banner'));
            document.body.append(d);
          }` : '';
      // 99: a banner pushes the button aside just as the cursor sets off: the click must not land where it was.
      const jumpy = id === '99' ? `document.addEventListener('mousemove', () => { const b = document.querySelector('button'); if (b && !window.moved) { window.moved = 1; b.style.margin = '8px 400px'; } });
        document.addEventListener('click', (e) => { if (!e.target.closest('button')) fetch('/rang?id=stray'); });` : '';
      r.setHeader('content-type', 'text/html; charset=utf-8');
      return r.end(page(`<script>
        window.moves = 0; document.addEventListener('mousemove', () => window.moves++);
        ${spa}
        ${jumpy}
        ${stall}
        ${away}
        setTimeout(() => {
          document.body.insertAdjacentHTML('beforeend', '<header style="${header}position:fixed;top:0;right:0;width:100%;height:48px;text-align:right">${twin}${fsOpen}<button aria-label="${label}" style="width:32px;height:32px;margin:8px 120px">☎</button>${fsClose}</header>${cover}');
          const b = [...document.querySelectorAll('button')].at(-1);
          ${swap}
          ${fsLater}
          b.addEventListener('click', (e) => fetch('/rang?id=' + (window.swapped ? '991' : '${shows}') + '&trusted=' + e.isTrusted + '&moves=' + window.moves));
          ${banner}
        }, ${late});
      </script>dm ${id}${slow}`));
    }
    if (u.pathname === '/t/777') return r.end(page(`<script>history.replaceState({}, '', '/t/778')</script>`));
    r.setHeader('content-type', 'text/html; charset=utf-8');
    if (u.pathname === '/') return r.end(page('app'));
    if (/^\/t\/\d+$/.test(u.pathname)) { r.setHeader('set-cookie', 'weftcalltest=1; Path=/; Max-Age=3600'); return r.end(page(`chat <iframe src="${other}/frame" allow="camera; microphone"></iframe>`)); }
    return r.end(page(u.pathname));
  });
  await new Promise((res) => server.listen(port, '127.0.0.1', res));
  // The pilot's rules, moved onto the stand-in's address (same shape as the real ones above).
  t.CALL_NETS.messenger = {
    name: 'Messenger', media: [origin], chat: (id) => `${origin}/t/${id}`,
    isChat: (u, id) => u.origin === origin && new RegExp(`^/t/${id}$`).test(u.pathname),
    chatId: (u) => (u.origin === origin && /^\/(?:e2ee\/)?t\/(\d+)$/.exec(u.pathname)?.[1]) || null,
    allows: (u) => u.origin === origin && /^\/(groupcall|login)(\/|$)/.test(u.pathname),
    passes: (u) => u.origin === origin && u.pathname === '/',
    popup: (u) => u.origin === origin && /^\/groupcall\//.test(u.pathname),
  };
  const callWin = () => t.calls.get('messenger')?.win;
  const urlOf = () => { try { const u = new URL(callWin().webContents.getURL()); return u.protocol === 'data:' ? 'data:' : u.pathname; } catch { return ''; } };
  const settle = async (want, ms = 8000) => { for (let i = 0; i < ms / 100 && urlOf() !== want; i++) await sleep(100); return urlOf(); };
  // Runs a step that leaves the chat and returns the paths the window tried on the way (so a check cannot pass
  // before anything moved), then where it ended.
  const leave = async (code, via) => {
    const wc = callWin().webContents;
    const tried = [];
    const note = (_e, url) => { try { tried.push(new URL(url).pathname); } catch {} };
    const events = ['will-navigate', 'will-redirect', 'did-navigate', 'did-navigate-in-page'];
    for (const e of events) wc.on(e, note);
    await run(code).catch(() => {});
    for (let i = 0; i < 50 && !tried.includes(via); i++) await sleep(100);
    const end = await settle('/t/123');
    await sleep(300);
    for (const e of events) wc.off(e, note);
    return { ok: tried.includes(via) && urlOf() === '/t/123', detail: `${tried.join(' → ')}; ${end}` };
  };
  const run = (code, contents = callWin().webContents) => contents.executeJavaScript(code, true);
  // Where the call session sends Messenger: the tunnel, or the dead end used while there is none (never DIRECT, and
  // neither does the page's localhost: x270's own services stay out of its reach).
  const route = async () => {
    const r = await t.callSession('messenger').resolveProxy('https://www.messenger.com/');
    const local = await t.callSession('messenger').resolveProxy('http://127.0.0.1:6463/');
    return /DIRECT/.test(r) || /DIRECT/.test(local) ? 'priamo' : /127\.0\.0\.1:9\b/.test(r) ? 'nikam' : /SOCKS/.test(r) ? 'tunel' : r;
  };
  const popupOf = async (contents) => {
    const made = [];
    contents.on('did-create-window', (child) => made.push(child));
    await contents.executeJavaScript(`window.open('/groupcall/ROOM:1/'); 0`, true);
    for (let i = 0; i < 50 && !made.length; i++) await sleep(100);
    const child = made[0];
    if (child) await new Promise((r) => (child.webContents.isLoading() ? child.webContents.once('did-finish-load', r) : r()));
    return child;
  };

  try {
    if (mode === 'call-notunnel') {
      await t.openCall('messenger', '123');
      await sleep(500);
      const text = urlOf() === 'data:' ? await run('document.body.innerText') : '';
      check('bez tunela: chyba, žiadne priame spojenie', /tunel na asus sa nepodaril/.test(text) && (await route()) === 'nikam', `${urlOf()}, ${await route()}`);
      return;
    }
    if (mode === 'call-discord') {
      // The cursor's way: inside the window, ends on the button, bent and different each time.
      const paths = Array.from({ length: 50 }, () => t.cursorPath({ x: 30, y: 700 }, { x: 800, y: 24 }, 940, 760));
      const straight = (p) => p.every((q) => Math.abs((q.y - 700) * 770 - (q.x - 30) * -676) / Math.hypot(770, 676) < 3);
      check('kurzor: 14–30 bodov v okne, koniec na tlačidle, pauzy 6–19 ms', paths.every((p) => p.length >= 14 && p.length <= 30 && p.at(-1).x === 800 && p.at(-1).y === 24
        && p.every((q) => q.x >= 0 && q.x < 940 && q.y >= 0 && q.y < 760 && q.wait >= 6 && q.wait <= 19)));
      check('kurzor: zakrivená a zakaždým iná dráha', paths.filter(straight).length < 5 && new Set(paths.map((p) => JSON.stringify(p))).size === 50, `${paths.filter(straight).length} rovných`);
      // The real rules moved onto the stand-in's address; everything else (no popups, no aliases, labels) stays.
      const real = t.CALL_NETS.discord;
      t.CALL_NETS.discord = {
        ...real, media: [origin], chat: (id) => `${origin}/channels/@me/${id}`,
        chatId: (u) => (u.origin === origin && /^\/channels\/@me\/(\d{1,20})(?:\/\d{1,20})?\/?$/.exec(u.pathname)?.[1]) || null,
        allows: (u) => u.origin === origin && /^\/login\/?$/.test(u.pathname),
        passes: (u) => u.origin === origin && /^\/(app|channels\/@me)?\/?$/.test(u.pathname),
        autoCall: { ...real.autoCall, wait: 5000 },
      };
      const dw = () => t.calls.get('discord')?.win;
      const pressed = (id) => rang.filter((x) => x.id === id);
      const waitPress = async (id) => { for (let i = 0; i < 60 && !pressed(id).length; i++) await sleep(100); return pressed(id); };
      await t.openCall('discord', '70');
      const p70 = await waitPress('70');
      check('Discord: okno samo stlačí hovor, skutočným klikom po ceste kurzora', p70.length === 1 && p70[0].trusted === 'true' && Number(p70[0].moves) >= 10, JSON.stringify(p70));
      check('Discord: okno 940 px, názov „Hovor · Discord (beta)“', dw().getContentSize()[0] === 940 && dw().getTitle() === 'Hovor · Discord (beta)', `${dw().getContentSize()}, ${dw().getTitle()}`);
      await t.openCall('discord', '70');
      await sleep(2500);
      check('Discord: klik na chat už v okne nevolá znova (hovor môže bežať)', pressed('70').length === 1, JSON.stringify(pressed('70')));
      await dw().webContents.executeJavaScript(`window.open('about:blank'); window.open('${origin}/channels/@me/70'); 1`);
      await sleep(800);
      check('Discord: stránka neotvorí žiadne nové okno, ani prázdne', t.callWindows('discord').length === 1, `${t.callWindows('discord').length} okien`);
      await t.openCall('discord', '71');
      check('Discord: iný DM: stlačí hovor tam', (await waitPress('71')).length === 1);
      // A quick click back on the DM on screen while another loads: that click's call goes nowhere.
      await t.openCall('discord', '97'); // its server answers 1.5 s later
      await sleep(300);
      await t.openCall('discord', '71');
      await sleep(5500);
      check('Discord: rýchly klik späť na DM v okne nezavolá ani tam, ani inam', pressed('71').length === 1 && !pressed('97').length, JSON.stringify(rang));
      // Signed out in the SPA (it moves to /login itself): a sign-in that ends on the DM does not call.
      await t.openCall('discord', '96');
      for (let i = 0; i < 30 && new URL(dw().webContents.getURL()).pathname !== '/login'; i++) await sleep(100);
      await sleep(1500);
      await dw().webContents.executeJavaScript(`history.pushState({}, '', '/channels/@me/96')`);
      await sleep(5500);
      check('Discord: po prihlásení na DM okno nevolá samo', !pressed('96').length && new URL(dw().webContents.getURL()).pathname === '/channels/@me/96', `${JSON.stringify(rang)}, ${dw().webContents.getURL()}`);
      // Zoomed in (Ctrl+plus) the click still lands on the button.
      await t.openCall('discord', '98');
      for (let i = 0; i < 30 && new URL(dw().webContents.getURL()).pathname !== '/channels/@me/98'; i++) await sleep(100);
      await sleep(300);
      dw().webContents.setZoomFactor(1.5);
      const p98 = await waitPress('98');
      dw().webContents.setZoomFactor(1);
      check('Discord: priblížené okno: klik trafí tlačidlo', p98.length === 1, JSON.stringify(p98));
      // A button that moves away while the cursor comes: no click where it was, found again and pressed there.
      await t.openCall('discord', '99');
      await waitPress('99');
      await sleep(500);
      check('Discord: tlačidlo sa pohne počas cesty kurzora: klik ho nájde znova, nikdy vedľa', pressed('99').length === 1 && !pressed('stray').length, JSON.stringify(rang));
      // A page that comes after the click's time is over: no call long after the click.
      const before89 = rang.length;
      await t.openCall('discord', '89');
      await sleep(8000);
      check('Discord: stránka príde po čase: nevolá neskoro', !pressed('89').length && new URL(dw().webContents.getURL()).pathname === '/channels/@me/89', `${JSON.stringify(rang.slice(before89))}, ${dw().webContents.getURL()}`);
      await t.openCall('discord', '90');
      await sleep(3500);
      check('Discord: odhlásený: tlačidlo na stránke prihlásenia nestlačí', !pressed('login').length && new URL(dw().webContents.getURL()).pathname === '/login', dw().webContents.getURL());
      // The server sends the DM clicked on to another DM: nobody is called, the other DM least of all.
      const before20 = rang.length;
      await t.openCall('discord', '20');
      await sleep(4500);
      check('Discord: presmerovanie na iný DM nikoho nezavolá', rang.length === before20 && new URL(dw().webContents.getURL()).pathname !== '/channels/@me/21', `${JSON.stringify(rang.slice(before20))}, ${dw().webContents.getURL()}`);
      // The page moves itself to another DM and the window puts the address back: the other DM's button may still be on
      // screen, so nobody is called.
      const before73 = rang.length;
      await t.openCall('discord', '73');
      await sleep(4000);
      check('Discord: stránka sama prejde na iný DM: okno nikoho nezavolá', rang.length === before73 && new URL(dw().webContents.getURL()).pathname === '/channels/@me/73', `${JSON.stringify(rang.slice(before73))}, ${dw().webContents.getURL()}`);
      // The page moves to another DM between the press and the release: the release goes outside the page, so no
      // control gets a click (Chromium counts it as a click on the page's root, which does nothing).
      await t.openCall('discord', '83');
      await sleep(4000);
      check('Discord: stránka prejde na iný DM počas stlačenia: klik nedostane žiadny ovládač', !pressed('991').length && !pressed('83').length && pressed('stray83').every((x) => x.on === 'HTML'), JSON.stringify(rang));
      // Through /login and straight back to the DM: a sign-in on the way, this click calls nobody.
      const before82 = rang.length;
      await t.openCall('discord', '82');
      await sleep(3500);
      check('Discord: presmerovanie cez prihlásenie späť na DM nevolá', rang.length === before82 && new URL(dw().webContents.getURL()).pathname === '/channels/@me/82', `${JSON.stringify(rang.slice(before82))}, ${dw().webContents.getURL()}`);
      // A hidden copy of the button before the real one: the real one is pressed.
      await t.openCall('discord', '81');
      check('Discord: skrytá kópia tlačidla: stlačí to viditeľné', (await waitPress('81')).length === 1, JSON.stringify(rang));
      await t.openCall('discord', '84');
      await sleep(3500);
      await t.openCall('discord', '79');
      await sleep(3500);
      check('Discord: neviditeľné tlačidlo (opacity, filter) nestlačí', !pressed('84').length && !pressed('79').length, JSON.stringify(rang));
      // A sign-in the page goes to that never shows (204): the DM stays, the click's call is over.
      await t.openCall('discord', '77');
      await sleep(3500);
      check('Discord: prihlásenie, ktoré sa neukáže (204): nevolá', !pressed('77').length && new URL(dw().webContents.getURL()).pathname === '/channels/@me/77', `${JSON.stringify(rang)}, ${dw().webContents.getURL()}`);
      // The page blanks itself: the window goes back to the DM and calls nobody.
      await t.openCall('discord', '75');
      await sleep(4000);
      check('Discord: stránka sa sama vyprázdni (about:blank): okno sa vráti na DM a nevolá', !pressed('75').length && new URL(dw().webContents.getURL()).pathname === '/channels/@me/75', `${JSON.stringify(rang)}, ${dw().webContents.getURL()}`);
      // Karchi presses the button himself before the window does: one press, his.
      await t.openCall('discord', '76');
      let at76 = null;
      for (let i = 0; i < 100 && !at76; i++) { await sleep(20); at76 = await dw().webContents.executeJavaScript(`(() => { const b = document.querySelector('button'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`).catch(() => null); }
      dw().webContents.sendInputEvent({ type: 'mouseDown', x: at76.x, y: at76.y, button: 'left', clickCount: 1 });
      dw().webContents.sendInputEvent({ type: 'mouseUp', x: at76.x, y: at76.y, button: 'left', clickCount: 1 });
      await sleep(3500);
      check('Discord: Karchi stlačí hovor sám: okno už nestlačí druhýkrát', pressed('76').length === 1, JSON.stringify(pressed('76')));
      // The same while the page still loads, by mouse (68), and with the keyboard (69: focus and Enter).
      const buttonAt = async () => {
        for (let i = 0; i < 150; i++) {
          const at = await dw().webContents.executeJavaScript(`(() => { const b = document.querySelector('button'); if (!b || !/@me\\/69$/.test(location.pathname)) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`).catch(() => null);
          if (at) return at;
          await sleep(20);
        }
        return null;
      };
      // A script in the page would wait for the load to end, so the button's place is worked out: the header's right
      // end, 120 px margin, 32 px wide, 8 px from the top.
      await t.openCall('discord', '68');
      for (let i = 0; i < 100 && !/@me\/68$/.test(dw().webContents.getURL()); i++) await sleep(20);
      await sleep(400);
      const at68 = { x: dw().getContentSize()[0] - 120 - 16, y: 24 };
      const loading68 = dw().webContents.isLoading();
      dw().webContents.sendInputEvent({ type: 'mouseDown', x: at68.x, y: at68.y, button: 'left', clickCount: 1 });
      dw().webContents.sendInputEvent({ type: 'mouseUp', x: at68.x, y: at68.y, button: 'left', clickCount: 1 });
      await sleep(7000);
      check('Discord: Karchi stlačí hovor sám, kým sa stránka ešte načítava: okno nestlačí druhýkrát', loading68 && pressed('68').length === 1, `${loading68}, ${JSON.stringify(pressed('68'))}`);
      await t.openCall('discord', '69');
      await buttonAt();
      await dw().webContents.executeJavaScript(`document.querySelector('button').focus()`);
      for (const type of ['rawKeyDown', 'char', 'keyUp']) dw().webContents.sendInputEvent({ type, keyCode: type === 'char' ? '\r' : 'Return' });
      await sleep(3500);
      check('Discord: Karchi stlačí hovor sám klávesom Enter: okno nestlačí druhýkrát', pressed('69').length === 1, JSON.stringify(pressed('69')));
      // Disabled for a moment (a fieldset around it): pressed once it can be.
      await t.openCall('discord', '78');
      check('Discord: chvíľu zakázané tlačidlo stlačí, až keď sa dá', (await waitPress('78')).length === 1, JSON.stringify(rang));
      // A banner over most of the button: the click lands on the button or not at all, never on the banner.
      await t.openCall('discord', '86');
      await sleep(5500);
      check('Discord: tlačidlo čiastočne zakryté: klik nikdy na to, čo ho zakrýva', !pressed('banner').length, JSON.stringify(rang));
      // The button comes just before the time is over and the page stalls: no press after the time.
      const t85 = Date.now();
      await t.openCall('discord', '85');
      await sleep(7000);
      check('Discord: tlačidlo tesne pred koncom času: nestlačí po čase', pressed('85').every((x) => x.at - t85 < 5000), JSON.stringify(pressed('85').map((x) => x.at - t85)));
      const quiet = rang.length;
      await t.openCall('discord', '92');
      await sleep(3500);
      check('Discord: bez tlačidla hovoru (iný popis) nestlačí nič', !pressed('92').length && rang.length === quiet, JSON.stringify(rang));
      await t.openCall('discord', '93');
      await sleep(3500);
      check('Discord: zakryté tlačidlo nestlačí', !pressed('93').length && rang.length === quiet, JSON.stringify(rang));
      // A click while the window is still starting: one window, and only the last chat is called.
      dw().destroy();
      const starting = t.openCall('discord', '94');
      for (let i = 0; i < 20 && !dw(); i++) await sleep(50);
      await t.openCall('discord', '95');
      await starting;
      await waitPress('95');
      await sleep(1500);
      check('Discord: dva kliky počas štartu: jedno okno, volá len posledný chat', !pressed('94').length && pressed('95').length === 1 && t.callWindows('discord').length === 1, JSON.stringify(rang));
      return;
    }
    if (mode === 'call-again') {
      const kept = await t.callSession('messenger').cookies.get({ name: 'weftcalltest' });
      const login = await session.fromPartition(`persist:login-127.0.0.1:${port}`).cookies.get({ name: 'weftcalltest' });
      check('prihlásenie okna prežije reštart', kept.length === 1);
      check('prihlasovacie okno ho nevidí', login.length === 0);
      await t.openCall('messenger', '123');
      const child = await popupOf(callWin().webContents);
      await t.forgetCalls();
      const gone = await t.callSession('messenger').cookies.get({});
      check('Odhlásiť okno hovorov zmaže jeho prihlásenie', gone.length === 0, `${gone.length} cookies`);
      check('Odhlásiť okno hovorov zavrie okno aj popup hovoru', !!child && child.isDestroyed() && t.callWindows('messenger').length === 0);
      // A network that rewrites the chat's id (Instagram might): the window ends with an explanation, not a loop.
      await t.openCall('messenger', '777');
      for (let i = 0; i < 100 && urlOf() !== 'data:'; i++) await sleep(100);
      const said = urlOf() === 'data:' ? await run('document.body.innerText') : urlOf();
      check('stránka sama prepíše id chatu: vysvetlenie, nie slučka', /odchádza z chatu/.test(said), said);
      // The network's server sending the window's own load to another address of a chat (an encrypted chat):
      // the same chat, also afterwards.
      await t.openCall('messenger', '555');
      const there = await settle('/e2ee/t/556');
      await run(`history.pushState({}, '', '/t/999')`);
      check('presmerovanie servera na šifrovaný chat: okno ho prijme', there === '/e2ee/t/556' && (await settle('/e2ee/t/556')) === '/e2ee/t/556', `${there}, ${urlOf()}`);
      const seen = [];
      callWin().webContents.on('did-navigate', (_e, url) => seen.push(new URL(url).pathname));
      // A quick click back on that chat while another one loads: still the same chat, no reload.
      await run('window.inPage = 7');
      await t.openCall('messenger', '60'); // its server answers 1.5 s later
      await sleep(300);
      await t.openCall('messenger', '555');
      await sleep(2500);
      check('rýchly klik späť na presmerovaný chat ho nenačíta znova', !seen.length && urlOf() === '/e2ee/t/556' && (await run('window.inPage')) === 7, `${seen.join(' → ')}, ${urlOf()}`);
      // While another chat loads, the chat on screen still cannot reach the start page.
      await run(`document.body.insertAdjacentHTML('afterbegin', '<a href="/" style="position:fixed;inset:0;display:block;z-index:9">x</a>')`);
      await t.openCall('messenger', '60');
      await sleep(300);
      // A real click on a link (a script's navigation without one does not cancel the window's own load).
      for (const type of ['mouseDown', 'mouseUp']) callWin().webContents.sendInputEvent({ type, x: 20, y: 20, button: 'left', clickCount: 1 });
      await settle('/t/60');
      await sleep(500);
      check('počas načítania iného chatu sa z chatu na zoznam chatov nedá', !seen.includes('/') && urlOf() === '/t/60', `${seen.join(' → ')}, ${urlOf()}`);
      // Through a detour (a login page between), another chat is not the same chat.
      seen.length = 0;
      await t.openCall('messenger', '80');
      for (let i = 0; i < 100 && urlOf() !== 'data:' && urlOf() !== '/t/81'; i++) await sleep(100);
      check('presmerovanie cez obchádzku na iný chat: okno ho neprijme', !seen.includes('/t/81') && !t.calls.get('messenger').aliases.has('81'), `${seen.join(' → ')}, ${urlOf()}`);
      // Back while the next chat is still loading never shows the one before.
      await t.openCall('messenger', '40');
      await settle('/t/40');
      const commits = [];
      callWin().webContents.on('did-navigate', (_e, url) => commits.push(new URL(url).pathname));
      await t.openCall('messenger', '50'); // its page commits at once and finishes 1.5 s later
      for (let i = 0; i < 50 && urlOf() !== '/t/50'; i++) await sleep(20);
      const loading = callWin().webContents.isLoading();
      callWin().webContents.navigationHistory.goBack();
      await settle('/t/50');
      await sleep(500);
      check('späť počas načítania ďalšieho chatu neukáže predošlý', loading && !commits.includes('/t/40') && urlOf() === '/t/50', `načítava ${loading}, ${commits.join(' → ')}, ${urlOf()}`);
      // A quick click back on the chat still on screen while another one loads: the other one never shows.
      await run('window.inPage = 5');
      const later = [];
      callWin().webContents.on('did-navigate', (_e, url) => later.push(new URL(url).pathname));
      await t.openCall('messenger', '60'); // its server answers 1.5 s later
      await sleep(300);
      await t.openCall('messenger', '50');
      await sleep(2500);
      check('rýchly klik späť na chat na obrazovke: ten druhý sa neukáže', !later.includes('/t/60') && urlOf() === '/t/50' && (await run('window.inPage')) === 5, `${later.join(' → ')}, ${urlOf()}`);
      // A second click on the same chat while its own load waits for the sign-in page: the load goes on.
      await t.openCall('messenger', '70');
      await sleep(300);
      await t.openCall('messenger', '70');
      await settle('/login/slow');
      await sleep(300);
      check('druhý klik počas čakania na prihlásenie ho nezačne znova', urlOf() === '/login/slow' && hits['/t/70'] === 1 && hits['/login/slow'] === 1, `${JSON.stringify({ chat: hits['/t/70'], login: hits['/login/slow'] })}, ${urlOf()}`);
      return;
    }
    // The IPC path the app uses: a window with the shell's preload on the app's address.
    const main = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), partition: 'selftest-app', contextIsolation: true, sandbox: true } });
    t.setMain(main);
    await main.loadURL(t.APP_URL);
    const refused = await main.webContents.executeJavaScript(`Promise.all([{ network: 'messenger', id: '12a' }, { network: 'whatsapp', id: '1' }, { network: 'teams', id: '1' }, { network: 'discord', id: '1' }, { network: '__proto__', id: '1' }, { network: 'messenger', id: 123 }]
      .map((s) => window.desktop.call(s).then(() => 'opened', () => 'refused')))`);
    check('zlá sieť alebo id: okno sa neotvorí', refused.every((x) => x === 'refused') && !callWin(), JSON.stringify(refused));
    check('appka vie, ktoré siete okno má', JSON.stringify(await main.webContents.executeJavaScript('window.desktop.callNetworks')) === '["messenger","instagram","discord"]');
    // A second click while the window is still starting: no second window, and it lands on the last chat.
    const starting = main.webContents.executeJavaScript(`window.desktop.call({ network: 'messenger', id: '999' })`);
    for (let i = 0; i < 20 && !callWin(); i++) await sleep(50);
    const startRoute = await route();
    await main.webContents.executeJavaScript(`window.desktop.call({ network: 'messenger', id: '123' })`);
    await starting;
    check('počas štartu: žiadne priame spojenie', startRoute === 'nikam', startRoute);
    check('druhý klik počas štartu: jedno okno, posledný chat', BrowserWindow.getAllWindows().filter((w) => w.webContents.session === t.callSession('messenger')).length === 1 && (await settle('/t/123')) === '/t/123', urlOf());
    check('okno ide cez tunel', (await route()) === 'tunel', await route());
    check('okno nemá window.desktop', (await run('typeof window.desktop')) === 'undefined');
    check('kamera a mikrofón pre povolený pôvod', (await run('probe()')) === 'ok');
    const frame = callWin().webContents.mainFrame.frames[0];
    check('iný pôvod (vnorený rámec): NotAllowedError', frame && (await frame.executeJavaScript('probe()')) === 'NotAllowedError');
    check('notifikácie odmietnuté', (await run('Notification.requestPermission()')) === 'denied');
    // Leaving the chat in any way brings it back.
    // A refused link keeps the page as it was (a draft, a call in the page): no reload.
    let r = await leave(`window.inPage = 1; location.href = '/marketplace'`, '/marketplace');
    check('odkaz inam: okno ostane na chate bez znovunačítania', r.ok && (await run('window.inPage')) === 1, r.detail);
    r = await leave(`history.pushState({}, '', '/t/999')`, '/t/999');
    check('iný chat v stránke (pushState) sa vráti bez znovunačítania', r.ok && (await run('window.inPage')) === 1, r.detail);
    r = await leave(`location.href = '/'`, '/');
    check('z chatu na zoznam chatov (/) nie, chat ostane', r.ok && (await run('window.inPage')) === 1, r.detail);
    r = await leave(`location.href = '/login/away'`, '/marketplace');
    check('presmerovanie mimo chatu: chat ostane', r.ok, r.detail);
    // Signing in: from a login page, the start page is passed through to the chat.
    await run(`location.href = '/login/x'`).catch(() => {});
    await settle('/login/x');
    // A click on the same chat while signing in only brings the window forward: the form stays.
    await run('window.inPage = 4');
    await main.webContents.executeJavaScript(`window.desktop.call({ network: 'messenger', id: '123' })`);
    await sleep(800);
    check('klik na ten istý chat počas prihlásenia formulár nezmaže', urlOf() === '/login/x' && (await run('window.inPage')) === 4, urlOf());
    r = await leave(`location.href = '/login/done'`, '/');
    check('prihlásenie, ktoré skončí na zozname chatov, dá chat', r.ok, r.detail);
    // Popups: only the call, in the same session, with the same locks.
    const made = [];
    callWin().webContents.on('did-create-window', (child) => made.push(child));
    await run(`window.open('/elsewhere'); window.open('https://example.com/'); 0`);
    await sleep(800);
    check('popup mimo hovoru sa neotvorí', made.length === 0, String(made.length));
    const child = await popupOf(callWin().webContents);
    check('popup hovoru sa otvorí v tej istej session', !!child && child.webContents.session === t.callSession('messenger') && (await run('probe()', child.webContents)) === 'ok');
    if (child) {
      const closed = new Promise((r) => child.once('closed', () => r(true)));
      await run(`location.href = '/t/123'`, child.webContents).catch(() => {});
      check('popup, ktorý odíde z hovoru (aj na chat okna), sa zavrie', await Promise.race([closed, sleep(5000).then(() => false)]));
    }
    // Another chat from the app turns the same window.
    const first = callWin();
    await main.webContents.executeJavaScript(`window.desktop.call({ network: 'messenger', id: '456' })`);
    check('ďalší chat otočí to isté okno', callWin() === first && (await settle('/t/456')) === '/t/456', urlOf());
    await run('window.inPage = 2');
    await main.webContents.executeJavaScript(`window.desktop.call({ network: 'messenger', id: '456' })`);
    await sleep(800);
    check('klik na ten istý chat stránku nenačíta znova', urlOf() === '/t/456' && (await run('window.inPage')) === 2, urlOf());
    // Back after another chat never shows the earlier chat: the window's history starts at its chat.
    const went = [];
    callWin().webContents.on('did-navigate', (_e, url) => went.push(new URL(url).pathname));
    callWin().webContents.navigationHistory.goBack(); // what Alt+← does
    await sleep(800);
    check('späť po prepnutí chatu neukáže predošlý chat', !went.includes('/t/123') && urlOf() === '/t/456', `${went.join(' → ')}, ${urlOf()}`);
    // A call starting in the window itself: clicking its chat again lets it come.
    await run(`location.href = '/groupcall/slow/'`).catch(() => {}); // its server answers 1.5 s later
    await sleep(300);
    await main.webContents.executeJavaScript(`window.desktop.call({ network: 'messenger', id: '456' })`);
    check('hovor, ktorý sa v okne ešte načítava: klik na jeho chat ho nezruší', (await settle('/groupcall/slow/')) === '/groupcall/slow/', urlOf());
    // A call running in the window itself: clicking its chat again keeps it.
    await run(`location.href = '/groupcall/fixture/'`).catch(() => {});
    await settle('/groupcall/fixture/');
    await run('window.inPage = 3');
    await main.webContents.executeJavaScript(`window.desktop.call({ network: 'messenger', id: '456' })`);
    await sleep(800);
    check('hovor v okne: klik na jeho chat ho nechá', urlOf() === '/groupcall/fixture/' && (await run('window.inPage')) === 3, urlOf());
    for (const away of ['/marketplace', '/']) {
      await run(`location.href = '${away}'`).catch(() => {});
      await sleep(600);
      check(`hovor v okne: odkaz na ${away} ho nechá`, urlOf() === '/groupcall/fixture/' && (await run('window.inPage')) === 3, urlOf());
    }
    await run(`history.pushState({}, '', '/t/999')`);
    await sleep(600);
    check('hovor v okne: iný chat v stránke (pushState) ho nechá', urlOf() === '/groupcall/fixture/' && (await run('window.inPage')) === 3, urlOf());
    // While another chat loads: a click on the chat whose call is on screen keeps the call, and back never shows it.
    const turned = [];
    callWin().webContents.on('did-navigate', (_e, url) => turned.push(new URL(url).pathname));
    const pick = (id) => main.webContents.executeJavaScript(`window.desktop.call({ network: 'messenger', id: '${id}' })`);
    await pick('60'); // its server answers 1.5 s later
    await sleep(300);
    await pick('456');
    await sleep(2500);
    check('hovor v okne: klik naň počas načítania iného chatu ho nechá', !turned.length && urlOf() === '/groupcall/fixture/' && (await run('window.inPage')) === 3, `${turned.join(' → ')}, ${urlOf()}`);
    await pick('60');
    await sleep(300);
    callWin().webContents.navigationHistory.goBack();
    await settle('/t/60');
    await sleep(500);
    check('z hovoru v okne: späť počas načítania iného chatu neukáže predošlý', !turned.includes('/t/456') && urlOf() === '/t/60', `${turned.join(' → ')}, ${urlOf()}`);
    await pick('456');
    await settle('/t/456');
    await run(`location.href = '/t/123'`).catch(() => {});
    check('pôvodný chat už nie je povolený', (await settle('/t/456')) === '/t/456', urlOf());
    const cookie = await t.callSession('messenger').cookies.get({ name: 'weftcalltest' });
    check('cookie okna je v jeho profile', cookie.length === 1);
    await t.callSession('messenger').cookies.flushStore();
    // The tunnel falls mid-call: the window says so, its popup closes, nothing goes direct.
    const fallen = await popupOf(callWin().webContents);
    for (const ssh of t.tunnels) ssh.kill();
    for (let i = 0; i < 50 && urlOf() !== 'data:'; i++) await sleep(100);
    const said = urlOf() === 'data:' ? await run('document.body.innerText') : urlOf();
    check('pád tunela počas hovoru: okno to povie', /spadlo/.test(said), said);
    check('pád tunela: popup sa zavrie, Messenger nejde nikam', !!fallen && fallen.isDestroyed() && (await route()) === 'nikam', await route());
    // The next click builds the window again behind a new tunnel.
    const dead = callWin();
    await main.webContents.executeJavaScript(`window.desktop.call({ network: 'messenger', id: '456' })`);
    check('klik po páde: nové okno cez nový tunel', callWin() !== dead && dead.isDestroyed() && (await settle('/t/456')) === '/t/456' && (await route()) === 'tunel', `${urlOf()}, ${await route()}`);
    // Closing the small chat window keeps a running call: the tunnel stays until its popup closes too.
    const call = await popupOf(callWin().webContents);
    callWin().destroy();
    await sleep(300);
    check('zavreté okno chatu: hovor v popupe beží ďalej cez tunel', !!call && !call.isDestroyed() && t.tunnels.size === 1 && (await route()) === 'tunel', `${t.tunnels.size} tunel, ${await route()}`);
    for (const ssh of t.tunnels) ssh.kill();
    for (let i = 0; i < 50 && call && !call.isDestroyed(); i++) await sleep(100);
    check('pád tunela bez okna chatu: popup sa zavrie', !!call && call.isDestroyed());
    if (call && !call.isDestroyed()) call.destroy();
    await sleep(300);
    check('zavretý aj popup: tunel skončí', t.tunnels.size === 0 && (await route()) === 'nikam', `${t.tunnels.size} tunel, ${await route()}`);
    main.destroy();
    await t.callSession('messenger').cookies.flushStore();
  } catch (err) {
    check('self-test dobehol', false, err.stack);
  } finally {
    server.close();
    console.log(fails ? `selftest ${mode}: ${fails} FAIL` : `selftest ${mode}: ok`);
    app.exit(fails ? 1 : 0);
  }
};

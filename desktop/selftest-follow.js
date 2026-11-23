// Self-test of the follow window (main.js) without Instagram or Facebook: SPRAVY_SELFTEST=follow, and
// SPRAVY_SELFTEST=follow-notunnel with SPRAVY_LOGIN_VIA pointing nowhere.
// Local pages stand in for a profile on each network; clicks are real mouse events. Prints PASS/FAIL lines, exits 1 on
// any FAIL. Run under Xvfb with a throwaway profile (overenie/sledovat/selftest.sh does it):
//   XDG_CONFIG_HOME=/tmp/x SPRAVY_URL=http://127.0.0.1:18432/ SPRAVY_SELFTEST=follow SPRAVY_FOLLOW_WAIT=1500 xvfb-run -a electron --no-sandbox desktop
const { app, BrowserWindow } = require('electron');
const http = require('node:http');

module.exports = async function selftestFollow(t) {
  let fails = 0;
  const check = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const port = Number(new URL(t.APP_URL).port);
  const origin = `http://127.0.0.1:${port}`;
  const other = `http://localhost:${port}`;

  // The real rules first.
  const ig = t.FOLLOW_NETS.instagram;
  const fb = t.FOLLOW_NETS.facebook;
  const igHome = (u) => ig.home(new URL(u), 'some.one_1');
  check('Instagram: profil áno (aj bez lomky a inými písmenami)', ['https://www.instagram.com/some.one_1/', 'https://www.instagram.com/some.one_1', 'https://www.instagram.com/Some.One_1/'].every(igHome));
  const igNo = ['https://www.instagram.com/some.one_1/reels/', 'https://www.instagram.com/', 'https://www.instagram.com/explore/', 'https://www.instagram.com/other/', 'https://www.instagram.com.evil.net/some.one_1/', 'http://www.instagram.com/some.one_1/', 'https://instagram.com/some.one_1/'];
  check('Instagram: iná stránka, feed, iný človek, http a podobné meno nie', igNo.every((u) => !igHome(u)), igNo.filter(igHome).join(' '));
  check('Instagram: prihlásenie áno, feed nie', ['https://www.instagram.com/accounts/login/?next=/x/', 'https://www.instagram.com/accounts/onetap/', 'https://www.instagram.com/challenge/1/', 'https://www.facebook.com/login.php'].every((u) => ig.allows(new URL(u)))
    && !ig.allows(new URL('https://www.instagram.com/')) && !ig.allows(new URL('https://www.instagram.com/accounts/edit/')));
  check('Instagram: meno len z písmen, číslic, bodky a podčiarkovníka', ig.valid.test('some.one_1') && !['', '../x', 'a b', 'x/y', 'a'.repeat(31), 'é'].some((x) => ig.valid.test(x)));
  check('Facebook: profil podľa id, iné id a stránky nie', fb.home(new URL('https://www.facebook.com/profile.php?id=4'), '4') && !fb.home(new URL('https://www.facebook.com/profile.php?id=5'), '4')
    && !fb.home(new URL('https://www.facebook.com/'), '4') && !fb.home(new URL('https://www.facebook.com.evil.net/profile.php?id=4'), '4') && fb.valid.test('100012345') && !fb.valid.test('zuck') && fb.aliases === true && !ig.aliases);
  let refused = '';
  try { await t.openFollow('instagram', '../explore'); } catch (err) { refused = err.message; }
  let refused2 = '';
  try { await t.openFollow('twitter', 'x'); } catch (err) { refused2 = err.message; }
  check('zlé meno alebo sieť: odmietnuté, žiadne okno', !!refused && !!refused2 && !t.follows.size, `${refused} | ${refused2}`);

  // Stand-ins: Instagram on 127.0.0.1, Facebook on localhost (two origins, like two networks).
  const hits = [];
  const page = (body) => `<!doctype html><meta charset="utf-8"><title>test</title><body style="margin:0;font:14px sans-serif">${body}</body>`;
  const igProfile = (user, button = true) => page(`
    <nav style="position:fixed;left:0;top:0;width:60px;height:100%"><a id="explore" href="/explore/">Explore</a><a href="/reels/">Reels</a></nav>
    <main style="margin-left:70px"><header style="padding:16px">
      <img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="60" height="60"><h2>${user}</h2>
      <div id="row"></div><button id="msg">Message</button><button aria-label="Options">…</button>
    </header>
    <div id="posts">${Array.from({ length: 12 }, (_, i) => `<a class="post" href="/p/${i}/" style="display:inline-block;width:100px;height:100px;background:#888;margin:2px">post</a>`).join('')}</div></main>
    <script>
      window.alive = 1;
      const draw = (text) => {
        const b = document.createElement('button');
        b.id = 'follow'; b.innerHTML = '<div>' + text + '</div>';
        b.style.cssText = 'width:120px;height:32px';
        b.addEventListener('click', () => {
          if (b.textContent === 'Follow') { fetch('/hit?followed=${user}'); draw('Following'); return; }
          const d = document.createElement('div'); d.setAttribute('role', 'dialog');
          d.style.cssText = 'position:fixed;left:20px;top:200px;width:300px;height:120px;background:#fff';
          d.innerHTML = '<p>Unfollow?</p><button id="unfollow">Unfollow</button>';
          document.body.append(d);
        });
        document.getElementById('row').replaceChildren(b);
      };
      // The button comes late, and the page draws it again (a new element, like React) a moment later.
      ${button ? "setTimeout(() => draw('Follow'), 600); setTimeout(() => { if (!document.querySelector('#follow').textContent.includes('Following')) draw('Follow'); }, 1500);" : ''}
    </script>`);
  const server = http.createServer((q, r) => {
    const u = new URL(q.url, origin);
    const host = q.headers.host?.startsWith('localhost') ? 'fb' : 'ig';
    hits.push(`${host}${u.pathname}${u.search}`);
    if (u.pathname === '/hit') return r.end('');
    r.setHeader('content-type', 'text/html; charset=utf-8');
    if (host === 'fb') {
      if (u.pathname === '/profile.php') { r.writeHead(302, { location: `/vanity${u.searchParams.get('id')}` }); return r.end(); }
      if (/^\/vanity\d+$/.test(u.pathname)) {
        return r.end(page(`<div role="banner"><a href="/">Facebook</a></div><div role="main"><h1>Test Person</h1>
          <div role="button" aria-label="Add friend" tabindex="0" style="width:120px;height:32px;background:#08f" onclick="fetch('/hit?friend=1');this.setAttribute('aria-label','Cancel request')"><span>Add friend</span></div>
          <div role="button" aria-label="Message" style="width:120px;height:32px">Message</div><div id="feed" style="height:2000px">feed</div></div>`));
      }
      return r.end(page(u.pathname));
    }
    // Signed out, the profile sends the window to sign in; the sign-in page then lets the network go to its feed.
    if (u.pathname === '/signin/' && !/weftsignedin=1/.test(q.headers.cookie || '')) { r.writeHead(302, { location: '/accounts/login/?next=/signin/' }); return r.end(); }
    if (u.pathname === '/accounts/login/') return r.end(page(`<form><input id="user" style="width:200px"><button id="go" type="button" onclick="document.cookie='weftsignedin=1; Path=/'; location.href='/'">Log in</button></form>`));
    if (u.pathname === '/tester/' || u.pathname === '/signin/') return r.end(igProfile(u.pathname.slice(1, -1)));
    if (u.pathname === '/nobutton/') return r.end(igProfile('nobutton', false));
    return r.end(page(`other page ${u.pathname}`));
  });
  await new Promise((res) => server.listen(port, '127.0.0.1', res));
  // localhost may be ::1 first: Chromium tries both, the stand-in answers only on 127.0.0.1, so localhost goes there too.
  t.FOLLOW_NETS.instagram = { ...ig, url: (who) => `${origin}/${who}/`,
    home: (u, who) => u.origin === origin && u.pathname.replace(/\/$/, '').toLowerCase() === `/${who.toLowerCase()}`,
    allows: (u) => u.origin === origin && /^\/accounts\/login(\/|$)/.test(u.pathname) };
  t.FOLLOW_NETS.facebook = { ...fb, url: (who) => `${other}/profile.php?id=${who}`,
    home: (u, who) => u.origin === other && u.pathname === '/profile.php' && u.searchParams.get('id') === who,
    allows: (u) => u.origin === other && u.pathname === '/login.php' };

  const win = (network) => t.follows.get(network)?.win;
  const wc = (network) => win(network).webContents;
  const run = (network, code) => wc(network).executeJavaScript(code, true);
  const pathOf = (network) => { try { const u = new URL(wc(network).getURL()); return u.protocol === 'data:' ? 'data:' : u.pathname; } catch { return ''; } };
  const until = async (fn, ms = 10000) => { for (let i = 0; i < ms / 100; i++) { try { if (await fn()) return true; } catch {} await sleep(100); } return false; };
  const clickAt = async (network, x, y) => {
    const c = wc(network);
    c.sendInputEvent({ type: 'mouseMove', x, y });
    c.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(60);
    c.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };
  const centre = (network, sel) => run(network, `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const seen = (network, sel) => run(network, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && getComputedStyle(e).visibility === 'visible'; })()`);
  const route = async (s) => {
    const r = await t.callSession(s).resolveProxy('https://www.instagram.com/');
    return /DIRECT/.test(r) ? 'priamo' : /127\.0\.0\.1:9\b/.test(r) ? 'nikam' : /SOCKS/.test(r) ? 'tunel' : r;
  };

  try {
    if (process.env.SPRAVY_SELFTEST === 'follow-notunnel') {
      await t.openFollow('instagram', 'tester');
      await until(() => pathOf('instagram') === 'data:', 15000);
      const text = pathOf('instagram') === 'data:' ? await run('instagram', 'document.body.innerText') : '';
      check('bez tunela: chyba, žiadne priame spojenie', /tunel na asus sa nepodaril/.test(text) && (await route('instagram')) === 'nikam' && !hits.length, `${pathOf('instagram')}, ${await route('instagram')}, ${hits.join(' ')}`);
      return;
    }
    await t.openFollow('instagram', 'tester');
    const up = await until(async () => pathOf('instagram') === '/tester/' && await run('instagram', `!!document.querySelector('[data-weft-button]')`));
    check('Instagram: okno ukáže profil a nájde tlačidlo', up, pathOf('instagram'));
    check('okno ide cez tunel na asus, nikdy priamo', (await route('instagram')) === 'tunel', await route('instagram'));
    check('okno má vlastný názov', win('instagram').getTitle() === 'Sledovať · Instagram', win('instagram').getTitle());
    await sleep(1500); // the page draws the button again
    const marked = await run('instagram', `document.querySelector('#follow').hasAttribute('data-weft-keep')`);
    check('nové tlačidlo po prekreslení stránky je znova to jediné viditeľné', marked);
    const vis = {};
    for (const sel of ['#follow', 'header h2', '#explore', '#msg', '.post', 'header img', 'nav']) vis[sel] = await seen('instagram', sel);
    // SPRAVY_FOLLOW_SHOT=<dir>: what the window shows, for a look.
    const shot = async (network, name) => { if (process.env.SPRAVY_FOLLOW_SHOT) require('node:fs').writeFileSync(`${process.env.SPRAVY_FOLLOW_SHOT}/${name}.png`, (await wc(network).capturePage()).toPNG()); };
    await shot('instagram', 'okno-instagram');
    check('vidno len meno a Sledovať; menu, Správa, príspevky a fotka nie', vis['#follow'] && vis['header h2'] && !vis['#explore'] && !vis['#msg'] && !vis['.post'] && !vis['header img'] && !vis.nav, JSON.stringify(vis));

    // A hidden link takes no click: the window stays on the profile and nothing is asked of the network.
    const post = await centre('instagram', '.post');
    await clickAt('instagram', post.x, post.y);
    await sleep(800);
    check('klik na skrytý príspevok nič neotvorí', pathOf('instagram') === '/tester/' && !hits.some((h) => h.startsWith('ig/p/')), `${pathOf('instagram')} ${hits.filter((h) => h.startsWith('ig/p/')).join(' ')}`);

    const b = await centre('instagram', '#follow');
    await clickAt('instagram', b.x, b.y);
    const followed = await until(() => hits.includes('ig/hit?followed=tester'), 3000);
    await sleep(300);
    check('skutočný klik na Sledovať zasiahne tlačidlo', followed && (await run('instagram', `document.querySelector('#follow').textContent`)) === 'Following' && await seen('instagram', '#follow'));
    const b2 = await centre('instagram', '#follow');
    await clickAt('instagram', b2.x, b2.y);
    await sleep(500);
    check('dialóg siete (Zrušiť sledovanie?) je vidieť', await seen('instagram', '[role=dialog] #unfollow'));

    await run('instagram', `window.alive = 7; location.href = '/explore/'; 0`);
    await sleep(1000);
    check('stránka sa sama nedostane preč z profilu (a ostane, ako bola)', pathOf('instagram') === '/tester/' && (await run('instagram', 'window.alive')) === 7 && !hits.includes('ig/explore/'), `${pathOf('instagram')} alive ${await run('instagram', 'window.alive')}`);
    const tried = [];
    const note = (_e, url) => tried.push(new URL(url).pathname);
    wc('instagram').on('did-navigate-in-page', note);
    await run('instagram', `history.pushState({}, '', '/reels/'); 0`);
    const home = await until(async () => tried.includes('/reels/') && pathOf('instagram') === '/tester/' && await run('instagram', `!!document.querySelector('[data-weft-button]')`));
    wc('instagram').off('did-navigate-in-page', note);
    check('presun v stránke inam: okno sa vráti na profil, zase len s tlačidlom', home, `${tried.join(' → ')}; ${pathOf('instagram')}`);
    const before = BrowserWindow.getAllWindows().length;
    await run('instagram', `window.open('/explore/'); 0`);
    await sleep(800);
    check('nové okno stránka neotvorí', BrowserWindow.getAllWindows().length === before);

    // Another person: the same window turns to them. Without a button the window says so instead of a blank page.
    await t.openFollow('instagram', 'nobutton');
    const noted = await until(async () => pathOf('instagram') === '/nobutton/' && await seen('instagram', '#weft-follow-note'), 6000);
    const noteText = noted ? await run('instagram', `document.querySelector('#weft-follow-note').textContent`) : '';
    check('bez tlačidla: jedno okno, poznámka namiesto prázdnej stránky', noted && t.follows.size === 1 && /nenašiel/.test(noteText) && !(await seen('instagram', '#msg')), noteText);

    // The tunnel falling: the window says so (never goes direct), and the next click builds it again.
    const igWin = win('instagram');
    for (const child of t.tunnels) child.kill();
    const fell = await until(() => pathOf('instagram') === 'data:', 5000);
    const fellText = fell ? await run('instagram', 'document.body.innerText') : '';
    check('tunel spadne: okno ostane a povie to, nikdy priamo', fell && win('instagram') === igWin && /spadlo/.test(fellText) && (await route('instagram')) === 'nikam', `${pathOf('instagram')} ${fellText} ${await route('instagram')}`);

    // Signed out: the sign-in page is whole, and after it the window goes back to the profile (not the feed).
    await t.openFollow('instagram', 'signin');
    const login = await until(() => pathOf('instagram') === '/accounts/login/');
    check('odhlásený: prihlásenie je celé vidieť', login && await seen('instagram', '#user') && await seen('instagram', '#go'));
    const go = await centre('instagram', '#go');
    await clickAt('instagram', go.x, go.y);
    const back = await until(async () => pathOf('instagram') === '/signin/' && await run('instagram', `!!document.querySelector('[data-weft-button]')`));
    check('po prihlásení späť na profil, nie na feed', back && !hits.includes('ig/') , `${pathOf('instagram')} ${hits.filter((h) => h === 'ig/').length}× feed`);

    // Facebook: profile.php?id= goes on to the person's name; that is the profile too.
    await t.openFollow('facebook', '7');
    const fbUp = await until(async () => pathOf('facebook') === '/vanity7' && await run('facebook', `!!document.querySelector('[data-weft-button]')`));
    check('Facebook: id → meno profilu, tlačidlo Pridať priateľa nájdené', fbUp, pathOf('facebook'));
    check('Facebook: okno má vlastný názov a ide cez tunel', win('facebook').getTitle() === 'Pridať priateľa · Facebook' && (await route('messenger')) === 'tunel');
    const fvis = { add: await seen('facebook', '[aria-label="Add friend"]'), name: await seen('facebook', 'h1'), msg: await seen('facebook', '[aria-label="Message"]'), feed: await seen('facebook', '#feed'), top: await seen('facebook', '[role=banner] a') };
    await shot('facebook', 'okno-facebook');
    check('Facebook: vidno len meno a Pridať priateľa', fvis.add && fvis.name && !fvis.msg && !fvis.feed && !fvis.top, JSON.stringify(fvis));
    const f = await centre('facebook', '[aria-label="Add friend"]');
    await clickAt('facebook', f.x, f.y);
    await sleep(800);
    check('Facebook: klik pošle žiadosť (na falošnej stránke) a tlačidlo ostane vidieť', hits.includes('fb/hit?friend=1') && await seen('facebook', '[aria-label="Cancel request"]'));
    await run('facebook', `location.href = '/vanity8'; 0`);
    await sleep(1000);
    check('Facebook: po kliknutí iný profil nie', pathOf('facebook') === '/vanity7' && !hits.includes('fb/vanity8'), pathOf('facebook'));

    // Closing: the window goes, and the way out of the call windows signs it out too.
    win('facebook').close();
    await until(() => !t.follows.has('facebook'));
    await t.forgetCalls();
    await sleep(300);
    check('zavretie a „Odhlásiť okno hovorov“ zavrú okno', !t.follows.has('facebook') && !t.callWindows('instagram').length && !t.callWindows('messenger').length);
  } catch (err) {
    check('beh testu', false, err.stack);
  } finally {
    server.close();
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
    console.log(fails ? `FAILED ${fails}` : 'ALL PASS');
    app.exit(fails ? 1 : 0);
  }
};

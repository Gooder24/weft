// Desktop shell for Karchi's messages app (served by asus) with Beeper-style login windows.
//
// The web app cannot read another site's cookies, so for chat accounts it asks this shell
// (window.desktop.collect) to open the service's real login page in its own window. The user
// logs in there as usual; once the page reaches its logged-in URL, the shell reads the values
// the bridge asked for (cookies, local storage, request headers) and hands them back to the
// app, which passes them to the bridge. Passwords never leave the login page.
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');

// The Weft server: SPRAVY_URL, else the first line of ~/.config/weft/url; without a valid one the app says so and quits.
function appUrl() {
  if (process.env.SPRAVY_URL) return process.env.SPRAVY_URL;
  try {
    const saved = fs.readFileSync(path.join(os.homedir(), '.config/weft/url'), 'utf8').split('\n')[0].trim();
    if (saved) return saved;
  } catch {}
  return '';
}
const APP_ORIGIN = (() => { try { const u = new URL(appUrl()); return /^https?:$/.test(u.protocol) ? u.origin : ''; } catch { return ''; } })();
const APP_URL = APP_ORIGIN ? appUrl() : '';
// A plain Chrome user agent: "Electron" in it would mark the login as unusual.
const CHROME_UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

// The name stays: it picks the profile folder (the login) and the window class the launcher matches.
app.setName('Správy');

let main = null;
let pending = null; // the one login window that may be open: { win, reject }

// Login windows go out through asus (an SSH SOCKS tunnel): the bridges run on asus, so Meta sees the login come from
// where the session is used. SPRAVY_LOGIN_VIA= (empty) turns it off; without the tunnel the window goes direct.
const LOGIN_VIA = process.env.SPRAVY_LOGIN_VIA ?? 'asus';
const tunnels = new Set(); // ssh children of open login windows, stopped when the app quits

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer().once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const accepts = (port) => new Promise((resolve) => {
  const c = net.connect(port, '127.0.0.1', () => { c.destroy(); resolve(true); }).once('error', () => resolve(false));
});

/** Starts one login window's tunnel; resolves with its proxy rules ('' when it cannot come up) and its stop.
 *  `lost` runs when an established tunnel ends by itself (ssh died, asus gone), never after its stop. */
async function openTunnel(lost = () => {}) {
  if (!LOGIN_VIA) return { proxy: '', close() {} };
  const port = await freePort();
  const child = spawn('ssh', ['-N', '-D', `127.0.0.1:${port}`, '-o', 'ExitOnForwardFailure=yes', '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', LOGIN_VIA], { stdio: 'ignore' });
  tunnels.add(child);
  let gone = false;
  let up = false;
  let stopped = false;
  child.once('exit', () => { gone = true; tunnels.delete(child); if (up && !stopped) lost(); });
  const close = () => { stopped = true; if (child.exitCode === null) child.kill(); tunnels.delete(child); };
  for (let i = 0; i < 40 && !gone; i++) {
    if (await accepts(port)) { up = true; return { proxy: `socks5://127.0.0.1:${port}`, close }; }
    await new Promise((r) => setTimeout(r, 250));
  }
  close();
  return { proxy: '', close() {} };
}
app.on('will-quit', () => { for (const child of tunnels) child.kill(); });

function openMain() {
  main = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Weft',
    autoHideMenuBar: true,
    // Behind other windows it still hears of codes at once (Chromium would slow a hidden window's timers).
    webPreferences: { preload: path.join(__dirname, 'preload.js'), partition: 'persist:app', contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  main.loadURL(APP_URL);
  main.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && !input.alt && !input.shift && input.key.toLowerCase() === 'q') {
      event.preventDefault();
      app.quit();
    }
  });
  // Links in messages open in the normal browser; the app window only ever shows the app.
  main.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  main.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== APP_ORIGIN) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  // Closing the window (Super+W, ✕) quits Weft with its call, follow and login windows, like Ctrl+Q.
  main.on('closed', () => { main = null; if (!process.env.SPRAVY_SELFTEST) app.quit(); });
}

/**
 * Makes a login window report one consistent browser: the user agent the bridge asked for, and
 * client hints (headers and navigator.userAgentData) of the same Chrome version. Electron's own
 * setUserAgent changes only the string, so sites saw "Chrome 141" next to Electron's Chromium
 * brands, which looks like a bot and ends in endless captchas.
 */
async function presentAs(contents, userAgent) {
  const full = /Chrome\/([\d.]+)/.exec(userAgent)?.[1] || process.versions.chrome;
  const major = full.split('.')[0];
  const override = {
    userAgent,
    platform: 'Linux x86_64',
    userAgentMetadata: {
      brands: [{ brand: 'Google Chrome', version: major }, { brand: 'Not?A_Brand', version: '8' }, { brand: 'Chromium', version: major }],
      fullVersionList: [{ brand: 'Google Chrome', version: full }, { brand: 'Not?A_Brand', version: '8.0.0.0' }, { brand: 'Chromium', version: full }],
      fullVersion: full, platform: 'Linux', platformVersion: /^[\d.]+/.exec(os.release())?.[0] || '', architecture: 'x86', model: '', mobile: false, bitness: '64', wow64: false,
    },
  };
  const dbg = contents.debugger;
  const send = (method, params, session) => dbg.sendCommand(method, params, session).catch(() => {});
  const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
  try {
    dbg.attach('1.3');
  } catch {
    return; // already attached or gone: the session user agent still applies
  }
  // Frames of other sites (the captcha) run in their own process: each gets the same identity
  // before its scripts start.
  dbg.on('message', (event, method, params) => {
    if (method !== 'Target.attachedToTarget') return;
    const id = params.sessionId;
    send('Emulation.setUserAgentOverride', override, id)
      .then(() => send('Target.setAutoAttach', autoAttach, id))
      .then(() => send('Runtime.runIfWaitingForDebugger', {}, id));
  });
  await send('Target.setAutoAttach', autoAttach);
  await send('Emulation.setUserAgentOverride', override);
}

// Where each login window went (host and path, no query) and which fields it had, never values.
const LOGIN_LOG = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'spravy', 'login.log');
function logLogin(line) {
  try {
    fs.mkdirSync(path.dirname(LOGIN_LOG), { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOGIN_LOG, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {}
}

// Pages that come before the login is complete: never take cookies there. Instagram asks for its checks
// ("confirm your phone or email", update_risky_contactpoint, …) under /accounts/; only the "save your login
// info" page there (onetap) comes after them. Cookies taken on a check page get "challenge required".
const NOT_YET = /\/(checkpoint|two_step_verification|two_factor|challenge|captcha|recover|suspended|auth_platform|confirmemail)|^\/(login(\.php)?|accounts\/login)\/?$|^\/accounts\/(?!onetap(\/|$))/;

// Cookies that only say "this device was here before"; they cannot sign anybody in.
const DEVICE_COOKIES = new Set(['datr', 'sb', 'mid', 'ig_did']);

/** Drops everything a login window collected except the device IDs: the session belongs to the bridge. */
async function forgetSession(ses) {
  await ses.clearStorageData({ storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql', 'filesystem', 'shadercache'] });
  for (const c of await ses.cookies.get({})) {
    if (DEVICE_COOKIES.has(c.name)) continue;
    const host = c.domain.replace(/^\./, '');
    await ses.cookies.remove(`http${c.secure ? 's' : ''}://${host}${c.path || '/'}`, c.name).catch(() => {});
  }
  await ses.cookies.flushStore();
}

/** Reads one field from the first source that has a value. */
async function readField(field, ses, win, headers) {
  for (const source of field.sources || []) {
    if (source.type === 'cookie') {
      const domain = (source.cookie_domain || '').replace(/^\./, '');
      const found = (await ses.cookies.get({ name: source.name })).find((c) => !domain || c.domain.replace(/^\./, '').endsWith(domain));
      if (found?.value) return found.value;
    } else if (source.type === 'local_storage') {
      const value = await win.webContents.executeJavaScript(`localStorage.getItem(${JSON.stringify(source.name)})`).catch(() => null);
      if (value) return value;
    } else if (source.type === 'request_header' && headers.has(field.id)) {
      return headers.get(field.id);
    }
  }
  return '';
}

/** Opens the login page described by a bridge cookie step and resolves with the collected fields. */
function collect(spec) {
  if (pending) {
    if (!pending.win.isDestroyed()) pending.win.focus();
    return Promise.reject(new Error('Jedno prihlasovacie okno už je otvorené.'));
  }
  // One profile per service that keeps only device IDs between attempts, as a normal browser does:
  // a brand-new device on every try makes Instagram and Facebook distrust the login even more.
  const ses = session.fromPartition(`persist:login-${new URL(spec.url).host}`);
  const userAgent = spec.user_agent || CHROME_UA;
  ses.setUserAgent(userAgent);
  const fields = spec.fields || [];
  const headers = new Map();
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    for (const field of fields) {
      for (const source of field.sources || []) {
        if (source.type !== 'request_header') continue;
        if (source.request_url_regex && !new RegExp(source.request_url_regex).test(details.url)) continue;
        const name = Object.keys(details.requestHeaders).find((k) => k.toLowerCase() === source.name.toLowerCase());
        if (name && details.requestHeaders[name]) headers.set(field.id, details.requestHeaders[name]);
      }
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  // Failed requests go to the log (host, path and status, never a query or a value): a check page that ends in
  // "Your request couldn't be processed" shows there what it could not load.
  const failed = new Set();
  const noteFail = (url, what) => {
    let u;
    try { u = new URL(url); } catch { return; }
    const key = `${u.host}${u.pathname} ${what}`;
    if (failed.size >= 80 || failed.has(key)) return;
    failed.add(key);
    logLogin(`fail ${key}`);
  };
  ses.webRequest.onCompleted((d) => { if (d.statusCode >= 400) noteFail(d.url, d.statusCode); });
  ses.webRequest.onErrorOccurred((d) => { if (d.error !== 'net::ERR_ABORTED') noteFail(d.url, d.error); });
  const win = new BrowserWindow({
    width: 560,
    height: 780,
    title: spec.title || 'Prihlásenie',
    autoHideMenuBar: true,
    show: !spec.hidden,
    webPreferences: { session: ses, contextIsolation: true, sandbox: true },
  });
  // Login pages open their own popups (e.g. "log in with Google"): keep them in this session.
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { session: ses } } }));
  win.webContents.on('did-create-window', (child) => {
    presentAs(child.webContents, userAgent);
    child.webContents.on('did-navigate', (_e, url) => { try { const u = new URL(url); logLogin(`popup ${u.host}${u.pathname}`); } catch {} });
  });
  const home = new URL(spec.url).host;
  logLogin(`start ${home}`);

  return new Promise((resolve, reject) => {
    pending = { win, reject };
    let finished = false;
    let closeTunnel = () => {}; // this window's tunnel, once it is up
    let settled = 0; // consecutive checks with every field set on a page after the login
    let lastLog = '';
    const finish = (error, values) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (!win.isDestroyed()) win.destroy();
      // The next window for this service may open only once the session is gone from the profile.
      closeTunnel();
      closeTunnel = () => {};
      ses.setProxy({ mode: 'direct' }).catch(() => {});
      forgetSession(ses).catch(() => {}).finally(() => {
        pending = null;
        if (error) reject(error);
        else resolve(values);
      });
    };
    const check = async (closing) => {
      if (finished || win.isDestroyed()) return;
      const url = win.webContents.getURL();
      const atTarget = !spec.wait_for_url_pattern || new RegExp(spec.wait_for_url_pattern).test(url);
      const values = {};
      for (const field of fields) {
        const value = await readField(field, ses, win, headers);
        if (value) values[field.id] = value;
      }
      const missing = fields.filter((f) => f.required && !values[f.id]);
      let where = '';
      try { const u = new URL(url); where = `${u.host}${u.pathname}`; } catch {}
      const note = `${where} ${fields.map((f) => `${f.id}=${values[f.id] ? 1 : 0}`).join(' ')}`;
      if (note !== lastLog) logLogin((lastLog = note));
      // Interstitials such as "save your login info" sit after the login but off the bridge's pattern.
      const checking = where.startsWith(`${home}/`) && NOT_YET.test(where.slice(home.length));
      const afterLogin = !missing.length && where.startsWith(`${home}/`) && !checking;
      settled = afterLogin ? settled + 1 : 0;
      if (!missing.length && !checking && (atTarget || closing || settled >= 2)) { logLogin(`done ${where}`); finish(null, values); }
      else if (closing && checking && !missing.length) finish(new Error('Okno sa zavrelo počas overenia. Skús znova a overenie v okne dokonči, okno sa potom zavrie samo.'));
      else if (closing) finish(new Error('Okno sa zavrelo skôr, než bolo prihlásenie hotové.'));
    };
    const timer = setInterval(() => check(false), 1500);
    win.webContents.on('did-navigate', () => check(false));
    win.webContents.on('did-navigate-in-page', () => check(false));
    // The title shows where the page is, so a login stuck on a checkpoint page is easy to spot.
    win.on('page-title-updated', (event) => {
      event.preventDefault();
      const { host, pathname } = new URL(win.webContents.getURL() || spec.url);
      win.setTitle(`${spec.title || 'Prihlásenie'} · ${host}${pathname}`);
    });
    // A page that closes its own window (window.close()) skips the 'close' event below.
    win.webContents.on('destroyed', () => {
      if (finished) return;
      logLogin('the page closed the window');
      finish(new Error('Stránka prihlasovacie okno zavrela sama. Skús to znova.'));
    });
    win.on('close', (event) => {
      if (finished) return;
      logLogin('closed by hand');
      event.preventDefault();
      check(true).then(() => finish(new Error('Okno sa zavrelo skôr, než bolo prihlásenie hotové.')));
    });
    openTunnel()
      .then(({ proxy, close }) => { closeTunnel = close; if (finished) { close(); throw new Error('closed'); } logLogin(proxy ? `via ${LOGIN_VIA}` : 'direct'); return ses.setProxy(proxy ? { proxyRules: proxy } : { mode: 'direct' }); })
      .then(() => Promise.all((spec.initial_cookies || []).map((c) => ses.cookies.set({
      url: `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`,
      name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.http_only,
    }))))
      .then(() => { if (finished) throw new Error('closed'); return win.loadURL('about:blank'); }) // the identity can only be set once the window has a page
      .then(() => presentAs(win.webContents, userAgent))
      .then(() => win.loadURL(spec.url, { userAgent }))
      .catch(() => {}); // aborted when the window closes early
  });
}

// ------------------------------------------------------------------ call windows
//
// Weft cannot carry a call itself: the bridges only write that one happened (HOVORY-PLAN.md). A call window is the
// network's own web in a window of this shell, locked to one chat and its call, with its own login (never the
// bridge's: Meta ends a session used from two places). Karchi signs in there himself once; the profile stays until
// Settings → Účty → „Odhlásiť okno hovorov“ (forgetCalls). It goes out through asus like the login windows, as
// x270 blocks facebook.com, and never directly: without the tunnel it shows why. Messenger and Instagram; Discord in
// beta (the app sends it here only when Karchi switched it on), where the window also presses the call button for
// him; WhatsApp Web and Teams stay in the browser (HOVORY-PLAN.md, „Stav“).
// Each network: exact origins for camera and microphone (never a pattern: messenger.com.evil.net or http:// must not
// pass), the chat's address, `chatId(u)` (the chat a page shows, or null), `allows(u)` for the other pages the
// window may stay on (the call, signing in), `passes(u)` for pages signing in may go through but the window never stays on (the start page: the
// list of every chat, Instagram's feed), and `popup` for what a page may open in a new window (only the call).
// `autoCall` (Discord) names the call button the window presses once the chat is there; `width` is the window's;
// `popups: false` refuses every new window, `aliases: false` every other chat id the network redirects to.
const META_AUTH = (u) => u.origin === 'https://www.facebook.com'
  && /^\/(login|checkpoint|two_step_verification|two_factor|auth_platform|recover)(\/|\.php|$)/.test(u.pathname);
const CALL_NETS = {
  messenger: {
    name: 'Messenger',
    media: ['https://www.messenger.com'],
    chat: (id) => `https://www.messenger.com/t/${id}`,
    chatId: (u) => (u.origin === 'https://www.messenger.com' && /^\/(?:e2ee\/)?t\/(\d+)\/?$/.exec(u.pathname)?.[1]) || null,
    allows: (u) => META_AUTH(u) || (u.origin === 'https://www.messenger.com' && /^\/(groupcall|login|checkpoint|two_step_verification|two_factor)(\/|\.php|$)/.test(u.pathname)),
    passes: (u) => u.origin === 'https://www.messenger.com' && u.pathname === '/',
    popup: (u) => u.origin === 'https://www.messenger.com' && /^\/groupcall(\/|$)/.test(u.pathname),
  },
  instagram: {
    name: 'Instagram',
    media: ['https://www.instagram.com'],
    chat: (id) => `https://www.instagram.com/direct/t/${id}/`,
    chatId: (u) => (u.origin === 'https://www.instagram.com' && /^\/direct\/t\/(\d+)\/?$/.exec(u.pathname)?.[1]) || null,
    // The call's own page (/call/) is a guess until the first real call; a refused one shows in login.log.
    allows: (u) => META_AUTH(u) || (u.origin === 'https://www.instagram.com' && /^\/(call|accounts\/(login|onetap|two_factor)|challenge|two_factor|auth_platform)(\/|$)/.test(u.pathname)),
    passes: (u) => u.origin === 'https://www.instagram.com' && /^\/(direct\/inbox\/?)?$/.test(u.pathname),
    popup: (u) => u.origin === 'https://www.instagram.com' && /^\/call(\/|$)/.test(u.pathname),
  },
  // A DM or group DM; its call runs in the page. A message link in the same DM (/<channel>/<message>) is the chat too.
  discord: {
    name: 'Discord',
    beta: true,
    width: 940, // narrower, Discord folds the call buttons away
    media: ['https://discord.com'],
    chat: (id) => `https://discord.com/channels/@me/${id}`,
    chatId: (u) => (u.origin === 'https://discord.com' && /^\/channels\/@me\/(\d{1,20})(?:\/\d{1,20})?\/?$/.exec(u.pathname)?.[1]) || null,
    allows: (u) => u.origin === 'https://discord.com' && /^\/login\/?$/.test(u.pathname),
    passes: (u) => u.origin === 'https://discord.com' && /^\/(app|channels\/@me)?\/?$/.test(u.pathname),
    popup: () => false,
    popups: false, // not even an empty one
    aliases: false, // a DM keeps its id: a redirect to another DM is another person
    // Its label in the languages Discord's web may speak to Karchi; one it lacks shows in login.log.
    // `wait`: from the click (the tunnel and Discord's page take their seconds first).
    autoCall: { labels: ['Start Voice Call', 'Zahájit hlasový hovor', 'Sprachanruf starten'], wait: 30000 },
  },
};
// network -> { win, id, aliases, ownLoad, bounces, bounceAt, ready, dead }: `aliases` are other ids the network itself redirected the
// window's own load of the chat to (an encrypted Messenger chat, Instagram's shorter id); `ownLoad` is true while
// the window loads the chat itself; `callWanted` stands for the click whose call the window still has to press
// (autoCall networks only).
const calls = new Map();
const callSession = (network) => session.fromPartition(`persist:call-${network}`);
const lockedSessions = new Map(); // session -> network, for the call windows' sessions in use

/** Only the app's own top frame in the main window may open a call window: the origin alone does not tell a frame
 *  the app embeds from the app itself. */
const fromApp = (event) => !!main && event.sender === main.webContents && !event.senderFrame?.parent && event.senderFrame?.origin === APP_ORIGIN;

function lockSession(network) {
  const ses = callSession(network);
  if (ses.weftLocked) return ses;
  ses.weftLocked = true;
  lockedSessions.set(ses, network);
  ses.setUserAgent(CHROME_UA);
  ses.setProxy(callProxy(NO_ROUTE)).catch(() => {});
  // Camera and microphone (and fullscreen for video) only for the network's own pages, decided by the address of the
  // frame that asks; a request without one is refused. Everything else (notifications, location, screen) is refused.
  const may = (url, permission) => {
    if (!['media', 'fullscreen'].includes(permission) || !url) return false;
    try { return CALL_NETS[network].media.includes(new URL(url).origin); } catch { return false; }
  };
  ses.setPermissionRequestHandler((_contents, permission, done, details) => {
    const ok = may(details?.requestingUrl, permission);
    // A refused request goes to the login log (origin only): the first real call shows a frame the list lacks.
    if (!ok) { try { logLogin(`call ${network} refused permission ${permission} for ${new URL(details.requestingUrl).origin}`); } catch {} }
    done(ok);
  });
  ses.setPermissionCheckHandler((_contents, permission, origin) => may(origin, permission));
  return ses;
}

/** Keeps a call window (and every popup it opens) on its chat: any other page sends the main window back to the chat
 *  and closes a popup. In-page moves (another chat picked in the page) count too. */
/** The window loads its chat itself: a redirect of this load to another address of a chat is the same chat. */
function loadChat(contents, net, entry, options) {
  entry.ownLoad = true;
  return contents.loadURL(net.chat(entry.id), options).catch(() => {});
}

function lockContents(contents, network, entry, popup) {
  const net = CALL_NETS[network];
  const chatOf = (url) => { try { return net.chatId(new URL(url)); } catch { return null; } };
  const ours = (url) => { const id = chatOf(url); return !!id && (id === entry.id || entry.aliases.has(id)); };
  const atChat = () => ours(contents.getURL());
  // The window's own places: its chat, or its call running in the window itself.
  const atHome = () => atChat() || test(contents.getURL(), net.popup);
  const test = (url, rule) => { try { return rule(new URL(url)); } catch { return false; } };
  // A popup is only the call: it never stays on a chat or a login, and never passes a start page.
  const stays = (url) => url === 'about:blank' || (popup ? test(url, net.popup) : ours(url) || test(url, net.allows));
  // Only on the way in (the window's own load of its chat, or a login page): from the chat or its call the start
  // page is refused like any other, also while the window's own load of another chat is still pending.
  const onTheWayIn = (own) => {
    const at = contents.getURL();
    return own || !at || at === 'about:blank' || (test(at, net.allows) && !test(at, net.popup));
  };
  const passes = (url, own = false) => !popup && onTheWayIn(own) && test(url, net.passes);
  const toChat = (inPage) => {
    if (popup) { contents.close(); return; }
    // A link refused before it left keeps the page as it was (a draft, a call in the page).
    if (!inPage && atHome()) return;
    // A page that keeps going elsewhere (a redirect loop: many returns a second, not a few clicks) gets an
    // explanation instead of an endless reload.
    entry.bounces = Date.now() - entry.bounceAt < 10000 ? entry.bounces + 1 : 1;
    entry.bounceAt = Date.now();
    if (entry.bounces > 10) { showCallError(contents, `${net.name} stále odchádza z chatu. Zavri okno hovoru a skús znova.`); return; }
    // A move inside the page (another chat clicked in its list) goes back without a reload, which would end a call
    // running in the page.
    const h = contents.navigationHistory;
    const prev = inPage && h.canGoBack() ? h.getEntryAtIndex(h.getActiveIndex() - 1) : null;
    if (prev && (ours(prev.url) || test(prev.url, net.popup))) h.goBack();
    else loadChat(contents, net, entry);
  };
  const refuse = (url, inPage = false) => {
    // What a call window refused goes to the login log (host and path only): the first real login shows which page
    // the list still lacks.
    try { const u = new URL(url); logLogin(`call ${network} refused ${u.host}${u.pathname}`); } catch {}
    // The page tried to go elsewhere (another DM picked in the page): what it shows may not follow the address put
    // back, so this click calls nobody; Karchi calls in the window himself.
    if (!popup && entry.callWanted) { entry.callWanted = null; logLogin(`call ${network} the page left the chat: no call for this click`); }
    toChat(inPage);
  };
  contents.on('will-navigate', (event, url) => { if (!stays(url) && !passes(url)) { event.preventDefault(); refuse(url); } });
  // The address each step of a main-frame load is at, redirects included.
  let hop = '';
  // Whether the main-frame load under way is the window's own load of its chat (not a page's link).
  let ownNav = false;
  // A main-frame load not yet committed: a click on the chat still on screen cancels it (openCall).
  contents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    hop = url;
    signingIn(url); // also a sign-in that never commits (an answer without a page)
    if (popup) return;
    entry.pending = url;
    ownNav = entry.ownLoad && chatOf(url) === entry.id;
  });
  contents.on('did-stop-loading', () => { if (!popup) entry.pending = null; });
  // Karchi pressing anything in the window himself (mouse, a key, touch), also while the page still loads, ends the
  // click's call: he is calling, or doing something else, himself. The window's own presses are counted out.
  if (!popup) contents.on('input-event', (_event, input) => {
    if (input.type === 'mouseDown') {
      const own = ownPresses.get(contents) || 0;
      if (own) { ownPresses.set(contents, own - 1); return; }
    } else if (!['rawKeyDown', 'keyDown', 'touchStart', 'gestureTapDown'].includes(input.type)) return;
    if (entry.callWanted) { entry.callWanted = null; logLogin(`call ${network} pressed in the window by hand: no call for this click`); }
  });
  contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
    if (!isMainFrame) return;
    const from = hop;
    hop = url;
    // The network's own server sending the window's load of its chat straight on to another address of a chat is
    // the same chat under another id (a click is never a redirect, and a detour through other pages does not count).
    signingIn(url); // a sign-in on the way, even one the server sends straight back to the DM
    const id = chatOf(url);
    if (!popup && net.aliases !== false && ownNav && id && !ours(url) && ours(from)) { entry.aliases.add(id); logLogin(`call ${network} chat also ${id}`); return; }
    if (!stays(url) && !passes(url, ownNav)) { event.preventDefault(); hop = from; refuse(url); }
  });
  // A page the window passes through is left for the chat as soon as it is there.
  // Signing in (Discord's SPA moves to /login in the page): the click's call waits for no login; Karchi calls himself.
  const signingIn = (url) => {
    if (popup || !entry.callWanted || ours(url) || !test(url, net.allows) || test(url, net.popup)) return;
    entry.callWanted = null;
    logLogin(`call ${network} signing in: no call for this click`);
  };
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    signingIn(url);
    if (!stays(url)) refuse(url, true);
  });
  // Back and forward in the history skip will-navigate: a page they bring that is not allowed goes too. The window's
  // own explanation page (data:) is not the network's.
  contents.on('did-navigate', (_event, url) => {
    if (!popup) { entry.ownLoad = false; entry.pending = null; }
    // Once the chat is there, the history before it goes: back never shows an earlier chat or the start page.
    if (!popup && ours(url)) { contents.navigationHistory.clear(); entry.shownChat = entry.id; entry.shownAliases = new Set(entry.aliases); }
    signingIn(url);
    // The empty page is only the window's own start: once a chat was shown, the page blanking itself goes back.
    if (!popup && url === 'about:blank' && entry.shownChat) { refuse(url); return; }
    if (url.startsWith('data:') || stays(url)) return;
    if (test(url, net.passes) && !popup) toChat(false);
    else refuse(url);
  });
  contents.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => { if (isMainFrame && !popup) { entry.ownLoad = false; entry.pending = null; } });
  contents.setWindowOpenHandler(({ url }) => {
    let u = null;
    try { u = new URL(url); } catch {}
    const may = !!u && net.popups !== false && (url === 'about:blank' || net.popup(u));
    if (!may) { try { logLogin(`call ${network} refused popup ${u.host}${u.pathname}`); } catch {} }
    return may
      // outlivesOpener: closing the small chat window must not end a call running in its popup.
      ? { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { session: callSession(network), contextIsolation: true, sandbox: true } } }
      : { action: 'deny' };
  });
  contents.on('did-create-window', (child) => {
    presentAs(child.webContents, CHROME_UA);
    lockContents(child.webContents, network, entry, true);
  });
}

/** A cursor's way from `from` to `to`: a bent path (a cubic Bézier with random control points), slow at both ends,
 *  14–30 points inside the w×h window, the last exactly on `to`, each with its own pause in ms. */
function cursorPath(from, to, w, h, rand = Math.random) {
  const steps = 14 + Math.floor(rand() * 17);
  const dx = to.x - from.x, dy = to.y - from.y;
  const bend = () => (rand() - 0.5) * 0.6;
  const c1 = { x: from.x + dx * 0.3 + dy * bend(), y: from.y + dy * 0.3 - dx * bend() };
  const c2 = { x: from.x + dx * 0.7 + dy * bend(), y: from.y + dy * 0.7 - dx * bend() };
  const clamp = (v, max) => Math.min(max - 1, Math.max(0, Math.round(v)));
  const points = [];
  for (let i = 1; i <= steps; i++) {
    const s = i / steps;
    const t = s < 0.5 ? 2 * s * s : 1 - (-2 * s + 2) ** 2 / 2;
    const u = 1 - t;
    const at = (a, b, c, d) => u ** 3 * a + 3 * u * u * t * b + 3 * u * t * t * c + t ** 3 * d;
    points.push({ x: clamp(at(from.x, c1.x, c2.x, to.x), w), y: clamp(at(from.y, c1.y, c2.y, to.y), h), wait: 6 + Math.floor(rand() * 14) });
  }
  points[points.length - 1] = { ...points[points.length - 1], x: to.x, y: to.y };
  return points;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// webContents -> presses the window itself sent and the page has not seen yet (every other press is Karchi's).
const ownPresses = new WeakMap();
/** Moves the cursor into the window and clicks a random point of `box` like a hand would; `still(point, release)` is
 *  asked right before the press and again before the release (the page may have gone elsewhere, or moved the button,
 *  meanwhile). A press no longer wanted is released outside the page, which makes no click. */
async function humanClick(win, box, still) {
  const [w, h] = win.getContentSize();
  const r = Math.random;
  const to = { x: Math.round(box.x + box.w * (0.3 + 0.4 * r())), y: Math.round(box.y + box.h * (0.3 + 0.4 * r())) };
  const from = { x: Math.round(w * (0.2 + 0.6 * r())), y: Math.round(h * (0.55 + 0.4 * r())) };
  for (const p of cursorPath(from, to, w, h, r)) {
    if (win.isDestroyed()) return false;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
    await pause(p.wait);
  }
  await pause(60 + Math.floor(r() * 140));
  if (win.isDestroyed() || !(await still(to))) return false;
  ownPresses.set(win.webContents, (ownPresses.get(win.webContents) || 0) + 1);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: to.x, y: to.y, button: 'left', clickCount: 1 });
  await pause(45 + Math.floor(r() * 90));
  if (win.isDestroyed()) return false;
  if (!(await still(to, true))) {
    if (win.isDestroyed()) return false;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: -20, y: -20, button: 'left' });
    win.webContents.sendInputEvent({ type: 'mouseLeave', x: -20, y: -20 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: -20, y: -20, button: 'left', clickCount: 1 });
    return false;
  }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
  return true;
}
// The page's own scripts never see what the window looks up (a world of its own over the same DOM).
const CALL_WORLD = 1077;
// Every button with one of `labels`, enabled (also through a disabled fieldset or an inert parent) and to be seen
// (opacity and filter: opacity(), also through its parents); a hidden copy (display: none) drops out at the box check.
const callButtons = (labels) => `const labels = ${JSON.stringify(labels)};
  const seen = (e) => {
    let o = 1;
    for (let x = e; x; x = x.parentElement) {
      const st = getComputedStyle(x);
      o *= Number(st.opacity);
      for (const m of st.filter.matchAll(/opacity\\(([\\d.]+)(%?)\\)/g)) o *= Number(m[1]) / (m[2] ? 100 : 1);
    }
    return o >= 0.5 && getComputedStyle(e).visibility === 'visible';
  };
  const usable = (e) => !e.matches(':disabled') && !e.closest('[inert], [aria-disabled="true"]');
  const bs = [...document.querySelectorAll('[aria-label]')].filter((e) => labels.includes(e.getAttribute('aria-label')) && usable(e) && seen(e));`;
/** The first such button whole on screen and not covered at its centre: its box, or null. */
const findCallButton = (labels) => `(() => {
  ${callButtons(labels)}
  for (const b of bs) {
    const r = b.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) continue;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit && (hit === b || b.contains(hit))) return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  return null;
})()`;
/** Whether the point (x, y) in CSS pixels is on such a button itself, not on something laid over part of it. */
const onCallButton = (labels, x, y) => `(() => {
  ${callButtons(labels)}
  const hit = document.elementFromPoint(${Number(x)}, ${Number(y)});
  return !!hit && bs.some((b) => hit === b || b.contains(hit));
})()`;
/** Presses the network's call button once its chat is in the window, for the click in Weft that `token` ({ id } of
 *  the chat clicked) stands for. A newer click, another chat, signing in, a closed window or the time running out
 *  end it without pressing anything. */
async function autoCall(network, entry, token) {
  try { await pressCall(network, entry, token); } catch (err) { logLogin(`call ${network} could not press call: ${err.message}`); }
}
async function pressCall(network, entry, token) {
  const net = CALL_NETS[network];
  if (!net.autoCall || !token || entry.callWanted !== token || entry.win.isDestroyed()) return;
  const contents = entry.win.webContents;
  const atChat = () => {
    if (entry.win.isDestroyed() || entry.dead || entry.id !== token.id) return false;
    let at = null;
    try { at = net.chatId(new URL(contents.getURL())); } catch {}
    return at === token.id; // only the chat clicked, never another id the page went on to
  };
  // Counted from the click: a slow tunnel or page never makes a call long after it.
  const until = token.at + net.autoCall.wait;
  const look = (code) => Promise.race([contents.executeJavaScriptInIsolatedWorld(CALL_WORLD, [{ code }]).catch(() => null), pause(3000).then(() => null)]);
  const zoom = () => (entry.win.isDestroyed() ? 1 : contents.getZoomFactor());
  const find = async () => {
    const box = await look(findCallButton(net.autoCall.labels));
    const z = box && zoom();
    return box && { x: box.x * z, y: box.y * z, w: box.w * z, h: box.h * z };
  };
  while (Date.now() < until) {
    await pause(400);
    if (entry.win.isDestroyed() || entry.dead || entry.callWanted !== token) return;
    if (!atChat()) continue;
    // The page's CSS pixels times its zoom (Ctrl+plus) are the window's; a page still loading may not answer at once.
    const box = await find();
    if (!box || entry.callWanted !== token || !atChat()) continue;
    // Right before the press: still this click, this chat, and the button still under the cursor.
    const current = () => entry.callWanted === token && atChat();
    // The point itself must be the button (an overlay may cover part of it), and the click's time not over even
    // once the button is released (mouseUp comes up to 135 ms after the press).
    const inTime = (release) => Date.now() < until - (release ? 0 : 250);
    const still = async (p, release = false) => {
      if (!current() || !inTime(release)) return false;
      const z = zoom();
      const on = await look(onCallButton(net.autoCall.labels, p.x / z, p.y / z));
      return on === true && current() && inTime(release);
    };
    if (await humanClick(entry.win, box, still)) {
      if (entry.callWanted === token) entry.callWanted = null;
      logLogin(`call ${network} pressed the call button`);
      return;
    }
    // The button moved meanwhile: looked up again. Another click or chat: this one is over.
    if (!current()) { logLogin(`call ${network} left before the call button`); return; }
  }
  if (entry.callWanted === token) { entry.callWanted = null; logLogin(`call ${network} found no call button`); }
}

function showCallError(contents, text) {
  const page = `<!doctype html><meta charset="utf-8"><title>Okno hovoru</title><body style="font:14px sans-serif;padding:24px;background:#000a07;color:#f0f0eb">${text.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</body>`;
  contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`).catch(() => {});
}

// While a network's tunnel is not up (starting, failed, fallen) its session goes to a proxy that answers nothing:
// a call window never reaches the network directly.
const NO_ROUTE = 'socks5://127.0.0.1:9';
// `<-loopback>`: the page's requests to localhost go the same way (to asus or nowhere), never to x270's own services.
const callProxy = (rules) => ({ proxyRules: rules, proxyBypassRules: '<-loopback>' });
const callTunnels = new Map(); // network -> { ready: Promise<boolean>, close, lost }
const callWindows = (network) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.session === callSession(network));

/** The network's tunnel, shared by its call window and the call's popup; resolves false when it cannot come up. */
function callTunnel(network) {
  const have = callTunnels.get(network);
  if (have && !have.lost) return have.ready;
  const ses = callSession(network);
  const t = { lost: false, close() {} };
  callTunnels.set(network, t);
  t.ready = ses.setProxy(callProxy(NO_ROUTE))
    .then(() => openTunnel(() => callLost(network, t)))
    .then(async ({ proxy, close }) => {
      t.close = close;
      if (!proxy || t.lost) { t.lost = true; close(); return false; }
      await ses.setProxy(callProxy(proxy));
      return true;
    })
    .catch(() => { t.lost = true; t.close(); return false; }); // the next click tries a new tunnel
  return t.ready;
}
/** A tunnel that falls mid-call leaves the page without its network: the window says so, the popups close, and the
 *  next click builds the window again. */
function callLost(network, t) {
  t.lost = true;
  callSession(network).setProxy(callProxy(NO_ROUTE)).catch(() => {});
  const entry = calls.get(network);
  const chat = entry && !entry.win.isDestroyed() ? entry.win : null;
  // A follow window on this session stays and says so, like the chat window.
  const follow = [...follows].filter(([n, f]) => FOLLOW_NETS[n].session === network && !f.win.isDestroyed()).map(([, f]) => f);
  for (const w of callWindows(network)) if (w !== chat && !follow.some((f) => f.win === w)) w.destroy(); // the call's popups, also without a chat window
  for (const f of follow) { f.dead = true; showCallError(f.win.webContents, 'Spojenie cez asus spadlo, okno prestalo fungovať. Klikni na odkaz vo Wefte znova.'); }
  if (!chat) return;
  entry.dead = true;
  showCallError(chat.webContents, `Spojenie cez asus spadlo, ${CALL_NETS[network].name} v okne prestal fungovať. Klikni na hovor vo Wefte znova.`);
}
/** The tunnel stays while any window of the network lives: closing the small chat window keeps a running call. */
app.on('browser-window-created', (_event, w) => {
  // Only sessions a call window locked: an unused network's profile is never made.
  const network = lockedSessions.get(w.webContents.session);
  if (!network) return;
  w.on('closed', () => setImmediate(() => {
    const t = callTunnels.get(network);
    if (!t || callWindows(network).length) return;
    callTunnels.delete(network);
    t.lost = true;
    t.close();
    callSession(network).setProxy(callProxy(NO_ROUTE)).catch(() => {});
  }));
});

/** Opens (or turns) the network's call window to one chat. `id` is the chat's id on the network, digits only. */
async function openCall(network, id) {
  const net = Object.hasOwn(CALL_NETS, network) ? CALL_NETS[network] : null;
  if (!net || typeof id !== 'string' || !/^\d{1,64}$/.test(id)) throw new Error('Tento chat sa v okne hovoru otvoriť nedá.');
  const open = calls.get(network);
  if (open && !open.win.isDestroyed() && !open.dead) {
    // The same chat already shown is only brought forward: a reload would end a call running in the page.
    const same = id === open.id;
    // A window still starting loads it once its tunnel is up. Back to the chat on screen keeps its other addresses.
    if (!same) Object.assign(open, { id, aliases: new Set(id === open.shownChat ? open.shownAliases : []) });
    open.bounces = 0; // a click is Karchi trying again, also after „stále odchádza z chatu“
    let shown = false;
    try {
      const u = new URL(open.win.webContents.getURL());
      const at = net.chatId(u);
      // A call running in the window itself counts as the chat it was started from being shown, and signing in on
      // the way to this chat as this chat (a reload would clear the form).
      shown = (!!at && (at === id || open.aliases.has(at))) || (net.popup(u) && id === open.shownChat) || (same && !at && net.allows(u));
    } catch {}
    // The chat still on screen while another chat loads (a quick click back): that load stops before it commits.
    // Any other load (its call, a login) goes on.
    let pendingChat = null;
    try { pendingChat = open.pending && net.chatId(new URL(open.pending)); } catch {}
    const pendingOurs = !!pendingChat && (pendingChat === id || open.aliases.has(pendingChat));
    if (shown && pendingChat && !pendingOurs && open.win.webContents.isLoading()) open.win.webContents.stop();
    // This chat's own load still under way (waiting for the network, or for its sign-in page): it goes on.
    const loadingOurs = pendingOurs && open.win.webContents.isLoading();
    // A click that loads its chat calls there (beta networks); a chat already in the window is only shown, as its
    // call may be running.
    if (!shown && !loadingOurs && net.autoCall) open.callWanted = { id, at: Date.now() };
    // The chat on screen is only shown: a click meant for another chat calls nobody (a second click on the same
    // chat while it still comes keeps its call).
    if (shown && open.callWanted?.id !== id) open.callWanted = null;
    if (open.ready && !shown && !loadingOurs) {
      // Back while the other chat loads never shows the one before.
      open.win.webContents.navigationHistory.clear();
      const token = open.callWanted;
      loadChat(open.win.webContents, net, open).then(() => autoCall(network, open, token));
    }
    open.win.show();
    open.win.focus();
    return;
  }
  if (open && !open.win.isDestroyed()) open.win.destroy(); // its tunnel failed or fell: built again
  const ses = lockSession(network);
  const win = new BrowserWindow({
    width: net.width || 420,
    height: 760,
    title: `Hovor · ${net.name}${net.beta ? ' (beta)' : ''}`,
    autoHideMenuBar: true,
    webPreferences: { session: ses, contextIsolation: true, sandbox: true }, // no preload: the page gets no window.desktop
  });
  const entry = { win, id, aliases: new Set(), shownChat: null, shownAliases: new Set(), callWanted: net.autoCall ? { id, at: Date.now() } : null, ownLoad: false, bounces: 0, bounceAt: 0, ready: false, dead: false };
  calls.set(network, entry);
  lockContents(win.webContents, network, entry, false);
  // The title stays „Hovor · …“ (the page would put its own): a window rule on the desktop can find it.
  win.on('page-title-updated', (event) => event.preventDefault());
  win.on('closed', () => { if (calls.get(network) === entry) calls.delete(network); });
  const up = await callTunnel(network);
  if (win.isDestroyed()) return;
  if (!up) {
    entry.dead = true;
    showCallError(win.webContents, `Okno hovoru ide cez asus a tunel na asus sa nepodaril. ${net.name} sa preto neotvoril; skús to znova, keď asus beží.`);
    return;
  }
  if (entry.dead) return; // the tunnel fell meanwhile: its explanation stays
  await win.loadURL('about:blank').catch(() => {}); // the identity can only be set once the window has a page
  if (win.isDestroyed() || entry.dead) return;
  await presentAs(win.webContents, CHROME_UA);
  if (win.isDestroyed() || entry.dead) return;
  entry.ready = true;
  const token = entry.callWanted;
  await loadChat(win.webContents, net, entry, { userAgent: CHROME_UA });
  autoCall(network, entry, token);
}

/** The way out: closes every call window (the call's popups too) and forgets their logins. */
async function forgetCalls() {
  calls.clear();
  for (const network of Object.keys(CALL_NETS)) {
    for (const w of callWindows(network)) w.destroy();
    const ses = callSession(network);
    await ses.clearStorageData();
    await ses.clearCache();
  }
}

// The networks the call window knows, for the app's call button (preload asks once when the page loads).
ipcMain.on('call-networks', (event) => { event.returnValue = fromApp(event) ? Object.keys(CALL_NETS) : []; });
ipcMain.handle('call', (event, spec) => {
  if (!fromApp(event)) throw new Error('Not allowed');
  // A beta network only for an app that knows it is one (its switch is on): an older app never calls by itself.
  if (Object.hasOwn(CALL_NETS, spec?.network) && CALL_NETS[spec.network].beta && spec.beta !== true) throw new Error('Tento chat sa v okne hovoru otvoriť nedá.');
  return openCall(spec?.network, spec?.id);
});
ipcMain.handle('call-forget', (event) => {
  if (!fromApp(event)) throw new Error('Not allowed');
  return forgetCalls();
});

// ------------------------------------------------------------------ follow window
// Settings → Prístupnosť → Prehliadač „vo Wefte“: a profile on Instagram or Facebook opens in a small window of the
// shell that shows only the person's name and the follow / add-friend button; everything else of the page is hidden
// and cannot be clicked, and the window never leaves the profile (signing in excepted). Like a call window it goes
// out through asus (x270's browser blocks facebook.com) and keeps that network's call-window login.
// Each network: `session` (the call window whose login it shares), `url(who)`, `home(u, who)` for the profile's own
// address, `aliases` when its own load may land on another address of the profile, `allows(u)` for signing in,
// `scope`/`nameAt` (CSS) for where the button and the person's name are, and `labels`, the button's text in the
// languages Meta may speak to Karchi (a missing one shows the window's note instead).
const FOLLOW_NETS = {
  instagram: {
    name: 'Instagram', title: 'Sledovať', session: 'instagram',
    valid: /^[A-Za-z0-9._]{1,30}$/,
    url: (who) => `https://www.instagram.com/${who}/`,
    home: (u, who) => u.origin === 'https://www.instagram.com' && u.pathname.replace(/\/$/, '').toLowerCase() === `/${who.toLowerCase()}`,
    allows: (u) => META_AUTH(u) || (u.origin === 'https://www.instagram.com' && /^\/(accounts\/(login|onetap|two_factor)|challenge|two_factor|auth_platform)(\/|$)/.test(u.pathname)),
    scope: 'header', nameAt: 'header h2',
    labels: ['Follow', 'Follow Back', 'Following', 'Requested', 'Sledovať', 'Sledovať tiež', 'Sledovať späť', 'Sledované', 'Sledujete', 'Sleduješ', 'Požiadané', 'Žiadosť odoslaná', 'Sledovat', 'Sledovat zpět', 'Sledováno', 'Požádáno'],
  },
  facebook: {
    name: 'Facebook', title: 'Pridať priateľa', session: 'messenger',
    aliases: true, // profile.php?id= goes on to the person's name
    valid: /^\d{1,20}$/,
    url: (who) => `https://www.facebook.com/profile.php?id=${who}`,
    home: (u, who) => u.origin === 'https://www.facebook.com' && u.pathname === '/profile.php' && u.searchParams.get('id') === who,
    allows: META_AUTH,
    scope: '[role=main]', nameAt: '[role=main] h1',
    labels: ['Add friend', 'Add Friend', 'Cancel request', 'Cancel Request', 'Friends', 'Respond', 'Confirm request', 'Follow', 'Following',
      'Pridať priateľa', 'Pridať medzi priateľov', 'Zrušiť žiadosť', 'Priatelia', 'Odpovedať', 'Potvrdiť žiadosť', 'Sledovať', 'Sledujete',
      'Přidat přítele', 'Přidat do přátel', 'Zrušit žádost', 'Přátelé', 'Odpovědět', 'Sledovat'],
  },
};
// Everything but the kept name, the button and Meta's own dialogs (cookies, „Unfollow?“, the Friends menu) is hidden:
// a hidden element is not drawn and takes no click. A user style wins over the page's own !important.
const FOLLOW_CSS = `body * { visibility: hidden !important; }
[data-weft-keep], [data-weft-keep] *, [role=dialog], [role=dialog] *, [role=menu], [role=menu] * { visibility: visible !important; }
html, body { overflow: hidden !important; }`;
const FOLLOW_WORLD = 1078;
/** Marks the name and the button (again after the page redraws them), brings the button into sight, and after
 *  `wait` ms without one shows the window's own note. Runs in a world of its own: the page never sees it. */
const followScript = (net, note, wait) => `(() => {
  if (window.__weftFollow) return; window.__weftFollow = 1;
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const labels = new Set(${JSON.stringify(net.labels)}.map(norm));
  let shown = false;
  const mark = () => {
    for (const n of document.querySelectorAll(${JSON.stringify(net.nameAt)})) { n.setAttribute('data-weft-keep', ''); break; }
    let button = null;
    for (const root of document.querySelectorAll(${JSON.stringify(net.scope)})) {
      for (const b of root.querySelectorAll('button, [role=button]')) {
        if (!labels.has(norm(b.getAttribute('aria-label'))) && !labels.has(norm(b.textContent))) continue;
        const r = b.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        button = b; break;
      }
      if (button) break;
    }
    for (const old of document.querySelectorAll('[data-weft-button]')) if (old !== button) { old.removeAttribute('data-weft-button'); old.removeAttribute('data-weft-keep'); }
    if (!button) return;
    document.getElementById('weft-follow-note')?.remove();
    button.setAttribute('data-weft-keep', ''); button.setAttribute('data-weft-button', '');
    if (!shown) { shown = true; button.scrollIntoView({ block: 'center', inline: 'center' }); }
  };
  let queued = false;
  new MutationObserver(() => { if (!queued) { queued = true; setTimeout(() => { queued = false; mark(); }, 150); } })
    .observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] });
  mark();
  setTimeout(() => {
    if (shown || document.getElementById('weft-follow-note')) return;
    const d = document.createElement('div');
    d.id = 'weft-follow-note'; d.setAttribute('data-weft-keep', '');
    d.style.cssText = 'position:fixed;z-index:2147483647;left:16px;right:16px;top:16px;padding:12px;font:14px sans-serif;background:#000a07;color:#f0f0eb;border-radius:8px';
    d.textContent = ${JSON.stringify(note)};
    document.body.append(d);
  }, ${Number(wait)});
})()`;
// network -> { win, who, aliases, touched, bounces, bounceAt, ready, dead }: `aliases` are the addresses the profile's own
// load landed on (Facebook sends profile.php?id= on to the person's name); `touched` is set once Karchi pressed
// anything in the window, after which no new address counts as the profile.
const follows = new Map();

function lockFollow(contents, network, entry) {
  const net = FOLLOW_NETS[network];
  const parse = (url) => { try { return new URL(url); } catch { return null; } };
  const home = (url) => { const u = parse(url); return !!u && (net.home(u, entry.who) || entry.aliases.has(`${u.origin}${u.pathname.replace(/\/$/, '')}`)); };
  const signIn = (url) => { const u = parse(url); return !!u && net.allows(u); };
  // The profile's own load, before Karchi touched anything, moving to one path of the same site: the same profile.
  const alias = (url) => {
    const u = parse(url);
    const at = parse(net.url(entry.who));
    if (!net.aliases || entry.touched || !u || !at || u.origin !== at.origin || !/^\/[^/]+\/?$/.test(u.pathname) || net.allows(u)) return false;
    entry.aliases.add(`${u.origin}${u.pathname.replace(/\/$/, '')}`);
    logLogin(`follow ${network} profile also ${u.pathname}`);
    return true;
  };
  const back = (url) => {
    try { const u = new URL(url); logLogin(`follow ${network} refused ${u.host}${u.pathname}`); } catch {}
    // Refused before it left: the profile is still there as it was (a dialog open on it stays).
    if (home(contents.getURL())) return;
    entry.bounces = Date.now() - entry.bounceAt < 10000 ? entry.bounces + 1 : 1;
    entry.bounceAt = Date.now();
    if (entry.bounces > 10) { showCallError(contents, `${net.name} stále odchádza z profilu. Zavri okno a skús znova.`); return; }
    contents.loadURL(net.url(entry.who)).catch(() => {});
  };
  contents.on('input-event', (_e, input) => { if (['mouseDown', 'rawKeyDown', 'keyDown', 'touchStart', 'gestureTapDown'].includes(input.type)) entry.touched = true; });
  contents.on('will-navigate', (event, url) => { if (!home(url) && !signIn(url)) { event.preventDefault(); back(url); } });
  contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
    if (!isMainFrame || home(url) || signIn(url) || alias(url)) return;
    event.preventDefault();
    back(url);
  });
  // The profile is stripped once in each page that shows it (a full load, or the page moving there itself after
  // signing in); a sign-in page is left whole, and one the stripped page moves to is loaded afresh.
  let stripped = false;
  const strip = async () => {
    if (stripped || !home(contents.getURL())) return;
    stripped = true;
    try {
      await contents.insertCSS(FOLLOW_CSS, { cssOrigin: 'user' });
      await contents.executeJavaScriptInIsolatedWorld(FOLLOW_WORLD, [{ code: followScript(net, `Tlačidlo ${net.title} som na stránke nenašiel (nie si prihlásený, súkromný účet, iný jazyk alebo nový vzhľad ${net.name}u). Nič iné tu nie je; zavri okno.`, entry.wait) }]);
    } catch (err) { logLogin(`follow ${network} could not strip the page: ${err.message}`); }
  };
  contents.on('did-start-navigation', (_e, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) stripped = false; });
  contents.on('dom-ready', strip);
  contents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (home(url)) strip();
    else if (signIn(url)) { if (stripped) contents.loadURL(url).catch(() => {}); }
    else if (!alias(url)) back(url);
    else strip();
  });
  // Signed in, a network goes to its start page (the feed): the window goes back to the profile.
  contents.on('did-navigate', (_e, url) => { if (!url.startsWith('data:') && url !== 'about:blank' && !home(url) && !signIn(url)) back(url); });
  contents.setWindowOpenHandler(({ url }) => {
    try { const u = new URL(url); logLogin(`follow ${network} refused popup ${u.host}${u.pathname}`); } catch {}
    return { action: 'deny' };
  });
}

/** Opens (or turns) the network's follow window to one person: an Instagram username or a Facebook profile id. */
async function openFollow(network, who) {
  const net = Object.hasOwn(FOLLOW_NETS, network) ? FOLLOW_NETS[network] : null;
  if (!net || typeof who !== 'string' || !net.valid.test(who)) throw new Error('Tento profil sa v okne Weftu otvoriť nedá.');
  const open = follows.get(network);
  if (open && !open.win.isDestroyed() && !open.dead) {
    if (open.who !== who) {
      Object.assign(open, { who, aliases: new Set(), touched: false, bounces: 0 });
      if (open.ready) open.win.webContents.loadURL(net.url(who)).catch(() => {});
    }
    open.win.show();
    open.win.focus();
    return;
  }
  if (open && !open.win.isDestroyed()) open.win.destroy();
  const ses = lockSession(net.session);
  const win = new BrowserWindow({
    width: 420, height: 560, title: `${net.title} · ${net.name}`, autoHideMenuBar: true,
    webPreferences: { session: ses, contextIsolation: true, sandbox: true }, // no preload: the page gets no window.desktop
  });
  // `wait`: how long the page may take to draw the button before the note (the self-test shortens it).
  const entry = { win, who, aliases: new Set(), touched: false, bounces: 0, bounceAt: 0, ready: false, dead: false, wait: Number(process.env.SPRAVY_FOLLOW_WAIT) || 12000 };
  win.removeMenu(); // no menu (Alt): its reload and developer tools would undo the window's narrowing
  follows.set(network, entry);
  lockFollow(win.webContents, network, entry);
  win.on('page-title-updated', (event) => event.preventDefault());
  win.on('closed', () => { if (follows.get(network) === entry) follows.delete(network); });
  const up = await callTunnel(net.session);
  if (win.isDestroyed()) return;
  if (!up) {
    entry.dead = true;
    showCallError(win.webContents, `Okno ide cez asus a tunel na asus sa nepodaril. ${net.name} sa preto neotvoril; skús to znova, keď asus beží.`);
    return;
  }
  await win.loadURL('about:blank').catch(() => {});
  if (win.isDestroyed() || entry.dead) return;
  await presentAs(win.webContents, CHROME_UA);
  if (win.isDestroyed() || entry.dead) return;
  entry.ready = true;
  await win.loadURL(net.url(entry.who), { userAgent: CHROME_UA }).catch(() => {});
}
ipcMain.on('follow-networks', (event) => { event.returnValue = fromApp(event) ? Object.keys(FOLLOW_NETS) : []; });
ipcMain.handle('follow', (event, spec) => {
  if (!fromApp(event)) throw new Error('Not allowed');
  return openFollow(spec?.network, spec?.who);
});

// „Prejsť z Beeperu“ (app.js beeperMove): Beeper Desktop's data folder on this computer. Its index.db (with the -wal
// beside it) is copied while Beeper is closed, and the app sends the copy to the archive piece by piece. Nothing in
// Beeper's folder is changed; the copy is deleted when the app is done with it or quits.
const beeperDir = () => (process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'BeeperTexts')
  : path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Application Support/BeeperTexts' : '.config/BeeperTexts'));
/** Whether Beeper holds its single-instance lock: on Linux and macOS a link "<host>-<pid>", on Windows a lockfile it keeps open. */
const beeperRunning = (dir) => {
  try {
    const m = /^(.*)-(\d+)$/.exec(fs.readlinkSync(path.join(dir, 'SingletonLock')));
    if (!m || m[1] !== os.hostname()) return true;
    try { process.kill(Number(m[2]), 0); return true; } catch (e) { return e.code === 'EPERM'; }
  } catch {}
  if (process.platform !== 'win32') return false;
  try { fs.closeSync(fs.openSync(path.join(dir, 'lockfile'), 'r+')); return false; } catch (e) { return e.code === 'EBUSY' || e.code === 'EPERM'; }
};
let beeperCopy = null; // { dir, files: { 'index.db': bytes, 'index.db-wal'?: bytes } }
const forgetBeeper = () => { if (beeperCopy) fs.rmSync(beeperCopy.dir, { recursive: true, force: true }); beeperCopy = null; };
/** Copies an earlier run left behind (it crashed or was killed): they hold decrypted chats. One Weft runs at a time. */
const sweepBeeper = () => {
  for (const name of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('weft-beeper-'))) {
    const dir = path.join(os.tmpdir(), name);
    if (dir !== beeperCopy?.dir) fs.rmSync(dir, { recursive: true, force: true });
  }
};
app.on('will-quit', forgetBeeper);
app.whenReady().then(() => { try { sweepBeeper(); } catch {} });
ipcMain.handle('beeper-find', async (event) => {
  if (!fromApp(event)) throw new Error('Not allowed');
  forgetBeeper();
  try { sweepBeeper(); } catch {}
  const dir = beeperDir();
  if (!fs.existsSync(path.join(dir, 'index.db'))) return { found: false };
  if (beeperRunning(dir)) return { found: true, running: true };
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'weft-beeper-'));
  const files = {};
  try {
    for (const name of ['index.db', 'index.db-wal']) {
      const from = path.join(dir, name);
      if (!fs.existsSync(from)) continue;
      await fs.promises.copyFile(from, path.join(copy, name)); // a big index.db must not stall the window
      files[name] = fs.statSync(path.join(copy, name)).size;
    }
  } catch (e) { fs.rmSync(copy, { recursive: true, force: true }); throw e; }
  if (!files['index.db-wal']) delete files['index.db-wal']; // an empty -wal holds nothing
  beeperCopy = { dir: copy, files };
  return { found: true, running: false, files };
});
ipcMain.handle('beeper-piece', (event, name, offset, length) => {
  if (!fromApp(event)) throw new Error('Not allowed');
  if (!beeperCopy || !(name in beeperCopy.files) || !Number.isSafeInteger(offset) || !(length > 0 && length <= 64 << 20)) throw new Error('No such piece');
  const fd = fs.openSync(path.join(beeperCopy.dir, name), 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, Math.min(length, beeperCopy.files[name] - offset)));
    fs.readSync(fd, buf, 0, buf.length, offset);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  } finally { fs.closeSync(fd); }
});
ipcMain.handle('beeper-done', (event) => {
  if (!fromApp(event)) throw new Error('Not allowed');
  forgetBeeper();
});

ipcMain.handle('collect', (event, spec) => {
  if (event.senderFrame?.origin !== APP_ORIGIN) throw new Error('Not allowed');
  return collect(spec);
});
ipcMain.handle('cancel-collect', (event) => {
  if (event.senderFrame?.origin !== APP_ORIGIN) throw new Error('Not allowed');
  if (pending && !pending.win.isDestroyed()) pending.win.close();
});

// The call windows' self-test (selftest-call.js) uses Chromium's fake camera; the permission path stays the real one.
if (process.env.SPRAVY_SELFTEST?.startsWith('call')) app.commandLine.appendSwitch('use-fake-device-for-media-stream');
// A click on a system notification (a Gmail code) brings the app window to the front, also when minimized.
ipcMain.handle('focus', (event) => {
  if (event.senderFrame?.origin !== APP_ORIGIN) throw new Error('Not allowed');
  if (!main || main.isDestroyed()) return;
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
});

// One Weft: starting it again brings the running window to the front instead of a second one.
const primary = !!process.env.SPRAVY_SELFTEST || app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => {
  if (!app.isReady() || !APP_URL) return;
  if (!main || main.isDestroyed()) return openMain();
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
});

app.whenReady().then(() => {
  if (!primary) return;
  if (process.env.SPRAVY_SELFTEST?.startsWith('call')) {
    return require('./selftest-call.js')({ APP_URL, APP_ORIGIN, CALL_NETS, calls, callSession, openCall, forgetCalls, fromApp, cursorPath, tunnels, callTunnels, callWindows, setMain: (w) => { main = w; } });
  }
  if (process.env.SPRAVY_SELFTEST?.startsWith('follow')) {
    return require('./selftest-follow.js')({ APP_URL, APP_ORIGIN, FOLLOW_NETS, follows, openFollow, callSession, callWindows, forgetCalls, fromApp, tunnels, setMain: (w) => { main = w; } });
  }
  if (process.env.SPRAVY_SELFTEST) return selftest();
  if (!APP_URL) {
    dialog.showErrorBox('Weft', 'Weft nevie, kde je server: nastav SPRAVY_URL alebo zapíš jeho celú adresu (https://…) do ~/.config/weft/url.');
    return app.quit();
  }
  openMain();
});
app.on('window-all-closed', () => { if (!process.env.SPRAVY_SELFTEST) app.quit(); }); // the self-test quits on its own

/** Hidden check of the collect pipeline against a public page: no login, nothing stored. */
async function selftest() {
  try {
    const values = await collect(process.env.SPRAVY_SELFTEST_SPEC ? JSON.parse(process.env.SPRAVY_SELFTEST_SPEC) : {
      url: 'https://example.com/',
      hidden: true,
      wait_for_url_pattern: '^https://example\\.com/',
      fields: [{ id: 'ua', required: true, sources: [{ type: 'request_header', name: 'User-Agent', request_url_regex: '^https://example\\.com/' }] }],
    });
    console.log('selftest ok, fields:', Object.keys(values).join(' '));
  } catch (err) {
    console.log('selftest failed:', err.message);
  }
  app.quit();
}

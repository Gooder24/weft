// Weft opens without the server: its own files come from the network while asus answers and from this
// cache when it does not, and photos stay here once seen. The messages themselves are kept by app.js.
const RELEASE = ''; // filled by tools/release-app.py
const RELEASE_FILES = []; // filled by tools/release-app.py
const SHELL = RELEASE ? `weft-shell-${RELEASE}` : 'weft-shell-v2';
const MEDIA = 'weft-media-v1';
const MEDIA_MAX = 3000; // photos and thumbnails; the oldest go first
const MEDIA_FILE_MAX = 8e6; // larger downloads (videos) are not kept
const WAIT = 4000; // a sleeping asus never answers: after this the cached copy opens
let downUntil = 0;
const FILES = ['/', '/app.js', '/updates.js', '/app.css', '/icon.svg', '/emoji.json', '/qrcode.js', '/calendar.js', '/kalendarix-colors.js', '/kalendarix-files.js', '/feed.js', '/stash.js', '/broadcast.js', '/board.js', '/hermes.svg', '/fonts/DepartureMono-Regular.woff2',
  '/discord.png', '/edupage.png', '/gmail.ico', '/instagram.png', '/messenger.ico', '/outlook.png', '/teams.png', '/vinted.png', '/packeta.png', '/sms.svg', '/phone.svg', '/matrix.svg', '/whatsapp.webp', '/x.svg', '/youtube.svg', '/rss.svg'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then((c) => Promise.all((RELEASE ? ['/', ...RELEASE_FILES] : FILES).map((f) => c.add(f)))));
});

self.addEventListener('activate', (e) => {
  // Keep old shell caches for still-open old windows; clear only unreferenced releases.
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/_matrix/client/v1/media/')) return e.respondWith(media(req));
  // The API, bridges and archive are live data: app.js keeps its own copy of what it needs.
  if (url.pathname.startsWith('/_') || url.pathname === '/sw.js' || url.pathname === '/release.json') return;
  e.respondWith(shell(req));
});

/** Network first, so a deploy shows at once; the cache when the network fails or is too slow. */
async function shell(req) {
  const path = new URL(req.url).pathname;
  const pinned = /^\/releases\/([a-f0-9]{20})\//.exec(path);
  const cache = await caches.open(pinned ? `weft-shell-${pinned[1]}` : SHELL);
  if (pinned) { const hit = await cache.match(req.url); if (hit) return hit; }
  // Fresh URL keys avoid serializing fetch-event Request headers, which crashes Electron 44.
  const key = req.mode === 'navigate' && (path === '/' || path === '/index.html') ? '/' : req.url;
  const stop = new AbortController();
  const net = fetch(req, { signal: stop.signal }).then((res) => {
    if (res.ok && res.type === 'basic') cache.put(key, res.clone());
    return res;
  });
  const late = new Promise((resolve) => setTimeout(resolve, Date.now() < downUntil ? 300 : WAIT));
  const first = await Promise.race([net.catch(() => null), late]);
  if (first) { downUntil = 0; return first; }
  downUntil = Date.now() + 15000; // the page's other files do not wait the full time again
  const cached = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
  if (!cached) return net;
  stop.abort(); // a hanging request would hold one of the few connections the page has
  return cached;
}

/** Media is content-addressed: once seen it never changes. Profile pictures (64 px thumbnails) are kept by app.js. */
async function media(req) {
  const url = new URL(req.url);
  if (url.searchParams.get('width') === '64') return fetch(req, { signal: AbortSignal.timeout(60000) });
  const cache = await caches.open(MEDIA);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req, { signal: AbortSignal.timeout(60000) });
  const size = Number(res.headers.get('content-length') || 0);
  // asus sends thumbnails chunked, with no length; they are small, so they are kept too.
  if (res.ok && (size ? size <= MEDIA_FILE_MAX : url.pathname.includes('/thumbnail/'))) cache.put(req.url, res.clone()).then(() => trim(cache));
  return res;
}

let trimming = null;
function trim(cache) {
  trimming ||= cache.keys().then(async (keys) => {
    for (const k of keys.slice(0, Math.max(0, keys.length - MEDIA_MAX))) await cache.delete(k);
  }).finally(() => { trimming = null; });
}

// Web Push from the Gmail bridge: a one-time code came for an account set to „okno a notifikácia“. The push carries
// nothing, so the code never passes through the push service; opening Weft shows it. Tag "weft-code" is the one
// app.js uses too, so a device that gets both shows one, and app.js closes it once the code is closed or expired.
self.addEventListener('push', (e) => {
  e.waitUntil(pushTexts().then((t) => self.registration.showNotification(t.title, { body: t.body, tag: 'weft-code', renotify: true, icon: '/icon.svg' })));
});

// A calendar reminder (app.js calNotify) names its event: the window it focuses opens it, a new one gets it in its address.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const event = e.notification.data?.calendar;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((list) => (list[0] ? list[0].focus().then((client) => { if (event) client?.postMessage({ calendar: event }); })
      : self.clients.openWindow(event ? `/?event=${encodeURIComponent(event)}` : '/'))));
});

async function pushTexts() {
  try {
    const saved = await (await caches.open('weft-prefs')).match('/push-texts');
    if (saved) return await saved.json();
  } catch { /* the default below */ }
  return { title: 'Prišiel overovací kód', body: 'Otvor Weft, kód je v jeho okne.' };
}

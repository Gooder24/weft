// Explicit daily reading inside the shared reading windows: the feed server opens a few a day (policy: count and
// minutes, changed in Settings from tomorrow on) for Feed and Weft's waiting messages together (readingWindow/onWindow).
// Leaving Feed keeps one; it ends by itself or with "Skončiť okno", and nothing on this device (reload, cleared
// storage) gives back a used one.
import { T, LOCALE } from './i18n.js';
import { icon } from './icons.js';
/** Tiles drawn at once; „Zobraziť ďalšie“ adds as many again (sixty YouTube channels bring hundreds of videos). */
const PAGE = 120;
export function createFeed({ h, api, kv, refresh, offline, user, settingsPanel, schedule, close, isOpen = () => false, readingWindow, onWindow, windowsLeft }) {
  const state = { doc: null, busy: false, error: '', open: null, addUrl: '', addName: '', reader: null, sel: null, limit: PAGE };
  const media = new Map();
  let generation = 0;
  let flushing = null;
  let opening = null;
  const key = () => `ep_feed_settings:${user()}`;
  const closeKey = () => `ep_window_close:${user()}`;
  const parse = (value) => { try { return JSON.parse(value || 'null'); } catch { return null; } };
  const active = () => { const w = readingWindow(); const now = Date.now(); return !!w && now >= w.start && now < w.end; };
  const minutes = () => readingWindow()?.minutes || 10;
  const hm = (t) => new Date(t).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  const pending = () => { try { return JSON.parse(localStorage.getItem(key()) || 'null'); } catch { return null; } };
  const cfg = () => ({ sources: [], hiddenStories: {}, instagram: false, ...state.doc?.settings, ...pending(), daily: true, limitOnce: true });
  function accept(doc) {
    if (doc.window) onWindow(doc.window);
    state.doc = { ...doc, items: doc.access === false ? state.doc?.items || [] : [...new Map([...(doc.items || []), ...(doc.hiddenItems || [])].map((item) => [item.id, item])).values()].sort((a, b) => (b.at || 0) - (a.at || 0)) };
    kv('readwrite', (st) => st.put({ user: user(), doc: state.doc }, 'feed')).catch(() => {});
  }
  async function load() {
    // The per-device session before the shared window: nothing to send any more.
    for (const k of [`ep_feed_opened:${user()}`, `ep_feed_finished:${user()}`]) localStorage.removeItem(k);
    sessionStorage.removeItem(`ep_feed_session:${user()}`);
    if (state.busy) return;
    state.busy = true;
    const run = generation;
    try {
      if (!state.doc) {
        const saved = await kv('readonly', (st) => st.get('feed')).catch(() => null);
        if (run !== generation) return;
        if (saved?.user === user()) state.doc = saved.doc;
        refresh();
      }
      if (!offline()) {
        let settingError = '';
        if (pending() || localStorage.getItem(closeKey())) {
          try { await flush(); } catch (err) { settingError = T`Nastavenie sa neuložilo: ${err.message}`; }
        }
        if (run !== generation) return;
        const doc = await api('GET', '/doc');
        if (run !== generation) return;
        accept(doc);
        // Collection only happens inside Feed, never because the eye opened the window for messages.
        if (isOpen() && doc.access && (doc.due ?? doc.day !== doc.today)) { const updated = await api('POST', '/refresh', {}); if (run !== generation) return; accept(updated); }
        state.error = settingError;
      }
    } catch (err) { if (run === generation) state.error = T`Feed sa nenačítal: ${err.message}`; }
    finally { if (run === generation) { state.busy = false; refresh(); } }
  }
  function flush() {
    if (flushing) return flushing.catch(() => {}).then(flush);
    const task = flushOnce().finally(() => { if (flushing === task) flushing = null; });
    flushing = task;
    return task;
  }
  async function flushOnce() {
    if (offline()) return;
    const run = generation;
    const ownerKey = key();
    const doneKey = closeKey();
    const value = pending();
    let rejected = null;
    if (value) {
      let doc;
      try { doc = await api('POST', '/settings', value); }
      catch (err) {
        if (run !== generation) return;
        // Invalid settings need correction, not an endless queue that blocks unrelated choices.
        if (JSON.stringify(pending()) === JSON.stringify(value) && err.status >= 400 && err.status < 500 && ![401, 403, 429].includes(err.status)) {
          const rest = { ...value };
          if (Array.isArray(rest.sources) && err.details?.field === 'sources' && Array.isArray(err.details.invalidIndices)) {
            rest.sources = rest.sources.filter((_, i) => !err.details.invalidIndices.includes(i));
          } else if ('sources' in rest) delete rest.sources;
          else for (const k of Object.keys(rest)) delete rest[k];
          if (Object.keys(rest).length) {
            localStorage.setItem(ownerKey, JSON.stringify(rest));
            const kept = await api('POST', '/settings', rest);
            if (run === generation) { if (JSON.stringify(pending()) === JSON.stringify(rest)) localStorage.removeItem(ownerKey); doc = kept; }
          } else localStorage.removeItem(ownerKey);
          rejected = err;
        } else throw err;
      }
      if (run !== generation) return;
      if (!rejected && JSON.stringify(pending()) === JSON.stringify(value)) localStorage.removeItem(ownerKey);
      if (doc) accept(doc);
    }
    // "Skončiť okno" made offline: ends that window (by its start, never a newer one) once online.
    const closingText = localStorage.getItem(doneKey);
    const closing = parse(closingText);
    if (Number.isInteger(closing?.start)) {
      const doc = await api('POST', '/window/close', { start: closing.start });
      if (run !== generation) return;
      accept(doc);
    }
    if (closingText && localStorage.getItem(doneKey) === closingText) localStorage.removeItem(doneKey);
    if (rejected) throw rejected;
  }
  async function configure(patch) {
    const run = generation;
    localStorage.setItem(key(), JSON.stringify({ ...pending(), ...patch }));
    refresh();
    try { await flush(); if (run === generation) state.error = ''; } catch (err) { if (run === generation) state.error = `${err.status >= 400 && err.status < 500 && ![401, 403, 429].includes(err.status) ? T('Nastavenie nebolo prijaté') : T('Nastavenie čaká na uloženie')}: ${err.message}`; }
    refresh();
  }
  async function clearInstagramCache() {
    for (const m of media.values()) if (m.url) URL.revokeObjectURL(m.url);
    media.clear(); state.open = null; state.doc = null;
    await kv('readwrite', (st) => {
      const keys = st.getAllKeys();
      keys.onsuccess = () => { for (const k of keys.result) if (String(k).startsWith('feed-media:')) st.delete(k); };
      return keys;
    }).catch(() => {});
  }
  async function connectInstagram() {
    if (state.busy || offline() || !window.desktop?.collect) return;
    const run = generation;
    state.busy = true; state.error = ''; refresh();
    try {
      const cookies = await window.desktop.collect({
        url: 'https://www.instagram.com/', title: T('Instagram: feed a stories'),
        wait_for_url_pattern: '^https://www\\.instagram\\.com/$',
        fields: ['sessionid', 'ds_user_id', 'csrftoken', 'ig_did', 'mid', 'rur'].map((id) => ({
          id, required: ['sessionid', 'ds_user_id', 'csrftoken'].includes(id),
          sources: [{ type: 'cookie', name: id, cookie_domain: '.instagram.com' }],
        })),
      });
      if (run !== generation) return;
      const doc = await api('POST', '/instagram/connect', { cookies });
      if (run !== generation) return;
      await clearInstagramCache();
      if (run !== generation) return;
      accept(doc);
      // Do not let an older queued setting disable the newly connected Instagram.
      if (pending()) localStorage.setItem(key(), JSON.stringify({ ...pending(), instagram: true }));
    } catch (err) { if (run === generation) state.error = T`Instagram sa nepripojil: ${err.message}`; }
    finally { if (run === generation) { state.busy = false; refresh(); } }
  }
  async function disconnectInstagram() {
    if (state.busy || offline()) return;
    const run = generation;
    state.busy = true; refresh();
    try {
      const doc = await api('POST', '/instagram/disconnect', {});
      if (run !== generation) return;
      await clearInstagramCache();
      if (run !== generation) return;
      accept(doc); state.error = '';
      if (pending()) localStorage.setItem(key(), JSON.stringify({ ...pending(), instagram: false }));
    } catch (err) { if (run === generation) state.error = T`Instagram sa neodpojil: ${err.message}`; }
    finally { if (run === generation) { state.busy = false; refresh(); } }
  }
  function hide(item, hidden = true) {
    const next = { ...cfg().hiddenStories };
    if (hidden) next[item.user] = item.author; else delete next[item.user];
    if (state.open === item.id) state.open = null;
    configure({ hiddenStories: next });
  }
  async function unfollow(item) {
    if (!active() || state.doc?.instagramPaused || offline() || state.busy || !confirm(T`Prestať sledovať @${item.author} na Instagrame? Prestaneš vidieť aj jeho príspevky.`)) return;
    const run = generation;
    state.busy = true; refresh();
    try {
      const doc = await api('POST', '/unfollow', { user: item.user, username: item.author, confirm: true });
      if (run !== generation) return;
      accept(doc);
      state.open = null; state.error = '';
    } catch (err) { if (run === generation) state.error = T`Sledovanie sa nezrušilo: ${err.message}`; }
    finally { if (run === generation) { state.busy = false; refresh(); } }
  }
  // Pictures load when their tile comes into sight, at most four at a time, and stay in IndexedDB (the newest 200)
  // for offline reading. A video is fetched only when it is played in the reader.
  const queue = [];
  let loading = 0;
  function want(item, index) {
    const id = `${item.id}:${index}`;
    if (!active() || media.has(id)) return;
    media.set(id, { busy: true });
    queue.push([item, index, generation]);
    pump();
  }
  function pump() {
    while (loading < 4 && queue.length) {
      const [item, index, run] = queue.shift();
      if (run !== generation) continue;
      loading++;
      fetchMedia(item, index, run).finally(() => { loading--; pump(); });
    }
  }
  async function fetchMedia(item, index, run) {
    const id = `${item.id}:${index}`;
    try {
      let blob = await kv('readonly', (st) => st.get(`feed-media:${user()}:${id}`)).catch(() => null);
      if (!blob && !offline()) {
        blob = await api('MEDIA', `/media?id=${encodeURIComponent(item.id)}&n=${index}`);
        if (run !== generation) return;
        // Keep only a bounded set of viewed media, not an ever-growing history.
        await kv('readwrite', (st) => { const put = st.put(blob, `feed-media:${user()}:${id}`); const keys = st.getAllKeys(); keys.onsuccess = () => { const old = keys.result.filter((k) => String(k).startsWith('feed-media:')); for (const k of old.slice(0, Math.max(0, old.length - 200))) st.delete(k); }; return put; }).catch(() => {});
      }
      if (run !== generation) return;
      if (!blob) throw new Error(T('Toto médium ešte nie je uložené offline.'));
      media.set(id, { url: URL.createObjectURL(blob) });
    } catch (err) { if (run === generation) media.set(id, { error: err.message }); }
    if (run === generation) refresh();
  }
  function retry(item, index) { media.delete(`${item.id}:${index}`); want(item, index); }
  // Which category an item is in, and the pictures of one role (avatar, media, quote, thumb …) with their index.
  const CATS = ['all', 'x', 'youtube', 'instagram', 'rss'];
  const catName = (c) => ({ all: T('Všetko'), x: 'X', youtube: 'YouTube', instagram: 'Instagram', rss: T('Novinky') })[c];
  const cat = (i) => (i.kind === 'story' || i.kind === 'post' ? 'instagram' : i.kind === 'youtube' ? 'youtube' : i.kind === 'x' ? 'x' : 'rss');
  const assets = (item, role) => (item.media || []).map((a, n) => [a, n]).filter(([a]) => (a.role || 'media') === role);
  const posterOf = (item, a) => (Number.isInteger(a.poster) ? a.poster : null);
  /** What a tile shows, loaded once it is in sight: avatars, the first pictures (a video's poster), a thumbnail. */
  function needed(item) {
    const pics = (role, max) => assets(item, role).slice(0, max).map(([a, n]) => (a.type === 'video' ? posterOf(item, a) : n)).filter((n) => n != null);
    return [...pics('avatar', 1), ...pics('media', 4), ...pics('quote-avatar', 1), ...pics('quote', 1)];
  }
  const logo = (c) => h('span', { class: `feed-logo feed-logo-${c}`, role: 'img', 'aria-label': catName(c) });
  function pic(item, n, cls, alt = '') {
    const v = n == null ? null : media.get(`${item.id}:${n}`);
    return v?.url ? h('img', { class: cls, src: v.url, alt, decoding: 'async' }) : h('span', { class: `${cls} feed-ph`, 'aria-hidden': 'true' });
  }
  const hm2 = (t) => (t ? new Date(t).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }) : '');
  /** A tile's time, always to the minute: „16:00“ today, „včera 23:21“, „pi 20. 11. 16:40“ before that. */
  function when(t) {
    if (!t) return '';
    const d = new Date(t); const y = new Date(); y.setDate(y.getDate() - 1);
    if (d.toDateString() === new Date().toDateString()) return hm2(t);
    if (d.toDateString() === y.toDateString()) return T`včera ${hm2(t)}`;
    return `${d.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'numeric' })} ${hm2(t)}`;
  }
  /** When a video came out, exactly: „22. 11. 2026 16:00“ (YouTube itself only says how long ago). */
  const stamp = (t) => (t ? new Date(t).toLocaleString(LOCALE, { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const views = (item) => (item.counts?.views != null ? T`${item.counts.views.toLocaleString(LOCALE)} zhliadnutí` : null);
  /** A video's line under its title as YouTube's own list writes it (Karchi wanted it native): channel, when it came
   *  out, views, Shorts. */
  const videoMeta = (item, channel = true) => h('div', { class: 'feed-video-meta' },
    // avoid-ai-design-ignore: SD4d
    [channel ? item.author : null, stamp(item.at), views(item), item.short ? 'Shorts' : null].filter(Boolean).join(' · '));
  /** An article's text without the title it often repeats at its start. */
  const articleText = (item) => { const t = String(item.text || ''); return item.title && t.startsWith(item.title) ? t.slice(item.title.length).trim() : t; };
  // URLs in a post become links in the reader; the tile itself is one click target.
  const linkify = (text) => String(text || '').split(/(https?:\/\/[^\s]+)/g).map((part, i) => (i % 2 ? h('a', { href: part, target: '_blank', rel: 'noopener noreferrer' }, part.replace(/^https?:\/\//, '')) : part));
  async function update() {
    if (!active() || state.busy || offline()) return;
    const run = generation;
    state.busy = true; refresh();
    try { const doc = await api('POST', '/refresh', {}); if (run !== generation) return; accept(doc); state.error = ''; }
    catch (err) { if (run === generation) state.error = T`Feed sa neobnovil: ${err.message}`; }
    finally { if (run === generation) { state.busy = false; refresh(); } }
  }
  /** Showing Feed. `open` (its button or shortcut, a conscious choice) also opens one of today's windows if any is
   *  left; a reload or link onto #feed only shows whether one can still open. */
  function enter(open = false) {
    generation++; state.busy = false; state.error = '';
    if (open && !active() && windowsLeft() > 0 && !offline()) openWindow();
    else load();
    refresh();
  }
  /** Asks the feed server for the next of today's windows (the eye, the chat's bar, the palette and Feed's button).
   *  While one runs, a double click or another device get the same one back; the server never makes it longer. */
  function openWindow() {
    if (opening) return opening;
    if (offline()) { state.error = T('Okno na čítanie sa otvorí, keď budeš online.'); refresh(); return Promise.resolve(); }
    opening = api('POST', '/window', {})
      .then((doc) => { accept(doc); state.error = ''; if (isOpen()) { generation++; state.busy = false; return load(); } })
      .catch((err) => { state.error = T`Okno sa neotvorilo: ${err.message}`; if (!isOpen()) alert(state.error); })
      .finally(() => { opening = null; refresh(); });
    refresh();
    return opening;
  }
  function leave() { state.open = null; state.reader = null; }
  /** Today's {count, minutes} and a change from tomorrow ({count, minutes, from}) or null, as the server last said. */
  const policy = () => state.doc?.policy || null;
  /** Settings → Správy: the number and length of windows from tomorrow on. Needs the server, so never offline. */
  async function setPolicy(p) {
    if (offline()) { alert(T('Nastavenie okien sa uloží, keď budeš online.')); return refresh(); }
    try { accept(await api('POST', '/policy', p)); }
    catch (err) { alert(T`Nastavenie okien sa neuložilo: ${err.message}`); }
    refresh();
  }
  /** "Skončiť okno": ends the running window for Feed and messages now, also offline (sent once online). */
  function finish() {
    const w = readingWindow();
    if (w && active()) {
      onWindow({ ...w, end: Date.now() });
      localStorage.setItem(closeKey(), JSON.stringify({ start: w.start }));
      flush().catch((err) => { state.error = T`Ukončenie čaká na uloženie: ${err.message}`; refresh(); });
    }
    close();
  }
  /** The items Feed shows in the chosen category, newest first; hidden and expired stories never. */
  function visible() {
    const c = cfg();
    const now = Date.now();
    return (state.doc?.items || []).filter((i) => (i.source === 'instagram' ? c.instagram : c.sources.some((s) => s.id === i.source)) && !(i.kind === 'story' && (c.hiddenStories[i.user] || (i.expires || (i.at || 0) + 86400000) <= now)));
  }
  const filterKey = () => `ep_feed_filter:${user()}`;
  const filter = () => (CATS.includes(localStorage.getItem(filterKey())) ? localStorage.getItem(filterKey()) : 'all');
  function setFilter(c) { localStorage.setItem(filterKey(), c); state.reader = null; state.limit = PAGE; refresh(); }
  /** YouTube's own list as one row a video: the title, then its line. */
  function videoRow(item) {
    return h('article', { class: `feed-tile feed-row${state.sel === item.id ? ' sel' : ''}`, tabindex: '0', 'data-feed-id': item.id, 'data-key': item.id,
      'aria-label': `YouTube: ${item.title}`, onclick: (e) => { if (!e.target.closest('a')) openReader(item.id); }, onfocus: () => { state.sel = item.id; } },
      logo('youtube'), h('div', {}, h('p', { class: 'feed-text feed-text-title' }, item.title), videoMeta(item)));
  }
  let shown = [];
  /** Instagram's problem in one sentence, or '' when it reads fine. */
  function instagramProblem(doc) {
    if (!cfg().instagram) return '';
    if (doc?.instagramPaused) return T('Instagram feed je pozastavený.');
    if (!doc?.instagramConnected) return T('Instagram nie je pripojený.');
    return (doc?.errors || []).find((e) => e.source === 'instagram')?.message || '';
  }
  function instagramRow(doc, problem) {
    return h('div', { class: 'feed-ig-state', role: 'status' }, logo('instagram'), h('span', {}, problem),
      window.desktop?.collect ? h('button', { class: 'primary', disabled: state.busy || offline() || doc?.instagramPaused, onclick: connectInstagram }, state.busy ? T('Pripájam…') : T('Znova prihlásiť feed'))
        : h('span', { class: 'feed-muted' }, T('Prihlásiš ho v desktopovej appke Weft.')));
  }
  function head(item, big = false) {
    const c = cat(item);
    const [avatar] = assets(item, 'avatar');
    return h('div', { class: 'feed-tile-head' }, logo(c),
      avatar ? pic(item, avatar[1], 'feed-avatar') : null,
      h('b', {}, c === 'x' ? item.name || item.author : item.author),
      c === 'x' ? h('span', { class: 'feed-handle' }, item.author) : null,
      item.kind === 'story' ? h('span', { class: 'feed-chip' }, 'story') : item.short ? h('span', { class: 'feed-chip' }, 'Shorts') : null,
      h('time', { datetime: item.at ? new Date(item.at).toISOString() : undefined }, big && item.at ? new Date(item.at).toLocaleString(LOCALE, { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : when(item.at)));
  }
  const via = (item) => (item.via ? h('div', { class: 'feed-via' }, icon('forward'), T`zdieľal @${item.via}`) : null);
  /** A tile's pictures: up to four in a mosaic, a video as its poster with a play mark. */
  function pics(item, role, cls) {
    const list = assets(item, role).slice(0, 4);
    if (!list.length) return null;
    return h('div', { class: `${cls} n${list.length}` }, list.map(([a, n]) => h('span', { class: 'feed-pic' },
      pic(item, a.type === 'video' ? posterOf(item, a) : n, 'feed-img'), a.type === 'video' ? h('span', { class: 'feed-play' }, icon('play')) : null)));
  }
  function quoteBox(item, full = false) {
    const q = item.quote;
    if (!q) return null;
    const [avatar] = assets(item, 'quote-avatar');
    const [first] = assets(item, 'quote');
    return h('div', { class: 'feed-quote' },
      h('div', { class: 'feed-quote-body' },
        h('div', { class: 'feed-tile-head' }, avatar ? pic(item, avatar[1], 'feed-avatar feed-avatar-s') : null, h('b', {}, q.name || '@' + q.handle), h('span', { class: 'feed-handle' }, '@' + q.handle)),
        h('p', { class: 'feed-text' }, full ? linkify(q.text) : q.text),
        full ? pics(item, 'quote', 'feed-read-pics') : null),
      !full && first ? h('span', { class: 'feed-pic feed-quote-thumb' }, pic(item, first[0].type === 'video' ? posterOf(item, first[0]) : first[1], 'feed-img')) : null);
  }
  function tile(item) {
    const c = cat(item);
    const own = assets(item, 'media');
    const text = c === 'x' ? item.title : c === 'rss' ? item.title : '';
    // A short post with nothing else is the tile: 22 px; the rest wraps in the reading font and is clamped.
    const big = (c === 'x' && !own.length && !item.quote && text.length <= 110) || (c === 'rss' && text.length <= 70);
    let body;
    if (c === 'x') body = [via(item), h('p', { class: `feed-text${big ? ' feed-text-big' : ''}`, style: { '--lines': String(own.length ? 4 : item.quote ? 7 : 14) } }, text), own.length ? pics(item, 'media', 'feed-pics') : null, quoteBox(item)];
    else if (c === 'youtube') body = [h('p', { class: 'feed-text feed-text-title feed-text-big', style: { '--lines': '6' } }, item.title), videoMeta(item, false)];
    else if (c === 'instagram') body = [own.length ? pics(item, 'media', 'feed-pics feed-pics-ig') : null, item.kind === 'post' && item.title ? h('p', { class: 'feed-text', style: { '--lines': '3' } }, item.title) : null];
    else body = [h('p', { class: `feed-text feed-text-title${big ? ' feed-text-big' : ''}`, style: { '--lines': '5' } }, item.title || item.url), articleText(item) ? h('p', { class: 'feed-text feed-muted', style: { '--lines': '8' } }, articleText(item)) : null];
    return h('article', { class: `feed-tile feed-tile-${c}${state.sel === item.id ? ' sel' : ''}${!own.length ? ' textual' : ''}`, tabindex: '0', 'data-feed-id': item.id, 'data-key': item.id,
      'aria-label': `${catName(c)}: ${c === 'x' ? item.name || item.author : item.author}`,
      onclick: (e) => { if (!e.target.closest('a')) openReader(item.id); }, onfocus: () => { state.sel = item.id; } }, head(item), body);
  }
  function openReader(id) { state.reader = id; state.sel = id; refresh(); requestAnimationFrame(() => document.querySelector('.feed-read')?.focus()); }
  function closeReader() {
    const id = state.reader; state.reader = null;
    // A post read past the drawn tiles gets its page drawn, so the focus has somewhere to land.
    const at = shown.findIndex((x) => x.id === id);
    if (at >= state.limit) state.limit = (Math.floor(at / PAGE) + 1) * PAGE;
    refresh();
    requestAnimationFrame(() => { const el = document.querySelector(`.feed-tile[data-feed-id="${CSS.escape(id || '')}"]`); el?.scrollIntoView({ block: 'nearest' }); el?.focus(); });
  }
  function step(d) { const i = shown.findIndex((x) => x.id === state.reader); const next = shown[i + d]; if (next) openReader(next.id); }
  /** One item at a time, whole: full text with links, every picture large, videos played here, counts and actions. */
  function reader(item) {
    const c = cat(item);
    const i = shown.findIndex((x) => x.id === item.id);
    for (const [a, n] of (item.media || []).map((a, n) => [a, n])) if (a.type === 'image') want(item, n);
    const big = (role) => assets(item, role).map(([a, n]) => {
      const v = media.get(`${item.id}:${n}`);
      if (a.type === 'video') return v?.url ? h('video', { class: 'feed-read-img', src: v.url, controls: true, autoplay: true, playsinline: true })
        : h('button', { class: 'feed-pic feed-read-video', onclick: () => want(item, n), 'aria-label': T('Prehrať video') }, pic(item, posterOf(item, a), 'feed-img'), h('span', { class: 'feed-play' }, v?.busy ? '…' : icon('play')));
      if (v?.error) return h('div', { class: 'feed-muted' }, v.error, ' ', h('button', { class: 'ghost', onclick: () => retry(item, n) }, T('Skúsiť znova')));
      return pic(item, n, 'feed-read-img', item.author);
    });
    const counts = item.counts || {};
    const doc = state.doc;
    return h('article', { class: `feed-read feed-read-${c}`, tabindex: '-1', 'aria-label': T`Čítanie: ${item.title || item.author}` },
      h('div', { class: 'feed-read-nav' },
        h('button', { class: 'ghost', disabled: i <= 0, onclick: () => step(-1) }, icon('chevron-left'), T('Novšie')),
        h('span', { class: 'feed-muted' }, `${i + 1} / ${shown.length}`),
        h('button', { class: 'ghost', disabled: i >= shown.length - 1, onclick: () => step(1) }, T('Staršie'), icon('chevron-right')),
        h('button', { class: 'ghost feed-read-close', onclick: closeReader, 'aria-label': T('Späť na feed') }, icon('close'), h('kbd', {}, 'Esc'))),
      head(item, true), via(item),
      c === 'youtube' ? [h('p', { class: 'feed-text feed-text-title feed-text-big' }, item.title), videoMeta(item), item.text ? h('p', { class: 'feed-text feed-muted' }, linkify(item.text)) : null]
        : c === 'rss' ? [h('p', { class: 'feed-text feed-text-title feed-text-big' }, item.title || item.url), articleText(item) ? h('p', { class: 'feed-text' }, linkify(articleText(item))) : null]
          : [item.title && item.title !== 'Story' ? h('p', { class: 'feed-text' }, linkify(item.title)) : null, h('div', { class: 'feed-read-pics' }, big('media')), quoteBox(item, true)],
      Object.keys(counts).length ? h('div', { class: 'feed-counts' },
        counts.replies != null ? h('span', {}, T`${counts.replies} odpovedí`) : null, counts.reposts != null ? h('span', {}, T`${counts.reposts} zdieľaní`) : null,
        counts.likes != null ? h('span', {}, T`${counts.likes} páči sa`) : null, counts.views != null && c !== 'youtube' ? h('span', {}, T`${counts.views} zobrazení`) : null) : null,
      h('div', { class: 'feed-actions' },
        item.url ? h('a', { class: 'ghost button', href: item.url, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), T('Otvoriť originál'), h('kbd', {}, 'O')) : null,
        c === 'youtube' ? h('button', { class: 'ghost', onclick: () => schedule(item) }, icon('calendar'), T('Naplánovať pozeranie')) : null,
        item.kind === 'story' ? h('button', { class: 'ghost', onclick: () => { hide(item); closeReader(); } }, T`Skryť stories od @${item.author}`) : null,
        item.user ? h('button', { class: 'ghost danger', disabled: state.busy || offline() || doc?.instagramPaused, onclick: () => unfollow(item) }, T('Prestať sledovať')) : null));
  }
  // Tiles are watched once each; when one nears the screen its pictures are fetched.
  let io = null;
  const byId = new Map();
  function watchTiles() {
    if (!('IntersectionObserver' in window)) { for (const item of shown) for (const n of needed(item)) want(item, n); return; }
    io ||= new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); const item = byId.get(e.target.dataset.feedId); if (item) for (const n of needed(item)) want(item, n); }
    }, { rootMargin: '300px' });
    for (const el of document.querySelectorAll('.feed-tile[data-feed-id]')) if (!el._watched) { el._watched = true; io.observe(el); }
  }
  /** Feed's keys while it has the keyboard: 1–5 categories, arrows move between tiles, Enter reads, O opens the
   *  original; in the reader ←/→ move and Esc goes back. Returns whether the key was Feed's. */
  function onKey(e) {
    if (!isOpen() || e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = e.key;
    const item = shown.find((x) => x.id === (state.reader || state.sel));
    if (state.reader) {
      if (k === 'Escape') { closeReader(); return true; }
      // Arrows on a focused video seek it.
      if (e.target?.tagName === 'VIDEO') return false;
      if (k === 'ArrowRight' || k === 'j') { step(1); return true; }
      if (k === 'ArrowLeft' || k === 'k') { step(-1); return true; }
    }
    if (!document.activeElement?.closest?.('.daily-feed')) return false;
    if ((k === 'o' || k === 'O') && item?.url) { window.open(item.url, '_blank', 'noopener'); return true; }
    if (state.reader) return false;
    if (/^[1-5]$/.test(k)) { setFilter(CATS[Number(k) - 1]); return true; }
    if (k === 'Enter' && item && document.activeElement?.classList.contains('feed-tile')) { openReader(item.id); return true; }
    const moves = { ArrowRight: 1, ArrowLeft: -1, j: 1, k: -1 };
    const grid = document.querySelector('.feed-grid');
    const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 1;
    const d = moves[k] ?? (k === 'ArrowDown' ? cols : k === 'ArrowUp' ? -cols : 0);
    if (!d) return false;
    const i = shown.findIndex((x) => x.id === state.sel);
    const next = shown[Math.max(0, Math.min(shown.length - 1, i < 0 ? 0 : i + d))];
    if (!next) return true;
    state.sel = next.id;
    const go = () => { const el = document.querySelector(`.feed-tile[data-feed-id="${CSS.escape(next.id)}"]`); el?.focus(); el?.scrollIntoView({ block: 'nearest' }); };
    // Past the drawn tiles: draw the next page first.
    if (shown.indexOf(next) >= state.limit) { state.limit += PAGE; refresh(); requestAnimationFrame(go); } else go();
    return true;
  }
  function view() {
    const doc = state.doc;
    const w = readingWindow();
    const open = active();
    // Today's windows were all used (a window still running from before midnight leaves today's free).
    const locked = !open && windowsLeft() === 0;
    const p = policy();
    const all = visible();
    const f = filter();
    shown = f === 'all' ? all : all.filter((i) => cat(i) === f);
    byId.clear(); for (const i of shown) byId.set(i.id, i);
    const count = (c) => (c === 'all' ? all.length : all.filter((i) => cat(i) === c).length);
    const igProblem = instagramProblem(doc);
    const otherErrors = (doc?.errors || []).filter((e) => e.source !== 'instagram');
    const current = state.reader && shown.find((i) => i.id === state.reader);
    if (state.reader && !current) state.reader = null;
    if (open && !current) requestAnimationFrame(watchTiles);
    // One grid, newest first: a heading per day would break rows (one video a day left a row each); tiles carry the day.
    // YouTube alone is a list of titles, like its app without thumbnails.
    const list = f === 'youtube';
    const grid = shown.slice(0, state.limit).map(list ? videoRow : tile);
    // Many failed sources make one line, not a wall of them.
    const failed = otherErrors.length > 2 ? [{ message: T`${otherErrors.length} zdrojov sa nenačítalo: ${otherErrors.map((e) => e.message.replace(/ sa nenačítal[o]?\.$/, '')).join(', ')}.` }] : otherErrors;
    return h('section', { class: 'daily-feed', 'aria-label': T('Denný feed') },
      h('div', { class: 'feed-head' }, h('h2', {}, 'Feed'),
        h('span', { class: 'feed-date' }, doc?.at ? T`obnovené ${new Date(doc.at).toLocaleString(LOCALE, { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''),
        open ? h('span', { class: 'feed-window', title: T('Feed a nové správy sú otvorené do tohto času. Odchodom sa okno nezavrie.') }, T`okno do ${hm(w.end)}`) : null,
        h('button', { class: 'ghost', disabled: state.busy || offline() || !open, onclick: update }, state.busy ? T('Načítavam…') : T('Obnoviť')),
        h('button', { class: 'ghost', onclick: settingsPanel }, T('Zdroje a filtre'))),
      state.error ? h('p', { class: 'err', role: 'status' }, state.error) : null,
      !open ? h('p', { class: 'feed-note' }, T`Okná na čítanie sú spoločné pre feed aj nové správy${p ? T`: ${p.count}× denne po ${p.minutes} min` : ''}.${windowsLeft() ? T` Dnes ešte ${windowsLeft()}.` : ''}`) : null,
      locked ? h('p', { class: 'feed-empty' }, w?.end ? T`Dnešné okná sa minuli, posledné skončilo o ${hm(w.end)}. Ďalšie sa otvorí zajtra.` : T('Dnešné okná sa minuli. Ďalšie sa otvorí zajtra.'))
        : !open ? h('button', { class: 'primary', disabled: !!opening || offline(), onclick: openWindow }, opening ? T('Otváram…') : T`Otvoriť feed a správy na ${minutes()} min`)
        : [
          h('div', { class: 'feed-filters', role: 'radiogroup', 'aria-label': T('Kategória') }, CATS.map((c, n) => {
            const warn = c === 'instagram' && igProblem;
            return h('button', { class: f === c ? 'on' : '', role: 'radio', 'aria-checked': String(f === c), title: warn ? igProblem : T`Kláves ${n + 1}`, onclick: () => setFilter(c) },
              c === 'all' ? null : logo(c), catName(c), h('span', { class: warn ? 'n warn' : 'n' }, warn ? '!' : String(count(c))));
          }), h('span', { class: 'feed-keys' }, T('1–5 kategória, šípky, Enter čítať, O originál'))),
          igProblem && (f === 'all' || f === 'instagram') ? instagramRow(doc, igProblem) : null,
          failed.map((err) => h('p', { class: 'feed-note', role: 'status' }, err.message)),
          current ? reader(current)
            : !shown.length ? h('div', { class: 'feed-empty' }, state.busy ? T('Načítavam dnešný feed…') : f === 'all' ? T('Zatiaľ žiadne položky. Zdroje pridáš v Zdroje a filtre.') : T`V kategórii ${catName(f)} dnes nič nie je.`)
              : [h('div', { class: list ? 'feed-grid feed-list' : 'feed-grid' }, grid),
                shown.length > state.limit ? h('button', { class: 'ghost feed-more', onclick: () => { state.limit += PAGE; refresh(); } }, T`Zobraziť ďalšie (${shown.length - state.limit})`) : null],
        ],
      open ? h('button', { class: 'ghost feed-finish', onclick: finish }, T('Skončiť okno')) : null);
  }
  // Settings → Feed: the sources first, then what is hidden, then how Feed behaves, in short notes.
  const AI_SOURCES = [
    { url: 'https://openai.com/news/rss.xml', name: 'OpenAI News' },
    { url: 'https://deepmind.google/blog/rss.xml', name: 'Google DeepMind' },
    { url: 'https://blog.google/innovation-and-ai/technology/ai/rss/', name: 'Google AI' },
    { url: 'https://huggingface.co/blog/feed.xml', name: 'Hugging Face' },
    { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', name: 'The Verge AI' },
    { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', name: 'TechCrunch AI' },
    { url: 'https://www.technologyreview.com/feed/', name: 'MIT Technology Review' },
    { url: 'https://simonwillison.net/atom/everything/', name: 'Simon Willison' },
    { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', name: 'Ars Technica' },
  ];
  async function addAiNews() {
    const c = cfg();
    const existing = new Set(c.sources.map((s) => s.url));
    const merged = [...c.sources, ...AI_SOURCES.filter((s) => !existing.has(s.url)).map((s) => ({ id: s.url, url: s.url, name: s.name }))];
    await configure({ sources: merged });
  }
  function extractYouTubeUrls(text) {
    const urls = new Set();
    const opml = text.match(/xmlUrl="([^"]+)"/gi) || [];
    for (const m of opml) { const u = m.match(/xmlUrl="([^"]+)"/i)?.[1]; if (u) urls.add(u); }
    const direct = text.match(/https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=[A-Za-z0-9_-]+/g) || [];
    direct.forEach((u) => urls.add(u));
    // Google Takeout CSV: find channel IDs (UC...)
    for (const line of text.split(/\r?\n/)) {
      for (const col of line.split(/[;,]/)) {
        const id = col.trim().replace(/^"|"$/g, '');
        if (/^UC[A-Za-z0-9_-]{20,}$/.test(id)) urls.add(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
      }
    }
    return [...urls];
  }
  async function importOpml(text) {
    const urls = extractYouTubeUrls(text);
    if (!urls.length) { state.error = T('V súbore/texte sa nenašli žiadne YouTube kanály.'); refresh(); return; }
    const c = cfg();
    const existing = new Set(c.sources.map((s) => s.url));
    const merged = [...c.sources, ...urls.filter((u) => !existing.has(u)).map((u) => ({ id: u, url: u, name: '' }))];
    await configure({ sources: merged });
    state.error = T`Importovaných ${urls.length} YouTube kanálov.`;
    refresh();
  }
  function settings() {
    const c = cfg();
    const hidden = Object.entries(c.hiddenStories);
    const unfollowed = (state.doc?.users || []).filter((u) => u.following === false);
    return [
      state.error ? h('p', { class: 'err', role: 'status' }, state.error) : null,
      h('h3', {}, 'Instagram'),
      h('p', { class: 'hint' }, state.doc?.instagramConnected ? T('Instagram je pripojený pre feed a stories.') : T('Prihlásenie v Účtoch pripája správy. Feed a stories pripojíš tu.')),
      h('div', { class: 'row' },
        h('button', { class: 'primary', disabled: state.busy || offline() || !window.desktop?.collect || state.doc?.instagramPaused, onclick: connectInstagram }, state.busy ? T('Pripájam…') : state.doc?.instagramConnected ? T('Znova prihlásiť feed') : T('Pripojiť Instagram')),
        state.doc?.instagramConnected ? h('button', { class: 'ghost', disabled: state.busy || offline(), onclick: disconnectInstagram }, T('Odpojiť')) : null),
      !window.desktop?.collect ? h('p', { class: 'hint' }, T('Instagram pripojíš v desktopovej appke Weft. Potom feed uvidíš aj tu.')) : null,
      h('h3', {}, T('RSS, YouTube a X')),
      c.sources.length ? c.sources.map((s) => h('div', { class: 'feed-source', 'data-feed-source': s.id }, h('span', {}, s.name || s.url), h('button', { class: 'ghost danger', onclick: () => configure({ sources: c.sources.filter((x) => x.id !== s.id) }) }, T('Odstrániť'))))
        : h('p', { class: 'hint' }, T('Zatiaľ žiadny zdroj.')),
      h('form', { class: 'feed-add', onsubmit: (e) => { e.preventDefault(); if (!state.addUrl.trim()) return; const s = { id: state.addUrl, url: state.addUrl.trim(), name: state.addName.trim() }; state.addUrl = ''; state.addName = ''; configure({ sources: [...c.sources, s] }); } },
        h('input', { value: state.addUrl, required: true, placeholder: T('RSS, kanál YouTube alebo profil na X'), 'aria-label': T('Adresa zdroja'), 'data-root': '__feedUrl', oninput: (e) => { state.addUrl = e.target.value; } }),
        h('input', { value: state.addName, placeholder: T('Názov (nepovinné)'), 'aria-label': T('Názov zdroja'), 'data-root': '__feedName', oninput: (e) => { state.addName = e.target.value; } }),
        h('button', { class: 'primary', type: 'submit' }, T('Pridať zdroj'))),
      h('p', { class: 'hint' }, T('Napríklad youtube.com/@theo, odkaz na video z kanála, x.com/theo alebo adresa RSS. Videá YouTube sú iba textové; X sa číta bez prihlásenia. Obnoviť ich načíta znova najskôr po 10 minútach, Instagram raz denne.')),
      h('h3', {}, T('YouTube odbery (hromadný import)')),
      h('p', { class: 'hint' }, T('Na takeout.google.com vyber iba YouTube → odbery a z archívu vlož alebo nahraj súbor subscriptions.csv:')),
      h('textarea', { rows: 4, placeholder: T('Vlož sem obsah subscriptions.csv…'), 'aria-label': T('Odbery YouTube'), oninput: (e) => { state._opml = e.target.value; } }),
      h('div', { class: 'row' },
        h('button', { class: 'ghost', disabled: state.busy || offline(), onclick: () => { if (state._opml) importOpml(state._opml); } }, T('Importovať z textu')),
        // A real button, so the keyboard reaches it; it opens the hidden file input right after it.
        h('button', { class: 'ghost', type: 'button', disabled: state.busy || offline(), onclick: (e) => e.currentTarget.nextElementSibling?.click() }, T('Nahrať súbor')),
        h('input', { type: 'file', accept: '.csv,.opml,.xml,.txt', hidden: true, 'aria-label': T('Nahrať súbor'), onchange: (e) => { const f = e.target.files && e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => importOpml(r.result); r.readAsText(f); e.target.value = ''; } })),
      h('h3', {}, T('AI novinky (modely a firmy)')),
      h('p', { class: 'hint' }, T('Pridá predvolené zdroje: OpenAI, Google DeepMind, Google AI, Hugging Face, The Verge, TechCrunch, MIT Tech Review, Simon Willison, Ars Technica.')),
      h('button', { class: 'ghost', disabled: state.busy || offline(), onclick: addAiNews }, T('Pridať AI novinky')),
      h('h3', {}, T('Skryté stories')),
      hidden.length ? hidden.map(([id, name]) => h('div', { class: 'feed-source' }, h('span', {}, `@${name}`),
        h('button', { class: 'ghost', onclick: () => hide({ user: id }, false) }, T('Znova zobrazovať')))) : h('p', { class: 'hint' }, T('Žiadne. Účet skryješ pri jeho story; skrytie platí iba vo Wefte.')),
      unfollowed.length ? [h('h3', {}, T('Zrušené sledovanie')),
        unfollowed.map((u) => h('div', { class: 'feed-source' }, h('a', { href: `https://www.instagram.com/${encodeURIComponent(u.username)}/`, target: '_blank', rel: 'noopener noreferrer' }, T`@${u.username} na Instagrame`))),
        h('p', { class: 'hint' }, T('Znova sledovať účet môžeš na jeho profile.'))] : null,
      h('h3', {}, T('Ako funguje')),
      h('p', { class: 'hint' }, T`Feed sa otvára spolu s novými správami v oknách na čítanie. Koľko ich je denne a ako dlho trvajú, nastavíš v Nastavenia → Správy (platí od zajtra). Odchodom sa okno nezavrie a ďalšie kliknutie ho nepredĺži. Stories sa neoznačujú za videné.`),
      h('p', { class: 'hint' }, T('Pripojenie a odpojenie feedu nemení prihlásenie správ. Instagram môže príspevky obmedziť; vtedy ostanú dostupné stories.')),
    ];
  }
  function clear() { leave(); generation++; flushing = null; queue.length = 0; for (const m of media.values()) if (m.url) URL.revokeObjectURL(m.url); media.clear(); state.doc = null; state.open = null; state.busy = false; state.error = ''; }
  return { load, enter, leave, openWindow, policy, setPolicy, view, settings, flush, clear, key: onKey };
}

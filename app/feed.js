// Explicit daily reading inside the shared reading windows: the feed server opens a few a day (policy: count and
// minutes, changed in Settings from tomorrow on) for Feed and Weft's waiting messages together (readingWindow/onWindow).
// Leaving Feed keeps one; it ends by itself or with "Skončiť okno", and nothing on this device (reload, cleared
// storage) gives back a used one.
import { T, LOCALE } from './i18n.js';
export function createFeed({ h, api, kv, refresh, offline, user, settingsPanel, schedule, close, isOpen = () => false, readingWindow, onWindow, windowsLeft }) {
  const state = { doc: null, busy: false, error: '', open: null, addUrl: '', addName: '' };
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
  async function download(item, index) {
    const id = `${item.id}:${index}`;
    if (!active() || media.has(id)) return;
    const run = generation;
    media.set(id, { busy: true }); refresh();
    try {
      let blob = await kv('readonly', (st) => st.get(`feed-media:${user()}:${id}`)).catch(() => null);
      if (!blob && !offline()) {
        blob = await api('MEDIA', `/media?id=${encodeURIComponent(item.id)}&n=${index}`);
        if (run !== generation) return;
        // Keep only a bounded set of viewed media, not an ever-growing history.
        await kv('readwrite', (st) => { const put = st.put(blob, `feed-media:${user()}:${id}`); const keys = st.getAllKeys(); keys.onsuccess = () => { const old = keys.result.filter((k) => String(k).startsWith('feed-media:')); for (const k of old.slice(0, Math.max(0, old.length - 60))) st.delete(k); }; return put; }).catch(() => {});
      }
      if (run !== generation) return;
      if (!blob) throw new Error(T('Toto médium ešte nie je uložené offline.'));
      media.set(id, { url: URL.createObjectURL(blob) });
    } catch (err) { if (run === generation) media.set(id, { error: err.message }); }
    refresh();
  }
  function viewMedia(item) {
    return h('div', { class: 'feed-media' }, (item.media || []).map((asset, index) => {
      const value = media.get(`${item.id}:${index}`);
      if (!value) return h('button', { class: 'ghost', onclick: () => download(item, index) }, asset.type === 'video' ? T('Načítať video') : T('Načítať fotku'));
      if (value.busy) return h('p', {}, T('Načítavam médium…'));
      if (value.error) return h('div', {}, h('p', { role: 'status' }, value.error), h('button', { class: 'ghost', onclick: () => { media.delete(`${item.id}:${index}`); download(item, index); } }, T('Skúsiť znova')));
      return asset.type === 'video' ? h('video', { src: value.url, controls: true, preload: 'metadata', playsinline: true }) : h('img', { src: value.url, alt: `${item.author}: ${item.kind === 'story' ? 'story' : T('príspevok')}` });
    }));
  }
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
  function leave() { state.open = null; }
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
  function view() {
    const doc = state.doc;
    const c = cfg();
    const w = readingWindow();
    const open = active();
    // Today's windows were all used (a window still running from before midnight leaves today's free).
    const locked = !open && windowsLeft() === 0;
    const p = policy();
    const items = (doc?.items || []).filter((i) => (i.source === 'instagram' ? c.instagram : c.sources.some((s) => s.id === i.source)) && !(i.kind === 'story' && c.hiddenStories[i.user]));
    return h('section', { class: 'daily-feed', 'aria-label': T('Denný feed') },
      h('div', { class: 'feed-head' }, h('h2', {}, 'Feed'),
        h('span', { class: 'feed-date' }, doc?.at ? T`Obnovené ${new Date(doc.at).toLocaleString(LOCALE)}` : T('RSS, YouTube, X a Instagram')),
        h('button', { class: 'ghost', disabled: state.busy || offline() || !open, onclick: update }, state.busy ? T('Načítavam…') : T('Obnoviť')),
        h('button', { class: 'ghost', onclick: settingsPanel }, T('Zdroje a filtre'))),
      state.error ? h('p', { class: 'err', role: 'status' }, state.error) : null,
      (doc?.errors || []).map((err) => h('p', { class: 'feed-note', role: 'status' }, err.message)),
      doc?.coverage?.postsError ? h('p', { class: 'feed-note', role: 'status' }, doc.coverage.postsError) : null,
      h('p', { class: 'feed-note' }, open ? T`Feed a nové správy sú otvorené do ${hm(w.end)}. Odchodom sa okno nezavrie.`
        : T`Okná na čítanie sú spoločné pre feed aj nové správy${p ? T`: ${p.count}× denne po ${p.minutes} min` : ''}.${windowsLeft() ? T` Dnes ešte ${windowsLeft()}.` : ''}`),
      !doc?.instagramConnected ? h('p', { class: 'feed-note' }, T('Pripoj Instagram cez Zdroje a filtre, aby sa načítali stories a príspevky.')) : null,
      doc?.coverage?.bounded ? h('p', { class: 'feed-note' }, T('Dnešný výber je obmedzený na jednu dávku Instagramu. Nie je to celý zoznam sledovaných.')) : null,
      locked ? h('p', { class: 'feed-empty' }, w?.end ? T`Dnešné okná sa minuli, posledné skončilo o ${hm(w.end)}. Ďalšie sa otvorí zajtra.` : T('Dnešné okná sa minuli. Ďalšie sa otvorí zajtra.'))
        : !open ? h('button', { class: 'primary', disabled: !!opening || offline(), onclick: openWindow }, opening ? T('Otváram…') : T`Otvoriť feed a správy na ${minutes()} min`)
        : !items.length ? h('div', { class: 'feed-empty' }, state.busy ? T('Načítavam dnešný feed…') : T('Zatiaľ žiadne položky. Zdroje pridáš v Nastaveniach → Feed.'))
          : h('div', { class: 'feed-list' }, items.map((item) => h('article', { class: 'feed-item', 'data-feed-id': item.id },
            h('div', { class: 'feed-byline' }, h('span', { class: `feed-kind feed-kind-${item.kind === 'story' || item.kind === 'post' ? 'ig' : item.kind === 'youtube' ? 'yt' : item.kind === 'x' ? 'x' : 'rss'}` }, item.kind === 'story' || item.kind === 'post' ? 'I' : item.kind === 'youtube' ? 'Y' : item.kind === 'x' ? 'X' : 'R'), h('b', {}, item.author), h('span', { class: 'feed-kind-label' }, item.kind === 'story' ? 'Story' : item.kind === 'post' ? 'Instagram' : item.kind === 'youtube' ? 'YouTube' : item.kind === 'x' ? 'X' : 'RSS'),
              h('time', { datetime: item.at ? new Date(item.at).toISOString() : undefined }, item.at ? new Date(item.at).toLocaleString(LOCALE, { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : T('Bez dátumu'))),
            item.kind === 'story' || item.kind === 'post'
              ? h('button', { class: 'feed-title', 'aria-expanded': String(state.open === item.id), onclick: () => { state.open = state.open === item.id ? null : item.id; if (state.open && item.media?.length) download(item, 0); refresh(); } }, item.title || T('Príspevok'))
              : h('a', { class: 'feed-title', href: item.url, target: '_blank', rel: 'noopener noreferrer' }, item.title || item.url),
            item.text ? h('p', {}, item.text) : null,
            state.open === item.id || (item.kind === 'x' && item.media?.length) ? viewMedia(item) : null,
            h('div', { class: 'feed-actions' },
              item.kind === 'story' ? h('button', { class: 'ghost', onclick: () => hide(item) }, T`Skryť stories od @${item.author}`) : null,
              item.user ? h('button', { class: 'ghost danger', disabled: state.busy || offline() || doc?.instagramPaused, onclick: () => unfollow(item) }, T('Prestať sledovať')) : null,
              item.kind === 'youtube' ? h('button', { class: 'ghost', onclick: () => schedule(item) }, T('Naplánovať pozeranie')) : null)))),
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
        h('label', { class: 'ghost', style: 'cursor:pointer' }, T('Nahrať súbor'),
          h('input', { type: 'file', accept: '.csv,.opml,.xml,.txt', style: 'display:none', onchange: (e) => { const f = e.target.files && e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => importOpml(r.result); r.readAsText(f); e.target.value = ''; } }))),
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
  function clear() { leave(); generation++; flushing = null; for (const m of media.values()) if (m.url) URL.revokeObjectURL(m.url); media.clear(); state.doc = null; state.open = null; state.busy = false; state.error = ''; }
  return { load, enter, leave, openWindow, policy, setPolicy, view, settings, flush, clear };
}

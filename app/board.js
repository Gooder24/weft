// The board („Nástenka“, Ctrl+B) of the desktop app: files and text go to Karchi's own devices that run the LocalSend
// app, without picking one (the default devices get it), and what they send stays here until it is deleted. The shell
// speaks LocalSend (desktop/localsend.js, desktop/main.js) and saves arrivals in Downloads/Weft; this file is the
// view, its keys and the corner window an arrival shows. In a browser there is no board (window.desktop is missing).
import { T, LOCALE } from './i18n.js';
import { icon } from './icons.js';

const BUSY = new Set(['sending', 'receiving']);
const ASK_SEEN_MS = 1000; // a stranger's files or text are accepted by Enter only once the question was this long in sight
const size = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
const LINK = /^https?:\/\/\S+$/;

/** What a send or arrival came to, in words. */
export function statusText(it) {
  const pct = it.total ? Math.min(99, Math.floor((it.got / it.total) * 100)) : 0;
  const targets = it.targets || [];
  // A device that has it asks its user (files) or shows it until closed (text); then it answers.
  if (it.status === 'sending' && (!targets.length || targets.some((t) => t.status === 'sending'))) return T`posiela sa ${pct} %`;
  if (it.status === 'receiving') return T`prijíma sa ${pct} %`;
  if (it.dir === 'in') return { partial: T('prišla len časť'), stopped: T('prerušené'), cancelled: T('zrušené odosielateľom') }[it.status] || '';
  const one = (s) => ({
    done: T('doručené'), busy: T('zariadenie práve prijíma niečo iné'), declined: T('odmietnuté'), pin: T('zariadenie chce PIN: vypni ho v LocalSende'),
    offline: T('zariadenie nie je dostupné'), failed: T('nepodarilo sa'), stopped: T('prerušené'), sending: T('posiela sa'),
    waiting: it.text != null ? T('zobrazené na zariadení') : T('čaká, kým to na zariadení prijmeš'),
  }[s] || s);
  if (targets.length > 1 && new Set(targets.map((t) => t.status)).size > 1) return targets.map((t) => `${t.alias}: ${one(t.status)}`).join(' · ');
  return one(targets[0]?.status || it.status);
}

export function createBoard({ h, render, isOpen, open }) {
  const api = window.desktop?.board;
  const b = { st: null, sel: null, text: '', pop: null, copied: null, note: '', notes: new Map() };
  const items = () => b.st?.items || [];
  const devices = () => b.st?.devices || [];
  const targets = () => devices().filter((d) => d.default);
  const find = (id) => items().find((x) => x.id === id);
  const time = (at) => new Date(at).toLocaleString(LOCALE, { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

  function notify(title, body, tag) {
    if (document.hasFocus() || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, { body, tag, icon: '/icon.svg' });
      n.onclick = () => { window.desktop?.focus?.(); window.focus(); n.close(); };
      b.notes.set(tag, n);
    } catch { /* no notifications here: the corner window still shows */ }
  }
  const unnotify = (tag) => { b.notes.get(tag)?.close(); b.notes.delete(tag); };

  if (api) {
    api.on((ev) => {
      b.st = ev.state;
      if (ev.type === 'arrived' && !isOpen()) {
        b.pop = ev.item.id;
        const what = ev.item.text != null ? ev.item.text.slice(0, 80) : ev.item.files.map((f) => f.name).join(', ');
        notify(T`Prišlo z ${ev.item.device.alias}`, what, 'weft-board');
      }
      if (ev.type === 'ask') {
        const { device, text } = ev.state.ask;
        if (text != null) notify(T`${device.alias} posiela text`, T('Prijmi ho vo Wefte.'), 'weft-board-ask');
        else notify(T`${device.alias} posiela súbory`, T('Prijmi ich vo Wefte.'), 'weft-board-ask');
      }
      if (!ev.state.ask) unnotify('weft-board-ask');
      render();
    });
    api.call('state').then((st) => { b.st ||= st; render(); }).catch(() => {});
  }

  /** Text, or files from a drop, the file picker or Ctrl+V, to the default devices. */
  async function send({ files, text, fromBox }) {
    if (!targets().length) { b.note = T('Najprv vyber zariadenie, kam to pôjde.'); return render(); }
    b.note = '';
    try {
      const r = await api.send({ files: files ? [...files] : [], text });
      if (r?.error === 'no-device') b.note = T('Najprv vyber zariadenie, kam to pôjde.');
      else if (r?.error) b.note = T('Nebolo čo poslať.');
      else if (fromBox) b.text = '';
    } catch (err) {
      b.note = T`Neodišlo: ${err.message}`;
    }
    render();
  }
  const sendText = () => { const text = b.text.trim(); if (text) send({ text, fromBox: true }); };
  function pick() {
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true });
    input.onchange = () => { if (input.files.length) send({ files: input.files }); };
    input.click();
  }
  const dropped = (e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) send({ files: e.dataTransfer.files }); else if (e.dataTransfer?.getData('text')) send({ text: e.dataTransfer.getData('text') }); };

  async function copy(it) {
    try { await navigator.clipboard.writeText(it.text); b.copied = it.id; } catch { b.note = T('Text sa nedal skopírovať; označ ho a skopíruj sám.'); }
    render();
    setTimeout(() => { if (b.copied === it.id) { b.copied = null; render(); } }, 1200);
  }
  /** The files of an item that can be opened: all that go out, of what came in those that arrived whole. */
  const whole = (it) => (it.files || []).map((_, i) => i).filter((i) => it.dir === 'out' || it.files[i].done);
  /** Enter on an item: copy a text, open a file (several: their folder), send again what did not go. */
  function primary(it) {
    if (!it || BUSY.has(it.status)) return;
    if (it.text != null && it.dir === 'in') return copy(it);
    if (it.dir === 'out' && !['done'].includes(it.status)) return api.call('retry', it.id).then((ok) => { if (!ok) { b.note = T('Znova to poslať nejde: súbor už nie je na disku alebo zariadenie bolo zabudnuté.'); render(); } });
    if (it.text != null) return copy(it);
    const can = whole(it);
    if (can.length === 1) return api.call('open', it.id, can[0]);
    if (can.length) return api.call('show', it.id, can[0]);
  }
  const primaryLabel = (it) => (it.text != null && (it.dir === 'in' || it.status === 'done') ? (b.copied === it.id ? T('Skopírované') : T('Kopírovať'))
    : it.dir === 'out' && it.status !== 'done' ? T('Skúsiť znova') : whole(it).length === 1 ? T('Otvoriť') : T('Priečinok'));
  /** Delete: off the board; what still goes out (or waits for the device) is stopped. */
  function remove(it) {
    if (!it || it.status === 'receiving') return;
    const list = items();
    const at = list.indexOf(it);
    b.sel = (list[at + 1] || list[at - 1])?.id || null;
    api.call('remove', it.id);
  }

  // ------------------------------------------------------------------ the panel

  function statusLine() {
    const me = b.st?.me;
    if (!me || (!me.listening && !me.error)) return T('Spúšťam LocalSend…'); // the first scan is still looking for Tailscale
    if (!me.listening && me.error === 'no-tailnet') return T('Tailscale na tomto počítači nebeží, takže nič neprijme. Zapni ho alebo „Aj v miestnej sieti“.');
    if (!me.listening) return me.error === 'port' ? T('Porty 53317 až 53320 sú obsadené, takže nič neprijme.') : T`Neprijíma: ${me.error}`;
    return [
      !me.lan ? T('Prijíma cez Tailscale') : me.tailnet ? T('Prijíma cez Tailscale aj v miestnej sieti') : T('Prijíma len v miestnej sieti (Tailscale na tomto počítači nebeží)'),
      me.port !== 53317 ? T`na porte ${me.port} (53317 má iná appka: v LocalSende pridaj tento počítač ručne)` : null,
      T`súbory ukladá do ${me.dir}`,
    ].filter(Boolean).join(' · ');
  }

  function deviceChip(d) {
    const seen = d.online ? T('dostupné') : T`naposledy ${time(d.seen)}`;
    return h('button', {
      class: `chip board-dev${d.default ? ' on' : ''}`, type: 'button', 'aria-pressed': String(!!d.default), 'data-key': `dev:${d.fingerprint}`,
      title: `${d.default ? T('Pôjde sem. Klik: už nie.') : T('Klik: posielať aj sem.')} ${d.via === 'tailnet' ? 'Tailscale' : T('miestna sieť')} · ${d.ip} · ${seen}`,
      onclick: () => api.call('default', d.fingerprint, !d.default),
    }, d.default ? icon('check') : null, h('span', {}, d.alias), h('small', {}, d.online ? '' : T('mimo')));
  }

  function itemRow(it) {
    const dirLabel = it.dir === 'in' ? T`z ${it.device?.alias || '?'}` : T`do ${(it.targets || []).map((t) => t.alias).join(', ')}`;
    const status = statusText(it);
    const busy = BUSY.has(it.status);
    const flowing = it.status === 'receiving' || (it.status === 'sending' && (it.targets || []).some((t) => t.status === 'sending'));
    const bad = it.dir === 'out' ? !['done', 'sending'].includes(it.status) : ['partial', 'stopped', 'cancelled'].includes(it.status);
    return h('div', {
      class: `board-item${b.sel === it.id ? ' sel' : ''}`, 'data-key': it.id, role: 'option', 'aria-selected': String(b.sel === it.id),
      onclick: (e) => { if (!e.target.closest('button, a')) { b.sel = it.id; render(); } },
      ondblclick: (e) => { if (!e.target.closest('button, a')) primary(it); },
    },
    icon(it.dir === 'in' ? 'arrow-down' : 'arrow-up'),
    h('div', { class: 'board-what' },
      it.text != null
        ? h('p', { class: 'board-text' }, LINK.test(it.text.trim()) ? h('a', { href: it.text.trim(), target: '_blank', rel: 'noreferrer' }, it.text.trim()) : it.text)
        : h('ul', { class: 'board-files' }, it.files.slice(0, 6).map((f, i) => h('li', {},
          f.done || it.dir === 'out'
            ? h('button', { class: 'linkbtn', type: 'button', title: T('Otvoriť'), onclick: () => api.call('open', it.id, i) }, f.name)
            : h('span', {}, f.name),
          h('small', {}, ` ${size(f.size)}`))),
        it.files.length > 6 ? h('li', {}, h('small', {}, T`a ďalších ${it.files.length - 6}`)) : null),
      h('small', { class: bad ? 'err' : '' }, [dirLabel, time(it.at), status].filter(Boolean).join(' · ')),
      flowing ? h('progress', { max: it.total || 1, value: it.got || 0 }) : null),
    h('div', { class: 'board-acts' },
      busy || (it.text == null && !whole(it).length) ? null : h('button', { class: 'ghost', type: 'button', onclick: () => primary(it) }, primaryLabel(it)),
      it.files && it.dir === 'in' && !busy && whole(it).length === 1 ? h('button', { class: 'ghost', type: 'button', onclick: () => api.call('show', it.id, whole(it)[0]) }, T('Priečinok')) : null,
      it.status === 'sending' ? h('button', { class: 'ghost', type: 'button', title: T('Prestať posielať a zmazať z nástenky'), onclick: () => remove(it) }, icon('close'), T('Zrušiť'))
        : busy ? null : h('button', { class: 'ghost', type: 'button', title: T('Zmazať z nástenky (súbor na disku ostane)'), 'aria-label': T('Zmazať z nástenky'), onclick: () => remove(it) }, icon('trash'))));
  }

  function view() {
    if (!api) return h('div', { class: 'board' }, h('h2', {}, T('Nástenka')), h('p', {}, T('Nástenka posiela cez LocalSend, a to vie len desktopová appka Weft.')));
    const shown = devices().filter((d) => d.default || d.online);
    const to = targets();
    return h('div', { class: 'board', ondragover: (e) => e.preventDefault(), ondrop: dropped },
      h('h2', {}, T('Nástenka')),
      h('p', { class: 'board-status' }, statusLine()),
      h('div', { class: 'board-send' },
        h('textarea', {
          rows: 2, value: b.text, 'data-root': '__boardText', 'aria-label': T('Text alebo odkaz na poslanie'),
          placeholder: T('Text alebo odkaz. Súbory sem potiahni, vlož (Ctrl+V) alebo pridaj.'),
          oninput: (e) => { b.text = e.target.value; },
          onkeydown: (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(); }
            // ↓ in the empty box goes down to the list (as in a chat); ↑ from its first item comes back.
            if (e.key === 'ArrowDown' && !e.currentTarget.value && items().length) { e.preventDefault(); e.currentTarget.blur(); select(b.sel && find(b.sel) ? b.sel : items()[0].id); }
          },
        }),
        h('div', { class: 'board-to' },
          h('span', { class: 'board-label' }, to.length ? T('Pôjde do:') : T('Kam:')),
          shown.map(deviceChip),
          shown.length ? null : h('small', {}, T('Zatiaľ žiadne zariadenie. Zapni LocalSend v mobile alebo na inom počítači (cez Tailscale, alebo v tej istej sieti s „Aj v miestnej sieti“) a daj Hľadať.')),
          h('button', { class: 'ghost', type: 'button', onclick: () => api.call('scan') }, icon('search'), T('Hľadať'))),
        h('div', { class: 'board-row' },
          h('label', { class: 'board-lan', title: T('Nájde LocalSend aj v sieti, kde nie je Tailscale (doma, v škole). Súbory od zariadení mimo Tailscale čakajú na Prijať.') },
            h('input', { type: 'checkbox', checked: !!b.st?.me?.lan, onchange: (e) => api.call('lan', e.currentTarget.checked) }), T('Aj v miestnej sieti')),
          h('button', { class: 'ghost', type: 'button', onclick: pick }, icon('plus'), T('Pridať súbory')),
          h('button', { class: 'primary', type: 'button', onclick: sendText }, T('Poslať (Enter)'))),
        b.note ? h('div', { class: 'err', role: 'alert' }, b.note) : null),
      h('div', { class: 'board-items', role: 'listbox', 'aria-label': T('Na nástenke'), 'data-scroll': 'board' },
        items().length ? items().map(itemRow) : h('p', { class: 'board-empty' }, T('Nič tu nie je. Čo pošleš alebo príde, ostane tu, kým to nezmažeš.'))),
      h('p', { class: 'board-keys' }, T('↑ ↓ vyberie, Enter otvorí alebo skopíruje, Delete zmaže z nástenky')));
  }

  function select(id) {
    b.sel = id;
    render();
    document.querySelector(`.board-item[data-key="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  /** Ctrl+V on the open board: files (a screenshot, files copied in the file manager) go at once; text goes into the
   *  text box as usual. Copied text that also carries a picture of itself stays text. */
  function paste(e) {
    const data = e.clipboardData;
    if (!api || !data?.files?.length || data.types.includes('text/plain')) return;
    e.preventDefault();
    send({ files: data.files });
  }

  /** The panel's keys while its text box does not have them. */
  function key(e) {
    if (!api || /^(input|textarea|select)$/i.test(document.activeElement?.tagName || '') || e.ctrlKey || e.metaKey || e.altKey) return false;
    const list = items();
    const at = list.findIndex((x) => x.id === b.sel);
    if (e.key === 'ArrowUp' && at <= 0) { document.querySelector('[data-root="__boardText"]')?.focus(); return true; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = list[Math.max(0, Math.min(list.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) select(next.id);
      return true;
    }
    if (e.key === 'Enter' && !document.activeElement?.matches('button, a')) { primary(find(b.sel)); return true; }
    if (e.key === 'Delete') { remove(find(b.sel)); return true; }
    return false;
  }

  // ------------------------------------------------------------------ the corner window

  /** An arrival while the board is closed, or files or text from outside the tailnet that wait for Prijať. */
  function popView() {
    const ask = b.st?.ask;
    if (ask) {
      if (b.askShown?.id !== ask.id) b.askShown = { id: ask.id, at: Date.now() };
      const text = ask.text != null;
      return h('div', { class: 'codepop boardpop', role: 'alertdialog', 'aria-label': text ? T('Prijať text') : T('Prijať súbory'), 'data-key': `ask:${ask.id}` },
        h('div', { class: 'codepop-head' },
          h('span', {}, h('b', {}, text ? T`${ask.device.alias} posiela text` : T`${ask.device.alias} posiela súbory: ${ask.count} (${size(ask.size)})`),
            text ? null : h('small', {}, ask.names.join(', ')), h('small', {}, T('Mimo Tailscale, z miestnej siete.')))),
        text ? h('p', { class: 'board-text boardpop-text' }, ask.text) : null,
        h('div', { class: 'board-row' },
          h('button', { class: 'ghost', type: 'button', onclick: () => api.call('respond', ask.id, false) }, T('Odmietnuť (Esc)')),
          h('button', { class: 'primary', type: 'button', onclick: () => api.call('respond', ask.id, true) }, T('Prijať (Enter)'))));
    }
    const it = b.pop && !isOpen() ? find(b.pop) : null;
    if (!it) return null;
    return h('div', { class: 'codepop boardpop', role: 'alertdialog', 'aria-label': T('Prišlo na nástenku'), 'data-key': `board:${it.id}` },
      h('div', { class: 'codepop-head' },
        h('span', {}, h('b', {}, T`Z ${it.device?.alias || '?'}`),
          it.text != null ? null : h('small', {}, whole(it).map((i) => it.files[i].name).join(', '))),
        h('button', { class: 'ghost', title: T('Zavrieť (Esc)'), onclick: closePop }, icon('close'), T('Zavrieť'))),
      it.text != null ? h('p', { class: 'board-text boardpop-text' }, it.text) : null,
      h('div', { class: 'board-row' },
        h('button', { class: 'ghost', type: 'button', onclick: () => { closePop(); open(); } }, T('Nástenka (Ctrl+B)')),
        h('button', { class: 'primary', type: 'button', onclick: () => popPrimary(it) }, `${primaryLabel(it)} (Enter)`)));
  }
  function closePop() { b.pop = null; unnotify('weft-board'); render(); }
  function popPrimary(it) {
    primary(it);
    if (it.text != null) setTimeout(() => { if (b.pop === it.id) closePop(); }, 900); else closePop();
  }
  /** Enter and Esc for the corner window while nothing else has the keyboard (as the Gmail code's). Enter takes what a
   *  stranger sends only once the question has been in sight for a second, so an Enter meant for the inbox never does. */
  function popKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
    const free = !document.activeElement || document.activeElement === document.body;
    const ask = b.st?.ask;
    const it = !ask && b.pop && !isOpen() ? find(b.pop) : null;
    if (!ask && !it) return false;
    if (e.key === 'Enter' && free) {
      if (ask && !(b.askShown?.id === ask.id && Date.now() - b.askShown.at >= ASK_SEEN_MS)) return false;
      e.preventDefault();
      if (ask) api.call('respond', ask.id, true); else popPrimary(it);
      return true;
    }
    if (e.key === 'Escape') { e.preventDefault(); if (ask) api.call('respond', ask.id, false); else closePop(); return true; }
    return false;
  }
  const popShown = () => !!(b.st?.ask || (b.pop && !isOpen() && find(b.pop)));

  return { available: !!api, view, key, paste, popView, popKey, popShown, entered: () => { b.pop = null; unnotify('weft-board'); if (api) api.call('scan'); } };
}

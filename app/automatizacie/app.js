const $ = s => document.querySelector(s);
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
const kinds = { systemd: 'Systemd', cron: 'Cron', t3: 'T3', hermes: 'Hermes', docker: 'Kontajner' };
const known = v => v && v !== 'neznáme' && v !== 'n/a';
const time = value => { const t = value && !String(value).startsWith('0001-') ? new Date(value).getTime() : NaN; return Number.isNaN(t) ? null : t; };
const stamp = value => time(value) ? new Date(time(value)).toLocaleString('sk-SK', { dateStyle: 'short', timeStyle: 'short' }) : '';
function span(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  return m < 1 ? 'menej ako minúta' : m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}
const relative = (value, now) => !time(value) ? '' : Math.abs(time(value) - now) < 60000 ? (time(value) > now ? 'o chvíľu' : 'práve teraz') : (time(value) > now ? 'o ' : 'pred ') + span(time(value) - now);
const bytes = b => b == null ? '—' : b >= 1e9 ? `${(b / 1e9).toLocaleString('sk-SK', { maximumFractionDigits: 1 })} GB` : `${Math.round(b / 1e6)} MB`;
const pct = v => v == null ? '—' : `${v.toLocaleString('sk-SK', { maximumFractionDigits: 1 })} %`;
const watts = v => `${v.toLocaleString('sk-SK', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} W`;
const counted = (n, one, few, many) => `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
function topology(h) {
  if (h.virtualized) return h.threads ? `${h.threads} vCPU` : 'počet vCPU nezistený';
  return [h.cores ? counted(h.cores, 'jadro', 'jadrá', 'jadier') : 'jadrá nezistené', h.threads ? counted(h.threads, 'vlákno', 'vlákna', 'vlákien') : ''].filter(Boolean).join(' / ');
}
function schedule(row) {
  if (row.kind !== 't3') return row.schedule || '';
  try {
    const s = JSON.parse(row.schedule), days = ['ne', 'po', 'ut', 'st', 'št', 'pi', 'so'];
    return s.type === 'fixed_time' ? `${s.weekdays?.length ? s.weekdays.map(n => days[n]).join(', ') : 'denne'} o ${s.timeOfDay}` : s.type === 'interval' ? `každých ${s.everyMs / 60000} min` : s.type === 'once' ? `raz ${stamp(s.runAt)}` : row.schedule;
  } catch { return row.schedule; }
}
const level = v => v >= 90 ? 'hot' : v >= 70 ? 'warm' : '';

// Groups in each machine, in the order a developer needs them.
const groups = [
  { key: 'chyba', title: 'Chyby', cols: ['Proces', 'Naposledy', 'Výsledok'] },
  { key: 'beží', title: 'Beží teraz', cols: ['Proces', 'CPU', 'RAM', 'Beží'] },
  { key: 'naplánované', title: 'Spustí sa', cols: ['Proces', 'Kedy', 'Ďalší beh', 'Naposledy'] },
  { key: 'vypnuté', title: 'Vypnuté a dokončené', cols: ['Proces', 'Kedy', 'Naposledy'], closed: true },
];
const groupOf = row => row.status === 'dokončené' ? 'vypnuté' : groups.some(g => g.key === row.status) ? row.status : 'vypnuté';
let data = null, live = null, liveFailed = false;
// Running rows keep the order of their first RAM reading, so a list refresh never makes rows jump.
const rank = new Map();

function detail(row) {
  const list = el('dl');
  const add = (label, value, cls) => { if (known(value)) list.append(el('dt', label), el('dd', value, cls)); };
  add('Technický názov', row.technical, 'mono');
  if (row.purpose && row.purpose !== row.name && !/^Pravidelná úloha|^Plánovaná úloha/.test(row.purpose) && row.purpose !== `Kontajner ${row.command}`) add('Účel', row.purpose);
  add('Spúšťanie', schedule(row));
  if (time(row.next_run)) add('Ďalší beh', stamp(row.next_run));
  if (time(row.last_run) || known(row.last_status)) add('Posledný beh', [stamp(row.last_run), known(row.last_status) ? row.last_status : ''].filter(Boolean).join(', '), row.last_status === 'chyba' ? 'issue' : '');
  const account = known(row.subscription) && row.subscription !== 'bez predplatného' ? row.subscription : '';
  if (row.ai === 'áno' || row.ai === 'spúšťa') add(row.ai === 'spúšťa' ? 'Spúšťa AI' : 'AI', [row.model, row.provider, account].filter(known).join(', ') || 'áno');
  else { add('Model', [row.model, row.provider].filter(known).join(', ')); add('Účet', account); }
  add('Súbor', row.path, 'mono');
  add('Príkaz', row.command && row.command !== row.technical ? row.command : '', 'mono');
  return list;
}

function processRow(row, group) {
  const item = el('details', null, 'proc g-' + groups.indexOf(group)); item.dataset.id = row.id;
  const summary = el('summary'), name = el('span', null, 'name');
  name.append(el('b', row.name), el('small', kinds[row.kind] + (row.technical && row.technical !== row.name && row.kind !== 't3' && row.kind !== 'hermes' ? '  ' + row.technical : '')));
  summary.append(name);
  const cell = (cls, text) => { const c = el('span', text ?? '', 'num ' + cls); summary.append(c); return c; };
  if (group.key === 'chyba') { cell('last', stamp(row.last_run)); cell('result issue', row.last_status === 'chyba' ? 'skončil chybou' : row.status); }
  if (group.key === 'beží') { cell('cpu'); cell('mem'); cell('since'); }
  if (group.key === 'naplánované') { cell('when', schedule(row)); cell('next'); cell('last', row.last_status === 'chyba' ? 'chyba' : stamp(row.last_run)).classList.toggle('issue', row.last_status === 'chyba'); }
  if (group.key === 'vypnuté') { cell('when', schedule(row)); cell('last', stamp(row.last_run)); }
  item.append(summary, detail(row));
  return item;
}

function machineTile(host) {
  const tile = el('a', null, 'machine'); tile.href = '#' + host.device; tile.dataset.host = host.device;
  const head = el('div', null, 'm-head');
  head.append(el('b', host.device), el('span', '', 'm-state'));
  const spec = el('p', '', 'm-spec');
  const cpu = el('div', null, 'meter cpu');
  cpu.append(el('span', 'CPU'), el('strong', '—', 'num'), document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
  const bar = label => { const m = el('div', null, 'meter bar'); const track = el('i'); track.append(el('i')); m.append(el('span', label), el('strong', '—', 'num'), track); return m; };
  const facts = el('p', '', 'm-facts num'), counts = el('p', '', 'm-counts');
  const power = el('div', null, 'm-power num');
  power.append(el('p', 'Celý stroj: —', 'p-total'), el('p', 'CPU balík: —', 'p-cpu'));
  const ram = bar('RAM'); ram.title = 'Využitá RAM a celková pamäť dostupná operačnému systému; časť nainštalovanej RAM môže byť vyhradená hardvéru.';
  tile.append(head, spec, el('p', '', 'm-gpu'), cpu, ram, bar('Disk'), power, facts, counts);
  return tile;
}

function render() {
  const rack = $('#machines'), root = $('#processes');
  const open = new Set([...root.querySelectorAll('details[open]')].map(d => d.dataset.id || d.dataset.group));
  rack.replaceChildren(); root.replaceChildren();
  const failing = data.rows.filter(r => r.status === 'chyba').length;
  const hosts = [...data.hosts].sort((a, b) => data.rows.filter(r => r.device === b.device && r.status === 'chyba').length - data.rows.filter(r => r.device === a.device && r.status === 'chyba').length);
  $('#summary').textContent = `${data.rows.length} procesov na ${data.hosts.length} strojoch` + (failing ? `, ${failing} s chybou` : ', žiadna chyba');
  $('#summary').classList.toggle('issue', failing > 0);
  for (const host of hosts) {
    const rows = data.rows.filter(r => r.device === host.device);
    const tile = machineTile(host);
    const count = key => rows.filter(r => groupOf(r) === key).length;
    tile.querySelector('.m-counts').append(...[['beží', 'beží'], ['naplánované', 'čaká'], ['chyba', count('chyba') === 1 ? 'chyba' : 'chýb']].map(([k, label]) => el('span', `${count(k)} ${label}`, k === 'chyba' && count(k) ? 'issue' : '')));
    if (count('chyba')) tile.classList.add('bad');
    rack.append(tile);

    const section = el('section'); section.id = host.device;
    const head = el('div', null, 'host-head');
    head.append(el('h2', host.device), el('p', '', 'host-spec'));
    section.append(head);
    const problems = [host.offline ? 'zoznam procesov sa nepodarilo načítať' : host.stale ? 'zoznam procesov je starý' : '', ...(host.errors || []).map(e => `${e.source}: ${e.error}`)].filter(Boolean);
    if (problems.length) section.append(el('p', problems.join('; '), 'host-problem'));
    for (const group of groups) {
      let list = rows.filter(r => groupOf(r) === group.key);
      if (!list.length) continue;
      if (group.key === 'beží' && live) for (const r of list) if (!rank.has(r.id)) rank.set(r.id, live.procs[r.id]?.mem ?? -1);
      const mem = r => rank.get(r.id) ?? -1;
      list.sort(group.key === 'beží' ? (a, b) => mem(b) - mem(a) || a.name.localeCompare(b.name, 'sk')
        : group.key === 'naplánované' ? (a, b) => (time(a.next_run) ?? Infinity) - (time(b.next_run) ?? Infinity) || a.name.localeCompare(b.name, 'sk')
        : (a, b) => a.name.localeCompare(b.name, 'sk'));
      const wrap = el(group.closed ? 'details' : 'div', null, 'group g-' + groups.indexOf(group));
      const title = el(group.closed ? 'summary' : 'h3', null, 'group-title');
      title.append(el('span', group.title), el('span', String(list.length), 'num count'));
      const cols = el('div', null, 'cols'); cols.setAttribute('aria-hidden', 'true');
      cols.append(...group.cols.map(c => el('span', c)));
      wrap.append(title, cols, ...list.map(r => processRow(r, group)));
      if (group.closed) { wrap.dataset.group = host.device + ':' + group.key; wrap.open = open.has(wrap.dataset.group); }
      section.append(wrap);
    }
    root.append(section);
  }
  for (const d of root.querySelectorAll('details.proc')) d.open = open.has(d.dataset.id);
  update();
}

function spark(svg, history, now) {
  // Last six minutes; samples arrive every 5 s while the page is open, every minute otherwise.
  const W = 240, H = 48, from = now - 360;
  const pts = history.filter(([t]) => t >= from).map(([t, v]) => [((t - from) / 360) * W, H - (Math.min(v, 100) / 100) * (H - 2) - 1]);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
  if (pts.length < 2) { svg.innerHTML = ''; return; }
  const line = pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ');
  svg.innerHTML = `<polygon points="${pts[0][0].toFixed(1)},${H} ${line} ${pts.at(-1)[0].toFixed(1)},${H}"/><polyline points="${line}"/>`;
}

function update() {
  if (!data) return;
  const now = Date.now(), hosts = live?.hosts || {};
  for (const tile of document.querySelectorAll('.machine')) {
    const h = hosts[tile.dataset.host];
    const state = tile.querySelector('.m-state');
    tile.classList.toggle('offline', !h || h.offline);
    if (!h || h.offline) {
      state.textContent = h ? 'nedostupný' + (tile.dataset.host === 'x270' ? ', asi spí' : '') : liveFailed ? 'bez živých údajov' : 'načítavam';
      tile.querySelector('.p-total').textContent = 'Celý stroj: —';
      tile.querySelector('.p-cpu').textContent = 'CPU balík: —';
      continue;
    }
    state.textContent = `beží ${span(h.uptime * 1000)}`;
    setText(tile.querySelector('.m-spec'), `${h.os.replace(/ GNU\/Linux| LTS|\(.*\)/g, '').trim()}, ${h.cpu_model.replace(/\(R\)|\(TM\)|CPU|Processor|@.*$|\d+th Gen|Intel|AMD/g, '').replace(/\s+/g, ' ').trim()}, ${topology(h)}`);
    setText(tile.querySelector('.m-gpu'), `GPU: ${h.gpus?.length ? h.gpus.join(', ') : 'nezistená'}`);
    const [cpu, ram, disk] = tile.querySelectorAll('.meter');
    cpu.querySelector('strong').textContent = pct(h.cpu); cpu.className = 'meter cpu ' + level(h.cpu ?? 0);
    spark(cpu.querySelector('svg'), h.history || [], live.now);
    for (const [m, [used, total]] of [[ram, h.mem], [disk, h.disk]]) {
      const p = total ? 100 * used / total : 0;
      m.className = 'meter bar ' + level(p);
      m.querySelector('strong').textContent = `${bytes(used)} z ${bytes(total)}`;
      m.querySelector('i i').style.width = p.toFixed(1) + '%';
    }
    tile.querySelector('.m-facts').textContent = [h.temp != null ? `${Math.round(h.temp)} °C` : '', h.battery ? `batéria ${h.battery.percent} %` : '', `záťaž ${h.load[0].toLocaleString('sk-SK')}`].filter(Boolean).join('   ');
    const power = tile.querySelector('.m-power'), p = h.power;
    power.querySelector('.p-total').textContent = p?.battery_w != null ? `Celý stroj: ${watts(p.battery_w)} z batérií` : 'Celý stroj: nemerané';
    power.querySelector('.p-cpu').textContent = p?.cpu_w != null ? `CPU balík: ${watts(p.cpu_w)}` : p?.cpu_state === 'sampling' ? 'CPU balík: čaká na vzorku' : 'CPU balík: nemerané';
    power.title = p?.cpu_w != null ? `CPU balík je priemer za ${p.interval_s} s podľa RAPL a zahŕňa súčasti daného čipu. Celkový odber sa číta z vybíjaných batérií.` : 'Celý stroj sa meria pri napájaní iba z batérií. Pri adaptéri jeho odber nie je dostupný.';
    const spec = document.querySelector(`#${tile.dataset.host} .host-spec`);
    if (spec) spec.textContent = `CPU ${pct(h.cpu)}, RAM ${bytes(h.mem[0])} z ${bytes(h.mem[1])}`;
  }
  for (const item of document.querySelectorAll('details.proc')) {
    const row = data.byId.get(item.dataset.id), p = live?.procs[item.dataset.id];
    const set = (cls, text) => { const c = item.querySelector('summary .' + cls); if (c) c.textContent = text; };
    set('cpu', p ? pct(p.cpu) : '—'); set('mem', p ? bytes(p.mem) : '—');
    item.querySelector('summary .cpu')?.classList.toggle('hot', (p?.cpu ?? 0) >= 25);
    const started = row.started || (row.kind === 'docker' ? row.last_run : null);
    set('since', time(started) ? span(now - time(started)) : '');
    // Process lists refresh every 5 minutes, so a run that just passed is due any moment.
    set('next', time(row.next_run) && time(row.next_run) <= now ? 'o chvíľu' : relative(row.next_run, now));
  }
  const age = live ? Math.max(0, Math.round(now / 1000 - live.now)) : 0;
  $('#updated').textContent = !live ? (liveFailed ? 'Živé údaje sa nepodarilo načítať, skúšam znova' : 'Načítavam živé údaje…')
    : liveFailed ? `Živé údaje sa nepodarilo obnoviť, posledné pred ${age} s` : `Živé údaje, pred ${age} s`;
  $('#updated').classList.toggle('issue', liveFailed);
}

async function get(path) {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Prehľad sa nepodarilo načítať.');
  return body;
}
async function loadData() {
  try {
    const next = await get('/_automations/data');
    const signature = JSON.stringify(next.rows.map(r => [r.id, r.status, r.next_run, r.last_run]));
    if (data && signature === data.signature) return;
    next.signature = signature; next.byId = new Map(next.rows.map(r => [r.id, r]));
    data = next; render();
  } catch (error) {
    $('#summary').textContent = error instanceof TypeError || error.name === 'TimeoutError' ? 'Prehľad sa nepodarilo načítať. Skontroluj spojenie a obnov stránku cez Ctrl+R.' : error.message;
    $('#summary').classList.add('issue');
  }
}
async function loadLive() {
  const first = !live;
  try { live = await get('/_automations/stats'); liveFailed = false; } catch { liveFailed = true; /* keep the last numbers and say they are old */ }
  // The first live reading decides the order of running rows; render once more so it applies.
  if (first && live && data) render(); else update();
}
// Live numbers every 5 s and the process list every minute, only while the page is visible.
async function start() {
  await Promise.all([loadData(), loadLive()]);
  if (data) render();
  setInterval(() => { if (!document.hidden) loadLive(); }, 5000);
  setInterval(() => { if (!document.hidden) loadData(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadLive(); });
}
if (window.desktop) {
  const form = $('#find'), input = $('#find-text');
  let previousFocus, query = '', matches = [], current = 0;
  const find = (backwards = false, reset = false) => {
    const value = input.value.toLocaleLowerCase('sk');
    if (reset || value !== query) {
      query = value; matches = []; current = 0;
      const walker = document.createTreeWalker($('main'), NodeFilter.SHOW_TEXT);
      if (query) while (walker.nextNode()) {
        const node = walker.currentNode, text = node.textContent.toLocaleLowerCase('sk');
        let offset = 0, index;
        while ((index = text.indexOf(query, offset)) !== -1) {
          const range = new Range(); range.setStart(node, index); range.setEnd(node, index + query.length);
          matches.push(range); offset = index + query.length;
        }
      }
    } else if (matches.length) current = (current + (backwards ? -1 : 1) + matches.length) % matches.length;
    CSS.highlights.set('automation-matches', new Highlight(...matches));
    CSS.highlights.set('automation-current', new Highlight(...(matches.length ? [matches[current]] : [])));
    if (matches.length) {
      // Process details are folded; open every fold around the current match.
      for (let d = matches[current].startContainer.parentElement.closest('details'); d; d = d.parentElement.closest('details')) d.open = true;
      matches[current].startContainer.parentElement.scrollIntoView({ block: 'center' });
    }
    form.querySelector('span').textContent = (query ? `${matches.length ? current + 1 : 0} / ${matches.length} · ` : '') + 'Enter: ďalší · Esc: zavrieť';
  };
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault(); previousFocus = document.activeElement; form.hidden = false; input.focus(); input.select();
    } else if (event.key === 'Escape' && !form.hidden) {
      event.preventDefault(); form.hidden = true; CSS.highlights.delete('automation-matches'); CSS.highlights.delete('automation-current'); previousFocus?.focus();
    }
  });
  input.addEventListener('input', () => find(false, true));
  form.addEventListener('submit', event => { event.preventDefault(); find(false); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); find(event.shiftKey); } });
}
start();

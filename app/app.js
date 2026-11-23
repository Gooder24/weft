// Karchi's messages: EduPage and bridged chats (Messenger, Instagram, Discord) in one inbox,
// on his own homeserver. One page, no framework.
// Talks Matrix client-server API to the homeserver on this origin and the bridges' provisioning
// APIs under /_bridges/<app>. The EduPage bridge puts all of EduPage into one room, where replies
// in a thread are Matrix replies to its first message; every other chat is a bridge portal room.

import { T, LANG, LOCALE, setLang } from './i18n.js';
import * as Cal from './calendar.js';
import { findWhen } from './when.js';
import { icon } from './icons.js';
import { STASH, GONE_MS, applyStash, stashHas, stashOf } from './stash.js';

import { createFeed } from './feed.js';
import { createUpdates } from './updates.js';
import { linksIn, trimLink, LINK_RE, fromBridge, card as linkCard, createLinkReader, readsItself, HELD, classify } from './links.js';

document.documentElement.lang = LANG;

const BRIDGE = '/_bridges/edupage/_matrix/provision/v3';
const BOT_LOCALPART = 'edupagebot';
const MARK = 'sk.karchi.edupage';
const TO_KEY = 'sk.karchi.edupage.to';
const RECIPIENT_KEY = 'sk.karchi.edupage.recipient'; // a new EduPage message: the ghost of the person it goes to
const PREFS = 'sk.karchi.edupage.prefs';
const GRADES = 'sk.karchi.edupage.grades';
const PEOPLE = 'sk.karchi.edupage.people';
const EDU_FILES = 'sk.karchi.edupage.files'; // [{ name, url: mxc, mimetype, size, w, h }] on a homework notice or Karchi's message
const EDU_SIGNIN = 'sk.karchi.edupage.signin'; // { name, type, from, to, chosen?, confirmed? } on a sign-up notice
const SEEN = 'sk.karchi.edupage.seen'; // { [thread root id]: ts seen up to, _all: baseline ts }
// Written by the bridge from EduPage's own data: { subjects: [{ id, name, short, mine, why: [...], grades }], groups,
// items: { [EduPage item id]: { subject?, others? } }, timetable }: which subject a notice is about and whether it is his.
const FACTS = 'sk.karchi.edupage.facts';
// Karchi's say over them (Settings → EduPage): { kinds: { [kind]: { show: 'inbox' | 'quiet' | 'hidden', color:
// 'subject' | '#rrggbb' | '', icon } }, subjects: { [id]: bool }, others: bool }. The bridge reads `subjects` too.
const RULES = 'sk.karchi.edupage.rules';
const TIMETABLE_CAL = 'lifeos-edupage'; // the calendar with Karchi's EduPage timetable, whose lessons give subject colours
// Inbox state per chat (EduPage thread root id or room id), kept on the homeserver only so no
// bridge ever sends it to the network: { done: archived at ts, low: true, remind: ts, unread: true }.
const INBOX = 'sk.karchi.inbox';
// Messages to send later: { items: [{ id, room, at, seq, batch, replyTo?, content, sent?, failed?, error? }] }. The service
// server/sendlater on asus sends them when due, so the computer with Weft may sleep.
const LATER = 'sk.karchi.sendlater';
// { items: [{ id, room, body, files?, at, by }] }: drafts agents write with `weft draft`; each goes into the chat's stash once
const AGENT_DRAFTS = 'sk.karchi.drafts';
// { items: [{ id, room, rooms?, from_event, from_ts, to_room, at, expires, status }] }: answers Karchi waits for; once one
// comes, server/relay/relay.py draws it and puts the picture into to_room as an agent draft.
const RELAY = 'sk.karchi.relay';
// Messages from others (Settings → Nové správy): { mode: 'manual' | 'times' (old 'live' is migrated), times: ['07:00', ...], edupage: held too, since,
//   pending: { mode, times, from: 'YYYY-MM-DD' } (a change waiting for its day) }.
const BATCHES = 'sk.karchi.batches';
// The latest reading window { day, start, end, used, count, minutes }: waiting messages and Feed open together for a
// few minutes, `count` times a day. Only the feed server writes it (server/feed/feed.py); Weft reads it here and from
// every feed answer.
const WINDOW = 'sk.karchi.window';
/** m.bridge protocol id -> app. */
const NETWORKS = { facebookgo: 'messenger', facebook: 'messenger', instagramgo: 'instagram', instagram: 'instagram', discordgo: 'discord', discord: 'discord', whatsapp: 'whatsapp', teams: 'teams' };
/** Matrix localpart of an agent bot -> app; its plain (unbridged) chat with Karchi shows in the inbox. */
const AGENTS = { '@hermes': 'hermes' };
const isBot = (id) => /^@(messenger|instagram|discord|edupage|whatsapp|teams)bot:/.test(id);
/** A message sent again after it did not go out names the one it replaces; that one leaves the chat. */
const RESEND_OF = 'sk.karchi.resend_of';
/** A bridge's „⚠️ Your message was not bridged: …“ notice: what it is about and why, or null. The legacy Discord
 *  bridge names no message (`target` null: Karchi's last one before it) and in a DM sends it as the other person. */
function bridgeFailure(ev) {
  if (ev.sender === S.userId || ev.content?.msgtype !== 'm.notice') return null;
  const hit = /\u26a0\ufe0f? ?Your ([\w ]+?) (was not|may not have been) bridged: ([\s\S]*)$/.exec(ev.content.body || '');
  const rel = ev.content['m.relates_to'];
  const target = rel?.['m.in_reply_to']?.event_id || (rel?.rel_type === 'm.reference' ? rel.event_id : null);
  return hit ? { target, kind: hit[1], sure: hit[2] === 'was not', reason: hit[3].trim() } : null;
}
const failReason = (reason) => (/aren't on your friends list|not on your friends list/i.test(reason) ? T('Discord tu dovolí písať len priateľom. Napíš mu v appke Discord alebo mu tam pošli žiadosť o priateľstvo.')
  : /logged out|relogin|not logged in/i.test(reason) ? T('účet je odhlásený, prihlás sa znova v Nastaveniach')
  : /timed? ?out|timeout/i.test(reason) ? T('sieť neodpovedala') : reason);
// Polls (MSC3381): bridges send the unstable types, the stable ones are here for the day they switch.
const POLL_START = ['org.matrix.msc3381.poll.start', 'm.poll.start'];
const POLL_RESPONSE = ['org.matrix.msc3381.poll.response', 'm.poll.response'];
const POLL_END = ['org.matrix.msc3381.poll.end', 'm.poll.end'];
// Discord tells only how many voted for each answer, not who: { counts: { [answer id]: n }, mine: [ids], closed, expiry }
// on the poll start (Weft's patch of the Discord bridge, kept current by edits) and on archived Discord polls.
const DISCORD_POLL = 'sk.karchi.discord.poll';
const POLL_TYPES = [...POLL_START, ...POLL_RESPONSE, ...POLL_END];
const TIMELINE_TYPES = ['m.room.message', 'm.sticker', 'm.reaction', 'm.room.redaction', 'm.room.create', 'm.room.member', 'm.room.name', 'm.room.avatar', 'm.bridge', ...POLL_TYPES];
const DEFAULT_PREFS = { polls: true, arrivals: false, meals: false };
const DAYS = [T('Nedeľa'), T('Pondelok'), T('Utorok'), T('Streda'), T('Štvrtok'), T('Piatok'), T('Sobota')];
const MONTHS = LANG === 'en' ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] : ['jan', 'feb', 'mar', 'apr', 'máj', 'jún', 'júl', 'aug', 'sep', 'okt', 'nov', 'dec']; // i18n-ignore: each language's own names
const ME_COLOR = '#ab9a3a';
const DC_ANNOUNCEMENTS = 5; // a Discord announcement channel's type (the bridge's portal.type)
const DC_DM = 1;
const OTHER_COLOR = '#9e9e9e';

const S = {
  token: localStorage.getItem('ep_token'),
  userId: localStorage.getItem('ep_user'),
  view: 'loading', // loading | login | connect | main
  archiveGen: 0, // counts changes of the archive's chats that bump no room's version (search's signature)
  error: '',
  busy: false,
  connect: null, // EduPage login in progress: { id, step }
  logins: [],
  roomId: null,
  events: new Map(), // event id -> event, the EduPage room's messages
  pending: new Map(), // txn id -> local reply not yet echoed by the server
  names: new Map(), // mxid -> display name
  account: {}, // account data type -> content
  selected: selectedFromHash(), // explicit chat links still work
  surface: feedFromLocation() ? 'feed' : 'calendar',
  drafts: storedDrafts(localStorage.getItem('ep_user')), // room or thread root id -> unsent text
  attach: new Map(), // room id -> [File] picked with "+", pasted or dropped; sent with the next message
  eduNote: null, // EduPage thread or new message where a file could not be taken: it gets a short note
  eduPeople: new Map(), // teachers from the EduPage bridge, mxid -> name, for new messages
  historyDone: false,
  readSent: '',
  showAll: localStorage.getItem('ep_show_all') === '1', // false: only unread threads, like Beeper's Unread inbox
  panel: null, // floating panel over the inbox: 'grades' | 'settings' | 'people'
  menu: false, // the app filter menu is open
  gradeMode: localStorage.getItem('ep_grade_mode') === 'recent' ? 'recent' : 'table',
  gradeOpen: null, // grade id whose details show in the table
  profileOf: null, // whose profile the panel shows: { key } a chat's person, { room, user } one member of a group
  links: {}, // chat app id -> its logins (null: the bridge does not answer)
  link: null, // account login in progress: { app, id, step, error, busy }
  acctOpen: null, // account row expanded in settings ('edupage' shows its options)
  eduKindOpen: null, // notice type whose colour and mark are being chosen in Settings → EduPage
  setTab: 'messages', // the section Settings shows
  rooms: new Map(), // room id -> bridged chat (see roomOf); the EduPage room is not in here
  box: 'inbox', // which chats the list shows, like Beeper's views: inbox | archive | reminders | low
  overlay: null, // { kind: 'search' | 'new' | 'remind' | 'menu' | 'help' | 'tools' | 'image', ... } over everything
  replyTo: null, // { room, event } the composer answers
  editing: null, // { room, event, draft } own message being edited in the composer; `draft` comes back after
  focusEvent: null, // event id to scroll to and highlight in the open chat
  focusComposer: false,
};

/** Unsent text belongs to this browser and this account; reopening never turns it into a send. */
function storedDrafts(user) {
  try {
    const items = JSON.parse(localStorage.getItem(`ep_drafts:${user}`) || '[]');
    return new Map(Array.isArray(items) ? items.filter((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string' && typeof x[1] === 'string' && x[1].trim()) : []);
  } catch { return new Map(); }
}
function persistDrafts() {
  if (!S.userId) return;
  const saved = new Map(S.drafts);
  // An edit temporarily borrows the composer; keep the unsent text that will come back after it.
  if (S.editing) saved.set(S.editing.room, S.editing.draft);
  const kept = [...saved].filter(([, text]) => text.trim());
  const picks = kept.map(([key]) => [key, key === S.editing?.room ? S.editing.picks : picked.get(key)]).filter(([, list]) => list?.length);
  try {
    localStorage.setItem(`ep_drafts:${S.userId}`, JSON.stringify(kept));
    localStorage.setItem(`ep_picks:${S.userId}`, JSON.stringify(picks));
  } catch { /* Storage unavailable: the in-memory draft still stays usable in this window. */ }
}
/** The picked names of the drafts storedDrafts gives back (persistDrafts keeps them beside the text). */
function storedPicks(user) {
  try {
    const items = JSON.parse(localStorage.getItem(`ep_picks:${user}`) || "[]");
    return new Map((Array.isArray(items) ? items : []).filter((x) => Array.isArray(x) && typeof x[0] === "string" && Array.isArray(x[1]))
      .map(([key, list]) => [key, list.filter((x) => Number.isInteger(x?.at) && typeof x.key === "string" && typeof x.id === "string")]));
  } catch { return new Map(); }
}
function loadDrafts(user) {
  S.drafts = storedDrafts(user);
  picked.clear();
  for (const [key, list] of storedPicks(user)) if (list.length && S.drafts.has(key)) picked.set(key, list);
}
function setDraft(key, text) { shiftPicks(key, S.drafts.get(key) || '', text); S.drafts.set(key, text); persistDrafts(); }
function deleteDraft(key) { picked.delete(key); S.drafts.delete(key); persistDrafts(); }

/** Draft key → [{ at, key, id }]: an "@Name" picked from the list (or kept from an edited message) at `at` in the
 *  draft; there it is that person (mentionsIn), also beside a longer name or one two people share. Kept with the draft
 *  in this browser, so a reload keeps who they were. */
const picked = new Map();
for (const [key, list] of storedPicks(localStorage.getItem("ep_user"))) if (list.length && S.drafts.has(key)) picked.set(key, list);
/** The draft changed from `before` to `after`: picks after the change move with it, picks inside it are gone. */
function shiftPicks(key, before, after) {
  const list = picked.get(key);
  if (!list?.length || before === after) return;
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let q = 0;
  while (q < before.length - p && q < after.length - p && before[before.length - 1 - q] === after[after.length - 1 - q]) q++;
  // Typing "@" before "@Ana" could be either "@" (a run of equal characters): the change may stand anywhere it slides
  // to the left; take the place that cuts the fewest picks, the rightmost of those as before.
  const cut = before.length - p - q, put = after.length - p - q;
  const cuts = (at) => list.filter((x) => (x.at < at && x.at + x.key.length > at) || (at + cut > x.at && at < x.at + x.key.length && !(x.at >= at && x.at + x.key.length <= at + cut))).length;
  let best = p;
  for (let at = p; at > 0 && (cut ? before[at - 1] === before[at - 1 + cut] : put ? before[at - 1] === after[at - 1 + put] : false);) {
    at--;
    if (cuts(at) < cuts(best)) best = at;
  }
  p = best;
  const end = p + cut;
  const kept = list.filter((x) => x.at + x.key.length <= p || x.at >= end).map((x) => (x.at >= end ? { ...x, at: x.at + after.length - before.length } : x));
  if (kept.length) picked.set(key, kept); else picked.delete(key);
}
const draftOf = (key) => (S.editing?.room === key ? S.editing.draft : S.drafts.get(key)) || '';
const hasDraft = (key) => !!draftOf(key).trim();

function selectedFromHash() {
  return location.hash.length > 1 && !['#feed', '#messages'].includes(location.hash) ? decodeURIComponent(location.hash.slice(1)) : null;
}

// Keep a reading overlay and a selected conversation addressable together.
function feedFromLocation() { return location.hash === '#feed' || new URLSearchParams(location.search).get('feed') === '1'; }
function workspaceUrl(id = S.selected, reading = S.surface === 'feed') {
  const url = new URL(location.href);
  if (reading) url.searchParams.set('feed', '1'); else url.searchParams.delete('feed');
  url.hash = id ? encodeURIComponent(id) : '';
  return url.pathname + url.search + url.hash;
}

// ------------------------------------------------------------------ API

class ApiError extends Error {
  constructor(status, body) {
    super(body.error || `HTTP ${status}`);
    this.status = status;
    this.errcode = body.errcode || '';
    this.details = body;
  }
}

async function call(method, path, body, base = '/_matrix/client/v3', signal = undefined) {
  if (/^\/rooms\/archive(?::|%3a)/i.test(path)) throw new Error(T('Uložená história je iba na čítanie.'));
  const res = await fetch(base + path, {
    method,
    signal,
    headers: {
      ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
const bridge = (method, path, body) => call(method, path, body ?? (method === 'POST' ? {} : undefined), BRIDGE);
const q = encodeURIComponent;

// ------------------------------------------------------------------ boot

let bootRun = 0;
async function boot() {
  if (!S.token) {
    // The old client on this origin was already logged in; take over its session once.
    const token = localStorage.getItem('cinny_access_token');
    const user = localStorage.getItem('cinny_user_id');
    if (token && user) saveSession(token, user);
  }
  if (!S.token) return show('login');
  const run = ++bootRun; // "Prihlásiť sa znova" and a later boot() end this one
  // The kept profile pictures come with the copy, so its first frame has them (both ways it is drawn, below).
  const kept = Promise.all([readSnapshot(), avatarsReady()]).then(([snap]) => snap);
  // The inbox opens from the copy kept on this computer while asus answers; the first sync replaces it.
  const keptUser = S.userId;
  kept.then((snap) => {
    if (run !== bootRun || S.homeSynced || S.fromSnapshot || !keptUser || snap?.user !== keptUser || S.userId !== keptUser) return;
    hydrate(snap);
    cal.view = calDefault();
    show('main');
  });
  keptArchive(run);
  for (let tries = 0; ; tries++) {
    try {
      // The first answer gets 4 s; after that Weft waits as long as asus needs.
      const me = (await call('GET', '/account/whoami', undefined, undefined, AbortSignal.timeout(tries ? 30000 : 4000))).user_id;
      if (run !== bootRun) return;
      // The kept copy was someone else's (never, unless the session changed under it): start over without it.
      if (S.fromSnapshot && S.userId !== me) { saveSession(S.token, me); await forgetSnapshot(); return location.reload(); }
      if (S.userId !== me) { loadDrafts(me); S.editing = null; }
      S.userId = me;
      break;
    } catch (err) {
      if (run !== bootRun) return;
      if (err.status === 401) {
        clearSession();
        return show('login');
      }
      // No network or asus asleep: Weft opens from the copy kept on this computer and catches up later.
      const snap = await kept;
      if (run !== bootRun) return;
      if (isNetErr(err) && snap?.user === S.userId) {
        if (!S.fromSnapshot) hydrate(snap);
        S.bootedOffline = true;
        goOffline(snap.at);
        cal.view = calDefault();
        show('main');
        syncLoop();
        codesLoop(); // waits while offline
        return;
      }
      // No copy yet (the first start, or the copy was never written): keep asking, never the login form.
      S.waiting = T('Čakám na asus… Weft sa otvorí sám, keď odpovie.');
      render();
      await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * 2 ** tries)));
      if (run !== bootRun) return;
    }
  }
  await refreshLogins();
  if (run !== bootRun) return;
  S.waiting = null;
  // Shown from the kept copy already, the window stays: a bridge that did not answer is no reason to leave it.
  if (!(S.fromSnapshot && S.view === 'main')) show(S.logins.length ? 'main' : 'connect');
  refreshLinks().then(refresh); // chat accounts' states, for the disconnected bar
  syncLoop();
  codesLoop();
}

function saveSession(token, user) {
  if (S.userId !== user) { loadDrafts(user); S.editing = null; }
  S.token = token;
  S.userId = user;
  localStorage.setItem('ep_token', token);
  localStorage.setItem('ep_user', user);
}

function clearSession() {
  persistDrafts();
  S.drafts.clear();
  S.editing = null;
  S.userId = null;
  feed.clear();
  S.homeReady = S.homeSynced = false;
  S.rooms.clear(); // also what a kept copy showed before asus said the session had ended
  S.archiveTag = null; S.archiveAt = 0;
  S.fromSnapshot = false;
  cal.doc = null; cal.loaded = false;
  forgetCodes();
  stopRing();
  S.token = null;
  localStorage.removeItem('ep_token');
  localStorage.removeItem('ep_user');
  localStorage.removeItem('cinny_access_token');
  localStorage.removeItem('ep_opened');
  localStorage.removeItem('ep_outbox');
  localStorage.removeItem('ep_account_out');
  forgetSnapshot();
}

/** Chats in the order they were last opened, newest first; Ctrl+K lists them so Enter goes back to the previous one. */
function opened() {
  try { return JSON.parse(localStorage.getItem('ep_opened')) || []; } catch { return []; }
}

function noteOpened(id) {
  if (id) localStorage.setItem('ep_opened', JSON.stringify([id, ...opened().filter((k) => k !== id)].slice(0, 30)));
}

async function refreshLogins() {
  const token = S.token; // an answer for a session that has since ended changes nothing
  const logins = await bridge('GET', '/whoami').then((r) => r.logins || [], () => []);
  if (S.token === token) S.logins = logins;
}

// ------------------------------------------------------------------ offline
// Weft works without the server. sw.js keeps the app's own files and the photos already seen; the last state
// of the inbox is kept here in IndexedDB, so the window opens and reads offline. Messages written meanwhile
// wait in ep_outbox and account changes (archive, read, settings) in ep_account_out; both go out as soon as
// sync answers again.

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

/** Asus did not answer at all (no network, asleep, a bridge down behind Caddy), as opposed to refusing. */
const isNetErr = (err) => !err?.status || err.status >= 500;

function goOffline(since = Date.now()) {
  if (S.offline) return;
  S.offline = true;
  S.offlineSince = since;
  // Who was typing is not known after a gap: the homeserver resends typing only when it changes.
  for (const r of S.rooms.values()) if (r.typing?.length) { r.typing = []; r.version++; }
  refresh();
}
addEventListener('offline', () => S.token && goOffline());

function offlineBanner() {
  const when = S.offlineSince ? `${dayLabel(S.offlineSince)} ${timeLabel(S.offlineSince)}` : '';
  return h('div', { class: 'banner offline' }, h('span', {}, T`Offline · správy z ${when}. Čo napíšeš, odíde, keď bude sieť.`));
}

function flushAll() {
  for (const [room, ev] of S.readLater || []) call('POST', `/rooms/${q(room)}/receipt/m.read/${q(ev)}`, {}).catch(() => {});
  S.readLater = null;
  for (const [type, content] of Object.entries(accountOut())) putAccount(type, content).catch(() => {});
  flushOut();
  flushCal();
}

function reconnected() {
  S.offlineSince = null;
  for (const key of S.mediaMissed || []) mediaCache.delete(key);
  S.mediaMissed = null;
  if (S.homeSynced) prefetchSoon(); // put off while offline
  pumpMedia(); // prefetches wait while offline
  flushAll();
  if (S.panel === 'calendar' || !S.selected) loadCalendar();
  feed.load();
  if (S.bootedOffline) { S.bootedOffline = false; refreshLogins().then(refresh); }
  refreshLinks().then(refresh);
}

let kvDb = null;
function kvDo(mode, fn) {
  kvDb ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('weft-offline', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return kvDb.then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  }));
}
const readSnapshot = () => kvDo('readonly', (st) => st.get('snapshot')).catch(() => null);
function forgetSnapshot() {
  globalThis.caches?.delete('weft-media-v1');
  return Promise.all([forgetAvatars(), kvDo('readwrite', (st) => st.clear()).catch(() => {})]);
}

let keepTimer = null;
/** The copy is rewritten at most every 15 s and only from live data, never from itself. */
function keepSoon() {
  if (keepTimer) return;
  keepTimer = setTimeout(() => { keepTimer = null; (globalThis.requestIdleCallback || setTimeout)(keepNow); }, 15000);
}

async function keepNow() {
  if (!S.token || S.offline || S.eduKept || !S.historyDone) return;
  let edu = [...S.events.values()];
  if (S.eduPartial) {
    const have = new Set(edu.map((ev) => ev.event_id));
    edu = [...((await readSnapshot())?.edu || []).filter((ev) => !have.has(ev.event_id)), ...edu];
  }
  const rooms = [];
  for (const r of S.rooms.values()) {
    // Old chats only in the archive (thousands) come back from asus; reading them needs asus anyway.
    if (!r.app || r.space || r.archiveOnly || r.statusRoom) continue;
    const events = [...r.events.values()].filter((ev) => !ev.pending)
      .sort((a, b) => a.origin_server_ts - b.origin_server_ts).slice(-80);
    rooms.push({ id: r.id, app: r.app, created: r.created, bridgeName: r.bridgeName, server: r.server, serverId: r.serverId, archiveOnly: !!r.archiveOnly,
      readAt: r.readAt, unread: r.unread, state: r.state, members: r.members, receipts: r.receipts, receiptAt: r.receiptAt, events });
  }
  const snap = { user: S.userId, at: Date.now(), account: S.account, logins: S.logins, links: S.links,
    roomId: S.roomId, edu, names: S.names, rooms };
  kvDo('readwrite', (st) => st.put(snap, 'snapshot')).catch(() => {});
}

/** Fills Weft from the kept copy, before the first sync (offline, or online while asus answers). */
function hydrate(snap) {
  S.fromSnapshot = true; // until the first sync: rooms only the copy had are dropped then, nothing is marked read
  S.snapRooms = new Set((snap.rooms || []).map((x) => x.id));
  S.account = { ...snap.account, ...accountOut() };
  if (!S.logins.length) S.logins = snap.logins || [];
  S.links = snap.links || {};
  S.roomId = snap.roomId;
  S.eduKept = true; // the first sync takes the EduPage room over and pages its history again
  for (const [id, name] of snap.names || []) if (!S.names.has(id)) S.names.set(id, name); // the archive's may be in already
  for (const ev of snap.edu || []) S.events.set(ev.event_id, ev);
  S.historyDone = true;
  for (const x of snap.rooms || []) {
    const r = roomOf(x.id);
    Object.assign(r, { app: x.app, created: x.created || 0, bridgeName: x.bridgeName, server: x.server || '', serverId: x.serverId || '', archiveOnly: x.archiveOnly,
      readAt: x.readAt, unread: x.unread || 0, state: x.state || new Map(), members: x.members || new Map(), receipts: x.receipts || new Map(), receiptAt: x.receiptAt || new Map() });
    for (const ev of x.events) r.events.set(ev.event_id, ev);
    if (r.archiveOnly) r.matrixDone = true;
    r.statusRoom = r.app === 'whatsapp' && bridgeChannel(r) === 'status@broadcast'; // a copy kept before it was left out
    r.version++;
  }
  for (const it of outbox()) roomOf(it.room).pending.set(it.txn, waitingEvent(it));
}

const readJson = (key, empty) => { try { return JSON.parse(localStorage.getItem(key)) || empty; } catch { return empty; } };
const outbox = () => readJson('ep_outbox', []);
const saveOutbox = (list) => localStorage.setItem('ep_outbox', JSON.stringify(list));
const waitingEvent = (it) => ({ event_id: it.txn, type: 'm.room.message', pending: true, waiting: true, sender: S.userId, origin_server_ts: it.at, content: it.content });

/** The send response is enough to settle the local bubble, even before sync echoes it. */
function settleChat(r, txn, res, content) {
  const local = r.pending.get(txn);
  if (!res.event_id) return;
  if (local && !r.events.has(res.event_id)) r.events.set(res.event_id, {
    ...local, event_id: res.event_id, content, pending: false, waiting: false,
  });
  r.pending.delete(txn);
  r.version++;
  render();
}

/** A text message that could not go out; it keeps its transaction id, so sending it again never doubles it. */
function queueOut(r, txn, content) {
  const it = { txn, room: r.id, at: Date.now(), content };
  saveOutbox([...outbox(), it]);
  r.pending.set(txn, waitingEvent(it));
  r.version++;
}

let flushing = false;
async function flushOut() {
  if (flushing) return;
  flushing = true;
  for (const it of outbox()) {
    const r = roomOf(it.room);
    if (!r.pending.has(it.txn)) r.pending.set(it.txn, waitingEvent(it)); // written in an earlier window
    const shown = r.pending.get(it.txn);
    shown.waiting = false;
    r.version++;
    refresh();
    const to = it.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;
    // Written in an earlier window: the message it answers may not be loaded here yet, so it is read first.
    let thread;
    try { thread = await heldReply(r, it.room, to); } catch {
      shown.waiting = true; r.version++; goOffline(); break;
    }
    if (thread) {
      // The text is kept in the chat's stash (every window, after a reload too), without the reply.
      const kept = typeof it.content?.body === 'string' && it.content.body.trim()
        && stashDo({ op: 'add', item: { id: newStashId(), room: it.room, body: it.content.body, at: it.at || Date.now(), pos: Date.now() } });
      const why = kept ? `${thread} ${T('Text je v Odložených (Ctrl+S).')}` : thread;
      failLocal(r, it.txn, new Error(why), () => alert(why));
      // Not in the stash: it stays in the outbox (held again on every try) until „Zahodiť“.
      if (kept) saveOutbox(outbox().filter((x) => x.txn !== it.txn));
      continue;
    }
    try {
      const res = await call('PUT', `/rooms/${q(it.room)}/send/m.room.message/${it.txn}`, it.content, undefined, AbortSignal.timeout(30000));
      // It went out in that earlier window already and its echo is here: the same transaction id gave the same event.
      settleChat(r, it.txn, res, it.content);
    } catch (err) {
      if (isNetErr(err)) {
        shown.waiting = true;
        r.version++;
        goOffline();
        break;
      }
      failLocal(r, it.txn, err, () => sendAgain(r, 'm.room.message', it.content, async () => it.content));
    }
    saveOutbox(outbox().filter((x) => x.txn !== it.txn));
  }
  flushing = false;
  refresh();
}

// ------------------------------------------------------------------ stash („Odložené“, app/stash.js)
// What Karchi stashes, and what agents draft, lives in account data on asus and shows in every window. This window
// writes it only through operations kept in localStorage (ep_stash_ops): they are applied to the server's latest copy
// until a sync shows them there, and checked again for a while after, in case a slower window wrote an older copy.
const RECHECK_MS = 10 * 60000;
const stashOpsKey = () => `ep_stash_ops:${S.userId}`;
// Read fresh before every change (another tab of this browser shares the list); what is drawn uses `stashRaw`.
const stashOps = () => (S.userId ? readJson(stashOpsKey(), []) : []);
let stashRaw = null; // { user, raw }: this window's operations as last read or written
function saveStashOps(ops) {
  const raw = JSON.stringify(ops);
  try { localStorage.setItem(stashOpsKey(), raw); } catch { return false; }
  stashRaw = { user: S.userId, raw };
  return true;
}
addEventListener('storage', (e) => { if (S.userId && e.key === stashOpsKey()) { stashRaw = null; renderSoon(); } });
let stashMemo = { server: null, raw: '', view: null, of: new Map() };
/** The stash as this window shows it: the server's copy with this window's operations on top. */
function stashNow() {
  if (stashRaw?.user !== S.userId) stashRaw = { user: S.userId, raw: S.userId ? localStorage.getItem(stashOpsKey()) || '[]' : '[]' };
  const server = S.account[STASH];
  if (stashMemo.server !== server || stashMemo.raw !== stashRaw.raw) {
    let ops = [];
    try { ops = JSON.parse(stashRaw.raw); } catch { /* unreadable: none */ }
    stashMemo = { server, raw: stashRaw.raw, view: applyStash(server, ops), of: new Map() };
  }
  return stashMemo.view;
}
const hiddenHere = new Set(); // items whose files are on their way into (or sit in) this window's box: they leave when it is sent
/** The items of these rooms, kept until the stash changes (every inbox row asks). */
function stashFor(rooms) {
  const view = stashNow();
  const key = rooms.join('|');
  let list = stashMemo.of.get(key);
  if (!list) stashMemo.of.set(key, (list = stashOf(view, rooms).filter((it) => !hiddenHere.has(it.id))));
  return list;
}
/** Records operations (durable here first), then sends them. False when this browser could not keep them. */
function stashDo(...ops) {
  const at = Date.now();
  if (!saveStashOps([...stashOps(), ...ops.map((op) => ({ ...op, at }))])) return false;
  flushStash();
  return true;
}
let stashBusy = null;
let stashAgain = false;
/** Puts this window's operations missing on the server there. Read first: the PUT replaces the whole copy. */
async function flushStash() {
  if (stashBusy) { stashAgain = true; return stashBusy; }
  if (!S.homeSynced || !S.userId || preview()) return;
  const user = S.userId;
  stashBusy = (async () => {
    try {
      const ops = stashOps();
      if (!ops.length) return;
      const now = await call('GET', `/user/${q(user)}/account_data/${STASH}`).catch((err) => (err.status === 404 ? {} : Promise.reject(err)));
      const todo = ops.filter((op) => !stashHas(now, op));
      if (todo.length) await call('PUT', `/user/${q(user)}/account_data/${STASH}`, applyStash(now, todo));
      // Seen on the server: kept a while longer to be checked against later copies, then forgotten.
      if (S.userId === user) saveStashOps(stashOps().map((op) => (ops.some((o) => o.at === op.at && sameOp(o, op)) ? { ...op, ok: op.ok || Date.now() } : op)));
      S.stashError = null;
    } catch (err) {
      if (isNetErr(err)) goOffline();
      // Refused (too big, a bad answer): said in the chat, and tried again a minute later, not on every sync.
      else { S.stashError = { at: Date.now(), text: err?.data?.error || err?.message || String(err?.status) }; render(); }
    } finally {
      stashBusy = null;
      if (stashAgain) { stashAgain = false; flushStash(); }
    }
  })();
  return stashBusy;
}
const sameOp = (a, b) => a.op === b.op && (a.op === 'add' ? a.item.id === b.item.id : a.id === b.id);
/** After a sync: operations the server's copy lacks go out again; confirmed ones are forgotten after a while. */
function checkStash() {
  if (!S.homeSynced || !S.userId) return;
  const server = S.account[STASH] || {};
  const ops = stashOps();
  const keep = ops.filter((op) => !(op.ok && Date.now() - op.ok > RECHECK_MS && stashHas(server, op)));
  if (keep.length !== ops.length) saveStashOps(keep);
  adoptAgentDrafts();
  checkStashSends();
  if (S.stashError && Date.now() - S.stashError.at < 60000) return;
  if (stashOps().some((op) => !stashHas(server, op))) flushStash();
}

/** Agents (`weft draft`, the relay) write drafts to sk.karchi.drafts; each lands in its chat's stash once. Only `weft`
 *  removes them there (a window writing that list could lose a draft an agent wrote meanwhile). */
function adoptAgentDrafts() {
  const view = stashNow();
  const ops = stashOps();
  const add = [];
  for (const it of S.account[AGENT_DRAFTS]?.items || []) {
    if (!it?.id || !it.room || !(it.body || it.files?.length) || Date.now() - (it.at || 0) > GONE_MS) continue;
    const op = { op: 'add', item: { id: `agent:${it.id}`, room: it.room, body: it.body || '', at: it.at, pos: it.at, by: it.by || 'agent', ...(it.files?.length ? { files: it.files } : {}), ...(it.relay ? { relay: it.relay } : {}) } };
    if (!stashHas(view, op) && !ops.some((o) => sameOp(o, op))) add.push(op);
  }
  if (add.length) stashDo(...add);
}

/** A chat's stash: a merged chat's from all its networks. */
const stashRooms = (r) => { const g = groupOf(r.id); return g ? g.rooms || [r.id] : [r.id]; };
const chatStash = (r) => stashFor(stashRooms(r));
const newStashId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** The message box goes to the stash and empties (after Ctrl+S or „Odložiť“ asked when to remind). Files are uploaded
 *  first (to asus only; they go to nobody); if that fails, everything stays in the box. With `remind` the chat also
 *  goes away until then, like Ctrl+L, and comes back with this item chosen. */
async function stashBox(r, remind = 0) {
  const draft = S.drafts.get(r.id) || '';
  const text = draft.trim();
  const files = [...(S.attach.get(r.id) || [])];
  if ((!text && !files.length) || S.stashing) return;
  // Names picked from the list go along (two people of the chat share them), relative to the stashed text.
  const lead = draft.search(/\S|$/);
  const picks = (picked.get(r.id) || []).filter((x) => x.at >= lead && x.at + x.key.length <= lead + text.length).map((x) => ({ ...x, at: x.at - lead }));
  let up = [];
  if (files.length) {
    S.stashing = r.id;
    render();
    try {
      up = await Promise.all(files.map(async (f) => { const c = await fileContent(f); return { url: c.url, name: f.name, mimetype: c.info.mimetype, size: f.size }; }));
    } catch {
      S.stashing = null;
      S.stashNote = { room: r.id, text: T('Prílohy sa nepodarilo odložiť (asus neodpovedá). Ostali v poli.') };
      render();
      return;
    }
    S.stashing = null;
  }
  const item = { id: newStashId(), room: r.id, body: text, at: Date.now(), pos: Date.now(), ...(up.length ? { files: up } : {}), ...(picks.length ? { picks } : {}), ...(remind ? { remind } : {}) };
  if (!stashDo({ op: 'add', item })) return render();
  const e = remind ? entryOf(r.id) : null;
  if (e) {
    if (selKey() === e.key) selectAfter(e);
    setChatState(e.key, { remind });
  }
  // Only what was stashed leaves the box: text typed or files added during the upload stay.
  const now = S.drafts.get(r.id) || '';
  if (now === draft) deleteDraft(r.id);
  else if (now.startsWith(draft)) setDraft(r.id, now.slice(draft.length).replace(/^\s+/, ''));
  const left = (S.attach.get(r.id) || []).filter((f) => !files.includes(f));
  if (left.length) S.attach.set(r.id, left);
  else S.attach.delete(r.id);
  if (!(S.drafts.get(r.id) || '').trim() && !left.length) {
    boxFrom.delete(r.id);
    if (S.replyTo?.room === r.id) S.replyTo = null; // the box is empty: the next message is no answer
  }
  S.stashNote = null;
  S.focusComposer = true;
  render();
}

const boxFrom = new Map(); // room id -> „Odpoveď z chatu …“: the box holds a relayed answer taken from the stash
const boxStash = new Map(); // room id -> ids of items with files in its box: they leave the stash once it is sent or emptied
/** The item goes into the chat's message box after what is typed there and leaves the stash. One with files stays
 *  there (hidden in this window) until the box is sent or emptied: files in a box do not survive a reload. */
function takeStashed(r, it) {
  if (S.editing?.room === r.id) return;
  S.stashSel = null;
  S.stashEdit = null;
  if (it.files?.length) return takeStashFiles(r, it);
  if (!stashDo({ op: 'del', id: it.id })) return;
  putInBox(r, it);
}
function putInBox(r, it) {
  const now = S.drafts.get(r.id) || '';
  const before = now.trimEnd() ? `${now.trimEnd()}\n` : '';
  if (it.body) {
    setDraft(r.id, before + it.body);
    if (it.picks?.length) { picked.set(r.id, [...(picked.get(r.id) || []), ...it.picks.map((x) => ({ ...x, at: x.at + before.length }))]); persistDrafts(); }
  }
  if (it.relay) boxFrom.set(r.id, T`Odpoveď z chatu ${it.relay.title || 'chat'}, pripravil Weft · pošli, uprav alebo odober`);
  S.focusComposer = true;
  render();
}
/** Sent or emptied: the items whose files were in this box are done. */
function doneBoxStash(roomId) {
  const ids = boxStash.get(roomId) || [];
  boxStash.delete(roomId);
  if (ids.length) stashDo(...ids.map((id) => ({ op: 'del', id })));
}
/** A taken item's files come down into the box's attachments, then its text; if they do not come, it stays stashed. */
async function takeStashFiles(r, it) {
  hiddenHere.add(it.id);
  stashMemo.of.clear();
  render();
  try {
    const files = await Promise.all(it.files.map(async (f) => {
      const [server, id] = f.url.slice(6).split('/');
      const res = await fetch(`/_matrix/client/v1/media/download/${q(server)}/${q(id)}`, { headers: { Authorization: `Bearer ${S.token}` } });
      if (!res.ok) throw new Error(res.status);
      const blob = await res.blob();
      return new File([blob], f.name || 'subor', { type: f.mimetype || blob.type });
    }));
    S.attach.set(r.id, [...(S.attach.get(r.id) || []), ...files]);
    for (const f of files) imageSize(f);
    boxStash.set(r.id, [...(boxStash.get(r.id) || []), it.id]);
    putInBox(r, it);
  } catch {
    hiddenHere.delete(it.id);
    stashMemo.of.clear();
    S.stashNote = { room: r.id, text: T('Prílohy sa nepodarilo stiahnuť, ostali odložené.') };
    render();
  }
}
/** „Poslať“: the item goes out now, beside whatever is in the box, once however many devices press it. A window's
 *  own send cannot promise that (each device has its own transaction ids), so the item goes to the send-later
 *  service: it sends with its one device and the item's id as the transaction id, and the homeserver lets one
 *  transaction id through once. Two devices hand over the same id, so a repeated write changes nothing. The service's
 *  list is one blob another window may overwrite with an older copy, so the hand-over is kept (ep_stash_send) and
 *  made again after every sync that lacks it, and the draft leaves the stash only once the service says it is sent. */
function sendStashed(r, it) {
  const to = S.rooms.get(it.room) && liveChat(S.rooms.get(it.room)) ? S.rooms.get(it.room) : r;
  if (it.files?.length) return takeStashed(r, it); // files come down first: they go out from the box
  const sends = stashSends();
  if (S.editing?.room === r.id || !it.body.trim() || sends[it.id]) return;
  const key = `stash:${it.id}`;
  if (it.picks?.length) picked.set(key, it.picks);
  let content;
  try { content = textMessage(to, it.body.trim(), 0, key); } finally { picked.delete(key); }
  if (!saveStashSends({ ...sends, [it.id]: { id: `stash-${it.id}`, room: to.id, content, at: Date.now() } })) return;
  noteHeldReply(to);
  render();
  pushStashSends();
}
const stashSendsKey = () => `ep_stash_send:${S.userId}`;
const stashSends = () => (S.userId ? readJson(stashSendsKey(), {}) : {});
function saveStashSends(sends) {
  try { localStorage.setItem(stashSendsKey(), JSON.stringify(sends)); return true; } catch { return false; }
}
let stashPushing = null;
let stashPushAgain = false;
/** Puts every waiting hand-over on the service's list as it is on the server now (one failed before this press is
 *  tried again, like its „Skúsiť znova“). */
function pushStashSends() {
  if (!Object.keys(stashSends()).length) return;
  if (stashPushing) { stashPushAgain = true; return; } // a press during a write: written right after it
  stashPushing = saveLater((list) => {
    const sends = Object.values(stashSends());
    let out = list;
    const olds = {};
    for (const s of sends) {
      const x = out.find((y) => y.id === s.id);
      // `old`, noted at the first write from the server's list: a failure from before this press, retried here and
      // told apart from a new one without comparing this device's clock with the server's.
      if (s.old === undefined) olds[s.id] = x?.failed || 0;
      if (!x) out = [...out, { id: s.id, room: s.room, at: s.at, seq: 0, content: s.content }];
      else if (x.failed && x.failed === (s.old ?? x.failed)) out = out.map((y) => (y === x ? { ...x, at: s.at, failed: undefined, error: undefined } : y));
    }
    const cur = stashSends();
    for (const v of Object.values(cur)) if (v.old === undefined && v.id in olds) v.old = olds[v.id];
    saveStashSends(cur);
    return out;
  }).finally(() => {
    stashPushing = null;
    if (stashPushAgain) { stashPushAgain = false; pushStashSends(); }
  });
}
/** After a sync: a sent hand-over takes its draft out of the stash, a refused one leaves it with the reason, one the
 *  list lacks (another window wrote over it) is made again. Older than the service keeps its record: never again. */
function checkStashSends() {
  const sends = stashSends();
  // A draft another window handed over and the service sent (that window may be closed by now) leaves here too.
  const sentHere = (stashNow().items || []).filter((it) => !sends[it.id] && laterItems().some((y) => y.id === `stash-${it.id}` && y.sent));
  if (sentHere.length) stashDo(...sentHere.map((it) => ({ op: 'del', id: it.id })));
  const ids = Object.keys(sends);
  if (!ids.length) return;
  const left = { ...sends };
  let missing = false;
  for (const sid of ids) {
    const s = sends[sid];
    const x = laterItems().find((y) => y.id === s.id);
    if (x?.sent) { stashDo({ op: 'del', id: sid }); delete left[sid]; }
    else if (x?.failed && s.old !== undefined && x.failed !== s.old) { delete left[sid]; S.stashNote = { room: s.room, text: T`Koncept neodišiel (${x.error || '?'}), ostáva v Odložených.` }; }
    else if (Date.now() - s.at > 6 * 864e5) delete left[sid];
    else if (!x || x.failed) missing = true; // the list lacks it, or still has the old failure: made again
  }
  if (Object.keys(left).length !== ids.length) { saveStashSends(left); render(); }
  if (missing) pushStashSends();
}
/** Saves an edited item as a new one in its place; a window that changed the same item meanwhile keeps its version too. */
function saveStashEdit(it, body) {
  S.stashEdit = null;
  if (body.trim() === it.body.trim()) return render();
  const id = newStashId();
  // Under a millisecond off the old place (a ms timestamp still tells it apart): two windows' versions never tie.
  const item = { ...it, id, body: body.trim(), from: it.from || it.id, at: Date.now(), pos: (it.pos ?? it.at ?? 0) + Math.random() };
  delete item.twin;
  delete item.elsewhere; // only how this window showed it
  if (!body.trim()) stashDo({ op: 'del', id: it.id });
  else stashDo({ op: 'add', item }, { op: 'del', id: it.id });
  S.stashSel = body.trim() ? id : null;
  render();
}
/** Alt+↑/↓: the item swaps places with its neighbour (as a new item, so moves from two windows never fight). */
function moveStashed(r, it, by) {
  const list = chatStash(r);
  const i = list.findIndex((x) => x.id === it.id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return;
  const other = list[j];
  const near = list[j + by];
  const pa = other.pos ?? other.at ?? 0;
  const pb = near ? near.pos ?? near.at ?? 0 : pa + (by < 0 ? 1000 : -1000);
  const mid = (pa + pb) / 2;
  let pos = mid;
  const ops = [];
  if (mid === pa || mid === pb) {
    // The neighbour and the next one tie (old data), so nothing fits between: the neighbour steps aside, by more than
    // a timestamp's rounding, and the item takes its place.
    const step = 0.01 + Math.random() / 100;
    const { twin: t, elsewhere: x, ...o } = other;
    ops.push({ op: 'add', item: { ...o, id: newStashId(), pos: pa + 2 * by * step } }, { op: 'del', id: other.id });
    pos = pa + by * step;
  }
  const id = newStashId();
  const { twin, elsewhere, ...rest } = it;
  stashDo({ op: 'add', item: { ...rest, id, pos } }, { op: 'del', id: it.id }, ...ops);
  S.stashSel = id;
  render();
}
/** Delete: gone from the stash; „Vrátiť“ (or Ctrl+Z in the list) brings it back for a while. */
function dropStashed(r, it) {
  if (!stashDo({ op: 'del', id: it.id })) return;
  const list = chatStash(r);
  S.stashSel = list[0]?.id || null;
  const { twin, elsewhere, ...rest } = it;
  S.stashUndo = { room: r.id, item: rest, until: Date.now() + 15000 };
  setTimeout(() => { if (S.stashUndo?.item === rest && Date.now() >= S.stashUndo.until) { S.stashUndo = null; render(); } }, 15100);
  render();
}
function undoStashDrop() {
  const u = S.stashUndo;
  if (!u) return;
  S.stashUndo = null;
  const id = newStashId();
  stashDo({ op: 'add', item: { ...u.item, id } });
  S.stashSel = id;
  render();
}
/** Ctrl+S anywhere in an open chat: a box with something in it asks when to remind (Ctrl+S or Enter again: no
 *  reminder) and goes to the stash; an empty one takes the only item, or opens the list with the keyboard on it. */
function stashShortcut() {
  const r = S.rooms.get(S.selected);
  if (!r || !liveChat(r) || S.editing || rec) return;
  if ((S.drafts.get(r.id) || '').trim() || S.attach.get(r.id)?.length) return openStashAsk(r);
  const list = chatStash(r);
  if (list.length === 1) return takeStashed(r, list[0]);
  if (!list.length) return;
  S.stashOpen = { ...S.stashOpen, [keyOfRoom(r.id)]: true };
  S.stashSel = list[0].id;
  render();
  document.querySelector('.stashlist')?.focus();
}
const openStashAsk = (r) => { if (!S.stashing) openOverlay('stashask', { room: r.id }); };
/** „Odložiť: …“ – only stash, or stash and remind at one of Ctrl+L's times (the same numbers). */
function stashAskView(o) {
  const r = S.rooms.get(o.room);
  const choices = remindChoices();
  const go = (ts) => { S.overlay = null; render(); if (r) stashBox(r, ts); };
  o.flat = [() => go(0), ...choices.map(([, ts]) => () => go(ts))];
  return [
    h('div', { class: 'rsec' }, T`Odložiť koncept a pripomenúť: ${entryOf(o.room)?.title || ''}`),
    h('div', { class: 'results', ...listScroll(o), tabindex: -1, 'data-root': '__overlay', onkeydown: (ev) => {
      const n = Number(ev.key);
      if (n >= 1 && n <= choices.length) { ev.preventDefault(); o.flat[n](); }
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); o.index = (o.index + (ev.key === 'ArrowDown' ? 1 : -1) + o.flat.length) % o.flat.length; render(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); o.flat[o.index](); }
    } },
    resultRow(o, null, 0, [h('kbd', { class: 'num' }, 'Ctrl+S'), h('div', { class: 'rmeta' }, h('b', {}, T('Len odložiť'))), h('time', {}, T('bez pripomienky'))]),
    choices.map(([label, ts], i) => resultRow(o, null, i + 1, [h('kbd', { class: 'num' }, String(i + 1)), h('div', { class: 'rmeta' }, h('b', {}, label)), h('time', {}, `${dayLabel(ts)} ${timeLabel(ts)}`)]))),
  ];
}
function startStashEdit(it) {
  S.stashSel = it.id;
  S.stashEdit = { id: it.id, text: it.body, item: it };
  render();
  const box = document.querySelector('.stashedit');
  if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); autosize(box); }
}
/** The list has the keyboard (its rows have no focus of their own): ↑ ↓ choose, Enter takes, Ctrl+Enter sends, E edits,
 *  Alt+↑ ↓ moves, Delete removes, Ctrl+Z brings it back, Esc goes back to the message box. */
function stashKey(e, r) {
  if (e.target.tagName === 'TEXTAREA' || e.isComposing) return;
  if (e.target !== e.currentTarget && e.target.closest('button')) return; // a focused action button keeps its own keys
  const list = chatStash(r);
  if (!list.length) return;
  keepStashOpen(r);
  const i = Math.max(0, list.findIndex((x) => x.id === S.stashSel));
  const it = list[i];
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  // After each key the chosen row is brought into sight inside the list (it may be a newly drawn list).
  const done = (fn) => {
    e.preventDefault(); e.stopPropagation(); fn();
    requestAnimationFrame(() => document.querySelector('.stashlist .stashrow.on')?.scrollIntoView({ block: 'nearest' }));
  };
  if (e.altKey && (key === 'arrowup' || key === 'arrowdown')) return done(() => moveStashed(r, it, key === 'arrowup' ? -1 : 1));
  if (key === 'arrowdown' || key === 'arrowup') return done(() => { S.stashSel = list[(i + (key === 'arrowdown' ? 1 : -1) + list.length) % list.length].id; render(); });
  if (key === 'enter' && mod) return done(() => sendStashed(r, it));
  if (key === 'enter' || (mod && key === 's')) return done(() => takeStashed(r, it));
  if (key === 'delete' || key === 'backspace') return done(() => dropStashed(r, it));
  if ((key === 'e' || key === 'f2') && !mod && !e.altKey) return done(() => startStashEdit(it));
  if (mod && key === 'z') return done(undoStashDrop);
  if (key === 'escape') return done(() => { S.focusComposer = true; render(); });
}
/** Once Karchi works in the list it stays open, whatever comes on top. */
const keepStashOpen = (r) => { const key = keyOfRoom(r.id); if (S.stashOpen?.[key] === undefined) S.stashOpen = { ...S.stashOpen, [key]: true }; };
/** The chat's stash over its message box: „Odložené N“, open by itself when an agent's draft is on top. */
function stashView(r) {
  if (S.editing?.room === r.id) return null; // the box holds a sent message being edited: nothing goes into it
  let list = chatStash(r);
  // An item being edited here that another window took, changed or moved meanwhile: the editor stays, and saving
  // keeps this version as a new item.
  const ed = S.stashEdit;
  if (ed && stashRooms(r).includes(ed.item.room) && !list.some((x) => x.id === ed.id)) list = [{ ...ed.item, elsewhere: true }, ...list];
  const undo = S.stashUndo?.room === r.id && S.stashUndo.until > Date.now() ? S.stashUndo : null;
  const note = S.stashNote?.room === r.id ? S.stashNote.text : S.stashError ? T`Odložené sa na asus neuložili (${S.stashError.text}); skúsim to znova o minútu.` : '';
  if (!list.length && !undo && !note && S.stashing !== r.id) return null;
  const key = keyOfRoom(r.id);
  const open = S.stashOpen?.[key] ?? !!list[0]?.by;
  const sel = list.find((x) => x.id === S.stashSel) || list[0];
  const toggle = () => { S.stashOpen = { ...S.stashOpen, [key]: !open }; render(); };
  return h('div', { class: 'stash', 'data-key': 'stash' },
    list.length ? h('button', { class: 'stashhead', 'aria-expanded': String(open), title: open ? T('Skryť odložené') : T('Ukázať odložené (Ctrl+S v prázdnom poli)'), onclick: toggle },
      icon('clipboard-note'), h('span', {}, T('Odložené')), h('b', {}, String(list.length)), icon(open ? 'arrow-down' : 'arrow-right')) : null,
    open && list.length ? h('div', {
      class: 'stashlist', tabindex: 0, role: 'listbox', 'aria-label': T('Odložené koncepty'),
      'aria-activedescendant': sel ? `stash-${sel.id}` : undefined, onkeydown: (e) => stashKey(e, r),
    }, list.map((it) => stashRow(r, it, it === sel)),
    h('small', { class: 'stashkeys' }, T('Enter vziať · Ctrl+Enter poslať · E upraviť · Alt+↑↓ posunúť · Del zmazať · Esc späť'))) : null,
    S.stashing === r.id ? h('div', { class: 'stashinfo' }, h('span', {}, T('Odkladám prílohy…'))) : null,
    note ? h('div', { class: 'stashinfo' }, h('span', {}, note), S.stashNote ? h('button', { class: 'ghost', title: T('Zavrieť'), onclick: () => { S.stashNote = null; render(); } }, icon('close')) : null) : null,
    undo ? h('div', { class: 'stashinfo' }, h('span', {}, T('Odložený koncept je zmazaný.')),
      h('button', { class: 'ghost', title: 'Ctrl+Z', onclick: undoStashDrop }, icon('undo'), h('span', {}, T('Vrátiť')))) : null);
}
function stashRow(r, it, on) {
  const editing = S.stashEdit?.id === it.id;
  const net = it.room !== r.id ? appOf(S.rooms.get(it.room)?.app)?.name : '';
  const meta = [
    it.by ? T`od ${it.by === 'agent' ? T('agenta') : it.by}` : '',
    it.twin ? T('iná verzia (upravené v dvoch oknách)') : '',
    it.remind > Date.now() && entryOf(it.room)?.remind ? T`pripomenie sa ${dayLabel(it.remind)} ${timeLabel(it.remind)}` : '',
    it.elsewhere ? T('medzitým zmenené v inom okne; uloží sa ako nový') : '',
    stashSends()[it.id] || laterItems().some((y) => y.id === `stash-${it.id}` && !y.sent && !y.failed) ? T('odosiela sa…') : '',
    it.relay ? T`odpoveď z chatu ${it.relay.title || 'chat'}` : '',
    it.files?.length ? T`súbory: ${it.files.length}` : '',
    net ? T`cez ${net}` : '',
    it.at ? `${dayLabel(it.at)} ${timeLabel(it.at)}` : '',
  ].filter(Boolean).join(' · ');
  return h('div', {
    class: `stashrow${on ? ' on' : ''}${it.twin ? ' twin' : ''}`, id: `stash-${it.id}`, 'data-key': it.id, role: 'option', 'aria-selected': String(on),
    onclick: (e) => {
      keepStashOpen(r);
      if (e.target.closest('button, textarea')) return;
      S.stashSel = it.id;
      const list = e.currentTarget.closest('.stashlist');
      render();
      list?.focus();
    },
  },
  editing ? h('textarea', {
    class: 'stashedit', rows: 1, value: S.stashEdit.text, 'aria-label': T('Upraviť odložený koncept'),
    oninput: (e) => { S.stashEdit.text = e.target.value; autosize(e.target); },
    onkeydown: (e) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const list = e.target.closest('.stashlist'); S.stashEdit = null; render(); list?.focus(); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); const list = e.target.closest('.stashlist'); saveStashEdit(it, e.target.value); list?.focus(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); saveStashEdit(it, e.target.value); }
    },
  }) : h('div', { class: 'stashtext' }, it.body || (it.files || []).map((f) => f.name).join(', ')),
  meta ? h('small', {}, meta) : null,
  on && !editing ? h('div', { class: 'stashacts' },
    h('button', { class: 'ghost', title: T('Do poľa správy (Enter)'), onclick: () => takeStashed(r, it) }, icon('arrow-down'), h('span', {}, T('Vziať'))),
    it.files?.length ? null : h('button', { class: 'ghost', title: T('Poslať hneď, pole správy ostane (Ctrl+Enter)'), onclick: () => sendStashed(r, it) }, icon('arrow-up'), h('span', {}, T('Poslať'))),
    h('button', { class: 'ghost', title: T('Upraviť tu (E)'), onclick: () => startStashEdit(it) }, icon('pencil'), h('span', {}, T('Upraviť'))),
    h('button', { class: 'ghost', title: T('Posunúť vyššie (Alt+↑)'), onclick: () => moveStashed(r, it, -1) }, icon('arrow-up'), h('span', {}, T('Vyššie'))),
    h('button', { class: 'ghost', title: T('Posunúť nižšie (Alt+↓)'), onclick: () => moveStashed(r, it, 1) }, icon('arrow-down'), h('span', {}, T('Nižšie'))),
    h('button', { class: 'ghost', title: T('Zmazať (Delete), dá sa vrátiť'), onclick: () => dropStashed(r, it) }, icon('trash'), h('span', {}, T('Zmazať')))) : null);
}

const accountOut = () => readJson('ep_account_out', {});
/** Saves account data; offline the change stays here and goes out once the server answers. */
function putAccount(type, content) {
  S.account[type] = content;
  // Online before the first sync the copy's account data may be old: the change goes out once sync has brought the
  // server's (applySync), so it never overwrites what another device changed meanwhile.
  if (preview()) { (S.previewOut ||= new Map()).set(type, content); return Promise.resolve(); }
  return call('PUT', `/user/${q(S.userId)}/account_data/${type}`, content).then(() => {
    const out = accountOut();
    if (JSON.stringify(out[type]) !== JSON.stringify(content)) return;
    delete out[type];
    localStorage.setItem('ep_account_out', JSON.stringify(out));
  }, (err) => {
    if (!isNetErr(err)) throw err;
    localStorage.setItem('ep_account_out', JSON.stringify({ ...accountOut(), [type]: content }));
    goOffline();
  });
}

// ------------------------------------------------------------------ sync

const FILTER = JSON.stringify({
  presence: { not_types: ['*'] },
  room: {
    timeline: { limit: 40, types: TIMELINE_TYPES },
    state: { types: ['m.room.create', 'm.room.member', 'm.room.name', 'm.room.avatar', 'm.bridge'] },
    ephemeral: { types: ['m.receipt', 'm.typing'] },
    account_data: { not_types: ['*'] },
  },
});

async function syncLoop() {
  let since = null;
  for (;;) {
    try {
      // Offline a cheap question goes first: a sync to a sleeping asus would hang for minutes.
      if (S.offline) await call('GET', '/versions', undefined, '/_matrix/client', AbortSignal.timeout(4000));
      // set_presence=offline: reading here never shows Karchi as online anywhere.
      const params = `filter=${q(FILTER)}&set_presence=offline&timeout=${since ? 30000 : 0}${since ? `&since=${q(since)}` : ''}`;
      const data = await call('GET', `/sync?${params}`, undefined, undefined, AbortSignal.timeout(since ? 45000 : 120000));
      const first = !since;
      since = data.next_batch;
      const back = S.offline;
      S.offline = false;
      applySync(data, first);
      // What waits from an earlier window goes out once the first sync is in, online start or not.
      if (back) reconnected(); else if (first) flushAll();
    } catch (err) {
      if (err.status === 401) {
        clearSession();
        return show('login');
      }
      if (isNetErr(err)) goOffline();
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function applySync(data, first = false) {
  // A change made offline wins over the server's older copy until it is sent.
  for (const ev of data.account_data?.events || []) {
    if (ev.type === WINDOW) takeWindow(ev.content);
    else if (!(ev.type in accountOut())) S.account[ev.type] = ev.content;
    if (ev.type === NICKS) namesChanged();
    if (ev.type === CALLS) ringRecheck(); // chosen on another device: what rings now follows it
    if (ev.type === CAL_PREFS) calRemindCheck(); // reminders switched on here or elsewhere ring what is due now
  }
  for (const [roomId, room] of Object.entries(data.rooms?.join || {})) {
    const all = [...(room.state?.events || []), ...(room.timeline?.events || [])];
    const create = all.find((ev) => ev.type === 'm.room.create');
    const creator = create && (create.content?.creator || create.sender);
    if (creator && creator.slice(1).split(':')[0] === BOT_LOCALPART && (!S.roomId || S.eduKept)) {
      if (S.eduKept && S.roomId && S.roomId !== roomId) S.events.clear(); // the kept copy's were another room's
      S.eduKept = false;
      S.roomId = roomId;
      loadHistory(room.timeline?.prev_batch);
    }
    if (roomId === S.roomId) all.forEach(addEvent);
    else updateRoom(roomOf(roomId), room);
    if (!first && roomId !== S.roomId) ringCalls(S.rooms.get(roomId), room.timeline?.events);
    // A bridge bot's state notice (logged out, connected again): the accounts' bar follows it.
    if (room.timeline?.events?.some((ev) => ev.content?.['fi.mau.bridge_state'])) linksSoon();
  }
  for (const roomId of Object.keys(data.rooms?.leave || {})) {
    if (roomId === S.roomId) resetRoom();
    S.rooms.delete(roomId);
  }
  // The first sync lists every joined room: one only the kept copy had was left meanwhile.
  if (first && S.fromSnapshot) {
    const joined = data.rooms?.join || {};
    const waiting = new Set(outbox().map((it) => it.room));
    for (const id of S.snapRooms || []) {
      if (id in joined || waiting.has(id) || S.rooms.get(id)?.archiveOnly) continue;
      S.rooms.delete(id);
      if (S.selected === id) S.selected = null;
    }
    S.fromSnapshot = false;
    S.snapRooms = null;
    // What Karchi changed meanwhile goes out now: the inbox state as his changes over the server's, the rest as he left it.
    const out = S.previewOut || new Map();
    const patches = S.previewPatches || [];
    S.previewOut = S.previewPatches = null;
    if (out.has(INBOX)) {
      let inbox = { ...inboxState() };
      for (const [key, patch] of patches) inbox = patchInbox(inbox, key, patch);
      out.set(INBOX, (S.account[INBOX] = inbox));
    }
    for (const [type, content] of out) putAccount(type, type === INBOX ? content : (S.account[type] = content)).catch(() => {});
  }
  refreshArchiveChats();
  keepBatchesHeld();
  if (!S.homeSynced) {
    S.homeSynced = true;
    cal.view = calDefault();
    loadCalendar();
    feed.load();
  }
  prefetchSoon();
  checkStash();
  autoMergeSoon();
  keepSoon();
  refresh();
}

/** Exports also contain old conversations without a current bridge room. Keep them searchable and read-only. */
function refreshArchiveChats(force = false) {
  loadDiscord(force);
  if (S.archiveLoading) return S.archiveLoading;
  if (!force && Date.now() - (S.archiveAt || 0) < 5 * 60e3) return Promise.resolve();
  S.archiveLoading = readArchiveChats().finally(() => { S.archiveLoading = null; });
  return S.archiveLoading;
}

async function readArchiveChats() {
  const token = S.token;
  try {
    // An unchanged list answers 304 to the tag of the last one taken: thousands of old mail threads are not walked again.
    const tag = S.archiveTag?.token === token ? S.archiveTag.etag : '';
    const res = await fetch('/_archive/chats', { cache: 'no-store', headers: { Authorization: `Bearer ${token}`, ...(tag ? { 'If-None-Match': tag } : {}) } });
    if (res.status === 304) { if (S.token === token) S.archiveAt = Date.now(); return; }
    if (!res.ok) return;
    const { chats = [] } = await res.json();
    if (S.token !== token) return;
    takeArchiveChats(chats);
    S.archiveAt = Date.now();
    S.archiveTag = { token, etag: res.headers.get('ETag') || '' };
    refresh();
    // Kept for the next start, so Ctrl+K finds these people at once (previews cut short: the archive has the rest);
    // written again only when a chat or its last message changed.
    const user = S.userId;
    const sig = archiveSig(chats);
    if (sig === S.archiveKept) return;
    const slim = chats.map((c) => ({ ...c, last: c.last && { ...c.last, body: String(c.last.body || '').slice(0, 200) } }));
    (globalThis.requestIdleCallback || setTimeout)(() => {
      if (S.token === token) kvDo('readwrite', (st) => st.put({ user, chats: slim }, 'archive')).then(() => { S.archiveKept = sig; }, () => {});
    });
  } catch { /* Existing history remains usable; the next sync retries. */ }
}
/** The archive's chats as the last start had them, taken once the inbox is drawn, until the first sync's asks asus
 *  for the current ones. Without a copy (the first start) asus is asked at once, beside the first sync. */
function keptArchive(run) {
  const token = S.token;
  kvDo('readonly', (st) => st.get('archive')).catch(() => null).then((kept) => {
    if (run !== bootRun || S.token !== token) return;
    if (kept?.user !== S.userId || !Array.isArray(kept.chats) || !kept.chats.length) return void refreshArchiveChats(true);
    (globalThis.requestIdleCallback || setTimeout)(() => {
      if (run !== bootRun || S.token !== token || S.archiveAt) return; // asus answered first: its list is newer
      takeArchiveChats(kept.chats);
      S.archiveKept = archiveSig(kept.chats);
      refresh();
    }, { timeout: 1000 });
  });
}
const archiveSig = (chats) => `${S.userId}|${chats.map((c) => `${c.id} ${c.network} ${c.title} ${c.last?.id} ${c.to ? JSON.stringify(c.to) : ''}`).join('|')}`;
/** Makes a room of each old chat only the archive has. A preview already here stays (the kept copy's is cut short:
 *  its chat loads the whole message when opened), so asus's answer changes only what is new. */
function takeArchiveChats(chats) {
  const current = new Set();
  for (const chat of chats) {
    if (!chat.id?.startsWith('archive:')) continue;
    current.add(chat.id);
    const fresh = !S.rooms.has(chat.id);
    const r = roomOf(chat.id);
    if (fresh || r.app !== chat.network || r.bridgeName !== chat.title || JSON.stringify(r.archiveTo) !== JSON.stringify(chat.to || null)) S.archiveGen++;
    r.archiveOnly = true;
    r.app = chat.network;
    r.bridgeName = chat.title;
    r.archiveTo = chat.to || null; // how its person can be written to again (writeArchived)
    r.matrixDone = true;
    r.readAt = Infinity;
    if (chat.last && !r.events.has(chat.last.id)) {
      r.events.set(chat.last.id, archivedEvent(r, chat.last));
      r.historyDone = false;
      r.version++;
    }
  }
  for (const [id, r] of S.rooms) if (r.archiveOnly && !current.has(id)) { S.rooms.delete(id); S.archiveGen++; }
}

// ------------------------------------------------------------------ bridged chats

function roomOf(id) {
  let r = S.rooms.get(id);
  if (!r) {
    r = {
      id,
      app: null, // messenger | instagram | discord; null for rooms that are not chats (bridge bots, spaces)
      space: false,
      created: 0, // m.room.create time
      state: new Map(), // `${type}|${state_key}` -> content
      members: new Map(), // mxid -> { name, avatar, membership }
      events: new Map(), // event id -> timeline event (messages, reactions, redactions)
      pending: new Map(), // txn id -> own message not yet echoed
      receipts: new Map(), // mxid -> event id read up to
      receiptAt: new Map(), // mxid -> when that receipt was sent (the homeserver's ts)
      readAt: 0, // when Karchi last read the room (his receipt's ts)
      typing: [], // mxids the bridge says are typing now (the homeserver ends it when they stop)
      unread: 0, // the server's notification count
      prevBatch: null,
      matrixDone: false, // paged back to the room's start on Matrix; older ones come from the archive
      historyDone: false, // and the archive has nothing older either
      archiveUntil: 0, // where the archive's exports end
      loading: false,
      version: 0,
      readSent: '',
    };
    S.rooms.set(id, r);
  }
  return r;
}

function roomState(r, ev) {
  r.state.set(`${ev.type}|${ev.state_key}`, ev.content || {});
  if (ev.type === 'm.room.member') {
    const c = ev.content || {};
    r.members.set(ev.state_key, { name: c.displayname, avatar: c.avatar_url, membership: c.membership });
    // A plain Matrix chat with one of Karchi's agents on this homeserver is that agent's own app.
    if (!r.app && AGENTS[ev.state_key.split(':')[0]]) r.app = AGENTS[ev.state_key.split(':')[0]];
  } else if (ev.type === 'm.bridge' && NETWORKS[ev.content?.protocol?.id]) {
    r.app = NETWORKS[ev.content.protocol.id];
    r.bridgeName = ev.content.channel?.displayname;
    // A Discord server's channel: its server, so "#general" says whose (and a search for the server finds it).
    const net = ev.content.network;
    const guild = r.app === 'discord' && net?.id && net.id !== ev.content.channel?.id;
    r.server = guild ? net.displayname || '' : '';
    r.serverId = guild ? net.id : '';
    // WhatsApp's statuses come into one room; they show in each person's profile, never as a chat (profileView).
    r.statusRoom = r.app === 'whatsapp' && ev.content.channel?.id === 'status@broadcast';
  } else if (ev.type === 'm.room.create') {
    r.space = ev.content?.type === 'm.space';
    r.created = ev.origin_server_ts || 0;
  }
}

/** Where the same chat is on its network's web, for a call Karchi starts or takes there himself: { network, id, url }
 *  or null. Only from the bridge's own room state (m.bridge), only ids of digits, only fixed address forms. Weft opens
 *  the chat and never calls: an address that rings someone by itself is not made here (only the desktop shell's
 *  Discord window, a beta Karchi switches on, presses the call button for him). WhatsApp names a chat by phone,
 *  which the room does not carry, so its web opens on the chat list. */
function callTarget(r) {
  if (!r || r.archiveOnly) return null;
  let b = null;
  for (const [key, c] of r.state) if (key.startsWith('m.bridge|') && NETWORKS[c?.protocol?.id]) b = c;
  const network = b && NETWORKS[b.protocol.id];
  const id = String(b?.channel?.id ?? '');
  const digits = (x) => /^\d{1,64}$/.test(x);
  if (network === 'messenger' && digits(id)) return { network, id, url: `https://www.messenger.com/t/${id}` };
  if (network === 'instagram' && digits(id)) return { network, id, url: `https://www.instagram.com/direct/t/${id}/` };
  if (network === 'discord' && digits(id)) {
    // A server's channel names its server in network.id; a DM or group DM has none (or its own id there).
    const guild = String(b.network?.id ?? '');
    if (guild && guild !== id) return digits(guild) ? { network, id, url: `https://discord.com/channels/${guild}/${id}` } : null;
    return { network, id, url: `https://discord.com/channels/@me/${id}` };
  }
  if (network === 'whatsapp') return { network, id: '', url: 'https://web.whatsapp.com/' };
  return null;
}
const CALL_WHERE = { messenger: T('Hovor: otvoriť chat v Messengeri'), instagram: T('Hovor: otvoriť chat na Instagrame'),
  discord: T('Hovor: otvoriť chat na Discorde'), whatsapp: T('Hovor: otvoriť WhatsApp Web (zoznam chatov)') };
/** The button's name: with the Discord beta on, the click calls. */
const callWhere = (network) => (network === 'discord' && callWindow('discord') ? T('Hovor: zavolať na Discorde (beta)') : CALL_WHERE[network]);
// Discord in the shell's call window, where the window presses the call button itself (beta, this device only).
const DISCORD_BETA = 'ep_call_discord_beta';
const discordBeta = () => localStorage.getItem(DISCORD_BETA) === '1';
/** Networks whose chat opens in the desktop shell's own call window (desktop/main.js), not in the browser. */
const callWindow = (network) => !!window.desktop?.call && (window.desktop.callNetworks || []).includes(network) && (network !== 'discord' || discordBeta());
/** The chat's call button, or null. In the desktop shell Messenger and Instagram wait for its call window: x270
 *  blocks facebook.com in its browser, so a plain link would lead nowhere there. */
function callButtonTarget(r) {
  const t = callTarget(r);
  if (!t) return null;
  // A server's text channel has no call: Discord calls only in DMs and group DMs (voice channels are not bridged).
  if (t.network === 'discord' && !t.url.includes('/@me/')) return null;
  if (window.desktop && ['messenger', 'instagram'].includes(t.network) && !callWindow(t.network)) return null;
  return t;
}
// Settings → Prístupnosť → Prehliadač, per device: a person's profile on Instagram or Facebook opens in the system's
// browser (default) or in the desktop app's follow window, which shows only the follow / add-friend button.
const BROWSER_PREF = 'ep_browser';
const canFollowWindow = () => !!window.desktop?.follow;
const followWindow = (network) => canFollowWindow() && (window.desktop.followNetworks || []).includes(network) && localStorage.getItem(BROWSER_PREF) === 'weft';
/** A link to a person's profile (`who`: an Instagram username, a Facebook profile id), named for where it goes. */
function profileLink(network, who, href, attrs, external, inWeft) {
  // A middle click (auxclick) goes the same way as a click.
  const open = (e) => {
    if (!followWindow(network) || (e.type === 'auxclick' && e.button !== 1)) return;
    e.preventDefault();
    window.desktop.follow({ network, who }).catch((err) => alert((LANG === 'sk' && String(err?.message || '').replace(/^.*Error: /, '')) || T('Okno sa neotvorilo.')));
  };
  return h('a', { ...attrs, href, target: '_blank', rel: 'noopener noreferrer', onclick: open, onauxclick: open }, followWindow(network) ? inWeft : external);
}

/** Opens the chat on its network (Karchi's own step out of Weft, so it works outside reading windows too). */
function openCall(r) {
  const t = callButtonTarget(r);
  if (!t) return;
  if (callWindow(t.network) && t.id) { // the window needs the chat's id (WhatsApp rooms carry none)
    // Electron puts „Error invoking remote method …: Error: “ before the shell's own sentence.
    // The shell answers in Slovak; English Weft says it in its own words.
    // A beta network goes only with its switch on: the shell refuses Discord without it (an older Weft never calls).
    window.desktop.call({ network: t.network, id: t.id, ...(t.network === 'discord' ? { beta: true } : {}) }).catch((err) => alert((LANG === 'sk' && String(err?.message || '').replace(/^.*Error: /, '')) || T('Okno hovoru sa neotvorilo.')));
    return;
  }
  window.open(t.url, '_blank', 'noopener');
}

/** `old`: from paging back, where state events are history and must not replace the current state. */
function roomEvent(r, ev, old = false) {
  if (ev.state_key !== undefined) {
    if (!old || !r.state.has(`${ev.type}|${ev.state_key}`)) roomState(r, ev);
    if (ev.type === 'm.room.member' && ev.event_id) r.events.set(ev.event_id, ev); // for "X je teraz v skupine"
    return;
  }
  if (!['m.room.message', 'm.sticker', 'm.reaction', 'm.room.redaction', ...POLL_TYPES].includes(ev.type)) return;
  const txn = ev.unsigned?.transaction_id;
  if (txn) { r.pending.delete(txn); r.events.delete(txn); }
  r.events.set(ev.event_id, ev);
}

function updateRoom(r, data) {
  for (const ev of data.state?.events || []) roomState(r, ev);
  const tl = data.timeline || {};
  // A gap after a long time offline: drop what is held and page back from the new start.
  if (tl.limited && r.events.size) { r.events.clear(); r.historyDone = r.matrixDone = false; r.prevBatch = null; r.epoch = (r.epoch || 0) + 1; r.archiveRetry = 0; }
  if (!r.prevBatch && !r.matrixDone) r.prevBatch = tl.prev_batch || null;
  for (const ev of tl.events || []) roomEvent(r, ev);
  if (data.unread_notifications) r.unread = data.unread_notifications.notification_count || 0;
  for (const ev of data.ephemeral?.events || []) {
    if (ev.type === 'm.typing') r.typing = (ev.content?.user_ids || []).filter((u) => u !== S.userId);
    if (ev.type !== 'm.receipt') continue;
    for (const [eventId, kinds] of Object.entries(ev.content || {})) {
      for (const [user, receipt] of Object.entries(kinds['m.read'] || {})) {
        r.receipts.set(user, eventId);
        if (receipt?.ts) r.receiptAt.set(user, receipt.ts); else r.receiptAt.delete(user);
        if (user !== S.userId) r.receiptStale = true; // the archive's log of this chat has a newer one
        if (user === S.userId) r.readAt = Math.max(r.readAt, receipt?.ts || 0);
      }
    }
  }
  r.version++;
}

const isChat = (r) => r.app && !r.space && !r.statusRoom;

/** Rooms muted on the network (the bridge sets a push rule without notify): the server counts none of their messages. */
function mutedRooms() {
  const g = S.account['m.push_rules']?.global || {};
  const silent = (rule) => rule.enabled !== false && !rule.actions?.includes('notify');
  const ids = (g.room || []).filter(silent).map((rule) => rule.rule_id);
  for (const rule of (g.override || []).filter((x) => !x.default && silent(x))) {
    for (const c of rule.conditions || []) if (c.key === 'room_id') ids.push(c.pattern);
  }
  return new Set(ids);
}

// ------------------------------------------------------------------ batches

/** Messages from others come when Karchi wants them: when he asks ('manual': the eye) or at the times he sets
 *  ('times'). "Hneď" ('live') is gone on purpose (Karchi, 16. 11.): a stored 'live', or none, shows everything
 *  until the first sync turns it into 'manual' (keepBatchesHeld), so nothing seen before is hidden. Either opens a reading window: for its few minutes messages come right away, also
 *  replies to what he wrote. The eye opens one of the day's few reading windows Feed shares (count and length set
 *  in Settings, kept by the feed server); clicking during one adds nothing. Mode and times change from tomorrow
 *  (`pending: {mode, times, from}`), so a change never opens anything today.
 *  One that arrived after a window stays out of sight (no unread mark, preview, move to the top or read receipt);
 *  what came before its end stays seen. Writing is never held. EduPage stays live unless he holds it too, and live
 *  it adds nothing to the window title's count. `since` is when he last saw everything: nothing before it is held. */
const BATCH_DEFAULT = { mode: 'live', times: ['07:00', '14:00', '20:00'], edupage: false };
// Asked for by every chat on every render: kept until the stored settings object is replaced (never mutate it).
let batchPrefsMemo = null;
function batchPrefs() {
  const src = S.account[BATCHES];
  const day = src?.pending ? calYmd(Date.now()) : '';
  if (batchPrefsMemo && batchPrefsMemo.src === src && batchPrefsMemo.day === day) return batchPrefsMemo.b;
  let b = { ...BATCH_DEFAULT, ...(src || {}) };
  // The first version stored only `on` (times).
  if (!src?.mode && b.on) b.mode = 'times';
  if (b.pending && b.pending.from <= day) b = takePending(b);
  batchPrefsMemo = { src, day, b };
  return b;
}
/** A waiting change on its day: what the old way showed by that midnight stays seen, and the new times count only
 *  from that midnight on (yesterday's new times would show what waited, without any window). */
function takePending(b) {
  const { from, ...change } = b.pending;
  const midnight = new Date(`${from}T00:00`).getTime();
  const { cut } = scheduledCut(b, midnight, windowMinutes() * 60000);
  return { ...b, ...change, pending: null, timesFrom: midnight, since: Math.max(b.since || 0, cut === Infinity ? midnight : cut) };
}
/** What Settings show and edit: the mode and times from tomorrow on when a change waits. */
function batchTarget() {
  const { from, ...change } = batchPrefs().pending || {};
  return { ...batchPrefs(), ...change };
}
const tomorrowYmd = () => { const d = new Date(); d.setDate(d.getDate() + 1); return calYmd(d); };
const BATCH_MODES = [['manual', T('Keď chcem')], ['times', T('V časoch')]];
/** No more "Hneď": an old setting, an older Weft window or a fresh account moves to "Keď chcem" from now on. */
function keepBatchesHeld() {
  if (batchPrefs().mode === 'live') return saveBatches({ mode: 'manual', pending: null }, true);
  // A change whose day came: stored as the settings now, so other devices and older windows see it too.
  if (S.account[BATCHES]?.pending && !batchPrefs().pending) {
    S.account[BATCHES] = batchPrefs();
    putAccount(BATCHES, S.account[BATCHES]).catch(() => {});
  }
}

/** The newest reading window this device knows: from account data or the feed server's last answer. */
const readingWindow = () => S.account[WINDOW] || null;
const windowMinutes = () => readingWindow()?.minutes || 10;
const windowOpen = (now = Date.now()) => { const w = readingWindow(); return !!w && now >= w.start && now < w.end; };
/** Today's windows not used yet (`count` and `used` come from the feed server; one from yesterday leaves all of today's). */
function windowsLeft() {
  const w = readingWindow();
  const today = calYmd(Date.now());
  if (w?.day === today) return Math.max(0, (w.count || 1) - (w.used || 1));
  const p = feed.policy();
  return (p?.next?.from <= today ? p.next.count : p?.count) || w?.count || 1;
}
/** "1 okno", "2 okná", "5 okien". */
const windowsWord = (n) => `${n} ${n === 1 ? T('okno') : n >= 2 && n <= 4 ? T('okná') : T('okien')}`;
/** The eye can open one of today's windows: some are left and none runs now. The feed server decides in the end. */
const canOpenWindow = () => !windowOpen() && windowsLeft() > 0;
/** Takes a window the feed server gave. A late answer never brings back an older window or a later end; the same
 *  window may come again with a new day's count and length. */
function takeWindow(w) {
  const old = S.account[WINDOW];
  if (!w || typeof w.start !== 'number' || typeof w.end !== 'number' || typeof w.day !== 'string') return false;
  if (old && (old.start > w.start || (old.start === w.start && old.end < w.end))) return false;
  if (old && old.start === w.start && old.end === w.end && old.used === w.used && old.count === w.count && old.minutes === w.minutes) return false;
  S.account[WINDOW] = w;
  return true;
}
/** Opens one of today's reading windows for waiting messages and Feed together; Feed's server keeps the count. */
function openWindow() {
  if (S.offline) return alert(T('Okno na čítanie sa otvorí, keď budeš online.'));
  feed.openWindow();
}

/** { cut: messages from others up to it show (Infinity while live), next: the coming batch time (0 when none),
 *  until: the end of the window that runs now (0 when none) }. */
let batchMemo = null; // the same until the next batch time or the end of a window
function batchWindow(now = Date.now()) {
  const b = batchPrefs();
  const rw = readingWindow();
  if (batchMemo && batchMemo.b === b && batchMemo.rw === rw && now >= batchMemo.from && now < batchMemo.until) return batchMemo.w;
  const w = batchWindowAt(b, now, rw);
  batchMemo = { b, rw, w, from: now, until: Math.min(w.next || Infinity, w.until || Infinity, rw && now < rw.start ? rw.start : Infinity) };
  return w;
}
function batchWindowAt(b, now, rw) {
  if (b.mode === 'live') return { cut: Infinity, next: 0, until: 0 };
  const base = scheduledCut(b, now, (rw?.minutes || 10) * 60000);
  // The eye's window: live while it runs, and what came before its end stays seen afterwards.
  if (rw && now >= rw.start && now < rw.end) return { cut: Infinity, next: base.next, until: Math.max(rw.end, base.until) };
  if (base.until) return base;
  return { ...base, cut: Math.max(base.cut, rw && rw.end <= now ? rw.end : 0) };
}
/** The cut of the chosen mode alone; a batch time opens a window of the same few minutes as the eye's. */
function scheduledCut(b, now, dur) {
  if (b.mode === 'manual') return { cut: b.since || 0, next: 0, until: 0 };
  const times = (b.times || []).filter((t) => /^\d\d:\d\d$/.test(t));
  if (!times.length) return { cut: b.since || 0, next: 0, until: 0 }; // no valid time: waits for the eye, never live
  // Turning batches on hides nothing that came before (he may have read it already): `since` is when he did.
  let cut = -Infinity;
  let next = Infinity;
  for (const days of [-1, 0, 1]) {
    for (const t of times) {
      const d = new Date(now);
      d.setDate(d.getDate() + days);
      d.setHours(Number(t.slice(0, 2)), Number(t.slice(3)), 0, 0);
      const at = d.getTime();
      if (at <= now) { if (at >= (b.timesFrom || 0)) cut = Math.max(cut, at); }
      else next = Math.min(next, at);
    }
  }
  if (cut + dur > now) return { cut: Infinity, next, until: cut + dur };
  return { cut: Math.max(cut + dur, b.since || 0), next, until: 0 };
}
// People marked „Práca“ (chat menu, Settings → Správy): { [user id]: { name, until? } }. What they write never waits
// for a reading window, in their own chat and in groups alike. Unmarked, a person keeps `until` (when): what came
// before it stays seen. Weft on every device reads the same account data.
const WORK = 'sk.karchi.work';
let workMemo = null;
let workVer = 0; // counts the lists seen, for the inbox rows' memo
/** User id -> the time up to which their messages come at once (Infinity while marked); kept until the stored
 *  object is replaced (never mutate it). */
function workTimes() {
  const src = S.account[WORK];
  if (!workMemo || workMemo.src !== src) {
    workVer++;
    workMemo = { src, times: new Map(Object.entries(src || {}).map(([id, w]) => [id, w?.until || Infinity])) };
  }
  return workMemo.times;
}
const isWork = (id) => workTimes().get(id) === Infinity;
const workPeople = () => Object.entries(S.account[WORK] || {}).filter(([id]) => isWork(id));
/** The people a chat entry is with (a merged chat's on each network); none for a group. */
const entryPeople = (e) => (e?.kind === 'room' ? (e.rooms || [e.room]).map((r) => dmPartner(r)).filter(Boolean) : []);
const entryWork = (e) => entryPeople(e).some(([id]) => isWork(id));
/** Marks or unmarks people (`[[user id, member?]]`) as work; their waiting messages show at once. */
function setWork(people, on) {
  const next = { ...(S.account[WORK] || {}) };
  for (const [id, m] of people) {
    if (!on && !isWork(id)) continue; // a merged chat's other networks were never marked: they keep waiting
    const name = next[id]?.name || bareName(m?.name || S.names.get(id) || id);
    next[id] = on ? { name } : { name, until: Date.now() };
  }
  putAccount(WORK, next).catch(() => alert(T('Nastavenie sa neuložilo.')));
  render();
}
// A bridge's „not bridged“ notice is about Karchi's own message: it never waits; neither does anything from work.
const isHeld = (ev, cut) => ev.origin_server_ts > cut && ev.sender !== S.userId && !bridgeFailure(ev) && !(ev.origin_server_ts <= (workTimes().get(ev.sender) || 0));
/** The time a bridged chat shows messages up to: the last batch, or later where Karchi chose "Ukázať teraz". */
function roomCut(r) {
  const { cut } = batchWindow();
  return cut === Infinity ? cut : Math.max(cut, inboxState()[r.id]?.shown || 0);
}
const eduCut = () => (batchPrefs().edupage ? Math.max(batchWindow().cut, batchPrefs().eduSince || 0) : Infinity);
/** A receipt never passes a held message, not even with Karchi's own later message: a bridge marks read by time,
 *  so a receipt on his reply would tell WhatsApp or Messenger he saw what still waits. */
function readUpTo(events, cut) {
  let firstHeld = Infinity;
  for (const ev of events) if (isHeld(ev, cut) && ev.origin_server_ts < firstHeld) firstHeld = ev.origin_server_ts;
  return events.filter((ev) => ev.origin_server_ts < firstHeld).sort((a, b) => b.origin_server_ts - a.origin_server_ts)[0];
}
/** The cut for any room id, for search results. */
const cutOf = (roomId) => (roomId === S.roomId ? eduCut() : S.rooms.has(roomId) ? roomCut(S.rooms.get(roomId)) : Infinity);

/** Karchi writes into a chat whose new messages wait: they would come in already read (his own message resets the
 *  server's count and stands after them), so the chat is marked to come back unread with their batch. */
function noteHeldReply(r) {
  const m = roomModel(r);
  if (m.held && !inboxState()[r.id]?.held) setChatState(r.id, { held: m.cut });
}
/** EduPage counts in the window title unless batches are on and it stays live, so it never draws the eye. */
const eduQuiet = () => batchPrefs().mode !== 'live' && !batchPrefs().edupage;

let batchTimer = 0;
let batchFor = 0;
/** Wakes the page at the next batch time or the end of a window. Called on each render. */
function scheduleBatch() {
  const { next: batch, until } = batchWindow();
  const next = Math.min(batch || Infinity, until || Infinity, windowOpen() ? readingWindow().end : Infinity);
  if (next === batchFor) return;
  clearTimeout(batchTimer);
  batchFor = next;
  // Timers stall while the laptop sleeps; the focus event re-renders on waking anyway.
  if (next && next !== Infinity) batchTimer = setTimeout(() => { batchFor = 0; S.view === 'main' && render(); }, Math.min(next - Date.now() + 500, 2 ** 31 - 1));
}

/** Saves batch settings. Mode, times and letting EduPage through wait for tomorrow (`now` only for moving off the
 *  old "Hneď"), so a change never shows anything today; holding EduPage too starts at once. */
async function saveBatches(patch, now = false) {
  const before = batchPrefs();
  // What he can see now stays seen: a change never hides it again (a later time, another mode, EduPage joining).
  const { cut } = batchWindow();
  const seen = { since: cut === Infinity ? Date.now() : Math.max(before.since || 0, cut) };
  if (patch.edupage && !before.edupage) seen.eduSince = Date.now();
  if (!now && ('mode' in patch || 'times' in patch || 'edupage' in patch)) {
    const { mode, times, edupage, ...rest } = patch;
    const target = batchTarget();
    const to = { mode: mode ?? target.mode, times: times ?? target.times, edupage: !!(edupage ?? target.edupage) };
    const edu = to.edupage || !!before.edupage;
    const same = to.mode === before.mode && to.times.join() === before.times.join() && to.edupage === edu;
    patch = { ...rest, edupage: edu, pending: same ? null : { ...to, from: tomorrowYmd() } };
  }
  const next = { ...before, ...seen, ...patch };
  delete next.on;
  S.account[BATCHES] = next;
  render();
  await putAccount(BATCHES, next).catch(() => alert(T('Nastavenie sa neuložilo.')));
}

/** The bar in a chat with held messages: when they come, and the way to see them now (one of today's windows). */
function heldBar(r, m) {
  if (!m.held) return null;
  const { next } = batchWindow();
  const one = m.held === 1;
  const can = canOpenWindow();
  return h('div', { class: 'held' },
    h('span', {}, next ? `${one ? T('Nová správa sa ukáže') : T('Nové správy sa ukážu')} o ${timeLabel(next)}.`
      : can ? T`${one ? T('Nová správa čaká.') : T('Nové správy čakajú.')} Dnes ešte ${windowsWord(windowsLeft())} na čítanie.`
      : T`${one ? T('Nová správa počká') : T('Nové správy počkajú')} na zajtrajšie okno.`),
    can ? h('button', { class: 'ghost', onclick: openWindow }, T`Ukázať na ${windowMinutes()} min`) : null);
}

/** Who is typing in a chat now, as far as Karchi may see it: someone whose message would wait for a batch is
 *  not shown typing either, and offline nothing is current. */
function typingIn(r) {
  if (S.offline || !r.typing.length) return [];
  const cut = roomCut(r);
  return r.typing.filter((sender) => !isHeld({ origin_server_ts: Date.now(), sender }, cut));
}
/** "píše…" under a chat's last message; in a group with names. */
function typingLine(parts, partner) {
  const who = parts.flatMap((x) => typingIn(x).map((id) => [x, id]));
  if (!who.length) return null;
  const names = who.map(([x, id]) => firstName(memberName(x, id)));
  return h('div', { class: 'typing', 'data-key': '__typing', role: 'status' },
    partner ? T('píše…') : names.length === 1 ? T`${names[0]} píše…` : T`${names.slice(0, -1).join(', ')} a ${names.at(-1)} píšu…`);
}

/** The eye beside the search: opens one of today's windows, shows while it runs, rests once all were used. */
function windowButton() {
  const open = windowOpen();
  const can = canOpenWindow();
  const title = open ? T`Nové správy a feed sú otvorené do ${timeLabel(readingWindow().end)}`
    : can ? T`Ukázať nové správy a feed na ${windowMinutes()} min (dnes ešte ${windowsWord(windowsLeft())})` : T('Dnešné okná na čítanie sa minuli. Ďalšie zajtra.');
  return h('button', { class: `filter reveal${open ? ' on' : ''}`, title, 'aria-label': title, 'aria-pressed': String(open), disabled: !can, onclick: openWindow }, icon('eye'));
}

/** Unread count of a room: the server's, or for a muted room the messages from others since Karchi read it. */
function roomUnread(r, m, muted) {
  // The server counts held messages too; they are not unread until their batch comes.
  if (r.unread || !muted.has(r.id)) return Math.max(0, r.unread - m.held);
  // With batches the receipt's own message says how far he read: a receipt sent at 16:00 stops before a held 15:00
  // message, so the time it was sent (readAt) must not count that message as read.
  const at = r.events.get(r.receipts.get(S.userId))?.origin_server_ts;
  const read = m.cut !== Infinity && at ? at : Math.max(r.readAt, at || 0);
  return m.messages.filter((ev) => ev.sender !== S.userId && ev.origin_server_ts > read).length;
}

/** Where a chat's unread messages start: others' first message after Karchi's read receipt and his own last one.
 *  `receipt` is his receipt as it was when the chat opened (reading it moves the live one to the end).
 *  Without the receipt's message the badge's `count` stands in; `short` means more are unread than loaded. */
function firstNew(r, count, receipt) {
  const list = roomModel(r).messages;
  const mine = list.findLastIndex((ev) => ev.sender === S.userId);
  const read = r.events.get(receipt)?.origin_server_ts;
  // By position, not time: an album's photos share one timestamp. A receipt on a reaction falls back to its time.
  const at = list.findIndex((ev) => ev.event_id === receipt);
  const after = read ? Math.max(mine, at >= 0 ? at : list.findLastIndex((ev) => ev.origin_server_ts <= read)) : mine;
  const others = list.slice(after + 1).filter((ev) => ev.sender !== S.userId);
  const ev = read ? others[0] : others.at(-Math.min(count, others.length));
  return { room: r.id, event: ev?.event_id, receipt, count, short: !read && mine < 0 && count > others.length && !r.matrixDone };
}

/** The bridge filling in media Weft asked for (a reel's video, a shared post's photos): the same sender replaces
 *  a picture that waited for it with a picture or video. No news, so it never waits for a reading window. */
function mediaFillIn(r, ev) {
  const orig = r.events.get(ev.content['m.relates_to'].event_id);
  const next = ev.content['m.new_content'];
  return !!(orig?.content?.['com.beeper.unresolved_media'] && orig.sender === ev.sender && ev.content['com.beeper.dont_render_edited']
    && ['m.image', 'm.video'].includes(next?.msgtype) && next.body === orig.content.body);
}

/** Messages of a room with edits, reactions and deletions applied; cached per room version. */
function roomModel(r) {
  const cut = roomCut(r);
  const work = workTimes();
  if (r.model?.version === r.version && r.model.pending === r.pending.size && r.model.cut === cut && r.model.work === work) return r.model;
  const all = [...r.events.values()].sort((a, b) => a.origin_server_ts - b.origin_server_ts);
  const redacted = new Set();
  for (const ev of all) if (ev.type === 'm.room.redaction') redacted.add(ev.redacts || ev.content?.redacts);
  const edits = new Map();
  const editCount = new Map(); // event id -> how many times it was edited
  const reactions = new Map(); // event id -> Map(key -> [sender])
  const ownReacts = new Map(); // `${event id}|${key}` -> id of Karchi's own reaction
  const votes = new Map(); // poll id -> Map(sender -> answer ids of their last vote)
  const votedAt = new Map(); // poll id -> when Karchi last voted
  const ended = new Set(); // poll ids
  const memberEvents = [];
  let messages = [];
  for (const ev of all) {
    const isMessage = ev.type === 'm.room.message' || POLL_START.includes(ev.type);
    // Others' reactions, votes and edits wait for the batch too; their messages are counted and left out below.
    if (!isMessage && ev.type !== 'm.sticker' && ev.type !== 'm.room.member' && ev.type !== 'm.room.redaction' && isHeld(ev, cut)) continue;
    if (isMessage && ev.content?.['m.relates_to']?.rel_type === 'm.replace' && !mediaFillIn(r, ev) && isHeld(ev, cut)) continue;
    if (redacted.has(ev.event_id) && !isMessage) continue;
    const rel = ev.content?.['m.relates_to'];
    if (ev.type === 'm.reaction') {
      if (rel?.rel_type !== 'm.annotation' || !rel.key) continue;
      const byKey = reactions.get(rel.event_id) || new Map();
      if ((byKey.get(rel.key) || []).includes(ev.sender)) continue;
      byKey.set(rel.key, [...(byKey.get(rel.key) || []), ev.sender]);
      reactions.set(rel.event_id, byKey);
      if (ev.sender === S.userId) ownReacts.set(`${rel.event_id}|${rel.key}`, ev.event_id);
    } else if (POLL_RESPONSE.includes(ev.type)) {
      // A vote replaces the sender's earlier one; votes after the end do not count.
      const answers = ev.content?.['org.matrix.msc3381.poll.response']?.answers ?? ev.content?.['m.selections'];
      if (rel?.rel_type !== 'm.reference' || !Array.isArray(answers) || ended.has(rel.event_id)) continue;
      if (!votes.has(rel.event_id)) votes.set(rel.event_id, new Map());
      votes.get(rel.event_id).set(ev.sender, answers);
      if (ev.sender === S.userId) votedAt.set(rel.event_id, ev.origin_server_ts);
    } else if (ev.type === 'm.room.member') {
      memberEvents.push(ev);
    } else if (POLL_END.includes(ev.type)) {
      if (rel?.rel_type === 'm.reference') ended.add(rel.event_id);
    } else if (isMessage && rel?.rel_type === 'm.replace') {
      if (!redacted.has(ev.event_id)) { edits.set(rel.event_id, ev); editCount.set(rel.event_id, (editCount.get(rel.event_id) || 0) + 1); }
    } else if (isMessage || ev.type === 'm.sticker') {
      if (!isSetupChatter(r, ev)) messages.push(ev);
    }
  }
  // A bridge's notice that Karchi's message did not go out is no message (and never waits for a batch): his own
  // bubble says it, with „Znova odoslať“. One sent again or deleted leaves the chat, and so does the notice about
  // that deletion.
  const failed = new Map(); // own event id -> { reason, sure }
  const own = new Map(messages.filter((ev) => ev.sender === S.userId).map((ev) => [ev.event_id, ev]));
  // A message being sent again (still on its way or waiting for the network) already stands in for the old one.
  const resent = new Set([...messages, ...r.pending.values()].map((ev) => ev.content?.[RESEND_OF]).filter(Boolean));
  // Notices that name no message (legacy Discord) come in order: a run of N of them belongs to the last N of
  // Karchi's messages before it (two quick messages, or a bridge catching up after it was disconnected); only his
  // next message ends a run.
  const paired = new Map(); // notice id -> own event id
  let ownRun = [];
  let noteRun = [];
  const pair = () => {
    noteRun.forEach((id, i) => { const to = ownRun[ownRun.length - noteRun.length + i]; if (to) paired.set(id, to); });
    ownRun = [];
    noteRun = [];
  };
  for (const ev of messages) {
    const f = bridgeFailure(ev);
    if (f && !f.target && f.kind === 'message') { noteRun.push(ev.event_id); continue; }
    if (ev.sender !== S.userId) continue; // a person's message between them ends no run
    if (noteRun.length) pair();
    ownRun.push(ev.event_id);
  }
  pair();
  messages = messages.filter((ev) => {
    const f = bridgeFailure(ev);
    if (!f) return true;
    const id = f.target || paired.get(ev.event_id);
    const target = own.get(id) || r.events.get(id);
    const about = target?.type === 'm.room.redaction' ? (target.redacts || target.content?.redacts) : null;
    if (about ? !failed.has(about) : !own.has(id)) return true;
    if (!about) failed.set(id, { reason: failReason(f.reason), sure: f.sure });
    return false;
  });
  if (failed.size || resent.size) messages = messages.filter((ev) => !resent.has(ev.event_id) && !(failed.has(ev.event_id) && redacted.has(ev.event_id)));
  // Messages waiting for their batch are left out here, so the list, previews and the chat agree.
  const held = messages.filter((ev) => isHeld(ev, cut) && !redacted.has(ev.event_id)).length;
  if (held) messages = messages.filter((ev) => !isHeld(ev, cut));
  for (const p of r.pending.values()) messages.push(p);
  const byId = new Map(messages.map((m) => [m.event_id, m]));
  // Only the sender may edit a message.
  for (const [id, edit] of edits) if (byId.get(id)?.sender !== edit.sender) edits.delete(id);
  const notes = memberNotes(r, memberEvents);
  r.model = { version: r.version, pending: r.pending.size, cut, work, held, messages, byId, redacted, edits, editCount, reactions, ownReacts, votes, votedAt, ended, notes, failed };
  return r.model;
}

/** Who came into or left a group, from the bridge's member events. Bridges also add, drop and re-add people
 *  while they sync a chat; that is hidden: a room's first minutes, bots and what they send, changes the bridge
 *  marks as sync, and a change undone within ten minutes. Discord servers come and go too much to show. */
function memberNotes(r, evs) {
  if (r.app === 'discord' || r.app === 'edupage') return [];
  // A one-to-one chat never had a third person; a group that shrank to two still had.
  if ([...r.members.keys()].filter((id) => id !== S.userId && !isBot(id)).length < 2) return [];
  const inside = (ev) => ev.content?.membership === 'join';
  const wasInside = (ev) => ev.unsigned?.prev_content?.membership === 'join';
  const notes = [];
  const runs = new Map(); // user -> { from, last }: their changes less than ten minutes apart
  const close = (user, run) => {
    const c = run.last.content || {};
    if (inside(run.last) === run.from || c['com.beeper.exclude_from_timeline']) return;
    const name = nickOf(user) || bareName(c.displayname || run.last.unsigned?.prev_content?.displayname || memberName(r, user));
    notes.push({ id: run.last.event_id, ts: run.last.origin_server_ts, text: `${name} ${inside(run.last) ? T('je teraz v skupine') : T('už nie je v skupine')}` });
  };
  for (const ev of evs) {
    const user = ev.state_key;
    if (isBot(user) || isBot(ev.sender) || ev.origin_server_ts - r.created < 5 * 60e3 || inside(ev) === wasInside(ev)) continue;
    const run = runs.get(user);
    if (run && ev.origin_server_ts - run.last.origin_server_ts < 10 * 60e3) { run.last = ev; continue; }
    if (run) close(user, run);
    runs.set(user, { from: wasInside(ev), last: ev });
  }
  for (const [user, run] of runs) close(user, run);
  return notes.sort((a, b) => a.ts - b.ts).slice(-200);
}

/** Setting a room up (the bot's greeting, `!discord bridge …` and its answer) is not part of the chat. */
const isSetupChatter = (r, ev) => r.created > 0 && ev.origin_server_ts - r.created < 120000
  && (isBot(ev.sender) || (ev.sender === S.userId && /^!discord\s/.test(ev.content?.body || '')));

const isRedacted = (m, ev) => m.redacted.has(ev.event_id) || !!ev.unsigned?.redacted_because || (!ev.pending && !Object.keys(ev.content || {}).length);
/** What a message says now: its last edit, if any. */
const contentOf = (m, ev) => m.edits.get(ev.event_id)?.content?.['m.new_content'] || ev.content || {};

const joinedPeople = (r) => [...r.members].filter(([id, mem]) => mem.membership === 'join' && id !== S.userId && !isBot(id));
/** The other person of a one-to-one chat, or null for a group. */
function dmPartner(r) {
  // A Discord server's channel is never someone's DM, however few of its people the bridge has in it.
  if (r?.serverId || (r?.app === 'discord' && dc.channels?.[r.id] && dc.channels[r.id].type !== DC_DM)) return null;
  const people = joinedPeople(r);
  return people.length === 1 ? people[0] : null;
}
// Names Karchi gives (Prezývka…): { [user id]: name } for a person, { [room id]: name } for a group chat. Only Weft
// shows them; the networks and the people in the chats keep their own names.
const NICKS = 'sk.karchi.nicknames';
const nickOf = (id) => S.account[NICKS]?.[id] || '';
/** A name as its network gives it, without the WhatsApp bridge's „(WA)“ tag. */
const bareName = (s) => String(s).replace(/\s+\(WA\)$/, '');
/** A person's name as the network gives it, never a nickname. A Messenger or Instagram ghost the bridge never
 *  named (its localpart as the name) gets the name the archive knows for it (peopleOf), else its localpart; with
 *  `guess` false never the archive's, which comes from an export and does not prove who it is (merging). */
function networkName(r, id, guess = true) {
  if (id === S.userId) return T('Ja');
  const local = id.slice(1).split(':')[0];
  const name = r?.members.get(id)?.name || S.names.get(id) || dc.names.get(id) || '';
  if ((name && name !== local) || !guess) return bareName(name || local);
  return bareName((META_GHOST.test(local) && peopleOf(r)?.[id]?.name) || name || local);
}
// ------------------------------------------------------------------ people the Meta bridges know
/** Localpart of a Messenger or Instagram ghost (mautrix-meta). */
const META_GHOST = /^(instagram|facebook)_\d+$/;
/** Room id → { [user id]: { name, handle } }: the bridge's name and username for each person of a Messenger or
 *  Instagram room (archive GET /_archive/rooms/{room}/people), asked once per room, again a minute after a failure. */
const bridgePeople = new Map();
function peopleOf(r) {
  if (!r || (r.app !== 'instagram' && r.app !== 'messenger') || r.archiveOnly) return null;
  const hit = bridgePeople.get(r.id);
  if (hit) return hit;
  bridgePeople.set(r.id, {});
  archiveGet(`/_archive/rooms/${q(r.id)}/people`).then((body) => {
    bridgePeople.set(r.id, body.people || {});
    renderSoon();
  }).catch(() => setTimeout(() => bridgePeople.delete(r.id), 60e3));
  return bridgePeople.get(r.id);
}
/** Whether a Messenger or Instagram person's name is still only their ghost's localpart: Meta never told the
 *  bridge, nor the archive. */
const unnamedGhost = (r, id) => { const local = id.slice(1).split(':')[0]; return META_GHOST.test(local) && networkName(r, id) === local; };
/** The @username the Meta bridge knows for a person, '' when none. */
const handleOf = (r, id) => peopleOf(r)?.[id]?.handle || '';
/** The name "@" puts into the message box: the network's, in plain letters (𝒶𝓃𝑒𝓉𝒶 → aneta, which the pixel font draws
 *  and Karchi can type); for a ghost nobody named its username or „Bez mena“, never its internal id. */
const mentionName = (r, id) => (unnamedGhost(r, id) ? handleOf(r, id) || T('Bez mena') : networkName(r, id).normalize('NFKC'));
/** A person's name as Weft shows it: Karchi's nickname, else the network's; an unnamed ghost as @username or „Bez mena“. */
function memberName(r, id) {
  if (id !== S.userId && nickOf(id)) return nickOf(id);
  if (unnamedGhost(r, id)) return handleOf(r, id) ? `@${handleOf(r, id)}` : T('Bez mena');
  return networkName(r, id);
}
/** The nickname of a chat: the group's, or its one person's. */
function roomNick(r) {
  if (!S.account[NICKS]) return '';
  const partner = dmPartner(r);
  return nickOf(r.id) || (partner ? nickOf(partner[0]) : '');
}
/** A chat's name: its nickname, else the network's (`nick` false: always the network's). */
function roomTitle(r, nick = true) {
  const mine = nick && roomNick(r);
  if (mine) return mine;
  const name = r.state.get('m.room.name|')?.name || r.bridgeName;
  if (name) return r.server ? `${bareName(name)} · ${r.server}` : bareName(name);
  const people = joinedPeople(r).map(([id]) => memberName(r, id));
  return people.length ? people.slice(0, 3).join(', ') + (people.length > 3 ? ` +${people.length - 3}` : '') : 'Chat';
}
const roomAvatar = (r) => r.state.get('m.room.avatar|')?.url || dmPartner(r)?.[1].avatar || '';

/** The question and answers of a poll start, or null when the content is not a poll. */
function pollOf(c) {
  const p = c['org.matrix.msc3381.poll.start'] || c['m.poll'];
  if (!p) return null;
  const text = (x) => (typeof x === 'string' ? x : x?.['org.matrix.msc1767.text'] ?? x?.['m.text']?.[0]?.body
    ?? x?.['org.matrix.msc1767.message']?.[0]?.body ?? x?.body ?? '');
  return {
    question: text(p.question),
    answers: (Array.isArray(p.answers) ? p.answers : []).filter(Boolean).map((a) => ({ id: a.id ?? a['m.id'], text: text(a) })),
    max: Math.max(1, p.max_selections || 1),
  };
}
/** The poll a message is, or null. mautrix-whatsapp (extev_polls off) sends a poll as a text message that carries the
 *  poll, marked fi.mau.whatsapp.poll; its votes are unstable poll responses like any other. Its own content counts, so
 *  an edit cannot turn a message into a poll. */
function pollIn(ev, c) {
  // A replacement without answers (Discord's counts alone) keeps the poll's own question and answers.
  if (POLL_START.includes(ev.type)) { const poll = pollOf(c); return poll?.answers.length || c === ev.content ? poll : pollOf(ev.content || {}) || poll; }
  if (ev.type !== 'm.room.message' || !ev.content?.['fi.mau.whatsapp.poll']) return null;
  // The bridge names each answer by the sha256 of its text and turns only such ids into a vote; anything else stays text.
  const answers = ev.content['org.matrix.msc3381.poll.start']?.answers;
  if (!Array.isArray(answers) || !answers.length || !answers.every((a) => typeof a?.id === 'string' && /^[0-9a-f]{64}$/.test(a.id))) return null;
  const poll = pollOf(ev.content);
  return poll.question ? poll : null;
}

/** What a bridged event says about a call, or null: { state: 'incoming' | 'missed' | 'ended', video, seconds }.
 *  Only an event its bridge marked as a call counts (com.beeper.action_message), never words alone: a hand-typed
 *  „Incoming call…“ or Discord's unmarked „started a call“ stays text. Its own content counts, as with polls. */
function callOf(ev) {
  const c = ev.content || {};
  const act = c['com.beeper.action_message'];
  if (ev.type !== 'm.room.message' || act?.type !== 'call') return null;
  const body = String(c.body || '');
  const video = act.call_type === 'video' || /video/i.test(body);
  if (/^Incoming\b/.test(body)) return { state: 'incoming', video, seconds: null }; // mautrix-whatsapp, while it rings
  if (/missed/i.test(body)) return { state: 'missed', video, seconds: null };
  const m = /\((?:(\d+):)?(\d+):(\d\d)\)\s*$/.exec(body); // mautrix-meta: „Audio call (3:12)“, „Video call (1:02:03)“
  return { state: 'ended', video, seconds: m ? (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] : null };
}
/** A call's line in the chat and the inbox (`mine`: Karchi called). Without its length (a record such as „X started a video chat“) it says
 *  only that there was a call: whether it still goes on, the bridge does not tell. */
function callLabel(call, mine = false) {
  const s = call.seconds;
  const length = s == null ? '' : s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
  if (call.state === 'incoming') return call.video ? T('Prichádzajúci videohovor') : T('Prichádzajúci hovor');
  if (call.state === 'missed' && mine) return call.video ? T('Nezdvihnutý videohovor') : T('Nezdvihnutý hovor');
  if (call.state === 'missed') return call.video ? T('Zmeškaný videohovor') : T('Zmeškaný hovor');
  if (length) return call.video ? T`Videohovor ${length}` : T`Hovor ${length}`;
  return call.video ? T('Videohovor') : T('Hovor');
}

// ------------------------------------------------------------------ ringing
// A call its bridge announces while it rings (today only mautrix-whatsapp's „Incoming call…“; Messenger and Instagram
// only after a bridge update, Discord's start carries no mark) rings in Weft: a window in the corner „Volá ti X“, a
// tone and, while Weft is not in front, a system notification. Weft does not pick up: the button opens the network,
// whose web or phone answers if it still rings. Only from a sync after the first one, once per event, while it is
// fresh: no bridge says when the ringing ends, so it stops after RING_FRESH, at the chat's next call event or by a click.
// Settings → Správy → Hovory (`sk.karchi.calls` { ring }) and Ctrl+J: 'always' rings also while messages wait for a
// reading window (the default, Karchi 19. 11.), 'held' lets a call wait with the messages (people marked „Práca“ and
// an open window still ring), 'never'. The call's line in the chat waits with the messages either way.
const CALLS = 'sk.karchi.calls';
const RING_MODES = [['always', T('Zvoniť vždy')], ['held', T('Len keď správy nečakajú')], ['never', T('Nezvoniť')]];
const ringMode = () => (RING_MODES.some(([id]) => id === S.account[CALLS]?.ring) ? S.account[CALLS].ring : 'always');
const RING_FRESH = 45e3;
const ringing = { list: [], seen: new Set(), notes: new Map(), audio: null, timer: 0 };
const ringWhat = (it) => `${appOf(it.app)?.name || ''}${it.video ? ` · ${T('videohovor')}` : ''}`;

/** Whether a call that rings now in chat r may ring here. */
function mayRing(r, ev) {
  const mode = ringMode();
  if (mode === 'never' || ev.sender === S.userId || hiddenApps().has(r.app)) return false;
  return mode === 'always' || !isHeld(ev, roomCut(r));
}

/** The new events of one room in a sync after the first: an incoming call rings, a later call event ends it. */
function ringCalls(r, events) {
  if (!r || r.archiveOnly || !isChat(r) || !events?.length) return;
  for (const ev of events) {
    const call = callOf(ev);
    if (!call) continue;
    const older = (x) => x.room === r.id && x.at < ev.origin_server_ts;
    if (ringing.list.some(older)) stopRing(older);
    const age = Date.now() - ev.origin_server_ts;
    if (call.state !== 'incoming' || ringing.seen.has(ev.event_id) || Math.abs(age) > RING_FRESH || !mayRing(r, ev)) continue;
    ringing.seen.add(ev.event_id);
    const it = { id: ev.event_id, room: r.id, sender: ev.sender, at: ev.origin_server_ts, video: call.video, app: r.app, title: entryOf(r.id)?.title || roomTitle(r) };
    ringing.list.push(it);
    ringNotify(it);
    ringSchedule();
  }
}

/** What rings now and would not ring under the current choice stops. */
const ringRecheck = () => stopRing((x) => !S.rooms.has(x.room) || !mayRing(S.rooms.get(x.room), { sender: x.sender, origin_server_ts: x.at }));

/** Ends the ringing of the calls `which` picks (all of them by default). */
function stopRing(which = () => true) {
  for (const x of ringing.list.filter(which)) { ringing.notes.get(x.id)?.close(); ringing.notes.delete(x.id); }
  ringing.list = ringing.list.filter((x) => !which(x));
  ringSchedule();
}

/** Drops what rang long enough and keeps the tone and the next expiry to what still rings. */
function ringSchedule() {
  const now = Date.now();
  const old = (x) => now - x.at >= RING_FRESH;
  if (ringing.list.some(old)) return stopRing(old);
  clearTimeout(ringing.timer);
  if (ringing.list.length) ringing.timer = setTimeout(() => { ringSchedule(); render(); }, Math.min(...ringing.list.map((x) => x.at + RING_FRESH)) - now + 200);
  ringTone(ringing.list.length ? Math.max(...ringing.list.map((x) => x.at + RING_FRESH)) : 0);
}

/** Two short tones every 3 s until `until`, scheduled on the audio clock at once (a hidden page's timers may wake
 *  late, the sound does not); 0 stops it. */
function ringTone(until) {
  if ((ringing.audio?.until || 0) === until) return;
  ringing.audio?.ctx.close().catch(() => {});
  ringing.audio = null;
  if (!until) return;
  try {
    const ctx = new AudioContext();
    ctx.resume().catch(() => {});
    const out = ctx.createGain();
    out.gain.value = 0.12;
    out.connect(ctx.destination);
    const t0 = ctx.currentTime;
    for (let t = 0; t < Math.min(until - Date.now(), RING_FRESH) / 1000; t += 3) {
      for (const [d, f] of [[0, 660], [0.45, 880]]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        const at = t0 + t + d;
        o.frequency.value = f;
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(1, at + 0.02);
        g.gain.setValueAtTime(1, at + 0.3);
        g.gain.linearRampToValueAtTime(0, at + 0.35);
        o.connect(g).connect(out);
        o.start(at);
        o.stop(at + 0.36);
      }
    }
    ringing.audio = { ctx, until };
    // A browser tab nobody has clicked yet starts it muted: the next key or click lets it sound (the desktop app
    // and the system notification need none).
    // Kept until it sounds or stops: a key like Shift or a touch's pointerdown does not yet count as a gesture.
    if (ctx.state === 'suspended') {
      const kinds = ['pointerdown', 'pointerup', 'click', 'touchend', 'keydown', 'keyup'];
      const done = () => kinds.forEach((k) => removeEventListener(k, wake, true));
      const wake = () => { if (ctx.state !== 'suspended') return done(); ctx.resume().then(() => ctx.state !== 'suspended' && done(), () => {}); };
      kinds.forEach((k) => addEventListener(k, wake, true));
      ctx.addEventListener('statechange', () => ctx.state !== 'suspended' && done());
    }
  } catch { /* no sound here: the window and the notification still come */ }
}

/** A system notification while Weft is not in front; a click brings Weft forward, where the window rings. */
function ringNotify(it) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || (!document.hidden && document.hasFocus())) return;
  try {
    const n = new Notification(T`Volá ti ${it.title}`, { body: ringWhat(it), tag: `weft-call:${it.id}`, icon: '/icon.svg' });
    n.onclick = () => { window.desktop?.focus?.(); window.focus(); n.close(); };
    ringing.notes.set(it.id, n);
  } catch { /* a browser that notifies only from its service worker: the window still rings */ }
}

function ringView() {
  const it = ringing.list.at(-1);
  if (!it) return null;
  const r = S.rooms.get(it.room);
  const t = r && callButtonTarget(r);
  const net = appOf(it.app)?.name || '';
  const close = () => { stopRing((x) => x.id === it.id); render(); };
  return h('div', { class: 'codepop callpop', role: 'alertdialog', 'aria-label': T`Volá ti ${it.title}`, 'data-key': `ring:${it.id}` },
    h('div', { class: 'codepop-head' },
      icon(it.video ? 'video' : 'phone'),
      h('span', {}, h('b', {}, T`Volá ti ${it.title}`), h('small', {}, ringWhat(it))),
      h('button', { class: 'ghost', title: T('Zavrieť (Esc)'), onclick: close }, icon('close'), T('Zavrieť'))),
    h('p', { class: 'hint' }, T('Weft hovor nezdvihne: zdvihni ho na telefóne alebo na webe siete, kým zvoní.')),
    t ? h('button', { class: 'primary', onclick: () => { openCall(r); close(); } }, T`Otvoriť ${net}`) : null);
}

/** Settings → Správy → Hovory. */
function ringSettings() {
  const mode = ringMode();
  return [
    h('h3', {}, T('Hovory')),
    h('div', { class: 'seg', role: 'radiogroup', 'aria-label': T('Zvoniť pri hovore') }, RING_MODES.map(([id, label]) =>
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(mode === id), class: mode === id ? 'on' : '', onclick: () => mode !== id && saveRing(id) }, label))),
    h('p', { class: 'hint' }, {
      always: T('Hovor zazvoní, aj keď správy čakajú na okno na čítanie. Riadok hovoru v chate počká so správami.'),
      held: T('Kým správy čakajú, počká s nimi aj hovor a uvidíš ho ako zmeškaný. Ľudia Práca a hovor počas okna zazvonia.'),
      never: T('Hovor nezazvoní, v chate ostane ako riadok.'),
    }[mode]),
    h('p', { class: 'hint' }, T('Zvoní zatiaľ len WhatsApp: ostatné mosty hovor počas zvonenia neohlásia. Weft hovor nezdvihne, otvorí sieť.')),
  ];
}

async function saveRing(ring) {
  S.account[CALLS] = { ...(S.account[CALLS] || {}), ring };
  ringRecheck();
  // A browser asks once whether Weft may notify; the choice is a click, so it may ask now (the desktop app may always).
  if (ring !== 'never' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  render();
  await putAccount(CALLS, S.account[CALLS]).catch(() => alert(T('Nastavenie sa neuložilo.')));
}

/** One-line summary of a message for the inbox and the reply quote. */
/** What a shared post's caption says besides its address (the bridge puts the address into the body). */
const sharedWords = (body) => String(body || '').replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/<?https?:\/\/\S+/g, '').replace(/^> ?/gm, '').trim();
/** The address of a post, reel or story shared from Instagram or Facebook, as one would send it on: Instagram's
 *  tracking parameters (?id=…&is_sponsored=…, ?igsh=…) dropped. '' for any other message. */
function shareLink(c) {
  if (typeof c?.external_url !== 'string') return '';
  try {
    const u = new URL(c.external_url);
    if (!/^https?:$/.test(u.protocol)) return '';
    return classify(u.href)[0] === 'instagram' ? `${u.origin}${u.pathname}` : u.href;
  } catch { return ''; }
}
/** A shared reel or story (also a Facebook video): the video says it all, so no card of its page goes under it.
 *  Besides what classify knows: /<user>/reel/…, /reels/…, /stories/… and Facebook's /share/r/ and /share/v/. */
function sharedVideo(c) {
  const link = shareLink(c);
  if (!link) return false;
  const [platform, kind] = classify(link);
  return ['reel', 'video', 'story'].includes(kind)
    || (['instagram', 'facebook'].includes(platform) && /\/(reels?|stories)\/|^\/share\/(r|v|reel)\//.test(new URL(link).pathname));
}

function messageSummary(m, ev) {
  if (isRedacted(m, ev)) return T('Správa bola odstránená');
  const c = contentOf(m, ev);
  if (ev.type === 'm.sticker') return T('Nálepka');
  const poll = pollIn(ev, c);
  if (poll) return T`Anketa: ${poll.question}`;
  const call = callOf(ev);
  if (call) return callLabel(call, ev.sender === S.userId);
  const kinds = { 'm.image': T('Obrázok'), 'm.video': 'Video', 'm.audio': T('Zvuková správa'), 'm.file': T('Súbor') };
  if (kinds[c.msgtype]) {
    const shared = typeof c.external_url === 'string';
    let caption = c.filename && c.body && c.body !== c.filename ? c.body : '';
    if (shared) caption = sharedWords(caption) || (/\/reels?\//.test(c.external_url) ? 'Reel' : /\/stories\//.test(c.external_url) ? T('Príbeh') : '');
    // A voice message says how long it is: from the message, or once the player has measured it (no download here).
    const length = c.msgtype === 'm.audio' ? (c.info?.duration || c['org.matrix.msc1767.audio']?.duration || 0) / 1000 || measured.get(c.url)?.duration : 0;
    if (!caption && length) return `${kinds[c.msgtype]} · ${mmss(length)}`;
    return caption || (c.msgtype === 'm.file' ? `${kinds[c.msgtype]}: ${c.filename || c.body || ''}` : kinds[c.msgtype]);
  }
  return String(c.body || '').replace(/^(> .*\n)+\n/, '').replace(/\s+/g, ' ').trim();
}

/** Pages back through the room on Matrix, then through the archive on asus once the room's start is reached. */
async function loadRoomHistory(r) {
  if (r.loading || r.historyDone || S.offline || Date.now() < (r.archiveRetry || 0)) return;
  r.loading = true;
  const epoch = r.epoch; // a limited sync empties the room meanwhile: an answer from before it is dropped
  try {
    if (r.prevBatch && !r.matrixDone) {
      const filter = q(JSON.stringify({ types: TIMELINE_TYPES }));
      const data = await call('GET', `/rooms/${q(r.id)}/messages?dir=b&limit=50&from=${q(r.prevBatch)}&filter=${filter}`);
      if (epoch === r.epoch) {
        for (const ev of data.chunk || []) roomEvent(r, ev, true);
        r.prevBatch = data.end && data.chunk?.length ? data.end : null;
        if (!r.prevBatch) r.matrixDone = true;
        await loadExportGaps(r, epoch);
      }
    } else {
      r.matrixDone = true;
      await loadExportGaps(r, epoch);
      const more = await loadArchive(r, epoch);
      if (more === null) retryHistory(r);
      else if (!more && epoch === r.epoch) r.historyDone = true;
    }
    r.version++;
  } catch {
    retryHistory(r);
  }
  r.loading = false;
  refresh();
}

/** Fill holes inside the loaded native timeline; older exports still page through loadArchive. */
async function loadExportGaps(r, epoch) {
  if (!['messenger', 'discord', 'whatsapp'].includes(r.app) || r.archiveOnly || epoch !== r.epoch) return;
  let after = Infinity;
  for (const ev of r.events.values()) if (ev.state_key === undefined && !ev.archived && Number.isFinite(ev.origin_server_ts)) after = Math.min(after, ev.origin_server_ts);
  const upper = r.exportGapEpoch === epoch && r.exportGapFloor != null ? r.exportGapFloor : Date.now() + 1;
  if (!Number.isFinite(after) || after >= upper) return;
  let before = upper, id = '';
  for (;;) {
    const params = new URLSearchParams({ local: '1', after: String(after), before: String(before), id, limit: '500' });
    const res = await fetch(`/_archive/rooms/${q(r.id)}/messages?${params}`, { headers: { Authorization: `Bearer ${S.token}` } });
    if (!res.ok) throw new Error('Archived history unavailable');
    const { messages = [] } = await res.json();
    if (epoch !== r.epoch) return;
    for (const a of messages) r.events.set(a.id, archivedEvent(r, a));
    if (messages.length < 500) break;
    const last = messages[messages.length - 1];
    if (last.ts === before && last.id === id) throw new Error('Archived history cursor did not advance');
    before = last.ts; id = last.id;
  }
  r.exportGapEpoch = epoch;
  r.exportGapFloor = after;
}

/** The homeserver or the archive did not answer (restart, network): try again by itself, never claim the chat's start. */
function retryHistory(r) {
  r.archiveRetry = Date.now() + 15e3;
  setTimeout(() => loadRoomHistory(r), 15e3 + 50);
}

/** true: more came; false: nothing older; null: the archive did not answer. */
/** Older messages than a bridge brought over, from the networks' own exports. Text only, read-only. */
async function loadArchive(r, epoch) {
  if (!isChat(r)) return false;
  let oldest = null;
  for (const ev of r.events.values()) {
    if (ev.state_key !== undefined) continue;
    if (!oldest || ev.origin_server_ts < oldest.origin_server_ts || (ev.origin_server_ts === oldest.origin_server_ts && ev.archived && ev.event_id < oldest.event_id)) oldest = ev;
  }
  // Newly arrived previews can be newer than an already loaded full timeline.
  const previews = [...r.events.values()].filter((ev) => ev.archivePreview);
  if (previews.length) oldest = previews.reduce((a, b) => a.origin_server_ts > b.origin_server_ts ? a : b);
  // Within the archive, page by (time, id): several messages can share a millisecond.
  const from = oldest?.archivePreview ? `before=${oldest.origin_server_ts + 1}` : oldest ? `before=${oldest.origin_server_ts}${oldest.archived ? `&id=${q(oldest.event_id)}` : ''}` : `before=${Date.now()}`;
  const res = await fetch(`/_archive/rooms/${q(r.id)}/messages?${from}&limit=200`, { headers: { Authorization: `Bearer ${S.token}` } }).catch(() => null);
  if (!res?.ok) return null;
  const { messages = [], until = 0 } = await res.json();
  if (epoch !== r.epoch) return true; // emptied meanwhile: page again from the new start
  r.archiveUntil = until || 0;
  for (const a of messages) r.events.set(a.id, archivedEvent(r, a));
  return messages.length > 0;
}

/** An archive row as a read-only message of its chat: its sender a member found by name, else a name only. */
function archivedEvent(r, a) {
  let sender = a.me ? S.userId : [...r.members].find(([, mem]) => mem.name === a.sender)?.[0];
  if (!sender) { sender = `@archive/${a.sender}`; S.names.set(sender, a.sender); }
  return { event_id: a.id, room_id: r.id, type: a.poll ? POLL_START[0] : 'm.room.message', sender, origin_server_ts: a.ts,
    content: { msgtype: 'm.text', body: a.body, ...(a.poll ? archivedPoll(a.poll) : {}) }, archived: true, archivePreview: !!a.preview,
    ...(a.files?.length ? { archiveFiles: a.files } : {}) };
}
/** An archived Discord poll as the bridge sends a live one, with Discord's counts as they stood when collected. */
function archivedPoll(p) {
  const answers = (Array.isArray(p.answers) ? p.answers : []).map((a) => ({ id: String(a.id), 'org.matrix.msc1767.text': String(a.text ?? '') }));
  return {
    [POLL_START[0]]: { question: { 'org.matrix.msc1767.text': String(p.question ?? '') }, answers, max_selections: p.multi ? answers.length : 1 },
    [DISCORD_POLL]: { counts: p.counts || {}, mine: p.mine || [], closed: !!p.closed, expiry: p.expiry || 0 },
  };
}

/** A message search found in the archive: the chat pages back (Matrix, then the archive) until it is there. It may
 * come in under another id (an exported message the bridge or the homeserver also has): then the one with the same
 * time and text. Paging stops once the chat is older than the message. */
async function jumpToArchived(r, found) {
  const ts = found.origin_server_ts;
  const match = () => r.events.get(found.event_id) || [...r.events.values()].find((ev) => ev.state_key === undefined
    && (ev.origin_server_ts === ts || (Math.abs(ev.origin_server_ts - ts) < 1000 && ev.content?.body === found.content.body)));
  const passed = () => [...r.events.values()].some((ev) => ev.state_key === undefined && ev.origin_server_ts < ts - 1000);
  S.focusEvent = found.event_id;
  S.focusScrolled = null;
  render();
  const until = Date.now() + 120e3;
  let hit = match();
  while (!hit && !passed() && !r.historyDone && S.focusEvent === found.event_id && Date.now() < until) {
    if (r.loading || Date.now() < (r.archiveRetry || 0)) await new Promise((ok) => setTimeout(ok, 250));
    else await loadRoomHistory(r);
    hit = match();
  }
  if (hit && S.focusEvent === found.event_id) { S.focusEvent = hit.event_id; S.focusScrolled = null; }
  render();
}

/** Puts an event found by search, with a few around it, into its room so the chat can show it. */
async function loadContext(r, eventId) {
  if (r.events.has(eventId)) return;
  try {
    const data = await call('GET', `/rooms/${q(r.id)}/context/${q(eventId)}?limit=20&filter=${q(JSON.stringify({ types: TIMELINE_TYPES }))}`);
    for (const ev of [...(data.events_before || []), data.event, ...(data.events_after || [])]) if (ev) roomEvent(r, ev, true);
    r.version++;
    refresh();
  } catch {
    // the chat opens at its end instead
  }
}

/** Uploads a file to the homeserver and describes it as a Matrix message. */
async function fileContent(file) {
  const res = await fetch(`/_matrix/media/v3/upload?filename=${q(file.name)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${S.token}`, 'Content-Type': file.type || 'application/octet-stream' }, body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.content_uri) throw new ApiError(res.status, data);
  const kind = file.type.split('/')[0];
  const msgtype = { image: 'm.image', video: 'm.video', audio: 'm.audio' }[kind] || 'm.file';
  const info = { mimetype: file.type || 'application/octet-stream', size: file.size, ...(await imageSize(file)) };
  // The picture is already here: the echoed message shows it at once instead of downloading it again.
  if (kind === 'image' || kind === 'video') for (const size of [0, 480]) mediaCache.set(`${data.content_uri}|${size}`, localUrl(file));
  return { msgtype, body: file.name, url: data.content_uri, info };
}

const localUrls = new WeakMap(); // File -> blob url of its preview
const localUrl = (file) => localUrls.get(file) || (localUrls.set(file, URL.createObjectURL(file)), localUrls.get(file));
const imageSizes = new WeakMap(); // File -> Promise of { w, h } ({} for anything that is not a picture)
function imageSize(file) {
  if (!imageSizes.has(file)) {
    imageSizes.set(file, !file.type.startsWith('image/') ? Promise.resolve({})
      : createImageBitmap(file).then((b) => { const wh = { w: b.width, h: b.height }; b.close(); return wh; }, () => ({})));
  }
  return imageSizes.get(file);
}

/** Files pasted, dropped or picked go to the open chat or EduPage message; a school notice takes no answer. */
function takeFiles(files) {
  if (!files.length || S.view !== 'main') return;
  const r = S.rooms.get(S.selected);
  if (S.selected === MAIL && S.mail && !S.mail.sent) {
    const all = [...(S.attach.get(MAIL) || []), ...files];
    if (all.reduce((n, f) => n + f.size, 0) > mailLimit().bytes) { S.eduNote = `big:${MAIL}`; return render(); }
    S.eduNote = null;
    S.attach.set(MAIL, all);
    return render();
  }
  if (!r || !isChat(r)) {
    const t = S.selected && !S.selected.startsWith('edu:') ? threads().find((x) => x.id === S.selected) : null;
    const key = S.selected?.startsWith('edu:') || (t && t.root.content.msgtype !== 'm.notice') ? S.selected : null;
    const big = files.filter((f) => f.size > EDU_MAX_FILE);
    if (key && big.length) { S.eduNote = `big:${key}`; render(); }
    const ok = files.filter((f) => f.size <= EDU_MAX_FILE);
    if (key && ok.length) {
      S.attach.set(key, [...(S.attach.get(key) || []), ...ok]);
      S.focusComposer = true;
      render();
    }
    return;
  }
  S.attach.set(r.id, [...(S.attach.get(r.id) || []), ...files]);
  for (const f of files) imageSize(f);
  S.focusComposer = true;
  render();
}
function dropAttachment(r, file) {
  const left = (S.attach.get(r.id) || []).filter((f) => f !== file);
  if (left.length) S.attach.set(r.id, left);
  else S.attach.delete(r.id);
  if (!left.length) boxFrom.delete(r.id);
  if (!left.length && !(S.drafts.get(r.id) || '').trim()) doneBoxStash(r.id); // emptied: the taken item is done
  S.focusComposer = true;
  render();
}

// Ctrl+V of a picture (a screenshot, "Copy image", a file from the file manager) attaches it.
// Copied text that also carries a picture of itself (a spreadsheet, a document) pastes as text.
document.addEventListener('paste', (e) => {
  const data = e.clipboardData;
  if (S.view !== 'main' || S.overlay || S.panel || !data?.files.length || data.types.includes('text/plain')) return;
  e.preventDefault();
  takeFiles([...data.files]);
});
// Files dragged over the window: the open chat says it takes them; dropped on the chat they attach.
let dropTimer = 0;
document.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault(); // otherwise the browser opens the file in place of the app
  const over = !!e.target.closest?.('.detail');
  e.dataTransfer.dropEffect = over ? 'copy' : 'none';
  document.getElementById('app').classList.toggle('dropping', over);
  clearTimeout(dropTimer); // dragover repeats while the file is held over the window, even without moving
  dropTimer = setTimeout(() => document.getElementById('app').classList.remove('dropping'), 200);
});
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  document.getElementById('app').classList.remove('dropping');
  if (e.target.closest?.('.detail')) takeFiles([...e.dataTransfer.files]);
});

/** Discord threads are not Weft's (the bridge has none): a reply to a message from one would go to the whole channel,
 *  without its quote. Such a reply never goes out, on any path (write, GIF, voice, later, again, the outbox). */
const inDiscordThread = (r, id) => r?.app === 'discord' && !!id
  && (r.events.get(id) || r.pending.get(id))?.content?.['m.relates_to']?.rel_type === 'm.thread';
const threadNote = () => T('Na správu z vlákna na Discorde sa z Weftu odpovedať nedá: odišla by do celého kanála. Odpovedz v appke Discord.');
const unreadNote = () => T('Správa, na ktorú odpovedá, sa nedá prečítať, tak neodišla: mohla by ísť do celého kanála.');
/** A message the reply's rules can be read from: Weft has it and it is not deleted (a deleted one has no content,
 *  or its deletion came after it while its content stays in this window). */
const readable = (r, ev) => Object.keys(ev?.content || {}).length > 0 && !ev.unsigned?.redacted_because
  && !(r?.events && roomModel(r).redacted.has(ev.event_id));
const discordTargetSeen = (r, id) => readable(r, r.events.get(id) || r.pending.get(id));
/** The reply part of a message to `r` going out now: null without one, false when it may not go (see above). */
function replyRel(r) {
  if (S.replyTo?.room !== r.id) return null;
  if (inDiscordThread(r, S.replyTo.event) || (r.app === 'discord' && !discordTargetSeen(r, S.replyTo.event))) return false;
  return { 'm.in_reply_to': { event_id: S.replyTo.event } };
}
/** Why the reply being written in `r` may not go (replyRel gave false). */
const replyNote = (r) => (inDiscordThread(r, S.replyTo?.event) ? threadNote() : unreadNote());
/** A reply to `id` in room `room` (model `r`) that goes out later: '' when it may go, else why not. The target is
 *  read from the homeserver when this window does not have it; a network error is thrown (try again later). */
async function heldReply(r, room, id) {
  if (!id || (r.app && r.app !== 'discord')) return '';
  const inThread = (ev) => ev?.content?.['m.relates_to']?.rel_type === 'm.thread';
  const here = r.events.get(id) || r.pending.get(id);
  if (inThread(here)) return threadNote();
  if (here && !readable(r, here)) return unreadNote();
  // The homeserver has the last word: a deletion this window has not synced yet. A room not synced yet (no app)
  // may be Discord's too.
  let ev;
  try { ev = await call('GET', `/rooms/${q(room)}/event/${q(id)}`, undefined, undefined, AbortSignal.timeout(30000)); } catch (err) {
    if (isNetErr(err)) throw err;
    return unreadNote();
  }
  if (inThread(ev)) return threadNote();
  return !readable(r, ev) ? unreadNote() : '';
}

/** Sends the attachments, each as its own message as Messenger does, then the text. `given`: a stashed text sent
 *  as it is („Poslať“ in the stash); the message box, its files and its reply stay. */
async function sendChat(r, given = null) {
  if (r?.archiveOnly) return;
  const draft = given ? given.text : S.drafts.get(r.id) || '';
  const text = draft.trim();
  const files = given ? [] : S.attach.get(r.id) || [];
  if (!text && !files.length) return;
  const reply = given ? null : replyRel(r);
  if (reply === false) return alert(replyNote(r));
  const replyWas = reply ? S.replyTo : null;
  noteHeldReply(r);
  // Read now: the people the names stand for are this chat's, whatever comes later.
  const said = textMessage(r, text, draft.search(/\S|$/), given ? given.key ?? null : r.id);
  const parts = [...files.map((file) => ({ file })), ...(text ? [{ text }] : [])];
  for (const part of parts) {
    part.txn = `ep${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const image = part.file?.type.startsWith('image/');
    const shown = !part.file ? said
      : image ? { msgtype: 'm.image', body: part.file.name, info: await imageSize(part.file), local: localUrl(part.file) }
        : { msgtype: 'm.file', body: part.file.name, info: { size: part.file.size } };
    r.pending.set(part.txn, { event_id: part.txn, type: 'm.room.message', pending: true, sender: S.userId, origin_server_ts: Date.now(), content: shown });
    // Uploads run side by side; the messages still go out in order.
    if (part.file) part.content = fileContent(part.file);
    part.content?.catch(() => {});
  }
  if (!given) {
    deleteDraft(r.id);
    doneBoxStash(r.id);
    boxFrom.delete(r.id);
    S.attach.delete(r.id);
    S.replyTo = null;
    S.mention = null;
  }
  render();
  for (const [i, part] of parts.entries()) {
    try {
      const content = part.file ? await part.content : { ...said };
      if (reply && i === 0) {
        // Checked again after the uploads: the message may have been deleted (or found in a thread) meanwhile.
        content['m.relates_to'] = reply;
        await checkReply(r, content);
      }
      // The text is written down before it goes: a window closed while asus does not answer still sends it later.
      if (!part.file) saveOutbox([...outbox(), { txn: part.txn, room: r.id, at: Date.now(), content }]);
      const res = await call('PUT', `/rooms/${q(r.id)}/send/m.room.message/${part.txn}`, content, undefined, part.file ? undefined : AbortSignal.timeout(30000));
      settleChat(r, part.txn, res, content);
      if (!part.file) saveOutbox(outbox().filter((x) => x.txn !== part.txn));
    } catch (err) {
      // A reply whose first part (the one that carries it) did not go, because it may not, the network is down or
      // the server refused it, goes back whole: text, files and the reply itself. Nothing of it waits or can be sent
      // again without the reply, and Enter again asks again (Esc on the reply sends it as a plain message).
      const down = reply && i === 0 && parts.length > 1;
      if (err?.held || down) {
        for (const p of parts) r.pending.delete(p.txn);
        saveOutbox(outbox().filter((x) => !parts.some((p) => p.txn === x.txn)));
        r.version++;
        if (!given) {
          const now = S.drafts.get(r.id) || '';
          if (text) setDraft(r.id, now.trim() ? `${draft.trimEnd()}\n${now}` : draft);
          if (files.length) S.attach.set(r.id, [...files, ...(S.attach.get(r.id) || [])]);
          if (replyWas && !S.replyTo) S.replyTo = replyWas;
        }
        if (!err?.held && isNetErr(err)) { goOffline(); alert(T('Teraz to nejde, skús to znova, keď bude sieť.')); }
        else if (!err?.held) alert(T`Odpoveď neodišla (${err?.data?.error || err?.message || T('server ju odmietol')}). Ostala v poli aj so súbormi.`);
        render();
        return;
      }
      // Offline the text waits and goes out by itself; files and anything refused stay in the chat as
      // „neodoslané“ with „Znova odoslať“.
      const rest = parts.slice(i);
      const wait = isNetErr(err) ? rest.find((p) => p.text) : null;
      for (const p of rest) {
        if (p === wait) continue;
        if (p.text) saveOutbox(outbox().filter((x) => x.txn !== p.txn));
        const shown = r.pending.get(p.txn)?.content;
        const rel = reply && p === parts[0] ? { 'm.relates_to': reply } : {};
        failLocal(r, p.txn, err, () => sendAgain(r, 'm.room.message', shown,
          async () => ({ ...(p.file ? await fileContent(p.file) : said), ...rel })));
      }
      const shown = wait && r.pending.get(wait.txn);
      if (wait && outbox().some((x) => x.txn === wait.txn) && shown) { shown.waiting = true; r.version++; }
      else if (wait) queueOut(r, wait.txn, { ...said, ...(reply && i === 0 && rest[0] === wait ? { 'm.relates_to': reply } : {}) });
      if (wait) goOffline();
      render();
      return;
    }
  }
}

const txnId = () => `ep${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

/** Right before a message with a reply goes: throws (`held`, not a network error) and says why when the reply may
 *  not go any more (heldReply asks the homeserver). */
async function checkReply(r, content) {
  const why = await heldReply(r, r.id, content?.['m.relates_to']?.['m.in_reply_to']?.event_id);
  if (!why) return;
  alert(why);
  throw Object.assign(new Error(why), { status: 400, held: true });
}

/** A message that did not leave this window stays in the chat as „neodoslané“; `retry` sends it again. */
function failLocal(r, txn, err, retry) {
  const p = r.pending.get(txn);
  if (!p) return;
  const reason = isNetErr(err) ? T('nie je spojenie so serverom') : err?.data?.error || err?.message || T('server ju odmietol');
  Object.assign(p, { failed: reason, waiting: false, retry });
  r.version++;
  render();
}

/** Sends a message again as a new one, under a new transaction id; `build` gives its content (an upload for a
 *  file, so a failed upload can be tried again too). A failure leaves it in the chat to try once more. */
async function sendAgain(r, type, shown, build) {
  const txn = txnId();
  r.pending.set(txn, { event_id: txn, type, pending: true, sender: S.userId, origin_server_ts: Date.now(), content: shown });
  r.version++;
  render();
  let content;
  try {
    content = await build();
    await checkReply(r, content); // every way of sending again ends here
    const res = await call('PUT', `/rooms/${q(r.id)}/send/${type}/${txn}`, content);
    settleChat(r, txn, res, content);
  } catch (err) {
    if (isNetErr(err)) goOffline();
    // Built but no network: it waits and goes out by itself, as a typed text does.
    if (isNetErr(err) && content && type === 'm.room.message') {
      r.pending.delete(txn);
      queueOut(r, txn, content);
      return render();
    }
    failLocal(r, txn, err, () => sendAgain(r, type, shown, build));
  }
}

/** „Znova odoslať“: a bubble from this window runs its send again; a message the bridge did not take goes as a
 *  new one that names it, so it leaves the chat on every device. */
async function resendFailed(r, ev) {
  const rel = ev.content?.['m.relates_to'];
  let why;
  try { why = await heldReply(r, r.id, rel?.['m.in_reply_to']?.event_id); } catch { return alert(T('Teraz to nejde, skús to znova, keď bude sieť.')); }
  if (why) return alert(why);
  if (ev.pending) {
    r.pending.delete(ev.event_id);
    r.version++;
    return ev.retry?.();
  }
  const { [RESEND_OF]: _, 'm.relates_to': __, 'm.new_content': ___, ...content } = contentOf(roomModel(r), ev);
  if (rel?.['m.in_reply_to']) content['m.relates_to'] = { 'm.in_reply_to': rel['m.in_reply_to'] };
  return sendAgain(r, ev.type, content, async () => ({ ...content, [RESEND_OF]: ev.event_id }));
}

/** „Zahodiť“: a bubble from this window just goes; a message on the server is deleted (it never reached anyone). */
function dropFailed(r, ev) {
  if (ev.pending) {
    r.pending.delete(ev.event_id);
    saveOutbox(outbox().filter((x) => x.txn !== ev.event_id)); // a held reply the stash could not take
    r.version++;
    return render();
  }
  sendLocal(r, 'm.room.redaction', { redacts: ev.event_id }, T('Správu sa nepodarilo zahodiť.'));
}

// ------------------------------------------------------------------ GIFs

/** Sends a GIF picked from KLIPY at once, as Messenger does. WhatsApp plays GIFs only as looping mp4 videos
 *  (the bridge has no ffmpeg to convert one), every other network takes the GIF file itself. */
async function sendGif(r, g) {
  const reply = replyRel(r);
  if (reply === false) return alert(replyNote(r));
  noteHeldReply(r);
  S.overlay = null;
  const wa = r.app === 'whatsapp';
  const mf = g.media_formats || {};
  const pick = wa ? mf.mp4 : mf.mediumgif || mf.gif;
  const url = pick?.url;
  if (!url) return alert(T('Tento GIF sa nedá poslať.'));
  const [w, hh] = pick.dims || [];
  const wh = { w: w || undefined, h: hh || undefined };
  const replyWas = reply ? S.replyTo : null;
  S.replyTo = null;
  const txn = txnId();
  const shown = { msgtype: 'm.image', body: 'GIF', info: wh, local: mf.tinygif?.url || mf.mediumgif?.url };
  r.pending.set(txn, { event_id: txn, type: 'm.room.message', pending: true, sender: S.userId, origin_server_ts: Date.now(), content: shown });
  S.focusComposer = true;
  render();
  const build = async () => {
    const download = await fetch(url);
    if (!download.ok) throw new Error(`klipy ${download.status}`);
    const file = new File([await download.blob()], wa ? 'gif.mp4' : 'gif.gif', { type: wa ? 'video/mp4' : 'image/gif' });
    const content = await fileContent(file);
    Object.assign(content.info, wh);
    if (wa) {
      content.msgtype = 'm.video';
      Object.assign(content.info, { 'fi.mau.gif': true, 'fi.mau.loop': true, 'fi.mau.autoplay': true, 'fi.mau.hide_controls': true, 'fi.mau.no_audio': true });
    }
    if (reply) content['m.relates_to'] = reply;
    return content;
  };
  try {
    const content = await build();
    await checkReply(r, content);
    const res = await call('PUT', `/rooms/${q(r.id)}/send/m.room.message/${txn}`, content);
    settleChat(r, txn, res, content);
    // KLIPY ranks its results by what people send; its terms ask every app to tell it.
    gifKey().then((key) => key && fetch(`${KLIPY}/registershare?key=${q(key)}&id=${q(g.id)}&locale=sk_SK&country=SK${g.query ? `&q=${q(g.query)}` : ''}`)).catch(() => {});
  } catch (err) {
    // Held: the text being written still answers the same message, so Enter on it asks again.
    if (err?.held && replyWas && !S.replyTo) { S.replyTo = replyWas; render(); }
    failLocal(r, txn, err, () => sendAgain(r, 'm.room.message', shown, build));
  }
}

// GIFs come from KLIPY with one key for the whole server: asus `~/matrix-spike/app/gifs.json` = {"klipy": "<key>"},
// kept out of git. Nobody sets anything up in Weft. KLIPY's terms want the browser to ask it and load its media
// directly (no proxy, no cache), so the key reaches the client; a KLIPY key is not a secret.
const KLIPY = 'https://api.klipy.com/v2';
let gifKeyAsk = null;
/** The server's KLIPY key, or null when it has none (asked again at the next picker). */
function gifKey() {
  gifKeyAsk ||= fetch('/gifs.json', { cache: 'no-store' }).then((res) => res.json()).then((c) => c?.klipy || null, () => null)
    .then((key) => { if (!key) gifKeyAsk = null; return key; });
  return gifKeyAsk;
}

let gifTimer = 0;
/** KLIPY's featured GIFs, or what `o.query` finds; in Slovak first. */
function searchGifs(o) {
  clearTimeout(gifTimer);
  gifTimer = setTimeout(async () => {
    const query = o.query.trim();
    try {
      const key = await gifKey();
      if (S.overlay !== o) return;
      if (!key) { o.nokey = true; return render(); }
      o.nokey = false;
      const what = query ? `search?q=${q(query)}&` : 'featured?';
      const res = await fetch(`${KLIPY}/${what}key=${q(key)}&limit=30&locale=sk_SK&country=SK&contentfilter=low&media_filter=tinygif,tinygifpreview,mediumgif,gif,mp4`);
      if (res.status === 401 || res.status === 403 || res.status === 404) throw new Error('key');
      const data = await res.json();
      if (S.overlay !== o || o.query.trim() !== query) return;
      Object.assign(o, { gifs: (data.results || []).map((g) => ({ ...g, query })), error: '', index: 0 });
    } catch (err) {
      if (S.overlay !== o) return;
      o.error = err.message === 'key' ? T('KLIPY kľúč tohto servera neprijal.') : T('KLIPY neodpovedá. Skús to o chvíľu.');
    }
    render();
  }, o.gifs ? 300 : 0); // the first list comes at once, typing waits for a pause
}

function openGifs(r, query = '') {
  if (r?.archiveOnly) return;
  openOverlay('gif', { room: r.id, query, gifs: null });
  searchGifs(S.overlay);
}

function gifView(o) {
  const r = S.rooms.get(o.room);
  if (o.nokey) return [h('div', { class: 'rsec' }, 'GIFy'), h('div', { class: 'empty' }, T('GIFy na tomto serveri ešte nie sú zapnuté.'))];
  const gifs = o.gifs || [];
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  o.flat = gifs.map((g) => () => sendGif(r, g));
  return [
    cmdInput(o, T('Hľadať GIF… (Enter pošle vybraný)')),
    o.error ? h('div', { class: 'empty' }, o.error)
      : !o.gifs ? h('div', { class: 'empty' }, T('Načítavam…'))
        : !gifs.length ? h('div', { class: 'empty' }, T('Nič sa nenašlo.'))
          : h('div', { class: 'gifs', ...listScroll(o) }, gifs.map((g, i) => h('button', {
            class: `gifcell${i === o.index ? ' on' : ''}`, title: g.content_description || g.title || 'GIF',
            onmousemove: (ev) => { if (pointerMoved(o, ev) && o.index !== i) { o.index = i; render(); } },
            onclick: () => o.flat[i](),
          }, h('img', { src: (still && g.media_formats?.tinygifpreview?.url) || g.media_formats?.tinygif?.url, alt: g.content_description || g.title || '', loading: 'lazy' })))),
    h('div', { class: 'gifsource' }, 'Powered by KLIPY'),
  ];
}

const gifEls = new Map(); // event id -> <video> of a GIF, kept across renders so it does not restart
// A GIF plays only while it is on screen, and not at all when the system asks for less motion.
const gifSeen = new IntersectionObserver((seen) => {
  for (const e of seen) {
    if (e.isIntersecting && !matchMedia('(prefers-reduced-motion: reduce)').matches) e.target.play().catch(() => {});
    else e.target.pause();
  }
});
function gifVideo(id, url) {
  let el = gifEls.get(id);
  if (!el || el.dataset.src !== url) {
    el = h('video', { src: url, loop: true, playsInline: true, disablePictureInPicture: true, 'data-src': url });
    el.muted = true;
    gifEls.set(id, el);
    gifSeen.observe(el);
  }
  return el;
}
const stillEls = new Map(); // event id -> <video> paused on an early frame, for a video sent without a thumbnail
function videoStill(id, url) {
  let el = stillEls.get(id);
  if (!el || el.dataset.src !== url) {
    el = h('video', { src: `${url}#t=0.1`, preload: 'metadata', muted: true, playsInline: true, disablePictureInPicture: true, 'data-src': url });
    stillEls.set(id, el);
  }
  return el;
}
/** GIFs and video stills of chats no longer open are let go. */
function pruneGifs(r) {
  for (const [id, el] of gifEls) if (!r.events.has(id)) { gifSeen.unobserve(el); gifEls.delete(id); }
  for (const id of stillEls.keys()) if (!r.events.has(id)) stillEls.delete(id);
}

// ------------------------------------------------------------------ emoji

// The list (app/emoji.json, built by tools/make-emoji.py) loads the first time it is needed:
// groups of [emoji, Slovak name, search words in Slovak and English without diacritics].
let emojiData = null;
let emojiLoad = null;
function loadEmoji() {
  emojiLoad ||= fetch('/emoji.json').then((res) => res.json()).then((d) => { emojiData = d.groups; renderSoon(); })
    .catch(() => { emojiLoad = null; });
  return emojiLoad;
}
const emojiName = new Map(); // emoji -> Slovak name, once the list is loaded
const emojiNameOf = (e) => {
  if (!emojiName.size && emojiData) for (const [, list] of emojiData) for (const [c, name] of list) emojiName.set(c, name);
  return emojiName.get(e) || '';
};

/** Emoji whose words start with every word typed. The name counts before the other search words,
 *  then what Karchi picked or reacts with most, then the shorter name. */
function findEmoji(query, limit = 90) {
  const words = norm(query).split(/[\s_]+/).filter(Boolean);
  if (!words.length || !emojiData) return [];
  const joined = words.join('');
  const recent = [...recentEmoji(), ...quickReacts()];
  const hits = [];
  for (const [, list] of emojiData) {
    for (const [c, name, terms] of list) {
      const own = ` ${norm(name).replace(/[^\p{L}\p{N}]+/gu, ' ')}`;
      const t = ` ${terms}`;
      const score = words.every((w) => own.includes(` ${w} `) || own.endsWith(` ${w}`)) ? 0
        : words.every((w) => own.includes(` ${w}`)) ? 1
          : words.every((w) => t.includes(` ${w}`)) ? 2
            : joined.length > 3 && terms.replace(/ /g, '').includes(joined) ? 3 : -1; // "thumbsup"
      const used = recent.indexOf(c);
      if (score >= 0) hits.push([score, used < 0 ? 99 : used, name.length, c]);
    }
  }
  return hits.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).slice(0, limit).map((x) => x[3]);
}

const recentEmoji = () => { try { return JSON.parse(localStorage.getItem('ep_emoji_recent')) || []; } catch { return []; } };
function useEmojiRecent(e) {
  localStorage.setItem('ep_emoji_recent', JSON.stringify([e, ...recentEmoji().filter((x) => x !== e)].slice(0, 18)));
}

/** Puts an emoji into the message box where the cursor was, replacing `from`..`to` of the draft. */
function insertEmoji(r, e, from, to) {
  const draft = S.drafts.get(r.id) || '';
  setDraft(r.id, draft.slice(0, from) + e + draft.slice(to));
  S.caret = from + e.length;
  S.focusComposer = true;
  useEmojiRecent(e);
}

/** The emoji picker, for the message box or, with `react`, for a reaction to that message. */
function openEmoji(r, react = null) {
  if (r?.archiveOnly) return;
  const box = document.querySelector(`[data-root="${CSS.escape(r.id)}"]`);
  const at = box ? box.selectionStart : (S.drafts.get(r.id) || '').length;
  const to = box ? box.selectionEnd : at;
  openOverlay('emoji', { room: r.id, react, at, to });
  loadEmoji();
}

function pickEmoji(o, e, keep) {
  const r = S.rooms.get(o.room);
  if (!r) return;
  if (o.react) {
    S.overlay = null;
    const ev = roomModel(r).byId.get(o.react);
    useEmojiRecent(e);
    if (ev) toggleReact(r, ev, e);
    else render();
    return;
  }
  insertEmoji(r, e, o.at, o.to);
  o.at = o.to = o.at + e.length;
  if (keep) { render(); return; } // Shift: several in a row
  S.overlay = null;
  render();
}

const EMOJI_COLS = 9;
/** The grid is built once per query and kept across renders: moving the selection only moves a class,
 *  so ~1900 emoji are not rebuilt on every arrow key or every sync. */
function emojiGrid(o) {
  if (o.grid && o.gridFor === o.query) return o.grid;
  const sections = o.query.trim() ? [['', findEmoji(o.query)]]
    : [[T('Nedávne'), recentEmoji()], ...emojiData.map(([name, list]) => [name, list.map((x) => x[0])])];
  o.items = [];
  o.rows = [];
  o.cells = [];
  const body = [];
  for (const [title, list] of sections) {
    if (!list.length) continue;
    if (title) body.push(h('div', { class: 'rsec' }, title));
    const cells = list.map((c, k) => {
      const i = o.items.length;
      if (k % EMOJI_COLS === 0) o.rows.push([]); // every section starts a fresh row
      o.rows.at(-1).push(i);
      o.items.push(c);
      const cell = h('button', { class: 'ecell', 'data-i': i }, c);
      o.cells.push(cell);
      return cell;
    });
    body.push(h('div', { class: 'egrid' }, cells));
  }
  o.name = h('div', { class: 'ename' });
  const grid = h('div', {
    class: 'emojis', 'data-scroll': `emoji:${o.query}`,
    onmousemove: (ev) => { const i = ev.target.closest('.ecell')?.dataset.i; if (i != null && pointerMoved(o, ev)) markEmoji(o, Number(i), false); },
    onclick: (ev) => { const i = ev.target.closest('.ecell')?.dataset.i; if (i != null) pickEmoji(o, o.items[i], ev.shiftKey); },
  }, o.cells.length ? body : h('div', { class: 'empty' }, T('Nič sa nenašlo.')));
  Object.assign(o, { grid, gridFor: o.query, index: Math.min(o.index, Math.max(0, o.cells.length - 1)) });
  markEmoji(o, o.index, false);
  return grid;
}

function markEmoji(o, i, scroll = true) {
  const cell = o.cells[i];
  if (!cell) { o.name.textContent = ''; return; }
  o.cells[o.index]?.classList.remove('on');
  o.index = i;
  cell.classList.add('on');
  o.name.textContent = `${o.items[i]}  ${emojiNameOf(o.items[i])}`;
  if (scroll) cell.scrollIntoView({ block: 'nearest' });
}

/** Arrows move through the grid row by row; a shorter row keeps the nearest column. */
function emojiKey(o, e) {
  const row = o.rows.findIndex((r) => r.includes(o.index));
  if (row < 0) return;
  const col = o.rows[row].indexOf(o.index);
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const i = o.index + (e.key === 'ArrowRight' ? 1 : -1);
    if (o.cells[i]) markEmoji(o, i);
  } else {
    const next = o.rows[row + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) markEmoji(o, next[Math.min(col, next.length - 1)]);
  }
}

function emojiView(o) {
  if (!emojiData) return [cmdInput(o, T('Hľadať emoji…')), h('div', { class: 'empty' }, emojiLoad ? T('Načítavam…') : T('Emoji sa nenačítali.'))];
  o.flat = null; // the grid below handles Enter and the arrows itself
  const input = cmdInput(o, o.react ? T('Reagovať emoji…') : T('Hľadať emoji…'));
  // The grid takes the arrows and Enter before the shared field's own list handling.
  input.addEventListener('keydown', (e) => {
    if (/^Arrow/.test(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); emojiKey(o, e); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); if (o.items[o.index]) pickEmoji(o, o.items[o.index], e.shiftKey); }
  }, { capture: true });
  return [input, emojiGrid(o), h('div', { class: 'efoot' }, o.name, h('small', {}, o.react ? T('Enter reaguje') : T('Enter vloží · Shift viac')))];
}

/** ":smi" right before the cursor, the start of an emoji typed by name; '' otherwise. */
function colonWord(text, at) {
  const m = /(?:^|\s):([^\s:]{2,})$/.exec(text.slice(0, at));
  return m ? m[1] : '';
}
/** What the message box suggests for the ":name" being typed. */
function colonHits(r) {
  const c = S.colon;
  if (!c || c.room !== r.id || c.off) return [];
  if (!emojiData) { loadEmoji(); return []; }
  return findEmoji(c.word, 6);
}
function useColon(r, e) {
  const c = S.colon;
  insertEmoji(r, e, c.at - c.word.length - 1, c.at);
  S.colon = null;
  render();
}

// ------------------------------------------------------------------ mentions

/** Networks whose bridge turns a Matrix mention (a matrix.to link in formatted_body, listed in m.mentions) into
 *  the network's own: mautrix-meta @name, mautrix-whatsapp @number, mautrix-discord <@id>, the Teams bridge <at>.
 *  EduPage and mail have no mentions. */
const MENTION_APPS = new Set(['messenger', 'instagram', 'whatsapp', 'discord', 'teams']);
const canMention = (r) => !!r && isChat(r) && !r.archiveOnly && MENTION_APPS.has(r.app);
/** "@jan" right before the cursor, the start of a mention; '' right after a bare @, null when none is typed. */
function atWord(text, at) {
  const m = /(?:^|[\s(])@([^\s@]{0,30})$/.exec(text.slice(0, at));
  return m ? m[1] : null;
}
/** The chat's people for the "@…" being typed: by their nickname or the network's name. */
function mentionHits(r) {
  const a = S.mention;
  if (!a || a.room !== r.id || a.off || !canMention(r)) return [];
  const query = norm(a.word.normalize('NFKC'));
  const here = joinedPeople(r).map(([id]) => {
    const scores = [memberName(r, id), networkName(r, id), mentionName(r, id), handleOf(r, id)].filter(Boolean).map((n) => (query ? nameScore(n, query) : 0)).filter((s) => s >= 0);
    return { id, score: scores.length ? Math.min(...scores) : -1 };
  }).filter((x) => x.score >= 0)
    .sort((x, y) => x.score - y.score || mentionLabel(r, x.id).localeCompare(mentionLabel(r, y.id), 'sk')).slice(0, 6);
  // Below them, people of the Discord server who never wrote in this channel (from the collected history).
  const inRoom = new Set(here.map((x) => x.id));
  const more = serverPeople(r, a.word).filter((id) => !inRoom.has(id) && r.members.get(id)?.membership !== 'join');
  return [...here, ...more.slice(0, Math.max(0, 8 - here.length)).map((id) => ({ id, score: 99, server: true }))];
}
/** "@" in a channel of a Discord server: its people from the collected history (archive, nothing asks Discord),
 *  as the bridge's ghosts, from the second letter on. A late answer for another word or chat is only kept. */
function serverPeople(r, word) {
  if (r.app !== 'discord' || !r.serverId || norm(word).length < 2) return [];
  const key = `${r.serverId}|${norm(word)}`;
  const hit = dc.people.get(key);
  if (hit) return hit;
  dc.people.set(key, []);
  archiveGet(`/_archive/discord/people?guild=${q(r.serverId)}&q=${q(norm(word))}`).then((body) => {
    const domain = S.userId.split(':').slice(1).join(':');
    const ids = (body.people || []).filter((p) => /^\d+$/.test(p.user)).map((p) => {
      const id = `@discord_${p.user}:${domain}`;
      dc.names.set(id, p.name);
      return id;
    });
    dc.people.set(key, ids);
    if (S.mention?.room === r.id && serverPeople(r, S.mention.word) === ids) render();
  }).catch(() => setTimeout(() => dc.people.delete(key), 60e3)); // nobody for a minute, then ask again
  return [];
}
/** A person in the "@" list: as memberName, a network's name in plain letters. */
const mentionLabel = (r, id) => ((id !== S.userId && nickOf(id)) || unnamedGhost(r, id) ? memberName(r, id) : mentionName(r, id));
/** Beside the name, on the same line: who outside the channel this is, the network's own name under a nickname,
 *  and the @username the network shows (Instagram's); for a person without a name, their network. */
function mentionHint(r, id, server) {
  if (server) return h('small', {}, T('zo servera, tu ešte nepísal'));
  const unnamed = unnamedGhost(r, id);
  const bits = unnamed ? [nickOf(id) && handleOf(r, id) ? `@${handleOf(r, id)}` : '', appOf(r.app)?.name]
    : [nickOf(id) ? mentionName(r, id) : '', handleOf(r, id) ? `@${handleOf(r, id)}` : ''];
  return bits.some(Boolean) ? h('small', {}, bits.filter(Boolean).join(' · ')) : null;
}
/** The picked person goes into the box as "@" and the name their network shows to the others. */
function useMention(r, id) {
  const a = S.mention;
  const draft = S.drafts.get(r.id) || '';
  const from = a.at - a.word.length - 1;
  const name = `@${mentionName(r, id)}`;
  const rest = draft.slice(a.at);
  const gap = /^\s/.test(rest) ? '' : ' ';
  const text = draft.slice(0, from) + name + gap + rest;
  setDraft(r.id, text);
  picked.set(r.id, [...(picked.get(r.id) || []), { at: from, key: name.toLowerCase(), id }]);
  persistDrafts();
  S.mention = null;
  S.focusComposer = true;
  S.caret = from + name.length + gap.length;
  const box = document.querySelector(`[data-root="${CSS.escape(r.id)}"]`);
  if (box) { box.value = text; box.setSelectionRange(S.caret, S.caret); }
  render();
}

/** A message being edited keeps who its "@Name"s are: its pills, found where their names stand in its text. */
function keepPicks(key, c, text) {
  const parts = c.format === 'org.matrix.custom.html' && typeof c.formatted_body === 'string' ? mentionParts(c.formatted_body) : null;
  const picks = [];
  let from = 0;
  for (const x of parts || []) {
    if (typeof x === 'string') continue;
    const at = text.toLowerCase().indexOf(x.text.toLowerCase(), from);
    if (at < 0 || !x.text.startsWith('@')) continue;
    picks.push({ at, key: x.text.toLowerCase(), id: x.user });
    from = at + x.text.length;
  }
  if (picks.length) picked.set(key, picks); else picked.delete(key);
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeHtml = (s) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
/** The people `text` names as "@" and their full name (the network's, or Karchi's nickname for them): each
 *  { at, end, id }. A name picked from the list is that person where it stands, also when the name changed since (a
 *  name the archive brought later); one two people share, and „Bez mena“, count only where they were picked. */
function mentionsIn(r, text, lead = 0, key = r.id) {
  if (!canMention(r) || !text.includes('@')) return [];
  const who = new Map(); // "@name" in lower case → the id, or null when it is not one person
  for (const [id] of joinedPeople(r)) {
    for (const n of new Set([networkName(r, id), mentionName(r, id), nickOf(id)])) {
      const key = `@${n}`.toLowerCase();
      if (n && n.length > 1) who.set(key, (who.has(key) && who.get(key) !== id) || n === T('Bez mena') ? null : id);
    }
  }
  // Picked from the list: that person where the name stands (`lead`: where the trimmed `text` starts in the draft),
  // also when the text goes on into a longer name of someone else („@Ana“ picked, then „ Maria“ typed).
  const picks = picked.get(key) || [];
  // Someone of the Discord server outside this channel: only where he was picked, never by a typed name.
  const outside = picks.filter((x) => r.app === 'discord' && dc.names.has(x.id) && r.members.get(x.id)?.membership !== 'join');
  const joined = (id) => r.members.get(id)?.membership === 'join';
  const held = picks.filter((x) => joined(x.id) || outside.includes(x))
    .map((x) => ({ at: x.at - lead, end: x.at - lead + x.key.length, id: x.id, key: x.key }))
    .filter((x) => x.at >= 0 && text.slice(x.at, x.end).toLowerCase() === x.key && !/[\p{L}\p{N}_.@]/u.test(text[x.at - 1] || '')
      && !/[\p{L}\p{N}_]/u.test(text[x.end] || ''))
    .map(({ at, end, id }) => ({ at, end, id })).sort((x, y) => x.at - y.at);
  const names = [...who].filter(([, id]) => id).map(([key]) => key).sort((x, y) => y.length - x.length);
  if (!names.length) return held;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_.@])(?:${names.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  const typed = [...text.matchAll(re)].filter((m) => !held.some((x) => m.index < x.end && x.at < m.index + m[0].length))
    .map((m) => ({ at: m.index, end: m.index + m[0].length, id: who.get(m[0].toLowerCase()) })).filter((x) => joined(x.id));
  return [...held, ...typed].sort((x, y) => x.at - y.at);
}
/** A text message, with its mentions as the bridges read them: the body as typed, formatted_body with a
 *  matrix.to link for each mentioned person, and m.mentions (mautrix-whatsapp and -discord drop a link whose
 *  person is not listed there). Without a mention it is plain text, as before. */
/** `key`: the draft whose picked names count (null: a text from elsewhere, only names one person has). */
function textMessage(r, text, lead = 0, key = r.id) {
  const found = mentionsIn(r, text, lead, key);
  if (!found.length) return { msgtype: 'm.text', body: text };
  let html = '';
  let at = 0;
  for (const f of found) {
    html += escapeHtml(text.slice(at, f.at)) + `<a href="https://matrix.to/#/${escapeHtml(f.id)}">${escapeHtml(text.slice(f.at, f.end))}</a>`;
    at = f.end;
  }
  html += escapeHtml(text.slice(at));
  return { msgtype: 'm.text', body: text, format: 'org.matrix.custom.html', formatted_body: html.replace(/\n/g, '<br>'),
    'm.mentions': { user_ids: [...new Set(found.map((f) => f.id))] } };
}

/** A message's text with the people it mentions as pills, read from formatted_body as the bridges write it (a
 *  matrix.to link per person); null when it mentions nobody, then the body shows as it is. Only the text and the
 *  links are taken from the HTML, never its markup. */
const mentionMemo = new Map();
function mentionParts(html) {
  if (mentionMemo.has(html)) return mentionMemo.get(html);
  if (mentionMemo.size > 2000) mentionMemo.clear();
  const parts = readMentions(html);
  mentionMemo.set(html, parts);
  return parts;
}
function readMentions(html) {
  if (!/matrix\.to\/#\/(@|%40)/.test(html)) return null;
  const out = [];
  const push = (s) => { if (typeof out.at(-1) === 'string') out[out.length - 1] += s; else out.push(s); };
  const block = /^(P|DIV|LI|BLOCKQUOTE|H[1-6]|PRE|TR|UL|OL)$/;
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { push(n.data); continue; }
      if (n.nodeType !== 1 || /^(MX-REPLY|SCRIPT|STYLE|TEMPLATE|HEAD|TITLE)$/.test(n.tagName)) continue;
      if (n.tagName === 'BR') { push('\n'); continue; }
      if (n.tagName === 'IMG') { push(n.getAttribute('alt') || n.getAttribute('title') || ''); continue; } // a custom emoji as its :name:
      const user = n.tagName === 'A' && /^https:\/\/matrix\.to\/#\/((?:@|%40)[^/?#]+)/.exec(n.getAttribute('href') || '')?.[1];
      if (user) { out.push({ user: decodeURIComponent(user), text: n.textContent }); continue; }
      const isBlock = block.test(n.tagName);
      if (isBlock && out.length && !/\n$/.test(typeof out.at(-1) === 'string' ? out.at(-1) : '')) push('\n');
      walk(n);
      if (isBlock) push('\n');
    }
  };
  walk(new DOMParser().parseFromString(html, 'text/html').body);
  if (typeof out.at(-1) === 'string') out[out.length - 1] = out.at(-1).replace(/\n+$/, '');
  return out.some((x) => typeof x !== 'string') ? out : null;
}
/** The pills of a message's mentions; Karchi's own stands out. */
function mentionText(parts, find) {
  return parts.map((x) => (typeof x === 'string' ? linkified(x, find)
    : h('span', { class: `mention${x.user === S.userId ? ' me' : ''}` }, `@${bareName(x.text.replace(/^@/, ''))}`)));
}

// ------------------------------------------------------------------ send later

const laterItems = () => S.account[LATER]?.items || [];
let laterChain = Promise.resolve();
/** Changes the list as it stands on the server now: the service marks what it sent in the same list. */
function saveLater(change) {
  laterChain = laterChain.then(async () => {
    const seen = S.account[LATER];
    const now = await call('GET', `/user/${q(S.userId)}/account_data/${LATER}`).catch((err) => (err.status === 404 ? {} : Promise.reject(err)));
    const base = now.items || [];
    const next = { items: change(base) };
    if (next.items === base) return; // nothing to change: a write would only put back what was read, maybe stale
    await call('PUT', `/user/${q(S.userId)}/account_data/${LATER}`, next);
    if (S.account[LATER] === seen) S.account[LATER] = next;
    else {
      // A sync brought another writer's list meanwhile (the service marking an item, another device): neither it nor
      // `next` is surely the newest, so the list is read again; callers look for their items in it.
      const was = S.account[LATER];
      const fresh = await call('GET', `/user/${q(S.userId)}/account_data/${LATER}`).catch(() => next);
      if (S.account[LATER] === was) S.account[LATER] = fresh;
    }
    render();
  });
  return laterChain.catch(() => { laterChain = Promise.resolve(); alert(T('Zmena naplánovaných správ sa neuložila.')); });
}

function openLater(r) {
  if (r?.archiveOnly) return;
  const text = (S.drafts.get(r.id) || '').trim();
  const files = S.attach.get(r.id) || [];
  if (!text && !files.length) return alert(T('Najprv napíš správu alebo pridaj prílohu, potom vyber, kedy odíde.'));
  openOverlay('later', { room: r.id });
}

/** Uploads the attachments now and leaves the messages with the service, to go out at `at`. */
async function scheduleChat(r, at) {
  if (!(at > Date.now() + 30e3)) return alert(T('Vyber čas aspoň o minútu.'));
  const reply = replyRel(r);
  if (reply === false) return alert(replyNote(r));
  const text = (S.drafts.get(r.id) || '').trim();
  const files = S.attach.get(r.id) || [];
  S.overlay = null;
  S.scheduling = r.id;
  render();
  try {
    const contents = await Promise.all(files.map((f) => fileContent(f)));
    if (text) contents.push(textMessage(r, text, (S.drafts.get(r.id) || '').search(/\S|$/)));
    if (reply && contents.length) contents[0]['m.relates_to'] = reply;
    const batch = txnId(); // sendlater holds the whole batch when its reply may not go
    // Every item names the reply: „Poslať teraz“ or cancelling one part never sends the rest unchecked.
    const replyTo = reply ? { replyTo: reply['m.in_reply_to'].event_id } : {};
    const items = contents.map((content, seq) => ({ id: txnId(), room: r.id, at, seq, batch, ...replyTo, content }));
    await saveLater((list) => [...list, ...items]);
    if (S.account[LATER]?.items.some((it) => it.id === items[0]?.id)) {
      deleteDraft(r.id);
      S.attach.delete(r.id);
      if (S.replyTo?.room === r.id) S.replyTo = null;
    }
  } catch {
    alert(T('Prílohu sa nepodarilo nahrať, nič sa nenaplánovalo.'));
  }
  S.scheduling = null;
  S.focusComposer = true;
  render();
}

const localInput = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function laterView(o) {
  const r = S.rooms.get(o.room);
  const text = (S.drafts.get(r.id) || '').trim();
  const files = (S.attach.get(r.id) || []).length;
  const choices = remindChoices();
  const own = () => { const ts = new Date(o.custom || '').getTime(); if (ts) scheduleChat(r, ts); else document.querySelector('.laterat')?.focus(); };
  o.flat = [...choices.map(([, ts]) => () => scheduleChat(r, ts)), own];
  o.custom ??= localInput(Math.ceil((Date.now() + 3600e3) / 900e3) * 900e3); // in an hour, on a quarter
  const what = [files ? `${files} ${files === 1 ? T('príloha') : files < 5 ? T('prílohy') : T('príloh')}` : '', text].filter(Boolean).join(', ');
  return [
    h('div', { class: 'rsec' }, T`Odoslať neskôr: ${what.length > 70 ? `${what.slice(0, 70)}…` : what}`),
    h('div', { class: 'results', ...listScroll(o), tabindex: -1, 'data-root': '__overlay', onkeydown: (ev) => {
      if (ev.target.tagName === 'INPUT') { if (ev.key === 'Enter') { ev.preventDefault(); own(); } return; }
      const n = Number(ev.key);
      if (n >= 1 && n <= o.flat.length) { ev.preventDefault(); o.flat[n - 1](); }
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); o.index = (o.index + (ev.key === 'ArrowDown' ? 1 : -1) + o.flat.length) % o.flat.length; render(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); o.flat[o.index](); }
    } },
    choices.map(([label, ts], i) => resultRow(o, null, i, [h('kbd', { class: 'num' }, String(i + 1)), h('div', { class: 'rmeta' }, h('b', {}, label)), h('time', {}, `${dayLabel(ts)} ${timeLabel(ts)}`)])),
    h('div', { class: `res${o.index === choices.length ? ' on' : ''}` },
      h('kbd', { class: 'num' }, String(choices.length + 1)),
      h('div', { class: 'rmeta' }, h('b', {}, T('Vlastný čas'))),
      h('input', { class: 'laterat', type: 'datetime-local', value: o.custom, min: localInput(Date.now()), oninput: (e) => { o.custom = e.target.value; } }),
      h('button', { class: 'primary', onclick: own }, T('Naplánovať')))),
  ];
}

/** The chat's messages still waiting for their time, under its last message, each can go now or be dropped. */
function laterBubbles(r, m) {
  const mine = laterItems().filter((it) => it.room === r.id && !it.sent).sort((a, b) => a.at - b.at || a.seq - b.seq);
  return mine.map((it) => {
    const late = !it.failed && it.at < Date.now() - 90e3;
    const label = it.failed ? T`Neodoslalo sa: ${it.error || 'chyba'}` : late ? T('Čaká na server…') : T`Odíde ${dayLabel(it.at)} ${timeLabel(it.at)}`;
    const ev = { event_id: it.id, type: 'm.room.message', pending: true, sender: S.userId, origin_server_ts: it.at, content: it.content };
    return h('div', { class: `msg mine later${it.failed ? ' failed' : ''}`, 'data-event': it.id },
      h('div', { class: 'mrow' }, h('div', { class: 'bubble' }, bubbleBody(r, m, ev), h('span', { class: 'mtime' }, label))),
      h('div', { class: 'lateracts' },
        h('button', { onclick: () => saveLater((list) => list.map((x) => (x.id === it.id ? { ...x, at: Date.now(), failed: undefined, error: undefined } : x))) }, it.failed ? T('Skúsiť znova') : T('Poslať teraz')),
        h('button', { onclick: () => saveLater((list) => list.filter((x) => x.id !== it.id)) }, T('Zrušiť'))));
  });
}

// ------------------------------------------------------------------ relay: an awaited answer, as a picture for a friend

const relayItems = () => S.account[RELAY]?.items || [];
/** Changes the list as it is on asus now: relay.py marks items there while Weft is open. */
async function saveRelay(change) {
  const now = await call('GET', `/user/${q(S.userId)}/account_data/${RELAY}`).catch((err) => (err.status === 404 || isNetErr(err) ? {} : Promise.reject(err)));
  const there = now.items || [];
  // What this window saved but asus does not have yet (offline, a write still on its way) stays.
  const list = [...there, ...relayItems().filter((x) => !there.some((y) => y.id === x.id))];
  await putAccount(RELAY, { items: change(list) });
  render();
}
/** Chats to pick for something to go to, the latest first, filtered by the words typed. */
function chatPicks(query, skip = []) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  const off = serversOff();
  return [...S.rooms.values()].filter((x) => isChat(x) && !x.archiveOnly && !skip.includes(x.id) && roomTitle(x) && !serverOff(x, off))
    .sort((a, b) => (roomModel(b).messages.at(-1)?.origin_server_ts || 0) - (roomModel(a).messages.at(-1)?.origin_server_ts || 0))
    .filter((x) => words.every((w) => norm(`${roomTitle(x)} ${appOf(x.app)?.name || ''}`).includes(w))).slice(0, 40);
}
const chatPickRow = (o, x, i) => resultRow(o, null, i, [avatar(roomAvatar(x), roomTitle(x), 28),
  h('div', { class: 'rmeta' }, h('b', {}, highlighted(roomTitle(x), o.query)), h('small', {}, appOf(x.app)?.name || 'Matrix')),
  appOf(x.app) ? h('img', { class: 'rnet', src: appOf(x.app).icon, alt: '' }) : null]);

/** Preposlať: a shared post's address goes into the picked chat's message box, after what is there, and Karchi
 *  sends it himself. Only here and in the message's menu does its address show. */
const openForward = (link) => openOverlay('forward', { link });
function forwardPickView(o) {
  const list = chatPicks(o.query);
  o.flat = list.map((x) => () => forwardTo(o.link, x.id));
  if (o.index >= o.flat.length) o.index = 0;
  return [
    cmdInput(o, T('Preposlať do… (meno)')),
    h('div', { class: 'fwdlink' }, h('span', {}, o.link), h('button', { class: 'ghost', onclick: () => copyLink(o.link) }, T('Kopírovať'))),
    h('div', { class: 'results', ...listScroll(o) }, list.length ? list.map((x, i) => chatPickRow(o, x, i)) : h('div', { class: 'empty' }, T('Taký chat sa nenašiel.'))),
  ];
}
function forwardTo(link, id) {
  S.overlay = null;
  endEdit(); // the link starts a new message, never joins one being edited
  // A merged chat opens where its draft is: the link goes there, else to the picked network, which it then opens on.
  const g = groupOf(id);
  const drafted = g && groupRooms(g).find((x) => x.id !== id && (S.drafts.get(x.id) || '').trim());
  if (drafted) id = drafted.id;
  else if (g) saveMerges({ ...mergeData(), groups: (mergeData().groups || []).map((x) => (x.id === g.id ? { ...x, via: id, viaAt: Date.now() } : x)) });
  const now = S.drafts.get(id) || '';
  if (!now.includes(link)) setDraft(id, now.trim() ? `${now.trimEnd()} ${link}` : link);
  S.focusComposer = true;
  select(id);
}
async function copyLink(link) {
  try { await navigator.clipboard.writeText(link); } catch { prompt(T('Odkaz:'), link); }
}

/** "Keď odpíše, ukázať…": waits from Karchi's message `ev` (or his last one in the chat) and asks which chat gets it. */
function openRelay(r, ev = null) {
  if (!r || r.archiveOnly) return;
  const g = groupOf(r.id);
  const rooms = g ? g.rooms : [r.id];
  const anchor = ev || rooms.map((id) => S.rooms.get(id)).filter(Boolean)
    .flatMap((x) => roomModel(x).messages.filter((m) => m.sender === S.userId && m.event_id.startsWith('$')))
    .sort((a, b) => a.origin_server_ts - b.origin_server_ts).at(-1);
  openOverlay('relay', { room: r.id, rooms, event: anchor?.event_id || null, ts: anchor?.origin_server_ts || Date.now() });
}
function relayPickView(o) {
  const from = S.rooms.get(o.room);
  const list = chatPicks(o.query, o.rooms);
  o.flat = list.map((x) => () => { S.overlay = null; startRelay(o, x.id); });
  if (o.index >= o.flat.length) o.index = 0;
  const name = from ? roomTitle(from) : 'chat';
  return [
    cmdInput(o, o.draft ? T`Keď ${name} odpíše, obrázok odpovede ako koncept do… (meno)` : T`Keď ${name} odpíše, obrázok odpovede pôjde do… (meno)`),
    h('div', { class: 'chips relayopts' }, relayOpts.map(([key, keys]) => h('button', {
      type: 'button', class: `chip${o[key] ? ' on' : ''}`, 'aria-pressed': String(!!o[key]), title: keys,
      onclick: () => { relayToggle(o, key); document.querySelector('.cmd .cmdinput')?.focus(); },
    }, key === 'draft' ? T('Len koncept') : T('Ukázať meno a fotku')))),
    h('div', { class: 'results', ...listScroll(o) }, list.length ? list.map((x, i) => chatPickRow(o, x, i)) : h('div', { class: 'empty' }, T('Taký chat sa nenašiel.'))),
  ];
}
/** The picker's two choices: by default the picture is sent at once and hides the other side's name and photo. */
const relayOpts = [['draft', 'Alt+K'], ['who', 'Alt+M']];
function relayToggle(o, key) { o[key] = !o[key]; render(); }
function startRelay(o, to) {
  const now = Date.now();
  const item = { id: crypto.randomUUID(), room: o.room, ...(o.rooms.length > 1 ? { rooms: o.rooms } : {}), from_event: o.event, from_ts: o.ts,
    to_room: to, note: '', send: !o.draft, who: !!o.who, at: now, expires: now + 7 * 864e5, status: 'waiting', by: 'weft' };
  saveRelay((list) => [...list, item]).catch(() => alert(T('Sledovanie sa nepodarilo uložiť. Skús to znova.')));
}
/** Under a chat's last message: what waits for an answer here, and what did not work out, each with a way out. */
function relayBar(rooms) {
  const ids = new Set(rooms.map((x) => x.id));
  const mine = relayItems().filter((it) => (it.rooms || [it.room]).some((id) => ids.has(id))
    && (it.status === 'waiting' || (it.status === 'failed' && !it.seen)));
  return mine.map((it) => {
    const to = S.rooms.get(it.to_room);
    const name = to ? roomTitle(to) : 'chat';
    return h('div', { class: `cnote relay${it.status === 'failed' ? ' failed' : ''}`, 'data-key': `relay:${it.id}` },
      it.status === 'failed' ? T`Obrázok odpovede pre ${name} sa nepodaril: ${it.error || 'chyba'}`
        : it.send ? T`Čaká na odpoveď → obrázok pôjde do chatu ${name}` : T`Čaká na odpoveď → koncept do chatu ${name}`,
      h('button', { class: 'ghost', onclick: () => saveRelay((list) => list.map((x) => (x.id !== it.id ? x
        : it.status === 'failed' ? { ...x, seen: true } : { ...x, status: 'cancelled', done_at: Date.now() }))) }, it.status === 'failed' ? 'OK' : T('Zrušiť')));
  });
}

/** Tells the network Karchi read the chat, as Beeper does when a chat is open. */
function markRoomRead(r, force = false) {
  if (r?.archiveOnly || (preview() && !force)) return; // Karchi's own „Prečítané“ goes out at once
  // A receipt there tells WhatsApp Karchi saw the person's status: they would find him among its viewers.
  if (r?.statusRoom) return;
  // Only server events can be read up to; a reaction still on its way has a local id.
  // Member events are kept for the chat's history lines; a bridge may not map a receipt on one to a message.
  // A message waiting for its batch is not read: the receipt stops before it, so its sender sees no "seen".
  const cut = roomCut(r);
  const last = readUpTo([...r.events.values()].filter((ev) => ev.type !== 'm.room.redaction' && ev.type !== 'm.room.member' && ev.event_id.startsWith('$')), cut);
  if (!last || last.event_id === r.readSent) return;
  if (!force && (document.visibilityState !== 'visible' || !document.hasFocus())) return;
  if (!r.unread && r.receipts.get(S.userId) === last.event_id) return;
  r.unread = 0;
  r.readAt = Math.max(r.readAt, cut === Infinity ? Date.now() : 0, last.origin_server_ts);
  // Offline only this window knows; the receipt for exactly what was read goes out after reconnecting.
  if (S.offline) return (S.readLater ||= new Map()).set(r.id, last.event_id);
  r.readSent = last.event_id;
  call('POST', `/rooms/${q(r.id)}/receipt/m.read/${q(last.event_id)}`, {}).catch(() => { r.readSent = ''; });
}
window.addEventListener('focus', () => S.view === 'main' && render());

// ------------------------------------------------------------------ authenticated media

const mediaCache = new Map(); // `${mxc}|${size}` -> blob url, '' while loading or when it failed
const mediaQueue = []; // [key, mxc, size, quiet]: what a view asks for first, quiet prefetches after it
let mediaActive = 0;
let quietActive = 0;
let renderQueued = false;
let renderEpoch = 0; // counts render() calls; work done once per render is kept for the same epoch
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; refresh(); });
}
// A file that arrives re-renders the window only when something drawn without it asked for it plainly.
// Avatars and message pictures leave a placeholder instead and take the file in place: rebuilding the
// whole window for each of the hundreds of thumbnails at start kept Weft busy for tens of seconds.
const mediaLoading = new Set(); // keys queued or being fetched
const mediaFailed = new Map(); // key -> when a fetch failed for a passing reason; asked again a minute later
const MEDIA_RETRY = 60000;
/** A file that failed a minute ago for a passing reason (503, a dropped connection) may be asked for again. */
function mediaRetry(key) {
  const at = mediaFailed.get(key);
  if (at === undefined || Date.now() - at < MEDIA_RETRY || mediaLoading.has(key)) return;
  mediaFailed.delete(key);
  if (mediaCache.get(key) !== '') return;
  mediaCache.delete(key);
  mediaRedraw.add(key); // its spot shows initials: when it comes, the view is drawn again
}
const mediaRedraw = new Set(); // keys still loading that a plain media() call is waiting for
const mediaSpots = new Map(); // key -> [[placeholder element, url => element in its place]]
/** Blob url of a Matrix file (thumbnail when `size` is set); '' until it is loaded. `avatar`: a profile picture,
 *  kept on this computer (see avatarSeen). An old message's photo or video in the archive comes as `archive:<id>`. */
function media(mxc, size = 0, redraw = true, avatar = false) {
  if (!mxc?.startsWith('mxc://') && !ARCHIVE_URL.test(mxc || '')) return '';
  const key = `${mxc}|${size}`;
  if (avatar) avatarSeen(key);
  mediaRetry(key);
  if (!mediaCache.has(key) && avatarKept(key)) mediaCache.set(key, avatarUrl(key)); // kept on this computer
  if (!mediaCache.has(key)) {
    mediaCache.set(key, '');
    mediaLoading.add(key);
    const quiet = mediaQueue.findIndex((x) => x[3]); // a view's file goes before every prefetch
    mediaQueue.splice(quiet < 0 ? mediaQueue.length : quiet, 0, [key, mxc, size, false]);
    pumpMedia();
  }
  if (redraw && mediaLoading.has(key)) { mediaRedraw.add(key); mediaAwaited = true; }
  return mediaCache.get(key);
}
let mediaAwaited = false; // set when a view asked for a file that will redraw the window on arrival
/** `make(url)` for a loaded file, or `empty()`, which is replaced by `make(url)` when the file arrives. */
function mediaInPlace(mxc, size, make, empty, avatar = false) {
  const url = media(mxc, size, false, avatar);
  if (url) return make(url);
  const placeholder = empty();
  const key = `${mxc}|${size}`;
  if (!mediaLoading.has(key)) return placeholder; // no file, or it failed: nothing will arrive
  placeholder._id = key; // a patch keeps a waiting placeholder only for the same file
  if (!mediaSpots.has(key)) mediaSpots.set(key, []);
  mediaSpots.get(key).push([placeholder, make]);
  return placeholder;
}
function mediaArrived(key, url) {
  mediaLoading.delete(key);
  const spots = mediaSpots.get(key) || [];
  mediaSpots.delete(key);
  if (!url) return void mediaRedraw.delete(key); // failed: nothing new to draw
  for (const [el, make] of spots) if (el.isConnected) el.replaceWith(make(url));
  if (mediaRedraw.delete(key)) renderSoon();
}
function pumpMedia() {
  if (avatarsRead && !avatarsDone) { // what this computer may keep is not asked of asus before the read ends
    avatarsHeld ||= Promise.race([avatarsRead, new Promise((resolve) => setTimeout(resolve, 2000))])
      .then(() => { avatarsDone = true; avatarsHeld = null; pumpMedia(); });
    return;
  }
  while (mediaActive < 4 && mediaQueue.length) {
    const quiet = mediaQueue[0][3];
    if (quiet && (quietActive >= 2 || S.offline)) break; // prefetches leave room for what comes into sight
    const [key, mxc, size] = mediaQueue.shift();
    if (quiet) quietQueued.delete(key);
    if (quiet) {
      if (mediaCache.has(key) || avatarKept(key)) continue; // a view asked for it meanwhile, or it was kept
      mediaCache.set(key, '');
      mediaLoading.add(key);
      quietActive++;
    }
    mediaActive++;
    const gen = avatarGen;
    const stale = () => { // fetched for a session that has ended: nothing of it is kept
      if (S.token && (mediaSpots.has(key) || mediaRedraw.has(key))) { // the new login waits for it: ask again
        const first = mediaQueue.findIndex((x) => x[3]);
        return void mediaQueue.splice(first < 0 ? mediaQueue.length : first, 0, [key, mxc, size, false]);
      }
      mediaCache.delete(key);
      mediaArrived(key, null);
    };
    const path = mediaPath(mxc, size);
    // Offline only what sw.js kept is shown; the rest is asked for again after reconnecting.
    const got = S.offline ? (globalThis.caches?.match(path) || Promise.resolve()).then((res) => res || Promise.reject(new Error('offline')))
      : fetch(path, { headers: { Authorization: `Bearer ${S.token}` } });
    got.then((res) => {
      // asus has no such file: a kept "none" keeps a profile picture from being asked for at every start.
      if (res.status === 404 && gen === avatarGen) avatarKeep(key, null);
      else if (!res.ok && gen === avatarGen) mediaFailed.set(key, Date.now());
      return res.ok ? res.blob() : null;
    })
      .then((blob) => {
        if (gen !== avatarGen) return stale();
        if (!blob) return mediaArrived(key, null);
        // A prefetched picture nobody waits for is only kept: its blob url is made when it is drawn.
        if (quiet && gen === avatarGen && !mediaSpots.has(key) && !mediaRedraw.has(key)) {
          avatarKeep(key, blob, false);
          mediaCache.delete(key);
          return void mediaLoading.delete(key);
        }
        const url = URL.createObjectURL(blob);
        mediaCache.set(key, url);
        mediaArrived(key, url);
        if (gen === avatarGen) avatarKeep(key, blob);
      })
      .catch(() => {
        if (gen !== avatarGen) return stale();
        (S.mediaMissed ||= []).push(key);
        mediaFailed.set(key, Date.now());
        mediaArrived(key, null);
      })
      .finally(() => { mediaActive--; if (quiet) quietActive--; pumpMedia(); });
  }
}

// Profile pictures stay on this computer, so the inbox, Ctrl+K and chats draw them in their first frame, also
// offline. avatar() marks its files; they are kept in IndexedDB `weft-avatars` (its own database: raising
// weft-offline's version would be blocked by older windows that still hold it open), read whole at start, and the
// first frame waits for that at most AVATAR_WAIT; what the read brings later replaces initials in place. A blob url is
// made only when its picture is drawn: making one is what costs (about 100 ms for 300 at 4x CPU), reading is quick. Records are { key, blob, at }: blob null when asus has no such
// file (asked again after a week), at when it was last drawn (renewed once a day); over AVATAR_MAX the least
// recently drawn go. A changed
// picture has a new mxc, so a new key: it is fetched as it shows, the old one ages out. Blob urls are never revoked:
// a session holds at most a few thousand small ones.
const AVATAR_MAX = 2000;
const AVATAR_WAIT = 150;
const AVATAR_NONE_DAYS = 7;
const avatarRecs = new Map(); // key -> record as stored (blob handles: the bytes stay on disk)
const avatarKeys = new Set(); // keys avatar() asked for, or prefetched: what arrives for them is kept
const avatarDirty = new Map(); // key -> record still to write
let avatarsDone = true; // the kept pictures were read (or the read gave up); pumpMedia waits for it
let avatarsHeld = null;
let avatarGen = 0; // a logout ends the reads, fetches and writes started before it
let avatarDb = null;
let avatarsRead = null;
function avatarTx(mode, fn) {
  avatarDb ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('weft-avatars', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('pics', { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return avatarDb.then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('pics', mode);
    const req = fn(tx.objectStore('pics'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  }));
}
/** Puts the kept pictures into mediaCache, once per session; ones a view is already waiting for take their place. */
function readAvatars() {
  const gen = avatarGen;
  if (avatarsRead) return avatarsRead;
  avatarsDone = false;
  avatarsRead = avatarTx('readonly', (st) => st.getAll()).then((list) => {
    if (gen !== avatarGen) return;
    const waiting = new Map();
    let missed = false;
    for (const rec of list || []) {
      if (!avatarRecs.has(rec.key)) avatarRecs.set(rec.key, rec);
      avatarKeys.add(rec.key);
      if (!mediaCache.has(rec.key) || mediaCache.get(rec.key) || !avatarKept(rec.key)) continue;
      // Asked for before this read ended: a view waits for it, or (offline) already gave up and shows initials.
      if (mediaLoading.has(rec.key)) waiting.set(rec.key, avatarUrl(rec.key));
      else if (rec.blob) { mediaCache.set(rec.key, avatarUrl(rec.key)); missed = true; }
    }
    if (missed) renderSoon();
    warmAvatars();
    if (!waiting.size) return;
    for (let i = mediaQueue.length; i--;) if (waiting.has(mediaQueue[i][0])) mediaQueue.splice(i, 1);
    for (const [key, url] of waiting) { mediaCache.set(key, url); mediaArrived(key, url || null); }
  }).catch(() => {}).finally(() => { if (gen === avatarGen) avatarsDone = true; });
  return avatarsRead;
}
/** Kept on this computer: a picture, or asus's "none" from the last week. */
function avatarKept(key) {
  const rec = avatarRecs.get(key);
  return !!rec && (!!rec.blob || Date.now() - rec.at < AVATAR_NONE_DAYS * 864e5);
}
const avatarUrl = (key) => (avatarRecs.get(key)?.blob ? URL.createObjectURL(avatarRecs.get(key).blob) : '');
/** Whether a picture shows at once: loaded, or kept on this computer. */
const mediaReady = (key) => !!(mediaCache.get(key) || (!mediaCache.has(key) && avatarRecs.get(key)?.blob));
/** The kept pictures, or nothing after AVATAR_WAIT: a slow disk never holds the window back longer. */
const avatarsReady = () => Promise.race([readAvatars(), new Promise((resolve) => setTimeout(resolve, AVATAR_WAIT))]);
/** avatar() drew `key`: it is kept when it arrives, and a kept one counts as used today. */
function avatarSeen(key) {
  avatarKeys.add(key);
  const rec = avatarRecs.get(key);
  if (rec?.blob && Date.now() - rec.at > 864e5) avatarWrite({ ...rec, at: Date.now() });
}
/** `drawn` false: prefetched, never drawn yet; such ones go first over the cap (their first drawing renews them). */
function avatarKeep(key, blob, drawn = true) {
  if (avatarKeys.has(key)) avatarWrite({ key, blob, at: drawn || !blob ? Date.now() : 0 });
}
let avatarSaveTimer = null;
let avatarPersist = null;
function avatarWrite(rec) {
  avatarRecs.set(rec.key, rec);
  avatarDirty.set(rec.key, rec);
  avatarSaveTimer ||= setTimeout(avatarSave, 2000);
}
/** Writes what arrived in one transaction, and lets the least recently drawn go over AVATAR_MAX, counted in the
 *  database itself (another window may have added its own). */
function avatarSave() {
  avatarSaveTimer = null;
  const gen = avatarGen;
  const recs = [...avatarDirty.values()];
  avatarDirty.clear();
  if (!recs.length || gen !== avatarGen) return;
  if (recs.some((r) => r.blob)) warmAvatars(); // the new ones too, before they show
  if (!avatarPersist) avatarPersist = globalThis.navigator?.storage?.persist?.().catch(() => {}) || true; // kept from eviction, if the browser agrees
  avatarTx('readwrite', (st) => {
    for (const rec of recs) st.put(rec);
    const n = st.count();
    n.onsuccess = () => {
      if (n.result <= AVATAR_MAX) return;
      const all = st.getAll();
      all.onsuccess = () => {
        for (const rec of all.result.sort((a, b) => a.at - b.at).slice(0, n.result - AVATAR_MAX)) { st.delete(rec.key); avatarRecs.delete(rec.key); }
      };
    };
  }).catch(() => {});
}
/** Logging out: nothing kept stays, and nothing still on its way is written afterwards, in any open window (each
 *  drops what it would still write when another one forgets). */
const avatarPeers = globalThis.BroadcastChannel ? new BroadcastChannel('weft-avatars') : null;
if (avatarPeers) avatarPeers.onmessage = (e) => { if (e.data === 'forget') forgetAvatars(false); };
function forgetAvatars(tell = true) {
  if (tell) avatarPeers?.postMessage('forget');
  avatarGen++;
  clearTimeout(avatarSaveTimer);
  avatarSaveTimer = null;
  avatarsRead = null;
  avatarsDone = true;
  for (const key of avatarKeys) if (!mediaLoading.has(key)) mediaCache.delete(key); // a new login keeps them again
  for (let i = mediaQueue.length; i--;) if (mediaQueue[i][3]) mediaQueue.splice(i, 1);
  quietQueued.clear();
  avatarImgs.clear();
  avatarRecs.clear();
  avatarDirty.clear();
  avatarKeys.clear();
  return avatarTx('readwrite', (st) => st.clear()).catch(() => {});
}
/** Kept pictures are decoded ahead in idle time, the most recently drawn first: an <img> of an already decoded url is
 *  complete at once, so Ctrl+K's results and a newly opened chat show their pictures in the first frame instead of
 *  empty circles. The Image objects are held so the decoded copies stay (about 16 KB each). */
const AVATAR_WARM = 800;
const avatarImgs = new Map(); // key -> decoded Image
let warming = false;
let warmAgain = false;
function warmAvatars() {
  if (warming) return void (warmAgain = true);
  const gen = avatarGen;
  const todo = [...avatarRecs.values()].filter((r) => r.blob && !avatarImgs.has(r.key)).sort((a, b) => b.at - a.at).slice(0, AVATAR_WARM - avatarImgs.size).map((r) => r.key);
  if (!todo.length) return;
  warming = true;
  const idle = globalThis.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 50));
  // A busy start gets no idle time: every 50 ms a batch of 40 is decoded anyway, so Ctrl+K soon after start (whose
  // results may be any chat) has them too. All at once would hold Ctrl+K back ~250 ms on a slow computer, and it
  // begins after the next frame, never holding the first one back.
  const step = (deadline) => {
    let forced = deadline.didTimeout ? 40 : 0;
    while (todo.length && (deadline.timeRemaining() > 2 || forced-- > 0) && gen === avatarGen) {
      const key = todo.shift();
      if (!avatarRecs.get(key)?.blob) continue;
      if (!mediaCache.get(key)) {
        if (mediaLoading.has(key)) continue; // its fetch brings it
        mediaCache.set(key, avatarUrl(key));
      }
      const img = new Image();
      img.src = mediaCache.get(key);
      img.decode().catch(() => {});
      avatarImgs.set(key, img);
    }
    if (todo.length && gen === avatarGen) return void idle(step, { timeout: 50 });
    warming = false;
    if (warmAgain && gen === avatarGen) { warmAgain = false; warmAvatars(); }
  };
  requestAnimationFrame(() => idle(step, { timeout: 50 }));
}
/** Every sync may bring a new or changed picture (a new mxc): the prefetch runs again, at most once a minute. */
let prefetchTimer = null;
let prefetchAt = 0;
function prefetchSoon() {
  if (prefetchTimer || S.offline) return;
  const wait = prefetchAt ? Math.max(2000, prefetchAt + 60e3 - Date.now()) : 2000;
  prefetchTimer = setTimeout(() => (globalThis.requestIdleCallback || ((fn) => setTimeout(fn, 100)))(() => {
    prefetchTimer = null;
    prefetchAt = Date.now();
    prefetchAvatars();
  }, { timeout: 5000 }), wait);
}
/** The pictures of every chat (the inbox rows, what Ctrl+K finds) and of the people in the open and the last opened
 *  chats are fetched quietly, so they are here the first time they show. */
const quietQueued = new Set();
function prefetchAvatars() {
  if (!S.token || S.offline) return;
  const want = new Set();
  for (const r of S.rooms.values()) {
    if (r.archiveOnly || !isChat(r)) continue;
    want.add(roomAvatar(r));
    // The senders of the messages this computer keeps: a group opened offline shows who wrote them.
    for (const ev of roomModel(r).messages.slice(-40)) if (ev.sender !== S.userId) want.add(r.members.get(ev.sender)?.avatar);
  }
  for (const id of [S.selected, ...opened().slice(0, 3)]) {
    const r = S.rooms.get(id);
    if (r && isChat(r)) for (const [, mem] of joinedPeople(r).slice(0, 60)) want.add(mem.avatar);
  }
  for (const mxc of want) {
    const key = `${mxc}|64`;
    mediaRetry(key);
    if (!mxc?.startsWith('mxc://') || mediaCache.has(key) || avatarKept(key) || quietQueued.has(key)) continue;
    avatarKeys.add(key);
    quietQueued.add(key);
    mediaQueue.push([key, mxc, 64, true]);
  }
  pumpMedia();
}

/** Re-render for new data, but never under a form being filled in. */
function refresh() {
  // Not while an account login form is open: re-rendering would clear what is being typed.
  if (S.view === 'main' && S.panel !== 'link') render();
}

function resetRoom() {
  S.roomId = null;
  S.events.clear();
  S.historyDone = false;
}

function addEvent(ev) {
  if (ev.type === 'm.room.member') {
    if (ev.content?.displayname) S.names.set(ev.state_key, ev.content.displayname);
    return;
  }
  if (ev.type !== 'm.room.message' || !ev.content?.body) return;
  const txn = ev.unsigned?.transaction_id;
  if (txn) S.pending.delete(txn);
  S.events.set(ev.event_id, ev);
}

async function loadHistory(from) {
  const roomId = S.roomId;
  let token = from;
  try {
    while (token && roomId === S.roomId) {
      const data = await call('GET', `/rooms/${q(roomId)}/messages?dir=b&limit=500&from=${q(token)}&filter=${q(JSON.stringify({ lazy_load_members: false }))}`);
      (data.chunk || []).forEach(addEvent);
      (data.state || []).forEach(addEvent);
      token = data.end && data.chunk?.length ? data.end : null;
    }
    const members = await call('GET', `/rooms/${q(roomId)}/joined_members`);
    for (const [id, m] of Object.entries(members.joined || {})) if (m.display_name) S.names.set(id, m.display_name);
    // First run: what is already here counts as read, only newer messages show as unread.
    if (!S.account[SEEN]) saveSeen({ _all: Date.now() });
  } catch {
    // history is a nicety; new messages keep coming through sync. The kept copy then keeps its older ones.
    S.eduPartial = true;
  }
  S.historyDone = true;
  keepSoon();
  refresh();
}

// ------------------------------------------------------------------ model

/** What Karchi's rules let through (Settings → EduPage). */
const eduTimeline = () => eduAll().filter((ev) => noticeShow(ev) !== 'hidden');
/** Resolve EduPage edits before grouping: a changed announcement stays in its original thread. */
function eduAll() {
  const events = [...S.events.values()].sort((a, b) => a.origin_server_ts - b.origin_server_ts);
  const originals = new Map(events.filter((ev) => ev.content['m.relates_to']?.rel_type !== 'm.replace').map((ev) => [ev.event_id, ev]));
  for (const edit of events) {
    const rel = edit.content['m.relates_to'];
    if (rel?.rel_type !== 'm.replace') continue;
    const original = originals.get(rel.event_id);
    const content = edit.content['m.new_content'];
    if (original && original.sender === edit.sender && content?.body && !isHeld(edit, eduCut())) {
      const relation = original.content['m.relates_to'];
      originals.set(original.event_id, { ...original, content: { ...content, ...(relation ? { 'm.relates_to': relation } : {}) } });
    }
  }
  return [...originals.values()];
}

function threads() {
  const cut = eduCut(); // EduPage held for its batch too, when Karchi chose so
  const events = eduTimeline().filter((ev) => !isHeld(ev, cut)).sort((a, b) => a.origin_server_ts - b.origin_server_ts);
  for (const p of S.pending.values()) events.push(p);
  const rootOf = new Map();
  const byRoot = new Map();
  for (const ev of events) {
    const parent = ev.content['m.relates_to']?.['m.in_reply_to']?.event_id;
    const root = parent && rootOf.get(parent);
    const thread = root && byRoot.get(root);
    if (thread) {
      rootOf.set(ev.event_id, root);
      thread.replies.push(ev);
      thread.last = Math.max(thread.last, ev.origin_server_ts);
    } else {
      rootOf.set(ev.event_id, ev.event_id);
      byRoot.set(ev.event_id, { id: ev.event_id, root: ev, replies: [], last: ev.origin_server_ts });
    }
  }
  S.rootOf = rootOf; // event id -> its thread, for search results
  return [...byRoot.values()].sort((a, b) => b.last - a.last);
}

const people = () => S.account[PEOPLE] || { colors: {}, me: '' };
const prefs = () => ({ ...DEFAULT_PREFS, ...(S.account[PREFS] || {}) });
const nameOf = (id) => (id === S.userId ? T('Ja') : S.names.get(id) || id.slice(1).split(':')[0]);
const colorOf = (id) => (id === S.userId ? ME_COLOR : people().colors?.[id] || OTHER_COLOR);
const initials = (id) =>
  (id === S.userId && people().me ? people().me : nameOf(id))
    .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
/** edupage.org paints a stored color mixed with white: `amount` 0.5 is its timetable card. */
const mix = (hex, amount) =>
  `#${[1, 3, 5].map((i) => Math.round((parseInt(hex.slice(i, i + 2), 16) || 0) * (1 - amount) + 255 * amount).toString(16).padStart(2, '0')).join('')}`;
const textOn = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#333' : '#fff';
};
/** A thread is unread when someone else wrote after Karchi last opened it. */
function isUnread(t) {
  const seen = S.account[SEEN];
  const last = t.replies.at(-1) || t.root;
  if (!seen || last.sender === S.userId || last.pending) return false;
  if (!t.replies.length && noticeShow(t.root) === 'quiet') return false; // Karchi wants this type there, never new
  return t.last > (seen[t.id] ?? seen._all ?? 0);
}
const pad = (n) => String(n).padStart(2, '0');
// Another year says which: the archive reaches years back.
const dayLabel = (ts) => { const d = new Date(ts); return `${DAYS[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear()}`; };
const timeLabel = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** When a receipt came, short: "14:32" today, "včera 14:32", then "Po 10.11. 14:32". */
const seenLabel = (ts) => {
  const d = new Date(ts), today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  const day = days === 0 ? '' : days === 1 ? T('včera ') : `${DAYS_SHORT[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear() === today.getFullYear() ? '' : d.getFullYear()} `;
  return day + timeLabel(ts);
};
const fullDate = (ts) => { const d = new Date(ts); return LANG === 'en' ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`; };
const shortDate = (ts) => { const d = new Date(ts); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
const listDate = (ts) => {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return timeLabel(ts);
  return d.getFullYear() === now.getFullYear() ? `${d.getDate()}. ${MONTHS[d.getMonth()]}` : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
};
const bodyOf = (ev) => String(ev.content.body).replace(/^(> .*\n)+\n/, '').trim();

// ------------------------------------------------------------------ inbox

const inboxState = () => S.account[INBOX] || {};
let inboxTimer;
/** Changes a chat's inbox state (null clears a field) and saves it a moment later. */
function setChatState(key, patch) {
  if (preview()) (S.previewPatches ||= []).push([key, patch]); // laid over the server's inbox state after the first sync
  S.account[INBOX] = patchInbox({ ...inboxState() }, key, patch);
  saveInboxSoon();
  render();
}
/** `all` (a copy of the inbox state) with one chat's fields changed; null or false clears a field. */
function patchInbox(all, key, patch) {
  const next = { ...all[key], ...patch };
  for (const k of Object.keys(next)) if (next[k] == null || next[k] === false) delete next[k];
  if (Object.keys(next).length) all[key] = next;
  else delete all[key];
  return all;
}
function saveInboxSoon() {
  clearTimeout(inboxTimer);
  inboxTimer = setTimeout(() => putAccount(INBOX, S.account[INBOX]).catch(() => alert(T('Zmena sa neuložila.'))), 300);
}

// ------------------------------------------------------------------ merged chats

// One person's one-to-one chats on several networks as one chat, like Beeper's Merge Chats: one inbox row, one history,
// and a switch for the network a message goes out on. Only Weft knows about it (account data): bridges, rooms and the
// people in them see nothing, and „Rozpojiť“ gives the chats back as they were.
// { groups: [{ id, rooms: [room id], name?, via?: room id Karchi picked to write to, viaAt?, at, auto?: 'name'|'people' }],
//   dismissed: ['a|b'], auto?: false (Settings → Správy: no automatic merging) }
const MERGES = 'sk.karchi.merges';
const MERGE_APPS = ['messenger', 'instagram', 'whatsapp', 'discord', 'teams'];
const mergeData = () => S.account[MERGES] || {};
/** A chat that can be merged: a live one-to-one chat on a messaging network (no group, EduPage, mail or archive). */
const canMerge = (r) => !!r && isChat(r) && !r.archiveOnly && MERGE_APPS.includes(r.app) && !!dmPartner(r);
const liveChat = (r) => !!r && isChat(r) && !r.archiveOnly;
let mergeMemo = { data: null, size: -1, byRoom: new Map() };
/** Room id -> its group, for groups of which at least two chats are here. */
function mergeIndex() {
  const data = mergeData();
  if (mergeMemo.data === data && mergeMemo.size === S.rooms.size) return mergeMemo.byRoom;
  const byRoom = new Map();
  for (const g of data.groups || []) {
    const live = (g.rooms || []).filter((id) => liveChat(S.rooms.get(id)) && !byRoom.has(id));
    if (live.length > 1) for (const id of live) byRoom.set(id, g);
  }
  mergeMemo = { data, size: S.rooms.size, byRoom };
  return byRoom;
}
const groupOf = (id) => (id && mergeIndex().get(id)) || null;
const mergeKey = (g) => `merge:${g.id}`;
/** The key a room's chat has in the inbox: its group's while it is merged. */
const keyOfRoom = (id) => { const g = groupOf(id); return g ? mergeKey(g) : id; };
/** The inbox key of the open chat (S.selected is always a room: in a merged chat the one it writes to). */
const selKey = () => keyOfRoom(S.selected);
const groupRooms = (g) => (g.rooms || []).map((id) => S.rooms.get(id)).filter(liveChat);
const appOf = (id) => APPS.find((a) => a.id === id);
const pairKey = (a, b) => [a, b].sort().join('|');

/** Where a merged chat writes: a chat with an unsent draft (it stays where it was left), else the network the person
 *  last wrote from, unless Karchi picked another since. A network whose account is down comes last. */
const downApps = () => new Set(downAccounts().map((d) => d.id));
/** `down`: the networks whose account is down, when the caller already has them (one inbox pass asks once). */
function viaRoom(g, rooms = groupRooms(g), down = null) {
  const drafted = rooms.find((r) => hasDraft(r.id) || S.attach.get(r.id)?.length);
  if (drafted) return drafted;
  down ||= downApps();
  const up = rooms.filter((r) => !down.has(r.app));
  const pool = up.length ? up : rooms;
  let theirs = null; let theirTs = -1; let any = pool[0]; let anyTs = -1;
  for (const r of pool) {
    const msgs = roomModel(r).messages;
    const last = msgs.at(-1);
    if (last && last.origin_server_ts > anyTs) { any = r; anyTs = last.origin_server_ts; }
    const their = msgs.findLast((ev) => ev.sender !== S.userId);
    if (their && their.origin_server_ts > theirTs) { theirs = r; theirTs = their.origin_server_ts; }
  }
  const picked = pool.find((r) => r.id === g.via);
  if (picked && (g.viaAt || 0) >= theirTs) return picked;
  return theirs || any;
}

/** The person a merged chat is with: the name Karchi gave it (a nickname), the people map's, or the fullest name among the chats. */
function mergedTitle(g, rooms) {
  if (g.name) return g.name;
  const nick = rooms.map((r) => roomNick(r)).find(Boolean);
  if (nick) return nick;
  const ids = new Set(rooms.map((r) => r.id));
  const person = (S.account[FRIENDS]?.people || []).find((p) => p.rooms?.some((id) => ids.has(id)));
  if (person) return S.account[FRIEND_EDITS]?.[person.id]?.name || person.name;
  return rooms.map(roomTitle).reduce((a, b) => (b.split(/\s+/).length > a.split(/\s+/).length ? b : a));
}

/** One inbox entry for a group, from its chats' entries. `room` is the chat it writes to. */
function mergedEntry(g, parts, down = null) {
  const newest = parts.reduce((a, b) => (b.last > a.last ? b : a));
  const rooms = parts.map((p) => p.room);
  return {
    key: mergeKey(g), kind: 'room', merged: g, rooms, app: newest.app, apps: [...new Set(rooms.map((r) => r.app))],
    room: rooms.find((r) => r.id === S.selected) || viaRoom(g, rooms, down), lastRoom: newest.room,
    title: mergedTitle(g, rooms), lastMsg: newest.lastMsg, last: newest.last, count: parts.reduce((n, p) => n + p.count, 0),
    counts: parts.map((p) => [p.room, p.count]),
  };
}

/** A merged chat's inbox state: its own, with the newest "wrote while messages waited" of its chats. */
function entryState(e) {
  const st = inboxState();
  if (!e?.merged) return st[e?.key] || {};
  const held = Math.max(0, ...e.rooms.map((r) => st[r.id]?.held || 0));
  return { ...st[e.key], ...(held ? { held } : {}) };
}
/** Changes an entry's inbox state; clearing `held` of a merged chat clears it on each of its chats. */
function setEntryState(e, patch) {
  if (e.merged && 'held' in patch && patch.held == null) for (const r of e.rooms) if (inboxState()[r.id]?.held) setChatState(r.id, { held: null });
  setChatState(e.key, patch);
}

const ENTRY_FIELDS = ['done', 'low', 'remind', 'unread'];
/** Merges chats (and any groups they are in) into one; their inbox state goes with them. */
function mergeChats(ids) {
  const { data, inbox, g } = mergeInto(mergeData(), inboxState(), ids);
  saveMerges(data);
  S.account[INBOX] = inbox;
  saveInboxSoon();
  if (g.rooms.includes(S.selected)) S.focusComposer = true;
  return g;
}

/** `data` and `inbox` (merges and inbox state) after merging `ids` and the groups they are in, written nowhere.
 *  `extra` goes on a new group (an automatic one's id and reason). */
function mergeInto(data, inbox, ids, extra = {}) {
  const groups = data.groups || [];
  const touched = groups.filter((g) => g.rooms.some((id) => ids.includes(id)));
  const rooms = [...new Set([...touched.flatMap((g) => g.rooms), ...ids])];
  const g = { ...(touched[0] || extra), id: touched[0]?.id || extra.id || `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, rooms, at: Date.now() };
  // Each chat or old group as it stood in the inbox: still unread if any was, archived or snoozed only if all were
  // away (a reminder on one chat must not hide the other network's messages), back at the earliest reminder.
  // Archived counts as away only while nothing came after it, as in entries().
  const lastOf = (ids) => Math.max(0, ...ids.map((id) => S.rooms.get(id)).filter(Boolean).map((r) => roomModel(r).messages.at(-1)?.origin_server_ts || 0));
  const parts = [...touched.map((x) => [inbox[mergeKey(x)] || {}, lastOf(x.rooms)]),
    ...ids.filter((id) => !touched.some((x) => x.rooms.includes(id))).map((id) => [inbox[id] || {}, lastOf([id])])];
  const states = parts.map(([st]) => st);
  const reminds = states.map((s) => s.remind).filter(Boolean);
  const away = parts.every(([st, last]) => st.remind || (st.done && last <= st.done));
  const state = {
    unread: states.some((s) => s.unread || (s.remind && s.remind <= Date.now())) || null, // a due reminder shows as unread
    remind: away && reminds.length ? Math.min(...reminds) : null,
    done: parts.every(([st, last]) => st.done && last <= st.done) ? Math.max(...states.map((s) => s.done)) : null,
    low: states.every((s) => s.low) || null,
  };
  let next = { ...inbox };
  for (const x of touched) if (x.id !== g.id) next = patchInbox(next, mergeKey(x), Object.fromEntries(ENTRY_FIELDS.map((f) => [f, null])));
  next = patchInbox(next, mergeKey(g), state);
  return { data: { ...data, groups: [...groups.filter((x) => !touched.includes(x)), g] }, inbox: next, g };
}

// Automatic merging (Karchi, 17. 11. 2026: „aby som sa nemusel zaujímať, na ktorej platforme im píšem“): only where
// it is clear who is who. One person's chats are those under the same full name on different networks, the name on
// each network only once, or one person of the people map. A pair Karchi took apart or said „Nie“ to stays apart.
// Every window and device plans the same groups with the same ids, so two of them at once make no second group.

// Slovak and Czech short forms of first names, folded: „Janka Nováková“ may be „Jana Nováková“. Only suggested,
// never merged on its own: Janko and Ján Novák may be son and father.
const SHORT_NAMES = Object.fromEntries(Object.entries({
  jan: 'jano janko honza jenda', jana: 'janka janicka', anna: 'anka anicka', hana: 'hanka', branislav: 'brano branko',
  tereza: 'terka terezka', zuzana: 'zuzka zuza', katarina: 'katka', nikol: 'nikola nikolka', michal: 'miso misko',
  peter: 'peto petko', pavol: 'palo pali palko', jakub: 'kubo kuba kubko', tomas: 'tomi tomo', jozef: 'jozo jozko',
  juraj: 'juro jurko', frantisek: 'fero franta', ladislav: 'laco lacko', vladimir: 'vlado', miroslav: 'miro',
  stanislav: 'stano', radoslav: 'rado', rastislav: 'rasto', lubomir: 'lubo', dusan: 'dusko', marian: 'majo',
  lucia: 'lucka', eva: 'evka', barbora: 'barca', veronika: 'vero veronka', monika: 'monca', ivana: 'ivka ivanka',
  natalia: 'natka', nela: 'nelka', sofia: 'sofka', simona: 'simonka', kristina: 'kristinka', alexandra: 'saska', dominika: 'dominka',
}).flatMap(([name, short]) => short.split(' ').map((x) => [x, name])));

/** A one-to-one chat partner's name as words to match people by: folded (also 𝓯𝓪𝓷𝓬𝔂 letters), without a „(WA)“ tag
 *  or handles with digits, and (`short`) short first names as the full one. [] when the name is a
 *  guess: an initial or a shortened word („Ján N.“, „J.N. Novák“), a placeholder („Facebook user“) or a „st“, „ml“,
 *  „junior“ (father and son share the rest). */
function nameWords(r, short = false) {
  const name = norm((networkName(r, dmPartner(r)[0], false) || '').normalize('NFKC')).replace(/\s*\((wa|ig|fb)\)\s*$/, '');
  if (/[.…]/.test(name)) return [];
  const words = name.split(/\s+/).filter((w) => !/\d/.test(w)).map((w) => w.replace(/[^\p{L}'-]/gu, '')).filter((w) => /\p{L}/u.test(w));
  if (words.some((w) => (w.match(/\p{L}/gu) || []).length < 2 || /^(user|pouzivatel|uzivatel|st|ml|jr|sr|junior|senior|starsi|mladsi|ii|iii)$/.test(w))) return [];
  return [...new Set(words.map((w) => (short && SHORT_NAMES[w]) || w))];
}

const inName = (a, b) => [...a].every((x) => b.has(x));
/** One full name inside the other („Peter Kováč“, „Peter Pavol Kováč“), or a first name alone as a full name's first
 *  or last word („Mia“, „Mia Kováčová“), never a middle name. */
const alikeNames = (a, b) => (a.size >= 2 && b.size >= 2 ? inName(a, b) || inName(b, a)
  : a.size + b.size > 2 && (([one, full]) => one.has([...full][0]) || one.has([...full].at(-1)))(a.size === 1 ? [a, b] : [b, a]));
/** For each chat with name words, the chats of other networks whose names are alike. */
function alikeChats(words) {
  const byWord = new Map();
  for (const [r, w] of words) for (const x of w) byWord.set(x, [...(byWord.get(x) || []), r]);
  const near = new Map();
  for (const [r, w] of words) near.set(r, [...new Set([...w].flatMap((x) => byWord.get(x)))].filter((y) => y !== r && y.app !== r.app && alikeNames(w, words.get(y))));
  return near;
}

let nameMemo = { key: -1 };
/** Each live one-to-one chat's name words, computed again only when chats change. `exact` and `near`: the names as
 *  written, for automatic merging. `likely`: with short first names too, the chats to suggest, each the only such chat
 *  of its network both ways. */
function nameIndex() {
  let key = S.rooms.size;
  for (const r of S.rooms.values()) key += r.version || 0;
  if (nameMemo.key === key) return nameMemo;
  const exact = new Map();
  const loose = new Map();
  for (const r of S.rooms.values()) {
    if (!canMerge(r)) continue;
    const w = nameWords(r);
    if (!w.length) continue;
    exact.set(r, new Set(w));
    loose.set(r, new Set(nameWords(r, true)));
  }
  const near = alikeChats(exact);
  const all = alikeChats(loose);
  const likely = new Map();
  for (const [r, ys] of all) likely.set(r, ys.filter((y) => ys.filter((z) => z.app === y.app).length === 1 && all.get(y).filter((z) => z.app === r.app).length === 1));
  nameMemo = { key, exact, near, likely };
  return nameMemo;
}
const hash36 = (text) => { let x = 2166136261; for (const c of text) x = Math.imul(x ^ c.codePointAt(0), 16777619) >>> 0; return x.toString(36); };

/** The merges automatic merging would make from `data`, in order: [{ id, rooms, add, auto }]. Pure: writes nothing. */
function autoMergePlan(data = mergeData()) {
  const live = [...S.rooms.values()].filter(canMerge);
  const sets = [];
  const oneEach = (list) => list.length > 1 && new Set(list.map((r) => r.app)).size === list.length;
  // Full names: the same one, or one inside the other, and the chat's only such match on every network (two
  // „Peter Novák“ on Messenger make every Peter Novák unclear). A first name alone is never clear.
  const { exact, near } = nameIndex();
  const full = (r) => (exact.get(r)?.size || 0) >= 2;
  const fullNear = (r) => (full(r) ? near.get(r).filter(full) : []);
  const clear = (r) => fullNear(r).length === new Set(fullNear(r).map((y) => y.app)).size;
  for (const r of live) for (const y of fullNear(r)) if (r.id < y.id && clear(r) && clear(y)) sets.push({ why: 'name', rooms: [r, y] });
  const inPeople = new Set();
  for (const person of S.account[FRIENDS]?.people || []) {
    const list = (person.rooms || []).map((id) => S.rooms.get(id)).filter(canMerge);
    if (oneEach(list)) { sets.push({ why: 'people', rooms: list }); for (const r of list) inPeople.add(r.id); }
  }
  // Sets that share a chat are one person; a person with two chats on one network is not clear.
  const comps = [];
  for (const set of sets) {
    const ids = new Set(set.rooms.map((r) => r.id));
    const hit = comps.filter((c) => [...ids].some((id) => c.ids.has(id)));
    const comp = { ids: new Set([...ids, ...hit.flatMap((c) => [...c.ids])]), why: hit.some((c) => c.why === 'people') || set.why === 'people' ? 'people' : 'name' };
    for (const c of hit) comps.splice(comps.indexOf(c), 1);
    comps.push(comp);
  }
  const plan = [];
  let groups = data.groups || [];
  const dismissed = new Set(data.dismissed || []);
  const appOfRoom = (id) => S.rooms.get(id)?.app;
  for (const comp of comps.map((c) => ({ ...c, ids: [...c.ids].sort() })).sort((a, b) => (a.ids[0] < b.ids[0] ? -1 : 1))) {
    if (new Set(comp.ids.map(appOfRoom)).size !== comp.ids.length) continue;
    // „Martin Horák“ is in both „Martin Ján Horák“ and „Martin Peter Horák“, who need not be one person: a chat
    // only a name brought in stays out unless its name is alike with every full name of the person.
    const w = (id) => exact.get(S.rooms.get(id));
    const named = comp.ids.filter((id) => (w(id)?.size || 0) >= 2);
    comp.ids = comp.ids.filter((a) => inPeople.has(a) || !named.some((b) => b !== a && !alikeNames(w(a), w(b))));
    const touched = groups.filter((g) => g.rooms.some((id) => comp.ids.includes(id)));
    if (touched.length > 1) continue;
    const members = [...(touched[0]?.rooms || [])];
    const apps = new Set(members.map(appOfRoom).filter(Boolean));
    const add = [];
    for (const id of comp.ids) {
      if (members.includes(id) || apps.has(appOfRoom(id)) || members.some((m) => dismissed.has(pairKey(m, id)))) continue;
      members.push(id); apps.add(appOfRoom(id)); add.push(id);
    }
    if (!add.length || members.length < 2) continue;
    const g = touched[0] ? { ...touched[0], rooms: members } : { id: `a${hash36(comp.ids.join(' '))}`, rooms: members, auto: comp.why };
    plan.push({ id: g.id, rooms: members, add, auto: touched[0] ? null : comp.why });
    groups = [...groups.filter((x) => x !== touched[0]), g];
  }
  return plan;
}

let autoTimer = 0;
/** After a sync: merge what has become clear, a moment later and once for many syncs. */
function autoMergeSoon() {
  if (!autoTimer && S.homeSynced && mergeData().auto !== false) autoTimer = setTimeout(autoMerge, 2000);
}
function autoMerge() {
  autoTimer = 0;
  if (!S.homeSynced || mergeData().auto === false) return;
  // The chat Karchi is typing in changes under him only after he leaves it (the next sync tries again).
  const typing = document.activeElement?.closest?.('.ccompose') ? S.selected : null;
  const plan = autoMergePlan().filter((x) => !x.rooms.includes(typing));
  if (!plan.length) return;
  let data = mergeData();
  let inbox = inboxState();
  for (const x of plan) ({ data, inbox } = mergeInto(data, inbox, x.rooms, x.auto ? { id: x.id, auto: x.auto } : {}));
  saveMerges(data);
  S.account[INBOX] = inbox;
  saveInboxSoon();
}

/** Takes one chat out of its group, or (`roomId` null) the whole group apart. Each chat that leaves gets the group's
 *  inbox state, and the pair is not suggested again. */
function unmergeChats(g, roomId = null) {
  const data = mergeData();
  const leaving = roomId ? [roomId] : g.rooms;
  const rest = g.rooms.filter((id) => !leaving.includes(id));
  const keep = rest.length > 1;
  const back = keep ? leaving : g.rooms;
  const state = inboxState()[mergeKey(g)] || {};
  const dismissed = new Set(data.dismissed || []);
  for (const a of leaving) for (const b of g.rooms) if (a !== b) dismissed.add(pairKey(a, b));
  saveMerges({ ...data, groups: (data.groups || []).flatMap((x) => (x.id !== g.id ? [x] : keep ? [{ ...x, rooms: rest, via: rest.includes(x.via) ? x.via : null }] : [])), dismissed: [...dismissed] });
  for (const id of back) setChatState(id, Object.fromEntries(ENTRY_FIELDS.map((f) => [f, state[f] ?? null])));
  if (!keep) setChatState(mergeKey(g), Object.fromEntries([...ENTRY_FIELDS, 'held'].map((f) => [f, null])));
}

function saveMerges(next) {
  for (const k of Object.keys(next)) if (next[k] == null) delete next[k];
  putAccount(MERGES, next).catch(() => alert(T('Spojenie chatov sa neuložilo.')));
  render();
}

/** Writes the open merged chat through another of its chats: the draft, files and a reply go along. */
function switchVia(e, to) {
  const from = S.selected;
  if (!e?.merged || !to || to === from) return;
  const text = [S.drafts.get(from), S.drafts.get(to)].filter((x) => x?.trim()).join('\n');
  if (S.editing?.room === from) endEdit();
  deleteDraft(from);
  if (text) setDraft(to, text);
  const files = S.attach.get(from);
  if (files?.length) { S.attach.set(to, [...(S.attach.get(to) || []), ...files]); S.attach.delete(from); }
  if (S.replyTo?.room === from) S.replyTo = null;
  S.selected = to;
  S.focusComposer = true;
  history.replaceState({ thread: to }, '', workspaceUrl(to, S.surface === 'feed'));
  saveMerges({ ...mergeData(), groups: (mergeData().groups || []).map((x) => (x.id === e.merged.id ? { ...x, via: to, viaAt: Date.now() } : x)) });
}
/** Reply or edit a message of another chat of the open merged chat: the composer moves to that chat first. */
function writeIn(r) {
  if (r.id === S.selected || !groupOf(r.id) || groupOf(r.id) !== groupOf(S.selected)) return;
  switchVia(entryOf(r.id), r.id);
}

/** Other chats that are likely the same person as `r` (its group): from the people map, else a matching name on
 *  another network (`nameIndex`), also a first name alone. Merged only by Karchi's click; „Nie“ is remembered. */
let hintMemo = { key: '', hints: [] };
function mergeHints(r) {
  if (!canMerge(r)) return [];
  const g = groupOf(r.id);
  const memoKey = `${r.id}|${S.rooms.size}|${r.version}`;
  if (hintMemo.key === memoKey && hintMemo.data === mergeData() && hintMemo.friends === S.account[FRIENDS]) return hintMemo.hints;
  const mine = new Set(g ? g.rooms : [r.id]);
  const apps = new Set([...mine].map((id) => S.rooms.get(id)?.app));
  const dismissed = new Set(mergeData().dismissed || []);
  const found = new Map();
  const consider = (x) => {
    if (canMerge(x) && !mine.has(x.id) && !apps.has(x.app) && !groupOf(x.id) && ![...mine].some((id) => dismissed.has(pairKey(id, x.id)))) found.set(x.id, x);
  };
  const person = (S.account[FRIENDS]?.people || []).find((p) => p.rooms?.some((id) => mine.has(id)));
  for (const id of person?.rooms || []) consider(S.rooms.get(id));
  const { likely } = nameIndex();
  for (const id of mine) for (const x of likely.get(S.rooms.get(id)) || []) consider(x);
  hintMemo = { key: memoKey, data: mergeData(), friends: S.account[FRIENDS], hints: [...found.values()] };
  return hintMemo.hints;
}
function dismissHint(a, b) {
  const data = mergeData();
  saveMerges({ ...data, dismissed: [...new Set([...(data.dismissed || []), pairKey(a, b)])] });
}

/** „Spojiť s…“: the open one-to-one chat with another one, picked by name. */
function openMergePick(r) {
  if (!canMerge(r)) return;
  openOverlay('merge', { room: r.id });
}
function mergePickView(o) {
  const r = S.rooms.get(o.room);
  const g = groupOf(o.room);
  const mine = new Set(g ? g.rooms : [o.room]);
  const hints = mergeHints(r);
  const words = norm(o.query).split(/\s+/).filter(Boolean);
  const pool = [...hints, ...[...S.rooms.values()].filter((x) => canMerge(x) && !mine.has(x.id) && !hints.includes(x))
    .sort((a, b) => (roomModel(b).messages.at(-1)?.origin_server_ts || 0) - (roomModel(a).messages.at(-1)?.origin_server_ts || 0))];
  const list = pool.filter((x) => words.every((w) => norm(`${roomTitle(x)} ${appOf(x.app)?.name}`).includes(w))).slice(0, 40);
  o.flat = list.map((x) => () => { S.overlay = null; mergeChats([...mine, x.id]); });
  if (o.index >= o.flat.length) o.index = 0;
  return [
    cmdInput(o, T`Spojiť ${g ? T('spojený chat') : roomTitle(r)} s… (meno alebo sieť)`),
    h('div', { class: 'results', ...listScroll(o) }, list.length
      ? list.map((x, i) => resultRow(o, null, i, [avatar(roomAvatar(x), roomTitle(x), 28),
        h('div', { class: 'rmeta' }, h('b', {}, highlighted(roomTitle(x), o.query)), h('small', {}, hints.includes(x) ? T`${appOf(x.app)?.name} · asi ten istý človek` : appOf(x.app)?.name)),
        h('img', { class: 'rnet', src: appOf(x.app)?.icon, alt: '' })]))
      : h('div', { class: 'empty' }, T('Žiadny iný chat s jedným človekom sa nenašiel.'))),
  ];
}

/** „Prezývka…“: Karchi names a chat's person (on each network of a merged chat) or a group as he likes. */
function openNick(e) {
  if (e?.kind !== 'room') return;
  const rooms = e.rooms || [e.room];
  const ids = rooms.map((r) => dmPartner(r)?.[0] || r.id);
  openNickFor(ids, [...new Set(rooms.map((r) => roomTitle(r, false)))].join(' / '));
}
const openNickFor = (ids, was) => openOverlay('nick', { ids, was, query: ids.map(nickOf).find(Boolean) || '' });
function nickView(o) {
  const name = o.query.trim();
  o.flat = [() => { S.overlay = null; saveNick(o.ids, name); }];
  return [
    cmdInput(o, T`Prezývka pre ${o.was}`),
    h('div', { class: 'results', ...listScroll(o) }, h('div', { class: 'empty' }, name
      ? T`Enter: „${name}“ namiesto ${o.was}. Vidíš ju len ty, vo Wefte.`
      : T`Enter s prázdnym poľom vráti meno zo siete: ${o.was}`)),
  ];
}
/** Kept inbox rows, messages and group notes show names: a changed nickname builds them anew. */
const namesChanged = () => { rowMemo.clear(); bubbleMemo.clear(); for (const r of S.rooms.values()) r.model = null; }; // models hold the group notes
function saveNick(ids, name) {
  const next = { ...S.account[NICKS] };
  for (const id of ids) if (name) next[id] = name; else delete next[id];
  putAccount(NICKS, next).catch(() => alert(T('Prezývka sa neuložila.')));
  namesChanged();
  render();
}

/** Every chat as one inbox entry: EduPage threads and bridged rooms alike. */
/** Every chat as an inbox entry, newest first. Old chats only the archive has are in no list, so they are left out
 *  (thousands of them) unless `all` (search, new chat) or one of them is open. A merged person's chats are one
 *  entry, unless `flat` (search lists each chat with its network). */
function entries(all = false, flat = false) {
  const list = chatEntries(all);
  return withState(flat ? list : mergeParts(list, mergeIndex()));
}
/** Search wants both lists: each chat on its own, and the merged people's entries; one pass over the chats. */
function entryLists(all, extra = null) {
  const list = chatEntries(all, extra);
  const groups = mergeIndex();
  return { flat: withState([...list]), merged: groups.size ? withState(mergeParts(list, groups).filter((e) => e.merged)) : [] };
}
// The thousands of old chats only the archive has change only when their history loads: their entries are kept.
const archiveEntries = new WeakMap(); // room model -> { nicks, name, e }
/** `extra`: old chats only the archive has that are wanted anyway (Ctrl+K's recent ones). */
function chatEntries(all, extra = null) {
  const nicks = S.account[NICKS];
  const list = threads().map((t) => ({ key: t.id, kind: 'thread', app: 'edupage', thread: t, title: titleOf(t), last: t.last, count: isUnread(t) ? 1 : 0 }));
  const muted = mutedRooms();
  const off = serversOff();
  for (const r of S.rooms.values()) {
    if (r.archiveOnly && !all && r.id !== S.selected && !extra?.has(r.id)) continue;
    if (!isChat(r) || serverOff(r, off)) continue;
    const m = roomModel(r);
    if (r.archiveOnly) {
      let x = archiveEntries.get(m);
      if (!x || x.nicks !== nicks || x.name !== r.bridgeName || x.e.app !== r.app) {
        const lastMsg = m.messages.at(-1);
        // Nobody writes into them and they are never unread.
        x = { nicks, name: r.bridgeName, e: { key: r.id, kind: 'room', app: r.app, room: r, title: roomTitle(r), lastMsg, last: lastMsg?.origin_server_ts || 0, count: 0 } };
        archiveEntries.set(m, x);
      }
      list.push({ ...x.e });
      continue;
    }
    const lastMsg = m.messages.at(-1);
    list.push({
      key: r.id, kind: 'room', app: r.app, room: r, title: roomTitle(r), lastMsg,
      last: lastMsg?.origin_server_ts || 0,
      count: lastMsg && lastMsg.sender !== S.userId ? roomUnread(r, m, muted) : 0,
    });
  }
  return list;
}
/** A merged person's chats are one entry. */
function mergeParts(list, groups) {
  if (!groups.size) return list;
  const parts = new Map();
  const out = list.filter((e) => {
    const g = e.kind === 'room' && groups.get(e.key);
    if (g) parts.set(g, [...(parts.get(g) || []), e]);
    return !g;
  });
  const down = parts.size ? downApps() : null;
  for (const [g, ps] of parts) out.push(mergedEntry(g, ps, down));
  return out;
}
/** The inbox state of each entry (archived, low, reminder, unread mark), newest first. */
function withState(list) {
  const now = Date.now();
  const batchCutNow = batchWindow(now).cut;
  for (const e of list) {
    const s = entryState(e);
    const due = !!s.remind && s.remind <= now;
    e.low = !!s.low;
    e.work = workTimes().size ? entryWork(e) : false;
    e.remind = s.remind || 0;
    // Karchi wrote while new messages waited (noteHeldReply): once their batch comes the chat is unread again.
    const heldIn = !!s.held && batchCutNow > s.held;
    e.flag = !!s.unread || due || heldIn;
    e.sortTs = Math.max(e.last, due ? s.remind : 0);
    e.unread = e.count > 0 || e.flag;
    // Archived until something new arrives; a reminder keeps the chat away until it is due.
    e.done = !!s.done && e.last <= s.done && !due && !heldIn;
    e.snoozed = !!s.remind && !due;
    e.archived = e.done || e.snoozed;
  }
  return list.sort((a, b) => b.sortTs - a.sortTs);
}

/** Opening a chat reads it: unread marks and a due reminder go away. */
function clearOnOpen(e) {
  const s = entryState(e);
  const heldIn = !!s.held && batchWindow().cut > s.held;
  const due = !!s.remind && s.remind <= Date.now();
  if (s.unread || due || heldIn) setEntryState(e, { unread: null, remind: null, held: heldIn ? null : s.held });
  // A draft stashed with this reminder is what brought the chat back: its list opens with that draft chosen.
  const it = due && entryStash(e).find((x) => x.remind === s.remind); // stashed with this very reminder, not a plain Ctrl+L
  if (it) { S.stashSel = it.id; S.stashOpen = { ...S.stashOpen, [e.key]: true }; render(); }
}

function toggleArchive(e) {
  if (!e || e.room?.archiveOnly) return;
  const archived = e.archived;
  if (!archived && selKey() === e.key) selectAfter(e);
  setEntryState(e, archived ? { done: null, remind: null } : { done: Math.max(Date.now(), e.last), remind: null, held: null });
}

function toggleRead(e) {
  if (!e) return;
  if (e.unread) {
    const held = entryState(e).held;
    setEntryState(e, { unread: null, remind: e.remind && e.remind <= Date.now() ? null : e.remind || null, held: held && batchWindow().cut > held ? null : held });
    if (e.kind === 'room') for (const r of e.rooms || [e.room]) markRoomRead(r, true);
    else saveSeen({ ...S.account[SEEN], [e.key]: e.thread.last });
  } else {
    // An open chat would read itself again at once: close it, as Beeper does.
    if (selKey() === e.key) select(null);
    setChatState(e.key, { unread: true });
  }
}

const toggleLow = (e) => e && setChatState(e.key, { low: !e.low || null });

function remindAt(e, ts) {
  if (!e) return;
  if (ts && selKey() === e.key) selectAfter(e);
  setChatState(e.key, { remind: ts || null });
  S.overlay = null;
  render();
}

/** Reminder choices: [label, timestamp]. */
function remindChoices() {
  const at = (days, hour) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.getTime(); };
  const now = new Date();
  const monday = (8 - now.getDay()) % 7 || 7;
  return [
    [T('O hodinu'), Date.now() + 3600e3],
    now.getHours() < 18 ? [T('Dnes večer'), at(0, 18)] : [T('Zajtra večer'), at(1, 18)],
    [T('Zajtra ráno'), at(1, 8)],
    [T('Budúci týždeň'), at(monday, 8)],
  ];
}

// A reminder that comes due brings its chat back without any other event.
setInterval(() => {
  const st = inboxState();
  const now = Date.now();
  if (cal.today !== Cal.dayNumber(now) || Object.values(st).some((s) => s.remind && s.remind <= now && s.remind > now - 60e3)) refresh();
}, 30e3);

// ------------------------------------------------------------------ actions

async function sendReply(rootId) {
  const text = (S.drafts.get(rootId) || '').trim();
  const files = S.attach.get(rootId) || [];
  if (!text && !files.length) return;
  const txn = `ep${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  // Without text EduPage still gets the files; the message then says what they are.
  const content = { msgtype: 'm.text', body: text || files.map((f) => f.name).join(', '), 'm.relates_to': { 'm.in_reply_to': { event_id: rootId } } };
  S.pending.set(txn, { event_id: txn, pending: true, sender: S.userId, origin_server_ts: Date.now(), content: { ...content, [EDU_FILES]: files.map((f) => ({ name: f.name })) } });
  deleteDraft(rootId);
  S.attach.delete(rootId);
  render();
  try {
    if (files.length) content[EDU_FILES] = await eduUpload(files);
    await call('PUT', `/rooms/${q(S.roomId)}/send/m.room.message/${txn}`, content);
  } catch {
    S.pending.delete(txn);
    setDraft(rootId, text);
    if (files.length) S.attach.set(rootId, files);
    alert(T('Odpoveď sa neodoslala. Skús to znova.'));
    render();
  }
}

/** Online before the first sync, from the kept copy, which may be old: nothing is marked read or seen until sync has
 *  drawn the chat again (offline the marks wait for the connection as before). */
const preview = () => !!S.fromSnapshot && !S.offline;
function markRead() {
  if (preview()) return;
  const cut = eduCut();
  const last = readUpTo(eduTimeline(), cut);
  if (!last || last.event_id === S.readSent || document.visibilityState !== 'visible' || S.offline) return;
  S.readSent = last.event_id;
  call('POST', `/rooms/${q(S.roomId)}/receipt/m.read/${q(last.event_id)}`, {}).catch(() => { S.readSent = ''; });
}
document.addEventListener('visibilitychange', () => S.view === 'main' && render());

let seenTimer;
function saveSeen(next) {
  S.account[SEEN] = next;
  clearTimeout(seenTimer);
  seenTimer = setTimeout(() => putAccount(SEEN, S.account[SEEN]).catch(() => {}), 400);
}

function markSeen(t) {
  if (t && isUnread(t) && document.visibilityState === 'visible') saveSeen({ ...S.account[SEEN], [t.id]: t.last });
}

function select(id) {
  // A merged chat opens on the chat it writes to; when one of its chats is open already, that one stays.
  if (id?.startsWith('merge:')) {
    const g = (mergeData().groups || []).find((x) => mergeKey(x) === id);
    id = g && (groupOf(S.selected) === g ? S.selected : viaRoom(g)?.id) || null;
  }
  if (S.surface === 'feed') feed.leave();
  S.surface = 'calendar';
  if (S.selected === id) { history.replaceState(null, '', workspaceUrl()); render(); return; }
  noteOpened(S.selected); // a chat opened from the page's link was never noted
  S.selected = id;
  noteOpened(id);
  S.replyTo = null;
  S.focusEvent = null;
  S.findQuery = '';
  S.eduNote = null;
  if (id) history.pushState({ thread: id }, '', workspaceUrl(id, false));
  else history.replaceState(null, '', workspaceUrl(null, false));
  render();
  document.querySelector('.detail .eduactions a')?.focus();
}

/** Close the conversation and give its space back to the calendar. */
function closeThread() {
  if (S.surface === 'feed') { feed.leave(); S.surface = 'calendar'; }
  noteOpened(S.selected);
  S.selected = null;
  history.replaceState(null, '', workspaceUrl(null, false));
  render();
}
window.addEventListener('popstate', () => {
  noteOpened(S.selected);
  if (S.surface === 'feed' && !feedFromLocation()) feed.leave();
  S.surface = feedFromLocation() ? 'feed' : 'calendar';
  S.selected = selectedFromHash();
  if (S.surface === 'feed') feed.enter();
  if (S.selected !== S.shownThread) S.focusEvent = null; // a search hit belongs to the chat it opened
  noteOpened(S.selected);
  render();
});

async function setPref(key, value) {
  const next = { ...prefs(), [key]: value };
  S.account[PREFS] = next;
  render();
  await putAccount(PREFS, next).catch(() => alert(T('Nastavenie sa neuložilo.')));
}

async function matrixLogin(user, password) {
  const data = await call('POST', '/login', {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user },
    password,
    initial_device_display_name: 'EduPage web',
  });
  saveSession(data.access_token, data.user_id);
}

async function connectStep(fields) {
  const c = S.connect;
  if (!c) {
    const step = await bridge('POST', '/login/start/password');
    S.connect = { id: step.login_id, step };
    return;
  }
  const { step } = c;
  const next = step.type === 'user_input'
    ? await bridge('POST', `/login/step/${q(c.id)}/${q(step.step_id)}/user_input`, fields)
    : await bridge('POST', `/login/step/${q(c.id)}/${q(step.step_id)}/display_and_wait`);
  if (next.type === 'complete') {
    S.connect = null;
    await refreshLogins();
    show('main');
    return;
  }
  S.connect = { id: c.id, step: next };
}

async function waitConfirm() {
  while (S.connect?.step.type === 'display_and_wait' && S.view === 'connect') {
    try {
      await connectStep();
    } catch (err) {
      S.connect = null;
      S.error = err.message;
    }
    render();
  }
}

async function edupageLogout() {
  const login = S.logins[0];
  if (!login || !confirm(T('Odhlásiť EduPage? Správy ostanú, nové prestanú chodiť.'))) return;
  await bridge('POST', `/logout/${q(login.id)}`).catch(() => undefined);
  await refreshLogins();
  show(S.logins.length ? 'main' : 'connect');
}

// ------------------------------------------------------------------ view

// Every view function builds a fresh tree with h(); render() then patches the live DOM to match it, so only what
// changed is touched and scroll, focus, caret, playing videos and hovered elements stay. Handlers go through one
// listener per type that calls the newest handler (`_on`), so a kept element runs the closures of the latest render.
// A captured element inside a handler is therefore the newly built one, which may be thrown away: look elements up
// from the event (e.currentTarget, closest) instead. `data-key` (or `data-event`) pairs children across renders.
const dispatch = function (e) { const f = this._on?.[e.type]; return f ? f.call(this, e) : undefined; };
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  el._h = true;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) { (el._on ||= {})[k.slice(2)] = v; el.addEventListener(k.slice(2), dispatch); }
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') { el[k] = v; (el._props ||= {})[k] = v; }
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c);
  return el;
}

/** Marks a tree render() replaces whole instead of patching: views that keep elements in variables or wire them
 *  by hand (panels, overlays, connection forms). */
const opaque = (el) => { if (el && typeof el === 'object') el._opaque = true; return el; };
const keyOf = (n) => n._key ?? (n.nodeType === 1 ? n.getAttribute('data-key') ?? n.getAttribute('data-event') : null);
const sameKeys = (a, b) => {
  if (!a || !b) return !a === !b;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b);
};
const morphable = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName && !a._opaque && !b._opaque && a._id === b._id
  && keyOf(a) === keyOf(b) && (a.nodeType !== 1 || (a.namespaceURI === b.namespaceURI && !a._h === !b._h && sameKeys(a._props, b._props)));
/** Makes the live element `a` look and act like the newly built `b`. */
function morphInto(a, b) {
  if (a.nodeType !== 1) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
  const aa = a.attributes;
  // A message box keeps the height autosize() gave it.
  for (let i = aa.length - 1; i >= 0; i--) if (!b.hasAttribute(aa[i].name) && !(a._sized != null && aa[i].name === 'style')) a.removeAttribute(aa[i].name);
  for (const { name, value } of b.attributes) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  if (b._on) for (const t in b._on) a.addEventListener(t, dispatch);
  a._on = b._on;
  patchChildren(a, [...b.childNodes]);
  // Properties without an attribute (a field's value, checked) after the children: a <select> needs its options.
  if (b._props) for (const k in b._props) if (!b.hasAttribute(k) && a[k] !== b._props[k]) a[k] = b._props[k];
  a._props = b._props;
  b._live?.(a);
}
/** Stands for a kept element that is on screen: building the new tree must not take it out of the live one. */
let refsOut = 0;
const ref = (el) => { const m = document.createComment(''); m._ref = el; refsOut++; return m; };
/** A new subtree going in whole: its stand-ins become the kept elements. */
function resolveRefs(root) {
  if (!refsOut || root.nodeType !== 1) return;
  const found = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  while (walk.nextNode()) if (walk.currentNode._ref) found.push(walk.currentNode);
  for (const m of found) { m.replaceWith(m._ref); refsOut--; }
}
/** Gives `parent` exactly the children `kids`, keeping every live child that can become its new counterpart. */
function patchChildren(parent, kids) {
  kids = kids.map((n) => { if (n._ref) { refsOut--; return n._ref; } return n; });
  const old = [...parent.childNodes];
  if (!kids.length) { if (old.length) parent.textContent = ''; return; }
  const keyed = new Map();
  const unkeyed = [];
  for (const c of old) { const k = keyOf(c); if (k == null) unkeyed.push(c); else if (!keyed.has(k)) keyed.set(k, c); }
  const used = new Set();
  const final = [];
  let u = 0;
  for (const n of kids) {
    if (n.parentNode === parent && !used.has(n)) { used.add(n); final.push(n); continue; } // the same live node again
    const k = keyOf(n);
    let c;
    if (k != null) c = keyed.get(k);
    else { while (u < unkeyed.length && used.has(unkeyed[u])) u++; c = unkeyed[u]; }
    if (c && !used.has(c) && morphable(c, n)) { used.add(c); if (k == null) u++; morphInto(c, n); final.push(c); } else { resolveRefs(n); final.push(n); }
  }
  for (const c of old) if (!used.has(c)) c.remove();
  let cur = parent.firstChild;
  for (const n of final) { if (n === cur) cur = cur.nextSibling; else parent.insertBefore(n, cur); }
}

/** Text with http(s) links made clickable; never parsed as HTML. */
/** Links made clickable; `find` underlines its words, for the message a search result opened. */
function linkified(text, find = '') {
  const plain = (part) => (find ? highlighted(part, find, 'found') : part);
  const out = [];
  let at = 0;
  // The sentence's closing punctuation after a link stays text (links.js: trimLink).
  for (const m of String(text).matchAll(LINK_RE)) {
    const url = trimLink(m[0]);
    if (m.index > at) out.push(plain(text.slice(at, m.index)));
    out.push(h('a', { href: url, target: '_blank', rel: 'noreferrer', onclick: (e) => e.stopPropagation() }, url));
    at = m.index + url.length;
  }
  if (at < text.length) out.push(plain(text.slice(at)));
  return out;
}
/** The search words to underline in a message: only in the one a search result opened. */
const findIn = (ev) => (S.findQuery && ev?.event_id === S.focusEvent ? S.findQuery : '');

/** EduPage's announcement types, each with its own name and mark, as edupage.org tells them apart. */
const EDU_KINDS = {
  signin: [T('Prihlasovanie'), 'clipboard-note'], znamka: [T('Známka'), 'star'], event: [T('Udalosť'), 'calendar'], homework: [T('Domáca úloha'), 'book-open'],
  student_absent: [T('Chýbanie'), 'square-alert'], ospravedlnenka: [T('Ospravedlnenka')], testpridelenie: ['Test', 'pencil'],
  testvysledok: [T('Výsledok testu'), 'pencil'], contest: [T('Súťaž')], payments: [T('Platby')], strava_kredit: [T('Kredit v jedálni')],
  strava_vydaj: [T('Výdaj obeda')], stravamenu: [T('Jedálny lístok')], pipnutie: [T('Príchod a odchod')], lost: [T('Stratené veci')], genotif: [T('Oznam školy')],
  substitution: [T('Suplovanie'), 'arrows-horizontal'], confirmation: [T('Potvrdenie prečítania'), 'check'],
};
/** Marks Karchi can give a type of notice in Settings → EduPage. */
const EDU_ICONS = { star: 'star', calendar: 'calendar', book: 'book-open', pencil: 'pencil', signin: 'clipboard-note', absence: 'square-alert', bell: 'bell', envelope: 'mail', swap: 'arrows-horizontal', check: 'check', flag: 'flag', coin: 'coins' };
// What a type does before Karchi says otherwise: substitution notices only say "a new one is up" for the whole school,
// and the things he is graded or tested on wear their subject's colour, as their lessons do in the calendar.
const KIND_DEFAULTS = { substitution: { show: 'hidden' }, znamka: { color: 'subject' }, homework: { color: 'subject' }, testvysledok: { color: 'subject' } };
// Types the bridge posts only when Karchi wants them (account data sk.karchi.edupage.prefs): hiding one stops it there.
const MADE_BY_PREF = { pipnutie: 'arrivals', strava_vydaj: 'meals' };
const eduRules = () => S.account[RULES] || {};
const eduFacts = () => S.account[FACTS] || null;
function kindRule(kind) {
  const rule = { show: 'inbox', color: '', icon: '', ...KIND_DEFAULTS[kind], ...eduRules().kinds?.[kind] };
  if (MADE_BY_PREF[kind] && !prefs()[MADE_BY_PREF[kind]]) rule.show = 'hidden';
  return rule;
}
const subjectInfo = (id) => eduFacts()?.subjects?.find((s) => s.id === id) || S.account[GRADES]?.subjects?.find((s) => s.id === id) || null;
/** Whether a subject is Karchi's: his own word, else what EduPage's data says (the bridge's facts); unknown shows. */
function subjectMine(id) {
  const said = eduRules().subjects?.[id];
  if (typeof said === 'boolean') return said;
  return subjectInfo(id)?.mine !== false;
}
const noticeFact = (ev) => (ev.content[MARK] ? eduFacts()?.items?.[String(ev.content[MARK])] : null);
/** How a school notice shows: 'inbox', 'quiet' (there, never unread) or 'hidden'; messages always show. */
function noticeShow(ev) {
  const c = ev.content;
  if (c.msgtype !== 'm.notice' || !c[MARK]) return 'inbox';
  const show = kindRule(c['sk.karchi.edupage.kind'] || '').show;
  if (show === 'hidden') return show;
  const fact = noticeFact(ev);
  if (fact?.others && !eduRules().others) return 'hidden';
  if (fact?.subject && !subjectMine(fact.subject)) return 'hidden';
  return show;
}
let subjectPaint = { sig: '', map: new Map() };
/** A subject's colour as its lessons wear it in the calendar's EduPage timetable; one of Kalendarix's second colours
 *  by its name when it has no lesson there. */
function subjectColor(id) {
  const name = subjectInfo(id)?.name;
  if (!name) return '';
  const tt = cal.doc?.calendars?.find((c) => c.id === TIMETABLE_CAL);
  const sig = tt ? `${tt.events?.length}|${tt.customColor}|${tt.color}|${tt.category}|${JSON.stringify(tt.accents || {})}` : '';
  if (sig !== subjectPaint.sig) subjectPaint = { sig, map: Cal.subjectColors(cal.doc, TIMETABLE_CAL) };
  const key = Cal.titleKey(name);
  return subjectPaint.map.get(key) || Cal.ACCENT_PALETTE[hue(key) % Cal.ACCENT_PALETTE.length];
}
/** A notice's colour and mark by its type's rule; '' colour keeps the type's own from app.css. */
function noticeLook(ev) {
  const kind = ev.content['sk.karchi.edupage.kind'] || '';
  const rule = kindRule(kind);
  const subject = noticeFact(ev)?.subject;
  const color = rule.color === 'subject' ? (subject ? subjectColor(subject) : '') : Cal.isHexColor(rule.color) ? rule.color : '';
  return { color, mark: EDU_ICONS[rule.icon] || EDU_KINDS[kind]?.[1] };
}
const kindOf = (t) => (t.root.content.msgtype === 'm.notice' ? t.root.content['sk.karchi.edupage.kind'] || '' : '');
const titleOf = (t) => {
  const { root } = t;
  const to = root.content[TO_KEY];
  const label = EDU_KINDS[kindOf(t)]?.[0];
  if (label) return nameOf(root.sender) === 'EduPage' ? label : `${label} · ${nameOf(root.sender)}`;
  return root.content.msgtype === 'm.notice' || !to ? nameOf(root.sender) : `${nameOf(root.sender)} → ${to}`;
};
const iconOf = (t) => {
  const notice = t.root.content.msgtype === 'm.notice';
  const kind = kindOf(t);
  const look = notice ? noticeLook(t.root) : {};
  return kindIcon(kind, look, notice);
};
/** The round mark of a notice type, in its colour (`look` from noticeLook, or a rule being set). */
function kindIcon(kind, look, notice = true) {
  return h('div', {
    class: `icon${notice ? ' notice' : ''}${kind ? ` k-${kind}` : ''}${look.color ? ' custom' : ''}`, title: EDU_KINDS[kind]?.[0] || null,
    style: look.color ? { background: look.color, color: Cal.textOn(look.color) } : null,
  }, icon(look.mark || (notice ? 'bell' : 'mail')));
}

const firstName = (name) => String(name).split(/\s+/)[0];
const hue = (text) => [...String(text)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
const initialsOf = (name) => String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0].toUpperCase()).join('') || '?';
/** Round picture of a chat or person: their avatar, or initials on a color of their own. */
function avatar(mxc, name, size, cls = 'av') {
  return mediaInPlace(mxc, size > 48 ? 96 : 64, (url) => h('img', { class: cls, src: url, alt: '' }),
    () => h('div', { class: `${cls} initials`, style: { background: `hsl(${hue(name)} 45% 64%)` } }, initialsOf(name)), true);
}
function entryAvatar(e) {
  const app = APPS.find((a) => a.id === e.app);
  return h('div', { class: 'avwrap' },
    e.kind === 'thread' ? iconOf(e.thread) : avatar(roomAvatar(e.rooms?.find(roomAvatar) || e.room), e.title, 40),
    app ? h('img', { class: 'badge', src: app.icon, alt: app.name }) : null);
}
/** The unsent text of an entry; a merged chat's is in whichever of its chats it was written. */
const entryDraft = (e) => (e.rooms ? e.rooms.map((r) => draftOf(r.id)).find((d) => d.trim()) || '' : draftOf(e.key));
/** What is stashed for an entry (a merged chat: for any of its networks). */
const entryStash = (e) => (e.kind === 'thread' ? [] : stashFor(e.rooms ? e.rooms.map((r) => r.id) : [e.key]));
/** The files waiting in an entry's message box (a relayed answer's picture with no text is a draft too). */
const entryFiles = (e) => (e.rooms || [{ id: e.key }]).flatMap((r) => S.attach.get(r.id) || []);
function entryPreview(e) {
  const draft = entryDraft(e).trim();
  if (draft) return [h('em', { class: 'draftmark' }, T('Koncept: ')), draft.replace(/\s+/g, ' ')];
  const files = entryFiles(e);
  if (files.length) return [h('em', { class: 'draftmark' }, T('Koncept: ')), files.map((f) => f.name).join(', ')];
  if (e.kind === 'thread') {
    const t = e.thread;
    const last = t.replies.at(-1);
    const text = (last ? `${nameOf(last.sender)}: ${bodyOf(last)}` : bodyOf(t.root)).replace(/\s+/g, ' ');
    return [t.replies.length ? h('em', {}, `${t.replies.length + 1} `) : null, text];
  }
  const rooms = e.rooms || (e.room ? [e.room] : []);
  if (e.kind === 'room' && rooms.some((x) => typingIn(x).length)) return h('em', { class: 'typingmark' }, T('píše…'));
  const r = e.lastRoom || e.room;
  const ev = e.lastMsg;
  if (!ev) return '';
  const m = roomModel(r);
  if (ev.sender === S.userId && (ev.failed || m.failed.has(ev.event_id))) return [h('em', { class: 'failmark' }, T('Neodoslané: ')), messageSummary(m, ev)];
  const who = ev.sender === S.userId ? T('Ty: ') : dmPartner(r) ? '' : `${firstName(memberName(r, ev.sender))}: `;
  return who + messageSummary(m, ev);
}

/** A long press on a touch screen opens the same menu as a right click. `e` is the entry, or a function giving
 *  the current one. */
function longPress(e) {
  let timer;
  let fired = false;
  return {
    ontouchstart: (ev) => {
      fired = false;
      const t = ev.touches[0];
      timer = setTimeout(() => { fired = true; openMenu({ clientX: t.clientX, clientY: t.clientY }, typeof e === 'function' ? e() : e); }, 500);
    },
    ontouchmove: () => clearTimeout(timer),
    ontouchend: (ev) => { clearTimeout(timer); if (fired) ev.preventDefault(); },
  };
}

// Rows of the inbox are kept and handed out again while nothing they show changed, so a render touches only the
// rows that did. A kept row's handlers read the newest entry from `_e`.
const rowMemo = new Map(); // entry key -> { sig, el }
function rowSig(e, today) {
  const r = e.room;
  const t = e.thread;
  return [today, entryDraft(e), entryFiles(e).map((f) => f.name).join(), entryStash(e).length, e.unread, e.count, e.sortTs, e.remind, e.flag, e.title, e.work, selKey() === e.key, e.app, e.lastMsg?.event_id, e.lastMsg?.pending, e.apps?.join(),
    // A row out of sight misses its picture arriving in place: whether it has arrived is part of what it shows.
    // The batch cut too: an edit held for the batch changes the preview when the batch comes, with no new version.
    ...(e.rooms || (r ? [r] : [])).map((r) => `${r.version}|${roomCut(r)}|${typingIn(r).length}|${workVer}|${r.pending.size}|${roomAvatar(r)}|${mediaReady(`${roomAvatar(r)}|64`)}`),
    t ? `${t.replies.length}|${t.last}|${t.replies.at(-1)?.event_id}|${t.root.content.msgtype === 'm.notice' ? Object.values(noticeLook(t.root)).join() : ''}` : ''].join('\u0001');
}
function itemRow(e, today) {
  const sig = rowSig(e, today);
  const hit = rowMemo.get(e.key);
  if (hit?.sig === sig) { hit.el._e = e; return hit.el.isConnected ? ref(hit.el) : hit.el; }
  if (rowMemo.size > 3000) rowMemo.clear();
  const el = itemView(e);
  el._e = e;
  const memo = { sig, el };
  // Patched into the row already on screen, that one is what is kept.
  el._live = (live) => { if (rowMemo.get(e.key) === memo) { memo.el = live; live._e = e; } };
  rowMemo.set(e.key, memo);
  return el;
}

/** One row of the inbox on the left. */
function itemView(e) {
  const now = (el) => el._e || e;
  return h('button', {
    class: `item${e.unread ? ' unread' : ''}${selKey() === e.key ? ' sel' : ''}${entryDraft(e).trim() ? ' has-draft' : ''}${personChat(e) ? ' person' : ''}`,
    'data-key': e.key,
    // The picture of a person's chat opens the chat with their profile beside it.
    onclick: (ev) => { const x = now(ev.currentTarget); select(x.key); if (ev.target.closest('.avwrap') && personChat(x)) openProfile(x); },
    oncontextmenu: (ev) => openMenu(ev, now(ev.currentTarget)),
    ...longPress(() => rowMemo.get(e.key)?.el._e || e),
  },
  entryAvatar(e),
  h('div', { class: 'meta' },
    h('div', { class: 'who' }, h('span', {}, e.title),
      e.apps ? h('span', { class: 'nets', title: e.apps.map((a) => appOf(a)?.name).join(', ') }, e.apps.map((a) => h('img', { src: appOf(a)?.icon, alt: appOf(a)?.name }))) : null,
      e.work ? h('i', { class: 'work', title: T('Práca: čo napíše, sa ukáže hneď') }, T('práca')) : null,
      entryStash(e).length ? h('i', { class: 'stashmark', title: T('Odložené koncepty: otvor chat, Ctrl+S ich ukáže') }, T`odložené ${entryStash(e).length}`) : null,
      isAnnouncements(e.room) ? h('i', { class: 'annmark', title: T('Oznamový kanál na Discorde') }, T('oznamy')) : null,
      // avoid-ai-design-ignore: I2 — existing reminder symbol in the inbox.
      e.remind && !e.flag ? h('i', { class: 'rem', title: T`Pripomenie sa ${dayLabel(e.remind)} ${timeLabel(e.remind)}` }, icon('alarm-clock')) : null,
      h('time', {}, e.sortTs ? listDate(e.sortTs) : '')),
    h('div', { class: 'prev' }, h('span', {}, entryPreview(e)),
      e.count > 1 ? h('b', { class: 'count' }, e.count > 99 ? '99+' : String(e.count)) : e.unread ? h('b', { class: 'dot' }) : null)));
}

/** School-provided actions open on EduPage; viewing a notice never submits a decision. */
function eduActions(ev) {
  const actions = ev.content['sk.karchi.edupage.actions'];
  if (!Array.isArray(actions)) return null;
  const safe = actions.filter((a) => {
    if (!a || typeof a.label !== 'string' || !a.label.trim() || typeof a.url !== 'string') return false;
    try {
      const url = new URL(a.url);
      return url.protocol === 'https:' && /^[a-z0-9-]+\.edupage\.org$/.test(url.host) && !url.username && !url.password;
    } catch { return false; }
  });
  return safe.length ? h('div', { class: 'eduactions' },
    safe.map((a) => h('a', { class: 'primary', 'data-edu-action': `${ev.event_id}|${a.url}`, href: a.url, target: '_blank', rel: 'noopener noreferrer' }, a.label)),
    h('small', {}, T('Otvorí formulár na EduPage.'))) : null;
}

/** Files pinned to an EduPage homework: pictures show whole width, a tap opens them in the viewer. */
function eduFiles(ev) {
  const files = ev.content[EDU_FILES];
  if (!Array.isArray(files) || !files.length) return null;
  const pictures = eduPictures(ev);
  return h('div', { class: 'edufiles' }, files.map((f, i) => {
    if (typeof f?.url !== 'string') return f?.name ? h('span', { class: 'mfile' }, icon('file'), f.name) : null; // still uploading
    const picture = pictures.find((p) => p.event_id === `${ev.event_id}#${i}`);
    if (!picture) return h('button', { class: 'mfile', onclick: () => download(f.url, f.name) }, icon('file'), f.name || T('Súbor'));
    return h('button', {
      class: 'mimg', title: f.name || '', style: f.w && f.h ? { aspectRatio: `${f.w} / ${f.h}` } : {},
      onclick: () => openOverlay('image', { edu: ev.event_id, event: picture.event_id, zoom: 1, x: 0, y: 0 }),
    }, mediaInPlace(f.url, 0, (url) => h('img', { src: url, alt: f.name || '' }), () => h('span', { class: 'mwait' })));
  }));
}

const eduTime = (stamp) => { const d = new Date(String(stamp).replace(' ', 'T')); return Number.isNaN(+d) ? null : d; };
const eduWhen = (d) => `${d.getDate()}. ${d.getMonth() + 1}. ${timeLabel(+d)}`;
/** A sign-up: what it is, until when it is open and what Karchi chose; signing happens on EduPage. */
function signinCard(ev) {
  const s = ev.content[EDU_SIGNIN];
  if (!s || typeof s !== 'object') return null;
  const from = eduTime(s.from);
  const to = eduTime(s.to);
  const chosen = Array.isArray(s.chosen) ? s.chosen.filter((x) => typeof x === 'string') : [];
  const confirmed = eduTime(s.confirmed);
  const now = Date.now();
  const state = to && +to < now ? ['over', T('Skončené')] : from && +from > now ? ['soon', T('Ešte sa nezačalo')] : ['open', T('Otvorené')];
  const link = bodyOf(ev).match(/https:\/\/[a-z0-9-]+\.edupage\.org\/signin\/\S*/)?.[0];
  return h('div', { class: 'signin' },
    h('b', { class: 'sname' }, s.name || T('Prihlasovanie')),
    s.type ? h('small', {}, s.type) : null,
    h('dl', {},
      from || to ? [h('dt', {}, h('span', { class: `sstate ${state[0]}` }, state[1])), h('dd', {}, `${from ? eduWhen(from) : ''} – ${to ? eduWhen(to) : ''}`)] : null,
      [h('dt', {}, T('Tvoja voľba')), h('dd', {}, chosen.length ? [h('b', {}, chosen.join(', ')), confirmed ? ` · ${eduWhen(confirmed)}` : ''] : T('zatiaľ žiadna'))]),
    link ? h('div', { class: 'eduactions' },
      h('a', { class: 'primary', href: link, target: '_blank', rel: 'noopener noreferrer' }, chosen.length ? T('Zmeniť na EduPage') : T('Prihlásiť sa na EduPage')),
      h('small', {}, T('Prihlasuje sa na EduPage.'))) : null);
}

/** The open thread on the right: whole first message, every reply, and the reply box. */
function detailView(t) {
  if (!t) return h('div', { class: 'detail', 'data-scroll': 'detail' }, h('div', { class: 'empty' }, T('Vyber správu vľavo.')));
  const { root } = t;
  const notice = root.content.msgtype === 'm.notice';
  const to = root.content[TO_KEY];
  return h('div', { class: 'detail', 'data-scroll': 'detail' },
    h('div', { class: 'paper' },
      h('div', { class: 'dhead' },
        h('button', { class: 'back', title: T('Späť'), onclick: closeThread }, '‹'),
        iconOf(t),
        h('div', {}, h('b', {}, titleOf(t)), h('small', {}, `${dayLabel(root.origin_server_ts)} ${timeLabel(root.origin_server_ts)}`))),
      h('div', { class: 'text' },
        notice ? null : [h('b', {}, nameOf(root.sender)), to ? [' → ', h('b', {}, to)] : null, ': '],
        signinCard(root) || linkified(bodyOf(root), findIn(root)), eduFiles(root), eduActions(root)),
      h('div', { class: 'replies' }, t.replies.map((r) => {
        const bot = r.content[MARK] === 0;
        const color = mix(colorOf(r.sender), 0.5);
        return h('div', {
          class: `reply${bot ? ' bot' : ''}${r.pending ? ' pending' : ''}`,
          style: bot ? {} : { background: mix(colorOf(r.sender), 0.85) },
        },
        bot ? null : h('div', { class: 'sq', style: { background: color, color: textOn(color) } }, initials(r.sender)),
        h('div', { class: 'rt' }, bot ? null : [h('b', {}, nameOf(r.sender)), ': '], linkified(bodyOf(r), findIn(r)), eduFiles(r), eduActions(r)),
        h('div', { class: 'rd' }, r.pending ? 'odosielam' : `${shortDate(r.origin_server_ts)} ${timeLabel(r.origin_server_ts)}`));
      })),
      notice ? null : composeView(t.id)));
}

function composeView(rootId) {
  const draft = S.drafts.get(rootId) || '';
  const files = S.attach.get(rootId) || [];
  const area = h('textarea', {
    rows: 3,
    value: draft,
    placeholder: T('Napíš odpoveď… (Enter odošle, Shift+Enter nový riadok)'),
    'data-root': rootId,
    oninput: (e) => {
      setDraft(rootId, e.target.value);
      renderSoon();
      const send = e.target.closest('.compose')?.querySelector('button.primary');
      if (send) send.disabled = !e.target.value.trim() && !(S.attach.get(rootId) || []).length;
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(rootId); }
    },
  });
  const send = h('button', { class: 'primary', disabled: !draft.trim() && !files.length, onclick: () => sendReply(rootId) }, T('Odoslať'));
  return h('div', { class: 'compose' }, eduNote(rootId), eduAtts(rootId), area, h('div', {}, eduAttachButton(), send));
}

/** Files waiting to go with an EduPage message, under the key of its thread or new message. */
const eduAtts = (key) => {
  const files = S.attach.get(key) || [];
  return files.length ? h('div', { class: 'atts' }, files.map((f) => h('div', { class: `att${f.type.startsWith('image/') ? ' pic' : ''}`, title: `${f.name} · ${fileSize(f.size)}` },
    f.type.startsWith('image/') ? h('img', { src: localUrl(f), alt: f.name }) : [h('b', {}, f.name), h('small', {}, fileSize(f.size))],
    h('button', { class: 'attx', title: T('Odobrať'), onclick: () => dropAttachment({ id: key }, f) }, icon('close'))))) : null;
};
const eduAttachButton = () => [
  h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { const files = [...e.target.files]; e.target.value = ''; takeFiles(files); } }),
  h('button', { class: 'ghost attachfile', title: T('Pridať prílohu (aj Ctrl+V alebo pretiahnutím)'), onclick: (e) => e.currentTarget.previousSibling.click() }, icon('plus'), T('Príloha')),
];
/** Uploads the waiting files; the bridge hands them to EduPage with the message. */
async function eduUpload(files) {
  return Promise.all(files.map(async (file) => {
    const c = await fileContent(file);
    return { name: file.name, url: c.url, mimetype: c.info.mimetype, size: file.size, ...(c.info.w ? { w: c.info.w, h: c.info.h } : {}) };
  }));
}
const EDU_MAX_FILE = 25 * 1024 * 1024;

// ------------------------------------------------------------------ inbox, panels, shortcuts

/** Apps that can feed the inbox; each chat belongs to one. */
const APPS = [
  { id: 'edupage', name: 'EduPage', icon: '/edupage.png' },
  { id: 'messenger', name: 'Messenger', icon: '/messenger.ico' },
  { id: 'instagram', name: 'Instagram', icon: '/instagram.png' },
  { id: 'discord', name: 'Discord', icon: '/discord.png' },
  { id: 'whatsapp', name: 'WhatsApp', icon: '/whatsapp.webp' },
  { id: 'teams', name: 'Teams', icon: '/teams.png' },
  { id: 'gmail', name: 'Gmail', icon: '/gmail.ico' },
  { id: 'outlook', name: 'Outlook', icon: '/outlook.png' },
  { id: 'hermes', name: 'Hermes', icon: '/hermes.svg' },
];
const hiddenApps = () => new Set(JSON.parse(localStorage.getItem('ep_hidden_apps') || '[]'));
function toggleApp(id) {
  const hidden = hiddenApps();
  if (hidden.has(id)) hidden.delete(id);
  else hidden.add(id);
  localStorage.setItem('ep_hidden_apps', JSON.stringify([...hidden]));
  render();
}

function setShowAll(on) {
  S.showAll = on;
  localStorage.setItem('ep_show_all', on ? '1' : '0');
  render();
}

/** Opens a floating panel ('grades' or 'settings'), or closes it when it is already open. */
function togglePanel(name, tab) {
  if (S.panel === 'link') cancelLink();
  if (tab) S.setTab = tab; // the settings section to open on
  S.panel = S.panel === name && !tab ? null : name; // a section asked for opens, never closes
  S.menu = false;
  S.overlay = null;
  if (S.panel === 'settings') { refreshLinks(); if (S.links.discord?.length) loadDiscordServers(); }
  render();
  // With a mouse the cursor waits in the search; on a phone that would pop the keyboard over the map.
  if (S.panel === 'people' && matchMedia('(pointer: fine)').matches) pm.input?.focus();
}

const BOXES = [
  ['inbox', 'Inbox', (e) => !e.archived && !e.low],
  ['archive', T('Archív'), (e) => e.done],
  ['reminders', T('Pripomienky'), (e) => e.remind > 0],
  ['low', T('Nízka priorita'), (e) => e.low && !e.archived],
];
const inBox = (box) => BOXES.find(([id]) => id === box)?.[2] || BOXES[0][2];
function setBox(box) {
  S.box = box;
  S.menu = false;
  render();
}

/** The chats the list shows: one of the views, and in the inbox only unread ones unless Ctrl+Shift+S. */
function visibleEntries(list = entries()) {
  const hidden = hiddenApps();
  // Conversations that exist only in the archive (no bridge room) are in no list: Ctrl+K finds them.
  const mine = list.filter((e) => !hidden.has(e.app) && !e.room?.archiveOnly);
  const pool = mine.filter(inBox(S.box));
  // As in Beeper, a chat leaves the unread list as soon as it is read, even while it stays open.
  const shown = S.showAll || S.box !== 'inbox' ? pool : pool.filter((e) => e.unread || !!entryDraft(e).trim() || entryStash(e).length > 0);
  return { mine, pool, shown };
}
const entryOf = (key) => key && entries(!!S.rooms.get(key)?.archiveOnly).find((e) => e.key === keyOfRoom(key));
const selectedEntry = () => entryOf(S.selected);

/** After archiving or snoozing the open chat, the next one opens, as in Beeper. */
// A read chat has already left `shown`, so its place in `pool` (same order) decides what is next.
function selectAfter(e) {
  const { pool, shown } = visibleEntries();
  const at = pool.findIndex((x) => x.key === e.key);
  const rest = shown.filter((x) => x.key !== e.key);
  const next = rest.find((x) => pool.indexOf(x) > at) || rest.findLast((x) => pool.indexOf(x) < at);
  select(next ? next.key : null);
}

function moveSelection(step) {
  const { pool, shown } = visibleEntries();
  if (!shown.length) return;
  const i = shown.findIndex((x) => x.key === selKey());
  if (i >= 0) return select(shown[(i + step + shown.length) % shown.length].key);
  const at = pool.findIndex((x) => x.key === selKey());
  const next = step > 0 ? shown.find((x) => pool.indexOf(x) > at) || shown[0] : shown.findLast((x) => pool.indexOf(x) < at) || shown.at(-1);
  select(next.key);
}

function nextUnread() {
  const { pool } = visibleEntries();
  const unread = pool.filter((e) => e.unread && e.key !== selKey());
  const i = pool.findIndex((x) => x.key === selKey());
  const next = unread.find((e) => pool.indexOf(e) > i) || unread[0];
  if (next) select(next.key);
}

function archiveAllRead() {
  const read = visibleEntries().pool.filter((e) => !e.unread);
  if (!read.length) return;
  const all = { ...inboxState() };
  const now = Date.now();
  for (const e of read) all[e.key] = { ...all[e.key], done: Math.max(now, e.last) };
  S.account[INBOX] = all;
  if (read.some((e) => e.key === selKey())) select(null);
  putAccount(INBOX, all).catch(() => alert(T('Zmena sa neuložila.')));
  render();
}

function replyToLast() {
  const open = S.rooms.get(S.selected);
  if (!open || open.archiveOnly) return;
  const t = timelineOf(open);
  const ev = t.msgs.findLast((x) => x.sender !== S.userId && !x.pending && !isRedacted(roomModel(t.roomOf(x)), x));
  if (!ev) return;
  // Never an older message instead: the newest one is from a Discord thread, and Weft cannot answer there.
  if (inDiscordThread(t.roomOf(ev), ev.event_id)) return alert(threadNote());
  const r = t.roomOf(ev);
  writeIn(r); // a merged chat answers through the chat the message came in
  S.replyTo = { room: r.id, event: ev.event_id };
  S.focusComposer = true;
  render();
}

function openMenu(ev, e) {
  ev.preventDefault?.();
  ev.stopPropagation?.();
  if (!e) return;
  S.menu = false;
  S.overlay = { kind: 'menu', key: e.key, x: ev.clientX, y: ev.clientY };
  render();
}
// Every scrolling list stays where Karchi left it when the window is drawn again (the mouse picking a row, a setting
// changed, a sync): render() keeps the place of each element with a data-scroll key. Typing a new query starts at the
// top again (cmdInput), the keyboard's choice is brought into sight (overlayMark).
const listScroll = (o) => ({ 'data-scroll': `list:${o.kind}` });
// A list that opens under a resting mouse ignores it until it really moves, so the keyboard keeps the choice.
// The browser also sends mouse events when the list is redrawn under the cursor; those carry the same position.
let pointerAt = null;
document.addEventListener('mousemove', (e) => { pointerAt = { x: e.screenX, y: e.screenY }; }, true);
function pointerMoved(o, ev) {
  if (o.mouse) return true;
  if (!o.from) { o.from = { x: ev.screenX, y: ev.screenY }; return false; }
  return (o.mouse = ev.screenX !== o.from.x || ev.screenY !== o.from.y);
}
const openOverlay = (kind, extra = {}) => {
  if (S.panel === 'link') cancelLink();
  remoteDrop(S.overlay);
  S.panel = null;
  S.menu = false;
  S.overlay = { kind, query: '', index: 0, from: pointerAt, ...extra };
  render();
};
/** Ctrl+K lays its overlay over the window as it is: rebuilding the whole window first made it open slowly. */
function openSearch() {
  const root = document.getElementById('app');
  if (S.view !== 'main' || S.panel || S.overlay || S.menu || !root.querySelector(':scope > .shell')) return openOverlay('search');
  const was = document.activeElement;
  S.overlay = { kind: 'search', query: '', index: 0, from: pointerAt, was, wasRoot: was?.dataset?.root };
  root.append(overlayView());
  root.querySelector(':scope > .veil .cmdinput')?.focus({ preventScroll: true });
  // The words of every message are gathered while Karchi starts typing, not on his first letter.
  const o = S.overlay;
  (globalThis.requestIdleCallback || setTimeout)(() => { if (S.overlay === o && !o.query) void searchBase(o).items; }, { timeout: 400 });
}
/** Ctrl+J opens above whatever is open (the map, grades, an image): Esc goes back to it, and to the message box. */
function openTools() {
  S.menu = false;
  const was = document.activeElement;
  const composer = !!was?.closest?.('.ccompose');
  // Ctrl+K's field and this one share a data-root: keep where its cursor was, or render would carry this one's over.
  const caret = was?.dataset?.root === '__overlay' && S.overlay ? [was.selectionStart, was.selectionEnd] : null;
  S.overlay = { kind: 'tools', query: '', index: 0, from: pointerAt, back: S.overlay, composer, was, caret };
  render();
}
/** Esc or a click beside an overlay: Ctrl+J's goes back to what was under it. */
/** `back`: Esc, which first steps Ctrl+N's network mode back to Karchi's own people (the field keeps the cursor and
 *  what is typed); a click beside the overlay closes it whole. */
function closeOverlay(back = false) {
  const o = S.overlay;
  if (o?.kind === 'new' && o.remote) {
    remoteDrop(o);
    if (back) { o.remote = null; o.index = 0; render(); return; }
  }
  if (o?.kind === 'new' && o.group && back) {
    if (o.group.state !== 'creating') { Object.assign(o, { group: null, query: '', index: 0 }); render(); }
    return; // Esc while the group is being made waits for its answer
  }
  // Ctrl+K's overlay goes as it came, the window under it stays; the cursor returns where it was.
  const veil = o?.kind === 'search' && !S.panel && document.querySelector('#app > .veil.search');
  if (veil) {
    S.overlay = null;
    searchRest = null;
    veil.remove();
    // A sync may have rebuilt the window meanwhile: then the same field is found again by its data-root.
    const back = o.was?.isConnected ? o.was : o.wasRoot && document.querySelector(`[data-root="${CSS.escape(o.wasRoot)}"]`);
    if (back && back !== document.body) back.focus({ preventScroll: true });
    return;
  }
  if (o?.gallery && gal) { S.overlay = { kind: 'gallery' }; render(); galDraw(true); return; } // back to the grid, same place
  if (o?.kind === 'gallery') return closeGallery();
  if (o?.kind === 'emoji' && !o.react) Object.assign(S, { focusComposer: true, caret: o.at }); // the cursor goes back
  if (o?.kind === 'tools' && o.composer && !o.back && !S.panel) S.focusComposer = true;
  S.overlay = o?.kind === 'tools' ? o.back || null : null;
  render();
  if (o?.kind === 'whocard' && o.was?.isConnected) o.was.focus({ preventScroll: true }); // the keys go back to the picture
  // Back on the map, the cursor is in its search again; back in Ctrl+K, where it was in its text.
  if (o?.kind === 'tools' && !o.back && o.was?.isConnected && !o.composer) o.was.focus();
  if (o?.kind === 'tools' && o.caret) try { document.querySelector('[data-root="__overlay"]')?.setSelectionRange(...o.caret); } catch { /* not a text field */ }
}
function openRemind(e) {
  if (e) openOverlay('remind', { key: e.key });
}
function openNewChat() {
  openOverlay('new', { contacts: [] });
  loadContacts(S.overlay);
}

// Ctrl+K search, Ctrl+Shift+K or Ctrl+N new chat, Ctrl+E archive, Ctrl+Shift+U read/unread,
// Ctrl+L remind, Ctrl+U next unread, Ctrl+R reply, Ctrl+Shift+A voice message, Ctrl+Shift+S unread/all, Ctrl+, settings,
// Ctrl+Shift+F daily feed, Ctrl+G grades (Tab switches its view), Ctrl+M people map, Ctrl+D calendar, Ctrl+J any tool by name, Ctrl+/ all shortcuts, Esc steps back,
// Ctrl+P the chat's photos and videos, Ctrl+Shift+Space plays or pauses a voice message.
document.addEventListener('keydown', (e) => {
  if (S.view !== 'main') return;
  const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
  const key = e.key.toLowerCase();
  const typing = /^(input|textarea|select)$/i.test(document.activeElement?.tagName || '');
  const run = (fn) => { e.preventDefault(); fn(); };
  // A list reached from the menu has the keyboard: Esc hands it back to the message box.
  if (key === 'escape' && membersPop) return run(() => { const had = membersPop.el.contains(document.activeElement); shutMembers(); if (had) { S.focusComposer = true; render(); } });
  // Ctrl+P: the chat's gallery (printing means nothing in Weft); again, from the viewer too, closes it.
  if (mod && !e.shiftKey && key === 'p') return run(() => (gal ? closeGallery() : openGallery(S.rooms.get(S.selected))));
  if (S.overlay?.kind === 'gallery' && galleryKey(e)) return;
  if (S.overlay?.kind === 'image' && viewerKey(e)) return;
  // Ctrl+S: the message box to the stash, or an empty box takes from it. Never the browser's „save page“.
  if (mod && !e.shiftKey && key === 's') return run(() => { if (S.overlay?.kind === 'stashask') S.overlay.flat?.[0](); else if (!S.overlay && !S.panel && !e.isComposing) stashShortcut(); });
  // Ctrl+Shift+Space: the voice message in hand plays or pauses, else the open chat's first unheard one starts.
  if (mod && e.shiftKey && e.code === 'Space') return run(voiceShortcut);
  // While a voice message records, Enter sends it and Esc throws it away.
  if (rec && !S.overlay && !S.panel && (key === 'enter' || key === 'escape')) return run(() => stopRecording(key === 'enter'));
  // A Gmail code in the corner: Enter copies it while nothing else has the keyboard.
  if (key === 'enter' && codeKey(e, key)) return;
  if (mod && ((e.shiftKey && key === 'k') || (!e.shiftKey && key === 'n'))) run(openNewChat);
  else if (mod && !e.shiftKey && key === 'k') run(() => (S.overlay?.kind === 'search' ? closeOverlay() : openSearch()));
  else if (mod && e.shiftKey && key === 's') run(() => setShowAll(!S.showAll));
  else if (mod && !e.shiftKey && key === ',') run(() => togglePanel('settings'));
  else if (mod && !e.shiftKey && key === 'g') run(() => togglePanel('grades'));
  else if (mod && !e.shiftKey && key === 'm') run(() => togglePanel('people'));
  else if (mod && e.shiftKey && key === 'f') run(showFeed);
  else if (mod && !e.shiftKey && key === 'd') run(toggleCalendar);
  else if (mod && !e.shiftKey && key === 'j') run(() => (S.overlay?.kind === 'tools' ? closeOverlay() : openTools()));
  else if (mod && (key === '/' || key === '?')) run(() => (S.overlay?.kind === 'help' ? (S.overlay = null, render()) : openOverlay('help')));
  else if (key === 'tab' && S.panel === 'grades' && !mod) run(() => setGradeMode(S.gradeMode === 'table' ? 'recent' : 'table'));
  else if (key === 'escape' && S.overlay) run(() => closeOverlay(true));
  else if (key === 'escape' && S.surface === 'feed' && !S.panel) run(closeFeed);
  else if (key === 'escape' && S.panel === 'link') run(cancelLink);
  else if (key === 'escape' && S.panel === 'people' && pm.naming) run(() => setNaming(false));
  else if (key === 'escape' && S.panel === 'people' && (pm.sel || pm.query)) run(clearPeople);
  else if (key === 'escape' && (!S.panel || S.panel === 'calendar') && cal.edit) run(() => { cal.edit = null; render(); });
  else if (key === 'escape' && (S.panel || S.menu)) run(() => { S.panel = null; S.menu = false; render(); });
  else if ((S.panel === 'calendar' || (!S.panel && document.activeElement?.closest('.home-calendar'))) && !typing && !mod && !e.altKey && calendarKey(e)) e.preventDefault();
  else if (S.overlay || S.panel) return;
  else if (mod && !e.shiftKey && key === 'e') run(() => toggleArchive(selectedEntry()));
  else if (mod && e.shiftKey && key === 'e') run(archiveAllRead);
  else if (mod && e.shiftKey && key === 'u') run(() => toggleRead(selectedEntry()));
  else if (mod && !e.shiftKey && key === 'u') run(nextUnread);
  else if (mod && !e.shiftKey && key === 'l') run(() => openRemind(selectedEntry()));
  else if (mod && !e.shiftKey && key === 'r') run(replyToLast);
  else if (mod && e.shiftKey && key === 'a') run(toggleRecording);
  else if (e.ctrlKey && key === 'tab') run(() => moveSelection(e.shiftKey ? -1 : 1));
  // By key position, not the character: on a Slovak keyboard the number row gives + ľ š č ť ž ý á í.
  else if (e.ctrlKey && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) run(() => { const t = visibleEntries().shown[Number(e.code.slice(5)) - 1]; if (t) select(t.key); });
  else if (e.ctrlKey && !e.altKey && !e.shiftKey && key === 'arrowdown' && document.querySelector('[data-scroll=chat]')) run(chatToNew);
  else if (e.ctrlKey && e.altKey && key === 'arrowleft') run(() => history.back());
  else if (e.ctrlKey && e.altKey && key === 'arrowright') run(() => history.forward());
  else if (key === 'escape' && S.editing) run(endEdit);
  else if (key === 'escape' && S.replyTo) run(() => { S.replyTo = null; render(); });
  else if (key === 'escape' && typing) run(() => document.activeElement.blur());
  else if (key === 'escape' && ringing.list.length) run(() => { const it = ringing.list.at(-1); stopRing((x) => x === it); render(); });
  else if (key === 'escape' && activeCode()) run(() => dismissCode(activeCode()));
  else if (key === 'escape' && S.selected) run(() => select(null));
  else if (key === 'escape' && S.box !== 'inbox') run(() => setBox('inbox'));
  else if (!typing && !mod && !e.altKey && e.key.length === 1 && S.rooms.has(S.selected) && !(e.key === ' ' && document.activeElement?.matches('button, [role=slider]'))) {
    // Typing anywhere goes into the open chat's message box; Space on a focused button presses it.
    document.querySelector('.ccompose textarea')?.focus();
  }
});

// In the narrow window the inbox is a sideways strip: the mouse wheel moves along it.
document.addEventListener('wheel', (e) => {
  const strip = e.target.closest?.('.sidelist');
  if (!strip || Math.abs(e.deltaX) >= Math.abs(e.deltaY) || getComputedStyle(strip).flexDirection !== 'row') return;
  e.preventDefault();
  strip.scrollLeft += e.deltaY;
}, { passive: false });

const fileSize = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);

/** Updates and offline status stay with inbox controls instead of a separate header. */
function workspaceStatus() {
  return h('div', { class: 'workspace-status' },
    S.offline ? h('small', { role: 'status' }, 'Offline') : null,
    S.updateAvailable ? h('button', { class: 'update-app', onclick: () => { if (!updates.apply()) alert(T('Pred aktualizáciou dokonči rozpísanú správu, odober prílohy a zavri otvorený editor alebo prihlásenie.')); } }, T('Aktualizovať Weft')) : null);
}

/** Inbox filter, search and settings; new chat on touch screens. */
function sideHead() {
  const hidden = hiddenApps();
  return h('div', { class: 'sidehead' },
    // The open view and its filter on the left, as Beeper's "Inbox / Unread"; a click opens the menu.
    h('button', { class: 'boxname', title: T('Zobrazenie'), onclick: (e) => { e.stopPropagation(); S.menu = !S.menu; render(); } },
      h('b', {}, BOXES.find(([id]) => id === S.box)[1]),
      h('small', {}, S.box === 'inbox' && !S.showAll ? T('Neprečítané') : T('Všetky'),
        hidden.size ? T` · bez ${APPS.filter((a) => hidden.has(a.id)).map((a) => a.name).join(', ')}` : '',
        batchWindow().until ? T` · otvorené do ${timeLabel(batchWindow().until)}` : batchWindow().next ? T` · ďalšie o ${timeLabel(batchWindow().next)}` : '')),
    // Messages that wait come in with one click, never by themselves; no count, so nothing draws the eye.
    batchPrefs().mode !== 'live' ? windowButton() : null,
    h('button', { class: 'filter', title: T('Hľadať (Ctrl+K)'), onclick: () => openSearch() }, icon('search')),
    // New chat is Ctrl+Shift+K on a keyboard; the button is there only for touch screens.
    h('button', { class: 'filter', title: T('Nastavenia (Ctrl+,)'), 'aria-label': T('Nastavenia'), onclick: () => togglePanel('settings') }, icon('sliders')),
    h('button', { class: 'filter touchonly', title: T('Nová správa'), onclick: openNewChat }, icon('pencil')),
    S.menu ? h('div', { class: 'menu', onclick: (e) => e.stopPropagation() },
      BOXES.map(([id, label]) => h('button', { class: 'mi', onclick: () => setBox(id) }, h('span', { class: 'check' }, S.box === id ? '✓' : ''), label)),
      h('hr'),
      APPS.map((app) => h('button', { class: 'mi', onclick: () => toggleApp(app.id) },
        h('span', { class: 'check' }, hidden.has(app.id) ? '' : '✓'),
        h('img', { src: app.icon, alt: '' }), app.name)),
      h('hr'),
      h('button', { class: 'mi', onclick: () => setShowAll(!S.showAll) }, h('span', { class: 'check' }, S.showAll ? '' : '✓'), T('Len neprečítané'), h('kbd', {}, 'Ctrl+Shift+S')),
      h('button', { class: 'mi', onclick: () => togglePanel('grades') }, h('span', { class: 'check' }), T('Známky'), h('kbd', {}, 'Ctrl+G')),
      h('button', { class: 'mi', onclick: () => togglePanel('people') }, h('span', { class: 'check' }), T('Ľudia'), h('kbd', {}, 'Ctrl+M')),
      h('button', { class: 'mi', onclick: toggleCalendar }, h('span', { class: 'check' }), T('Kalendár'), h('kbd', {}, 'Ctrl+D')),
      h('button', { class: 'mi', onclick: () => { location.href = '/automatizacie/'; } }, h('span', { class: 'check' }), T('Automatizácie')),
      h('button', { class: 'mi', onclick: () => togglePanel('settings') }, h('span', { class: 'check' }), T('Nastavenia'), h('kbd', {}, 'Ctrl+,')),
      h('button', { class: 'mi', onclick: openTools }, h('span', { class: 'check' }), T('Všetky nástroje'), h('kbd', {}, 'Ctrl+J'))) : null);
}
document.addEventListener('click', () => { if (S.menu) { S.menu = false; render(); } });

/** Accounts that lost their connection: { id, name, icon, app, out }. out: the login to sign in again ({} when the
 *  network's login is gone), null while the bridge reconnects by itself. */
function downAccounts() {
  const down = [];
  const edu = S.logins[0];
  if (edu && edu.state?.state_event && !['CONNECTED', 'CONNECTING'].includes(edu.state.state_event)) down.push({ id: 'edupage', name: 'EduPage', icon: '/edupage.png', out: null });
  for (const app of LINKS) {
    const logins = S.links[app.id];
    const broken = logins?.some((l) => l.state?.state_event && !['CONNECTED', 'CONNECTING', 'BACKFILLING'].includes(l.state.state_event));
    // A network whose login is gone while its chats stay in the list gets no new messages: say so, as Beeper does.
    const orphaned = logins?.length === 0 && [...S.rooms.values()].some((r) => r.app === app.id);
    const out = orphaned ? {} : logins?.find(signedOut) || null;
    // One of several accounts (Gmail) is named: the others may work.
    const name = app.multi && out?.name ? `${app.name} ${out.name}` : app.name;
    if (orphaned || broken || out) down.push({ id: app.id, name, icon: app.icon, app, out });
  }
  return down;
}

/** A bar on top of the list for each account that lost its connection, like Beeper's; a click opens settings. A
 *  signed-out one says so and signs in again from the bar. Hiding a bar holds until the account breaks another way. */
const downKey = (d) => `${d.id}:${d.out ? `out:${d.out.id ?? ''}` : 'down'}`;
function disconnectedBanners() {
  const key = downKey;
  return downAccounts().filter((d) => !S.dismissed?.has(key(d))).map((d) => h('div', { class: 'banner', 'data-key': key(d), onclick: () => togglePanel('settings', 'accounts') },
    h('img', { src: d.icon, alt: '' }), h('span', {}, d.out ? T`${d.name} je odhlásený` : T`${d.name} je odpojený`),
    d.out ? h('button', { class: 'again', title: T('Služba toto prihlásenie ukončila. Prihlás sa znova; správy ostanú.'),
      onclick: (e) => { e.stopPropagation(); signInAgain(d.app, d.out.id ? d.out : null); } }, T('Znova prihlásiť')) : null,
    h('button', { title: T('Skryť'), onclick: (e) => { e.stopPropagation(); (S.dismissed ||= new Set()).add(key(d)); render(); } }, icon('close'))));
}

/** Once per opened chat, before it reads itself: where its unread messages start (the "Nové správy" line), and
 *  render() opens the chat there. More unread than loaded: older pages come (at most 6) until the start shows. */
function findNewStart(open) {
  if (S.newFor !== open.key) {
    S.newFor = open.key;
    // A merged chat: the line goes above the oldest new message of any of its chats.
    const at = (nf) => S.rooms.get(nf.room)?.events.get(nf.event)?.origin_server_ts ?? Infinity;
    S.newFrom = (open.counts || [[open.room, open.count]]).filter(([, n]) => n > 0)
      .map(([r, n]) => ({ ...firstNew(r, n, r.receipts.get(S.userId)), pages: 0, version: r.version }))
      .sort((a, b) => at(a) - at(b))[0] || null;
    S.scrollNew = true;
    S.onLine = false;
  }
  const nf = S.newFrom;
  if (!nf?.short) return;
  const r = S.rooms.get(nf.room);
  if (!r) return;
  if (nf.version !== r.version) {
    const next = firstNew(r, nf.count, nf.receipt);
    // The last allowed page came without the start: the line stays at the oldest message and loading stops for good.
    S.newFrom = { ...next, short: next.short && nf.pages + 1 < 6, pages: nf.pages + 1, version: r.version };
    // Found or given up, once: the chat moves to the line, unless search brought Karchi to a message.
    if (!S.newFrom.short && !S.focusEvent) S.scrollNew = true;
  }
  if (S.newFrom.short && !r.loading) setTimeout(() => loadRoomHistory(r));
}

function mainView() {
  let list = entries();
  let open = list.find((e) => e.key === selKey()) || null;
  if (open?.kind !== 'room') S.newFor = null;
  // The new-messages line and the read marks wait for the first sync (the kept copy may be old).
  if (open && !preview()) {
    if (open.kind === 'room') findNewStart(open);
    if (open.kind === 'thread') markSeen(open.thread);
    else for (const r of open.rooms || [open.room]) markRoomRead(r);
    setTimeout(() => clearOnOpen(open));
    // Reading it changes the list: the chat leaves Unread on this same render, not on the next sync.
    if (open.unread) {
      list = entries();
      open = list.find((e) => e.key === open.key) || open;
    }
  }
  const { mine, pool, shown } = visibleEntries(list);
  sideLast = { shown, pool };
  const quiet = eduQuiet();
  const unread = mine.filter((e) => e.unread && inBox('inbox')(e) && !(quiet && e.app === 'edupage')).length;
  document.title = unread ? `(${unread}) Weft` : 'Weft';
  scheduleBatch();
  const pendingRoom = !open && (S.selected?.startsWith('!') || (S.selected && S.selected === S.justSent));
  const newEdu = S.selected?.startsWith('edu:') ? S.selected.slice(4) : null;
  const message = open?.kind === 'room' ? chatView(open.room, open)
    : S.selected === MAIL ? mailView()
    : newEdu ? newEduView(newEdu)
      : pendingRoom ? h('div', { class: 'detail' }, h('div', { class: 'empty' }, T('Otváram chat…')))
        : open ? detailView(open.thread) : null;
  // An open conversation takes the whole workspace; the calendar fills it only when nothing is open. The feed
  // (Ctrl+Shift+F) still opens beside a conversation, so its draft stays where it is.
  const home = !message || S.surface === 'feed';
  return [
    h('div', { class: `shell${message ? ' has-sel' : ''}` },
      h('div', { class: 'side' }, sideHead(), workspaceStatus(), nowPlaying(), h('div', { class: 'sidelist', 'data-scroll': 'side', onscroll: sideScrolled }, sideItems())),
      h('div', { class: `workarea${message && home ? ' has-chat' : ''}` },
        // Keyed by the open chat: another chat starts from a fresh pane (its own scroll), the same one is patched.
        message ? h('section', { class: 'workspace-message', 'aria-label': T('Otvorená správa'), 'data-key': `open:${open?.key || S.selected}` }, message) : null,
        home ? homeView() : null)),
    opaque(S.panel === 'grades' ? panel(gradesView()) : null),
    opaque(S.panel === 'settings' ? panel(settingsView()) : null),
    opaque(S.panel === 'people' ? panel(peopleView(), 'wide') : null),
    opaque(S.panel === 'calendar' ? panel(calendarView(), 'wide') : null),
    opaque(S.panel === 'link' ? panel(linkView()) : null),
    opaque(S.panel === 'profile' ? panel(profileView()) : null),
    opaque(overlayView()),
    codeView(),
    ringView(),
  ];
}

// The inbox draws only the rows in sight (and some around them); spacers stand for the rest, so a list of
// hundreds of chats costs as much as one screen of them. Scrolling redraws only the list.
let sideLast = { shown: [], pool: [] };
let sideRowH = 0; // measured height of one row
const SIDE_ALL = 60; // a list this short is drawn whole
function sideRange(n) {
  const list = document.querySelector('.sidelist');
  if (n <= SIDE_ALL) return [0, n];
  const rowH = sideRowH || 56;
  if (!list?.isConnected || !list.clientHeight) return [0, Math.min(n, 30)];
  const top = list.querySelector(':scope > [data-key="__top"]');
  const y0 = top ? top.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop : 0;
  const span = Math.ceil(list.clientHeight / rowH) + 30;
  // The scroll may belong to a longer list (another folder, a filter): the window never starts past the end.
  const from = Math.min(Math.max(0, Math.floor((list.scrollTop - y0) / rowH) - 10), Math.max(0, n - span));
  return [from, Math.min(n, from + span)];
}
function sideItems() {
  const { shown, pool } = sideLast;
  const [from, to] = sideRange(shown.length);
  const rowH = sideRowH || 56;
  const items = [...(S.offline ? [offlineBanner()] : disconnectedBanners())];
  if (shown.length > SIDE_ALL) items.push(h('div', { 'data-key': '__top', 'aria-hidden': 'true', style: { height: `${from * rowH}px` } }));
  const today = new Date().toDateString(); // the rows' dates read "today" or "yesterday"
  items.push(...shown.slice(from, to).map((e) => itemRow(e, today)));
  if (shown.length > SIDE_ALL) items.push(h('div', { 'data-key': '__end', 'aria-hidden': 'true', style: { height: `${(shown.length - to) * rowH}px` } }));
  if (!(S.roomId && S.historyDone) && !shown.length) {
    items.push(h('div', { class: 'empty' }, T('Sťahujem správy…')));
  } else if (!pool.length) {
    items.push(h('div', { class: 'empty' }, S.box === 'inbox' ? T('Zatiaľ žiadne správy.') : T('Nič tu nie je.')));
  }
  sideDrawn = [from, to];
  return items;
}
let sideDrawn = [0, 0];
let sideFrame = 0;
// A list that grows (a bigger window, the list shown again) or rows that change height (the font arriving)
// would show the spacers: measure again and draw what came into sight.
let sideWatched = null;
function sideRemeasure() {
  const list = sideWatched;
  if (!list?.isConnected) return;
  sideRowH = list.querySelector(':scope > .item')?.offsetHeight || sideRowH;
  sideScrolled({ currentTarget: list }, true);
}
const sideResize = new ResizeObserver(sideRemeasure);
document.fonts?.ready.then(sideRemeasure);
function sideWatch(root) {
  const list = root.querySelector('.sidelist');
  if (list === sideWatched) return;
  if (sideWatched) sideResize.disconnect();
  sideWatched = list;
  if (list) sideResize.observe(list);
}
/** Scrolling the inbox past the drawn rows draws the ones coming into sight, without a full render. */
function sideScrolled(e, always = false) {
  const list = e.currentTarget;
  if (sideFrame || sideLast.shown.length <= SIDE_ALL) return;
  sideFrame = requestAnimationFrame(() => {
    sideFrame = 0;
    if (!list.isConnected) return;
    const rowH = sideRowH || 56;
    const top = list.querySelector(':scope > [data-key="__top"]');
    const y0 = top ? top.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop : 0;
    const first = (list.scrollTop - y0) / rowH;
    const last = first + list.clientHeight / rowH;
    const [from, to] = sideDrawn;
    if (always || (from > 0 && first < from + 3) || (to < sideLast.shown.length && last > to - 3)) patchChildren(list, sideItems());
  });
}

// ------------------------------------------------------------------ open chat

function bubbleBody(r, m, ev) {
  if (isRedacted(m, ev)) return h('i', { class: 'gone' }, T('Správa bola odstránená'));
  const c = contentOf(m, ev);
  let caption = c.filename && c.body && c.body !== c.filename ? h('div', { class: 'caption' }, linkified(c.body)) : null;
  const size = (info, most = 320) => {
    const w = Math.min(info?.w || most, most);
    const hgt = info?.w && info?.h ? Math.round(w * info.h / info.w) : 200;
    return { width: `${w}px`, height: `${Math.min(hgt, 420)}px` };
  };
  const several = ev.pending ? [] : carouselOf(ev, c);
  const view = ev.pending ? null : () => openViewer(r, (several.find((it) => it.content.url === c.url) || several[0])?.event_id || ev.event_id);
  // A post shared from Instagram or Facebook comes as its media with the post's address and caption: the media, then
  // the post's card. A reel or story is its video alone; its address shows only when Karchi forwards it (Preposlať).
  // The address itself is not repeated; only words beside it stay as the caption.
  const shared = typeof c.external_url === 'string' && !sharedVideo(c) ? linkCards(r, ev, c, c.external_url) : null;
  if (shareLink(c) && caption) {
    const words = sharedWords(c.body);
    caption = words ? h('div', { class: 'caption' }, linkified(words)) : null;
  }
  if (c.msgtype === 'm.image' && c['com.beeper.unresolved_media'] && r.app === 'instagram') {
    const state = reelState.get(ev.event_id);
    reelContent.set(ev.event_id, c['com.beeper.unresolved_media']);
    return [h('button', { class: 'mimg video', style: size(c.info), 'data-reel': state ? null : ev.event_id,
      onclick: ev.pending ? null : (e) => { e.stopPropagation(); if (state !== 'busy') fetchReel(ev.event_id); } },
    mediaInPlace(c.url, 480, (url) => h('img', { src: url, alt: '' }), () => h('span', { class: 'mwait' })),
    h('span', { class: 'play' }, icon('play', 48)),
    h('span', { class: 'reelstate' }, state === 'failed' ? T('Video sa nestiahlo · skúsiť znova') : T('Sťahujem video…'))), caption, shared];
  }
  if (ev.type === 'm.sticker' || c.msgtype === 'm.image') {
    // A thumbnail of a GIF stands still: GIFs show whole.
    const picture = (url) => h('img', { src: url, alt: c.body || '' });
    return [h('button', { class: 'mimg', style: size(c.info, ev.type === 'm.sticker' ? 180 : 320), onclick: view },
      c.local ? picture(c.local) : mediaInPlace(c.url, c.info?.mimetype === 'image/gif' ? 0 : 480, picture, () => h('span', { class: 'mwait' }))),
    carouselStrip(r, ev, c), caption, shared];
  }
  if (c.msgtype === 'm.video' && (c.info?.['fi.mau.gif'] || c.info?.['fi.mau.loop'])) {
    const url = media(c.url);
    const thumb = media(c.info?.thumbnail_url, 480);
    return [h('button', { class: 'mimg gifv', style: size(c.info), onclick: view },
      url ? gifVideo(ev.event_id, url) : thumb ? h('img', { src: thumb, alt: '' }) : null), carouselStrip(r, ev, c), caption, shared];
  }
  if (c.msgtype === 'm.video') {
    const thumb = media(c.info?.thumbnail_url, 480);
    // WhatsApp sends videos without a thumbnail: one up to 25 MB is fetched and shows its own early frame.
    const still = !c.info?.thumbnail_url && (c.info?.size || 0) <= 25e6 ? media(c.url) : '';
    return [h('button', { class: 'mimg video', style: size(c.info), onclick: view },
      thumb ? h('img', { src: thumb, alt: '' }) : still ? videoStill(ev.event_id, still) : null,
      h('span', { class: 'play' }, icon('play', 48))), carouselStrip(r, ev, c), caption, shared];
  }
  const poll = pollIn(ev, c);
  if (poll) return pollView(r, m, ev, poll);
  const call = callOf(ev);
  if (call) {
    const mine = ev.sender === S.userId; // Karchi called and nobody answered: not his missed call
    return h('div', { class: `mcall${call.state === 'missed' && !mine ? ' missed' : ''}` }, call.video ? icon('video') : icon('phone'), callLabel(call, mine));
  }
  if (c.msgtype === 'm.audio') return [voiceView(r, ev, c), caption];
  if (c.msgtype === 'm.file') {
    return [h('button', { class: 'mfile', onclick: c.url ? () => download(c.url, c.filename || c.body) : null }, icon('file'), `${c.filename || c.body || T('Súbor')}${sizeNote(c.info?.size)}`), caption];
  }
  let text = String(c.body || '').replace(/^(> .*\n)+\n/, '');
  // An old message's attachments (the archive keeps them, or fetches them from Discord when asked): their
  // "[Súbor] name" lines become the files themselves.
  const files = ev.archiveFiles || [];
  // "[Súbor] name" from Discord, a bare "[Fotka]" from an export.
  if (files.length) text = text.split('\n').filter((line) => !files.some((f) => [`[${ARCHIVE_KINDS[f.kind] || T('Súbor')}] ${f.name}`, `[${ARCHIVE_KINDS[f.kind] || T('Súbor')}]`].includes(line.trim()))).join('\n').trim();
  // Mentions come as pills in formatted_body; the body may name them otherwise (Instagram: @username).
  const said = !files.length && c.format === 'org.matrix.custom.html' && typeof c.formatted_body === 'string' ? mentionParts(c.formatted_body) : null;
  // Its photos and videos show as the homeserver's do; the viewer pages through them with the chat's other ones.
  const pictures = ev.pending ? [] : archiveMedia(ev);
  return [text ? h('div', { class: 'mtext' }, c.msgtype === 'm.emote' ? `* ${memberName(r, ev.sender)} ` : null, said ? mentionText(said, findIn(ev)) : linkified(text, findIn(ev))) : null,
    files.map((f) => {
      const it = pictures.find((x) => x.file === f);
      if (!it) return h('button', { class: 'mfile', onclick: () => archiveDownload(f) }, icon('file'), `${f.name}${sizeNote(f.size)}`);
      const video = it.content.msgtype === 'm.video';
      return h('button', { class: `mimg${video ? ' video' : ''}`, style: size(it.content.info), title: f.name, onclick: () => openViewer(r, it.event_id) },
        mediaInPlace(it.content.url, f.mime === 'image/gif' ? 0 : 480, (url) => h('img', { src: url, alt: video ? '' : f.name }), () => h('span', { class: 'mwait' })),
        video ? h('span', { class: 'play' }, icon('play', 48)) : null);
    }),
    linkCards(r, ev, c, text)];
}

// ------------------------------------------------------------------ shared links

/* Under a message, each link it carries (at most three) as a card: what the bridge said about it at once, then what
 * the reader on asus found (server/links/links.py). A card is asked for when it comes into sight, never for history
 * nobody looks at. The text and its link stay as they were above the card. */
const linkReader = createLinkReader({
  request: (url) => call('GET', `/resolve?url=${q(url)}`, undefined, '/_links', AbortSignal.timeout(30000)),
  changed: (url) => { for (const id of linkEvents.get(url) || []) linkVer.set(id, (linkVer.get(id) || 0) + 1); renderSoon(); },
});
const linkEvents = new Map(); // url -> event ids whose bubble shows it
const linkVer = new Map(); // event id -> how often its cards changed (part of the bubble's memo)
const linkOpen = new Set(); // `${event}|${url}` whose description is shown whole
const linkPics = new Map(); // preview image url -> blob url, '' while loading or when it failed
let linkSight = null;

function linkPic(url, id) {
  if (!linkPics.has(url)) {
    linkPics.set(url, '');
    fetch(`/_links/image?url=${q(url)}`, { headers: { Authorization: `Bearer ${S.token}` }, signal: AbortSignal.timeout(20000) })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => { if (blob) { linkPics.set(url, URL.createObjectURL(blob)); linkVer.set(id, (linkVer.get(id) || 0) + 1); renderSoon(); } })
      .catch(() => {});
  }
  return linkPics.get(url);
}

function linkCards(r, ev, c, text) {
  if (ev.pending) return null;
  const links = linksIn(text);
  if (!links.length) return null;
  const bridge = fromBridge(c, links);
  return links.map((url) => {
    (linkEvents.get(url) || linkEvents.set(url, new Set()).get(url)).add(ev.event_id);
    const read = linkReader.get(url);
    const held = read === undefined && !readsItself(url, r.app);
    const k = linkCard(url, bridge.get(url), held ? HELD : read && read.status ? read : null);
    const pic = k.image.startsWith('mxc://') ? media(k.image, 96) : k.image ? linkPic(k.image, ev.event_id) : '';
    const key = `${ev.event_id}|${url}`;
    const open = linkOpen.has(key);
    const toggle = k.description.length > 140 || k.transcript.length > 140 ? (e) => { e.stopPropagation(); if (open) linkOpen.delete(key); else linkOpen.add(key); linkVer.set(ev.event_id, (linkVer.get(ev.event_id) || 0) + 1); render(); } : null;
    const state = k.status === 'loading' ? T('Načítavam, čo je za odkazom…')
      : ['ok', 'partial', 'bridge'].includes(k.status) ? [k.transcript, k.source && T`zdroj: ${k.source}`].filter(Boolean).join(' · ')
      : k.reason || T('Obsah odkazu sa nedá načítať.');
    const ask = held ? h('button', { class: 'linkbtn', onclick: (e) => { e.stopPropagation(); linkReader.want(url); linkVer.set(ev.event_id, (linkVer.get(ev.event_id) || 0) + 1); render(); } }, T('Načítať')) : null;
    return h('div', { class: `lcard${toggle ? ' more' : ''}`, 'data-key': url, 'data-link': read === undefined && !held ? url : null, title: url, onclick: toggle },
      k.image ? h('div', { class: 'lpic' }, pic ? h('img', { src: pic, alt: '' }) : null) : null,
      h('div', { class: 'lmeta' },
        h('small', { class: 'lhead' }, `${k.name} · ${k.kindName}${k.author ? ` · ${k.author}` : ''}`),
        k.title ? h('b', {}, k.title) : null,
        k.description ? h('p', { class: open ? 'open' : '' }, k.description) : null,
        h('small', { class: open ? 'lstate open' : 'lstate' }, state, ask && ' ', ask)));
  });
}

// ------------------------------------------------------------------ shared reels and stories

/* Instagram brings a reel or story shared in a chat as its picture until a client asks for the video, as Beeper
 * does: the bridge fetches it with Karchi's login (POST /resolve_media) and edits the message into the video.
 * Weft asks once the picture comes into sight, one message at a time; a failure waits for a click to try again. */
const reelState = new Map(); // event id -> 'busy' | 'failed'
let reelQueue = Promise.resolve();
let reelSight = null;

const reelContent = new Map(); // event id -> its com.beeper.unresolved_media, which the bridge wants back

function fetchReel(id) {
  reelState.set(id, 'busy');
  linkVer.set(id, (linkVer.get(id) || 0) + 1);
  renderSoon();
  reelQueue = reelQueue.then(async () => {
    const app = LINKS.find((a) => a.id === 'instagram');
    const content = reelContent.get(id);
    const login = S.links.instagram?.[0]?.id;
    try {
      await call('POST', `/resolve_media/${q(id)}?user_id=${q(S.userId)}${login ? `&login_id=${q(login)}` : ''}`,
        { 'com.beeper.unresolved_media': content }, app.base, AbortSignal.timeout(60000));
      // The edit comes with the next sync; a bridge that never sends it lets a click try again after a while.
      setTimeout(() => { if (reelState.get(id) === 'busy') { reelState.set(id, 'failed'); linkVer.set(id, (linkVer.get(id) || 0) + 1); renderSoon(); } }, 30000);
    } catch {
      reelState.set(id, 'failed');
      linkVer.set(id, (linkVer.get(id) || 0) + 1);
      renderSoon();
    }
  });
}

/** After a render: pictures of shared reels not asked for yet are asked for once they come into sight. */
function watchReels(root) {
  const pics = root.querySelectorAll('.mimg[data-reel]');
  if (!pics.length) return;
  reelSight ||= new IntersectionObserver((seen) => {
    for (const e of seen) {
      if (!e.isIntersecting) continue;
      reelSight.unobserve(e.target);
      if (!reelState.has(e.target.dataset.reel)) fetchReel(e.target.dataset.reel);
    }
  }, { rootMargin: '200px 0px' });
  for (const el of pics) reelSight.observe(el);
}

/** After a render: cards whose link was not asked for yet are asked for once they come into sight. */
function watchLinks(root) {
  const cards = root.querySelectorAll('.lcard[data-link]');
  if (!cards.length) return;
  linkSight ||= new IntersectionObserver((seen) => {
    for (const e of seen) {
      if (!e.isIntersecting) continue;
      linkSight.unobserve(e.target);
      linkReader.want(e.target.dataset.link);
    }
  }, { rootMargin: '200px 0px' });
  for (const el of cards) linkSight.observe(el);
}

/** Karchi's vote: a tap picks the answer (or adds it, up to the limit), a tap on a picked one takes it back. */
function votePoll(r, m, ev, poll, id, picked) {
  // A card drawn before the poll expired: the click only redraws it as closed.
  const expiry = pollExpiry(m, ev);
  if (expiry && expiry < Date.now()) { r.version++; return render(); }
  const valid = new Set(poll.answers.map((a) => a.id));
  const mine = picked.filter((x) => valid.has(x));
  const next = mine.includes(id) ? mine.filter((x) => x !== id) : poll.max === 1 ? [id] : [...mine, id].slice(-poll.max);
  const stable = ev.type === 'm.poll.start';
  sendLocal(r, stable ? 'm.poll.response' : 'org.matrix.msc3381.poll.response', {
    'm.relates_to': { rel_type: 'm.reference', event_id: ev.event_id },
    ...(stable ? { 'm.selections': next } : { 'org.matrix.msc3381.poll.response': { answers: next } }),
  }, T('Hlas sa neodoslal.'));
}

/** When a Discord poll closes: newer counts may come without it (the bridge restarted), the poll itself has it. */
const pollExpiry = (m, ev) => contentOf(m, ev)[DISCORD_POLL]?.expiry || ev.content?.[DISCORD_POLL]?.expiry || 0;

/** Who voted for each answer, from the votes in the room: { count(id), mine, voters, names(id) }. */
function pollTally(m, ev, poll) {
  const who = new Map(poll.answers.map((a) => [a.id, []]));
  let voters = 0;
  for (const [sender, answers] of m.votes.get(ev.event_id) || []) {
    const valid = [...new Set(answers)].filter((id) => who.has(id)).slice(0, poll.max);
    for (const id of valid) who.get(id).push(sender);
    if (valid.length) voters++;
  }
  // Karchi's answers in the order he picked them: a vote over the limit drops the oldest.
  const mine = (m.votes.get(ev.event_id)?.get(S.userId) || []).filter((id) => who.has(id));
  return { count: (id) => who.get(id).length, names: (id) => who.get(id), picked: (id) => who.get(id).includes(S.userId), mine, voters };
}

/** Discord's counts; Karchi's vote counts in at once, until Discord's counts come with it. Counts the bridge sent
 *  while the vote was on its way (up to 30 s after it, or held for the reading window) do not undo it; later ones
 *  that differ (he changed it in Discord) win. A vote Discord refused leaves the bridge's notice in the chat. */
function discordTally(m, ev, poll, state) {
  const valid = new Set(poll.answers.map((a) => a.id));
  const counts = new Map(poll.answers.map((a) => [a.id, Math.max(0, Number(state.counts?.[a.id]) || 0)]));
  const said = (Array.isArray(state.mine) ? state.mine : []).filter((id) => valid.has(id));
  const stateAt = m.edits.get(ev.event_id)?.origin_server_ts ?? ev.origin_server_ts;
  const voted = m.votedAt.get(ev.event_id);
  let mine = said;
  const his = [...new Set(m.votes.get(ev.event_id)?.get(S.userId) || [])].filter((id) => valid.has(id)).slice(0, poll.max);
  const same = his.length === said.length && his.every((id) => said.includes(id));
  if (voted !== undefined && !same && (voted > stateAt || stateAt - voted < 30000)) {
    mine = his;
    for (const id of said) counts.set(id, Math.max(0, counts.get(id) - 1));
    for (const id of mine) counts.set(id, counts.get(id) + 1);
  }
  const votes = [...counts.values()].reduce((a, b) => a + b, 0);
  return { count: (id) => counts.get(id), names: () => [], picked: (id) => mine.includes(id), mine, votes };
}

/** A poll as its network shows it: each answer with a bar of its share of the votes; a tap votes. */
function pollView(r, m, ev, poll) {
  const state = contentOf(m, ev)[DISCORD_POLL];
  const t = state ? discordTally(m, ev, poll, state) : pollTally(m, ev, poll);
  const total = state ? t.votes : t.voters;
  const ended = m.ended.has(ev.event_id) || !!state?.closed || (!!state && pollExpiry(m, ev) > 0 && pollExpiry(m, ev) < Date.now());
  const people = total === 0 ? T('Zatiaľ nikto nehlasoval')
    : state ? `${total} ${total === 1 ? T('hlas') : total < 5 ? T('hlasy') : T('hlasov')}`
    : `${total} ${total < 5 ? T('hlasujúci') : T('hlasujúcich')}`;
  const open = !ev.pending && !ev.archived && !ended;
  return h('div', { class: 'poll' },
    h('div', { class: 'pq' }, poll.question),
    poll.answers.map((a) => {
      const n = t.count(a.id);
      return h('button', {
        class: `popt${t.picked(a.id) ? ' me' : ''}`, disabled: !open,
        title: t.names(a.id).map((id) => memberName(r, id)).join(', '), onclick: () => votePoll(r, m, ev, poll, a.id, t.mine),
      },
        h('i', { style: { width: `${total ? (n / total) * 100 : 0}%` } }),
        h('span', {}, a.text), h('b', {}, n ? String(n) : ''));
    }),
    h('div', { class: 'pfoot' }, people, ended ? T(' · ukončená') : '', ev.archived && state && !state.closed ? T(' · stav z archívu') : ''));
}

const ARCHIVE_KINDS = { image: 'Fotka', video: 'Video', audio: T('Zvuková správa'), file: T('Súbor') };
const sizeNote = (n) => (n ? ` · ${n > 1e6 ? `${num((n / 1e6).toFixed(1))} MB` : `${Math.ceil(n / 1e3)} kB`}` : '');

/** An old message's attachment from the archive; a Discord one may take a moment the first time. */
async function archiveDownload(f) {
  const res = await fetch(`/_archive/media/${f.id}`, { headers: { Authorization: `Bearer ${S.token}` } }).catch(() => null);
  if (!res?.ok) return alert(T('Súbor sa nepodarilo stiahnuť.'));
  const a = h('a', { href: URL.createObjectURL(await res.blob()), download: f.name || 'subor' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
}

async function download(mxc, name) {
  const res = await fetch(mediaPath(mxc), { headers: { Authorization: `Bearer ${S.token}` } }).catch(() => null);
  if (!res?.ok) return alert(T('Súbor sa nepodarilo stiahnuť.'));
  const a = h('a', { href: URL.createObjectURL(await res.blob()), download: name || 'subor' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
}

const ARCHIVE_URL = /^archive:\d+$/;
/** Where a file (a thumbnail of `size` px, 0: the whole file) is asked for: the homeserver, or the archive. */
function mediaPath(url, size = 0) {
  if (ARCHIVE_URL.test(url)) return `/_archive/media/${url.slice(8)}${!size ? '' : size <= 96 ? '?w=320' : '?w=480&fit=scale'}`;
  const [server, id] = url.slice(6).split('/');
  return size
    ? `/_matrix/client/v1/media/thumbnail/${q(server)}/${q(id)}?width=${size}&height=${size}&method=${size <= 96 ? 'crop' : 'scale'}`
    : `/_matrix/client/v1/media/download/${q(server)}/${q(id)}`;
}

/** Blob url of a whole Matrix file, fetched now rather than in the background queue. */
function mediaFile(mxc) {
  const key = `${mxc}|0`;
  if (mediaCache.get(key)) return Promise.resolve(mediaCache.get(key));
  return fetch(mediaPath(mxc), { headers: { Authorization: `Bearer ${S.token}` } })
    .then((res) => (res.ok ? res.blob() : null))
    .then((blob) => { if (!blob) return ''; const url = URL.createObjectURL(blob); mediaCache.set(key, url); return url; })
    .catch(() => '');
}

// ------------------------------------------------------------------ voice messages

const RATES = [1, 1.5, 2];
const voiceRate = () => { const x = Number(localStorage.getItem('ep_voice_rate')); return RATES.includes(x) ? x : 1; };
/** One player for every voice message. It lives outside the page, which is rebuilt on every render, so playback goes
 *  on while messages arrive and in other chats (the bar above the inbox pauses it there). `event` is the message it
 *  holds, playing or paused; `ev` and `c` are that message and its content. */
const voice = { el: new Audio(), room: null, event: null, ev: null, c: null, seekTo: null };
voice.el.defaultPlaybackRate = voiceRate(); // a new src starts at this rate
const mmss = (sec) => (Number.isFinite(sec) && sec >= 0 ? `${Math.floor(sec / 60)}:${pad(Math.floor(sec % 60))}` : '');

// Voice messages Karchi has started, on this device: someone else's unheard one carries a dot (as in WhatsApp and
// Telegram) and Ctrl+Shift+Space starts there. Messages from before this was kept count as heard.
const HEARD_KEY = 'ep_voice_heard';
const heard = (() => {
  try { const x = JSON.parse(localStorage.getItem(HEARD_KEY)); if (Number.isFinite(x?.since)) return { since: x.since, ids: new Set(x.ids) }; } catch { /* first run */ }
  const fresh = { since: Date.now(), ids: [] };
  localStorage.setItem(HEARD_KEY, JSON.stringify(fresh));
  return { since: fresh.since, ids: new Set() };
})();
const unheard = (ev) => ev.sender !== S.userId && !ev.archived && ev.origin_server_ts > heard.since && !heard.ids.has(ev.event_id);
function markHeard(id) {
  if (!id || heard.ids.has(id)) return;
  heard.ids.add(id);
  localStorage.setItem(HEARD_KEY, JSON.stringify({ since: heard.since, ids: [...heard.ids].slice(-500) }));
}

const BARS = 28;
/** `raw` levels squeezed into BARS bars of 0..1, the loudest one full. */
function toBars(raw) {
  const top = Math.max(...raw) || 1;
  return Array.from({ length: BARS }, (_, i) => {
    const from = Math.floor(i * raw.length / BARS);
    return Math.max(...raw.slice(from, Math.max(from + 1, Math.floor((i + 1) * raw.length / BARS)))) / top;
  });
}
/** Length in seconds and waveform bars: what the bridge wrote into the message, else measured here. */
function audioInfo(c) {
  const a = c['org.matrix.msc1767.audio'] || {};
  const own = Array.isArray(a.waveform) && a.waveform.length > 1 ? toBars(a.waveform) : null;
  const here = own ? null : measureAudio(c);
  return { duration: (c.info?.duration || a.duration || 0) / 1000 || here?.duration || 0, wave: own || here?.wave || null };
}
// Instagram and Messenger send voice messages without a waveform (WhatsApp and Discord do): small ones
// are fetched and measured once, one after another, and the file is then ready to play at once.
const measured = new Map(); // mxc -> { wave, duration }, null while it is being measured
let measuring = Promise.resolve();
function measureAudio(c) {
  if (measured.has(c.url) || !c.url || !(c.info?.size < 3e6 || (!c.info?.size && c['org.matrix.msc3245.voice']))) return measured.get(c.url);
  measured.set(c.url, null);
  measuring = measuring.then(async () => {
    const url = await mediaFile(c.url);
    if (!url) return;
    const audio = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(await (await fetch(url)).arrayBuffer()).catch(() => null);
    if (!audio) return;
    const data = audio.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / (BARS * 4)));
    const raw = [];
    for (let i = 0; i < data.length; i += step) {
      let sum = 0;
      const end = Math.min(data.length, i + step);
      for (let j = i; j < end; j++) sum += data[j] * data[j];
      raw.push(Math.sqrt(sum / (end - i)));
    }
    measured.set(c.url, { wave: toBars(raw), duration: audio.duration });
    renderSoon();
  });
  return null;
}

/** Where the player is in the voice message `id`: seconds played and its whole length (0 while unknown). */
function voicePos(id, duration) {
  const on = voice.event === id;
  const total = on && Number.isFinite(voice.el.duration) ? voice.el.duration : duration;
  return { on, total, at: on && total ? Math.min(total, voice.el.currentTime) : 0 };
}
const voiceTimeText = (at, total) => (total ? T`${mmss(at)} z ${mmss(total)}` : '');

/** A voice message as in Messenger: play, its waveform as the track (drag to move), the time left, speed. Keys on
 *  it: Space or K plays and pauses, ← → move 5 s, Home and End, Ctrl+S downloads (voiceKey). */
function voiceView(r, ev, c) {
  const { duration, wave } = audioInfo(c);
  const { on, total, at } = voicePos(ev.event_id, duration);
  const bars = (cls) => h('div', { class: cls }, wave.map((v) => h('i', { style: { height: `${Math.round(18 + v * 82)}%` } })));
  const track = h('div', {
    class: 'vtrack', title: T('Posunúť (← →)'), tabindex: 0, role: 'slider', 'aria-label': T`Hlasovka: ${memberName(r, ev.sender)}`,
    'aria-valuemin': 0, 'aria-valuemax': Math.round(total || 0), 'aria-valuenow': Math.round(at), 'aria-valuetext': voiceTimeText(at, total),
    onpointerdown: (e) => seekVoice(e, r, ev, c),
  }, wave ? [bars('vbars'), bars('vbars vdone')] : [h('div', { class: 'vline' }), h('div', { class: 'vline vdone' })]);
  track.lastChild.style.clipPath = `inset(0 ${100 - (total ? at / total : 0) * 100}% 0 0)`;
  const playing = on && !voice.el.paused;
  return h('div', { class: `voice${on ? ' on' : ''}`, 'data-voice': ev.event_id, onkeydown: (e) => voiceKey(e, r, ev, c) },
    h('button', {
      class: 'vplay', title: playing ? T('Pozastaviť (Space)') : T('Prehrať (Space)'),
      'aria-label': playing ? T('Pozastaviť hlasovku') : T`Prehrať hlasovku, ${mmss(total)}`, onclick: () => toggleVoice(r, ev, c),
    }, icon(playing ? 'pause' : 'play')),
    track,
    h('span', { class: 'vtime' }, mmss(on && total ? total - at : total)),
    unheard(ev) ? h('span', { class: 'vnew', title: T('Ešte si ju nepočul') }) : null,
    h('button', { class: 'vrate', title: T('Rýchlosť hlasoviek (zapamätá sa)'), onclick: cycleRate }, `${num(voiceRate())}×`));
}

/** Plays or pauses a voice message; `at` (0..1) starts it from that point of its length. */
async function toggleVoice(r, ev, c, at = null) {
  if (!c.url) return; // still being sent
  const a = voice.el;
  if (voice.event === ev.event_id && a.src) {
    if (at != null && Number.isFinite(a.duration)) a.currentTime = at * a.duration;
    else if (at == null && !a.paused) return a.pause();
    return a.play().catch(() => {});
  }
  a.pause();
  Object.assign(voice, { room: r.id, event: ev.event_id, ev, c, seekTo: at });
  a.removeAttribute('src');
  render();
  const url = await mediaFile(c.url);
  if (voice.event !== ev.event_id) return; // another one was started meanwhile
  if (!url) { voice.event = null; render(); return alert(T('Hlasovku sa nepodarilo načítať.')); }
  a.src = url;
  a.play().catch(() => {});
}

/** Plays or pauses the voice message in hand (the bar above the inbox, Ctrl+Shift+Space, the media keys). */
function toggleHeld() {
  const a = voice.el;
  if (!voice.event || !a.getAttribute('src')) return;
  if (a.paused) a.play().catch(() => {}); else a.pause();
}
/** Puts the voice message away: the bar above the inbox goes too. */
function stopVoice() {
  voice.el.pause();
  voice.el.removeAttribute('src');
  voice.el.load();
  Object.assign(voice, { room: null, event: null, ev: null, c: null, seekTo: null });
  voiceSession();
  render();
}
function seekVoiceBy(sec) {
  const a = voice.el;
  if (voice.event && Number.isFinite(a.duration)) a.currentTime = Math.max(0, Math.min(a.duration, a.currentTime + sec));
}

/** Ctrl+Shift+Space: plays or pauses the voice message in hand; with none, starts the open chat's first one Karchi
 *  has not heard, else its newest, and brings it into sight. */
function voiceShortcut() {
  if (voice.event) return toggleHeld();
  const r = S.rooms.get(S.selected);
  if (!r || !isChat(r)) return;
  const t = timelineOf(r);
  const list = t.msgs.filter((ev) => isVoice(t, ev));
  const pick = list.find(unheard) || list.at(-1);
  if (!pick) return;
  const pr = t.roomOf(pick);
  toggleVoice(pr, pick, contentOf(roomModel(pr), pick));
  requestAnimationFrame(() => document.querySelector(`.voice[data-voice="${CSS.escape(pick.event_id)}"]`)?.scrollIntoView({ block: 'nearest' }));
}
function isVoice(t, ev) {
  const m = roomModel(t.roomOf(ev));
  return !ev.pending && !isRedacted(m, ev) && contentOf(m, ev).msgtype === 'm.audio';
}
/** The voice message before (-1) or after (1) the one in hand in its chat: ended ones go on to the next, as in Messenger. */
function stepVoice(dir) {
  const vr = S.rooms.get(voice.room);
  const t = vr && voice.event ? timelineOf(vr) : null; // a merged chat goes on through all of its networks
  const i = t ? t.msgs.findIndex((ev) => ev.event_id === voice.event) : -1;
  const next = i < 0 ? null : dir > 0 ? t.msgs.slice(i + 1).find((ev) => isVoice(t, ev)) : t.msgs.slice(0, i).findLast((ev) => isVoice(t, ev));
  if (!next) return false;
  const r = t.roomOf(next);
  toggleVoice(r, next, contentOf(roomModel(r), next));
  return true;
}

/** Keys on a voice message and on the bar above the inbox. Native button keys stay (Enter, Space on its buttons); the
 *  page's „typing goes into the message box“ never takes them. */
function voiceKey(e, r, ev, c) {
  const key = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  const own = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
  if (mod && !e.shiftKey && !e.altKey && key === 's') return own(() => downloadVoice(r, ev, c));
  if (mod || e.altKey) return;
  const onButton = !!e.target.closest('button');
  if (key === ' ' && onButton) return e.stopPropagation(); // the button's own click, not a letter for the message box
  if (key === ' ' || key === 'k' || (key === 'enter' && !onButton)) return own(() => toggleVoice(r, ev, c));
  const held = voice.event === ev.event_id && Number.isFinite(voice.el.duration);
  if (key === 'arrowleft' || key === 'arrowright') return own(() => (held ? seekVoiceBy(key === 'arrowleft' ? -5 : 5) : toggleVoice(r, ev, c)));
  if (key === 'home' || key === 'end') return own(() => { if (held) voice.el.currentTime = key === 'home' ? 0 : Math.max(0, voice.el.duration - 0.05); });
}

function seekVoice(e, r, ev, c) {
  if (e.button !== 0) return; // a right click opens the menu, it does not play
  const track = e.currentTarget;
  const at = (x) => { const box = track.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - box.left) / box.width)); };
  toggleVoice(r, ev, c, at(e.clientX));
  track.setPointerCapture(e.pointerId);
  track.onpointermove = (m) => {
    if (voice.event === ev.event_id && Number.isFinite(voice.el.duration)) { voice.el.currentTime = at(m.clientX) * voice.el.duration; paintVoice(); }
  };
  track.onpointerup = () => { track.onpointermove = null; };
}

function cycleRate() {
  const rate = RATES[(RATES.indexOf(voiceRate()) + 1) % RATES.length];
  localStorage.setItem('ep_voice_rate', String(rate));
  voice.el.defaultPlaybackRate = rate;
  voice.el.playbackRate = rate;
  render(); // every voice message shows the speed, playing or not
}

const AUDIO_EXT = { 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/amr': 'amr' };
/** Saves a voice message as „Hlasovka <who> <date time>.<ext>“, the extension from its type, else its name. */
function downloadVoice(r, ev, c) {
  if (!c.url) return;
  const ext = AUDIO_EXT[String(c.info?.mimetype || '').split(';')[0].trim()] || /\.(\w{2,4})$/.exec(c.filename || c.body || '')?.[1] || 'ogg';
  const d = new Date(ev.origin_server_ts);
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
  download(c.url, `${T('Hlasovka')} ${memberName(r, ev.sender)} ${when}.${ext}`.replace(/[\\/:*?"<>|]+/g, ' '));
}

/** The voice message in hand, playing or paused, above the inbox wherever Karchi is (as Telegram's bar): who and
 *  where, which opens it in its chat, the time left, speed, download, and × to put it away. */
function nowPlaying() {
  const r = voice.event && S.rooms.get(voice.room);
  if (!r || !voice.ev) return null;
  const { ev, c } = voice;
  const playing = !voice.el.paused;
  const { total, at } = voicePos(ev.event_id, audioInfo(c).duration);
  return h('div', { class: 'nowplay', role: 'group', 'aria-label': T('Hlasovka'), onkeydown: (e) => voiceKey(e, r, ev, c) },
    h('button', { class: 'vplay', title: playing ? T('Pozastaviť (Ctrl+Shift+Space)') : T('Prehrať (Ctrl+Shift+Space)'), 'aria-label': playing ? T('Pozastaviť hlasovku') : T('Prehrať hlasovku'), onclick: toggleHeld }, icon(playing ? 'pause' : 'play')),
    h('button', { class: 'npwho', title: T('Ukázať v chate'), onclick: () => { select(keyOfRoom(r.id)); jumpTo(r, ev.event_id); } },
      h('b', {}, memberName(r, ev.sender)), roomTitle(r) !== memberName(r, ev.sender) ? h('small', {}, roomTitle(r)) : null),
    h('span', { class: 'vtime' }, mmss(total ? total - at : total)),
    h('button', { class: 'vrate', title: T('Rýchlosť hlasoviek (zapamätá sa)'), onclick: cycleRate }, `${num(voiceRate())}×`),
    h('button', { class: 'npbtn', title: T('Stiahnuť (Ctrl+S)'), 'aria-label': T('Stiahnuť hlasovku'), onclick: () => downloadVoice(r, ev, c) }, icon('download')),
    h('button', { class: 'npbtn', title: T('Zavrieť'), 'aria-label': T('Zavrieť hlasovku'), onclick: stopVoice }, icon('close')));
}

/** Moves the progress of the voice message on screen without rebuilding the page. */
function paintVoice() {
  const a = voice.el;
  if (!voice.event || !Number.isFinite(a.duration)) return;
  const el = document.querySelector(`.voice[data-voice="${CSS.escape(voice.event)}"]`);
  const done = a.duration ? Math.min(1, a.currentTime / a.duration) : 0;
  const left = mmss(a.duration - a.currentTime);
  if (el) {
    el.querySelector('.vdone').style.clipPath = `inset(0 ${100 - done * 100}% 0 0)`;
    el.querySelector('.vtime').textContent = left;
    const track = el.querySelector('.vtrack');
    track.setAttribute('aria-valuenow', Math.round(a.currentTime));
    track.setAttribute('aria-valuetext', voiceTimeText(a.currentTime, a.duration));
  }
  const bar = document.querySelector('.nowplay .vtime');
  if (bar) bar.textContent = left;
}

/** The voice message for the system's media controls (the keyboard's play, next and previous keys, the panel's player). */
function voiceSession() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const r = voice.event && S.rooms.get(voice.room);
  if (!r || !voice.ev) { ms.metadata = null; ms.playbackState = 'none'; return; }
  const title = T`Hlasovka: ${memberName(r, voice.ev.sender)}`;
  if (ms.metadata?.title !== title) ms.metadata = new MediaMetadata({ title, artist: roomTitle(r), album: 'Weft', artwork: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] });
  ms.playbackState = voice.el.paused ? 'paused' : 'playing';
  const a = voice.el;
  if (Number.isFinite(a.duration) && a.duration > 0) try { ms.setPositionState({ duration: a.duration, playbackRate: a.playbackRate, position: Math.min(a.currentTime, a.duration) }); } catch { /* an old browser */ }
}
if (navigator.mediaSession) {
  const handle = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* not in this browser */ } };
  handle('play', () => voice.el.play().catch(() => {}));
  handle('pause', () => voice.el.pause());
  handle('stop', stopVoice);
  handle('seekbackward', (d) => seekVoiceBy(-(d.seekOffset || 5)));
  handle('seekforward', (d) => seekVoiceBy(d.seekOffset || 5));
  handle('seekto', (d) => { if (Number.isFinite(voice.el.duration)) voice.el.currentTime = d.seekTime; });
  handle('previoustrack', () => { if (voice.el.currentTime > 3 || !stepVoice(-1)) voice.el.currentTime = 0; });
  handle('nexttrack', () => stepVoice(1));
}

voice.el.addEventListener('timeupdate', paintVoice);
for (const type of ['play', 'pause', 'ratechange', 'durationchange']) voice.el.addEventListener(type, () => { voiceSession(); renderSoon(); });
voice.el.addEventListener('play', () => markHeard(voice.event));
voice.el.addEventListener('seeked', voiceSession);
voice.el.addEventListener('loadedmetadata', () => {
  if (voice.seekTo != null && Number.isFinite(voice.el.duration)) voice.el.currentTime = voice.seekTo * voice.el.duration;
  voice.seekTo = null;
});
voice.el.addEventListener('error', () => { if (voice.el.getAttribute('src')) { voice.event = null; renderSoon(); alert(T('Túto hlasovku prehliadač neprehrá.')); } });
// The next voice message in its chat follows, as in Messenger; after the last one the bar goes.
voice.el.addEventListener('ended', () => { if (!stepVoice(1)) stopVoice(); });

// ------------------------------------------------------------------ recording voice messages

/** The voice message being recorded, at most one: { room, started, levels, stop }. */
let rec = null;
const REC_BARS = 40;

/** Ctrl+Shift+A or the microphone: starts a voice message in the open chat, or sends the one being recorded. */
async function toggleRecording() {
  if (S.rooms.get(S.selected)?.archiveOnly) return;
  if (rec) return stopRecording(true);
  const r = S.rooms.get(S.selected);
  if (!r || !isChat(r)) {
    if (S.selected) { S.eduNote = S.selected; render(); }
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    return alert(T('Mikrofón nie je dostupný.'));
  }
  if (rec || S.selected !== r.id) return stream.getTracks().forEach((t) => t.stop()); // pressed twice, or another chat meanwhile
  voice.el.pause(); // a voice message does not talk into the new one
  // Chromium records only WebM; it is rewrapped as Ogg when sent, the one voice format every bridge takes.
  const mimeType = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const me = { room: r.id, started: Date.now(), levels: [] };
  // The loudness every tenth of a second: the live bars now, the message's waveform later.
  const tick = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    me.levels.push(Math.sqrt(sum / buf.length));
    paintRecording();
  }, 100);
  me.stop = () => new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
    recorder.stop();
  }).finally(() => { clearInterval(tick); stream.getTracks().forEach((t) => t.stop()); ctx.close(); });
  recorder.start(1000);
  rec = me;
  render();
}

/** Ends the recording: sends it, or with `send` false throws it away. */
async function stopRecording(send) {
  const me = rec;
  if (!me) return;
  rec = null;
  const ms = Date.now() - me.started;
  S.focusComposer = true;
  render();
  const recorded = await me.stop();
  const r = S.rooms.get(me.room);
  if (send && r && ms >= 500) sendVoice(r, recorded, ms, me.levels); // a shorter one was a slip of the key
}

/** Bar heights 0..1 of the last moments of the recording, the newest on the right. */
function recHeights() {
  const last = rec ? rec.levels.slice(-REC_BARS) : [];
  return Array.from({ length: REC_BARS }, (_, i) => {
    const v = last[i - (REC_BARS - last.length)];
    return v == null ? 0.08 : Math.max(0.08, Math.min(1, Math.sqrt(v) * 2.2));
  });
}
function recordingBar() {
  return h('div', { class: 'crow rec' },
    h('button', { class: 'attach', title: T('Zahodiť (Esc)'), onclick: () => stopRecording(false) }, icon('trash')),
    h('span', { class: 'rdot' }),
    h('div', { class: 'rbars' }, recHeights().map((v) => h('i', { style: { height: `${Math.round(v * 100)}%` } }))),
    h('span', { class: 'vtime' }, mmss((Date.now() - rec.started) / 1000)),
    h('button', { class: 'send', title: T('Odoslať (Enter alebo Ctrl+Shift+A)'), onclick: () => stopRecording(true) }, icon('arrow-up')));
}
/** Moves the bars and the time without rebuilding the page. */
function paintRecording() {
  const bar = rec && document.querySelector('.crow.rec');
  if (!bar) return;
  const heights = recHeights();
  bar.querySelectorAll('.rbars i').forEach((el, i) => { el.style.height = `${Math.round(heights[i] * 100)}%`; });
  bar.querySelector('.vtime').textContent = mmss((Date.now() - rec.started) / 1000);
}

/** Sends a recorded voice message as Matrix voice (MSC3245), with its length and waveform. */
async function sendVoice(r, recorded, ms, levels) {
  const reply = replyRel(r);
  if (reply === false) return alert(replyNote(r));
  noteHeldReply(r);
  const replyWas = reply ? S.replyTo : null;
  if (reply) S.replyTo = null;
  const n = Math.min(64, levels.length) || 1;
  const raw = Array.from({ length: n }, (_, i) => Math.max(0, ...levels.slice(Math.floor(i * levels.length / n), Math.floor((i + 1) * levels.length / n))));
  const top = Math.max(...raw) || 1;
  const audio = { duration: ms, waveform: raw.map((v) => Math.round(v / top * 256)) };
  const txn = txnId();
  const shown = { msgtype: 'm.audio', body: 'hlasovka.ogg', info: { duration: ms }, 'org.matrix.msc1767.audio': audio, 'org.matrix.msc3245.voice': {} };
  r.pending.set(txn, { event_id: txn, type: 'm.room.message', pending: true, sender: S.userId, origin_server_ts: Date.now(), content: shown });
  render();
  const build = async () => {
    const ogg = recorded.type.startsWith('audio/ogg') ? recorded : webmToOgg(new Uint8Array(await recorded.arrayBuffer()));
    const file = new File([ogg], 'hlasovka.ogg', { type: 'audio/ogg' });
    const content = await fileContent(file);
    content.info.duration = ms;
    Object.assign(content, { 'org.matrix.msc1767.audio': audio, 'org.matrix.msc3245.voice': {} });
    if (reply) content['m.relates_to'] = reply;
    mediaCache.set(`${content.url}|0`, localUrl(file)); // it plays at once, without downloading it back
    return content;
  };
  try {
    const content = await build();
    await checkReply(r, content);
    const res = await call('PUT', `/rooms/${q(r.id)}/send/m.room.message/${txn}`, content);
    settleChat(r, txn, res, content);
  } catch (err) {
    // Held: the text being written still answers the same message, so Enter on it asks again.
    if (err?.held && replyWas && !S.replyTo) { S.replyTo = replyWas; render(); }
    failLocal(r, txn, err, () => sendAgain(r, 'm.room.message', shown, build));
  }
}

/** Rewraps the Opus audio of a WebM recording as an Ogg Opus file (RFC 7845), without re-encoding. */
function webmToOgg(b) {
  const vint = (p, id) => {
    let len = 1;
    while (len <= 8 && !(b[p] & (0x80 >> (len - 1)))) len++;
    let v = id ? b[p] : b[p] & (0xff >> len);
    for (let i = 1; i < len; i++) v = v * 256 + b[p + i];
    return [v, len];
  };
  // Segment, Tracks, TrackEntry, Audio, Cluster, BlockGroup: read through, whatever size they claim
  // (a live recording leaves the Segment's and Clusters' sizes unknown).
  const MASTER = new Set([0x18538067, 0x1654ae6b, 0xae, 0xe1, 0x1f43b675, 0xa0]);
  let head = null;
  let channels = 1;
  const packets = [];
  for (let p = 0; p < b.length;) {
    const [id, il] = vint(p, true);
    const [size, sl] = vint(p + il);
    if (il > 4 || sl > 8) break;
    p += il + sl;
    if (MASTER.has(id)) continue;
    const end = Math.min(b.length, p + size);
    if (id === 0x63a2) head = b.slice(p, end); // CodecPrivate: the OpusHead
    else if (id === 0x9f) channels = b[p];
    else if (id === 0xa3 || id === 0xa1) { // SimpleBlock or Block: track, timecode, flags, one Opus packet
      const at = p + vint(p)[1] + 3;
      if (!(b[at - 1] & 0x06) && end > at) packets.push(b.subarray(at, end));
    }
    p = end;
  }
  if (!packets.length) throw new Error('no audio');
  const enc = new TextEncoder();
  if (!head) {
    head = new Uint8Array(19);
    head.set(enc.encode('OpusHead'));
    head[8] = 1;
    head[9] = channels;
    new DataView(head.buffer).setUint32(12, 48000, true);
  }
  const vendor = enc.encode('Weft');
  const tags = new Uint8Array(16 + vendor.length);
  tags.set(enc.encode('OpusTags'));
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);

  const serial = (Math.random() * 2 ** 32) >>> 0;
  const pages = [];
  const page = (group, granule, flags) => {
    const lace = [];
    for (const pk of group) {
      let n = pk.length;
      for (; n >= 255; n -= 255) lace.push(255);
      lace.push(n);
    }
    const out = new Uint8Array(27 + lace.length + group.reduce((s, pk) => s + pk.length, 0));
    const dv = new DataView(out.buffer);
    out.set([0x4f, 0x67, 0x67, 0x53, 0, flags]); // "OggS", version, header type
    dv.setBigUint64(6, BigInt(granule), true);
    dv.setUint32(14, serial, true);
    dv.setUint32(18, pages.length, true);
    out[26] = lace.length;
    out.set(lace, 27);
    let at = 27 + lace.length;
    for (const pk of group) { out.set(pk, at); at += pk.length; }
    dv.setUint32(22, oggCrc(out), true);
    pages.push(out);
  };
  page([head], 0, 0x02);
  page([tags], 0, 0);
  // Samples at 48 kHz in one packet, from its TOC byte (RFC 6716, 3.1).
  const samples = (pk) => {
    const c = pk[0] >> 3;
    const frame = c < 12 ? [480, 960, 1920, 2880][c & 3] : c < 16 ? [480, 960][c & 1] : [120, 240, 480, 960][c & 3];
    const count = pk[0] & 3;
    return frame * (count === 0 ? 1 : count === 3 ? (pk[1] & 0x3f) : 2);
  };
  let granule = 0;
  for (let i = 0; i < packets.length;) {
    const group = [];
    let laces = 0;
    // About a second of audio per page, never over the 255 lacing values a page holds.
    while (i < packets.length && group.length < 50 && laces + Math.floor(packets[i].length / 255) + 1 <= 255) {
      laces += Math.floor(packets[i].length / 255) + 1;
      granule += samples(packets[i]);
      group.push(packets[i++]);
    }
    page(group, granule, i === packets.length ? 0x04 : 0);
  }
  return new Blob(pages, { type: 'audio/ogg' });
}
const OGG_CRC = Array.from({ length: 256 }, (_, i) => {
  let c = i << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  return c >>> 0;
});
function oggCrc(bytes) {
  let crc = 0;
  for (const x of bytes) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ x) & 0xff]) >>> 0;
  return crc;
}

// ------------------------------------------------------------------ photo viewer

/** The chat's pictures and videos, oldest first: what the viewer pages through. A shared post's photos each count,
 *  and so do an old message's from the archive. */
function galleryOf(r) {
  const m = roomModel(r);
  return m.messages.filter((ev) => !ev.pending && !isRedacted(m, ev)).flatMap((ev) => {
    if (ev.archiveFiles) return archiveMedia(ev);
    const c = contentOf(m, ev);
    if (ev.type !== 'm.sticker' && !['m.image', 'm.video'].includes(c.msgtype)) return [];
    const items = carouselOf(ev, c);
    return items.length ? items : [ev];
  });
}
/** An old message's photos and videos the archive keeps (an export, a bridge's older pages), as the viewer's picture
 *  events `<message id>#a<n>` with the content a homeserver message would have; `file` is the archive's row. Only a
 *  file on asus or the homeserver: a Discord one not downloaded yet waits for a click (its first fetch asks Discord). */
function archiveMedia(ev) {
  return (ev.archiveFiles || []).flatMap((f, n) => {
    const mime = String(f?.mime || '');
    // A voice message may be an .mp4 too: only a plain file goes by its type.
    const kind = f?.kind === 'image' || f?.kind === 'video' ? f.kind : f?.kind === 'file' ? (/^(image|video)\//.exec(mime) || [])[1] : null;
    // Pictures a browser cannot draw (HEIC, SVG) stay files.
    if (f?.here !== true || !kind || /hei[cf]|svg/.test(mime)) return [];
    const info = { mimetype: mime, size: f.size, ...(f.w && f.h ? { w: f.w, h: f.h } : {}), ...(f.dur ? { duration: f.dur } : {}) };
    return [{ event_id: `${ev.event_id}#a${n}`, sender: ev.sender, origin_server_ts: ev.origin_server_ts, file: f,
      content: { msgtype: kind === 'video' ? 'm.video' : 'm.image', url: `archive:${f.id}`, body: f.name, info } }];
  });
}
/** A shared Instagram post with several photos or videos (the bridge lists them in com.beeper.meta.carousel), as
 *  the viewer's picture events `<event id>#<n>` in the post's order; their content is the item itself. */
function carouselOf(ev, c) {
  const items = c?.['com.beeper.meta.carousel']?.items;
  const list = Array.isArray(items) ? items.filter((it) => typeof it?.url === 'string' && ['m.image', 'm.video'].includes(it.msgtype)) : [];
  return list.length > 1 ? list.map((it, n) => ({ event_id: `${ev.event_id}#${n}`, sender: ev.sender, origin_server_ts: ev.origin_server_ts, content: it })) : [];
}
/** Under a shared post's picture: each of its photos and videos small, a click shows that one large. */
function carouselStrip(r, ev, c) {
  const items = ev.pending ? [] : carouselOf(ev, c);
  if (!items.length) return null;
  return h('div', { class: 'mcarousel' }, items.map((it, n) => h('button', {
    class: `mthumb${it.content.url === c.url ? ' on' : ''}`, 'data-key': it.event_id, title: T`${n + 1} z ${items.length}`,
    onclick: (e) => { e.stopPropagation(); openViewer(r, it.event_id); },
  }, it.content.msgtype === 'm.video' && !it.content.info?.thumbnail_url ? null
    : mediaInPlace(it.content.msgtype === 'm.video' ? it.content.info.thumbnail_url : it.content.url, 96, (url) => h('img', { src: url, alt: '' }), () => h('span', { class: 'mwait' })),
  it.content.msgtype === 'm.video' ? h('span', { class: 'play' }, icon('play')) : null)));
}
const openViewer = (r, eventId) => openOverlay('image', { room: r.id, event: eventId, zoom: 1, x: 0, y: 0 });
/** Pictures a teacher pinned to an EduPage homework, as the viewer's picture events `<notice id>#<n>`. */
function eduPictures(ev) {
  const files = ev?.content[EDU_FILES];
  if (!Array.isArray(files)) return [];
  return files.flatMap((f, i) => (typeof f?.url === 'string' && String(f.mimetype).startsWith('image/') ? [{
    event_id: `${ev.event_id}#${i}`, sender: ev.sender, origin_server_ts: ev.origin_server_ts,
    content: { msgtype: 'm.image', url: f.url, body: f.name, info: { w: f.w, h: f.h, mimetype: f.mimetype } },
  }] : []));
}
/** What the viewer pages through: a chat's pictures and videos, or one EduPage homework's pictures. */
function viewerSource(o) {
  if (o.edu) {
    return { list: eduPictures(eduTimeline().find((ev) => ev.event_id === o.edu)), content: (ev) => ev.content,
      who: (ev) => ({ name: nameOf(ev.sender) }), done: true };
  }
  const r = S.rooms.get(o.room);
  if (!r) return { list: [], content: () => ({}), who: () => ({}), done: true };
  const m = roomModel(r);
  if (o.statusOf) {
    return { list: statusPosts(o.statusOf).filter((ev) => ['m.image', 'm.video'].includes(ev.content?.msgtype)).reverse(),
      content: (ev) => contentOf(m, ev), done: true, who: () => o.statusWho || {} }; // the status room knows no names
  }
  return { list: galleryOf(r), content: (ev) => contentOf(m, ev), done: r.matrixDone, more: () => loadRoomHistory(r),
    who: (ev) => ({ name: memberName(r, ev.sender), avatar: r.members.get(ev.sender)?.avatar }) };
}
function stepViewer(d) {
  const o = S.overlay;
  viewerSpaceUp(null, false); // a held Space belongs to the video being left
  if (o.gallery) {
    if (!gal?.items[o.index + d]) return;
    Object.assign(o, { index: o.index + d, zoom: 1, x: 0, y: 0 });
    gal.sel = o.index;
    return render();
  }
  const { list } = viewerSource(o);
  const next = list[list.findIndex((ev) => ev.event_id === o.event) + d];
  if (!next) return;
  Object.assign(o, { event: next.event_id, zoom: 1, x: 0, y: 0 });
  render();
}
let viewerVideo = null; // { src, el }: kept across renders so a playing video does not restart

/** Full screen picture: arrows or the wheel page through the chat, Ctrl+wheel or a double click zooms. */
function viewerView(o) {
  if (o.gallery) return galleryViewerView(o);
  const close = () => { S.overlay = null; render(); };
  const src = viewerSource(o);
  const { list } = src;
  const i = list.findIndex((ev) => ev.event_id === o.event);
  const ev = list[i];
  if (!ev) return h('div', { class: 'veil dark', onclick: close }, h('div', { class: 'empty' }, T('Obrázok už v chate nie je.')));
  // Older pictures come in as the first loaded one is reached.
  if (i < 3 && !src.done) setTimeout(src.more); // the archive has no pictures
  const c = src.content(ev);
  const who = src.who(ev);
  const video = c.msgtype === 'm.video';
  for (const n of [list[i - 1], list[i + 1]]) if (n && src.content(n).msgtype !== 'm.video') media(src.content(n).url);
  const full = media(c.url);
  let stage;
  if (video) {
    if (full && viewerVideo?.src !== full) viewerVideo = { src: full, el: playerVideo(full) };
    stage = full ? viewerVideo.el : h('div', { class: 'empty' }, T('Načítavam…'));
  } else {
    // The chat's small picture stands in, at full size, until the whole one arrives.
    const shown = full || media(c.url, 480);
    const w = c.info?.w;
    const hgt = c.info?.h;
    const fit = w && hgt ? Math.min(1, innerWidth * 0.94 / w, (innerHeight - 140) / hgt) : 0;
    stage = shown ? h('img', {
      class: `vimg${o.zoom > 1 ? ' zoomed' : ''}`, src: shown, alt: c.body || '', draggable: false,
      style: { transform: `translate(${o.x}px, ${o.y}px) scale(${o.zoom})`, ...(fit ? { width: `${Math.round(w * fit)}px`, height: `${Math.round(hgt * fit)}px` } : {}) },
      ondblclick: (e) => zoomAt(o, e.currentTarget, o.zoom > 1 ? 1 : 2.5, e.clientX, e.clientY),
      onpointerdown: (e) => panViewer(e, o),
    }) : h('div', { class: 'empty' }, T('Načítavam…'));
  }
  const ts = ev.origin_server_ts;
  const stop = (e) => e.stopPropagation();
  return h('div', {
    class: 'veil dark viewer',
    onclick: (e) => { if (o.dragged) o.dragged = false; else if (e.target === e.currentTarget || e.target.classList.contains('vstage')) close(); },
    onwheel: (e) => viewerWheel(e, o),
  },
  h('div', { class: 'vhead', onclick: stop },
    avatar(who.avatar, who.name, 32, 'mav'),
    h('div', { class: 'vwho' }, h('b', {}, who.name), h('small', {}, `${dayLabel(ts)} ${timeLabel(ts)}`)),
    list.length > 1 ? h('span', { class: 'vcount', title: src.done ? '' : T('Staršie obrázky sa ešte načítavajú') }, T`${i + 1} z ${list.length}${src.done ? '' : '+'}`) : null,
    shareLink(c) ? h('button', { class: 'vbtn', title: T('Preposlať…'), onclick: () => openForward(shareLink(c)) }, icon('forward')) : null,
    h('button', { class: 'vbtn', title: T('Stiahnuť (Ctrl+S)'), onclick: () => viewerDownload(o) }, icon('download')),
    h('button', { class: 'vbtn', title: T('Zavrieť (Esc)'), onclick: close }, icon('close'))),
  h('div', { class: 'vstage' }, stage, o.fast ? h('span', { class: 'vfast' }, '2×') : null),
  i > 0 ? h('button', { class: 'vnav vprev', title: T('Predošlý (Ctrl+←)'), onclick: (e) => { stop(e); stepViewer(-1); } }, icon('chevron-left')) : null,
  i < list.length - 1 ? h('button', { class: 'vnav vnext', title: T('Ďalší (Ctrl+→)'), onclick: (e) => { stop(e); stepViewer(1); } }, icon('chevron-right')) : null);
}

function viewerDownload(o) {
  if (o.gallery) {
    const it = gal?.items[o.index];
    const url = it && galFiles.get(galKey(it));
    if (url) h('a', { href: url, download: `${fullDate(it.ts).replace(/\. /g, '-')} ${timeLabel(it.ts).replace(':', '.')}.${it.kind === 'video' ? 'mp4' : 'jpg'}` }).click();
    return;
  }
  const src = viewerSource(o);
  const ev = src.list.find((x) => x.event_id === o.event);
  if (!ev) return;
  const c = src.content(ev);
  let name = c.filename || c.body || 'obrazok';
  const ext = (c.info?.mimetype || '').split('/')[1]?.replace('jpeg', 'jpg').replace('quicktime', 'mov');
  if (ext && !/\.\w{2,4}$/.test(name)) name += `.${ext}`;
  download(c.url, name);
}

/** Zooms to `z` keeping the point under (mx, my) where it is; at 1 the picture sits centered again. */
function zoomAt(o, img, z, mx, my) {
  z = Math.min(8, Math.max(1, z));
  const box = img.getBoundingClientRect(); // scaled around its center, so the center has only moved by (x, y)
  const cx = box.left + box.width / 2 - o.x;
  const cy = box.top + box.height / 2 - o.y;
  const k = z / o.zoom;
  o.x = z === 1 ? 0 : mx - cx - k * (mx - cx - o.x);
  o.y = z === 1 ? 0 : my - cy - k * (my - cy - o.y);
  o.zoom = z;
  img.style.transform = `translate(${o.x}px, ${o.y}px) scale(${z})`;
  img.classList.toggle('zoomed', z > 1);
}

function viewerWheel(e, o) {
  e.preventDefault();
  const img = document.querySelector('.vimg');
  const now = performance.now();
  if (img && (e.ctrlKey || o.zoom > 1)) {
    const was = o.zoom;
    zoomAt(o, img, o.zoom * Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * 0.004), e.clientX, e.clientY);
    if (was > 1 && o.zoom === 1) o.wheelLock = now + 500; // zoomed back out: the same flick does not page on
    return;
  }
  if (now < (o.wheelLock || 0)) return;
  o.wheelSum = (o.wheelSum || 0) + (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX);
  if (Math.abs(o.wheelSum) < 50) return;
  const d = Math.sign(o.wheelSum);
  o.wheelSum = 0;
  o.wheelLock = now + 280; // one picture per wheel notch, and a touchpad flick does not race through all
  stepViewer(d);
}

function panViewer(e, o) {
  if (o.zoom <= 1 || e.button !== 0) return;
  const img = e.currentTarget;
  img.setPointerCapture(e.pointerId);
  let last = { x: e.clientX, y: e.clientY };
  img.onpointermove = (m) => {
    o.x += m.clientX - last.x;
    o.y += m.clientY - last.y;
    if (Math.abs(m.clientX - e.clientX) + Math.abs(m.clientY - e.clientY) > 3) o.dragged = true;
    last = { x: m.clientX, y: m.clientY };
    img.style.transform = `translate(${o.x}px, ${o.y}px) scale(${o.zoom})`;
  };
  img.onpointerup = () => { img.onpointermove = null; setTimeout(() => { o.dragged = false; }, 0); };
}

/** The viewer's keys: arrows page, + - 0 zoom, Ctrl+S downloads. True when the key was the viewer's. */
/** Keys in the viewer: Ctrl+← → page through the files; on a video ← → move 5 s and Space plays or pauses, held down
 *  it plays twice as fast until let go (viewerSpaceUp); on a picture ← → page too. */
function viewerKey(e) {
  const o = S.overlay;
  const mod = e.ctrlKey || e.metaKey;
  const img = document.querySelector('.vimg');
  const video = document.querySelector('.veil.viewer video');
  const middle = () => { const b = img.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; };
  const arrow = e.altKey || e.shiftKey ? 0 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
  if (arrow && (mod || !video)) stepViewer(arrow);
  else if (arrow) video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + arrow * 5));
  else if (e.key === ' ' && !mod && !e.altKey) { if (video && !e.repeat && !spaceHold) holdSpace(o, video); } // on a picture: nothing
  else if (mod && e.key.toLowerCase() === 's') viewerDownload(o);
  else if (!mod && img && ['+', '='].includes(e.key)) zoomAt(o, img, o.zoom * 1.5, ...middle());
  else if (!mod && img && e.key === '-') zoomAt(o, img, o.zoom / 1.5, ...middle());
  else if (!mod && img && e.key === '0') zoomAt(o, img, 1, ...middle());
  else return false;
  e.preventDefault();
  return true;
}
addEventListener('resize', () => S.overlay?.kind === 'image' && render());

/** The viewer's video. A click on it or its controls gives focus back to the page at once: a focused video would
 *  answer Space and the arrows itself, on top of viewerKey (Space played and paused again, or the keys died). */
const playerVideo = (src) => h('video', { class: 'full', src, controls: true, autoplay: true, onfocus: (e) => { const v = e.currentTarget; setTimeout(() => v.blur()); } });

let spaceHold = null; // { timer, o, video, rate }: Space down over the viewer's video; `rate` once it went fast
function holdSpace(o, video) {
  spaceHold = { o, video, timer: setTimeout(() => {
    // Paged on or closed meanwhile: that video is not the one in front any more.
    if (!spaceHold || S.overlay !== o || !video.isConnected) return;
    spaceHold.rate = video.playbackRate;
    video.playbackRate = 2;
    video.play().catch(() => {});
    o.fast = true;
    // Drawing the mark rebuilds the viewer, which would take the video out of full screen: there it goes without.
    if (!document.fullscreenElement) render();
  }, 300) };
}
/** Space let go: a short press plays or pauses, after holding the video goes back to its speed and plays on.
 *  `toggle` false only ends the hold (the window lost the key, the viewer paged on). */
function viewerSpaceUp(e, toggle = true) {
  if (!spaceHold) return;
  const { timer, o, video, rate } = spaceHold;
  spaceHold = null;
  clearTimeout(timer);
  e?.preventDefault();
  if (rate) video.playbackRate = rate;
  if (o.fast) { o.fast = false; if (!document.fullscreenElement) render(); }
  if (!rate && toggle && S.overlay === o && video.isConnected) { if (video.paused) video.play().catch(() => {}); else video.pause(); }
}
document.addEventListener('keyup', (e) => { if (e.key === ' ') viewerSpaceUp(e); });
addEventListener('blur', () => viewerSpaceUp(null, false)); // the window lost the key: never stuck fast
// Back from full screen, the viewer draws what changed there (the 2× mark it skipped).
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && S.overlay?.kind === 'image') render(); });

function jumpTo(r, eventId) {
  S.focusEvent = eventId;
  S.focusScrolled = null;
  loadContext(r, eventId);
  render();
}

// ------------------------------------------------------------------ gallery (Ctrl+P)

// The open chat's photos and videos over the whole window, newest first, by month. The archive lists them (the
// homeserver's, the bridges' older pages, the exports) and serves square thumbnails; only the tiles in view and a
// screen above and below are in the DOM. The element lives across renders: scrolling never re-renders the app.
const GAL_HEAD = 44;
const GAL_FILTERS = [['', T('Všetko')], ['image', T('Fotky')], ['video', T('Videá')]];
const GAL_MONTHS = [T('Január'), T('Február'), T('Marec'), T('Apríl'), T('Máj'), T('Jún'), T('Júl'), 'August', 'September', T('Október'), 'November', 'December'];
let gal = null;
const galThumbs = new Map(); // item key -> blob url ('' while loading); the oldest are let go past 900
let galQueue = [];
let galActive = 0;

const galKey = (it) => (it.id != null ? `a${it.id}` : `l${it.msg}`);
const galMonth = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const galLabel = (mon) => `${GAL_MONTHS[Number(mon.slice(5)) - 1]} ${mon.slice(0, 4)}`;
const galDuration = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
/** Where an item's file is: the archive's, or (a picture newer than its hourly copy) the homeserver's. */
function galUrl(it, thumb) {
  if (it.id != null) return `/_archive/media/${it.id}${thumb ? '?w=320' : ''}`;
  const mxc = thumb ? it.thumb || it.mxc : it.mxc;
  const [server, id] = mxc.slice(6).split('/');
  return thumb ? `/_matrix/client/v1/media/thumbnail/${q(server)}/${q(id)}?width=320&height=320&method=crop`
    : `/_matrix/client/v1/media/download/${q(server)}/${q(id)}`;
}

function openGallery(r) {
  if (!r) return;
  closeGallery(false);
  gal = { room: r.id, kind: '', sel: 0, items: [], months: [], total: 0, epoch: 0, shown: new Map(), heads: new Map(), y: 0 };
  galBuild();
  document.activeElement?.blur(); // the message box under it must not take the keys
  S.overlay = { kind: 'gallery' };
  // Laid over the window as it is: the chat under it is not rebuilt (that takes longer than the first thumbnails).
  document.getElementById('app').append(gal.el);
  galLoad();
}

function closeGallery(draw = true) {
  if (!gal) return;
  gal.epoch++;
  gal = null;
  galQueue = [];
  if (S.overlay?.kind === 'gallery' || S.overlay?.gallery) S.overlay = null;
  if (draw) { if (!S.rooms.get(S.selected)?.archiveOnly) S.focusComposer = true; render(); }
}

/** The list from the archive: the first page with every month's count lays the whole gallery out at once, the rest
 * follows in the background. */
async function galLoad() {
  const g = gal;
  const epoch = ++g.epoch;
  const r = S.rooms.get(g.room);
  const get = async (args) => {
    const res = await fetch(`/_archive/rooms/${q(g.room)}/media?${new URLSearchParams({ ...(g.kind ? { kind: g.kind } : {}), ...args })}`,
      { headers: { Authorization: `Bearer ${S.token}` } }).catch(() => null);
    if (!res?.ok) throw new Error('gallery unavailable');
    return res.json();
  };
  Object.assign(g, { items: [], months: [], total: 0, failed: false, done: false });
  let first;
  try { first = await get({ limit: '150' }); } catch { first = { items: [], months: [], total: 0 }; g.failed = true; }
  if (epoch !== g.epoch || gal !== g) return;
  g.items = first.items;
  g.months = first.months;
  g.total = first.total;
  if (r) galAddLocal(g, r);
  g.sel = Math.min(g.sel, Math.max(0, g.total - 1));
  galLayout();
  galDraw(true);
  while (g.items.length < g.total && !g.failed) {
    const last = g.items[g.items.length - 1];
    let page;
    try { page = await get({ before: String(last.ts), id: String(last.id ?? 2 ** 62), limit: '1000' }); } catch { g.failed = true; break; }
    if (epoch !== g.epoch || gal !== g) return;
    if (!page.items.length) break;
    g.items.push(...page.items);
    galDraw();
  }
  g.done = true;
  galDraw();
}

/** Pictures the chat has that the archive's hourly copy does not yet: they join the newest end. */
function galAddLocal(g, r) {
  const m = roomModel(r);
  const known = new Set(g.items.map((it) => it.msg));
  const oldest = g.items.length < g.total ? g.items[g.items.length - 1]?.ts ?? Infinity : -Infinity;
  const extra = [];
  for (const ev of galleryOf(r)) {
    const c = contentOf(m, ev);
    const kind = { 'm.image': 'image', 'm.video': 'video' }[c.msgtype];
    if (!kind || ev.archived || known.has(ev.event_id) || !c.url?.startsWith('mxc://') || (g.kind && g.kind !== kind) || ev.origin_server_ts < oldest) continue;
    extra.push({ msg: ev.event_id, ts: ev.origin_server_ts, sender: ev.sender === S.userId ? '' : memberName(r, ev.sender), me: ev.sender === S.userId,
      kind, w: c.info?.w, h: c.info?.h, dur: c.info?.duration, mxc: c.url, thumb: c.info?.thumbnail_url, body: c.body || '' });
  }
  if (!extra.length) return;
  g.items = [...extra, ...g.items].sort((a, b) => b.ts - a.ts || (b.id ?? 2 ** 62) - (a.id ?? 2 ** 62));
  g.total += extra.length;
  const counts = new Map(g.months);
  for (const it of extra) counts.set(galMonth(it.ts), (counts.get(galMonth(it.ts)) || 0) + 1);
  g.months = [...counts].sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

function galBuild() {
  const g = gal;
  const stop = (e) => e.stopPropagation();
  g.grid = h('div', { class: 'ggrid' });
  g.stick = h('div', { class: 'ghead gstick' });
  g.scroller = h('div', { class: 'gscroll', onscroll: () => { g.y = g.scroller.scrollTop; galDraw(); } }, g.grid);
  g.rail = h('div', { class: 'grail', title: T('Ťahom alebo klikom na mesiac'), onpointerdown: (e) => galRail(e) });
  g.tip = h('div', { class: 'gtip', hidden: true });
  g.mark = h('div', { class: 'gmark' });
  g.foot = h('div', { class: 'gfoot', onclick: stop });
  g.count = h('span', { class: 'vcount' });
  g.filters = h('div', { class: 'gfilters' }, GAL_FILTERS.map(([kind, label]) => h('button', {
    class: `gchip${kind === g.kind ? ' on' : ''}`, 'data-kind': kind, onclick: () => galFilter(kind),
  }, label)));
  const r = S.rooms.get(g.room);
  g.el = h('div', { class: 'veil dark viewer gallery' },
    h('div', { class: 'vhead ghtop' },
      h('div', { class: 'vwho' }, h('b', {}, r ? roomTitle(r) : T('Galéria')), h('small', {}, T('Fotky a videá'))),
      g.filters, g.count,
      h('button', { class: 'vbtn', title: T('Zavrieť (Esc, Ctrl+P)'), onclick: () => closeGallery() }, icon('close'))),
    h('div', { class: 'gbody' }, g.scroller, g.stick, h('div', { class: 'grailbox' }, g.rail, g.mark, g.tip)),
    g.foot);
}

/** Sections by month: where each starts, how many rows its tiles take at the window's width. */
function galLayout() {
  const g = gal;
  const width = g.scroller.clientWidth || innerWidth - 60;
  g.width = g.scroller.clientWidth;
  g.cols = Math.max(3, Math.round(width / 150));
  g.size = width / g.cols;
  g.sections = [];
  let top = 0;
  let start = 0;
  for (const [mon, n] of g.months) {
    const rows = Math.ceil(n / g.cols);
    g.sections.push({ mon, n, start, top, rows });
    top += GAL_HEAD + rows * g.size;
    start += n;
  }
  g.height = top + 8;
  g.grid.style.height = `${g.height}px`;
  for (const el of g.shown.values()) el.remove();
  for (const el of g.heads.values()) el.remove();
  g.shown.clear();
  g.heads.clear();
  galRailDraw();
}

function galSectionOf(i) {
  const s = gal.sections;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid].start <= i) lo = mid; else hi = mid - 1; }
  return s[lo];
}
function galPos(i) {
  const sec = galSectionOf(i);
  const k = i - sec.start;
  return { sec, row: Math.floor(k / gal.cols), col: k % gal.cols, top: sec.top + GAL_HEAD + Math.floor(k / gal.cols) * gal.size, left: (k % gal.cols) * gal.size };
}

/** Puts in the tiles from a screen above to a screen below the view; the rest leave the DOM. */
function galDraw(keepSel = false) {
  const g = gal;
  if (!g?.sections || !g.el.isConnected) return;
  if (g.scroller.clientWidth !== g.width) { galLayout(); keepSel = true; } // the window changed size meanwhile
  if (g.scroller.scrollTop !== g.y) g.scroller.scrollTop = g.y; // re-attached by a render
  if (keepSel) galReveal(g.sel);
  const view = g.scroller.clientHeight || innerHeight;
  const from = g.y - view;
  const to = g.y + 2 * view;
  const want = new Set();
  const heads = new Set();
  for (const sec of g.sections) {
    const end = sec.top + GAL_HEAD + sec.rows * g.size;
    if (end < from || sec.top > to) continue;
    heads.add(sec.mon);
    if (!g.heads.has(sec.mon)) {
      const el = h('div', { class: 'ghead', style: { top: `${sec.top}px` } }, h('b', {}, galLabel(sec.mon)), h('small', {}, String(sec.n)));
      g.heads.set(sec.mon, el);
      g.grid.append(el);
    }
    const r0 = Math.max(0, Math.floor((from - sec.top - GAL_HEAD) / g.size));
    const r1 = Math.min(sec.rows - 1, Math.floor((to - sec.top - GAL_HEAD) / g.size));
    for (let row = r0; row <= r1; row++) {
      for (let col = 0; col < g.cols; col++) {
        const i = sec.start + row * g.cols + col;
        if (i < sec.start + sec.n) want.add(i);
      }
    }
  }
  for (const [mon, el] of g.heads) if (!heads.has(mon)) { el.remove(); g.heads.delete(mon); }
  for (const [i, el] of g.shown) if (!want.has(i)) { el.remove(); g.shown.delete(i); }
  // Thumbnails not yet asked for, of tiles that left: asked again when they come back.
  galQueue = galQueue.filter(([it, i]) => want.has(i) || (galThumbs.get(galKey(it)) === '' && !galThumbs.delete(galKey(it))));
  for (const i of want) {
    let el = g.shown.get(i);
    const it = g.items[i];
    if (!el) {
      const p = galPos(i);
      el = h('button', { class: `gtile${i === g.sel ? ' sel' : ''}`, 'data-i': i, tabindex: -1,
        style: { top: `${p.top}px`, left: `${p.left}px`, width: `${g.size}px`, height: `${g.size}px` },
        onclick: () => { galSelect(i); }, ondblclick: () => galOpen(i) });
      g.shown.set(i, el);
      g.grid.append(el);
    }
    if (it && !el.firstChild) {
      el.dataset.msg = it.msg;
      const url = galThumb(it, i);
      el.append(h('img', { alt: '', draggable: false, ...(url ? { src: url } : {}) }));
      // avoid-ai-design-ignore: I2 — Existing media play indicator, not navigation iconography.
      if (it.kind === 'video') el.append(h('span', { class: 'gdur' }, it.dur ? galDuration(it.dur) : '▶'));
    }
  }
  galStick();
  galFoot();
  g.mark.style.transform = `translateY(${Math.round((g.y / Math.max(1, g.height - view)) * Math.max(0, g.rail.clientHeight - 2))}px)`;
  g.count.textContent = g.total ? String(g.total) : '';
  if (!g.total) g.grid.replaceChildren(h('div', { class: 'empty' }, g.failed ? T('Galéria sa nenačítala, skús znova (Ctrl+P).') : T('V tomto chate nie sú fotky ani videá.')));
  else g.grid.querySelector(':scope > .empty')?.remove();
}

/** The month at the top stays there, pushed away by the next one's heading. */
function galStick() {
  const g = gal;
  const at = g.sections.findLast((s) => s.top <= g.y);
  if (!at || g.y <= at.top) { g.stick.hidden = true; return; }
  g.stick.hidden = false;
  if (g.stick.dataset.mon !== at.mon) {
    g.stick.dataset.mon = at.mon;
    g.stick.replaceChildren(h('b', {}, galLabel(at.mon)), h('small', {}, String(at.n)));
  }
  const next = g.sections[g.sections.indexOf(at) + 1];
  g.stick.style.transform = `translateY(${next ? Math.min(0, next.top - g.y - GAL_HEAD) : 0}px)`;
}

function galThumb(it, i) {
  const key = galKey(it);
  if (galThumbs.get(key)) return galThumbs.get(key);
  if (!galThumbs.has(key)) { galThumbs.set(key, ''); galQueue.push([it, i]); galPump(); }
  return '';
}
function galPump() {
  while (galActive < 6 && galQueue.length) {
    const [it, i] = galQueue.shift();
    const key = galKey(it);
    galActive++;
    fetch(galUrl(it, true), { headers: { Authorization: `Bearer ${S.token}` } })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!blob) { galThumbs.delete(key); return; }
        galThumbs.set(key, URL.createObjectURL(blob));
        const img = gal?.items[i] === it && gal.shown.get(i)?.querySelector('img');
        if (img) img.src = galThumbs.get(key);
        for (const [k, url] of galThumbs) { // keep the most recent 900
          if (galThumbs.size <= 900) break;
          if (url) URL.revokeObjectURL(url);
          galThumbs.delete(k);
        }
      })
      .catch(() => galThumbs.delete(key))
      .finally(() => { galActive--; galPump(); });
  }
}

function galFoot() {
  const g = gal;
  const it = g.items[g.sel];
  if (g.foot.dataset.key === (it ? galKey(it) : '')) return;
  g.foot.dataset.key = it ? galKey(it) : '';
  g.foot.replaceChildren(...(it ? [
    h('span', {}, `${fullDate(it.ts)} ${timeLabel(it.ts)}`), h('span', { class: 'gsep' }, '·'), h('b', {}, it.me ? T('Ty') : it.sender || T('Neznámy')),
    h('button', { class: 'gjump', onclick: () => galJump() }, T('Ukázať v chate'), h('kbd', {}, 'J')),
  ] : g.total ? [h('span', {}, T('Načítavam…'))] : []));
}

/** Scrolls just enough for tile i to be whole in view, below the sticky month. */
function galReveal(i) {
  const g = gal;
  if (!g.sections?.length || i >= g.total) return;
  const p = galPos(i);
  const view = g.scroller.clientHeight;
  if (p.top - GAL_HEAD < g.y) g.y = Math.max(0, p.row === 0 ? p.sec.top : p.top - GAL_HEAD);
  else if (p.top + g.size > g.y + view) g.y = p.top + g.size - view + 8;
  else return;
  g.scroller.scrollTop = g.y;
}

function galSelect(i) {
  const g = gal;
  if (!g.total) return;
  i = Math.max(0, Math.min(g.total - 1, i));
  g.shown.get(g.sel)?.classList.remove('sel');
  g.sel = i;
  g.shown.get(i)?.classList.add('sel');
  galReveal(i);
  galDraw();
}

/** Up and down keep the column, across a month's short last row too. */
function galStep(dr) {
  const g = gal;
  if (!g.sections?.length) return; // nothing to move through
  const p = galPos(g.sel);
  const idx = g.sections.indexOf(p.sec);
  let sec = p.sec;
  let row = p.row + dr;
  if (row < 0) { sec = g.sections[idx - 1]; if (!sec) return galSelect(0); row = sec.rows - 1; }
  else if (row >= sec.rows) { sec = g.sections[idx + 1]; if (!sec) return galSelect(g.total - 1); row = 0; }
  galSelect(Math.min(sec.start + sec.n - 1, sec.start + row * g.cols + p.col));
}

function galMonthStep(d) {
  const g = gal;
  if (!g.sections?.length) return; // nothing to move through
  const idx = g.sections.indexOf(galSectionOf(g.sel));
  const sec = g.sections[Math.max(0, Math.min(g.sections.length - 1, idx + d))];
  galSelect(sec.start);
  g.y = sec.top;
  g.scroller.scrollTop = g.y;
  galDraw();
}

function galFilter(kind) {
  const g = gal;
  if (g.kind === kind) return;
  g.kind = kind;
  g.sel = 0;
  g.y = 0;
  g.scroller.scrollTop = 0;
  for (const b of g.filters.children) b.classList.toggle('on', b.dataset.kind === kind);
  galLoad();
}

/** Years along the right edge, a tick per month, placed where their month is in the gallery. */
function galRailDraw() {
  const g = gal;
  const H = g.rail.clientHeight || innerHeight - 140;
  let lastY = -99;
  g.rail.replaceChildren();
  for (const sec of g.sections) {
    const y = Math.round((sec.top / Math.max(1, g.height)) * H);
    const year = sec.mon.slice(0, 4);
    const firstOfYear = g.sections.find((s) => s.mon.startsWith(year)) === sec;
    g.rail.append(h('i', { style: { top: `${y}px` } }));
    if (firstOfYear && y - lastY >= 18) {
      g.rail.append(h('button', { class: 'gyear', 'data-year': year, style: { top: `${y}px` }, tabindex: -1,
        onpointerdown: (e) => e.stopPropagation(), onclick: () => galJumpTo(sec) }, year));
      lastY = y;
    }
  }
}
function galJumpTo(sec) {
  const g = gal;
  g.y = sec.top;
  g.scroller.scrollTop = sec.top;
  galSelect(sec.start);
}
/** Click or drag along the rail: to the month under the pointer, its name beside it. */
function galRail(e) {
  const g = gal;
  const box = g.rail.getBoundingClientRect();
  const at = (ev) => {
    const y = Math.max(0, Math.min(box.height, ev.clientY - box.top));
    const sec = g.sections.findLast((s) => s.top <= (y / box.height) * g.height) || g.sections[0];
    if (!sec) return;
    g.tip.hidden = false;
    g.tip.textContent = galLabel(sec.mon);
    g.tip.style.top = `${y}px`;
    if (g.y !== sec.top) galJumpTo(sec);
  };
  g.rail.setPointerCapture(e.pointerId);
  at(e);
  g.rail.onpointermove = at;
  g.rail.onpointerup = () => { g.rail.onpointermove = null; g.tip.hidden = true; };
}

function galOpen(i = gal.sel) {
  if (!gal.items[i]) return;
  galSelect(i);
  S.overlay = { kind: 'image', gallery: true, index: i, zoom: 1, x: 0, y: 0 };
  render();
}
/** J: the gallery closes and the chat goes to that message. */
function galJump() {
  const g = gal;
  const it = g?.items[g.sel];
  const r = g && S.rooms.get(g.room);
  if (!it || !r) return;
  closeGallery(false);
  if (it.msg.startsWith('$')) jumpTo(r, it.msg);
  else jumpToArchived(r, { event_id: it.msg, origin_server_ts: it.ts, content: { body: it.body || '' } });
  render();
}

function galleryKey(e) {
  const g = gal;
  const key = e.key;
  const mod = e.ctrlKey || e.metaKey || e.altKey;
  if (mod && !(e.ctrlKey && key.toLowerCase() === 'p')) return false;
  if (key === 'ArrowLeft') galSelect(g.sel - 1);
  else if (key === 'ArrowRight') galSelect(g.sel + 1);
  else if (key === 'ArrowUp') galStep(-1);
  else if (key === 'ArrowDown') galStep(1);
  else if (key === 'Home') galSelect(0);
  else if (key === 'End') galSelect(g.total - 1);
  else if (key === 'PageUp') galMonthStep(-1);
  else if (key === 'PageDown') galMonthStep(1);
  else if (key === 'Enter' || key === ' ') galOpen();
  else if (key.toLowerCase() === 'j') galJump();
  else if (key === 'Tab') { const i = GAL_FILTERS.findIndex(([k]) => k === g.kind); galFilter(GAL_FILTERS[(i + (e.shiftKey ? 2 : 1)) % 3][0]); }
  else if (key === 'Escape' || (e.ctrlKey && key.toLowerCase() === 'p')) closeGallery();
  else return false;
  e.preventDefault();
  return true;
}
addEventListener('resize', () => { if (gal?.sections) galDraw(true); });

/** Full blob url of a gallery item, fetched once; neighbours' pictures ahead of time. */
const galFiles = new Map();
function galFile(it) {
  const key = galKey(it);
  if (!galFiles.has(key)) {
    galFiles.set(key, '');
    fetch(galUrl(it, false), { headers: { Authorization: `Bearer ${S.token}` } })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!blob) { galFiles.delete(key); return; }
        galFiles.set(key, URL.createObjectURL(blob));
        for (const [k, url] of galFiles) { if (galFiles.size <= 12) break; if (k !== key && url) URL.revokeObjectURL(url); galFiles.delete(k); }
        if (S.overlay?.gallery) render();
      })
      .catch(() => galFiles.delete(key));
  }
  return galFiles.get(key);
}

/** The viewer for a gallery item: the same as a chat's, paging in the gallery's order. */
function galleryViewerView(o) {
  const g = gal;
  const it = g?.items[o.index];
  const back = () => { S.overlay = { kind: 'gallery' }; render(); galDraw(true); };
  if (!it) return h('div', { class: 'veil dark', onclick: back }, h('div', { class: 'empty' }, T('Načítavam…')));
  for (const n of [g.items[o.index - 1], g.items[o.index + 1]]) if (n && n.kind === 'image') galFile(n);
  const full = galFile(it);
  let stage;
  if (it.kind === 'video') {
    if (full && viewerVideo?.src !== full) viewerVideo = { src: full, el: playerVideo(full) };
    stage = full ? viewerVideo.el : h('div', { class: 'empty' }, T('Načítavam…'));
  } else {
    const src = full || galThumbs.get(galKey(it));
    const fit = it.w && it.h ? Math.min(1, innerWidth * 0.94 / it.w, (innerHeight - 140) / it.h) : 0;
    stage = src ? h('img', {
      class: `vimg${o.zoom > 1 ? ' zoomed' : ''}`, src, alt: '', draggable: false,
      style: { transform: `translate(${o.x}px, ${o.y}px) scale(${o.zoom})`, ...(fit ? { width: `${Math.round(it.w * fit)}px`, height: `${Math.round(it.h * fit)}px` } : {}) },
      ondblclick: (e) => zoomAt(o, e.currentTarget, o.zoom > 1 ? 1 : 2.5, e.clientX, e.clientY),
      onpointerdown: (e) => panViewer(e, o),
    }) : h('div', { class: 'empty' }, T('Načítavam…'));
  }
  const stop = (e) => e.stopPropagation();
  const who = it.me ? T('Ty') : it.sender || T('Neznámy');
  return h('div', {
    class: 'veil dark viewer',
    onclick: (e) => { if (o.dragged) o.dragged = false; else if (e.target === e.currentTarget || e.target.classList.contains('vstage')) back(); },
    onwheel: (e) => viewerWheel(e, o),
  },
  h('div', { class: 'vhead', onclick: stop },
    avatar(null, who, 32, 'mav'),
    h('div', { class: 'vwho' }, h('b', {}, who), h('small', {}, `${dayLabel(it.ts)} ${timeLabel(it.ts)}`)),
    h('span', { class: 'vcount' }, T`${o.index + 1} z ${g.total}`),
    h('button', { class: 'vbtn', title: T('Ukázať v chate (J)'), onclick: () => { g.sel = o.index; galJump(); } }, icon('arrow-right')),
    h('button', { class: 'vbtn', title: T('Stiahnuť (Ctrl+S)'), onclick: () => viewerDownload(o) }, icon('download')),
    h('button', { class: 'vbtn', title: T('Späť do galérie (Esc)'), onclick: back }, icon('close'))),
  h('div', { class: 'vstage' }, stage, o.fast ? h('span', { class: 'vfast' }, '2×') : null),
  o.index > 0 ? h('button', { class: 'vnav vprev', title: T('Predošlý (Ctrl+←)'), onclick: (e) => { stop(e); stepViewer(-1); } }, icon('chevron-left')) : null,
  o.index < g.total - 1 ? h('button', { class: 'vnav vnext', title: T('Ďalší (Ctrl+→)'), onclick: (e) => { stop(e); stepViewer(1); } }, icon('chevron-right')) : null);
}

function bubbleView(r, m, ev, grouped, group, sug = null) {
  const mine = ev.sender === S.userId;
  const gone = isRedacted(m, ev);
  const reply = ev.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;
  const quoted = reply && m.byId.get(reply);
  const reacts = m.reactions.get(ev.event_id);
  const member = r.members.get(ev.sender);
  const acts = !(gone || ev.pending || ev.archived);
  const fail = mine && !gone ? (ev.pending ? (ev.failed ? { reason: ev.failed, sure: true } : null) : m.failed?.get(ev.event_id)) : null;
  return h('div', {
    class: `msg${mine ? ' mine' : lookClass(r, ev.sender)}${grouped ? ' grouped' : ''}${ev.pending && !fail ? ' pending' : ''}${fail ? ' failed' : ''}${S.focusEvent === ev.event_id ? ' focus' : ''}${S.actsFor === ev.event_id ? ' acts' : ''}`,
    'data-event': ev.event_id,
    oncontextmenu: (e) => {
      // Someone else's name or picture in a group: the menu offers a nickname for them.
      // A shared post or reel: anywhere on it, for Preposlať and its address.
      if (!ev.archived && !ev.pending && !gone && shareLink(contentOf(m, ev))) openMsgMenu(e, r, ev);
      else if (mine ? !ev.archived && !ev.pending && !e.target.closest('a, img, video') : !ev.archived && e.target.closest('.mname, .mav')) openMsgMenu(e, r, ev);
      else if (e.target.closest('.voice')) openMsgMenu(e, r, ev); // a voice message's menu downloads it
    },
    // Touch screens have no hover: a tap on the message shows its bar.
    onclick: (e) => { if (matchMedia('(hover: none)').matches && !e.target.closest('a, button')) { S.actsFor = S.actsFor === ev.event_id ? null : ev.event_id; render(); } },
  },
  !mine && group && !grouped ? h('div', { class: 'mname' }, memberName(r, ev.sender)) : null,
  h('div', {
    class: 'mrow',
    // The bar of reactions and actions is built when the mouse first comes to the message, not for every one.
    // A bar from before the receipts came is built again: it says who saw the message.
    onmouseenter: acts ? (e) => {
      hoverMsg = ev.event_id;
      const bar = e.currentTarget.querySelector(':scope > .macts');
      if (bar?.dataset.seq === String(receiptSeq)) return;
      bar?.remove();
      e.currentTarget.append(msgActs(r, m, ev, mine));
    } : null,
  },
    mine ? null : grouped ? h('div', { class: 'mav' }) : r.archiveOnly ? avatar(member?.avatar, memberName(r, ev.sender), 28, 'mav') : h('button', {
      class: 'mavbtn', title: T`Profil: ${memberName(r, ev.sender)}`,
      onclick: (e) => openPersonCard(e, r, ev.sender),
    }, avatar(member?.avatar, memberName(r, ev.sender), 28, 'mav')),
    // A sticker stands alone, without a bubble, as in Beeper.
    h('div', { class: `bubble${ev.type === 'm.sticker' && !gone ? ' sticker' : ''}` },
      reply && !gone ? h('button', { class: 'quote', onclick: () => jumpTo(r, reply) },
        quoted ? [h('b', {}, memberName(r, quoted.sender)), h('span', {}, messageSummary(m, quoted))] : h('span', {}, T('Odpoveď na správu'))) : null,
      bubbleBody(r, m, ev),
      inDiscordThread(r, ev.event_id) ? h('small', { class: 'mthread' }, T('vo vlákne · odpovedať sa dá len v appke Discord')) : null,
      h('span', { class: 'mtime' }, m.edits.has(ev.event_id) && !m.edits.get(ev.event_id).content?.['com.beeper.dont_render_edited'] && !gone && !POLL_START.includes(ev.type) && !pollIn(ev, ev.content) ? T('upravené · ') : '', fail ? (fail.sure ? T('neodoslané') : T('možno neodoslané')) : ev.waiting ? T('čaká na sieť') : ev.pending ? 'odosielam' : timeLabel(ev.origin_server_ts))),
    acts && (hoverMsg === ev.event_id || S.actsFor === ev.event_id) ? msgActs(r, m, ev, mine) : null),
  sug ? calSuggestion(r, ev, sug) : null,
  fail ? h('div', { class: 'lateracts failacts' },
    h('span', { class: 'failwhy' }, fail.reason),
    r.app === 'discord' && /^@discord_\d+:/.test(dmPartner(r)?.[0] || '') && /friends|priateľom/.test(fail.reason) ? h('a', { class: 'linkbtn', href: discordProfileUrl(dmPartner(r)[0].match(/^@discord_(\d+):/)[1]), target: '_blank', rel: 'noopener noreferrer' }, T('Profil v Discorde ↗')) : null,
    h('button', { onclick: () => resendFailed(r, ev) }, T('Znova odoslať')),
    h('button', { title: ev.pending ? '' : T('Zmaže ju z chatu'), onclick: () => dropFailed(r, ev) }, T('Zahodiť'))) : null,
  reacts ? h('div', { class: 'reacts' }, [...reacts].map(([key, who]) => h('button', {
    class: `react${who.includes(S.userId) ? ' me' : ''}`, title: who.map((id) => memberName(r, id)).join(', '),
    onclick: () => toggleReact(r, ev, key),
  }, key, who.length > 1 ? ` ${who.length}` : ''))) : null);
}

// The open chat's messages are kept while their room did not change (another chat's sync, more history drawn,
// the hover bar elsewhere): a render rebuilds only messages that did. Voice messages, messages still sending and
// ones waiting for a file that redraws on arrival are always built anew.
const bubbleMemo = new Map(); // event id -> { sig, el }
let bubbleMemoRoom = null;
const modelSeq = new WeakMap();
let modelSeqN = 0;
let bubbleMemoSeq = 0;
function bubbleKept(r, m, ev, grouped, group, sug = null) {
  let seq = modelSeq.get(m);
  if (!seq) modelSeq.set(m, (seq = ++modelSeqN));
  // Every kept bubble belongs to one model of one room: a new model (sync, history dropped on a gap) frees the
  // old bubbles and the history their handlers hold.
  if (bubbleMemoRoom !== r.id || bubbleMemoSeq !== seq) { bubbleMemo.clear(); bubbleMemoRoom = r.id; bubbleMemoSeq = seq; }
  const id = ev.event_id;
  const sig = `${seq}|${lookClass(r, ev.sender)}|${grouped}|${group}|${S.focusEvent === id}|${S.actsFor === id}|${hoverMsg === id}|${hoverMsg === id || S.actsFor === id ? receiptSeq : ''}|${S.focusEvent === id ? S.findQuery || '' : ''}|${!!ev.pending}|${!!ev.waiting}|${linkVer.get(id) || 0}|${sug ? calSugKey(sug) : ''}`;
  const hit = bubbleMemo.get(id);
  if (hit?.sig === sig && hit.el.isConnected) return ref(hit.el);
  mediaAwaited = false;
  const el = bubbleView(r, m, ev, grouped, group, sug);
  if (ev.pending || ev.waiting || mediaAwaited || ev.content?.msgtype === 'm.audio') { bubbleMemo.delete(id); return el; }
  const memo = { sig, el };
  el._live = (live) => { if (bubbleMemo.get(id) === memo) memo.el = live; };
  bubbleMemo.set(id, memo);
  return el;
}

/** Who saw Karchi's message `ev` and when: [[mxid, ts]], ts null when they saw it but when is not known.
 *  Someone saw it once their receipt reached it, at the time of the receipt that first did. From the archive's log
 *  (receiptLogFor); a base receipt only knows its own message's time. Without the log, the current receipt. */
function seenOf(r, ev) {
  if (ev.pending) return [];
  const at = ev.origin_server_ts;
  const tsOf = (x) => x.event_ts ?? r.events.get(x.event)?.origin_server_ts ?? -1;
  const out = [];
  for (const [id] of joinedPeople(r)) {
    const first = r.receiptLog?.find((x) => x.user === id && tsOf(x) >= at);
    if (first) { out.push([id, !first.base || first.event === ev.event_id ? first.ts : null]); continue; }
    const cur = r.events.get(r.receipts.get(id));
    if (cur && cur.origin_server_ts >= at) out.push([id, cur.event_id === ev.event_id ? r.receiptAt.get(id) || null : null]);
  }
  return out;
}
/** "Videné 14:32" in a one-to-one chat, else "Videli: Jana 14:32, Peter" with at most `most` names. */
function seenText(r, seen, partner, most) {
  const when = (ts) => (ts ? ` ${seenLabel(ts)}` : '');
  if (partner) return T`Videné${when(seen[0][1])}`;
  const names = seen.map(([id, ts]) => firstName(memberName(r, id)) + when(ts));
  return T`Videli: ${names.slice(0, most).join(', ')}${names.length > most ? T` a ďalší ${names.length - most}` : ''}`;
}
/** Compact readers, newest known read time first; all names stay available on hover and keyboard focus. */
function placeReaders(e) {
  const el = e.currentTarget;
  const anchor = el.getBoundingClientRect();
  const chat = el.closest('[data-scroll="chat"]')?.getBoundingClientRect();
  const outside = anchor.bottom <= Math.max(0, chat?.top || 0) || anchor.top >= Math.min(innerHeight, chat?.bottom ?? innerHeight);
  el.toggleAttribute('data-reader-hidden', outside);
  if (outside) { if (el.contains(document.activeElement)) document.activeElement.blur(); return; }
  const list = el.querySelector('.reader-list');
  const width = list.offsetWidth, height = list.offsetHeight;
  list.style.left = `${Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))}px`;
  const top = anchor.top >= height + 8 ? anchor.top - height : anchor.bottom;
  list.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`;
}

document.addEventListener('scroll', (e) => {
  if (e.target.matches?.('[data-scroll="chat"]')) {
    e.target.querySelectorAll('.readers:hover, .readers:focus-within').forEach((el) => placeReaders({ currentTarget: el }));
  }
}, true);

function seenView(r, seen, partner) {
  if (partner) return seenText(r, seen, partner, 1);
  const sorted = [...seen].sort((a, b) => (b[1] || 0) - (a[1] || 0));
  const el = h('span', { class: 'readers', tabindex: 0, onmouseenter: placeReaders, onfocus: placeReaders, 'aria-label': seenText(r, sorted, null, Infinity) },
    h('span', { class: 'reader-icons', 'aria-hidden': 'true' }, sorted.slice(0, 3).map(([id]) =>
      avatar(r.members.get(id)?.avatar, memberName(r, id), 24, 'reader-av')),
      sorted.length > 3 ? h('span', { class: 'reader-more' }, `+${sorted.length - 3}`) : null),
    h('span', { class: 'reader-list', role: 'tooltip' }, sorted.map(([id, ts]) => h('span', { class: 'reader-person' },
      avatar(r.members.get(id)?.avatar, memberName(r, id), 24, 'reader-av'),
      h('span', { class: 'reader-name' }, memberName(r, id)), h('time', {}, ts ? seenLabel(ts) : T('Videné'))))));
  el._live = (live) => queueMicrotask(() => {
    if (live.isConnected && live.matches(':hover, :focus-within')) placeReaders({ currentTarget: live });
  });
  return el;
}

/** Loads the archive's receipts for a chat's loaded messages (from `oldest` on): again when older ones are drawn or a
 *  receipt came, a moment later, so the archive has taken it from its own sync. */
let receiptSeq = 0;
function receiptLogFor(r, oldest) {
  if (r.receiptAsk || !S.token || Date.now() < (r.receiptRetry || 0)) return;
  if (r.receiptSince != null && oldest >= r.receiptSince && !r.receiptStale) return;
  const wait = r.receiptSince != null && r.receiptStale ? 3000 : 0;
  r.receiptAsk = true;
  r.receiptStale = false;
  setTimeout(async () => {
    try {
      const res = await fetch(`/_archive/rooms/${q(r.id)}/receipts?since=${oldest}`, { headers: { Authorization: `Bearer ${S.token}` } });
      if (!res.ok) throw new Error(res.status);
      r.receiptLog = (await res.json()).receipts;
      r.receiptSince = oldest;
      receiptSeq++;
      render();
    } catch { r.receiptRetry = Date.now() + 60e3; }
    r.receiptAsk = false;
  }, wait);
}

let hoverMsg = null; // the message whose bar the mouse last opened: a render keeps that one bar
/** The bar over a message: quick reactions, another reaction, reply, and for his own edit or delete. */
function msgActs(r, m, ev, mine) {
  const seen = mine ? seenOf(r, ev) : [];
  return h('div', { class: 'macts', 'data-seq': receiptSeq },
    seen.length ? h('span', { class: 'mseen' }, seenView(r, seen, dmPartner(r))) : null,
    quickReacts().map((key) => h('button', { class: `qr${m.ownReacts.has(`${ev.event_id}|${key}`) ? ' me' : ''}`, onclick: () => toggleReact(r, ev, key) }, key)),
    h('button', { class: 'qmore', title: T('Iná reakcia'), onclick: () => openEmoji(r, ev.event_id) }, icon('smile')),
    inDiscordThread(r, ev.event_id) ? null : h('button', {
      class: 'qreply', title: T('Odpovedať (Ctrl+R)'),
      onclick: () => { writeIn(r); S.replyTo = { room: r.id, event: ev.event_id }; S.focusComposer = true; render(); },
    }, icon('undo')),
    shareLink(contentOf(m, ev)) ? h('button', { class: 'qmenu', title: T('Preposlať…'), onclick: () => openForward(shareLink(contentOf(m, ev))) }, icon('forward')) : null,
    contentOf(m, ev).msgtype === 'm.audio' && contentOf(m, ev).url ? h('button', { class: 'qmenu', title: T('Stiahnuť hlasovku'), onclick: () => downloadVoice(r, ev, contentOf(m, ev)) }, icon('download')) : null,
    mine ? h('button', { class: 'qmenu', title: canEdit(r, m, ev) || canDelete(r, m, ev) ? T('Upraviť, odstrániť, počkať na odpoveď') : T('Počkať na odpoveď'), onclick: (e) => openMsgMenu(e, r, ev) }, icon('more-horizontal')) : null);
}

/** The reactions in the hover bar: the ones Karchi uses most, filled up with common ones. */
let quickMemo = { epoch: -1, list: [] };
function quickReacts() {
  if (quickMemo.epoch === renderEpoch) return quickMemo.list; // every message's hover bar asks during one render
  const used = new Map();
  for (const r of S.rooms.values()) {
    if (!isChat(r) || !r.model) continue;
    for (const id of r.model.ownReacts.keys()) { const key = id.slice(id.indexOf('|') + 1); used.set(key, (used.get(key) || 0) + 1); }
  }
  const top = [...used].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  // avoid-ai-design-ignore: I2 — actual reaction values, not decorative interface icons.
  const list = [...new Set([...top, '❤️', '😂', '👍', '😮', '😢', '🙏'])].slice(0, 6);
  quickMemo = { epoch: renderEpoch, list };
  return list;
}

/** Adds Karchi's reaction, or takes it back when he already gave it; shown at once, sent to the chat. */
async function toggleReact(r, ev, key) {
  const own = roomModel(r).ownReacts.get(`${ev.event_id}|${key}`);
  if (own && !own.startsWith('$')) return; // still being sent
  noteHeldReply(r);
  const txn = `ep${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const local = own
    ? { event_id: txn, type: 'm.room.redaction', redacts: own, content: { redacts: own }, sender: S.userId, origin_server_ts: Date.now() }
    : { event_id: txn, type: 'm.reaction', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: ev.event_id, key } }, sender: S.userId, origin_server_ts: Date.now() };
  r.events.set(txn, local);
  r.version++;
  render();
  try {
    const res = own
      ? await call('PUT', `/rooms/${q(r.id)}/redact/${q(own)}/${txn}`, {})
      : await call('PUT', `/rooms/${q(r.id)}/send/m.reaction/${txn}`, local.content);
    if (r.events.has(txn) && res.event_id) { r.events.delete(txn); r.events.set(res.event_id, { ...local, event_id: res.event_id }); }
  } catch {
    r.events.delete(txn);
    alert(own ? T('Reakciu sa nepodarilo zobrať späť.') : T('Reakcia sa neodoslala.'));
  }
  r.version++;
  render();
}

// ------------------------------------------------------------------ editing and deleting own messages

/** How long, and how many times, each network lets a sent message be edited or deleted (seconds; what
 *  the bridges announce in com.beeper.room_features). Discord has no limits. */
const LIMITS = {
  whatsapp: { edit: 900, delete: 172800 },
  messenger: { edit: 900, edits: 5 },
  instagram: { edit: 900, edits: 5 },
};
const ageOk = (ev, maxSec) => !maxSec || Date.now() - ev.origin_server_ts < maxSec * 1000;
function canEdit(r, m, ev) {
  const l = LIMITS[r.app] || {};
  return ev.sender === S.userId && !ev.pending && !isRedacted(m, ev) && ev.type === 'm.room.message'
    && ['m.text', 'm.emote', 'm.notice'].includes(contentOf(m, ev).msgtype) && !pollIn(ev, ev.content) && !callOf(ev) && ageOk(ev, l.edit) && !(m.editCount.get(ev.event_id) >= l.edits);
}
// A call's line is the network's record of it, not a message Karchi wrote: it is never edited or deleted from here.
const canDelete = (r, m, ev) => ev.sender === S.userId && !ev.pending && !isRedacted(m, ev) && !callOf(ev) && ageOk(ev, LIMITS[r.app]?.delete);
/** The text of a message without the quote of the message it answers (the reply fallback). */
function plainBody(c) {
  const body = c.body || '';
  if (!c['m.relates_to']?.['m.in_reply_to'] || !body.startsWith('> ')) return body;
  const lines = body.split('\n');
  const i = lines.findIndex((l) => !l.startsWith('>'));
  return lines.slice(i < 0 ? lines.length : i).join('\n').replace(/^\n/, '');
}

/** The message box takes the message's text; Enter saves the edit, Esc puts back what was being written. */
function startEdit(r, ev) {
  const m = roomModel(r);
  if (!canEdit(r, m, ev)) return;
  writeIn(r); // a merged chat edits in the message's own chat
  if (S.editing?.room !== r.id) S.editing = { room: r.id, draft: S.drafts.get(r.id) || '', picks: picked.get(r.id) };
  S.editing.event = ev.event_id;
  S.replyTo = null;
  const text = plainBody(contentOf(m, ev));
  setDraft(r.id, text);
  keepPicks(r.id, contentOf(m, ev), text);
  S.focusComposer = true;
  S.caret = text.length;
  const box = document.querySelector(`[data-root="${CSS.escape(r.id)}"]`);
  if (box) box.value = text; // render keeps a focused field's own value
  render();
}
function endEdit() {
  const e = S.editing;
  if (!e) return;
  S.editing = null;
  if (e.draft) setDraft(e.room, e.draft);
  else deleteDraft(e.room);
  if (e.picks) { picked.set(e.room, e.picks); persistDrafts(); } // the draft's own picks come back with it
  const box = document.querySelector(`[data-root="${CSS.escape(e.room)}"]`);
  if (box) box.value = e.draft;
  S.focusComposer = true;
  render();
}
async function saveEdit(r) {
  const m = roomModel(r);
  const ev = m.byId.get(S.editing?.event);
  const text = (S.drafts.get(r.id) || '').trim();
  const before = ev && plainBody(contentOf(m, ev));
  const said = textMessage(r, text, (S.drafts.get(r.id) || '').search(/\S|$/)); // before endEdit brings the draft back
  endEdit();
  if (!ev || text === before) return;
  if (!text) return deleteMessage(r, ev); // an emptied message is one to delete, as in Beeper
  const msgtype = contentOf(m, ev).msgtype;
  const content = { msgtype, body: `* ${text}`, 'm.new_content': { ...said, msgtype }, 'm.relates_to': { rel_type: 'm.replace', event_id: ev.event_id } };
  await sendLocal(r, 'm.room.message', content, T('Úprava sa neuložila.'));
}
async function deleteMessage(r, ev) {
  if (!confirm(T('Odstrániť správu pre všetkých?'))) return;
  await sendLocal(r, 'm.room.redaction', { redacts: ev.event_id }, T('Správu sa nepodarilo odstrániť.'));
}
/** Shows an edit or a deletion at once and sends it; the server's copy replaces it when it comes back. */
async function sendLocal(r, type, content, failed) {
  if (r?.archiveOnly) return;
  noteHeldReply(r);
  const txn = txnId();
  const local = { event_id: txn, type, content, sender: S.userId, origin_server_ts: Date.now(), ...(type === 'm.room.redaction' ? { redacts: content.redacts } : {}) };
  r.events.set(txn, local);
  r.version++;
  render();
  try {
    const res = type === 'm.room.redaction'
      ? await call('PUT', `/rooms/${q(r.id)}/redact/${q(content.redacts)}/${txn}`, {})
      : await call('PUT', `/rooms/${q(r.id)}/send/${type}/${txn}`, content);
    if (r.events.has(txn) && res.event_id) { r.events.delete(txn); r.events.set(res.event_id, { ...local, event_id: res.event_id }); }
  } catch {
    r.events.delete(txn);
    alert(failed);
  }
  r.version++;
  render();
}
/** Karchi's last message that can still be edited: the ↑ key in an empty message box takes it. */
function lastEditable(r) {
  const m = roomModel(r);
  return [...m.messages].reverse().find((ev) => canEdit(r, m, ev)) || null;
}
/** Karchi's last editable message in the open chat, a merged one included: [its room, the message]. */
function lastEditableIn(r) {
  const t = timelineOf(r);
  const ev = t.msgs.findLast((x) => { const xr = t.roomOf(x); return canEdit(xr, roomModel(xr), x); });
  return ev ? [t.roomOf(ev), ev] : [r, null];
}

/** The "⋯" of Karchi's own message: edit, delete. */
function openMsgMenu(e, r, ev) {
  const at = e.currentTarget.getBoundingClientRect?.();
  const o = { kind: 'msgmenu', room: r.id, event: ev.event_id, x: e.type === 'contextmenu' ? e.clientX : at.left, y: e.type === 'contextmenu' ? e.clientY : at.bottom + 4 };
  if (!msgMenuView(o)) return; // nothing to offer (a bot's name): the browser's own menu
  e.preventDefault();
  e.stopPropagation();
  S.overlay = o;
  render();
}
function msgMenuView(o) {
  const r = S.rooms.get(o.room);
  const m = r && roomModel(r);
  const ev = m?.byId.get(o.event);
  if (!ev) return null;
  const item = (glyph, label, key, fn, danger) => ctxItem(glyph, label, key, () => { S.overlay = null; render(); fn(); }, danger);
  const c = contentOf(m, ev);
  return ctxMenu(o, [
    [c.msgtype === 'm.audio' && c.url ? item(icon('download'), T('Stiahnuť hlasovku'), 'Ctrl+S', () => downloadVoice(r, ev, c)) : null],
    [canEdit(r, m, ev) ? item(icon('pencil'), T('Upraviť'), lastEditable(r) === ev ? '↑' : null, () => startEdit(r, ev)) : null,
      ev.sender === S.userId && !r.archiveOnly && !ev.archived ? item(icon('forward'), T('Keď odpíše, ukázať kamošovi…'), null, () => openRelay(r, ev)) : null,
      ev.sender !== S.userId && !isBot(ev.sender) && !dmPartner(r) ? item(icon('label'), T`Prezývka pre ${memberName(r, ev.sender)}…`, null, () => openNickFor([ev.sender], networkName(r, ev.sender))) : null],
    // A shared post or reel: the one place besides Preposlať where its address shows.
    ((link) => (link ? [item(icon('forward'), T('Preposlať…'), null, () => openForward(link)), item(icon('link'), T('Kopírovať odkaz'), null, () => copyLink(link))] : []))(isRedacted(m, ev) ? '' : shareLink(contentOf(m, ev))),
    // The one thing that reaches other people and cannot be undone: last, apart, in the error colour.
    [canDelete(r, m, ev) ? item(icon('trash'), T('Odstrániť pre všetkých'), null, () => deleteMessage(r, ev), true) : null],
  ]);
}

/** A right-click menu row: an icon() or a network's picture, the label (whole on hover when it is cut), a muted
 *  note on the right (shortcut, time). */
const ctxItem = (glyph, label, note, onclick, danger) =>
  h('button', { class: danger ? 'mi danger' : 'mi', onclick }, glyph, h('span', { class: 'ml', title: label.length > 34 ? label : null }, label), note ? h('kbd', {}, note) : null);
/** A right-click menu at the pointer, or null when it has nothing: groups of rows (null = absent), a divider between
 *  those that are not empty, kept inside the window by its height counted from its rows (32 px each, a divider 9, a
 *  note its wrapped lines, counted generously for a phone's larger font: rather a little higher than cut off). */
function ctxMenu(o, groups) {
  const close = () => { S.overlay = null; render(); };
  const parts = groups.map((g) => g.flat().filter(Boolean)).filter((g) => g.length);
  if (!parts.length) return null;
  const rows = parts.flat();
  const height = 12 + rows.reduce((n, el) => n + (el.classList.contains('mnote') ? 8 + 19 * Math.ceil(el.textContent.length / 28) : 32), 0) + 9 * (parts.length - 1);
  const x = Math.max(8, Math.min(o.x, innerWidth - Math.min(348, innerWidth - 8)));
  const y = Math.max(8, Math.min(o.y, innerHeight - height - 8));
  return h('div', { class: 'veil clear', onclick: close, oncontextmenu: (e) => { e.preventDefault(); close(); } },
    h('div', { class: 'menu ctx', style: { left: `${x}px`, top: `${y}px` }, onclick: (e) => e.stopPropagation() },
      parts.flatMap((g, i) => (i ? [h('hr'), ...g] : g))));
}

// An open chat draws its last CHAT_FIRST messages, a screenful (from the "Nové správy" line or a message search
// opened, when those are older), and more right after it is on screen; scrolling near the top draws CHAT_MORE
// older ones before asking the server for history.
const CHAT_FIRST = 15;
const CHAT_MORE = 25;
let drawnChat = null;
// Where Karchi was in each chat (by inbox key): the message at the top, how far below the top it was and where the
// chat was drawn from. Kept when he leaves the chat or it is merged, so coming back shows the same place; a chat left
// at its end opens at its end again (or on its „Nové správy“ line).
const chatSpots = new Map();
let spotWant = null; // { key, id, offset, drawFrom, tries }: the place the open chat still has to come back to
/** Index of the first message drawn in the open chat. */
function chatFrom(v, msgs) {
  if (drawnChat !== v.id) { drawnChat = v.id; v.drawFrom = spotWant?.key === v.id ? spotWant.drawFrom || null : null; v.revealOlder = false; }
  let from = v.drawFrom ? msgs.findIndex((ev) => ev.event_id === v.drawFrom) : -1;
  if (from < 0) from = Math.max(0, msgs.length - CHAT_FIRST);
  const newHere = S.newFrom && (v.rooms ? v.rooms.includes(S.newFrom.room) : S.newFrom.room === v.id);
  for (const id of [newHere && S.newFrom.event, S.focusEvent]) {
    const i = id ? msgs.findIndex((ev) => ev.event_id === id) : -1;
    if (i >= 0 && i - 10 < from) from = Math.max(0, i - 10);
  }
  // Older messages came from the server while Karchi waited at the top: they show at once.
  if (v.revealOlder && from > 0) { from = Math.max(0, from - CHAT_MORE); v.revealOlder = false; }
  v.drawFrom = msgs[from]?.event_id || null;
  return from;
}

const mergeViews = new Map(); // merge key -> what its chat shows (see timelineOf), with where it is drawn from
const oldestTs = (r) => roomModel(r).messages[0]?.origin_server_ts ?? Infinity;
/** What a chat shows: its room's messages, or a merged chat's from all its chats in time order. A chat's messages
 *  older than what another one has loaded so far wait, so the history never seems to skip a network. `holder` keeps
 *  where drawing starts (the room, or the merged chat whichever of its chats it writes to). */
function timelineOf(r) {
  const g = groupOf(r.id);
  if (!g) return { holder: r, msgs: roomModel(r).messages, roomOf: () => r, parts: [r], g: null };
  const parts = groupRooms(g);
  const key = mergeKey(g);
  let v = mergeViews.get(key);
  if (!v) mergeViews.set(key, (v = { id: key, rooms: [], models: [] }));
  const models = parts.map(roomModel);
  if (models.length !== v.models.length || models.some((m, i) => m !== v.models[i])) {
    const floor = Math.max(...parts.map((x) => (x.historyDone ? -Infinity : oldestTs(x))).filter(Number.isFinite), -Infinity);
    const roomOf = new Map();
    const msgs = [];
    parts.forEach((x, i) => { for (const ev of models[i].messages) if (ev.origin_server_ts >= floor || ev.pending) { msgs.push(ev); roomOf.set(ev.event_id, x); } });
    msgs.sort((a, b) => a.origin_server_ts - b.origin_server_ts); // stable: an album keeps its order
    Object.assign(v, { rooms: parts.map((x) => x.id), models, msgs, roomOf });
  }
  return { holder: v, msgs: v.msgs, roomOf: (ev) => v.roomOf.get(ev.event_id) || r, parts, g };
}

/** More of the chat can still be drawn or loaded: a remembered place not drawn yet may still come. */
function spotCanCome(r) {
  const t = timelineOf(r);
  return t.holder.drawFrom !== t.msgs[0]?.event_id || t.parts.some((x) => !x.historyDone);
}

/** Near the top of the open chat: older messages already here are drawn, else the server is asked for more (in a
 *  merged chat, by the chat that has loaded the least far back). */
function chatNearTop(r) {
  const t = timelineOf(r);
  const from = chatFrom(t.holder, t.msgs);
  if (from > 0) { t.holder.drawFrom = t.msgs[Math.max(0, from - CHAT_MORE)].event_id; render(); return; }
  t.holder.revealOlder = true;
  const next = t.parts.filter((x) => !x.historyDone).sort((a, b) => oldestTs(b) - oldestTs(a))[0];
  if (next) loadRoomHistory(next);
}

/** Ctrl+↓ and the floating arrow: down to the „Nové správy“ line when it is still below, else to the newest message. */
function chatToNew() {
  const box = document.querySelector('[data-scroll=chat]');
  if (!box) return;
  spotWant = null;
  const line = box.querySelector('.cnew');
  const below = line && line.getBoundingClientRect().top > box.getBoundingClientRect().bottom - 40;
  if (below) {
    box.scrollTop += line.getBoundingClientRect().top - box.getBoundingClientRect().top - parseFloat(getComputedStyle(box).paddingTop) + 8;
    S.onLine = true;
  } else {
    box.scrollTop = box.scrollHeight;
    S.onLine = false;
  }
  chatAwayCheck(box);
}
/** The floating arrow shows while the open chat is scrolled up from its end. */
function chatAwayCheck(box) {
  const away = box.scrollHeight - box.scrollTop - box.clientHeight > 200;
  if (away === S.chatAway) return;
  S.chatAway = away;
  const b = box.querySelector(':scope > .tonew button');
  if (b) b.hidden = !away;
}

/** `e`: the open chat's inbox entry; a merged one shows all of its chats and writes to `r`. */
function chatView(r, e = null) {
  const t = timelineOf(r);
  const merged = !!t.g;
  const m = roomModel(r);
  const partner = dmPartner(r);
  const app = APPS.find((a) => a.id === r.app);
  for (const x of t.parts) {
    const mx = roomModel(x);
    if (!x.historyDone && !x.loading && (mx.messages.length < 30 || mx.messages.some((ev) => ev.archivePreview))) setTimeout(() => loadRoomHistory(x));
    if (mx.messages.length) receiptLogFor(x, mx.messages[0].origin_server_ts);
  }
  const msgs = t.msgs;
  const from = chatFrom(t.holder, msgs);
  const items = [];
  let day = '';
  let prev = null;
  let last = msgs[from - 1] || null; // the message before, even across day and note rows
  let lastRoom = last && t.roomOf(last);
  let n = 0;
  // Notes older than the first drawn message are not drawn either. A merged chat is one-to-one chats: no notes.
  const notes = merged ? [] : m.notes;
  const sugs = calSuggestions(t, msgs, from);
  if (from > 0) while (n < notes.length && notes[n].ts <= last.origin_server_ts) n++;
  const notesUntil = (ts) => {
    for (; n < notes.length && notes[n].ts <= ts; n++) {
      const note = notes[n];
      if (dayLabel(note.ts) !== day) { day = dayLabel(note.ts); items.push(h('div', { class: 'cday' }, day)); }
      items.push(h('div', { class: 'cnote' }, note.text));
      prev = null;
    }
  };
  for (let i = from; i < msgs.length; i++) {
    const ev = msgs[i];
    const er = t.roomOf(ev);
    notesUntil(ev.origin_server_ts);
    // Between the end of the exports and the bridge's first message nobody has the messages: say so.
    if (last?.archived && !ev.archived && lastRoom === er && er.archiveUntil && ev.origin_server_ts - er.archiveUntil > 6 * 3600e3) {
      items.push(h('div', { class: 'cnote' }, T`Tu chýbajú správy od ${fullDate(er.archiveUntil)} do ${fullDate(ev.origin_server_ts)}`));
      prev = null;
      day = '';
    }
    const label = dayLabel(ev.origin_server_ts);
    if (label !== day) { items.push(h('div', { class: 'cday' }, label)); prev = null; }
    // An hour of silence within a day starts a new block, headed by its time.
    else if (prev && ev.origin_server_ts - prev.origin_server_ts >= 60 * 60e3) { items.push(h('div', { class: 'cday' }, timeLabel(ev.origin_server_ts))); prev = null; }
    day = label;
    // A merged chat says where the conversation goes on whenever the network changes, and where it starts.
    if (merged && er !== lastRoom) {
      items.push(h('div', { class: 'cnote via', 'data-key': `via:${ev.event_id}` }, h('img', { src: appOf(er.app)?.icon, alt: '' }), T`cez ${appOf(er.app)?.name}`));
      prev = null;
    }
    // The chat opened with unread messages: they start below this line, and the chat opens on it.
    if (S.newFrom?.room === er.id && S.newFrom.event === ev.event_id) { items.push(h('div', { class: 'cnew' }, T('Nové správy'))); prev = null; }
    const grouped = !!prev && prev.sender === ev.sender && ev.origin_server_ts - prev.origin_server_ts < 5 * 60e3;
    items.push(bubbleKept(er, roomModel(er), ev, grouped, !partner, sugs.get(ev.event_id)));
    prev = last = ev;
    lastRoom = er;
  }
  notesUntil(Infinity);
  const mineLast = msgs.findLast((ev) => ev.sender === S.userId);
  const mineRoom = mineLast && t.roomOf(mineLast);
  const seen = mineLast ? seenOf(mineRoom, mineLast) : [];
  if (seen.length) items.push(h('div', { class: 'seen' }, seenView(mineRoom, seen, dmPartner(mineRoom))));
  items.push(typingLine(t.parts, partner));
  for (const x of t.parts) items.push(...laterBubbles(x, roomModel(x)));
  items.push(...relayBar(t.parts));
  pruneGifs(r);
  const group = !partner && joinedPeople(r).length > 0;
  const held = t.parts.reduce((sum, x) => sum + roomModel(x).held, 0);
  const done = t.parts.every((x) => x.historyDone);
  const title = merged && e?.merged ? e.title : roomTitle(r);
  const apps = merged ? t.parts.map((x) => appOf(x.app)).filter((a, i, all) => a && all.indexOf(a) === i) : app ? [app] : [];
  const hint = !r.archiveOnly && mergeHints(r)[0];
  const call = callButtonTarget(r);
  return h('div', { class: `detail chat${hint ? ' hinted' : ''}` },
    // No header bar, as in Beeper: the chat's picture and name float centered above the messages.
    h('div', { class: 'chead float' },
      h('button', { class: 'back', title: T('Späť'), onclick: closeThread }, '‹'),
      h('button', {
        class: `cwho${personChat(entryOf(r.id)) ? ' person' : ''}`,
        title: group ? null : apps.map((a) => a.name).join(', '),
        // A person's picture opens their profile, the name the chat's menu.
        onclick: (ev) => {
          shutMembers();
          const x = entryOf(r.id);
          if (ev.target.closest('.av') && personChat(x)) openProfile(x); else openMenu(ev, x);
        },
        ...(group ? membersHover(r, 'head') : {}),
      }, avatar(roomAvatar(merged ? t.parts.find(roomAvatar) || r : r), title, 36), h('span', { class: 'ctitle' }, h('b', {}, title), apps.map((a) => h('img', { src: a.icon, alt: a.name })),
        group ? h('small', { title: memberCount(joinedPeople(r).length + 1) }, icon('users'), joinedPeople(r).length + 1) : null,
        isAnnouncements(r) ? h('small', { title: T('Oznamový kanál na Discorde') }, T('oznamy')) : null, '›')),
      // Beeper's prompt under the name: the same person on another network, one click to merge.
      hint ? h('div', { class: 'mergehint' },
        h('img', { src: appOf(hint.app)?.icon, alt: '' }), h('span', {}, T`Aj na ${appOf(hint.app)?.name}: `, h('b', {}, roomTitle(hint))),
        h('button', { class: 'ghost', onclick: () => mergeChats([...(t.g ? t.g.rooms : [r.id]), hint.id]) }, T('Spojiť')),
        h('button', { class: 'ghost', title: T('Neponúkať znova'), onclick: () => dismissHint(r.id, hint.id) }, T('Nie'))) : null,
      call ? h('button', { class: 'callbtn', type: 'button', title: callWhere(call.network), 'aria-label': callWhere(call.network), onclick: () => openCall(r) }, icon('phone')) : null,
      h('button', { class: 'more', title: T('Možnosti'), onclick: (ev) => openMenu(ev, entryOf(r.id)) }, '⋯')),
    h('div', { class: `msgs${chatTint(r)}`, 'data-scroll': 'chat', onscroll: (ev) => { chatAwayCheck(ev.target); if (ev.target.scrollTop < 300) chatNearTop(r); } },
      from > 0 ? h('div', { class: 'cstart' }) : done ? chatIntro(r, app, group) : h('div', { class: 'cstart' }, t.parts.some((x) => x.loading) ? T('Načítavam staršie správy…') : ''),
      items,
      heldBar(r, held === m.held ? m : { held }),
      h('div', { class: 'tonew', 'data-key': '__tonew' }, h('button', { type: 'button', title: T('Na najnovšie správy (Ctrl+↓)'), 'aria-label': T('Na najnovšie správy'), hidden: !S.chatAway, onclick: chatToNew }, icon('arrow-down'), h('kbd', {}, 'Ctrl+↓')))),
    r.archiveOnly ? archiveCompose(r) : chatCompose(r, m, merged ? t : null));
}

/* An old chat only the archive has (an export) knows its person by name alone: Instagram's export keeps a slug of
 * the display name, never the username or id, so three accounts called "paulinka" are equally likely. Weft never
 * guesses: under the old chat it shows at once whom the network can reach under that name, and one click opens
 * that person's live chat, which from then on carries the old history (linkArchived). The bridge is asked once
 * per old chat (remembered for ten minutes) and never while its login is down. Gmail and Outlook answer by mail. */
const REACH_TTL = 10 * 60e3;
const reachOf = new Map(); // old chat id -> { state: 'loading'|'done'|'down'|'error', hits, login, error, at }
/** A bridge that never answers must not leave the old chat waiting. */
const inTime = (app, promise) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error(T`${app.name} neodpovedá`)), 20e3))]);

/** The people an old chat's "Napísať" can reach, each { name, avatar, handle, room?, id? } (room: a chat exists). */
async function reachArchived(r) {
  const to = r.archiveTo;
  const app = LINKS.find((a) => a.id === to.app);
  const got = (x) => { reachOf.set(r.id, { ...x, at: Date.now() }); render(); };
  reachOf.set(r.id, { state: 'loading', at: Date.now() });
  try {
    if (S.links[app.id] === undefined) await refreshLinks();
    const logins = S.links[app.id] || [];
    const login = logins.find((l) => ['CONNECTED', 'CONNECTING', 'BACKFILLING'].includes(l.state?.state_event || 'CONNECTED'));
    if (!login) return got({ state: 'down', hits: [] });
    const ask = (method, path, body) => inTime(app, prov(app, method, `${path}${path.includes('?') ? '&' : '?'}login_id=${q(login.id)}`, body));
    const dms = dmGhosts();
    // What tells two people of one name apart: an @username, or a phone number (identifiers like "instagram:x", "tel:+421…").
    const handle = (c) => (c.identifiers || []).map(String).map((x) => (x.startsWith('tel:') ? x.slice(4) : x.includes(':') && !/:\d+$/.test(x) ? `@${x.split(':').slice(1).join(':')}` : ''))
      .find(Boolean) || '';
    const hit = (c) => ({ id: c.id, name: c.name || to.query, avatar: c.avatar_url || '', handle: handle(c), room: c.dm_room_mxid || dms.get(`${app.id}:${c.id}`) || '' });
    if (to.id) {
      // WhatsApp keeps the person's number: exactly one, no choice to make.
      const c = await ask('GET', `/resolve_identifier/${q(to.id)}`);
      return got({ state: 'done', login: login.id, hits: [hit({ ...c, id: c.id || to.id })] });
    }
    const same = (name) => norm(name || '').trim() === norm(r.bridgeName || to.query).trim();
    // Live chats Karchi already has under that name, then whoever else the network finds under it.
    const named = [...S.rooms.values()].filter((x) => x.app === app.id && !x.archiveOnly && isChat(x) && dmPartner(x) && same(memberName(x, dmPartner(x)[0])))
      .map((x) => ({ id: ghostKey(dmPartner(x)[0])?.split(':').slice(1).join(':') || '', name: roomTitle(x), avatar: roomAvatar(x) || '', handle: '', room: x.id }));
    const search = async (query) => (await ask('POST', '/search_users', { query })).results?.filter((c) => same(c.name)) || [];
    // The export's folder is the name without accents and spaces, often not the username: then the name itself.
    let results = await search(to.query);
    const title = (r.bridgeName || '').trim();
    if (!results.length && title && title !== to.query) results = await search(title);
    const found = results.map(hit).filter((c) => !named.some((n) => n.room && n.room === c.room));
    return got({ state: 'done', login: login.id, hits: [...named, ...found].slice(0, 6) });
  } catch (err) {
    return got({ state: /not logged in|NOT_LOGGED_IN|login not found/i.test(`${err.message} ${err.errcode || ''}`) ? 'down' : 'error', hits: [], error: err.message });
  }
}

/** Under an old chat only the archive has: whom to write to (at once, one click each), or why there is nobody. */
function archiveCompose(r) {
  const to = r.archiveTo;
  const app = to && APPS.find((a) => a.id === to.app);
  if (!app && r.app === 'discord') return discordCompose(r);
  if (!app) return h('div', { class: 'cnote' }, T('Uložená história · iba na čítanie'));
  if (MAIL_APPS.includes(to.app)) {
    // Only from the app the thread came to: an Outlook thread is never answered from Gmail.
    if (!mailAccounts().some((l) => l.app.id === to.app)) return h('div', { class: 'cnote' }, T`Odpovedať mailom sa dá po pripojení ${app.name} v Nastaveniach → Účty.`);
    return h('div', { class: 'cnote' }, h('button', { class: 'primary', onclick: () => writeArchived(r) }, T('Odpovedať mailom')));
  }
  const reach = reachOf.get(r.id);
  if (!reach || (reach.state !== 'loading' && Date.now() - reach.at > REACH_TTL)) {
    if (S.selected === r.id) queueMicrotask(() => S.selected === r.id && reachOf.get(r.id)?.state !== 'loading' && reachArchived(r));
    return h('div', { class: 'cnote reach' }, T`Hľadám, komu napísať cez ${app.name}…`);
  }
  const again = h('button', { class: 'linkbtn', onclick: () => { reachOf.delete(r.id); render(); } }, T('Skúsiť znova'));
  const other = h('button', { class: 'linkbtn', onclick: () => writeOther(r) }, T('Hľadať inak'));
  if (reach.state === 'loading') return h('div', { class: 'cnote reach' }, T`Hľadám, komu napísať cez ${app.name}…`);
  if (reach.state === 'down') {
    return h('div', { class: 'cnote reach' }, T`${app.name} je odpojený, nikomu sa teraz napísať nedá. `,
      h('button', { class: 'linkbtn', onclick: () => togglePanel('settings', 'accounts') }, T('Nastavenia → Účty')), ' · ', again);
  }
  if (reach.state === 'error') return h('div', { class: 'cnote reach' }, T`Nepodarilo sa nájsť, komu napísať: ${reach.error}. `, again);
  if (!reach.hits.length) {
    return h('div', { class: 'cnote reach' }, T`${app.name} nenašiel nikoho s menom „${r.bridgeName || to.query}“. `, other);
  }
  const many = reach.hits.length > 1;
  return h('div', { class: 'reach' },
    h('small', {}, many ? T`Napísať cez ${app.name} — rovnaké meno má ${reach.hits.length} ľudí, vyber toho pravého:` : T`Napísať cez ${app.name}:`),
    h('div', { class: 'reachlist' }, reach.hits.map((c) => h('button', {
      class: 'reachrow', 'data-key': c.room || c.id, disabled: !!r.reaching, onclick: () => writeTo(r, c),
    },
      avatar(c.avatar, c.name, 28),
      h('span', {}, h('b', {}, c.name), h('small', {}, [c.handle, c.room ? T('už máte chat') : T('nový chat')].filter(Boolean).join(' · ')))))),
    many ? h('small', {}, T('Nie je medzi nimi? '), other) : null,
    r.reaching ? h('small', {}, r.reaching) : null);
}

// ------------------------------------------------------------------ Discord without the bridge's limits

/* The Discord bridge opens only the newest 5 DMs at its start and others when a new message comes. The archive reads
 * the bridge's database (server/archive/discord_weft.py): Karchi's DM and group channels, and opens one of them on a
 * click through the bridge's own command. Nothing here writes to Discord; the bridge reads the channel (two GETs). */
const dc = { dms: null, channels: null, at: 0, failed: false, loading: null, opening: new Set(), people: new Map(), names: new Map() };
const archiveGet = async (path) => {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${S.token}` }, signal: AbortSignal.timeout(20e3) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || T`archív odpovedal ${res.status}`), { status: res.status });
  return body;
};
/** Karchi's Discord DMs and the type of each bridged channel, at most once in five minutes (`force`: now). */
function loadDiscord(force = false) {
  if (!S.links.discord?.length && !S.rooms.size) return Promise.resolve();
  if (dc.loading) return dc.loading;
  if (!force && Date.now() - dc.at < 5 * 60e3) return Promise.resolve();
  dc.loading = Promise.all([archiveGet('/_archive/discord/dms'), archiveGet('/_archive/discord/channels')]).then(([d, c]) => {
    dc.dms = d.dms || [];
    dc.channels = c.channels || {};
    dc.at = Date.now();
    dc.failed = false;
    for (const [room, ch] of Object.entries(dc.channels)) {
      const r = S.rooms.get(room);
      if (r && r.dcType !== ch.type) { r.dcType = ch.type; r.version++; }
    }
    refresh();
  }).catch(() => {
    // An archive without these endpoints (older deploy) or without the bridge's database: ask again in a minute.
    dc.at = Date.now() - 4 * 60e3;
    if (!dc.failed) { dc.failed = true; refresh(); }
  }).finally(() => { dc.loading = null; });
  return dc.loading;
}
/** A Discord announcement channel; also a room that came after the last load (it is drawn new, so it reads this). */
const isAnnouncements = (r) => !!r && (r.dcType ?? dc.channels?.[r.id]?.type) === DC_ANNOUNCEMENTS;
/** The Discord channel an old chat of the archive is, when it is one of Karchi's DMs or groups. */
const dmOfArchive = (r) => dc.dms?.find((x) => x.chat && `archive:${x.chat}` === r.id) || null;
const discordProfileUrl = (user) => `https://discord.com/users/${encodeURIComponent(user)}`;
const discordChannel = (channel) => `https://discord.com/channels/@me/${encodeURIComponent(channel)}`;

/** Under an old Discord chat: open it as a live chat (one click, one chat), or why not. */
function discordCompose(r) {
  if (dc.dms === null) {
    loadDiscord();
    return h('div', { class: 'cnote' }, dc.failed ? T('Starý chat z Discordu · iba na čítanie. Archív teraz nevie povedať, či sa dá otvoriť.') : T('Zisťujem, či sa dá chat otvoriť…'));
  }
  const x = dmOfArchive(r);
  if (!x) return h('div', { class: 'cnote' }, T('Starý chat z Discordu · iba na čítanie. Most tento kanál nepozná.'));
  const busy = dc.opening.has(x.channel);
  return h('div', { class: 'reach' },
    h('small', {}, x.type === 'group' ? T('Stará skupina z Discordu. Otvorením sa z nej stane živý chat s poslednými správami.')
      : T('Starý chat z Discordu. Otvorením sa z neho stane živý chat s poslednými správami; písať sa dá priateľom.')),
    h('div', { class: 'row' },
      h('button', { class: 'primary', disabled: busy, onclick: () => openDiscord(x, r.id) }, busy ? T('Otváram chat…') : T('Otvoriť chat')),
      h('a', { class: 'linkbtn', href: discordChannel(x.channel), target: '_blank', rel: 'noopener noreferrer' }, T('Otvoriť v Discorde ↗'))));
}

/** Ctrl+N's Discord people. A bridge with Weft's patch (GET /v1/contacts, server/bridges/discord-weft.patch) gives
 *  friends and DM partners with their friendship; the stock bridge (404) or one still connecting (503) leaves only
 *  the archive's DMs without a room. A DM channel opens through the archive; a friend without one (a new DM would
 *  write to Discord) gets his profile in the Discord app. */
const FRIENDSHIP = { friend: () => T('priateľ'), outgoing: () => T('žiadosť odoslaná'), incoming: () => T('chce byť priateľ'), none: () => T('nie ste priatelia'), blocked: () => T('zablokovaný') };
async function discordContacts() {
  if (!S.links.discord?.length) return [];
  const [, bridged] = await Promise.all([loadDiscord(), call('GET', '/contacts', undefined, LINKS.find((a) => a.id === 'discord').legacy).catch(() => null)]);
  const byChannel = new Map((dc.dms || []).map((x) => [x.channel, x]));
  if (!Array.isArray(bridged?.contacts)) {
    return (dc.dms || []).filter((x) => x.type === 'dm' && !x.room && !x.bot && x.user)
      .map((x) => ({ id: x.user, name: x.name || x.username, app: 'discord', discord: x }));
  }
  return bridged.contacts.filter((c) => typeof c?.id === 'string' && !c.bot && FRIENDSHIP[c.relationship]).map((c) => {
    // A room Weft has is that chat; a DM channel without one (or one Karchi is not in) opens through the archive.
    const room = c.dm_room_mxid && S.rooms.has(c.dm_room_mxid) ? c.dm_room_mxid : '';
    const open = room ? {} : c.dm_channel && c.relationship !== 'blocked' ? { discord: byChannel.get(c.dm_channel) || { channel: c.dm_channel, type: 'dm' } } : { discordProfile: c.id };
    return { id: c.id, name: c.name || c.username || c.id, app: 'discord', dm_room_mxid: room, note: FRIENDSHIP[c.relationship](), ...open };
  });
}

/** One of Karchi's Discord channels as a live room: the archive asks the bridge (once) and waits for the room.
 *  `archived`: the old chat whose history then belongs to it. */
async function openDiscord(x, archived = null) {
  if (dc.opening.has(x.channel)) return;
  dc.opening.add(x.channel);
  const from = S.selected; // the chat open now: if Karchi stays there, the opened one replaces it
  render();
  try {
    const res = await fetch('/_archive/discord/open', {
      method: 'POST', headers: { Authorization: `Bearer ${S.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: x.channel }),
      signal: AbortSignal.timeout(40e3),
    }).catch((err) => { throw new Error(err.name === 'TimeoutError' ? T('archív neodpovedá') : err.message); });
    const body = await res.json().catch(() => ({}));
    if (res.status === 202) return alert(body.state === 'busy' ? T('Práve sa otvára iný chat z Discordu. Skús to o chvíľu.') : T('Chat sa ešte otvára. Skús to o minútu znova.'));
    if (res.status === 409 && body.error === 'not_joined') {
      if (confirm(T('Tento chat most už má, ale ty v ňom nie si. Otvoriť ho v appke Discord?'))) window.open(discordChannel(x.channel), '_blank', 'noopener');
      return;
    }
    if (res.status === 404) throw new Error(T('tento chat nie je medzi tvojimi chatmi na Discorde'));
    if (res.status === 502) throw new Error(T('most alebo server neodpovedá'));
    if (res.status === 409 && body.error === 'the bridge has other accounts') throw new Error(T('skupinu Weft neotvorí, kým je v moste prihlásený aj iný účet Discordu'));
    if (!res.ok || !body.room) throw new Error(res.status === 409 ? T('most nemá správcovskú miestnosť') : body.error || T`archív odpovedal ${res.status}`);
    x.room = body.room;
    const room = archived ? await linkArchived(archived, body.room) : body.room;
    if (S.selected === from && S.selected !== room) { select(room); S.focusComposer = true; }
    loadDiscord(true);
  } catch (err) {
    alert(T`Chat sa nepodarilo otvoriť: ${err.message}`);
  } finally {
    dc.opening.delete(x.channel);
    render();
  }
}

/** One click under an old chat: that person's live chat (found, or started once), with the old history in it. */
async function writeTo(r, c) {
  if (r.reaching) return;
  const app = LINKS.find((a) => a.id === r.archiveTo.app);
  r.reaching = T('Otváram chat…');
  render();
  try {
    let room = c.room;
    if (!room) {
      // The account that found the person opens the chat: with two accounts on one network, never the other one.
      const login = reachOf.get(r.id)?.login;
      if (!login) throw new Error(T`${app.name} nie je pripojený`);
      room = (await inTime(app, prov(app, 'POST', `/create_dm/${q(c.id)}?login_id=${q(login)}`))).dm_room_mxid;
    }
    if (!room) throw new Error(T('most nevrátil chat'));
    const linked = await linkArchived(r.id, room);
    if (linked !== room) alert(T('Táto stará história už bola pripojená k inému chatu (napr. v inom okne), otváram ten.'));
  } catch (err) {
    // The account that found the person went away since: look again with the accounts there are now.
    if (/not logged in|NOT_LOGGED_IN|login not found/i.test(`${err.message} ${err.errcode || ''}`)) { S.links[app.id] = undefined; reachOf.delete(r.id); }
    alert(T`Chat sa nepodarilo otvoriť: ${err.message}`);
  } finally {
    r.reaching = null;
    render();
  }
}

/** The person is not among those found: Ctrl+N with that name, its network one Enter away. */
function writeOther(r) {
  const hits = reachOf.get(r.id)?.hits || [];
  openOverlay('new', { contacts: [], found: hits.filter((c) => c.id).map((c) => ({ id: c.id, name: c.name, avatar_url: c.avatar, dm_room_mxid: c.room, app: r.archiveTo.app })),
    query: r.bridgeName || r.archiveTo.query, link: r.id });
  loadContacts(S.overlay);
}

/** A mail thread (Gmail, Outlook): a reply by mail to its newest sender, from the account it came to. */
function writeArchived(r) {
  const to = r.archiveTo;
  const ofApp = mailAccounts().filter((l) => l.app.id === to.app);
  const from = ofApp.find((l) => l.name === to.account || l.id === to.account) || ofApp[0];
  if (!from) return;
  return openMail(to.mail, to.subject, from.key);
}

/** The old chat's history now belongs to the live room: the archive pages it under that room, and the old chat
 *  leaves search. Undo on asus: `archive.py unlink <chat>`. */
async function linkArchived(id, room) {
  const res = await fetch('/_archive/chats/link', {
    method: 'POST', headers: { Authorization: `Bearer ${S.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ chat: id, room }),
    signal: AbortSignal.timeout(20e3),
  }).catch((err) => { throw new Error(err.name === 'TimeoutError' ? T('archív neodpovedá') : err.message); });
  const body = await res.json().catch(() => ({}));
  // Linked already (another window did it): go to the room it was linked to, if that chat is still here.
  if (res.status === 409 && body.room && body.room !== room && !S.rooms.has(body.room)) throw new Error(T('stará história je už pripojená k chatu, ktorý tu už nie je'));
  if (res.status === 409 && body.room) room = body.room;
  else if (res.status === 409) throw new Error(T('táto stará história k tomuto chatu nepatrí, nič sa nepresunulo'));
  else if (res.status === 503) throw new Error(T('archív teraz nevie prečítať most Discordu, nič sa nepresunulo. Skús to o chvíľu.'));
  else if (!res.ok) throw new Error(body.error || T`archív odpovedal ${res.status}`);
  const live = S.rooms.get(room);
  if (live) { live.historyDone = false; live.archiveRetry = 0; }
  if (S.selected === id) { select(room); S.focusComposer = true; }
  S.rooms.delete(id);
  refreshArchiveChats(true);
  render();
  return room;
}

/** The top of a chat whose whole history is loaded: who it is with, the way Messenger opens a conversation. */
function chatIntro(r, app, group) {
  const people = joinedPeople(r);
  return h('div', { class: 'cintro' },
    avatar(roomAvatar(r), roomTitle(r), 48), // the header's thumbnail, already loaded; CSS draws it larger
    h('b', {}, roomTitle(r)),
    h('small', {}, app ? h('img', { src: app.icon, alt: '' }) : null, app?.name || 'Chat'),
    group ? h('button', { class: 'cmembers', onclick: (e) => clickMembers(r, e.currentTarget), ...membersHover(r, 'intro') },
      h('span', { class: 'stack' }, membersSorted(r).slice(0, 5).map((p) => avatar(p.avatar, p.name, 24))),
      memberCount(people.length + 1)) : null);
}
const memberCount = (n) => `${n} ${n === 1 ? T('člen') : n < 5 ? T('členovia') : T('členov')}`;

// A group's members, opened by resting the mouse on its name or member line, as in Beeper. The list stays
// open while the mouse is on it, so a member can be clicked. It lives outside #app: the redraw on every
// sync would otherwise throw it away under the cursor.
let membersPop = null; // { room, el }
let openTimer = 0;
let closeTimer = 0;
let openFor = null; // the room whose list opens once the mouse has rested
let shutAt = null; // where the mouse was when the list was closed on purpose: no reopening until it moves
const canHover = matchMedia('(hover: hover)');
let mouseAt = { x: -1, y: -1 };
const within = (el, x, y) => { const b = el?.getBoundingClientRect(); return !!b && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom; };
// A list opened by hovering closes once the mouse is off both the name and the list. Watched here rather than
// by mouseleave, which a redraw of the name under the resting mouse can swallow.
document.addEventListener('mousemove', (e) => {
  mouseAt = { x: e.clientX, y: e.clientY };
  if (!membersPop?.hover) return;
  if (within(membersPop.el, e.clientX, e.clientY) || within(document.querySelector(`[data-members="${membersPop.where}"]`), e.clientX, e.clientY)) {
    clearTimeout(closeTimer);
    closeTimer = 0;
  } else if (!closeTimer) closeTimer = setTimeout(closeMembers, 250);
}, { capture: true, passive: true });
function membersHover(r, where) {
  return {
    'data-members': where,
    onmouseenter: (e) => {
      clearTimeout(closeTimer);
      closeTimer = 0;
      // A redraw puts a new element under the resting mouse: the wait already running goes on.
      const still = shutAt && shutAt.x === mouseAt.x && shutAt.y === mouseAt.y;
      if (!canHover.matches || membersPop?.room === r.id || openFor === r.id || still) return;
      const el = e.currentTarget;
      openFor = r.id;
      openTimer = setTimeout(() => { openFor = null; openMembers(r, el, true); }, 350);
    },
    // A redraw takes the element from under the mouse and the browser calls that leaving: the mouse stayed.
    onmouseleave: (e) => { if (e.currentTarget.isConnected) leaveMembers(); },
  };
}
function leaveMembers() {
  clearTimeout(openTimer);
  openFor = null;
  if (membersPop) closeTimer = setTimeout(closeMembers, 250);
}
/** A click opens the list at once (a touch screen has no resting mouse); one already open stays. */
function clickMembers(r, el) {
  clearTimeout(openTimer);
  openFor = null;
  if (membersPop?.room !== r.id) openMembers(r, el);
}
/** Esc, a wheel turn, a member or the chat's menu clicked: a redraw puts a new name under the resting mouse,
 *  which must not open the list again until the mouse moves. */
function shutMembers() {
  shutAt = { ...mouseAt };
  closeMembers();
}
function closeMembers() {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  closeTimer = 0;
  openFor = null;
  membersPop?.el.remove();
  membersPop = null;
}
/** A group's members by name: the order of the list and of the faces under the group's name. */
const membersSorted = (r) => joinedPeople(r).map(([id, mem]) => ({ id, avatar: mem.avatar, name: memberName(r, id) }))
  .sort((a, b) => a.name.localeCompare(b.name, 'sk'));
function openMembers(r, anchor, hovered, focus) {
  // A sync may have redrawn the chat since the mouse came: the same spot in the new page.
  if (!anchor.isConnected) anchor = document.querySelector(`[data-members="${anchor.dataset.members}"]`);
  if (!anchor || S.selected !== r.id || S.overlay) return;
  const at = anchor.getBoundingClientRect();
  if (hovered && !within(anchor, mouseAt.x, mouseAt.y)) return;
  closeMembers();
  const people = membersSorted(r);
  const el = h('div', {
    class: 'mpop', onmouseenter: () => { clearTimeout(closeTimer); closeTimer = 0; }, onmouseleave: leaveMembers,
    onkeydown: (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const rows = [...el.querySelectorAll('button.mprow')];
      const i = rows.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1);
      rows[(i + rows.length) % rows.length]?.focus();
    },
  },
    h('div', { class: 'mphead' }, memberCount(people.length + 1)),
    h('div', { class: 'mplist' },
      people.map((p) => (canOpenMember(r, p.id)
        ? h('button', { class: 'mprow', title: T`Otvoriť chat s: ${p.name}`, onclick: (e) => openMember(r, p.id, e.currentTarget) }, avatar(p.avatar, p.name, 28), h('span', {}, p.name))
        : h('div', { class: 'mprow off', title: T`Chat s ${p.name} sa z Weftu založiť nedá` }, avatar(p.avatar, p.name, 28), h('span', {}, p.name)))),
      h('div', { class: 'mprow me' }, avatar(r.members.get(S.userId)?.avatar, T('Ty'), 28), h('span', {}, T('Ty')))));
  document.body.append(el);
  membersPop = { room: r.id, el, hover: !!hovered, where: anchor.dataset.members };
  const left = Math.max(8, Math.min(at.left + at.width / 2 - el.offsetWidth / 2, innerWidth - el.offsetWidth - 8));
  const below = at.bottom + 6;
  const top = below + el.offsetHeight <= innerHeight - 8 ? below : Math.max(8, at.top - 6 - el.offsetHeight);
  Object.assign(el.style, { left: `${left}px`, top: `${top}px` });
  if (focus) el.querySelector('button.mprow')?.focus();
}
document.addEventListener('pointerdown', (e) => {
  if (membersPop && !membersPop.el.contains(e.target) && !e.target.closest?.('[data-members]')) closeMembers();
}, true);
// The list stays where it opened, so turning the wheel elsewhere or resizing the window closes it.
addEventListener('resize', () => closeMembers());
document.addEventListener('wheel', (e) => { if (membersPop && !membersPop.el.contains(e.target)) shutMembers(); }, { capture: true, passive: true });

/** A member's one-to-one chat in the same network, if Karchi has one. */
const memberDm = (r, id) => [...S.rooms.values()].find((x) => x.app === r.app && isChat(x) && dmPartner(x)?.[0] === id);
/** The bridge and network id behind a member's ghost (`@whatsapp_lid-123:…` → whatsapp, lid-123), for the
 *  bridges that find and start chats; WhatsApp names group members by LID and DMs by phone, so only the bridge
 *  can tell whether a chat with them exists. */
function memberStart(r, id) {
  const m = id.match(/^@(facebook|instagram|whatsapp|teams)_([a-z0-9-]+):/);
  const app = m && { facebook: 'messenger', instagram: 'instagram', whatsapp: 'whatsapp', teams: 'teams' }[m[1]];
  return app === r.app && S.links[app]?.length ? { app, id: m[2] } : null;
}
/** Whether clicking a member can lead to a chat with them; a row that cannot is not offered as a button. */
const canOpenMember = (r, id) => !!(memberDm(r, id) || memberStart(r, id));

let memberAsk = 0; // the latest member click waiting for its bridge; an older answer is dropped
/** A member clicked in a group: the one-to-one chat with them, started on the bridge when there is none yet. */
async function openMember(r, id, row) {
  const dm = memberDm(r, id);
  const start = !dm && memberStart(r, id);
  if (!dm && !start) return;
  if (dm) { shutMembers(); return startChat({ key: dm.id }); }
  // Asking first creates nothing: it finds the chat Karchi already has under another id. WhatsApp can take
  // seconds, so the row says so and the list stays until the answer.
  const ask = ++memberAsk;
  row?.classList.add('busy');
  if (row) row.lastChild.textContent += T(' · hľadám chat…');
  const app = LINKS.find((a) => a.id === start.app);
  let found;
  try {
    found = await prov(app, 'GET', `/resolve_identifier/${q(start.id)}`);
  } catch (err) {
    if (ask === memberAsk && S.selected === r.id) { shutMembers(); alert(T`Chat sa nepodarilo nájsť: ${err.message}`); }
    return;
  }
  // Karchi moved on (another chat, another member): this answer is no longer wanted.
  if (ask !== memberAsk || S.selected !== r.id) return;
  shutMembers();
  startChat({ app: start.app, contact: { id: found.id || start.id, dm_room_mxid: found.dm_room_mxid } });
}

/** The network a merged chat writes through, beside the message box; a click goes to the next one. */
function viaSwitch(r, t) {
  if (!t || t.parts.length < 2) return null;
  const i = t.parts.indexOf(r);
  const next = t.parts[(i + 1) % t.parts.length];
  const app = appOf(r.app);
  return h('button', {
    class: 'viasw', title: T`Odíde cez ${app?.name} · klik: cez ${appOf(next.app)?.name}`, 'aria-label': T`Odoslať cez ${app?.name}, zmeniť`,
    onclick: () => switchVia({ merged: t.g }, next.id),
  }, h('img', { src: app?.icon, alt: '' }), h('span', {}, app?.name));
}

/** `t`: a merged chat's timeline (timelineOf); its composer writes to `r` and can switch to another of its chats. */
function chatCompose(r, m, t = null) {
  const editing = S.editing?.room === r.id ? m.byId.get(S.editing.event) : null;
  const reply = S.replyTo?.room === r.id ? m.byId.get(S.replyTo.event) : null;
  const files = S.attach.get(r.id) || [];
  const area = h('textarea', {
    rows: 1,
    value: S.drafts.get(r.id) || '',
    placeholder: T('Napíš správu…'),
    'data-root': r.id,
    oninput: (e) => {
      const was = slashWord(S.drafts.get(r.id) || '');
      setDraft(r.id, e.target.value);
      renderSoon();
      if (!e.target.value.trim() && !(S.attach.get(r.id) || []).length) { boxFrom.delete(r.id); doneBoxStash(r.id); }
      if (!e.target.value.trim()) picked.delete(r.id); // an emptied box forgets who its names were
      autosize(e.target);
      const word = colonWord(e.target.value, e.target.selectionStart);
      const colonWas = S.colon?.room === r.id ? S.colon.word : '';
      S.colon = word ? { room: r.id, word, at: e.target.selectionStart, index: 0 } : null;
      const who = canMention(r) ? atWord(e.target.value, e.target.selectionStart) : null;
      const whoWas = S.mention?.room === r.id ? S.mention.word : null;
      S.mention = who != null ? { room: r.id, word: who, at: e.target.selectionStart, index: 0 } : null;
      // The lists of commands, emoji and people follow what is typed.
      if (slashWord(e.target.value) !== was || word !== colonWas || who !== whoWas) render();
    },
    onkeydown: (e) => {
      const draft = S.drafts.get(r.id) || '';
      const found = colonHits(r);
      if (found.length) {
        const c = S.colon;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); c.index = (c.index + (e.key === 'ArrowDown' ? 1 : -1) + found.length) % found.length; render(); return; }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); useColon(r, found[c.index] || found[0]); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); c.off = true; render(); return; }
        if (/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) { S.colon = null; renderSoon(); } // the cursor leaves the word
      }
      const people = mentionHits(r);
      if (people.length) {
        const a = S.mention;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); a.index = (a.index + (e.key === 'ArrowDown' ? 1 : -1) + people.length) % people.length; render(); return; }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey)) { e.preventDefault(); useMention(r, (people[a.index] || people[0]).id); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); a.off = true; render(); return; }
        if (/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) { S.mention = null; renderSoon(); }
      }
      const hits = slashHits(draft);
      if (e.key === 'Tab' && hits.length) { e.preventDefault(); useSlash(r, hits[0]); return; }
      // ↑ in an empty box edits Karchi's last message, as in Beeper.
      if (e.key === 'ArrowUp' && !e.target.value && !files.length && !S.editing) {
        const [lr, last] = lastEditableIn(r);
        if (last) { e.preventDefault(); startEdit(lr, last); }
        return;
      }
      if (e.key !== 'Enter' || (e.shiftKey && !e.ctrlKey && !e.metaKey) || e.altKey) return;
      e.preventDefault();
      if (e.repeat) return; // a held Enter (one that picked a chat a moment ago) sends nothing
      if (editing) return saveEdit(r);
      // A command is the first word: what follows it is the message, or for /gif what to look for.
      const cmd = SLASH.find(([name]) => new RegExp(`^/${name}(\\s|$)`, 'i').test(draft.trim()));
      if (cmd) {
        const rest = draft.trim().slice(cmd[0].length + 1).trim();
        if (cmd[0] === 'gif') { deleteDraft(r.id); return openGifs(r, rest); }
        setDraft(r.id, rest);
        return openLater(r);
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) return openLater(r); // Ctrl+Shift+Enter: send later
      // Ctrl+Enter sends and archives the chat, as in Beeper.
      const archive = e.ctrlKey || e.metaKey;
      sendChat(r).then(() => archive && toggleArchive(entryOf(r.id)));
    },
  });
  const hits = slashHits(S.drafts.get(r.id) || '');
  const found = colonHits(r);
  const people = mentionHits(r);
  return h('div', { class: 'ccompose' },
    people.length ? h('div', { class: 'slash mentions' }, people.map(({ id, server }, i) => h('button', {
      class: `res mini${i === S.mention.index ? ' on' : ''}`, 'data-key': id, onmousedown: (ev) => ev.preventDefault(), onclick: () => useMention(r, id),
    }, avatar(r.members.get(id)?.avatar, mentionLabel(r, id), 28),
    h('div', { class: 'rmeta' }, h('b', {}, mentionLabel(r, id), mentionHint(r, id, server))),
    i === S.mention.index ? h('kbd', {}, 'Tab') : null))) : null,
    hits.length ? h('div', { class: 'slash' }, hits.map(([name, hint], i) => h('button', { class: `res mini${i === 0 ? ' on' : ''}`, onclick: () => useSlash(r, [name]) },
      h('div', { class: 'rmeta' }, h('b', {}, `/${name}`, h('small', {}, hint))), i === 0 ? h('kbd', {}, 'Tab') : null))) : null,
    found.length ? h('div', { class: 'slash' }, found.map((e, i) => h('button', { class: `res mini${i === S.colon.index ? ' on' : ''}`, onmousedown: (ev) => ev.preventDefault(), onclick: () => useColon(r, e) },
      h('span', { class: 'eico' }, e), h('div', { class: 'rmeta' }, h('b', {}, emojiNameOf(e))), i === S.colon.index ? h('kbd', {}, 'Tab') : null))) : null,
    S.scheduling === r.id ? h('div', { class: 'replybar' }, h('span', {}, T('Nahrávam prílohy a plánujem…'))) : null,
    editing ? h('div', { class: 'replybar' },
      h('span', {}, h('b', {}, T('Upravuješ správu')), T(' · Enter uloží, Esc zruší')),
      h('button', { class: 'ghost', title: T('Zrušiť (Esc)'), onclick: endEdit }, icon('close'))) : null,
    reply ? h('div', { class: 'replybar' },
      h('span', {}, T('Odpovedáš '), h('b', {}, memberName(r, reply.sender)), ': ', messageSummary(m, reply)),
      h('button', { class: 'ghost', title: T('Zrušiť (Esc)'), onclick: () => { S.replyTo = null; render(); } }, icon('close'))) : null,
    stashView(r),
    files.length && boxFrom.get(r.id) ? h('div', { class: 'replybar relayfrom' }, h('span', {}, boxFrom.get(r.id))) : null,
    files.length ? h('div', { class: 'atts' }, files.map((f) => h('div', { class: `att${f.type.startsWith('image/') ? ' pic' : ''}`, title: `${f.name} · ${fileSize(f.size)}` },
      f.type.startsWith('image/') ? h('img', { src: localUrl(f), alt: f.name }) : [h('b', {}, f.name), h('small', {}, fileSize(f.size))],
      h('button', { class: 'attx', title: T('Odobrať'), onclick: () => dropAttachment(r, f) }, icon('close'))))) : null,
    rec?.room === r.id ? recordingBar() : h('div', { class: `crow${editing ? ' editing' : ''}` },
      viaSwitch(r, t),
      h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { const files = [...e.target.files]; e.target.value = ''; takeFiles(files); } }),
      h('button', { class: 'attach', title: T('Pridať obrázok alebo súbor (obrázok vložíš aj Ctrl+V)'), onclick: (e) => e.currentTarget.parentNode.querySelector('input[type=file]').click() }, icon('plus')),
      h('button', { class: 'gifbtn', title: 'GIF (aj /gif)', onclick: () => openGifs(r) }, 'GIF'),
      h('button', { class: 'attach emojibtn', title: T('Emoji (aj :meno, napríklad :srdce)'), onmousedown: (e) => e.preventDefault(), onclick: () => openEmoji(r) }, icon('smile')),
      h('button', { class: 'attach micbtn', title: T('Nahrať hlasovku (Ctrl+Shift+A)'), onclick: toggleRecording }, icon('mic')),
      area,
      !editing && ((S.drafts.get(r.id) || '').trim() || files.length) ? h('button', {
        class: 'gifbtn stashbtn', title: T('Odložiť koncept na neskôr, aj s pripomienkou; uvidíš ho v každom okne (Ctrl+S)'), onclick: () => openStashAsk(r),
      }, icon('clipboard-note'), h('span', {}, T('Odložiť'))) : null,
      h('button', {
        class: 'send', title: editing ? T('Uložiť úpravu (Enter)') : T('Odoslať (Enter). Pravým klikom neskôr (Ctrl+Shift+Enter)'),
        onclick: () => (editing ? saveEdit(r) : sendChat(r)), oncontextmenu: (e) => { e.preventDefault(); if (!editing) openLater(r); },
      }, icon('arrow-up'))));
}

/** Commands typed at the start of a message. */
const SLASH = [['gif', T('Poslať GIF, napríklad /gif mačka')], ['sendlater', T('Odoslať neskôr, čas vyberieš')]];
/** The command word being typed ("/sen"), or '' once a space or anything else follows. */
const slashWord = (text) => (/^\/\S*$/.test(text) ? text : '');
const slashHits = (text) => { const w = slashWord(text).slice(1).toLowerCase(); return slashWord(text) ? SLASH.filter(([name]) => name.startsWith(w)) : []; };
function useSlash(r, [name]) {
  setDraft(r.id, `/${name} `);
  S.focusComposer = true;
  const box = document.querySelector(`[data-root="${CSS.escape(r.id)}"]`);
  if (box) { box.value = `/${name} `; box.setSelectionRange(box.value.length, box.value.length); }
  render();
}

/** A new EduPage message to one person; once sent it becomes a thread like any other. */
function newEduView(mxid) {
  const name = eduName(mxid);
  const key = `edu:${mxid}`;
  const area = h('textarea', {
    rows: 3,
    value: S.drafts.get(key) || '',
    placeholder: T`Správa pre ${name}… (Enter odošle, Shift+Enter nový riadok)`,
    'data-root': key,
    oninput: (e) => { setDraft(key, e.target.value); autosize(e.target); },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.altKey) { e.preventDefault(); sendEdu(mxid); } },
  });
  return h('div', { class: 'detail chat' },
    h('div', { class: 'chead' },
      h('button', { class: 'back', title: T('Späť'), onclick: closeThread }, '‹'),
      avatar('', name, 36),
      h('div', { class: 'ctitle' }, h('b', {}, T`Nová správa: ${name}`), h('small', {}, h('img', { src: '/edupage.png', alt: '' }), 'EduPage'))),
    h('div', { class: 'msgs' }, h('div', { class: 'cstart' }, T('Správa pôjde cez EduPage len tomuto človeku.'))),
    h('div', { class: 'ccompose' }, eduNote(key), eduAtts(key), h('div', { class: 'crow' },
      h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { const files = [...e.target.files]; e.target.value = ''; takeFiles(files); } }),
      h('button', { class: 'attach', title: T('Pridať prílohu (aj Ctrl+V alebo pretiahnutím)'), onclick: (e) => e.currentTarget.parentNode.querySelector('input[type=file]').click() }, icon('plus')),
      area,
      h('button', { class: 'send', title: T('Odoslať (Enter)'), onclick: () => sendEdu(mxid) }, icon('arrow-up')))));
}

/** EduPage carries text only: a picture offered to it is turned down here, not lost on the way. */
const eduNote = (key) => (S.eduNote === `big:${key}`
  ? h('div', { class: 'note' }, key === MAIL ? T`Prílohy spolu nad ${mailLimit().mb} MB ${mailFrom()?.app.name || 'Gmail'} neprenesie.` : T('Súbor väčší ako 25 MB EduPage neprenesie.')) : null);

/** A person's name for a new EduPage message: from their messages, else from the school's teacher list. */
const eduName = (mxid) => S.names.get(mxid) || S.eduPeople.get(mxid) || mxid;

async function sendEdu(mxid) {
  const key = `edu:${mxid}`;
  const text = (S.drafts.get(key) || '').trim();
  const files = S.attach.get(key) || [];
  if ((!text && !files.length) || !S.roomId) return;
  const txn = `ep${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const content = { msgtype: 'm.text', body: text || files.map((f) => f.name).join(', '), [TO_KEY]: eduName(mxid), [RECIPIENT_KEY]: mxid };
  S.pending.set(txn, { event_id: txn, pending: true, sender: S.userId, origin_server_ts: Date.now(), content: { ...content, [EDU_FILES]: files.map((f) => ({ name: f.name })) } });
  deleteDraft(key);
  S.attach.delete(key);
  render();
  try {
    if (files.length) content[EDU_FILES] = await eduUpload(files);
    const { event_id: id } = await call('PUT', `/rooms/${q(S.roomId)}/send/m.room.message/${txn}`, content);
    S.justSent = id;
    select(id);
  } catch {
    S.pending.delete(txn);
    setDraft(key, text);
    if (files.length) S.attach.set(key, files);
    alert(T('Správa sa neodoslala. Skús to znova.'));
    render();
  }
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight + el.offsetHeight - el.clientHeight, 200)}px`;
  el.style.overflowY = el.scrollHeight > el.clientHeight ? 'auto' : 'hidden';
  el._sized = el.value; // the patch keeps this height; render() sizes the box again only when its text changed
}

// ------------------------------------------------------------------ search, new chat, menus

// Search runs over every message at each keystroke: the same texts are normalised and split once, not every time.
const memo = (fn, limit = 50000) => { const seen = new Map(); return (text) => { const key = String(text || ''); let v = seen.get(key); if (v === undefined) { if (seen.size >= limit) seen.clear(); v = fn(key); seen.set(key, v); } return v; }; };
const norm = memo((text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase());
const wordsOf = memo((text) => norm(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
/** How well a name matches: 0 starts with the whole query, 1 every word of it starts a word, 2 contained, -1 not. */
function nameScore(text, query) {
  const t = norm(text);
  if (t.startsWith(query)) return 0;
  const words = wordsOf(text);
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.every((tok) => words.some((w) => w.startsWith(tok)))) return 1;
  return t.includes(query) ? 2 : -1;
}
/** Beeper's name match: the word is anywhere in the name; from four letters on, one typo is forgiven
 * (a letter changed, added, dropped, or two neighbours swapped). One pass over the name: the edit distance of the
 * word to the best piece of the name ending at each letter, without cutting the name into pieces. */
const typoRows = [new Int32Array(64), new Int32Array(64), new Int32Array(64)];
function tokenIn(text, tok) {
  if (text.includes(tok)) return true;
  const m = tok.length;
  if (m < 4) return false;
  if (m >= typoRows[0].length) for (let k = 0; k < 3; k++) typoRows[k] = new Int32Array(m + 1);
  let [before, prev, cur] = typoRows; // rows for the name's letters i-2, i-1 and i
  for (let j = 0; j <= m; j++) prev[j] = j; // the word against nothing of the name
  for (let i = 1; i <= text.length; i++) {
    const c = text.charCodeAt(i - 1);
    cur[0] = 0; // the piece may start anywhere
    for (let j = 1; j <= m; j++) {
      const p = tok.charCodeAt(j - 1);
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (c === p ? 0 : 1));
      if (i > 1 && j > 1 && c === tok.charCodeAt(j - 2) && text.charCodeAt(i - 2) === p) d = Math.min(d, before[j - 2] + 1);
      cur[j] = d;
    }
    if (cur[m] <= 1) return true;
    [before, prev, cur] = [prev, cur, before];
  }
  return false;
}
const nameMatches = (name, tokens) => { const t = norm(name); return tokens.every((tok) => tokenIn(t, tok)); };

let searchTimer;
/** Older messages than the app holds come from the homeserver's full-text search, and those older than the
 * homeserver has (the bridges' older pages, the exports) from the archive's (asus archive.py). */
function serverSearch(o) {
  clearTimeout(searchTimer);
  const query = o.query.trim();
  if (query.length < 2) { o.server = []; o.archive = []; return; }
  searchTimer = setTimeout(() => {
    const current = () => S.overlay === o && o.query.trim() === query;
    call('POST', '/search', { search_categories: { room_events: { search_term: query, order_by: 'recent', event_context: { before_limit: 0, after_limit: 0 } } } }).then((data) => {
      if (!current()) return;
      // The server searches everything; a message waiting for its batch stays out of sight here too.
      // Filtered where they are listed: a window or a „Práca“ mark changes what is held while the search stays open.
      o.server = (data.search_categories?.room_events?.results || []).map((x) => x.result);
      overlayRedraw(o);
    }, () => {}); // local results stay
    fetch(`/_archive/search?q=${q(query)}&limit=100`, { headers: { Authorization: `Bearer ${S.token}` } })
      .then((res) => (res.ok ? res.json() : null)).then(async (data) => {
        if (!current() || !data) return;
        await refreshArchiveChats((data.results || []).some((a) => !S.rooms.has(a.room)));
        if (!current()) return;
        o.archive = (data.results || []).map((a) => [S.rooms.get(a.room), a]).filter(([r]) => r).map(([r, a]) => archivedEvent(r, a));
        overlayRedraw(o);
      }, () => {});
  }, 250);
}

// Search filters, as the chips under Beeper's search field: [key, label, [[value, label], ...]].
const SEARCH_FILTERS = [
  ['app', T('Účty'), [['', T('Všetky')], ...APPS.map((a) => [a.id, a.name])]],
  ['sender', T('Typ správy'), [['', T('Všetky')], ['me', T('Moje')], ['others', T('Od iných')]]],
  ['since', T('Obdobie'), [['', T('Kedykoľvek')], ['1', T('Dnes')], ['7', T('Posledný týždeň')], ['30', T('Posledný mesiac')], ['365', T('Posledný rok')]]],
  ['media', T('Médiá'), [['', T('Všetko')], ['image', T('Obrázky')], ['video', T('Videá')], ['file', T('Súbory')], ['link', T('Odkazy')]]],
];
const MEDIA_TYPES = { image: ['m.image'], video: ['m.video'], file: ['m.file', 'm.audio'] };

/** Whether a message passes the message filters (who sent it, when, what kind). */
function messageAllowed(f, ev, content) {
  if (f.sender === 'me' && ev.sender !== S.userId) return false;
  if (f.sender === 'others' && ev.sender === S.userId) return false;
  if (f.since) {
    const from = f.since === '1' ? new Date().setHours(0, 0, 0, 0) : Date.now() - Number(f.since) * 864e5;
    if (ev.origin_server_ts < from) return false;
  }
  if (f.media === 'link') return /https?:\/\//.test(content?.body || '');
  if (f.media) return MEDIA_TYPES[f.media].includes(content?.msgtype);
  return true;
}

// Each chat's messages as search sees them (summary, its words, resolved content), built once per room model:
// a keystroke then only compares words instead of summarising and splitting every message again.
const searchRowsOf = new WeakMap();
function searchRows(m) {
  let rows = searchRowsOf.get(m);
  if (!rows) {
    rows = [];
    for (const ev of m.messages) {
      if (ev.pending || isRedacted(m, ev)) continue;
      const text = messageSummary(m, ev);
      rows.push({ ev, text, words: wordsOf(text), content: contentOf(m, ev) });
    }
    searchRowsOf.set(m, rows);
  }
  return rows;
}

/** What search reads of Weft's data: when none of it changed, a render (a picture loaded, the list scrolled) leaves
 *  search what it gathered. Rooms change their version, account data is replaced, never changed in place. */
function searchSig() {
  let v = 0;
  for (const r of S.rooms.values()) v += r.version;
  // The minute: a reminder that came due brings its chat back.
  return [S.rooms.size, v, S.archiveGen, localStorage.getItem('ep_hidden_apps'), S.events.size, S.names.size, S.selected, batchWindow().cut, Math.floor(Date.now() / 60e3), S.userId, ...Object.keys(S.account), ...Object.values(S.account)];
}
const sameSig = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
let lastBase = null; // Ctrl+K opened again with nothing changed starts from what it gathered last time
/** What search needs of every chat, gathered once while Weft's data stays the same: typing redraws only the
 *  overlay, so each keystroke just compares words. `recent`: only what the empty field lists (recent chats). */
function searchBase(o, recent = false) {
  const app = o.f?.app || '';
  const sig = searchSig();
  const fits = (b) => b?.app === app && (b.all || recent) && (o.redrawSoon && b === o.base || sameSig(b.sig, sig));
  if (fits(o.base)) return o.base;
  if (fits(lastBase)) return (o.base = lastBase);
  const hidden = hiddenApps();
  // Each chat of a merged person on its own (its name and messages); `onePerPerson` shows the person as one row.
  // The empty field needs no old chat only the archive has, except one opened lately.
  const both = recent ? entryLists(false, new Set(opened())) : entryLists(true);
  const list = both.flat.filter((e) => !hidden.has(e.app) && (!app || e.app === app));
  const merged = new Map(both.merged.map((e) => [e.merged.id, e]));
  o.base = lastBase = { sig, all: !recent, app, list, merged, get items() { return (this.built ||= searchItems(list)); } };
  return o.base;
}
/** Per chat: its names, a group's members and its messages for search (the costly part, built on first need). */
function searchItems(list) {
  return list.map((e) => {
    const partner = e.kind === 'room' ? dmPartner(e.room) : null;
    return {
      e, partner,
      name: e.kind === 'thread' ? nameOf(e.thread.root.sender) : e.title,
      partnerName: partner ? networkName(e.room, partner[0]) : '', // a nicknamed person is found by their own name too
      // A merged person is found also by the name the inbox shows for them (the people map's, or one Karchi gave).
      groupName: (() => { const g = e.kind === 'room' && groupOf(e.key); return g ? mergedTitle(g, g.rooms.map((id) => S.rooms.get(id)).filter(Boolean)) : ''; })(),
      members: e.kind === 'room' && !partner ? joinedPeople(e.room).map(([id]) => memberName(e.room, id)) : [],
      rows: e.kind === 'room' ? (previewOnly(e.room) ? [] : searchRows(roomModel(e.room)))
        : [e.thread.root, ...e.thread.replies].filter((ev) => !ev.pending).map((ev) => { const text = bodyOf(ev); return { ev, text, words: wordsOf(text), content: ev.content }; }),
    };
  });
}

/** An old chat only the archive has, with nothing loaded but its last message: found here by its name, while its
 *  words asus's archive search finds (thousands of previews would make every first letter slow). */
const previewOnly = (r) => r.archiveOnly && [...r.events.values()].every((ev) => ev.archivePreview);
// Every chat's search rows are kept ready in idle moments after the data changes, chat by chat, so the first
// letter typed into Ctrl+K does not wait for thousands of messages to be summarised.
let warmQueued = false;
function warmSearch() {
  if (warmQueued) return;
  warmQueued = true;
  const idle = globalThis.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 50));
  const rooms = [...S.rooms.values()];
  const step = (deadline) => {
    while (rooms.length && deadline.timeRemaining() > 2) {
      const r = rooms.shift();
      if (isChat(r) && !previewOnly(r)) searchRows(roomModel(r));
    }
    if (rooms.length) idle(step); else warmQueued = false;
  };
  idle(step);
}

function searchResults(o) {
  const query = norm(o.query).trim();
  const f = o.f || {};
  const byMessage = !!(f.sender || f.since || f.media);
  const base = searchBase(o, !query && !byMessage);
  const { list } = base;
  if (!query && !byMessage) {
    // The chats you had open last come first (even archived ones, Ctrl+Enter archives), the open one is skipped,
    // then the rest by their last message.
    const byKey = new Map(list.map((e) => [e.key, e]));
    const recent = opened().filter((k) => k !== S.selected).map((k) => byKey.get(k)).filter(Boolean);
    const rest = list.filter((e) => !e.archived && !e.room?.archiveOnly && e.key !== S.selected && !recent.includes(e));
    const open = (x) => x.e.merged?.rooms.includes(S.selected);
    return [[T('Nedávne'), onePerPerson([...recent, ...rest].map((e) => ({ e })), f.app, base.merged).filter((x) => !open(x)).slice(0, o.more ? 20 : 5)]];
  }
  const tokens = query ? query.split(/\s+/) : [];
  // Chats whose name matches, then chats with someone whose name matches, then messages. Among the chats a person
  // (a one-to-one chat) comes first, then EduPage messages by their sender (a teacher is a person too), then groups
  // (Karchi, 20. 11.: the teacher above a group named after her); within each the closer
  // name match (the name starts with it, a word does, it is inside) and then the newest. Names that match only with
  // a typo come after all of them ("anna" finds Anna first, Jana and Zuzana last), in the same order of kinds.
  const chats = [];
  const groups = [];
  // People are matched on the words of the query only; a lone bracket or dash says nothing about a name.
  const wordTokens = tokens.filter((t) => /[\p{L}\p{N}]/u.test(t));
  const names = new Map();
  const matchName = (name, ts) => {
    const key = `${ts === tokens ? 'query' : 'words'}:${name}`;
    if (!names.has(key)) names.set(key, nameMatches(name, ts));
    return names.get(key);
  };
  const messages = [];
  const seen = new Set();
  // The sender's name is looked up only for the messages shown: a single letter matches thousands.
  const add = (e, ev, text) => { if (!seen.has(ev.event_id)) { seen.add(ev.event_id); messages.push({ e, ev, text }); } };
  // Typing on narrows: what matches the longer query matched the shorter one too, so only the chats and messages
  // that matched it are looked at again. Not across three to four letters, where a typo starts to be forgiven.
  const fKey = JSON.stringify(f);
  const last = o.narrow;
  // Every earlier word must hold a letter or digit: a lone "(" leaves names unchecked against a chat's person.
  const narrower = last && last.base === o.base && last.fKey === fKey && tokens.length >= last.tokens.length
    && last.tokens.every((t, i) => /[\p{L}\p{N}]/u.test(t) && tokens[i].startsWith(t) && (t.length >= 4 || tokens[i].length < 4));
  const pool = [];
  for (const { it, rows: from } of narrower ? last.pool : base.items.map((it) => ({ it, rows: it.rows }))) {
    const { e, partner, name: title, partnerName, groupName, members } = it;
    let hit = false;
    if (!byMessage) {
      // An EduPage message is found by who wrote it, not by whom it went to ("→ Ján" matched every one).
      // A one-to-one chat is its person, also when the chat is named otherwise (a Discord display name), and a merged
      // person is found by the name the inbox shows; the closest of these names counts (a title matching only with a
      // typo loses to the person's exact name).
      const closeness = (n) => { const sc = nameScore(n, query); return sc < 0 ? 3 : sc; };
      let name = title;
      let best = matchName(title, tokens) ? closeness(title) : 4;
      for (const alt of [partner && partnerName, groupName]) {
        if (best === 0 || !alt || !wordTokens.length || !matchName(alt, wordTokens)) continue;
        const c = closeness(alt);
        if (c < best) { name = alt; best = c; }
      }
      if (best < 4) {
        hit = true;
        const score = best === 3 ? -1 : best;
        const kind = e.kind === 'thread' ? 1 : partner ? 0 : 2;
        // `person`: the name that matched when it is not the chat's title, shown under it.
        chats.push({ e, rank: score < 0 ? 9 + kind : kind * 3 + score, person: name !== e.title && e.kind === 'room' ? name : '' });
      }
      if (e.kind === 'room' && !partner) {
        const who = members.find((member) => matchName(member, wordTokens));
        if (who) hit = true;
        // A group already found by its name is not shown a second time.
        if (who && chats.at(-1)?.e !== e) groups.push({ e, who });
      }
    }
    const rows = [];
    for (const row of from) {
      if (!messageAllowed(f, row.ev, row.content)) continue;
      if (tokens.length && !tokens.every((tok) => row.words.some((w) => w.startsWith(tok)))) continue;
      rows.push(row);
      add(e, row.ev, row.text);
    }
    if (hit || rows.length) pool.push({ it, rows });
  }
  o.narrow = { base: o.base, fKey, tokens, pool };
  const byKey = new Map(list.map((e) => [e.key, e]));
  for (const ev of o.server || []) {
    if (isHeld(ev, cutOf(ev.room_id))) continue;
    const e = ev.room_id === S.roomId ? byKey.get(S.rootOf?.get(ev.event_id)) : byKey.get(ev.room_id);
    if (!e || !ev.content?.body || !messageAllowed(f, ev, ev.content)) continue;
    add(e, ev, String(ev.content.body).replace(/^(> .*\n)+\n/, ''));
  }
  for (const ev of o.archive || []) {
    const e = byKey.get(ev.room_id);
    if (e?.kind === 'room' && messageAllowed(f, ev, ev.content)) add(e, ev, ev.content.body);
  }
  messages.sort((a, b) => b.ev.origin_server_ts - a.ev.origin_server_ts);
  chats.sort((a, b) => a.rank - b.rank); // stable: the newest first within a rank
  const shown = messages.slice(0, byMessage ? 60 : 30);
  for (const x of shown) x.sender = x.e.kind === 'room' ? memberName(x.e.room, x.ev.sender) : nameOf(x.ev.sender);
  return [[T('Chaty'), onePerPerson(chats, f.app, base.merged, query).slice(0, 30)], [T('V skupinách'), groups.slice(0, 30)], [T('Správy'), shown]];
}

/** Chat results with a merged person's chats as one row, the merged chat, where its first chat came. Not with a
 *  network filter (`app`): then each chat is that network's. */
function onePerPerson(rows, app, merged, query = '') {
  if (app) return rows;
  const seen = new Set();
  return rows.flatMap((x) => {
    const g = x.e.kind === 'room' && groupOf(x.e.key);
    const e = g && merged.get(g.id);
    if (!e) return [x];
    if (seen.has(g.id)) return [];
    seen.add(g.id);
    // The name that matched, when the merged row's own title does not match the query without a typo („zorka“ finds
    // Zora through her Messenger chat „Zorka …“). Only a search hit has a rank.
    // Never the row's own title again („Ján Novák | Ján Novák“ when a typo found him through a chat of that name).
    const matched = x.rank === undefined || nameScore(e.title, query) >= 0 ? '' : x.person || x.e.title;
    return [{ ...x, e, person: matched && norm(bareName(matched)) !== norm(bareName(e.title)) ? matched : '' }];
  });
}

/** The filter chips under the search field and, for the open one, its choices. */
function searchFilters(o) {
  const f = (o.f ||= {});
  const chips = SEARCH_FILTERS.map(([key, label, options]) => {
    const value = options.find(([v]) => v === (f[key] || ''));
    return h('button', { class: `chip${f[key] ? ' on' : ''}${o.chip === key ? ' open' : ''}`, onclick: () => { o.chip = o.chip === key ? null : key; overlayRedraw(o); } },
      f[key] ? value[1] : label, ' ▾');
  });
  const open = SEARCH_FILTERS.find(([key]) => key === o.chip);
  return [h('div', { class: 'chips' }, chips),
    open ? h('div', { class: 'chips choices' }, open[2].map(([v, label]) => h('button', {
      class: `chip${(f[open[0]] || '') === v ? ' on' : ''}`,
      onclick: () => { if (v) f[open[0]] = v; else delete f[open[0]]; o.chip = null; o.index = 0; overlayRedraw(o); },
    }, label))) : null];
}

function openResult(x) {
  const query = S.overlay?.query?.trim() || '';
  S.overlay = null;
  if (!x.e.room?.archiveOnly) S.box = BOXES.find(([, , has]) => has(x.e))?.[0] || 'inbox';
  select(x.e.key);
  S.findQuery = x.ev ? query : '';
  if (x.ev?.archived && x.e.kind === 'room') jumpToArchived(x.e.room, x.ev);
  else if (x.ev && x.e.kind === 'room') jumpTo(x.e.room, x.ev.event_id);
  else {
    if (x.ev) { S.focusEvent = x.ev.event_id; S.focusScrolled = null; }
    render();
  }
}

/** A text with the query's words marked (bold in results, underlined as `found` in the chat). */
function highlighted(text, query, cls = '') {
  const tokens = norm(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return text;
  const out = [];
  const re = /[\p{L}\p{N}]+|[^\p{L}\p{N}]+/gu;
  for (const [part] of String(text).matchAll(re)) out.push(tokens.some((t) => norm(part).startsWith(t)) ? h('mark', cls ? { class: cls } : {}, part) : part);
  return out;
}

/** A long message cut so that its first matching word shows, as Beeper does in results. */
function snippet(text, query, lead = 16) {
  const flat = String(text).replace(/\s+/g, ' ');
  const tokens = norm(query).split(/\s+/).filter(Boolean);
  for (const m of flat.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (!tokens.some((t) => norm(m[0]).startsWith(t))) continue;
    if (m.index <= lead) return flat;
    // Start a few words before the match; a long link in front is cut rather than shown whole.
    let from = m.index - lead;
    const space = flat.indexOf(' ', from);
    if (space >= 0 && space < m.index) from = space + 1;
    return `…${flat.slice(from)}`;
  }
  return flat;
}

function resultRow(o, x, i, body, extra = '') {
  return h('button', { class: `res${extra}${i === o.index ? ' on' : ''}`, onmousemove: (ev) => { if (pointerMoved(o, ev) && o.index !== i) { o.index = i; overlayMark(o, true); } }, onclick: () => o.flat[i]() }, body);
}

/** One redraw of Ctrl+K's results for any number of renders under it; until then typing searches what it had. */
function searchRedrawSoon(o) {
  if (o.redrawSoon) return;
  o.redrawSoon = true;
  (globalThis.requestIdleCallback || setTimeout)(() => { o.redrawSoon = false; if (S.overlay === o) overlayRedraw(o); }, { timeout: 500 });
}
/** Search typing redraws only the overlay's results, never the window under it; the field keeps its caret. */
function overlayRedraw(o) {
  const box = document.querySelector('.cmd.search');
  const input = box?.querySelector('.cmdinput');
  if (S.overlay !== o || o.kind !== 'search' || !input) return render();
  // New data under the same text keeps the results where they were scrolled; new text starts at the top.
  const was = o.drawn === o.query ? box.querySelector('.results')?.scrollTop || 0 : 0;
  const [, ...rest] = searchView(o);
  while (input.nextSibling) input.nextSibling.remove();
  input.after(...rest.flat().filter(Boolean));
  o.drawn = o.query;
  if (was) { if (searchRest) searchDrawRest(); box.querySelector('.results').scrollTop = was; }
}
/** Moves the highlighted result: Ctrl+K's and Ctrl+J's rows without redrawing anything else, other lists by a render.
 *  The keyboard's choice comes into sight; the mouse's is under the pointer already, so the list never moves under it. */
function overlayMark(o, mouse = false) {
  const own = S.overlay === o && (o.kind === 'search' || o.kind === 'tools');
  // The rows past the first screenful are drawn once the highlight reaches them.
  if (own && o.kind === 'search' && searchRest && document.querySelectorAll('.cmd.search .res').length <= o.index) searchDrawRest();
  const rows = own ? document.querySelectorAll(`.cmd.${o.kind} .res`) : [];
  if (rows[o.index]) rows.forEach((el, i) => el.classList.toggle('on', i === o.index));
  else render();
  if (!mouse) document.querySelector('.cmd .res.on')?.scrollIntoView({ block: 'nearest' });
}

function cmdInput(o, placeholder) {
  return h('input', {
    class: 'cmdinput',
    placeholder,
    value: o.query,
    'data-root': '__overlay',
    // Typing in Ctrl+N only filters what Weft has; the network mode asks its network on Enter alone.
    oninput: (e) => { o.query = e.target.value; o.index = 0; e.target.closest('.cmd')?.querySelectorAll('[data-scroll]').forEach((el) => { el.scrollTop = 0; }); if (o.kind === 'search') serverSearch(o); if (o.kind === 'gif') searchGifs(o); if (o.kind === 'search') overlayRedraw(o); else render(); },
    onkeydown: (e) => {
      const opt = o.kind === 'relay' && e.altKey && !e.ctrlKey && relayOpts.find(([, keys]) => e.code === `Key${keys.at(-1)}`);
      if (opt) { e.preventDefault(); return relayToggle(o, opt[0]); }
      if (o.kind === 'new' && o.group && e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); return createGroup(o); }
      const rem = o.kind === 'new' && o.remote;
      if (rem && e.key === 'Tab') {
        e.preventDefault();
        const all = remoteTargets().map(targetKey);
        return remoteSwitch(o, all[(all.indexOf(rem.target) + (e.shiftKey ? -1 : 1) + all.length) % all.length]);
      }
      if (rem && e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        // A result Karchi moved to opens; otherwise Enter asks the network about what is typed now.
        const ask = remoteAsk(rem.target.split('|')[0], o.query);
        const shown = rem.state === 'done' && rem.query === o.query.trim() && rem.asked === (ask.kind ? `${rem.target}|${ask.kind}:${ask.value.toLowerCase()}` : '');
        return shown && o.flat?.length ? o.flat[o.index]?.() : remoteSearch(o);
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = o.flat?.length || 0;
        if (n) { o.index = (o.index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; overlayMark(o); }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        o.flat?.[o.index]?.();
      }
    },
  });
}

// Results past the first screenful are drawn only when they are reached: a keystroke lays out one screenful.
const SEARCH_FIRST_ROWS = 16;
let searchRest = null; // { results element, row builders still to draw }
function searchDrawRest() {
  const rest = searchRest;
  searchRest = null;
  if (rest?.box.isConnected) rest.box.append(...rest.make.map((make) => make()));
}

function searchView(o) {
  const sections = searchResults(o);
  o.flat = [];
  const body = [];
  const later = [];
  const put = (make) => { if (o.flat.length <= SEARCH_FIRST_ROWS) body.push(make()); else later.push(make); };
  for (const [title, rows] of sections) {
    if (!rows.length) continue;
    const recent = title === T('Nedávne');
    put(() => h('div', { class: 'rsec' }, title,
      recent && !o.more ? h('button', { class: 'more', onclick: () => { o.more = true; overlayRedraw(o); } }, T('Ukáž viac')) : null));
    for (const x of rows) {
      const i = o.flat.length;
      o.flat.push(() => openResult(x));
      // Recent chats and the people and groups a search finds are one line each, as in Beeper: the name (its match
      // in bold), the network, or the person's own name when that matched instead, and the network's icon.
      if (recent || (!x.ev && !x.who && x.e.kind === 'room')) {
        const apps = (x.e.apps || [x.e.app]).map((id) => APPS.find((a) => a.id === id)).filter(Boolean);
        put(() => resultRow(o, x, i, [
          x.e.kind === 'thread' ? iconOf(x.e.thread) : avatar(roomAvatar(x.e.merged ? x.e.rooms.find(roomAvatar) || x.e.room : x.e.room), x.e.title, 28),
          h('div', { class: 'rmeta' }, h('b', recent ? {} : { class: 'hit' }, recent ? x.e.title : highlighted(x.e.title, o.query),
            h('small', {}, x.person ? highlighted(x.person, o.query) : apps.map((a) => a.name).join(', ')))),
          apps.map((a) => h('img', { class: 'rnet', src: a.icon, alt: '' })),
        ], ' mini'));
        continue;
      }
      put(() => resultRow(o, x, i, [
        entryAvatar(x.e),
        h('div', { class: 'rmeta' },
          h('b', {}, x.ev ? x.e.title : highlighted(x.e.title, o.query)),
          h('small', {}, x.ev ? [`${x.sender}: `, highlighted(snippet(x.text, o.query), o.query)] : x.who ? ['obsahuje ', highlighted(x.who, o.query)] : entryPreview(x.e))),
        h('time', {}, x.ev ? listDate(x.ev.origin_server_ts) : x.e.sortTs ? listDate(x.e.sortTs) : ''),
      ]));
    }
  }
  if (o.index >= o.flat.length) o.index = 0;
  // The rest comes when the list is scrolled towards its end or the highlight moves past the first screenful.
  const box = h('div', { class: 'results', onscroll: (e) => { const b = e.currentTarget; if (searchRest?.box === b && b.scrollTop + b.clientHeight > b.scrollHeight - 300) searchDrawRest(); } },
    body.length ? body : h('div', { class: 'empty' }, T('Nič sa nenašlo.')));
  searchRest = later.length ? { box, make: later } : null;
  return [cmdInput(o, T('Hľadať chaty, ľudí a správy')), ...searchFilters(o), box];
}

/** People Karchi can write to: everyone he has a one-to-one chat with, plus the bridges' contacts. */
/** A bridge ghost's network id as `messenger:123`, the way a bridge's search result is `${app}:${id}`. */
function ghostKey(id) {
  const m = id.match(/^@(facebook|instagram|whatsapp|teams|discord)_([a-z0-9-]+):/);
  return m && `${{ facebook: 'messenger', instagram: 'instagram', whatsapp: 'whatsapp', teams: 'teams', discord: 'discord' }[m[1]]}:${m[2]}`;
}
/** The people Karchi has a one-to-one chat with, by ghostKey, to that chat's room. */
function dmGhosts() {
  const out = new Map();
  for (const r of S.rooms.values()) {
    const p = !r.archiveOnly && isChat(r) && dmPartner(r);
    const k = p && ghostKey(p[0]);
    if (k) out.set(k, r.id);
  }
  return out;
}

function contactList(o) {
  const out = [];
  const ghosts = [];
  // Per network: picking someone's WhatsApp opens their merged chat writing through WhatsApp.
  for (const e of entries(true, true)) {
    if (e.kind !== 'room') continue;
    const p = dmPartner(e.room);
    if (p) out.push({ name: memberName(e.room, p[0]), app: e.app, avatar: p[1].avatar, key: e.key, sortTs: e.sortTs });
    if (p && ghostKey(p[0])) ghosts.push(ghostKey(p[0]));
  }
  // EduPage: everyone who has written to Karchi there; the bridge sends only to people it knows.
  const lastBy = new Map();
  for (const t of threads()) lastBy.set(t.root.sender, Math.max(lastBy.get(t.root.sender) || 0, t.last));
  for (const [id, name] of S.names) {
    if (/^@edupage_(ucitel|student|rodic)/.test(id)) out.push({ name, app: 'edupage', key: `edu:${id}`, sortTs: lastBy.get(id) || 0 });
  }
  // Every teacher of the school, also those who never wrote to Karchi.
  for (const [id, name] of S.eduPeople) {
    if (!S.names.has(id)) out.push({ name, app: 'edupage', key: `edu:${id}`, sortTs: 0 });
  }
  // A bridge's contact or search result Karchi already has a chat with is that chat, not a second row.
  const known = new Set([...out.map((x) => x.key), ...ghosts]);
  for (const c of [...(o.contacts || []), ...(o.found || [])]) {
    if ((c.dm_room_mxid && known.has(c.dm_room_mxid)) || known.has(`${c.app}:${c.id}`)) continue;
    known.add(c.dm_room_mxid || `${c.app}:${c.id}`);
    out.push({ name: c.name || c.id, app: c.app, avatar: c.avatar_url, contact: c, note: c.note || '', sortTs: 0 });
  }
  return out.filter((x) => !hiddenApps().has(x.app));
}

/** The bridges that can start chats (Messenger, Instagram) list their contacts once the overlay opens. */
async function loadContacts(o) {
  discordContacts().then((rows) => {
    o.contacts.push(...rows);
    if (rows.length && S.overlay === o) render();
  });
  bridge('GET', '/contacts').then((data) => {
    for (const c of data.contacts || []) if (typeof c?.id === 'string' && typeof c.name === 'string') S.eduPeople.set(c.id, c.name);
    if (S.overlay === o) render();
  }).catch(() => {});
  await refreshLinks();
  for (const app of LINKS.filter((a) => !a.legacy && !a.noContactList && S.links[a.id]?.length)) {
    prov(app, 'GET', '/contacts').then((data) => {
      o.contacts.push(...(data.contacts || []).map((c) => ({ ...c, app: app.id })));
      if (S.overlay === o) render();
    }).catch(() => {});
  }
}

// ------------------------------------------------------------------ people outside the contacts

/* Ctrl+N filters only what Weft already has. Looking someone up on a network is its own mode ("Hľadať mimo
 * kontaktov"): one network and login at a time, and only when Karchi presses Enter. What each bridge can do was
 * read from its /v3/capabilities on 16. 11. 2026 (mautrix-meta v26.10+dev, mautrix-whatsapp v26.10):
 *   Messenger, Instagram: search by name or username (search_users), a numeric id (resolve_identifier), new DM;
 *                          no username or phone lookup, no friend or follow requests.
 *   WhatsApp:            only a full phone number (lookup_phone, resolve_identifier), new DM; no search.
 *   Teams (server/microsoft): people of Karchi's school or work directory by name or mail, a full address, new DM. */
const REMOTE = {
  instagram: { hint: T('Meno, @používateľ alebo odkaz na profil'), note: T('Kto ťa nesleduje, dostane správu ako žiadosť o správu. Sledovať ho Weft nevie: to sa dá iba v Instagrame.') },
  messenger: { hint: T('Meno na Facebooku alebo číselné ID profilu'), note: T('Kto nie je tvoj priateľ, dostane správu ako žiadosť o správu, ak ju jeho súkromie pustí. Žiadosť o priateľstvo Weft poslať nevie: to sa dá iba na Facebooku.') },
  whatsapp: { hint: T('Celé číslo s predvoľbou, napr. +421 900 123 456'), note: T('WhatsApp nájde človeka iba podľa celého čísla; mená a priateľstvá tu nie sú.') },
  teams: { hint: T('Meno alebo e-mail v škole či firme'), note: T('Teams nájde ľudí z adresára tvojej školy alebo firmy; ľudí mimo nej Weft nepridá.') },
};
// The same notes when profiles open in Weft's follow window (Settings → Prístupnosť).
const FOLLOW_NOTE = {
  instagram: T('Kto ťa nesleduje, dostane správu ako žiadosť o správu. Sledovať ho môžeš v okne Weftu: napíš jeho @používateľa a klikni na „Sledovať @…“.'),
  messenger: T('Kto nie je tvoj priateľ, dostane správu ako žiadosť o správu, ak ju jeho súkromie pustí. Žiadosť o priateľstvo pošleš v okne Weftu cez „Pridať priateľa…“ pri človeku.'),
};
const REMOTE_TIMEOUT = 15e3;
const REMOTE_TTL = 60e3; // the same question to the same login is answered from memory this long
const REMOTE_MAX = 20;
const remoteCache = new Map(); // `${app}|${login}|${kind}:${value}` → { at, results }
let remoteLast = ''; // the network chosen last, offered first next time

/** What Karchi typed, as the one request this network supports for it, or why it has none. */
function remoteAsk(app, text) {
  const t = text.trim();
  if (app === 'teams') {
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) return { kind: 'id', value: t };
    return t.length < 2 ? { error: T('Napíš aspoň dve písmená.') } : { kind: 'search', value: t, user: '' };
  }
  if (app === 'whatsapp') {
    const n = t.replace(/^(?:https?:\/\/)?(?:api\.)?wa\.me\//i, '+').replace(/[\s\-().\/]/g, '');
    const m = n.match(/^(?:\+|00)(\d{8,15})$/);
    return m ? { kind: 'id', value: m[1] } : { error: T('WhatsApp nájde človeka iba podľa celého čísla s predvoľbou krajiny, napr. +421 900 123 456.') };
  }
  const fb = t.match(/^(?:https?:\/\/)?(?:[a-z]+\.)?(?:facebook\.com\/profile\.php\?(?:.*&)?id=|messenger\.com\/t\/|m\.me\/)(\d+)/i);
  if (app === 'messenger' && fb) return { kind: 'id', value: fb[1] };
  if (app === 'messenger' && /facebook\.com\//i.test(t)) return { error: T('Adresu profilu s menom most nepozná. Napíš meno alebo číselné ID profilu.') };
  const ig = app === 'instagram' && t.match(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)/i);
  const name = ig ? ig[1] : t.replace(/^@(?=[A-Za-z0-9._]+$)/, '');
  if (/^\d{5,}$/.test(name)) return { kind: 'id', value: name };
  if (name.length < 2) return { error: T('Napíš aspoň dve písmená.') };
  return { kind: 'search', value: name, user: ig || /^@?[A-Za-z0-9._]+$/.test(t) && /[._]|^@/.test(t) ? name : '' };
}

/** The networks Ctrl+N can look people up on, each login its own choice. */
function remoteTargets() {
  return LINKS.filter((a) => REMOTE[a.id]).flatMap((app) => {
    const logins = S.links[app.id];
    if (!logins?.length) return [{ app, login: null, down: logins === null ? T('nedostupný') : T('nepripojený') }];
    return logins.map((l) => ({ app, login: l, down: ['CONNECTED', 'CONNECTING', 'BACKFILLING'].includes(l.state?.state_event || 'CONNECTED') ? '' : T('odpojený') }));
  });
}
const targetKey = (t) => `${t.app.id}|${t.login?.id || ''}`;

function openRemote(o, app) {
  const all = remoteTargets();
  const want = app || remoteLast;
  const t = all.find((x) => x.app.id === want && !x.down) || all.find((x) => !x.down) || all[0];
  o.remote = { target: targetKey(t), seq: 0, state: 'idle', results: [], asked: '' };
  o.index = 0;
  render();
}
/** Leaves the network mode or switches it: an answer still on its way is no longer wanted. */
function remoteDrop(o) {
  const rem = o?.remote;
  if (!rem) return;
  rem.seq++;
  rem.abort?.abort();
  rem.abort = null;
}
function remoteSwitch(o, key) {
  remoteDrop(o);
  Object.assign(o.remote, { target: key, state: 'idle', results: [], asked: '', error: '' });
  o.index = 0;
  remoteLast = key.split('|')[0];
  render();
}

/** Enter in the network mode: one request to the chosen login. The same question while it runs sends nothing. */
async function remoteSearch(o) {
  const rem = o.remote;
  const t = remoteTargets().find((x) => targetKey(x) === rem.target);
  if (!t) return;
  remoteLast = t.app.id;
  const ask = remoteAsk(t.app.id, o.query);
  const key = ask.kind ? `${rem.target}|${ask.kind}:${ask.value.toLowerCase()}` : '';
  if (key && rem.state === 'loading' && rem.asked === key) return;
  remoteDrop(o);
  const seq = rem.seq;
  Object.assign(rem, { asked: key, query: o.query.trim(), user: ask.user || '', error: '', code: 0, results: [] });
  o.index = 0;
  if (t.down) { rem.state = 'down'; return render(); }
  if (ask.error) { rem.state = 'unsupported'; rem.error = ask.error; return render(); }
  const hit = remoteCache.get(key);
  if (hit && Date.now() - hit.at < REMOTE_TTL) { rem.state = 'done'; rem.results = hit.results; return render(); }
  rem.state = 'loading';
  render();
  const abort = rem.abort = new AbortController();
  const timer = setTimeout(() => abort.abort('timeout'), REMOTE_TIMEOUT);
  const path = ask.kind === 'id' ? `/resolve_identifier/${q(ask.value)}` : '/search_users';
  let state = 'done';
  let results = [];
  try {
    const data = await call(ask.kind === 'id' ? 'GET' : 'POST', `${path}?user_id=${q(S.userId)}&login_id=${q(t.login.id)}`,
      ask.kind === 'id' ? undefined : { query: ask.value }, t.app.base, abort.signal);
    results = (ask.kind === 'id' ? [data] : data.results || []).filter((c) => typeof c?.id === 'string')
      .slice(0, REMOTE_MAX).map((c) => ({ id: c.id, name: c.name || '', avatar_url: c.avatar_url, dm_room_mxid: c.dm_room_mxid }));
    remoteCache.set(key, { at: Date.now(), results });
  } catch (err) {
    if (abort.signal.aborted && abort.signal.reason !== 'timeout') return; // Karchi moved on
    state = abort.signal.reason === 'timeout' ? 'timeout'
      : err.status === 404 ? 'done'
      : err.status === 429 ? 'limit'
      : err.status === 403 || err.errcode === 'FI.MAU.NOT_LOGGED_IN' ? 'down'
      : 'error';
    if (state === 'done') remoteCache.set(key, { at: Date.now(), results });
    rem.error = state === 'error' ? err.message : '';
    rem.code = err.status || 0;
  } finally {
    clearTimeout(timer);
  }
  if (S.overlay !== o || o.remote !== rem || rem.seq !== seq) return;
  rem.abort = null;
  rem.state = state;
  rem.results = results;
  render();
}

/** The network mode of Ctrl+N: which network, what to look for, and what it found. */
function remoteView(o) {
  const rem = o.remote;
  const targets = remoteTargets();
  const t = targets.find((x) => targetKey(x) === rem.target) || targets[0];
  const app = t.app;
  const ask = remoteAsk(app.id, o.query);
  const askKey = ask.kind ? `${rem.target}|${ask.kind}:${ask.value.toLowerCase()}` : '';
  const fresh = rem.state !== 'idle' && rem.asked === askKey && rem.query === o.query.trim();
  const dms = dmGhosts();
  const rows = fresh && rem.state === 'done' ? rem.results : [];
  o.flat = rows.map((c) => () => startChat({ app: app.id, login: t.login?.id, contact: { ...c, dm_room_mxid: c.dm_room_mxid || dms.get(`${app.id}:${c.id}`) } }));
  if (o.index >= o.flat.length) o.index = 0;
  const many = targets.filter((x) => x.app.id === app.id).length > 1;
  const label = (x) => `${x.app.name}${targets.filter((y) => y.app === x.app).length > 1 ? ` · ${x.login?.name || x.login?.id}` : ''}${x.down ? ` · ${x.down}` : ''}`;
  const where = many ? label(t) : app.name;
  const retry = h('button', { class: 'linkbtn', onclick: () => { remoteSearch(o); document.querySelector('.cmd.new .cmdinput')?.focus(); } }, T('Skúsiť znova'));
  const status = !fresh
    ? h('div', { class: 'rnote' }, o.query.trim() ? T`Enter hľadá na ${where}.` : `${REMOTE[app.id].hint}.`, T(' Tab prepne sieť, Esc sa vráti k tvojim kontaktom.'))
    : rem.state === 'loading' ? h('div', { class: 'rnote' }, T`Hľadám na ${where}…`)
    : rem.state === 'down' ? h('div', { class: 'rnote' }, `${app.name} ${t.down === T('nepripojený') ? T('nie je pripojený') : t.down === T('nedostupný') ? T('teraz neodpovedá') : T('je odpojený')}. `,
      h('button', { class: 'linkbtn', onclick: () => togglePanel('settings', 'accounts') }, T('Nastavenia → Účty')))
    : rem.state === 'unsupported' ? h('div', { class: 'rnote' }, rem.error)
    : rem.state === 'timeout' ? h('div', { class: 'rnote' }, T`${app.name} neodpovedal do ${REMOTE_TIMEOUT / 1000} s. `, retry)
    : rem.state === 'limit' ? h('div', { class: 'rnote' }, T`${app.name} teraz obmedzuje hľadanie. Skús o chvíľu. `, retry)
    // WhatsApp answers an unknown number with an internal error (500 M_UNKNOWN, checked live 16. 11.), not 404.
    : rem.state === 'error' && app.id === 'whatsapp' && rem.code === 500 ? h('div', { class: 'rnote' }, T('WhatsApp toto číslo nepozná (alebo práve neodpovedá). '), retry)
    : rem.state === 'error' ? h('div', { class: 'rnote' }, T`Hľadanie zlyhalo: ${rem.error || T('neznáma chyba')}. `, retry)
    : !rows.length ? h('div', { class: 'rnote' }, app.id === 'whatsapp' ? T('Toto číslo WhatsApp nemá, alebo ho most nenašiel.') : T`Na ${where} sa nikto nenašiel.`)
    : null;
  // A profile page in the network's own app, for what Weft cannot do (follow, friend request). Only links that are
  // certain: the profile of the username Karchi typed, a Facebook profile by its id.
  const profile = (c) => app.id === 'messenger' && /^\d+$/.test(c.id) ? `https://www.facebook.com/profile.php?id=${c.id}` : '';
  const typedUser = fresh && app.id === 'instagram' && rem.user;
  return [
    cmdInput(o, REMOTE[app.id].hint),
    h('div', { class: 'chips' }, targets.map((x) => h('button', {
      class: `chip${targetKey(x) === rem.target ? ' on' : ''}`, onclick: () => { remoteSwitch(o, targetKey(x)); document.querySelector('.cmd.new .cmdinput')?.focus(); },
    }, label(x))), h('button', { class: 'chip go', disabled: rem.state === 'loading' && fresh, onclick: () => { remoteSearch(o); document.querySelector('.cmd.new .cmdinput')?.focus(); } }, T('Hľadať'))),
    h('div', { class: 'results', ...listScroll(o) },
      status,
      rows.length ? [h('div', { class: 'rsec' }, T`Na ${where}`), rows.map((c, i) => {
        const room = c.dm_room_mxid || dms.get(`${app.id}:${c.id}`);
        const link = profile(c);
        return h('div', { class: 'rrow', 'data-key': c.id },
          resultRow(o, c, i, [
            h('div', { class: 'avwrap' }, avatar(c.avatar_url, c.name || c.id, 40), h('img', { class: 'badge', src: app.icon, alt: '' })),
            h('div', { class: 'rmeta' }, h('b', {}, c.name || c.id),
              h('small', {}, room ? T('Už máte chat · otvorí ho') : app.id === 'whatsapp' ? T('Nový chat') : T('Nový chat · môže prísť ako žiadosť o správu'))),
          ]),
          link ? profileLink('facebook', c.id, link, { class: 'rlink', title: T('Profil na Facebooku') }, T('Profil ↗'), T('Pridať priateľa…')) : null);
      })] : null,
      typedUser ? profileLink('instagram', rem.user, `https://www.instagram.com/${encodeURIComponent(rem.user)}/`, { class: 'rnote rlink' }, T`Profil @${rem.user} v Instagrame ↗`, T`Sledovať @${rem.user}…`) : null,
      h('div', { class: 'rnote dim' }, (followWindow(app.id === 'messenger' ? 'facebook' : app.id) && FOLLOW_NOTE[app.id]) || REMOTE[app.id].note)),
  ];
}

// ------------------------------------------------------------------ new WhatsApp group

/* Ctrl+N → „Nová skupina na WhatsAppe“: people of Karchi's WhatsApp chats and contacts or a full number, a name, and
 * the bridge's POST /v3/create_group/group (mautrix-whatsapp v26.10: a name of up to 100 characters, at least one
 * other member; Weft asks for a name, as WhatsApp's own app does). WhatsApp tells every member at once, so the
 * group is made only after Karchi confirms it. Someone whose privacy refuses being added gets the group's
 * invitation in their own chat only when Karchi says so. */
const GROUP_NAME_MAX = 100;
const waApp = () => LINKS.find((a) => a.id === 'whatsapp');
const waLogin = () => (S.links.whatsapp || []).find((l) => ['CONNECTED', 'CONNECTING', 'BACKFILLING'].includes(l.state?.state_event || 'CONNECTED'));

function openGroup(o) {
  remoteDrop(o);
  Object.assign(o, { remote: null, group: { name: '', picked: [], state: 'idle', error: '', checking: '' }, query: '', index: 0 });
  render();
}
function openNewGroup() {
  openNewChat();
  openGroup(S.overlay);
}

/** WhatsApp people Karchi can add: those of his WhatsApp chats, then the bridge's contacts. `id` is what the bridge
 *  takes (a ghost's Matrix id or a WhatsApp user id), `key` the person as ghostKey names them. */
function groupPeople(o) {
  const out = [];
  const seen = new Set();
  for (const e of entries(true, true)) {
    if (e.kind !== 'room' || e.app !== 'whatsapp') continue;
    const p = dmPartner(e.room);
    const key = p && ghostKey(p[0]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: p[0], key, name: memberName(e.room, p[0]), avatar: p[1].avatar, sortTs: e.sortTs });
  }
  for (const c of o.contacts || []) {
    const key = `whatsapp:${c.id}`;
    if (c.app !== 'whatsapp' || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: c.id, key, name: c.name || c.id, avatar: c.avatar_url, sortTs: 0 });
  }
  return out;
}

const groupFocus = () => document.querySelector('.cmd.new .cmdinput')?.focus();
function groupToggle(o, x) {
  const g = o.group;
  g.picked = g.picked.some((p) => p.key === x.key) ? g.picked.filter((p) => p.key !== x.key) : [...g.picked, x];
  Object.assign(o, { query: '', index: 0 });
  g.error = '';
  render();
  groupFocus();
}

/** A full number typed in: WhatsApp says whether it has it (one GET), and then it is added like a contact. */
async function groupNumber(o, number) {
  const g = o.group;
  const login = waLogin();
  if (g.checking) return;
  if (!login) { g.error = T('WhatsApp nie je pripojený.'); return render(); }
  Object.assign(g, { checking: number, error: '' });
  render();
  try {
    const c = await call('GET', `/resolve_identifier/${q(number)}?user_id=${q(S.userId)}&login_id=${q(login.id)}`, undefined, waApp().base, AbortSignal.timeout(REMOTE_TIMEOUT));
    if (typeof c?.id !== 'string') throw new Error('');
    if (S.overlay !== o || o.group !== g) return;
    g.checking = '';
    const x = { id: c.id, key: `whatsapp:${c.id}`, name: c.name || `+${number}`, avatar: c.avatar_url, sortTs: 0 };
    if (g.picked.some((p) => p.key === x.key)) { Object.assign(o, { query: '', index: 0 }); render(); return void groupFocus(); } // already in: adding never removes
    groupToggle(o, x);
  } catch {
    if (S.overlay !== o || o.group !== g) return;
    Object.assign(g, { checking: '', error: T`WhatsApp číslo +${number} nepozná (alebo práve neodpovedá).` });
    render();
  }
}

async function createGroup(o) {
  const g = o.group;
  if (!g || g.state === 'creating') return;
  const login = waLogin();
  const name = g.name.trim();
  const bytes = new TextEncoder().encode(name).length; // the bridge counts bytes: a letter with a diacritic is two
  g.error = !login ? T('WhatsApp nie je pripojený.') : !g.picked.length ? T('Pridaj aspoň jedného človeka.') : !name ? T('Napíš názov skupiny.')
    : bytes > GROUP_NAME_MAX ? T`Názov je pre WhatsApp pridlhý: ${bytes} zo ${GROUP_NAME_MAX} (písmeno s diakritikou sa ráta za dve, emoji za štyri).` : '';
  if (g.error) { render(); return void (!login || !g.picked.length ? groupFocus() : document.querySelector('.cmd.new .grpname')?.focus()); }
  if (!confirm(T`Vytvoriť skupinu „${name}“ na WhatsAppe s ľuďmi: ${g.picked.map((p) => p.name).join(', ')}? WhatsApp im to hneď oznámi.`)) return;
  g.state = 'creating';
  render();
  try {
    const data = await call('POST', `/create_group/group?user_id=${q(S.userId)}&login_id=${q(login.id)}`,
      { name: { name }, participants: g.picked.map((p) => p.id) }, waApp().base);
    if (!data.mxid) throw new Error(T('most nevrátil chat skupiny'));
    if (S.overlay === o) S.overlay = null;
    S.focusComposer = true;
    select(data.mxid);
    render();
    const failed = Object.entries(data.failed_participants || {});
    if (failed.length) await groupInvites(failed, g.picked);
  } catch (err) {
    g.state = 'idle';
    g.error = T`Skupinu sa nepodarilo vytvoriť: ${err.message || T('neznáma chyba')}`;
    if (S.overlay === o) render(); else alert(g.error); // closed by a click beside it meanwhile
  }
}

/** Members WhatsApp did not add (their privacy settings): the bridge gives each an invitation to the group, which
 *  goes to that person's own chat only once Karchi agrees. */
async function groupInvites(failed, picked) {
  const nameOf = ([id, f]) => picked.find((p) => p.id === id || p.id === f.user_mxid || (f.user_mxid && p.key === ghostKey(f.user_mxid)))?.name || id;
  const can = failed.filter(([, f]) => f.invite_content && f.dm_room_mxid);
  const all = failed.map(nameOf).join(', ');
  if (!can.length) return alert(T`WhatsApp do skupiny nepridal: ${all}. Pozvi ich odkazom na skupinu vo WhatsAppe.`);
  if (!confirm(T`WhatsApp do skupiny nepridal: ${all} (nedovoľuje to ich súkromie). Poslať pozvánku do skupiny do chatu s: ${can.map(nameOf).join(', ')}?`)) return;
  for (const one of can) {
    const [, f] = one;
    try {
      await call('PUT', `/rooms/${q(f.dm_room_mxid)}/send/${f.invite_event_type || 'm.room.message'}/${txnId()}`, f.invite_content);
    } catch (err) {
      alert(T`Pozvánku pre ${nameOf(one)} sa nepodarilo poslať: ${err.message}`);
    }
  }
}

function groupView(o) {
  const g = o.group;
  const query = norm(o.query).trim();
  const picked = new Set(g.picked.map((p) => p.key));
  const people = groupPeople(o)
    .map((x) => ({ x, score: query ? nameScore(x.name, query) : 0 }))
    .filter((p) => p.score >= 0)
    .sort((a, b) => a.score - b.score || b.x.sortTs - a.x.sortTs)
    .slice(0, 30)
    .map((p) => p.x);
  const ask = remoteAsk('whatsapp', o.query);
  const number = ask.kind === 'id' ? ask.value : '';
  o.flat = [...(number ? [() => groupNumber(o, number)] : []), ...people.map((x) => () => groupToggle(o, x))];
  if (o.index >= o.flat.length) o.index = 0;
  const shift = number ? 1 : 0;
  const busy = g.state === 'creating';
  const app = waApp();
  return [
    cmdInput(o, T('Meno alebo číslo s predvoľbou')),
    g.picked.length ? h('div', { class: 'chips' }, g.picked.map((p) => h('button', {
      class: 'chip on', 'data-key': p.key, title: T('Odobrať zo skupiny'), disabled: busy, onclick: () => groupToggle(o, p),
    }, `${p.name} ×`))) : null,
    h('div', { class: 'results', ...listScroll(o) },
      number ? resultRow(o, null, 0, [
        h('div', { class: 'avwrap' }, h('div', { class: 'icon grpicon' }, icon('plus')), h('img', { class: 'badge', src: app.icon, alt: '' })),
        h('div', { class: 'rmeta' }, h('b', {}, T`Pridať +${number}`),
          h('small', {}, g.checking === number ? T('Overujem na WhatsAppe…') : T('WhatsApp najprv overí, či toto číslo má'))),
      ]) : null,
      people.length ? [h('div', { class: 'rsec' }, T('Ľudia na WhatsAppe')), people.map((x, i) => resultRow(o, x, i + shift, [
        h('div', { class: 'avwrap' }, avatar(x.avatar, x.name, 40), h('img', { class: 'badge', src: app.icon, alt: '' })),
        h('div', { class: 'rmeta' }, h('b', {}, highlighted(x.name, o.query)), h('small', {}, picked.has(x.key) ? T('V skupine · Enter odoberie') : T('Enter pridá'))),
        picked.has(x.key) ? h('span', { class: 'grpcheck' }, icon('check')) : null,
      ]))] : number ? null : h('div', { class: 'empty' }, T('Nikoho takého na WhatsAppe nepoznám. Napíš celé číslo s predvoľbou.'))),
    h('div', { class: 'grpform' },
      h('input', {
        class: 'grpname', 'data-root': '__overlay-groupname', placeholder: T('Názov skupiny'), maxlength: GROUP_NAME_MAX, value: g.name, disabled: busy,
        oninput: (e) => { g.name = e.target.value; if (g.error) { g.error = ''; render(); } },
        onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); createGroup(o); } },
      }),
      h('button', { class: 'chip go', disabled: busy, onclick: () => createGroup(o) }, busy ? T('Vytváram…') : T('Vytvoriť skupinu'))),
    h('div', { class: 'rnote grperr' }, g.error), // always there, so clearing it never redraws the name field
    h('div', { class: 'rnote dim' }, T('Enter pridá alebo odoberie človeka, Ctrl+Enter vytvorí skupinu, Esc sa vráti k tvojim kontaktom.')),
  ];
}

let chatOpening = null; // the chat being opened: a second Enter or click while the bridge answers opens nothing more
async function startChat(x) {
  // Picked for an old chat's "Hľadať inak" (writeOther): the old history goes with the chosen one's chat.
  const link = S.overlay?.link;
  const known = x.key || x.contact?.dm_room_mxid;
  const id = known || `${x.app}:${x.contact?.id}`;
  if (chatOpening === id) return;
  remoteDrop(S.overlay);
  S.overlay = null;
  chatOpening = id;
  try {
    if (link && known?.startsWith('!')) return await linkArchived(link, known);
    if (x.contact?.discord && !known) return await openDiscord(x.contact.discord, link || (x.contact.discord.chat ? `archive:${x.contact.discord.chat}` : null));
    if (x.contact?.discordProfile && !known) return void window.open(discordProfileUrl(x.contact.discordProfile), '_blank', 'noopener');
    if (known) {
      select(known);
      S.focusComposer = true;
      return render();
    }
    render();
    const app = LINKS.find((a) => a.id === x.app);
    const data = await call('POST', `/create_dm/${q(x.contact.id)}?user_id=${q(S.userId)}${x.login ? `&login_id=${q(x.login)}` : ''}`, {}, app.base);
    if (data.dm_room_mxid && link) await linkArchived(link, data.dm_room_mxid);
    else if (data.dm_room_mxid) { S.focusComposer = true; select(data.dm_room_mxid); }
  } catch (err) {
    alert(T`Chat sa nepodarilo otvoriť: ${err.message}`);
  } finally {
    chatOpening = null;
  }
}

function newChatView(o) {
  if (o.remote) return remoteView(o);
  if (o.group) return groupView(o);
  const query = norm(o.query).trim();
  const people = contactList(o)
    .map((x) => ({ x, score: query ? nameScore(x.name, query) : 0 }))
    .filter((p) => p.score >= 0)
    .sort((a, b) => a.score - b.score || b.x.sortTs - a.x.sortTs)
    .slice(0, 30);
  // Mail (Gmail, Outlook): a new mail, to the address being typed when it is one.
  const mailTo = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.query.trim()) ? o.query.trim() : '';
  const mail = !o.link && mailAccounts().length && (!query || mailTo || nameScore('novy mail email gmail outlook', query) >= 0);
  const mailApps = [...new Set(mailAccounts().map((l) => l.app))];
  // The last row leaves Weft's own people for one network's search (ArrowUp from the top reaches it).
  const outside = () => openRemote(o, o.link && S.rooms.get(o.link)?.archiveTo?.app);
  // WhatsApp: a new group, and a full number typed here asks WhatsApp for it at once (the network mode, one Enter).
  const wa = !!S.links.whatsapp?.length && !hiddenApps().has('whatsapp');
  const waAsk = remoteAsk('whatsapp', o.query);
  const number = wa && waAsk.kind === 'id' ? waAsk.value : '';
  const group = wa && !o.link && (!query || nameScore('nova skupina whatsapp group', query) >= 0);
  const top = [
    ...(number ? [() => { openRemote(o, 'whatsapp'); remoteSearch(o); }] : []),
    ...(mail ? [() => openMail(mailTo)] : []),
    ...(group ? [() => openGroup(o)] : []),
  ];
  o.flat = [...top, ...people.map(({ x }) => () => startChat(x)), outside];
  if (o.index >= o.flat.length) o.index = 0;
  const shift = top.length;
  const waIcon = LINKS.find((a) => a.id === 'whatsapp').icon;
  return [
    cmdInput(o, o.link ? T`Kto je ${S.rooms.get(o.link)?.bridgeName || 'to'}? Jeho stará história pôjde s ním` : T('Komu chceš napísať?')),
    h('div', { class: 'results', ...listScroll(o) },
      number ? resultRow(o, null, 0, [
        h('div', { class: 'avwrap' }, h('div', { class: 'icon grpicon' }, icon('search')), h('img', { class: 'badge', src: waIcon, alt: '' })),
        h('div', { class: 'rmeta' }, h('b', {}, T`Napísať na WhatsApp +${number}`), h('small', {}, T('WhatsApp najprv overí, či toto číslo má'))),
      ]) : null,
      mail ? resultRow(o, null, number ? 1 : 0, [
        h('div', { class: 'avwrap' }, h('div', { class: 'icon mailicon' }, icon('mail')), h('img', { class: 'badge', src: (mailFrom()?.app || mailApps[0]).icon, alt: '' })),
        h('div', { class: 'rmeta' }, h('b', {}, mailTo ? T`Nový mail pre ${mailTo}` : T('Nový mail')), h('small', {}, mailApps.map((a) => a.name).join(' alebo '))),
      ]) : null,
      group ? resultRow(o, null, shift - 1, [
        h('div', { class: 'avwrap' }, h('div', { class: 'icon grpicon' }, icon('users')), h('img', { class: 'badge', src: waIcon, alt: '' })),
        h('div', { class: 'rmeta' }, h('b', {}, T('Nová skupina na WhatsAppe')), h('small', {}, T('Vyber ľudí a názov · WhatsApp im to hneď oznámi'))),
      ]) : null,
      people.length ? [h('div', { class: 'rsec' }, query ? T('Ľudia') : T('Nedávni')), people.map(({ x }, i) => resultRow(o, x, i + shift, [
        h('div', { class: 'avwrap' }, avatar(x.avatar, x.name, 40), APPS.find((a) => a.id === x.app) ? h('img', { class: 'badge', src: APPS.find((a) => a.id === x.app).icon, alt: '' }) : null),
        h('div', { class: 'rmeta' }, h('b', {}, highlighted(x.name, o.query)), h('small', {}, [APPS.find((a) => a.id === x.app)?.name || '', x.note].filter(Boolean).join(' · '))),
      ]))] : h('div', { class: 'empty' }, T('Nikoho takého nepoznám.')),
      resultRow(o, null, o.flat.length - 1, [
        h('div', { class: 'avwrap' }, h('div', { class: 'icon outside' }, icon('search'))),
        h('div', { class: 'rmeta' }, h('b', {}, o.query.trim() ? T`Hľadať „${o.query.trim()}“ mimo kontaktov` : T('Hľadať mimo kontaktov')),
          h('small', {}, T('Instagram, Messenger, WhatsApp alebo Teams · jedna sieť, až po Enter'))),
      ], ' outside')),
  ];
}

// ------------------------------------------------------------------ new mail (Gmail, Outlook)

const MAIL_APPS = ['gmail', 'outlook'];
/** Mail logins that can send: the ones each bridge holds and that are not waiting for a new sign-in, each with its
 *  app and a key ("gmail:<id>") that names it among all of them. */
const mailAccounts = () => MAIL_APPS.flatMap((id) => (S.links[id] || [])
  .filter((l) => l.state?.state_event !== 'BAD_CREDENTIALS')
  .map((l) => ({ ...l, app: LINKS.find((a) => a.id === id), key: `${id}:${l.id}` })));
/** The account the open mail goes from (an older draft's plain id is a Gmail one); null when that account is no
 *  longer connected: the mail then never goes from another one by itself. */
const mailFrom = () => {
  const from = S.mail?.from || '';
  if (!from) return mailAccounts()[0] || null;
  return mailAccounts().find((l) => l.key === from || (!from.includes(':') && l.app.id === 'gmail' && l.id === from)) || null;
};
/** The app of the open mail's account, also when it is not connected now. */
const mailApp = () => mailFrom()?.app || LINKS.find((a) => a.id === (S.mail?.from?.includes(':') ? S.mail.from.split(':')[0] : 'gmail'));
const MAIL = 'mail:new';
// Gmail takes 25 MB per mail and files grow by a third on the way; Outlook.com takes 20 MB of files. The bridges
// hold the same limits.
const MAIL_LIMITS = { gmail: { bytes: 25 * 1024 * 1024 * 3 / 4, mb: 18 }, outlook: { bytes: 20 * 1024 * 1024, mb: 20 } };
const mailLimit = () => MAIL_LIMITS[mailApp()?.id] || MAIL_LIMITS.gmail;
/** A mail being written that a reload would lose. */
const mailUnsent = () => !!S.mail && !S.mail.sent && (['to', 'cc', 'subject', 'text'].some((k) => String(S.mail[k] || '').trim()) || !!S.attach.get(MAIL)?.length);

function openMail(to = '', subject = '', account = '') {
  S.overlay = null;
  const from = account || mailFrom()?.key || '';
  // A mail being written stays; a new address and subject only fill empty fields, and a reply that names its account
  // (a mail thread's) goes from it. A mail already written to someone else, or one without an address that a thread's
  // reply would take over, is replaced only when Karchi agrees.
  const m = S.mail && !S.mail.sent ? S.mail : null;
  const was = m?.to.trim() || '';
  const other = m && to && mailUnsent() && (was ? was.toLowerCase() !== to.trim().toLowerCase() : !!account);
  if (other && !confirm(T`Máš rozpísaný mail${was ? T` pre ${was}` : ''}. Zahodiť ho a písať odpoveď pre ${to}?`)) S.mail = m;
  else if (m && !other) S.mail = { ...m, from: account || m.from, to: m.to || to, subject: m.subject || subject };
  else {
    if (other) S.attach.delete(MAIL); // the discarded mail's files go with it
    S.mail = { from, to, cc: '', subject, text: '' };
  }
  select(MAIL);
  S.focusComposer = false;
  setTimeout(() => document.querySelector(`[data-root="mail:${!S.mail.to ? 'to' : S.mail.subject ? 'text' : 'subject'}"]`)?.focus());
}

/** The new mail on the right: from, to, copy, subject, text and files; Ctrl+Enter sends. */
function mailView() {
  const m = S.mail || (S.mail = { from: mailAccounts()[0]?.key || '', to: '', cc: '', subject: '', text: '' });
  const accounts = mailAccounts();
  const sender = mailFrom();
  const files = S.attach.get(MAIL) || [];
  const keys = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMail(); } };
  const field = (id, label, props = {}) => h('label', { class: 'mfield' }, h('span', {}, label),
    h('input', { value: m[id], 'data-root': `mail:${id}`, disabled: !!m.sending, oninput: (e) => { m[id] = e.target.value; }, onkeydown: keys, ...props }));
  const head = h('div', { class: 'chead' },
    h('button', { class: 'back', title: T('Späť'), onclick: closeThread }, '‹'),
    h('div', { class: 'icon mailicon' }, icon('mail')),
    h('div', { class: 'ctitle' }, h('b', {}, T('Nový mail')), h('small', {}, h('img', { src: mailApp().icon, alt: '' }), mailApp().name)));
  if (m.sent) {
    return h('div', { class: 'detail chat mail' }, head,
      h('div', { class: 'msgs' }, h('div', { class: 'cstart' }, m.sent,
        h('div', {}, h('button', { class: 'primary', onclick: () => { S.mail = null; openMail('', '', m.from); } }, T('Napísať ďalší'))))));
  }
  // Without any account a mail already being written stays on screen (it says why it cannot go when sent).
  if (!accounts.length && !mailUnsent()) {
    return h('div', { class: 'detail chat mail' }, head, h('div', { class: 'msgs' }, h('div', { class: 'cstart' }, T('Najprv pripoj Gmail alebo Outlook v Nastaveniach → Účty.'))));
  }
  return h('div', { class: 'detail chat mail' }, head,
    h('div', { class: 'mailform' },
      accounts.length > 1 || !sender
        ? h('label', { class: 'mfield' }, h('span', {}, T('Od')), h('select', { disabled: !!m.sending, onchange: (e) => { m.from = e.target.value; m.error = ''; render(); } },
          sender ? null : h('option', { value: '', selected: true, disabled: true }, T('vyber účet (pôvodný už nie je pripojený)')),
          accounts.map((l) => h('option', { value: l.key, selected: l.key === sender?.key }, new Set(accounts.map((x) => x.app)).size > 1 ? `${l.name} (${l.app.name})` : l.name))))
        : h('div', { class: 'mfield' }, h('span', {}, T('Od')), h('span', { class: 'mfrom' }, accounts[0].name)),
      field('to', 'Komu', { placeholder: T('adresa@gmail.com, ďalšia@…'), type: 'email', multiple: true }),
      field('cc', T('Kópia')),
      field('subject', T('Predmet')),
      h('textarea', { class: 'mtext', value: m.text, placeholder: T('Text mailu… (Ctrl+Enter odošle)'), 'data-root': 'mail:text', disabled: !!m.sending,
        oninput: (e) => { m.text = e.target.value; }, onkeydown: keys }),
      eduNote(MAIL),
      m.error ? h('div', { class: 'note' }, m.error) : null,
      eduAtts(MAIL),
      h('div', { class: 'mfoot' },
        h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { const files = [...e.target.files]; e.target.value = ''; takeFiles(files); } }),
        h('button', { class: 'ghost attachfile', disabled: !!m.sending, title: T('Pridať prílohu (aj Ctrl+V alebo pretiahnutím)'), onclick: (e) => e.currentTarget.previousSibling.click() }, icon('plus'), T('Príloha')),
        files.length ? h('small', {}, fileSize(files.reduce((n, f) => n + f.size, 0))) : null,
        h('button', { class: 'primary', disabled: !!m.sending, onclick: sendMail }, m.sending ? T('Odosielam…') : T('Odoslať')))));
}

async function sendMail() {
  const m = S.mail;
  if (!m || m.sending) return;
  const files = S.attach.get(MAIL) || [];
  if (!m.to.trim()) { m.error = T('Napíš, komu mail ide.'); return render(); }
  if (!m.text.trim() && !files.length) { m.error = T('Mail je prázdny.'); return render(); }
  const sender = mailFrom();
  if (!sender) {
    m.error = m.from ? T`Účet ${m.from.split(':').slice(1).join(':') || m.from} už nie je pripojený. Vyber iný v poli Od alebo ho pripoj v Nastaveniach → Účty.` : T('Najprv pripoj Gmail alebo Outlook v Nastaveniach → Účty.');
    return render();
  }
  if (files.reduce((n, f) => n + f.size, 0) > mailLimit().bytes) { m.error = T`Prílohy spolu nad ${mailLimit().mb} MB ${sender.app.name} neprenesie.`; return render(); }
  m.sending = true;
  m.error = '';
  render();
  try {
    const uploaded = await Promise.all(files.map(async (f) => {
      const c = await fileContent(f);
      return { url: c.url, name: f.name, mimetype: c.info.mimetype };
    }));
    await prov(sender.app, 'POST', `/send/${q(sender.id)}`, { to: m.to, cc: m.cc, subject: m.subject, text: m.text, files: uploaded });
    S.mail = { from: sender.key, sent: T`Mail odišiel z ${sender.name} na ${m.to.trim()}. ${sender.app.name} ho má v Odoslanej pošte.` };
    S.attach.delete(MAIL);
  } catch (err) {
    m.error = err?.message || T('Mail neodišiel. Skús to znova.');
  }
  m.sending = false;
  render();
}

function remindView(o) {
  const e = entryOf(o.key);
  const choices = remindChoices();
  o.flat = choices.map(([, ts]) => () => remindAt(e, ts));
  if (e?.remind) o.flat.push(() => remindAt(e, null));
  return [
    h('div', { class: 'rsec' }, T`Pripomenúť: ${e?.title || ''}`),
    h('div', { class: 'results', ...listScroll(o), tabindex: -1, 'data-root': '__overlay', onkeydown: (ev) => {
      const n = Number(ev.key);
      if (n >= 1 && n <= o.flat.length) { ev.preventDefault(); o.flat[n - 1](); }
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); o.index = (o.index + (ev.key === 'ArrowDown' ? 1 : -1) + o.flat.length) % o.flat.length; render(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); o.flat[o.index](); }
    } },
    choices.map(([label, ts], i) => resultRow(o, null, i, [h('kbd', { class: 'num' }, String(i + 1)), h('div', { class: 'rmeta' }, h('b', {}, label)), h('time', {}, `${dayLabel(ts)} ${timeLabel(ts)}`)])),
    e?.remind ? resultRow(o, null, choices.length, [h('kbd', { class: 'num' }, String(choices.length + 1)), h('div', { class: 'rmeta' }, h('b', {}, T('Zrušiť pripomienku'))), h('time', {}, `${dayLabel(e.remind)} ${timeLabel(e.remind)}`)]) : null),
  ];
}

function menuView(o) {
  const e = entryOf(o.key);
  if (!e) return null;
  const item = (glyph, label, key, fn) => ctxItem(glyph, label, key, () => { S.overlay = null; fn(); render(); });
  const room = e.kind === 'room' ? e.room : null;
  return ctxMenu(o, [
    // What Karchi does with the chat in the inbox.
    [item(icon(e.unread ? 'mail-open' : 'mail'), e.unread ? T('Označiť ako prečítané') : T('Označiť ako neprečítané'), 'Ctrl+Shift+U', () => toggleRead(e)),
      e.room?.archiveOnly ? null : item(icon('archive'), e.archived ? T('Vrátiť z archívu') : T('Archivovať'), 'Ctrl+E', () => toggleArchive(e))],
    // When it should come back and how loud.
    [item(icon('bell'), T('Pripomenúť…'), 'Ctrl+L', () => openRemind(e)),
      e.remind ? item(icon('bell-off'), T('Zrušiť pripomienku'), `${dayLabel(e.remind)} ${timeLabel(e.remind)}`, () => remindAt(e, null)) : null,
      item(icon(e.low ? 'arrow-up' : 'arrow-down'), e.low ? T('Zrušiť nízku prioritu') : T('Nízka priorita'), null, () => toggleLow(e)),
      entryPeople(e).length ? item(icon('briefcase'), e.work ? T('Zrušiť značku Práca') : T('Práca: ukázať hneď'), null, () => setWork(entryPeople(e), !e.work)) : null],
    // What is in the chat.
    [room ? item(icon('images'), T('Galéria'), 'Ctrl+P', () => openGallery(room)) : null,
      // The members list, also where there is no mouse to rest on the group's name.
      room && e.key === selKey() && !dmPartner(room) && joinedPeople(room).length
        ? item(icon('users'), T('Členovia'), null, () => openMembers(room, document.querySelector('[data-members="head"]'), false, true)) : null,
      room && !room.archiveOnly ? item(icon('label'), T('Prezývka…'), null, () => openNick(e)) : null,
      room ? item(icon('fill'), T('Farba chatu…'), null, () => openChatLook(e)) : null,
      personChat(e) ? item(icon('user'), T('Profil'), null, () => openProfile(e)) : null],
    // Merged chats: one more of the person's chats, or apart again.
    [room && canMerge(room) ? item(icon('link'), T('Spojiť s…'), null, () => openMergePick(room)) : null,
      e.merged?.auto ? h('div', { class: 'mnote' }, T`Spojené automaticky: ${e.merged.auto === 'people' ? T('ten istý človek v mape ľudí') : T('rovnaké meno')} (${e.rooms.map((x) => appOf(x.app)?.name).join(', ')})`) : null,
      e.merged ? e.rooms.map((x) => item(h('img', { src: appOf(x.app)?.icon, alt: '' }), T`Oddeliť ${appOf(x.app)?.name}: ${roomTitle(x)}`, null, () => unmergeChats(e.merged, x.id))) : null,
      e.merged ? item(icon('unlink'), T('Rozpojiť všetky'), null, () => unmergeChats(e.merged)) : null],
  ]);
}

// ------------------------------------------------------------------ a person's profile

// What WhatsApp and Discord say about the person of a one-to-one chat (each network of a merged chat): WhatsApp's
// „about“ text and statuses of the last day, Discord's bio, pronouns, banner or colour, what they are doing now,
// shared servers and connected accounts. The bridges answer it themselves (server/bridges/*weft-profile.patch); it
// is asked only when the panel opens. Looking tells the person nothing: no receipt ever goes into the status room
// (markRoomRead), and Discord does not tell who opened a profile.
const PROFILE_NETS = {
  whatsapp: { prefix: 'whatsapp_', base: () => LINKS.find((a) => a.id === 'whatsapp').base },
  discord: { prefix: 'discord_', base: () => LINKS.find((a) => a.id === 'discord').legacy },
};
const profileCache = new Map(); // `${app}:${network id}` → { at, data } or { at, error }; loading: true while asked
const PROFILE_FRESH = 10 * 60e3; // the bridges keep theirs longer and ask the network at most every 30 to 60 min
const PROFILE_RETRY = 60e3;

/** The bridge's id of a chat (a WhatsApp JID, a Discord channel), from its m.bridge state. */
function bridgeChannel(r) {
  for (const [key, c] of r.state) if (key.startsWith('m.bridge|')) return c.channel?.id || '';
  return '';
}
/** A real one-to-one chat: not a Discord server's channel or a WhatsApp group that has only one other member left. */
const isDirect = (r) => (r.app === 'discord' ? !r.serverId && !r.server : !/@(g\.us|broadcast|newsletter)$/.test(bridgeChannel(r)));

/** A person seen in a chat, on a network that has a profile: [{ room, app, user, id }], else []. */
function partOf(r, user) {
  const net = !r.archiveOnly && PROFILE_NETS[r.app];
  const local = net && user ? user.slice(1).split(':')[0] : '';
  return net && local.startsWith(net.prefix) ? [{ room: r, app: r.app, user, id: local.slice(net.prefix.length) }] : [];
}
/** The people of an entry's one-to-one chats on networks that have a profile. */
function profileParts(e) {
  if (!e || e.kind !== 'room') return [];
  return (e.rooms || [e.room]).flatMap((r) => (isDirect(r) ? partOf(r, dmPartner(r)?.[0]) : []));
}
/** A chat with one person, on any network: its picture opens their profile. */
const personChat = (e) => e?.kind === 'room' && (e.rooms || [e.room]).every((r) => !r.archiveOnly && isDirect(r) && dmPartner(r));

function loadProfile(p) {
  const key = `${p.app}:${p.id}`;
  const had = profileCache.get(key);
  if (had?.loading || (had?.data && Date.now() - had.at < PROFILE_FRESH) || (had?.error && Date.now() - had.at < PROFILE_RETRY)) return;
  profileCache.set(key, { ...had, loading: true });
  call('GET', `/weft/profile/${q(p.id)}?user_id=${q(S.userId)}`, undefined, PROFILE_NETS[p.app].base(), AbortSignal.timeout(30000))
    .then((data) => profileCache.set(key, { at: Date.now(), data }))
    .catch((err) => profileCache.set(key, {
      at: Date.now(),
      ...had?.data ? { data: had.data } : {},
      // A bridge without the patch does not know the address at all.
      error: err.status === 404 && (err.errcode === 'M_UNRECOGNIZED' || !err.errcode) ? T('Most to zatiaľ nevie (treba ho aktualizovať).')
        : err.status === 404 ? T('Účet nie je pripojený.')
          : err.status === 403 ? T('Discord tento profil neukazuje: nie ste priatelia ani na spoločnom serveri.') : T('Sieť profil teraz nedala.'),
    }))
    .finally(() => { if (S.panel === 'profile') render(); });
}

/** The profile panel for a chat's person (an entry), or for one member of a group (room and user id). */
function openProfile(e, member) {
  const parts = member ? partOf(member.room, member.user) : profileParts(e);
  if (!member && !personChat(e)) return;
  S.profileOf = member ? { room: member.room.id, user: member.user } : { key: e.key };
  S.panel = 'profile';
  S.overlay = null;
  parts.forEach(loadProfile);
  if (parts.some((p) => p.app === 'whatsapp')) loadStatusDay();
  render();
}

/** Pages the status room back (reads only) until it reaches a day ago: a sync brings only its last 40 events. */
async function loadStatusDay() {
  const r = [...S.rooms.values()].find((x) => x.statusRoom);
  const since = Date.now() - 24 * 3600e3;
  for (let page = 0; r && page < 20 && r.prevBatch && !r.matrixDone && !r.loading; page++) {
    let oldest = Infinity;
    for (const ev of r.events.values()) if (Number.isFinite(ev.origin_server_ts)) oldest = Math.min(oldest, ev.origin_server_ts);
    if (oldest < since) return;
    const before = r.prevBatch;
    await loadRoomHistory(r);
    if (r.prevBatch === before) return; // it failed: the next opening tries again
  }
}

/** A status full screen, paging through this person's statuses of the day; the profile stays open beneath. */
function openStatus(ev, senders, who) {
  const r = [...S.rooms.values()].find((x) => x.statusRoom);
  if (!r) return;
  S.overlay = { kind: 'image', room: r.id, event: ev.event_id, statusOf: senders, statusWho: who, zoom: 1, x: 0, y: 0, from: pointerAt };
  render();
}

/** The person's statuses of the last 24 hours, newest first, from the bridge's status room. senders: their ghosts. */
function statusPosts(senders) {
  const room = [...S.rooms.values()].find((r) => r.statusRoom);
  if (!room) return [];
  const m = roomModel(room);
  const since = Date.now() - 24 * 3600e3;
  return [...room.events.values()]
    .filter((ev) => senders.includes(ev.sender) && ev.type === 'm.room.message' && ev.origin_server_ts >= since && !isRedacted(m, ev))
    .sort((a, b) => b.origin_server_ts - a.origin_server_ts);
}

function statusPost(ev, senders, who) {
  const c = ev.content || {};
  const thumb = c.msgtype === 'm.image' ? c.url : c.msgtype === 'm.video' ? c.info?.thumbnail_url : null;
  const caption = c.msgtype === 'm.text' || c.msgtype === 'm.notice' || thumb ? (thumb && c.body === c.filename ? '' : c.body) : c.body;
  const media = c.msgtype === 'm.image' || c.msgtype === 'm.video';
  return h(media ? 'button' : 'div', { class: 'prof-status', 'data-key': ev.event_id, ...media ? { title: T('Otvoriť'), onclick: () => openStatus(ev, senders, who) } : {} },
    thumb ? mediaInPlace(thumb, 320, (url) => h('img', { class: 'prof-shot', src: url, alt: '' }), () => h('div', { class: 'prof-shot' })) : null,
    c.msgtype === 'm.video' ? h('small', {}, icon('play'), T('Video')) : null,
    caption && !(thumb && /^[\w-]+\.(jpe?g|png|webp|mp4)$/i.test(caption)) ? h('p', {}, caption) : null,
    h('small', {}, `${dayLabel(ev.origin_server_ts)} ${timeLabel(ev.origin_server_ts)}`));
}

/** Loading, a failure, or null when the data is there. */
function profileWait(got) {
  if (got?.data) return null;
  return h('p', { class: 'muted' }, got?.error || T('Načítavam…'));
}

function waProfile(p, who) {
  const got = profileCache.get(`whatsapp:${p.id}`);
  // A status may come under the person's LID while the chat has their phone number, or the other way round.
  const server = p.user.slice(p.user.indexOf(':'));
  const senders = [p.user, ...(got?.data?.ids || []).map((id) => `@whatsapp_${id}${server}`)];
  const posts = statusPosts(senders);
  return h('section', { class: 'prof-sec', 'data-key': `wa:${p.id}` },
    h('h3', {}, h('img', { src: appOf('whatsapp')?.icon, alt: '' }), 'WhatsApp'),
    // WhatsApp gives a single space for a person without an about text.
    profileWait(got) || (got.data.about?.trim() ? h('p', { class: 'prof-about' }, got.data.about.trim()) : h('p', { class: 'muted' }, T('Nemá text „o mne“ alebo ho skrýva.'))),
    got?.error && got.data ? h('p', { class: 'muted' }, got.error) : null,
    h('h4', {}, T('Statusy za posledný deň')),
    posts.length ? h('div', { class: 'prof-statuses' }, posts.map((ev) => statusPost(ev, senders, who))) : h('p', { class: 'muted' }, T('Žiadne.')),
    h('p', { class: 'muted' }, T('Pozeranie statusov sa neukáže ako „videné“.')));
}

const presenceWord = (status) => ({ online: T('Online'), idle: T('Nečinný'), dnd: T('Nerušiť'), offline: T('Offline'), invisible: T('Offline') })[status] || status;
function activityLine(a) {
  if (a.type === 'custom') return [a.emoji, a.state].filter(Boolean).join(' ');
  if (a.type === 'listening') return T`Počúva ${a.details ? `${a.details}${a.state ? ` – ${a.state}` : ''}` : a.name}${a.details && a.name ? ` (${a.name})` : ''}`;
  if (a.type === 'playing') return T`Hrá ${a.name}${a.details ? ` · ${a.details}` : ''}`;
  if (a.type === 'watching') return T`Pozerá ${a.details || a.name}`;
  if (a.type === 'streaming') return T`Vysiela ${a.details || a.name}`;
  if (a.type === 'competing') return T`Súťaží: ${a.name}`;
  return a.name || '';
}

// Where a connected account lives, for the types whose address the profile gives.
const ACCOUNT_LINKS = {
  github: (a) => `https://github.com/${q(a.name)}`, twitch: (a) => `https://twitch.tv/${q(a.name)}`,
  youtube: (a) => `https://www.youtube.com/channel/${q(a.id)}`, steam: (a) => `https://steamcommunity.com/profiles/${q(a.id)}`,
  spotify: (a) => `https://open.spotify.com/user/${q(a.id)}`, reddit: (a) => `https://www.reddit.com/user/${q(a.name)}`,
  twitter: (a) => `https://x.com/${q(a.name)}`, instagram: (a) => `https://www.instagram.com/${q(a.name)}`,
  tiktok: (a) => `https://www.tiktok.com/@${q(a.name)}`, bluesky: (a) => `https://bsky.app/profile/${q(a.name)}`,
  roblox: (a) => `https://www.roblox.com/users/${q(a.id)}/profile`, domain: (a) => `https://${a.name.replace(/[^\w.-]/g, '')}`,
};
const ACCOUNT_NAMES = {
  battlenet: 'Battle.net', riotgames: 'Riot Games', leagueoflegends: 'League of Legends', epicgames: 'Epic Games',
  playstation: 'PlayStation', twitter: 'X', youtube: 'YouTube', github: 'GitHub', tiktok: 'TikTok', paypal: 'PayPal',
  ebay: 'eBay', domain: 'Web', bungie: 'Bungie.net', amazon: 'Amazon Music', crunchyroll: 'Crunchyroll',
};
const accountName = (type) => ACCOUNT_NAMES[type] || type.charAt(0).toUpperCase() + type.slice(1);
const colorHex = (n) => `#${(n >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;

function discordProfile(p) {
  const got = profileCache.get(`discord:${p.id}`);
  const d = got?.data;
  const servers = d?.mutual_servers || [];
  const named = servers.filter((g) => g.name);
  const colour = d?.theme_colors?.[0] ?? d?.accent_color;
  return h('section', { class: 'prof-sec', 'data-key': `dc:${p.id}` },
    h('h3', {}, h('img', { src: appOf('discord')?.icon, alt: '' }), 'Discord'),
    profileWait(got) || [
      // The person's own banner or colour, as on their Discord profile.
      d.banner ? h('img', { class: 'prof-banner', src: d.banner, alt: '' }) : colour != null ? h('div', { class: 'prof-banner', style: { background: colorHex(colour) } }) : null,
      h('p', {}, h('b', {}, d.display_name || d.username), ` @${d.username}`, d.pronouns ? ` · ${d.pronouns}` : ''),
      d.presence ? h('p', { class: 'prof-now' }, [presenceWord(d.presence.status),
        ...(d.presence.activities || []).map(activityLine).filter(Boolean),
        // Discord tells about people only on a shared server rarely: an old presence says how old it is.
        Date.now() - d.presence.at > 15 * 60e3 ? T`zistené ${dayLabel(d.presence.at)} ${timeLabel(d.presence.at)}` : ''].filter(Boolean).join(' · ')) : null,
      d.bio ? h('p', { class: 'prof-about' }, d.bio) : null,
      servers.length ? [h('h4', {}, T`Spoločné servery (${servers.length})`),
        h('p', {}, named.slice(0, 12).map((g) => g.name).join(', ') + (servers.length > Math.min(12, named.length) ? ` ${T`a ďalšie (${servers.length - Math.min(12, named.length)})`}` : ''))] : null,
      d.connected_accounts?.length ? [h('h4', {}, T('Pripojené účty')),
        h('ul', { class: 'prof-links' }, d.connected_accounts.map((a) => {
          const link = ACCOUNT_LINKS[a.type]?.(a);
          return h('li', {}, h('span', { class: 'muted' }, `${accountName(a.type)}: `),
            link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, a.name) : a.name, a.verified ? ` ${T('(overený)')}` : '');
        }))] : null,
      got.error ? h('p', { class: 'muted' }, got.error) : null,
    ]);
}

function profileView() {
  const who = S.profileOf || {};
  const e = who.key ? entryOf(who.key) : null;
  const r = who.room ? S.rooms.get(who.room) : null;
  if (!e && !r) return h('div', { class: 'profile' }, h('p', { class: 'muted' }, T('Tento chat už v zozname nie je.')));
  // The network the chat is open on comes first.
  const parts = (e ? profileParts(e) : partOf(r, who.user)).sort((x, y) => (y.room.id === S.selected) - (x.room.id === S.selected));
  parts.forEach(loadProfile); // a data older than PROFILE_FRESH is asked again while the panel is open
  const title = e ? e.title : memberName(r, who.user);
  const pic = e ? roomAvatar(e.rooms?.find(roomAvatar) || e.room) : r.members.get(who.user)?.avatar;
  // Networks that tell nothing more about a person (Messenger, Instagram, EduPage…) are named, not left out silently.
  const apps = [...new Set((e ? e.rooms || [e.room] : [r]).map((x) => x.app))];
  const bare = apps.filter((a) => !parts.some((p) => p.app === a)).map(appOf).filter(Boolean);
  const lookUser = e ? entryPeople(e)[0]?.[0] : who.user;
  return h('div', { class: 'profile' },
    h('div', { class: 'prof-head' }, avatar(pic, title, 64), h('div', {}, h('h2', {}, title),
      h('p', { class: 'prof-nets' }, apps.map(appOf).filter(Boolean).map((a) => h('span', {}, h('img', { src: a.icon, alt: '' }), a.name))))),
    lookUser ? lookPicker(lookUser) : null,
    parts.map((p) => (p.app === 'whatsapp' ? waProfile(p, { name: title, avatar: pic }) : discordProfile(p))),
    bare.length ? h('section', { class: 'prof-sec', 'data-key': 'bare' },
      h('p', { class: 'muted' }, T`${bare.map((a) => a.name).join(', ')}: o človeku len meno a fotka.`)) : null);
}

// ------------------------------------------------------------------ the card beside a message's picture

// A click on the picture beside someone's message opens a small card out of it: what Karchi and that person wrote
// each other over the whole history the archive has (GET /_archive/stats, all networks of a merged chat at once).
// In a group it is about Karchi's own chat with that person, when Weft has one. The name opens the full profile.
const statsCache = new Map(); // room ids joined by ' ' → { at, data } or { at, error }; loading: true while asked
const STATS_FRESH = 2 * 60e3;

/** The chat (an inbox entry) Karchi has with this one person, on any network; null when there is none. In a
 *  one-to-one chat every message not Karchi's is the person's, also an archived one under its old name. */
function personEntry(r, user) {
  if (isDirect(r) && dmPartner(r)) return entryOf(r.id);
  const dm = [...S.rooms.values()].find((x) => !x.archiveOnly && isDirect(x) && dmPartner(x)?.[0] === user);
  return dm ? entryOf(dm.id) : null;
}
const statsRooms = (e) => (e?.kind === 'room' ? (e.rooms || [e.room]).filter((x) => !x.archiveOnly).map((x) => x.id).sort() : []);

function loadStats(e) {
  const rooms = statsRooms(e);
  const key = rooms.join(' ');
  const had = statsCache.get(key);
  if (!rooms.length || had?.loading || (had && Date.now() - had.at < (had.error ? 10e3 : STATS_FRESH))) return;
  statsCache.set(key, { ...had, loading: true });
  archiveGet(`/_archive/stats?${rooms.map((id) => `room=${q(id)}`).join('&')}`)
    .then((data) => statsCache.set(key, { at: Date.now(), data }))
    .catch(() => statsCache.set(key, { ...had, at: Date.now(), error: true, loading: false }))
    .finally(() => { if (S.overlay?.kind === 'whocard') redrawCard(S.overlay); });
}
// The card keeps its first drawing while it grows out of the picture (personCardView, o.grown); what came meanwhile
// shows right after.
function redrawCard(o) {
  (o.grown || Promise.resolve()).then(() => {
    if (S.overlay !== o) return;
    const had = !!document.activeElement?.closest?.('.whocard');
    render();
    if (had) document.querySelector('.whocard .pc-name')?.focus({ preventScroll: true }); // the new drawing keeps the keys
    countUp();
  });
}

function openPersonCard(ev, r, user) {
  const at = ev.currentTarget.getBoundingClientRect();
  const e = personEntry(r, user);
  const o = { kind: 'whocard', was: ev.currentTarget, room: r.id, user, key: e?.key || null, at: { left: at.left, right: at.right, top: at.top, bottom: at.bottom }, grownDone: true };
  S.overlay = o;
  loadStats(e);
  // WhatsApp names group members by LID and DMs by phone: only the bridge knows their chat (it creates nothing).
  const start = !e && r.app === 'whatsapp' && memberStart(r, user);
  if (start) {
    o.finding = true;
    prov(LINKS.find((a) => a.id === 'whatsapp'), 'GET', `/resolve_identifier/${q(start.id)}`)
      .then((found) => {
        const dm = found.dm_room_mxid && S.rooms.has(found.dm_room_mxid) && entryOf(found.dm_room_mxid);
        if (dm) { o.key = dm.key; loadStats(dm); } else if (found.dm_room_mxid) o.findFailed = true; // a chat Weft has not loaded
      })
      .catch(() => { o.findFailed = true; })
      .finally(() => { o.finding = false; redrawCard(o); });
  }
  render();
  // It grows out of the picture once: a circle opening from the picture's centre. The keys go to its name (Enter: the
  // full profile, Esc: closed), not to the chat behind it.
  const card = document.querySelector('.whocard');
  card?.querySelector('.pc-name')?.focus({ preventScroll: true });
  if (card && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const box = card.getBoundingClientRect();
    const x = (at.left + at.right) / 2 - box.left, y = (at.top + at.bottom) / 2 - box.top;
    const far = Math.hypot(Math.max(x, box.width - x), Math.max(y, box.height - y)) + 4;
    const grow = card.animate([{ clipPath: `circle(14px at ${x}px ${y}px)`, transform: 'scale(.94)' }, { clipPath: `circle(${far}px at ${x}px ${y}px)`, transform: 'none' }],
      { duration: 220, easing: 'cubic-bezier(.2, .7, .3, 1)' });
    o.grownDone = false;
    o.grown = grow.finished.catch(() => {}).then(() => { o.grownDone = true; });
  }
  countUp();
}

/** The card's numbers run up to their value once, when they first show. */
function countUp() {
  const card = document.querySelector('.whocard');
  const els = card ? [...card.querySelectorAll('[data-n]:not([data-counted])')] : [];
  if (!els.length) return;
  els.forEach((el) => el.setAttribute('data-counted', ''));
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / 600);
    const eased = 1 - (1 - k) ** 3;
    for (const el of els) if (el.isConnected) el.textContent = Math.round(Number(el.dataset.n) * eased).toLocaleString(LOCALE);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** How long an answer takes, rounded as people say it. */
function answerTime(ms) {
  const min = Math.round(ms / 60e3);
  return min < 1 ? '<1 min' : min < 60 ? `${min} min` : `${Math.round(min / 60)} h`;
}
const daysWord = (n) => `${n.toLocaleString(LOCALE)} ${n === 1 ? T('deň') : n >= 2 && n <= 4 ? T('dni') : T('dní')}`;
const eventsWord = (n) => `${n} ${n === 1 ? T('udalosťou') : T('udalosťami')}`;
const messagesWord = (n) => (n === 1 ? T('správa') : n >= 2 && n <= 4 ? T('správy') : T('správ'));

function personCardView(o) {
  const r = S.rooms.get(o.room);
  if (!r) return null;
  const e = o.key ? entryOf(o.key) : null;
  const had = e && statsCache.get(statsRooms(e).join(' '));
  const sig = [e?.key, e?.title, o.finding, o.findFailed, had?.at, had?.error].join('|');
  const live = document.querySelector('#app > .veil.whoveil');
  if (live?._o === o && (live._sig === sig || !o.grownDone)) return live;
  const veil = whoCard(o, r, e);
  Object.assign(veil, { _o: o, _sig: sig });
  return veil;
}
function whoCard(o, r, e) {
  const title = e ? e.title : memberName(r, o.user);
  const pic = r.members.get(o.user)?.avatar || (e && roomAvatar(e.rooms?.find(roomAvatar) || e.room));
  const apps = [...new Set((e ? e.rooms || [e.room] : [r]).map((x) => x.app))].map(appOf).filter(Boolean);
  const got = e && statsCache.get(statsRooms(e).join(' '));
  const st = got?.data;
  const close = () => closeOverlay();
  const full = () => { S.overlay = null; if (e && personChat(e)) openProfile(e); else openProfile(null, { room: r, user: o.user }); };
  // Beside the picture, toward the middle of the window; upward from it when it sits low, as the newest messages do.
  const W = 248;
  const left = o.at.right + 10 + W <= innerWidth - 8 ? o.at.right + 10 : Math.max(8, o.at.left - 10 - W);
  const up = o.at.bottom > 280;
  const place = up ? { left: `${left}px`, bottom: `${Math.max(8, innerHeight - o.at.bottom)}px` } : { left: `${left}px`, top: `${Math.max(8, o.at.top)}px` };
  const n = (v) => h('span', { 'data-n': String(v) }, v.toLocaleString(LOCALE));
  const first = st?.first ? new Date(st.first) : null;
  const top = st ? Math.max(1, ...st.months.map(([, c]) => c)) : 1;
  const monthLabel = ([ym, c]) => `${MONTHS[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}: ${c.toLocaleString(LOCALE)}`;
  const shortMonth = (ym) => `${MONTHS[Number(ym.slice(5)) - 1]} ${ym.slice(2, 4)}`;
  const firstName = String(title).split(/\s+/)[0];
  return h('div', { class: 'veil clear whoveil', onclick: close, oncontextmenu: (ev) => { ev.preventDefault(); close(); } },
    h('div', { class: 'whocard', style: place, onclick: (ev) => ev.stopPropagation() },
      h('div', { class: 'pc-head' }, avatar(pic, title, 28),
        h('div', { class: 'pc-who' },
          h('button', { class: 'pc-name', title: T('Celý profil'), onclick: full }, title),
          h('div', { class: 'pc-sum' },
            st ? [n(st.total), ` ${messagesWord(st.total)}`] : got?.error ? T('archív teraz neodpovedá') : e || o.finding ? T('počítam…') : o.findFailed ? T('chat sa nepodarilo nájsť') : T('len v skupinách'),
            apps.map((a) => h('img', { src: a.icon, alt: a.name, title: a.name }))))),
      st?.total ? [
        h('div', { class: 'pc-sec' },
          h('div', { class: 'pc-split', title: T`ty ${st.me} · ${firstName} ${st.them}` }, h('i', { style: { width: `${(st.me / st.total) * 100}%` } })),
          h('div', { class: 'pc-legend' }, h('span', {}, h('em', { class: 'me' }), T('ty'), ' ', n(st.me)), h('span', {}, h('em'), `${firstName} `, n(st.them)))),
        h('dl', { class: 'pc-sec pc-rows' },
          h('dt', {}, T('Od')), h('dd', {}, `${MONTHS[first.getMonth()]} ${first.getFullYear()}`),
          h('dt', {}, T('Séria')), h('dd', {}, T`${daysWord(st.streak)} po sebe`),
          h('dt', {}, T('Odpovedá')), h('dd', {}, st.reply.them == null ? '–' : T`do ${answerTime(st.reply.them)}`, st.reply.me == null ? null : h('small', {}, T` · ty ${answerTime(st.reply.me)}`))),
        h('div', { class: 'pc-sec' },
          h('div', {
            class: 'pc-spark',
            // The month under the pointer is named under the bars; nothing covers the card.
            onpointerover: (ev) => { const b = ev.target.closest('i[data-m]'); ev.currentTarget.parentElement.querySelector('.pc-mon').textContent = b ? b.dataset.m : ''; },
            onpointerleave: (ev) => { ev.currentTarget.parentElement.querySelector('.pc-mon').textContent = ''; },
          }, st.months.map((m, i) => h('i', { 'data-m': monthLabel(m), style: { height: `${Math.max(2, Math.round((m[1] / top) * 18))}px`, animationDelay: `${i * 20}ms` } }))),
          h('div', { class: 'pc-axis' }, h('span', {}, shortMonth(st.months[0][0])), h('span', { class: 'pc-mon' }), h('span', {}, shortMonth(st.months.at(-1)[0])))),
      ] : null));
}

const SHORTCUTS = [
  ['Ctrl+J', T('Nájsť nástroj podľa mena (bez skratky)')], ['Ctrl+K', T('Hľadať chaty, ľudí a správy')], ['Ctrl+Shift+K', T('Nová správa (aj Ctrl+N)')], ['Ctrl+U', T('Ďalší neprečítaný chat')],
  // avoid-ai-design-ignore: CP3 — literal arrow keys in the shortcut reference.
  ['Ctrl+1 … 9', T('Prvých 9 chatov')], ['Ctrl+Tab', T('Ďalší chat (so Shift predošlý)')], ['Ctrl+Alt+← →', T('Späť a dopredu medzi chatmi')], ['Ctrl+↓', T('Na najnovšie správy v chate')],
  ['Ctrl+E', T('Archivovať / vrátiť')], ['Ctrl+Shift+E', T('Archivovať všetky prečítané')], ['Ctrl+Shift+U', T('Prečítané / neprečítané')],
  ['Ctrl+L', T('Pripomenúť neskôr')], ['Ctrl+R', T('Odpovedať na poslednú správu')], ['Ctrl+Enter', T('Odoslať a archivovať')],
  ['Ctrl+Shift+A', T('Nahrať hlasovku (Enter odošle, Esc zahodí)')],
  ['Ctrl+Shift+Space', T('Hlasovka: prehrať / pozastaviť (v chate prvú nevypočutú)')], ['← →', T('Na hlasovke: o 5 s späť a dopredu (Space prehrá, Ctrl+S stiahne)')],
  ['↑', T('Upraviť svoju poslednú správu (v prázdnom poli)')], ['Shift+Enter', T('Nový riadok')], ['Ctrl+Shift+S', T('Len neprečítané / všetky')], ['Ctrl+S', T('Odložiť koncept (spýta sa, kedy pripomenúť; Ctrl+S znova = bez pripomienky); v prázdnom poli vziať odložený')], ['Ctrl+G', T('Známky (Tab prepína)')], ['Ctrl+M', T('Ľudia: mapa, koho odkiaľ poznáš')], ['Ctrl+D', T('Kalendár (D T M Z zobrazenie, ← → posun, N nová)')],
  ['Ctrl+,', T('Nastavenia')], ['Esc', T('Zavrieť, zrušiť odpoveď, zavrieť chat')],
  ['Ctrl+V', T('Vložiť obrázok do správy')], ['Ctrl+← →, koliesko', T('Obrázky a videá: predošlý a ďalší (na obrázku aj ← →)')], ['← → / Space', T('Video: o 5 s späť a dopredu / prehrať; podržať Space = 2× rýchlo')], ['Ctrl+koliesko', T('Obrázky: priblížiť (aj dvojklik, + − 0)')],
  ['Ctrl+S', T('Obrázky: stiahnuť')], ['Ctrl+P', T('Galéria chatu: fotky a videá (šípky, Enter, PageUp/PageDown po mesiacoch, J ukáže v chate)')], ['Ctrl+Shift+Enter', T('Odoslať neskôr (aj /sendlater, pravý klik na odoslať)')], ['/gif', T('Poslať GIF')],
  [':srdce', T('Emoji podľa mena (Tab alebo Enter vloží)')],
];

/** Every tool and action Weft has, for Ctrl+J: [name, other words it is found by, shortcut, run, false when it needs
 *  an open chat and none is (an EduPage thread counts for archive, read and remind, not for writing), true when it
 *  never wins by its name alone (it hides or archives a lot at once: "edupage" means grades, not hiding EduPage)]. */
function toolList() {
  const e = selectedEntry();
  const selected = S.rooms.get(S.selected);
  const r = selected?.archiveOnly ? null : selected;
  const call = callButtonTarget(r); // only where the chat has a call: elsewhere Ctrl+J does not offer it
  const show = (name) => Object.assign(() => { if (S.panel !== name) togglePanel(name); }, { panel: name }); // never closes it
  const hidden = hiddenApps();
  return [
    [T('Hľadať chaty, ľudí a správy'), 'search find vyhladavanie najst', 'Ctrl+K', () => openSearch()],
    [T('Nová správa'), 'new message napisat novy chat konverzacia', 'Ctrl+N', openNewChat],
    [T('Nový mail'), 'gmail outlook email napisat novy mail posta', null, () => openMail()],
    ...(S.links.whatsapp?.length && !hidden.has('whatsapp') ? [[T('Nová skupina na WhatsAppe'), 'whatsapp nova skupina group vytvorit', null, openNewGroup]] : []),
    [T('Známky'), 'edupage znamky hodnotenie skola grades', 'Ctrl+G', show('grades')],
    [T('Ľudia: mapa, koho odkiaľ poznáš'), 'people mapa priatelia kamarati kamosi friends vetvy druzina', 'Ctrl+M', show('people')],
    [T('Kalendár'), 'kalendar calendar kalendarix udalosti rozvrh tyzden mesiac', 'Ctrl+D', toggleCalendar],
    [T('Automatizácie'), 'procesy skripty cron ulohy systemd hermes automatizacie', '', () => { location.href = '/automatizacie/'; }],
    [T('Nastavenia'), 'settings ucty ucet pripojit siete tema tmavy gmail outlook teams microsoft mail email login', 'Ctrl+,', show('settings')],
    [T('EduPage: oznamy a predmety'), 'edupage oznamy typy predmety skryt suplovanie farby ikony skupina nastavenia', '', () => togglePanel('settings', 'edupage')],
    [S.showAll ? T('Len neprečítané') : T('Všetky chaty, aj prečítané'), 'unread neprecitane precitane vsetky filter', 'Ctrl+Shift+S', () => setShowAll(!S.showAll)],
    [T('Ďalší neprečítaný chat'), 'next unread dalsi neprecitany', 'Ctrl+U', nextUnread],
    ...(batchPrefs().mode !== 'live' && canOpenWindow() ? [[T`Ukázať nové správy a feed na ${windowMinutes()} min`, 'zobrazit cakaju caka spravy nove reveal okno citanie', '', openWindow]] : []),
    ...BATCH_MODES.filter(([id]) => id !== batchTarget().mode).map(([id, label]) => [T`Nové správy: ${label.toLowerCase()} (od zajtra)`,
      'zobrazovat davky 3x denne casy rusit vyrusovat notifikacie', '', () => saveBatches({ mode: id })]),
    [T('Archivovať všetky prečítané'), 'archive archiv precitane upratat', 'Ctrl+Shift+E', archiveAllRead, true, true],
    ...BOXES.filter(([id]) => id !== S.box).map(([id, label]) => [T`Zobraziť: ${label}`, 'zobrazenie priecinok folder view', '', () => setBox(id)]),
    ...APPS.map((a) => [`${hidden.has(a.id) ? T('Ukázať') : T('Skryť')} ${a.name}`, 'siet filter aplikacia', '', () => toggleApp(a.id), true, !hidden.has(a.id)]),
    [e?.archived ? T('Vrátiť chat z archívu') : T('Archivovať chat'), 'archive archiv hotovo', 'Ctrl+E', () => toggleArchive(e), !!e],
    [e?.unread ? T('Označiť ako prečítané') : T('Označiť ako neprečítané'), 'read unread precitane neprecitane', 'Ctrl+Shift+U', () => toggleRead(e), !!e],
    [T('Pripomenúť chat neskôr'), 'remind snooze pripomienka', 'Ctrl+L', () => openRemind(e), !!e],
    [T('Odpovedať na poslednú správu'), 'reply odpoved', 'Ctrl+R', replyToLast, !!r],
    [T('Upraviť svoju poslednú správu'), 'edit opravit', '↑', () => { const [lr, ev] = r ? lastEditableIn(r) : []; if (ev) startEdit(lr, ev); render(); }, !!r],
    [T('Nahrať hlasovku'), 'voice hlasova sprava audio nahravka mikrofon', 'Ctrl+Shift+A', toggleRecording, !!r],
    [T('Prehrať / pozastaviť hlasovku'), 'voice hlasovka prehrat pustit pozastavit audio play pause', 'Ctrl+Shift+Space', voiceShortcut, !!voice.event || !!r],
    [T('Odoslať neskôr'), 'send later sendlater naplanovat', 'Ctrl+Shift+Enter', () => openLater(r), !!r],
    [T('Keď odpíše, ukázať odpoveď kamošovi…'), 'relay screenshot preposlat odpoved kamos cakam odpise obrazok', '', () => openRelay(r), !!r],
    [T('Poslať GIF'), 'gif klipy obrazok', '/gif', () => openGifs(r), !!r],
    ...(call ? [[callWhere(call.network), 'call hovor volat zavolat videohovor telefon video', '', () => openCall(r)]] : []),
    ...RING_MODES.filter(([id]) => id !== ringMode()).map(([id, label]) => [T`Hovory: ${label.toLowerCase()}`, 'hovor zvonenie zvonit call ring telefon tichy rezim', '', () => saveRing(id)]),
    [T('Galéria: fotky a videá chatu'), 'galeria fotky videa obrazky media photos', 'Ctrl+P', () => openGallery(selected), !!selected],
    [T('Vložiť emoji'), 'emoji smajlik', ':meno', () => openEmoji(r), !!r],
    [T('Prezývka chatu'), 'nickname prezyvka premenovat meno rename', '', () => openNick(e), !!e && e.kind === 'room' && !e.room.archiveOnly],
    [T('Profil človeka: status, bio, aktivita'), 'profil profile about bio status zamena pronouns aktivita hra pocuva servery ucty', '', () => openProfile(e), personChat(e)],
    [T('Spojiť chat s iným chatom toho istého človeka'), 'merge spojit zlucit chaty siete osoba', '', () => openMergePick(r), canMerge(r)],
    ...(e?.merged ? [
      [T('Rozpojiť spojený chat'), 'unmerge rozpojit oddelit chaty', '', () => unmergeChats(e.merged)],
      ...e.rooms.filter((x) => x.id !== S.selected).map((x) => [T`Odoslať cez ${appOf(x.app)?.name}`, 'via siet poslat cez prepnut ucet', '', () => switchVia(e, x.id)]),
    ] : []),
    [T('Klávesové skratky'), 'shortcuts skratky klavesy help pomoc', 'Ctrl+/', () => openOverlay('help')],
  ].map(([name, more, key, fn, can = true, last = false]) => [name, more, key, fn, can, last]);
}

/** How well a typed word fits a tool's word: 3 the same, 2 its start, 1 the same but for the ending ("mapu", "hlasovka"). */
function wordFit(w, x) {
  if (x === w) return 3;
  if (x.startsWith(w)) return 2;
  let i = 0;
  while (i < w.length && w[i] === x[i]) i++;
  return i >= Math.max(3, w.length - 2) ? 1 : 0;
}

/** Ctrl+J: find any tool by its name, without knowing its shortcut; Enter runs it. What can run now comes first, then
 *  the best fit (a word of the name before one of its other words), then a shorter name before a longer. */
function toolsView(o) {
  const words = norm(o.query).split(/\s+/).filter(Boolean);
  const split = (t) => norm(t).split(/[\s:,/]+/).filter(Boolean);
  const tools = toolList().map((t) => {
    const [name, more] = [split(t[0]), split(t[1])];
    const fits = words.map((w) => Math.max(...name.map((x) => wordFit(w, x) * (t[5] ? 1 : 2)), ...more.map((x) => wordFit(w, x))));
    return { t, score: fits.every(Boolean) ? fits.reduce((a, b) => a + b, 0) - (t[5] ? 0.5 : 0) : 0 };
  }).filter((x) => !words.length || x.score > 0)
    .sort((a, b) => (words.length ? b.t[4] - a.t[4] || b.score - a.score || a.t[0].length - b.t[0].length : 0)).map((x) => x.t);
  // A chat's action without an open chat stays listed, greyed, and says why it does nothing. Running a tool closes
  // the panel under it, so what it does (a reply, a recording) is not hidden behind the map.
  o.flat = tools.map(([, , , fn, can]) => () => { if (!can) return; S.overlay = null; if (S.panel !== 'link' && fn.panel !== S.panel) S.panel = null; render(); fn(); });
  if (o.index >= o.flat.length) o.index = 0;
  return [
    cmdInput(o, T('Nástroj alebo akcia, napr. známky, mapa, hlasovka')),
    h('div', { class: 'results', ...listScroll(o) }, tools.length
      ? tools.map(([name, , key, , can], i) => resultRow(o, null, i, [
        h('div', { class: 'rmeta' }, h('b', {}, highlighted(name, o.query)), can ? null : h('small', {}, T('Najprv otvor chat'))),
        key ? h('kbd', {}, key) : null], can ? '' : ' dim'))
      : h('div', { class: 'empty' }, T('Taký nástroj tu nie je.'))),
  ];
}

function overlayView() {
  const o = S.overlay;
  if (!o) return null;
  if (o.kind === 'menu') return menuView(o);
  if (o.kind === 'msgmenu') return msgMenuView(o);
  if (o.kind === 'whocard') return personCardView(o);
  const close = () => closeOverlay();
  if (o.kind === 'image') return viewerView(o);
  if (o.kind === 'gallery') return gal?.el || null;
  // Ctrl+K stays as it is when the window under it is drawn again: when search's data changed (sync, the archive's
  // chats), its results follow in a quiet moment, so new data never holds up typing.
  const live = o.kind === 'search' && document.querySelector('#app > .veil.search');
  if (live?._o === o) { if (!o.base || !sameSig(o.base.sig, searchSig())) searchRedrawSoon(o); return live; }
  const body = o.kind === 'search' ? searchView(o) : o.kind === 'new' ? newChatView(o) : o.kind === 'remind' ? remindView(o) : o.kind === 'chatlook' ? chatLookView(o) : o.kind === 'stashask' ? stashAskView(o)
    : o.kind === 'gif' ? gifView(o) : o.kind === 'emoji' ? emojiView(o) : o.kind === 'later' ? laterView(o) : o.kind === 'tools' ? toolsView(o) : o.kind === 'merge' ? mergePickView(o) : o.kind === 'relay' ? relayPickView(o) : o.kind === 'forward' ? forwardPickView(o) : o.kind === 'nick' ? nickView(o)
    : [h('div', { class: 'rsec' }, T('Klávesové skratky')), h('div', { class: 'results keys', ...listScroll(o) }, SHORTCUTS.map(([k, label]) => h('div', { class: 'krow' }, h('kbd', {}, k), label)))];
  const veil = h('div', { class: `veil${o.kind === 'search' || o.kind === 'tools' || o.kind === 'merge' || o.kind === 'relay' || o.kind === 'forward' ? ' search' : ''}`, onclick: (e) => onVeil(e) && close() }, h('div', { class: `cmd ${o.kind}`, onclick: (e) => e.stopPropagation() },
    h('button', { class: 'pclose', title: T('Zavrieť'), onclick: close }, icon('close')), body));
  if (o.kind === 'search') {
    veil._o = o;
    veil.addEventListener('wheel', wheelThrough, { passive: true }); // never waits for the page: the veil is drawn whole
  }
  return veil;
}

// A veil closes only on a click that also began on a veil: a scrollbar dragged or text selected out of a panel,
// or a press whose panel the next render replaced, ends on it without closing what is open.
let pressedOn = null;
document.addEventListener('pointerdown', (e) => { pressedOn = e.target; }, true);
addEventListener('click', () => { pressedOn = null; }); // a press counts for its own click only
document.addEventListener('pointercancel', () => { pressedOn = null; }, true);
/** The wheel over the open chat beside Ctrl+K scrolls the chat; Ctrl+K stays open and keeps the cursor. Over its
 *  own results the wheel scrolls them as usual. */
function wheelThrough(e) {
  if (e.ctrlKey || e.target.closest('.cmd')) return; // Ctrl+wheel (and a touchpad pinch) zooms
  const veil = e.currentTarget;
  const chat = document.elementsFromPoint(e.clientX, e.clientY).find((x) => !veil.contains(x))?.closest('[data-scroll=chat]');
  if (!chat) return;
  const step = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? chat.clientHeight : 1;
  chat.scrollBy({ top: e.deltaY * step, behavior: 'instant' });
}
const onVeil = (e) => { const ok = e.target === e.currentTarget && !!pressedOn?.classList?.contains('veil'); pressedOn = null; return ok; };

const panel = (content, size = '') => h('div', { class: 'veil', onclick: (e) => onVeil(e) && (S.panel === 'link' ? cancelLink() : (S.panel = null, render())) },
  h('div', { class: `panel ${size}`, 'data-scroll': 'panel', onclick: (e) => e.stopPropagation() },
    h('button', { class: 'pclose', title: T('Zavrieť'), onclick: () => (S.panel === 'link' ? cancelLink() : (S.panel = null, render())) }, icon('close')), content));

// ------------------------------------------------------------------ home and daily reading

const feed = createFeed({
  h, kv: kvDo, refresh, offline: () => !!S.offline, user: () => S.userId, windowsLeft,
  settingsPanel: () => togglePanel('settings', 'feed'), close: () => closeFeed(),
  isOpen: () => S.surface === 'feed', readingWindow, onWindow: takeWindow,
  api: async (method, path, body) => {
    if (method !== 'MEDIA') return call(method, path, body, '/_feed', AbortSignal.timeout(method === 'GET' ? 15000 : 120000));
    const res = await fetch('/_feed' + path, { headers: { Authorization: `Bearer ${S.token}` }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(T('Médium sa nenačítalo alebo už vypršalo.'));
    return res.blob();
  },
  schedule: (item) => { closeFeed(); if (!calNew()) return; cal.edit.title = item.title; cal.edit.notes = item.url; render(); document.querySelector('.home-calendar')?.scrollIntoView({ block: 'start' }); },
});

function showFeed() {
  if (S.panel === 'link') return;
  if (S.surface === 'feed') return closeFeed();
  S.surface = 'feed'; S.panel = null; S.overlay = null;
  history.replaceState(history.state, '', workspaceUrl());
  feed.enter(true); render();
}

function closeFeed() {
  feed.leave(); S.surface = 'calendar';
  history.replaceState(history.state, '', workspaceUrl());
  render();
}

function homeView() {
  return h('main', { class: 'detail home', 'data-scroll': 'home' },
    h('section', { class: 'home-calendar', tabindex: '0', 'aria-label': T('Kalendár') }, calendarView()),
    h('div', { class: 'feed-launch' }, h('button', { class: 'ghost', onclick: showFeed, 'aria-expanded': String(S.surface === 'feed') }, S.surface === 'feed' ? T('Zavrieť feed') : T('Otvoriť denný feed')), h('kbd', {}, 'Ctrl+Shift+F'), h('span', { class: 'mobile-workspace-options' }, workspaceStatus(), h('button', { class: 'ghost', 'aria-label': T('Nastavenia'), onclick: () => togglePanel('settings') }, T('Nastavenia')))),
    S.surface === 'feed' ? h('section', { class: 'feed-drawer', 'aria-label': T('Denný feed') }, feed.view()) : null);
}

// ------------------------------------------------------------------ calendar
// Weft's own calendars, kept on asus (server/calendar/kalendar.py) in Kalendarix's calendars.json layout; Settings
// adds and deletes them, no Kalendarix needed. Ctrl+D opens it on the view chosen in Settings (a week unless changed). Offline the
// last copy shows and edits wait in ep_cal_out, the way messages do. Events of a sync program (the EduPage
// timetable) are shown and not edited.

const CAL_PREFS = 'sk.karchi.calendar'; // { view: 'day' | 'week' | 'month' | 'list', shown: { [calendar id]: bool }, hiddenSubjects: [titleKey], suggest: bool, dismissed: [event id] }
const CAL_VIEWS = [['day', T('Deň'), 'D'], ['week', T('Týždeň'), 'T'], ['month', T('Mesiac'), 'M'], ['list', T('Zoznam'), 'Z']];
const DAYS_SHORT = [T('Ne'), T('Po'), T('Ut'), T('St'), T('Št'), T('Pi'), T('So')];
const CAL_START_HOUR = 5;
const CAL_END_HOUR = 21;
const CAL_HOURS = CAL_END_HOUR - CAL_START_HOUR;
const cal = { today: Cal.dayNumber(Date.now()), doc: null, version: '', seq: 0, loaded: false, error: '', view: 'week', cursor: Cal.startOfDay(Date.now()), edit: null, lastCal: null };
// A click with no Weft window open: sw.js opens /?event=<key>, shown once the calendar is in.
let calAsked = new URLSearchParams(location.search).get('event');
const calDefault = () => (CAL_VIEWS.some(([id]) => id === S.account[CAL_PREFS]?.view) ? S.account[CAL_PREFS].view : 'week');
const calYmd = (d) => { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
const calHm = (d) => timeLabel(d);
const calDate = (ymd, hm = '00:00') => { const [y, m, d] = ymd.split('-').map(Number); const [hh, mm] = hm.split(':').map(Number); return new Date(y, m - 1, d, hh || 0, mm || 0); };
const calOut = () => readJson('ep_cal_out', []);
/** Calendars Weft may add to: not a subscribed feed and not one a sync program fills. */
const calWritable = () => (cal.doc?.calendars || []).filter((c) => !c.sourceUrl && !Cal.isSynced(c));
/** Weft's own choice of calendars to draw (Settings), else what the file says. */
const calShown = (c) => S.account[CAL_PREFS]?.shown?.[c.id] ?? c.visible !== false;
function calSetShown(id, on) {
  const prefs = S.account[CAL_PREFS] || {};
  putAccount(CAL_PREFS, { ...prefs, shown: { ...prefs.shown, [id]: on } }).catch(() => alert(T('Nastavenie sa neuložilo.')));
  render();
}
/** Without the lessons of timetable subjects turned off in Settings → Kalendár: they are not drawn and do not remind. */
function calSubjectsShown(items) {
  const off = new Set(S.account[CAL_PREFS]?.hiddenSubjects || []);
  return off.size ? items.filter((i) => !(i.cal.id === TIMETABLE_CAL && !i.event.allDay && off.has(Cal.titleKey(i.event.title || '')))) : items;
}
const calExpand = (from, to) => calSubjectsShown(Cal.expand(cal.doc, from, to, calShown));

function toggleCalendar() {
  if (S.surface === 'feed') closeFeed();
  if (S.selected) closeThread(); // the calendar shows where the conversation was; its draft is kept
  if (S.panel === 'calendar') { S.panel = null; render(); }
  const section = document.querySelector('.home-calendar');
  section?.focus({ preventScroll: true });
  if (!cal.loaded) loadCalendar();
}

/** Day/week grids fit the available height, showing the waking hours. */
function calScroll() { cal.scrolled = true; }

async function loadCalendar() {
  const token = S.token;
  if (!cal.doc) {
    const kept = await kvDo('readonly', (st) => st.get('calendar')).catch(() => null);
    if (token !== S.token) return;
    if (kept && !cal.doc) setCalDoc(kept, false);
  }
  if (!S.offline) {
    try {
      const doc = await call('GET', '/doc', undefined, '/_calendar', AbortSignal.timeout(15000));
      if (token !== S.token) return;
      setCalDoc(doc);
      cal.error = '';
    } catch (err) {
      if (token !== S.token) return;
      if (isNetErr(err)) goOffline(); else cal.error = T`Kalendár sa nenačítal: ${err.message}`;
    }
  }
  cal.loaded = true;
  refresh();
  if (!cal.scrolled) calScroll();
  if (calAsked && cal.doc) { const key = calAsked; calAsked = null; history.replaceState(null, '', location.pathname); calShowAlarm(key); }
}

function setCalDoc(res, keep = true) {
  cal.seq++;
  cal.doc = res.doc;
  cal.version = res.version;
  // What still waits is laid over the server's copy, so nothing jumps back while it goes out.
  if (cal.doc) for (const op of calOut()) calApply(cal.doc, op);
  if (keep) kvDo('readwrite', (st) => st.put({ doc: res.doc, version: res.version }, 'calendar')).catch(() => {});
  calRemindCheck();
}

/** The same change kalendar.py makes, done here first. */
function calApply(doc, op) {
  cal.seq++;
  if (op.op === 'addcal') {
    if (!doc.calendars.some((x) => x.id === op.cal)) doc.calendars.push({ id: op.cal, name: op.name, color: op.color, customColor: op.color, visible: true, events: [] });
    return;
  }
  const c = doc.calendars.find((x) => x.id === op.cal);
  if (!c) return;
  if (op.op === 'delcal') { doc.calendars = doc.calendars.filter((x) => x !== c); return; }
  const uid = op.uid || op.event.uid;
  const old = c.events.find((e) => e.uid === uid);
  if (op.op === 'del') c.events = c.events.filter((e) => e.uid !== uid);
  else if (old) Object.assign(old, op.event);
  else c.events.push({ description: '', notes: '', location: '', allDay: false, rrule: null, exdates: [], alarmMinutes: '', ...op.event });
}

function calSave(ops, keepEdit = false) {
  cal.doc ||= { schema: 2, calendars: [] }; // nothing on asus yet: the first change starts the file there too
  for (const op of ops) calApply(cal.doc, op);
  localStorage.setItem('ep_cal_out', JSON.stringify([...calOut(), ...ops]));
  calRemindCheck();
  if (!keepEdit) cal.edit = null;
  render();
  flushCal();
}

/** The server's copy again, when it changed: the timetable follows EduPage by itself (substitutions, cancelled
 *  lessons), so a window left open all day follows too. Not while a change of Karchi's is open or on its way. */
let calWrites = 0; // copies taken in so far (rechecks and answers to Karchi's changes): an answer to an older ask loses
async function recheckCalendar() {
  // Hidden, it still follows while reminders are on: the desktop app keeps running with its window closed.
  const busy = () => S.offline || (document.hidden && !calRemindOn()) || cal.edit || calDrag || calFlushing || calOut().length;
  if (!cal.loaded || busy()) return;
  if (!cal.doc) return loadCalendar(); // still nothing on asus: ask again whole
  const token = S.token;
  const writes = ++calWrites;
  try {
    const res = await call('GET', `/doc?have=${encodeURIComponent(cal.version)}`, undefined, '/_calendar', AbortSignal.timeout(15000));
    if (token !== S.token || res.same || !res.doc || writes !== calWrites || busy()) return;
    setCalDoc(res);
    refresh();
  } catch { /* offline or the server restarting: the next round tries again */ }
}
setInterval(recheckCalendar, 120000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) recheckCalendar(); });

// ---- reminders: an event's „Pripomienka“ (alarmMinutes, kept as Kalendarix keeps it) notifies on this device at its
// time, the way a Gmail code does: a system notification while Weft runs (on x270 the desktop's own notifications, only
// while the desktop app is open: closing its window quits it). A click opens the event. Off until Settings → Kalendár
// turns it on (`sk.karchi.calendar` `notify`): Kalendarix gives every event 120 minutes for the phone, so on by
// default it would ring two hours before everything. Calendars hidden in Weft do not remind.
const CAL_REMIND_LATE = 10 * Cal.MS_MINUTE; // a reminder missed (asleep, Weft not running) still comes until its event starts, and at least this long
const calRemindOn = () => S.account[CAL_PREFS]?.notify === true;
const remindKey = () => `ep_cal_reminded:${S.userId}`;
let remindTimer = 0;

/** Reminders around now: each occurrence with an alarm, and when it rings. */
function calAlarms(now) {
  const out = [];
  let ahead = Cal.MS_DAY; // as far ahead as the earliest reminder reaches, at most a month (a longer one rings a month before)
  for (const c of cal.doc.calendars || []) for (const e of c.events || []) if (Number.isFinite(+e.alarmMinutes)) ahead = Math.max(ahead, Math.min(+e.alarmMinutes * Cal.MS_MINUTE, 31 * Cal.MS_DAY));
  for (const i of calExpand(now - Cal.MS_DAY, now + ahead + Cal.MS_DAY)) {
    const m = i.event.alarmMinutes;
    if (m === '' || m == null || !Number.isFinite(+m) || +m < 0 || i.start < now - CAL_REMIND_LATE) continue;
    out.push({ i, at: i.start - +m * Cal.MS_MINUTE, key: `${i.key}|${+m}` });
  }
  return out;
}

/** Rings what is due and waits for the next one (at most a minute: a sleeping machine's timers run late). */
function calRemindCheck() {
  clearTimeout(remindTimer);
  remindTimer = setTimeout(calRemindCheck, Cal.MS_MINUTE);
  if (!cal.doc || !S.userId || !calRemindOn() || !('Notification' in window) || Notification.permission !== 'granted') return;
  const now = Date.now();
  const rung = readJson(remindKey(), {});
  // Kept until its event is long past (the key ends in the event's start), however early it rang.
  for (const k of Object.keys(rung)) if (+k.split('|').at(-2) < now - 2 * Cal.MS_DAY) delete rung[k];
  let next = Infinity;
  for (const a of calAlarms(now)) {
    if (rung[a.key]) continue;
    if (a.at > now) { next = Math.min(next, a.at); continue; }
    if (now >= Math.max(a.i.start, a.at + CAL_REMIND_LATE)) continue;
    rung[a.key] = a.at;
    calNotify(a);
  }
  localStorage.setItem(remindKey(), JSON.stringify(rung));
  if (next - now < Cal.MS_MINUTE) { clearTimeout(remindTimer); remindTimer = setTimeout(calRemindCheck, Math.max(0, next - now) + 200); }
}

function calNotify({ i, key }) {
  const at = i.allDay ? `${dayLabel(i.start)} ${T('celý deň')}` : `${dayLabel(i.start)} ${timeLabel(i.start)}`;
  const body = [at, i.event.location, i.cal.name].filter(Boolean).join(' · ');
  const title = i.event.title || T('Udalosť');
  const tag = `weft-remind:${key}`; // two windows of one browser show one
  try {
    const n = new Notification(title, { body, tag, icon: '/icon.svg' });
    n.onclick = async () => {
      n.close();
      // The window comes forward first: its focus would otherwise go back to the message box after the event opened.
      await window.desktop?.focus?.()?.catch(() => {});
      window.focus();
      calShowAlarm(i.key);
    };
  } catch {
    // A browser that notifies only from its service worker (Android): sw.js sends the click back here.
    navigator.serviceWorker?.ready.then((reg) => reg.showNotification(title, { body, tag, icon: '/icon.svg', data: { calendar: i.key } })).catch(() => {});
  }
}

/** The click on a reminder: the calendar at its day with the event open, the same way a suggestion opens it. */
function calShowAlarm(key) {
  if (!cal.doc) return;
  const start = +key.slice(key.lastIndexOf('|') + 1);
  const i = Cal.expand(cal.doc, start, start + 1, () => true).find((x) => x.key === key);
  if (!i) return;
  if (S.surface === 'feed') closeFeed();
  S.panel = 'calendar'; S.overlay = null; S.menu = false;
  cal.cursor = Cal.startOfDay(i.start);
  if (calTouched()) { render(); calKept(); return; }
  calOpen(i);
  // The keys go to the event, not to the message box of a chat open under it.
  calEditBox()?.querySelector('input[name=title], button.primary')?.focus();
}
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.calendar) calShowAlarm(String(e.data.calendar)); });

let calFlushing = false;
async function flushCal() {
  const ops = calOut();
  if (calFlushing || S.offline || !ops.length) return;
  calFlushing = true;
  let sent = false;
  try {
    const res = await call('POST', '/ops', { ops }, '/_calendar', AbortSignal.timeout(15000));
    calWrites++;
    localStorage.setItem('ep_cal_out', JSON.stringify(calOut().slice(ops.length)));
    setCalDoc(res);
    sent = true;
  } catch (err) {
    if (isNetErr(err)) goOffline();
    else {
      localStorage.setItem('ep_cal_out', JSON.stringify(calOut().slice(ops.length)));
      alert(T`Kalendár zmenu neprijal: ${err.message}`);
      cal.doc = null;
      loadCalendar();
    }
  }
  calFlushing = false;
  refresh();
  // An edit made while this one was on its way goes right after it.
  if (sent && calOut().length) flushCal();
}

// ---- moving around

function calDays() {
  if (cal.view === 'day') return [cal.cursor];
  return Array.from({ length: 7 }, (_, i) => Cal.addDays(cal.cursor, i));
}
function calMove(dir) {
  const c = cal.cursor;
  cal.cursor = cal.view === 'month' ? Cal.startOfMonth(Cal.addMonths(c, dir)) : Cal.addDays(c, dir * ({ day: 1, week: 7, list: 14 }[cal.view]));
  render();
}
function calSetView(view) {
  cal.view = view;
  render();
  if (view === 'day' || view === 'week') calScroll();
}
function calToday() { cal.cursor = Cal.startOfDay(Date.now()); render(); calScroll(); }

function calTitle() {
  const c = cal.cursor;
  if (cal.view === 'day') return `${DAYS[c.getDay()]} ${c.getDate()}. ${MONTH_NAMES[c.getMonth()]} ${c.getFullYear()}`;
  if (cal.view === 'month') return `${MONTH_NAMES[c.getMonth()]} ${c.getFullYear()}`;
  const days = cal.view === 'list' ? [c, Cal.addDays(c, 13)] : [calDays()[0], calDays()[6]];
  const [a, b] = days;
  return a.getMonth() === b.getMonth() ? `${a.getDate()}. – ${b.getDate()}. ${MONTH_NAMES[a.getMonth()]} ${a.getFullYear()}`
    : `${a.getDate()}. ${MONTHS[a.getMonth()]} – ${b.getDate()}. ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
}

/** Keys while the calendar is open and nothing is being typed. */
function calendarKey(e) {
  if (cal.edit) return false;
  const k = e.key.toLowerCase();
  const view = CAL_VIEWS.find(([, , key]) => key.toLowerCase() === k);
  if (view) calSetView(view[0]);
  else if (k === 'arrowleft' || k === 'pageup') calMove(-1);
  else if (k === 'arrowright' || k === 'pagedown') calMove(1);
  else if (k === 'home') calToday();
  else if (k === 'n' && cal.doc) calNew();
  else return false;
  return true;
}

// ---- drawing

/** Dark text on light colours, white on dark ones. */
const inkOn = Cal.textOn;
const calChipStyle = (i) => ({ background: i.color, color: inkOn(i.color), borderLeft: i.accent ? `6px solid ${i.accent}` : '0' });
const calWhen = (i) => (i.allDay ? T('celý deň') : `${calHm(i.start)} – ${calHm(i.end)}`);

function calendarView() {
  const today = Cal.dayNumber(Date.now());
  if (cal.today !== today && !cal.edit) {
    if (Cal.dayNumber(cal.cursor) === cal.today) cal.cursor = Cal.startOfDay(Date.now());
    cal.today = today;
  }
  const head = h('div', { class: 'phead calhead' },
    h('button', { title: T('Späť (←)'), 'aria-label': T('Späť'), onclick: () => calMove(-1) }, '‹'),
    h('button', { title: T('Dnes (Home)'), onclick: calToday }, T('Dnes')),
    h('button', { title: T('Ďalej (→)'), 'aria-label': T('Ďalej'), onclick: () => calMove(1) }, '›'),
    h('b', { class: 'caltitle' }, calTitle()),
    CAL_VIEWS.map(([id, label, key]) => h('button', { class: cal.view === id ? 'on' : '', title: `${label} (${key})`, onclick: () => calSetView(id) }, label)),
    h('button', { class: 'calnew', disabled: !calWritable().length, title: T('Nová udalosť (N)'), onclick: () => calNew() }, T('+ Nová')));
  let body;
  if (!cal.doc) {
    body = h('div', { class: 'empty' }, !cal.loaded ? T('Načítavam kalendár…') : cal.error
      || (S.offline ? T('Offline a kalendár ešte nie je uložený na tomto počítači.') : T('Kalendár je zatiaľ prázdny: kalendár si pridáš v Nastaveniach → Kalendár.')));
  } else if (cal.view === 'month') body = calMonth();
  else if (cal.view === 'list') body = calList();
  else body = calGrid(calDays());
  return h('div', { class: `calendar cal-${cal.view}` }, head, body, cal.edit ? calEditor() : null);
}

/** Day and week: whole-day events in a strip, the rest at their hours. */
function calGrid(days) {
  const from = days[0].getTime();
  const to = Cal.addDays(days[days.length - 1], 1).getTime();
  const all = calExpand(from, to);
  const today = Cal.dayNumber(Date.now());
  const cols = `42px repeat(${days.length}, minmax(0, 1fr))`;
  const dayHead = h('div', { class: 'calrow calnames', style: { gridTemplateColumns: cols } }, h('span'),
    days.map((d) => h('button', { class: `calname${Cal.dayNumber(d) === today ? ' today' : ''}`, onclick: () => { cal.cursor = d; calSetView('day'); } },
      `${DAYS_SHORT[d.getDay()]} `, h('b', {}, String(d.getDate())))));
  const bars = all.filter(Cal.isBar);
  const strip = h('div', { class: 'calrow calbars', style: { gridTemplateColumns: cols } }, h('span', { class: 'calgut' }, T('celý deň')),
    days.map((d) => { const n = Cal.dayNumber(d); return h('div', { class: 'calbarday', ...calDropTarget(calOnDay(d)) }, bars.filter((i) => i.firstDay <= n && i.lastDay >= n).map((i) => calChip(i, i.event.title, n))); }));
  const hours = h('div', { class: 'calhours' }, Array.from({ length: CAL_HOURS + 1 }, (_, i) => h('span', { style: { top: `${i / CAL_HOURS * 100}%` } }, `${pad(CAL_START_HOUR + i)}:00`)));
  const cols2 = days.map((d) => {
    const atHour = (hour) => { const at = new Date(d); at.setHours(hour, 0, 0, 0); return at.getTime(); };
    const start = atHour(CAL_START_HOUR);
    const end = atHour(CAL_END_HOUR);
    const span = end - start;
    const items = Cal.columns(all.filter((i) => !Cal.isBar(i) && i.start < end && (i.end > start || (i.start === i.end && i.start >= start)))
      .map((i) => ({ ...i, start: Math.max(i.start, start), end: Math.min(Math.max(i.end, i.start), end), whole: i })));
    const now = Date.now();
    // Dropped at the half hour under the pointer, less where the event was taken hold of; quarters snap.
    const dropAt = (e, drag) => { const box = e.currentTarget.getBoundingClientRect(); const t = start + (e.clientY - box.top) / box.height * span - drag.ms; return Math.round(t / 9e5) * 9e5; };
    return h('div', { class: 'calday', ...calDropTarget(dropAt), onclick: (e) => { const slot = Math.max(0, Math.min(CAL_HOURS * 2 - 1, Math.floor((e.clientY - e.currentTarget.getBoundingClientRect().top) / e.currentTarget.clientHeight * CAL_HOURS * 2))); const at = start + slot * 18e5; calNew(new Date(at)); } },
      items.map((it) => {
        const top = (it.start - start) / span * 100;
        const height = Math.max(0, (it.end - it.start) / span * 100);
        const change = it.whole.managed ? Cal.lessonChange(it.whole.event) : null;
        const sub = change?.who && change.kind === 'substitution' ? change : null;
        const note = sub ? T`supluje ${sub.who}` : change?.room && change.kind !== 'cancelled' ? T`učebňa ${change.room}` : '';
        return h('button', {
          class: `calev${it.whole.managed ? ' managed' : ''}${change?.kind === 'cancelled' ? ' cancelled' : ''}`, title: `${it.whole.event.title}\n${calWhen(it.whole)}${it.whole.event.location ? `\n${it.whole.event.location}` : ''}${sub ? `\n${T`Supluje ${sub.who} namiesto ${sub.instead}`}` : ''}${change?.room ? `\n${T`Učebňa ${change.room} namiesto ${change.roomBefore}`}` : ''}${it.whole.recurring ? T`\nOpakuje sa ${calRepeatText(it.whole.event.rrule, Date.parse(it.whole.event.start))}` : ''}`,
          style: { top: `${top}%`, height: `calc(${height}% - 1px)`, left: `calc(${(it.col / it.cols) * 100}% + 1px)`, width: `calc(${100 / it.cols}% - 3px)`, ...calChipStyle(it.whole) },
          onclick: (e) => { e.stopPropagation(); calOpen(it.whole); },
          ...calDraggable(it.whole, (e) => { const box = e.currentTarget.getBoundingClientRect(); return { ms: it.start - it.whole.start + (e.clientY - box.top) / box.height * (it.end - it.start) }; }),
        }, h('b', {}, it.whole.event.title), note && height > 3 ? h('small', { class: 'calsub' }, note) : null, height > 5 ? h('small', {}, calWhen(it.whole)) : null);
      }),
      now >= start && now < end ? h('i', { class: 'calnow', style: { top: `${(now - start) / span * 100}%` } }) : null);
  });
  const grid = h('div', { class: 'calgrid', 'data-scroll': 'calgrid' },
    h('div', { class: 'calrow calbody', style: { gridTemplateColumns: cols, height: '100%', backgroundSize: `100% ${100 / CAL_HOURS}%` } }, hours, cols2));
  return [dayHead, strip, grid];
}

/** `day`: the day number the chip is drawn on, so a long bar dragged by that day keeps it under the pointer. */
function calChip(i, label, day = i.firstDay) {
  return h('button', { class: `calchip${i.managed ? ' managed' : ''}`, style: calChipStyle(i), title: `${i.event.title}\n${calWhen(i)}${i.recurring ? T`\nOpakuje sa ${calRepeatText(i.event.rrule, Date.parse(i.event.start))}` : ''}`,
    onclick: (e) => { e.stopPropagation(); calOpen(i); }, ...calDraggable(i, () => ({ days: Math.max(0, day - i.firstDay) })) }, label);
}

/** A day's lessons from one timetable become one line: a school day is one thing, not seven. */
/** A folded school day with a substitution, a cancelled or a moved lesson in it: the line says so. */
const calRunChanged = (run) => run.parts.some((p) => Cal.lessonChange(p.event));

function calFold(items) {
  const out = [];
  const runs = new Map();
  for (const i of items) {
    if (!i.managed || Cal.isBar(i)) { out.push(i); continue; }
    const run = runs.get(i.cal.id);
    if (run) { run.parts.push(i); run.end = Math.max(run.end, i.end); continue; }
    const r = { ...i, parts: [i] };
    runs.set(i.cal.id, r);
    out.push(r);
  }
  return out;
}

function calMonth() {
  const first = Cal.startOfMonth(cal.cursor);
  const start = Cal.startOfWeek(first);
  const all = calExpand(start.getTime(), Cal.addDays(start, 42).getTime());
  const today = Cal.dayNumber(Date.now());
  const cells = Array.from({ length: 42 }, (_, k) => {
    const d = Cal.addDays(start, k);
    const n = Cal.dayNumber(d);
    const items = calFold(all.filter((i) => i.firstDay <= n && i.lastDay >= n).sort((a, b) => (Cal.isBar(b) - Cal.isBar(a)) || a.start - b.start));
    // The change mark leads: a narrow chip cuts its end off.
    const label = (i) => (i.parts?.length > 1 ? `${calRunChanged(i) ? `${T('Zmena')} · ` : ''}${i.cal.name} ${calHm(i.start)}–${calHm(i.end)}` : Cal.isBar(i) ? i.event.title : `${calHm(i.start)} ${i.event.title}`);
    return h('div', { class: `calcell${d.getMonth() !== first.getMonth() ? ' other' : ''}${n === today ? ' today' : ''}`, onclick: () => { cal.cursor = d; calSetView('day'); }, ...calDropTarget(calOnDay(d)) },
      h('span', { class: 'calnum' }, String(d.getDate())),
      items.slice(0, 4).map((i) => calChip(i, label(i), n)),
      items.length > 4 ? h('small', {}, T`+${items.length - 4} ďalšie`) : null);
  });
  return h('div', { class: 'calmonth', 'data-scroll': 'calmonth' },
    [T('Po'), T('Ut'), T('St'), T('Št'), T('Pi'), T('So'), T('Ne')].map((d) => h('span', { class: 'caldow' }, d)), cells);
}

/** Two weeks from the shown day, a heading per day that has something. */
function calList() {
  const from = cal.cursor.getTime();
  const all = calExpand(from, Cal.addDays(cal.cursor, 14).getTime());
  const rows = [];
  for (let k = 0; k < 14; k++) {
    const d = Cal.addDays(cal.cursor, k);
    const n = Cal.dayNumber(d);
    const items = calFold(all.filter((i) => i.firstDay <= n && i.lastDay >= n));
    if (!items.length) continue;
    rows.push(h('h3', { class: `calday-h${n === Cal.dayNumber(Date.now()) ? ' today' : ''}` }, `${DAYS[d.getDay()]} ${d.getDate()}. ${MONTHS[d.getMonth()]}`));
    for (const i of items) {
      const run = i.parts?.length > 1;
      rows.push(h('button', { class: 'calline', onclick: () => (run ? (cal.cursor = d, calSetView('day')) : calOpen(i)) },
        h('i', { style: { background: i.color } }),
        h('span', { class: 'calt' }, Cal.isBar(i) ? T('celý deň') : `${calHm(i.start)} – ${calHm(i.end)}`),
        h('span', {}, run ? T`${i.cal.name}: ${i.parts.length} hodín` : i.event.title, i.event.location && !run ? h('small', {}, ` · ${i.event.location}`) : null,
          run && calRunChanged(i) ? h('small', {}, ` · ${T('zmena v rozvrhu')}`) : null)));
    }
  }
  return h('div', { class: 'callist', 'data-scroll': 'callist' }, rows.length ? rows : h('div', { class: 'empty' }, T('Najbližšie dva týždne nič.')));
}

// ---- one event

const CAL_REPEATS = [['none', T('Neopakuje sa')], ['DAILY', T('Denne')], ['WORKDAYS', T('Každý pracovný deň')], ['WEEKLY', T('Týždenne')], ['MONTHLY', T('Mesačne')], ['YEARLY', T('Ročne')]];
const CAL_UNITS = { DAILY: T('dní'), WEEKLY: T('týždňov'), MONTHLY: T('mesiacov'), YEARLY: T('rokov') };
const CAL_ALARMS = [[5, T('5 minút pred')], [15, T('15 minút pred')], [30, T('30 minút pred')], [60, T('1 hodinu pred')], [120, T('2 hodiny pred')], [1440, T('1 deň pred')]];
const WD_SHORT = [T('Po'), T('Ut'), T('St'), T('Št'), T('Pi'), T('So'), T('Ne')];
const WD_ON = LANG === 'en' ? ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] : ['pondelok', 'utorok', 'stredu', 'štvrtok', 'piatok', 'sobotu', 'nedeľu']; // i18n-ignore: each language's own names
const WORKDAYS = Cal.WEEKDAYS.slice(0, 5);
const weekdayIndex = (d) => (new Date(d).getDay() + 6) % 7;
const ruleDays = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
const sameList = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const nthOf = (d) => Math.ceil(new Date(d).getDate() / 7);
/** „2.“ in Slovak, „2nd“ in English (the weeks of a month only go to 5). */
const nth = (n) => (LANG === 'en' ? `${n}${['th', 'st', 'nd', 'rd'][n] || 'th'}` : `${n}.`);
const isLastOf = (d) => { const x = new Date(d); return x.getDate() + 7 > Cal.daysInMonth(x.getFullYear(), x.getMonth()); };
const alarmLabel = (m) => CAL_ALARMS.find(([v]) => v === +m)?.[1] || T`${m} minút pred`;
const ymdText = (d) => { const x = new Date(d); return `${x.getDate()}. ${x.getMonth() + 1}. ${x.getFullYear()}`; };

/** "každý týždeň v Po, St, 10-krát": a rule as Karchi would say it. */
function calRepeatText(rule, start) {
  if (!rule?.FREQ) return '';
  const n = rule.INTERVAL > 1 ? Math.floor(rule.INTERVAL) : 1;
  const days = ruleDays(rule.BYDAY);
  const every = (one, many) => (n > 1 ? T`každých ${n} ${many}` : one);
  let text;
  if (rule.FREQ === 'DAILY') text = sameList(days, WORKDAYS) ? T('každý pracovný deň') : every(T('každý deň'), T('dní')) + (days.length ? ` (${days.map((t) => WD_SHORT[Cal.WEEKDAYS.indexOf(t)]).join(', ')})` : '');
  else if (rule.FREQ === 'WEEKLY') text = `${every(T('každý týždeň'), T('týždňov'))} ${T`v ${(days.length ? days.map((t) => Cal.WEEKDAYS.indexOf(t.slice(-2))) : [weekdayIndex(start)]).sort((a, b) => a - b).map((i) => WD_SHORT[i]).join(', ')}`}`;
  else if (rule.FREQ === 'MONTHLY') {
    const m = days.length === 1 && /^(-?\d)(MO|TU|WE|TH|FR|SA|SU)$/.exec(days[0]);
    const md = Array.isArray(rule.BYMONTHDAY) ? rule.BYMONTHDAY : rule.BYMONTHDAY != null ? String(rule.BYMONTHDAY).split(',') : [];
    const day = m ? (m[1] === '-1' ? `${[T('posledný'), T('posledný'), T('poslednú'), T('posledný'), T('posledný'), T('poslednú'), T('poslednú')][Cal.WEEKDAYS.indexOf(m[2])]} ${WD_ON[Cal.WEEKDAYS.indexOf(m[2])]}` : `${nth(Number(m[1]))} ${WD_ON[Cal.WEEKDAYS.indexOf(m[2])]}`)
      : md.length ? T`dňa ${md.join(', ')}.` : days.length ? `(${days.join(', ')})` : T`dňa ${new Date(start).getDate()}.`;
    text = `${every(T('každý mesiac'), T('mesiacov'))} ${m ? T`v ${day}` : day}`;
  } else text = `${every(T('každý rok'), T('rokov'))} ${LANG === 'en' ? `${MONTH_NAMES[new Date(start).getMonth()]} ${new Date(start).getDate()}` : `${new Date(start).getDate()}. ${MONTH_NAMES[new Date(start).getMonth()]}`}`;
  if (rule.COUNT > 0) text += T`, ${rule.COUNT}-krát`;
  else if (rule.UNTIL) { const u = Cal.parseUntil(rule.UNTIL); if (u !== null) text += T`, do ${ymdText(u)}`; }
  return text;
}

/** The repeat fields of the editor for a rule (null for none), read at `start`. */
function calRepeatState(rule, start) {
  const r = rule?.FREQ ? rule : null;
  const days = ruleDays(r?.BYDAY);
  let repeat = r ? r.FREQ : 'none';
  if (r?.FREQ === 'DAILY' && sameList(days, WORKDAYS)) repeat = 'WORKDAYS';
  let monthMode = 'date';
  if (r?.FREQ === 'MONTHLY') {
    const md = r.BYMONTHDAY == null ? [] : [].concat(r.BYMONTHDAY).map(Number);
    const m = days.length === 1 && /^(-?\d)(MO|TU|WE|TH|FR|SA|SU)$/.exec(days[0]);
    if (r.BYSETPOS != null || (md.length && !(md.length === 1 && md[0] === new Date(start).getDate() && !days.length))) monthMode = 'kept';
    else if (m && !md.length) monthMode = m[1] === '-1' ? 'last' : +m[1] === nthOf(start) ? 'nth' : 'kept';
    else if (days.length) monthMode = 'kept';
  }
  const until = r?.UNTIL ? Cal.parseUntil(r.UNTIL) : null;
  return { repeat, interval: r?.INTERVAL > 0 ? Math.floor(r.INTERVAL) : 1, byday: r?.FREQ === 'WEEKLY' && days.length ? days.map((t) => Cal.WEEKDAYS.indexOf(t.slice(-2))).filter((i) => i >= 0) : [weekdayIndex(start)],
    monthMode, ending: r?.COUNT ? 'count' : r?.UNTIL ? 'until' : 'never', count: r?.COUNT || 10, until: calYmd(until ?? Cal.addDays(start, 90)), keptRule: r, ruleTouched: false, daysTouched: false };
}

/** The rule the editor describes. `ref` is the day shown (an nth weekday is read from it), `anchor` the series' first start,
 *  `movedFrom` where the shown occurrence was before its day changed. */
function calRuleOf(ed, ref, anchor = ref, movedFrom = null) {
  if (ed.repeat === 'none') return null;
  const freq = ed.repeat === 'WORKDAYS' ? 'DAILY' : ed.repeat;
  // Parts the editor has no control for stay, as long as the kind of rule does (Kalendarix does the same).
  let rule = { ...(ed.keptRule?.FREQ === freq ? ed.keptRule : {}), FREQ: freq, INTERVAL: ed.repeat === 'WORKDAYS' ? 1 : Math.max(1, Math.floor(+ed.interval) || 1) };
  delete rule.COUNT; delete rule.UNTIL;
  if (ed.repeat === 'WORKDAYS') rule.BYDAY = [...WORKDAYS];
  else if (freq === 'DAILY' && (ed.ruleTouched || sameList(ruleDays(rule.BYDAY), WORKDAYS))) delete rule.BYDAY;
  else if (freq === 'WEEKLY') {
    const days = [...new Set(ed.byday)].sort((a, b) => a - b);
    if (days.length && !(days.length === 1 && days[0] === weekdayIndex(anchor))) rule.BYDAY = days.map((i) => Cal.WEEKDAYS[i]);
    else delete rule.BYDAY;
  } else if (freq === 'MONTHLY' && ed.monthMode !== 'kept') {
    delete rule.BYDAY; delete rule.BYMONTHDAY; delete rule.BYSETPOS;
    if (ed.monthMode === 'nth') rule.BYDAY = [`${nthOf(ref)}${Cal.WEEKDAYS[weekdayIndex(ref)]}`];
    if (ed.monthMode === 'last') rule.BYDAY = [`-1${Cal.WEEKDAYS[weekdayIndex(ref)]}`];
  } else if (movedFrom != null && (freq === 'MONTHLY' || freq === 'YEARLY')) rule = Cal.shiftRule(rule, movedFrom, ref.getTime());
  if (ed.ending === 'count') rule.COUNT = Math.max(1, Math.floor(+ed.count) || 1);
  if (ed.ending === 'until') rule.UNTIL = Cal.untilOf(calDate(ed.until));
  return rule;
}

/** An event being written stays open: a click on the grid, another event, + Nová or a drop never replaces it, only
 *  brings it back to the eye. Escape, Zrušiť and Uložiť still close it. */
// A change is a field Karchi fills in, as written (also a blank or invalid one); what only shows or asks, or was
// changed and set back, is none.
const CAL_EDIT_FIELDS = ['cal', 'title', 'allDay', 'date', 'time', 'endDate', 'endTime', 'location', 'notes', 'alarm', 'category', 'accent',
  'repeat', 'interval', 'ending', 'count', 'until', 'monthMode'];
const calEditSig = (ed) => JSON.stringify([...CAL_EDIT_FIELDS.map((k) => String(ed[k] ?? '')), [...new Set(ed.byday || [])].sort((x, y) => x - y)]);
const calTouched = () => !!cal.edit && calEditSig(cal.edit) !== cal.editFrom;
/** The editor in sight: the calendar panel's lies over the home one. */
const calEditBox = () => [...document.querySelectorAll('.caledit')].pop();
function calKept() {
  if (!calTouched()) return false;
  const box = calEditBox();
  box?.scrollIntoView({ block: 'nearest' });
  box?.querySelector('input[name=title]')?.focus({ preventScroll: true });
  return true;
}
function calEditOpen(ed) {
  cal.edit = ed;
  cal.editFrom = calEditSig(ed);
}

/** A new event at `at`; `fill` sets fields of the editor before it opens (a suggestion from a message). */
function calNew(at = null, fill = {}) {
  const cals = calWritable();
  if (!cals.length || calKept()) return false;
  let s = at;
  if (!s) { s = new Date(cal.cursor); s.setHours(Cal.dayNumber(s) === Cal.dayNumber(Date.now()) ? new Date().getHours() + 1 : 9, 0, 0, 0); }
  const e = new Date(s.getTime() + Cal.MS_HOUR);
  calEditOpen({ isNew: true, cal: cals.some((c) => c.id === cal.lastCal) ? cal.lastCal : cals[0].id, uid: Cal.newUid(), title: '', allDay: false,
    date: calYmd(s), time: calHm(s), endDate: calYmd(e), endTime: calHm(e), location: '', notes: '', alarm: '', category: '', accent: '', more: false,
    ...calRepeatState(null, s), ...fill });
  render();
  calEditBox()?.querySelector('input[name=title]')?.focus();
  return true;
}

/** Opens an occurrence: a series opens at the day clicked, and saving asks whether the change is for that day only. */
function calOpen(i) {
  if (calKept()) return;
  const ev = i.event;
  const s = new Date(i.start);
  const e = new Date(Math.max(i.end, i.start));
  const lastDay = ev.allDay ? Cal.addDays(e, Cal.dayNumber(e) > Cal.dayNumber(s) && e.getHours() === 0 && e.getMinutes() === 0 ? -1 : 0) : e;
  calEditOpen({ isNew: false, managed: i.managed, cal: i.cal.id, from: i.cal.id, uid: ev.uid, at: i.start, title: ev.title, allDay: !!ev.allDay, recurring: i.recurring,
    date: calYmd(s), time: calHm(s), endDate: calYmd(lastDay), endTime: calHm(e), location: ev.location || '', notes: ev.notes || ev.description || '',
    alarm: ev.alarmMinutes === '' || ev.alarmMinutes == null || Number.isNaN(+ev.alarmMinutes) ? '' : String(+ev.alarmMinutes),
    category: ev.category || '', accent: Cal.isHexColor(ev.accent) ? ev.accent.toLowerCase() : '', more: !!(ev.category || ev.accent),
    ...calRepeatState(ev.rrule, s) });
  render();
}

function calEditor() {
  const ed = cal.edit;
  const redraw = (k) => k === 'allDay' || k === 'repeat' || k === 'ending' || k === 'monthMode' || k === 'more';
  const set = (k) => (e) => {
    ed[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (['repeat', 'interval', 'ending', 'count', 'until', 'monthMode'].includes(k)) ed.ruleTouched = true;
    ed.error = '';
    if (redraw(k)) render();
  };
  // Moving the start drags the end along so the length stays, and a weekly series' days follow (as in Kalendarix).
  const moveStart = (k) => (e) => {
    const before = calDate(ed.date, ed.allDay ? '00:00' : ed.time);
    ed[k] = e.target.value;
    const after = calDate(ed.date, ed.allDay ? '00:00' : ed.time);
    if (Number.isNaN(after.getTime()) || Number.isNaN(before.getTime())) return;
    const end = new Date(calDate(ed.endDate, ed.allDay ? '00:00' : ed.endTime).getTime() + (after - before));
    if (!Number.isNaN(end.getTime())) { ed.endDate = calYmd(end); if (!ed.allDay) ed.endTime = calHm(end); }
    const days = Cal.dayNumber(after) - Cal.dayNumber(before);
    if (days && !ed.daysTouched) ed.byday = ed.byday.map((i) => (((i + days) % 7) + 7) % 7);
    render();
  };
  const close = () => { cal.edit = null; render(); };
  const repeatLine = ed.repeat === 'none' ? '' : calRepeatText(calRuleOf(ed, calDate(ed.date)), calDate(ed.date));
  if (ed.managed) {
    const ev = cal.doc.calendars.find((c) => c.id === ed.from)?.events.find((x) => x.uid === ed.uid);
    return h('div', { class: 'caledit' }, h('h3', {}, ed.title),
      h('p', {}, ed.allDay ? T`${ed.date} celý deň` : `${ed.date} ${ed.time} – ${ed.endTime}`),
      ev?.rrule?.FREQ ? h('p', {}, T`Opakuje sa ${calRepeatText(ev.rrule, Date.parse(ev.start))}`) : null,
      ed.location ? h('p', {}, ed.location) : null, ed.notes ? h('p', { class: 'calnotes' }, ed.notes) : null,
      h('p', { class: 'bline' }, T('Túto udalosť zapisuje synchronizácia (rozvrh), tu sa nemení.')),
      h('div', { class: 'calbtns' }, h('button', { class: 'primary', onclick: close }, T('Zavrieť'))));
  }
  const cals = calWritable();
  const ref = calDate(ed.date);
  const freq = ed.repeat === 'WORKDAYS' ? 'DAILY' : ed.repeat;
  const toggleDay = (i) => () => { ed.byday = ed.byday.includes(i) ? ed.byday.filter((x) => x !== i) : [...ed.byday, i]; ed.daysTouched = ed.ruleTouched = true; render(); };
  const repeat = ed.repeat === 'none' ? null : h('div', { class: 'calrepeat' },
    ed.repeat === 'WORKDAYS' ? null : h('label', {}, T('každých '), h('input', { type: 'number', min: 1, max: 99, value: ed.interval, 'aria-label': 'Interval', oninput: set('interval'), onchange: () => render() }), ` ${CAL_UNITS[freq]}`),
    freq === 'WEEKLY' ? h('div', { class: 'caldays', role: 'group', 'aria-label': T('Dni v týždni') }, WD_SHORT.map((d, i) =>
      h('button', { type: 'button', class: ed.byday.includes(i) ? 'on' : '', 'aria-pressed': String(ed.byday.includes(i)), onclick: toggleDay(i) }, d))) : null,
    freq === 'MONTHLY' ? h('select', { 'aria-label': T('Ktorý deň v mesiaci'), onchange: set('monthMode') },
      h('option', { value: 'date', selected: ed.monthMode === 'date' }, T`dňa ${ref.getDate()}.`),
      h('option', { value: 'nth', selected: ed.monthMode === 'nth' }, `${nth(nthOf(ref))} ${WD_ON[weekdayIndex(ref)]}`),
      isLastOf(ref) || ed.monthMode === 'last' ? h('option', { value: 'last', selected: ed.monthMode === 'last' }, `${calRepeatText({ FREQ: 'MONTHLY', BYDAY: [`-1${Cal.WEEKDAYS[weekdayIndex(ref)]}`] }, ref).replace(`${T('každý mesiac')} ${T`v ${''}`}`, '')}`) : null,
      ed.monthMode === 'kept' ? h('option', { value: 'kept', selected: true }, T('ako je zapísané')) : null) : null,
    h('label', {}, 'koniec ', h('select', { 'aria-label': T('Koniec opakovania'), onchange: set('ending') },
      [['never', 'nikdy'], ['count', T('po počte')], ['until', T('dátumom')]].map(([v, l]) => h('option', { value: v, selected: ed.ending === v }, l)))),
    ed.ending === 'count' ? h('label', {}, h('input', { type: 'number', min: 1, max: 999, value: ed.count, 'aria-label': T('Počet opakovaní'), oninput: set('count'), onchange: () => render() }), T(' -krát')) : null,
    ed.ending === 'until' ? h('input', { type: 'date', value: ed.until, 'aria-label': T('Opakuje sa do'), onchange: (e) => { set('until')(e); render(); } }) : null,
    h('p', { class: 'bline calrule' }, repeatLine ? T`Opakuje sa ${repeatLine}.` : ''));
  const cats = Cal.categoryList(cal.doc);
  const more = !ed.more ? h('button', { class: 'ghost calmore', type: 'button', onclick: () => { ed.more = true; render(); } }, T('Kategória a druhá farba'))
    : [h('label', { class: 'calfield' }, T('Kategória '), h('select', { onchange: set('category') },
        h('option', { value: '', selected: !ed.category }, T('podľa kalendára')),
        cats.map((c) => h('option', { value: c.id, selected: ed.category === c.id }, c.name)),
        ed.category && !cats.some((c) => c.id === ed.category) ? h('option', { value: ed.category, selected: true }, ed.category) : null)),
      h('div', { class: 'calaccent', role: 'group', 'aria-label': T('Druhá farba') },
        h('button', { type: 'button', class: !ed.accent ? 'on none' : 'none', 'aria-pressed': String(!ed.accent), onclick: () => { ed.accent = ''; render(); } }, T('Žiadna')),
        Cal.ACCENT_PALETTE.map((c) => h('button', { type: 'button', class: ed.accent === c ? 'on' : '', title: c, 'aria-label': T`Druhá farba ${c}`, 'aria-pressed': String(ed.accent === c), style: { background: c }, onclick: () => { ed.accent = c; render(); } })))];
  const recurring = ed.recurring && !ed.isNew;
  const first = !recurring || calFirstOccurrence(ed);
  let buttons;
  if (ed.asking === 'save') {
    buttons = h('div', { class: 'calbtns calask' }, h('span', {}, T('Opakuje sa. Zmeniť:')),
      ed.ruleTouched ? null : h('button', { type: 'button', class: 'ghost', onclick: () => calSubmit('one') }, T('Len túto')),
      first ? null : h('button', { type: 'button', class: 'ghost', onclick: () => calSubmit('following') }, T('Túto a ďalšie')),
      h('button', { type: 'button', class: 'primary', onclick: () => calSubmit('all') }, T('Celú sériu')),
      h('button', { type: 'button', class: 'ghost', onclick: () => { ed.asking = null; render(); } }, T('Späť')));
  } else if (ed.asking === 'del') {
    buttons = h('div', { class: 'calbtns calask' }, h('span', {}, recurring ? T('Opakuje sa. Zmazať:') : T`Zmazať „${ed.title}“?`),
      recurring ? h('button', { type: 'button', class: 'ghost danger', onclick: () => calDelete('one') }, T('Len túto')) : null,
      recurring && !first ? h('button', { type: 'button', class: 'ghost danger', onclick: () => calDelete('following') }, T('Túto a ďalšie')) : null,
      h('button', { type: 'button', class: 'ghost danger', onclick: () => calDelete('all') }, recurring ? T('Celú sériu') : T('Zmazať')),
      h('button', { type: 'button', class: 'ghost', onclick: () => { ed.asking = null; render(); } }, T('Späť')));
  } else {
    buttons = h('div', { class: 'calbtns' },
      h('button', { class: 'primary', type: 'submit' }, T('Uložiť')),
      h('button', { class: 'ghost', type: 'button', onclick: close }, T('Zrušiť')),
      ed.isNew ? null : h('button', { class: 'ghost danger', type: 'button', onclick: () => { ed.asking = 'del'; render(); } }, T('Zmazať')));
  }
  return h('form', { class: 'caledit', onsubmit: (e) => { e.preventDefault(); calSubmit(); } },
    h('input', { name: 'title', value: ed.title, placeholder: T('Názov'), required: true, oninput: set('title'), 'data-root': '__calTitle' }),
    h('div', { class: 'calwhen' },
      h('input', { type: 'date', value: ed.date, required: true, 'aria-label': T('Začiatok'), onchange: moveStart('date') }),
      ed.allDay ? null : h('input', { type: 'time', value: ed.time, required: true, 'aria-label': T('Čas začiatku'), onchange: moveStart('time') }),
      '–',
      h('input', { type: 'date', value: ed.endDate, required: true, 'aria-label': T('Koniec'), onchange: set('endDate') }),
      ed.allDay ? null : h('input', { type: 'time', value: ed.endTime, required: true, 'aria-label': T('Čas konca'), onchange: set('endTime') }),
      h('label', { class: 'bcheck' }, h('input', { type: 'checkbox', checked: ed.allDay, onchange: set('allDay') }), T('celý deň'))),
    h('select', { class: 'calrepeat-kind', 'aria-label': T('Opakovanie'), onchange: (e) => { set('repeat')(e); if (ed.repeat === 'WEEKLY' && !ed.byday.length) ed.byday = [weekdayIndex(ref)]; render(); } },
      CAL_REPEATS.map(([v, l]) => h('option', { value: v, selected: ed.repeat === v }, l))),
    repeat,
    h('select', { 'aria-label': T('Kalendár'), onchange: set('cal') }, cals.map((c) => h('option', { value: c.id, selected: c.id === ed.cal }, c.name))),
    h('select', { 'aria-label': T('Pripomienka'), onchange: set('alarm') },
      h('option', { value: '', selected: ed.alarm === '' }, T('Bez pripomienky')),
      [...new Set([...CAL_ALARMS.map(([m]) => m), ...(ed.alarm === '' ? [] : [+ed.alarm])])].sort((a, b) => a - b)
        .map((m) => h('option', { value: String(m), selected: ed.alarm === String(m) }, T`Pripomenúť ${alarmLabel(m)}`))),
    h('input', { value: ed.location, placeholder: T('Miesto'), oninput: set('location') }),
    h('textarea', { value: ed.notes, placeholder: T('Poznámka'), rows: 3, oninput: set('notes') }),
    more,
    ed.error ? h('div', { class: 'err' }, ed.error) : null,
    buttons);
}

/** Whether the occurrence being edited is the series' first, so "this and the following" would be the whole series. */
function calFirstOccurrence(ed) {
  const ev = calEvent(ed.from, ed.uid);
  return !ev || !Cal.countBefore(ev, ed.at);
}
const calEvent = (calId, uid) => cal.doc?.calendars.find((c) => c.id === calId)?.events.find((e) => e.uid === uid);

/** The event as the editor has it: times, texts, reminder, colours (not the uid or repetition). */
function calFields(ed, old = {}) {
  const start = ed.allDay ? calDate(ed.date) : calDate(ed.date, ed.time);
  const end = ed.allDay ? Cal.addDays(calDate(ed.endDate), 1) : calDate(ed.endDate, ed.endTime);
  const out = { title: ed.title.trim(), start: start.toISOString(), end: end.toISOString(), allDay: ed.allDay,
    location: ed.location.trim(), notes: ed.notes, description: ed.notes, alarmMinutes: ed.alarm === '' ? '' : +ed.alarm };
  // Cleared colours are written empty: the asus copy keeps fields a change leaves out.
  if (ed.category || old.category) out.category = ed.category;
  if (ed.accent || old.accent) out.accent = ed.accent;
  return out;
}

function calSubmit(scope = null) {
  const ed = cal.edit;
  const start = ed.allDay ? calDate(ed.date) : calDate(ed.date, ed.time);
  const end = ed.allDay ? Cal.addDays(calDate(ed.endDate), 1) : calDate(ed.endDate, ed.endTime);
  const fail = (text) => { ed.error = text; ed.asking = null; render(); };
  if (!ed.title.trim()) return fail(T('Zadaj názov.'));
  if ([start, end].some((d) => Number.isNaN(d.getTime()))) return fail(T('Doplň dátum a čas.'));
  if (end < start || (end - start === 0 && ed.allDay)) return fail(T('Koniec je pred začiatkom.'));
  if (ed.repeat !== 'none' && ed.ending === 'until' && !(calDate(ed.until) >= Cal.startOfDay(start))) return fail(T('Opakovanie končí pred začiatkom.'));
  if (ed.repeat === 'WEEKLY' && !ed.byday.length) return fail(T('Vyber aspoň jeden deň v týždni.'));
  cal.lastCal = ed.cal;
  const place = (event, from = ed.from) => (from && from !== ed.cal ? [{ op: 'del', cal: from, uid: event.uid }] : []).concat({ op: 'put', cal: ed.cal, event });
  if (ed.isNew) return calSave([{ op: 'put', cal: ed.cal, event: { uid: ed.uid, ...calFields(ed), rrule: calRuleOf(ed, start), exdates: [] } }]);
  const old = calEvent(ed.from, ed.uid);
  if (!old) return fail(T('Udalosť medzitým zmizla.'));
  if (!ed.recurring) return calSave(place({ ...old, ...calFields(ed, old), rrule: calRuleOf(ed, start) }));
  if (!scope) { ed.asking = 'save'; return render(); }
  const at = ed.at;
  const days = Cal.dayNumber(start) - Cal.dayNumber(at);
  if (scope === 'one') {
    return calSave([{ op: 'put', cal: ed.from, event: { ...old, exdates: [...(old.exdates || []), new Date(at).toISOString()] } },
      { op: 'put', cal: ed.cal, event: { ...old, uid: Cal.newUid(), ...calFields(ed, old), rrule: null, exdates: [] } }]);
  }
  const cut = scope === 'following' ? Cal.endBefore(old, at) : null;
  if (cut) {
    const rule = calRuleOf(ed, start, start);
    if (rule?.COUNT && ed.ending === 'count' && !ed.ruleTouched) rule.COUNT = Math.max(1, rule.COUNT - Cal.countBefore(old, at));
    const later = (old.exdates || []).filter((d) => Date.parse(d) >= at).map((d) => Cal.shiftDays(d, days));
    return calSave([{ op: 'put', cal: ed.from, event: cut },
      { op: 'put', cal: ed.cal, event: { ...old, uid: Cal.newUid(), ...calFields(ed, old), rrule: rule, exdates: later } }]);
  }
  // The whole series moves as the shown occurrence moved, by days and by the clock.
  const first = new Date(old.start);
  const minutes = ed.allDay ? 0 : Cal.minuteOfDay(start) - Cal.minuteOfDay(at);
  const s0 = new Date(first.getFullYear(), first.getMonth(), first.getDate() + days, ed.allDay ? 0 : first.getHours(), ed.allDay ? 0 : first.getMinutes() + minutes);
  const rule = calRuleOf(ed, start, s0, days ? at : null);
  // A series on "the 3rd Wednesday" starts on one, or its first month would be dropped.
  const anchored = Cal.anchorStart(rule, s0, s0);
  if (anchored) s0.setTime(anchored.getTime());
  const e0 = ed.allDay ? Cal.addDays(s0, Cal.dayNumber(end) - Cal.dayNumber(start)) : new Date(s0.getTime() + (end - start));
  calSave(place({ ...old, ...calFields(ed, old), start: s0.toISOString(), end: e0.toISOString(), rrule: rule,
    exdates: (old.exdates || []).map((d) => Cal.shiftDays(d, days)) }));
}

function calDelete(scope) {
  const ed = cal.edit;
  const old = calEvent(ed.from, ed.uid);
  if (!old || scope === 'all' || !ed.recurring) return calSave([{ op: 'del', cal: ed.from, uid: ed.uid }]);
  if (scope === 'one') return calSave([{ op: 'put', cal: ed.from, event: { ...old, exdates: [...(old.exdates || []), new Date(ed.at).toISOString()] } }]);
  const cut = Cal.endBefore(old, ed.at);
  calSave([cut ? { op: 'put', cal: ed.from, event: cut } : { op: 'del', cal: ed.from, uid: ed.uid }]);
}

// ---- moving by dragging (as in Kalendarix: a series moves whole)

let calDrag = null; // { i, ms, days }: the occurrence picked up, and how far into it the pointer took hold
function calDraggable(i, grip = () => ({})) {
  if (i.managed || i.parts?.length > 1) return {};
  return { draggable: true,
    ondragstart: (e) => { calDrag = { i, ms: 0, days: 0, ...grip(e) }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', i.event.title); e.stopPropagation(); },
    ondragend: () => { calDrag = null; } };
}
/** A drop target; `at(e, drag)` says where the dragged occurrence starts now. */
const calDropTarget = (at) => ({
  ondragover: (e) => { if (calDrag) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } },
  ondrop: (e) => {
    const d = calDrag;
    calDrag = null;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const to = at(e, d);
    if (to == null || Number.isNaN(to) || to === d.i.start) return;
    const old = calEvent(d.i.cal.id, d.i.event.uid);
    // An event moved beside one being written leaves the editor open; the one being written moves only from it.
    const writing = calTouched();
    if (writing && cal.edit.uid === d.i.event.uid && cal.edit.from === d.i.cal.id) return void calKept();
    if (old) calSave([{ op: 'put', cal: d.i.cal.id, event: Cal.moved(old, d.i.start, to) }], writing);
  } });
/** Dropped on a day: the same time of day, and a bar picked up by its Wednesday puts that Wednesday there. */
const calOnDay = (day) => (e, d) => { const s = new Date(d.i.start); return new Date(day.getFullYear(), day.getMonth(), day.getDate() - d.days, s.getHours(), s.getMinutes(), s.getSeconds()).getTime(); };

// ---- Settings → Kalendár: calendars of Karchi's own added and removed (ops addcal and delcal, kept on asus like
// events), and timetable subjects he does not want drawn (`sk.karchi.calendar` `hiddenSubjects`, this account only).

const calNewCal = { name: '', color: '', asking: null }; // the new calendar being named, and the one whose removal is asked

/** Why a calendar cannot be removed here (a program fills it and would fail or bring it back), else ''. Same rule as kalendar.py. */
function calKeep(c) {
  if (c.id === TIMETABLE_CAL) return T('plní ho rozvrh');
  if ((c.events || []).some((e) => Cal.isManaged(e, c.id))) return T('plní ho synchronizácia');
  if (String(c.name || '').trim().toLocaleLowerCase('sk') === 'testy') return T('sem píše testy EduPage');
  return '';
}

/** Settings is drawn again whole after a change: the keys stay on the control that made it (data-focus). */
const calKeepFocus = (fn) => (e) => {
  const id = e.currentTarget.dataset.focus;
  const back = () => document.querySelector(`.setpane [data-focus="${CSS.escape(id)}"]`)?.focus();
  Promise.resolve(fn(e)).then(back, back);
  back();
};

function calAddCalendar(color) {
  const name = calNewCal.name.trim();
  if (!name) return;
  calNewCal.name = '';
  calNewCal.color = '';
  calSave([{ op: 'addcal', cal: Cal.newUid(), name, color }], true);
}

function calAskDelete(id) {
  calNewCal.asking = id;
  render();
  // Onto Späť: a second Enter must not delete.
  document.querySelector(`.calsetrow[data-key="${CSS.escape(id || '')}"] button:not(.danger)`)?.focus();
}

/** The subjects of the timetable, each once by its titleKey, named as an ordinary lesson of it is (not „Odpadlo: …“). */
function calSubjects() {
  const tt = cal.doc?.calendars?.find((c) => c.id === TIMETABLE_CAL);
  const out = new Map();
  for (const e of tt?.events || []) {
    const key = !e.allDay && Cal.titleKey(e.title || '');
    if (!key) continue;
    const plain = !Cal.lessonChange(e);
    if (!out.has(key) || (plain && !out.get(key).plain)) out.set(key, { key, plain, name: (plain ? e.title : e.title.replace(/^[^:]*:/, '')).trim() });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'sk'));
}
function calSetSubject(key, on) {
  const off = new Set(S.account[CAL_PREFS]?.hiddenSubjects || []);
  if (on) off.delete(key); else off.add(key);
  calSetPrefs({ hiddenSubjects: [...off].sort() });
}

function calendarSettings() {
  const v = calDefault();
  const cals = cal.doc?.calendars || [];
  const cats = Cal.categoryColors(cal.doc || {});
  const used = new Set(cals.map((c) => Cal.calendarColor(c, cats).toLowerCase()));
  const color = calNewCal.color || Cal.ACCENT_PALETTE.find((c) => !used.has(c)) || Cal.ACCENT_PALETTE[0];
  const subjects = calSubjects();
  const off = new Set(S.account[CAL_PREFS]?.hiddenSubjects || []);
  const paint = subjects.length ? Cal.subjectColors(cal.doc, TIMETABLE_CAL) : null;
  const back = (id) => () => { calNewCal.asking = null; render(); document.querySelector(`.calsetrow[data-key="${CSS.escape(id)}"] button`)?.focus(); };
  const row = (c) => {
    const name = c.name || T('Bez názvu');
    const keep = calKeep(c);
    const n = (c.events || []).length;
    const asking = calNewCal.asking === c.id;
    return h('div', { class: 'calsetrow', 'data-key': c.id },
      h('label', { class: 'bcheck' },
        h('input', { type: 'checkbox', checked: calShown(c), 'data-focus': `shown:${c.id}`, onchange: calKeepFocus((e) => calSetShown(c.id, e.currentTarget.checked)) }),
        h('i', { style: { background: Cal.calendarColor(c, cats) } }), name),
      asking ? h('span', { class: 'calconfirm', role: 'group', 'aria-label': T`Zmazať kalendár ${name}` },
        h('span', {}, n ? T`Zmazať aj s ${eventsWord(n)}?` : T('Zmazať?')),
        h('button', { type: 'button', class: 'ghost danger', onclick: () => { calNewCal.asking = null; calSave([{ op: 'delcal', cal: c.id }], true); document.querySelector('.calnewcal input')?.focus(); } }, T('Zmazať')),
        h('button', { type: 'button', class: 'ghost', onclick: back(c.id) }, T('Späť')))
        : keep ? h('small', {}, keep)
          : h('button', { type: 'button', class: 'ghost', 'aria-label': T`Zmazať kalendár ${name}`, onclick: () => calAskDelete(c.id) }, T('Zmazať')));
  };
  return [
    h('h3', {}, T('Predvolené zobrazenie')),
    h('div', { class: 'seg', role: 'radiogroup', 'aria-label': T('Kalendár sa otvorí na') }, CAL_VIEWS.map(([id, label]) =>
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === id), class: v === id ? 'on' : '',
        'data-focus': `view:${id}`, onclick: calKeepFocus(() => { if (v === id) return; cal.view = id; cal.scrolled = false; putAccount(CAL_PREFS, { ...S.account[CAL_PREFS], view: id }).catch(() => alert(T('Nastavenie sa neuložilo.'))); render(); }) }, label))),
    h('p', { class: 'hint' }, T('Takto sa kalendár ukáže na úvodnej ploche aj na Ctrl+D.')),
    h('h3', {}, T('Kalendáre')),
    cals.length ? h('div', { class: 'calshown calsetlist' }, cals.map(row)) : null,
    cal.loaded ? h('form', { class: 'calnewcal', onsubmit: (e) => { e.preventDefault(); calAddCalendar(color); } },
      h('input', { value: calNewCal.name, required: true, maxlength: 60, placeholder: T('Nový kalendár'), 'aria-label': T('Názov nového kalendára'),
        oninput: (e) => { calNewCal.name = e.target.value; }, 'data-root': '__calNewName' }),
      h('div', { class: 'calaccent', role: 'radiogroup', 'aria-label': T('Farba nového kalendára') }, Cal.ACCENT_PALETTE.map((c) =>
        h('button', { type: 'button', role: 'radio', class: color === c ? 'on' : '', title: c, 'aria-label': T`Farba ${c}`, 'aria-checked': String(color === c),
          style: { background: c }, 'data-focus': `color:${c}`, onclick: calKeepFocus(() => { calNewCal.color = c; render(); }) }))),
      h('button', { type: 'submit', class: 'primary' }, T('Pridať kalendár'))) : null,
    h('p', { class: 'hint' }, T('Odškrtnutý kalendár sa vo Wefte nekreslí a jeho udalosti ostávajú. Zmazaný zmizne aj s udalosťami.')),
    subjects.length ? h('h3', {}, T('Predmety v rozvrhu')) : null,
    subjects.length ? h('div', { class: 'calshown' }, subjects.map((s) => h('label', { class: 'bcheck', 'data-key': s.key },
      h('input', { type: 'checkbox', checked: !off.has(s.key), 'data-focus': `subject:${s.key}`, onchange: calKeepFocus((e) => calSetSubject(s.key, e.currentTarget.checked)) }),
      h('i', { style: { background: paint.get(s.key) } }), s.name))) : null,
    subjects.length ? h('p', { class: 'hint' }, T('Odškrtnutý predmet sa v kalendári nekreslí ani nepripomína, ani keď odpadne alebo sa supluje.')) : null,
    h('h3', {}, T('Pripomienky')),
    h('label', { class: 'bcheck' }, h('input', { type: 'checkbox', checked: calRemindOn(), 'data-focus': 'remind', onchange: calKeepFocus((e) => calSetRemind(e.currentTarget.checked)) }),
      h('span', {}, T('Upozorniť v čase pripomienky'), h('small', {}, T('Udalosť s pripomienkou ukáže notifikáciu na zariadení, kde Weft beží (desktopová appka beží aj so zatvoreným oknom), a klik ju otvorí. Kalendarix dáva každej udalosti pripomienku 2 hodiny vopred pre telefón, takže zapnuté pípne aj pri nich.')))),
    'Notification' in window && Notification.permission === 'denied' ? h('p', { class: 'hint' }, T('Tento prehliadač má notifikácie Weftu zakázané.')) : null,
    h('h3', {}, T('Návrhy zo správ')),
    h('label', { class: 'bcheck' }, h('input', { type: 'checkbox', checked: calSuggestOn(), 'data-focus': 'suggest', onchange: calKeepFocus((e) => calSetPrefs({ suggest: e.currentTarget.checked })) }),
      h('span', {}, T('Navrhovať udalosti zo správ'), h('small', {}, T('Pod správou s termínom ponúkne „Pridať do kalendára“. Čas číta toto zariadenie; či je to naozaj plán, posúdi malý model na asuse. Text nikam inam neodchádza.')))),
  ];
}

// ---- suggestions from messages (like iMessage): app/when.js reads a message's text on this device, and a time it
// names is offered under the message. Nothing is saved until Karchi saves the editor it opens.

const calSuggestOn = () => S.account[CAL_PREFS]?.suggest !== false;
async function calSetRemind(on) {
  // A browser asks once whether Weft may notify; the choice is a click, so it may ask now (the desktop app may always).
  if (on && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission().catch(() => {});
  calSetPrefs({ notify: on });
  calRemindCheck();
}
function calSetPrefs(patch) {
  putAccount(CAL_PREFS, { ...S.account[CAL_PREFS], ...patch }).catch(() => alert(T('Nastavenie sa neuložilo.')));
  render();
}
const calWhenKey = (w) => `${w.allDay ? 'd' : 't'}${+w.start}-${w.end ? +w.end : ''}`;
const calSugKey = (w) => `${calWhenKey(w)}|${(w.title || '').toLowerCase()}`;
/** Chats where a suggestion helps: not EduPage (its tests come into the calendar by themselves), not a Discord
 *  server's channel, not a big group. */
const calSuggestsIn = (r) => r.app !== 'edupage' && !r.server && joinedPeople(r).length <= 8;

const whenMemo = new Map(); // event id -> { text, w }
/** The time a message names, read once per text (an edit reads it again). */
function messageWhen(r, ev) {
  if (ev.type !== 'm.room.message' || ev.pending || isBot(ev.sender)) return null;
  const m = roomModel(r);
  if (isRedacted(m, ev)) return null;
  const c = contentOf(m, ev);
  if (c.msgtype !== 'm.text' && c.msgtype !== 'm.emote') return null;
  const text = plainBody(c);
  const hit = whenMemo.get(ev.event_id);
  if (hit?.text === text) return hit.w;
  // Enough for the longest history drawn; the oldest read goes first.
  if (whenMemo.size >= 100000) whenMemo.delete(whenMemo.keys().next().value);
  // Whether the time is over is asked at each draw, not here.
  const w = findWhen(text, { ref: ev.origin_server_ts, now: 0 });
  whenMemo.set(ev.event_id, { text, w: w && { ...w, text } });
  return whenMemo.get(ev.event_id).w;
}

/** The messages of a chat that carry a suggestion: a time still to come, once, under the newest message that names
 *  it; not when the calendar has it already (an event then, or one with the message in its note, on any device)
 *  or Karchi waved it off. */
function calSuggestions(t, msgs, from) {
  const out = new Map();
  if (!calSuggestOn() || (cal.doc && !calWritable().length)) return out;
  const off = new Set(S.account[CAL_PREFS]?.dismissed || []);
  const found = []; // [event, time], newest first
  const now = Date.now();
  const today = Cal.startOfDay(now).getTime();
  const rooms = new Map(); // room id -> whether it gets suggestions, asked once per draw
  for (let i = msgs.length - 1; i >= from; i--) {
    const ev = msgs[i];
    const r = t.roomOf(ev);
    if (!rooms.has(r.id)) rooms.set(r.id, calSuggestsIn(r));
    if (!rooms.get(r.id)) continue;
    const w = messageWhen(r, ev);
    if (w && (w.allDay ? +w.start >= today : +w.start > now)) found.push([ev, w]);
  }
  // Only what is in sight waits for the judge: a chat left behind does not hold up the open one.
  judgeKeep(new Set(found.map(([ev]) => ev.event_id)));
  // The judge on asus says whether it is a plan (without it a doubted one, "nemôžem", "presúva sa", is not offered);
  // only what it lets through counts below, so a refused "o 17:00 pošlem video" hides nothing.
  const plans = found.filter(([ev, w]) => {
    const said = calJudged(ev, w);
    return said !== undefined && (said ? said.plan : !w.doubt);
  });
  // One suggestion per time and what happens then ("o 17:00 tréning" and "o 17:00 krúžok" are two); "ok, zajtra o 17:00?"
  // names no event and joins one at that time that does.
  const named = new Set(plans.filter(([, w]) => w.title).map(([, w]) => calWhenKey(w)));
  const seen = new Set();
  for (const [ev, w] of plans) {
    const key = calSugKey(w);
    if (seen.has(key) || (!w.title && !w.allDay && named.has(calWhenKey(w)))) continue;
    seen.add(key);
    if (!off.has(ev.event_id) && !calHas(w)) out.set(ev.event_id, w);
  }
  return out;
}

// The judge (server/when/judge.py): event id -> { text, said } where said is { plan, title }, null when there is no
// judge for a while (the parser alone decides then) or undefined while asked. One question at a time.
const judgeMemo = new Map();
const judgeQueue = [];
let judgeBusy = false;
let judgeDownUntil = 0;
function calJudged(ev, w) {
  const hit = judgeMemo.get(ev.event_id);
  if (hit?.text === w.text) return hit.said;
  if (Date.now() < judgeDownUntil) return null;
  judgeMemo.set(ev.event_id, { text: w.text, said: undefined });
  judgeQueue.push([ev.event_id, w]);
  queueMicrotask(judgeNext);
  return undefined;
}
function judgeKeep(ids) {
  for (let i = judgeQueue.length; i--;) {
    const [id] = judgeQueue[i];
    if (!ids.has(id)) { judgeQueue.splice(i, 1); judgeMemo.delete(id); }
  }
}
async function judgeNext() {
  if (judgeBusy) return;
  judgeBusy = true;
  while (judgeQueue.length && calSuggestOn() && S.selected && Date.now() >= judgeDownUntil) {
    const [id, w] = judgeQueue.shift(); // the newest message first
    try {
      const said = await call('POST', '/judge', { text: w.text, when: whenLabel(w) }, '/_when', AbortSignal.timeout(30e3));
      if (typeof said.plan !== 'boolean') throw new Error('no answer'); // a body cut short reads as {}
      judgeMemo.set(id, { text: w.text, said: { plan: said.plan, title: said.title || null } });
    } catch (e) {
      // Busy (503) for a minute, anything else (down, no route, too slow) for ten: the parser alone decides meanwhile,
      // and what was not answered is asked again after.
      judgeDownUntil = Date.now() + (e.status === 503 ? 60e3 : 10 * 60e3);
      judgeMemo.delete(id);
    }
    render();
  }
  // Suggestions switched off, the chat closed, or no judge for a while: nothing waits to be asked.
  for (const [id] of judgeQueue.splice(0)) if (judgeMemo.get(id)?.said === undefined) judgeMemo.delete(id);
  judgeBusy = false;
  render();
}

const calHasMemo = { seq: -1, until: 0, map: new Map(), days: new Map(), notes: '' };
function calHas(w) {
  if (!cal.doc) return false;
  const now = Date.now();
  if (calHasMemo.seq !== cal.seq || now >= calHasMemo.until) {
    calHasMemo.seq = cal.seq; calHasMemo.until = Infinity; calHasMemo.map.clear(); calHasMemo.days.clear();
    // The note of every event not yet over: one saved from a message and moved to another day still holds the message,
    // while last week's "zajtra o 17:00 pohovor" does not hide this week's. Read again when the first of them ends.
    const notes = [];
    for (const c of cal.doc.calendars || []) for (const e of c.events || []) {
      if (!e.notes) continue;
      const end = Date.parse(e.end || e.start);
      if (!e.rrule?.FREQ && end <= now) continue;
      if (!e.rrule?.FREQ && end > now) calHasMemo.until = Math.min(calHasMemo.until, end);
      notes.push(e.notes);
    }
    calHasMemo.notes = notes.join('\u0000');
  }
  const key = `${calSugKey(w)}|${w.text}`;
  if (calHasMemo.map.has(key)) return calHasMemo.map.get(key);
  const day = Cal.startOfDay(w.start);
  // Every calendar, also one hidden in Weft: the event is there all the same.
  if (!calHasMemo.days.has(+day)) calHasMemo.days.set(+day, Cal.expand(cal.doc, day.getTime(), Cal.addDays(day, 1).getTime(), () => true));
  const quote = w.text.trim().slice(0, 80);
  const title = (w.title || '').toLowerCase();
  // The message in a note (any day); the same title that day (at that very time for a timed one); or, for a time that names no
  // event, any event at that very time (not the timetable's lessons).
  const has = (quote && calHasMemo.notes.includes(quote)) || calHasMemo.days.get(+day).some((i) => (title && i.event.title?.toLowerCase() === title && (w.allDay || i.start === +w.start))
    || (!title && !w.allDay && !i.allDay && !i.managed && i.start === +w.start));
  calHasMemo.map.set(key, has);
  return has;
}

const whenLabel = (w) => {
  const date = (d) => d.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'numeric' });
  const day = date(w.start);
  // A few days in a row ("cez víkend", "od 23. do 25. 11.") end on their last day.
  if (w.allDay) return T`${w.end ? `${day} – ${date(w.end)}` : day} celý deň`;
  return `${day} ${calHm(w.start)}${w.end ? `–${calHm(w.end)}` : ''}`;
};

function calSuggestion(r, ev, w) {
  return h('div', { class: 'cnote calsug' },
    h('button', { class: 'linkbtn', onclick: () => calFromMessage(r, ev, w) }, icon('calendar'), T('Pridať do kalendára')),
    h('span', {}, whenLabel(w)),
    h('button', { class: 'calsugoff', title: T('Nenavrhovať'), 'aria-label': T('Nenavrhovať'),
      onclick: () => calSetPrefs({ dismissed: [...(S.account[CAL_PREFS]?.dismissed || []), ev.event_id].slice(-300) }) }, icon('close')));
}

/** Opens the calendar over the chat with a new event filled from the message: its words, time and people. */
async function calFromMessage(r, ev, w) {
  if (!cal.doc) await loadCalendar();
  if (!calWritable().length) return alert(T('Kalendár sa nenačítal, skús to o chvíľu.'));
  S.panel = 'calendar'; S.overlay = null; S.menu = false;
  // An event being written stays: the calendar opens on it.
  if (calTouched()) { render(); calKept(); return; }
  cal.cursor = Cal.startOfDay(w.start);
  const people = joinedPeople(r).map(([id]) => memberName(r, id));
  const end = w.end || (w.allDay ? w.start : new Date(+w.start + Cal.MS_HOUR));
  // The judge's title only when the words gave none and it holds no time ("Môžeš zajtra o 17:00?").
  const judged = judgeMemo.get(ev.event_id)?.said?.title;
  const fill = { title: w.title || (judged && !/\d/.test(judged) ? judged : '') || roomTitle(r), allDay: w.allDay, date: calYmd(w.start), endDate: calYmd(end),
    notes: `${people.length ? T`Ľudia: ${people.join(', ')}` : roomTitle(r)}\n${w.text.trim()}` };
  if (!w.allDay) Object.assign(fill, { time: calHm(w.start), endTime: calHm(end) });
  if (!calNew(w.start, fill)) render();
}

// ------------------------------------------------------------------ grades

const MONTH_NAMES = LANG === 'en' ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  : ['január', 'február', 'marec', 'apríl', 'máj', 'jún', 'júl', 'august', 'september', 'október', 'november', 'december']; // i18n-ignore: each language's own names
const num = (x) => String(x).replace('.', ',');
const weightLabel = (w) => `${num(w)}×`;
const gradeText = (g) => (g.max ? `${num(g.value)} / ${num(g.max)} = ${num(g.percent)} % → ${g.mark}` : g.value);
const longDate = (ts) => { const d = new Date(ts); return `${pad(d.getDate())}. ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`; };

function setGradeMode(mode) {
  S.gradeMode = mode;
  localStorage.setItem('ep_grade_mode', mode);
  render();
}

/** Weighted mean like edupage.org; a subject graded only in points shows its total percent. */
function average(grades) {
  if (!grades.length) return '';
  if (grades.every((g) => g.max)) {
    const got = grades.reduce((a, g) => a + Number(g.value), 0);
    const top = grades.reduce((a, g) => a + g.max, 0);
    return `${num((got / top * 100).toFixed(1))} %`;
  }
  let sum = 0;
  let weight = 0;
  for (const g of grades) {
    const mark = Number(g.max ? g.mark : g.value);
    if (!Number.isFinite(mark) || mark <= 0) continue;
    sum += mark * g.weight;
    weight += g.weight;
  }
  return weight ? num((sum / weight).toFixed(2)) : '';
}

function gradeDetail(g) {
  return h('div', { class: 'gdetail' },
    h('b', {}, g.title || T('Známka')), T` · ${longDate(g.date)} · váha ${weightLabel(g.weight)}`,
    g.teacher ? ` · ${g.teacher}` : null,
    g.others ? T` · priemer ostatných ${num(g.others)}` : null);
}

/** A grade's subject colour on it, as in the calendar; text in the colour that reads on it. */
const gradePaint = (subject) => { const c = subjectColor(subject); return c ? { background: c, color: Cal.textOn(c) } : null; };

/** Subjects with grades only: one Karchi has no grade in yet has nothing to show. */
function gradesTable(book) {
  const bySubject = new Map(book.subjects.map((s) => [s.id, []]));
  for (const g of [...book.grades].sort((a, b) => a.date - b.date)) {
    if (!bySubject.has(g.subject)) bySubject.set(g.subject, []);
    bySubject.get(g.subject).push(g);
  }
  for (const [id, grades] of bySubject) if (!grades.length) bySubject.delete(id);
  const names = new Map(book.subjects.map((s) => [s.id, s]));
  return h('table', { class: 'gtable' },
    h('thead', {}, h('tr', {}, h('th', {}, T('Predmet')), h('th', {}, T('Známky')), h('th', { class: 'avg' }, T('Priemer')))),
    h('tbody', {}, [...bySubject].map(([id, grades]) => {
      const subject = names.get(id) || { name: id, teacher: '' };
      const picked = grades.find((g) => g.id === S.gradeOpen);
      return [
        h('tr', {},
          h('td', { class: 'subj' }, h('b', {}, subject.name), subject.teacher ? h('small', {}, subject.teacher) : null),
          h('td', { class: 'cells' }, grades.map((g) => h('button', {
            class: `cell${g.id === S.gradeOpen ? ' on' : ''}${g.max ? ' wide' : ''}`, style: gradePaint(id),
            onclick: () => { S.gradeOpen = S.gradeOpen === g.id ? null : g.id; render(); },
          }, gradeText(g), h('span', { class: 'w' }, weightLabel(g.weight))))),
          h('td', { class: 'avg' }, average(grades))),
        picked ? h('tr', { class: 'detailrow' }, h('td', { colspan: 3 }, gradeDetail(picked))) : null,
      ];
    })));
}

function gradesRecent(book) {
  const names = new Map(book.subjects.map((s) => [s.id, s]));
  let day = '';
  const out = [];
  for (const g of book.grades) {
    const label = longDate(g.date);
    if (label !== day) out.push(h('div', { class: 'gday' }, label));
    day = label;
    const subject = names.get(g.subject) || { name: g.subject, short: '?' };
    out.push(h('div', { class: 'gitem' },
      h('div', { class: 'gdot', style: gradePaint(g.subject) }, (subject.name || '?')[0].toUpperCase()),
      h('div', {},
        h('b', {}, subject.name),
        h('div', { class: 'gtitle' }, g.title, h('span', {}, ` · ${weightLabel(g.weight)}`)),
        h('div', { class: 'gval' }, gradeText(g)),
        h('small', {}, [g.teacher, g.others ? T`priemer ostatných študentov z tejto udalosti: ${num(g.others)}` : ''].filter(Boolean).join(' · ')))));
  }
  return out;
}

function gradesView() {
  const book = S.account[GRADES];
  const ready = Array.isArray(book?.subjects) && Array.isArray(book?.grades);
  return [
    h('div', { class: 'phead' },
      h('button', { class: S.gradeMode === 'table' ? 'on' : '', onclick: () => setGradeMode('table') }, T('Predmety')),
      h('button', { class: S.gradeMode === 'recent' ? 'on' : '', onclick: () => setGradeMode('recent') }, T('Najnovšie')),
      h('kbd', {}, 'Tab')),
    !ready ? h('div', { class: 'empty' }, T('Známky ešte neprišli z EduPage.'))
      : S.gradeMode === 'table' ? gradesTable(book) : gradesRecent(book),
  ];
}

// ------------------------------------------------------------------ people map

// The map of the people Karchi knows (Ctrl+M), made on asus by server/people from his whole message history:
// { branches: [{ id, name, color, subs: [{ id, name }] }], people: [{ id, name, alias, b: ['school/3b', 'school/choir'],
//   was: ['school/choir'] (where they used to be: also in b, drawn faded and dashed), sib, sibq (a guess from the surname),
//   rel, note, unsure, n, first, last, rooms }] }. His own corrections live apart in FRIEND_EDITS ({ [id]: { b, was, hide } })
// so a new map from asus never overwrites them.
const FRIENDS = 'sk.karchi.friends';
const FRIEND_EDITS = 'sk.karchi.friends.edits';
const pm = { shown: false, el: null, view: null, sel: null, query: '', hits: [], hit: 0, off: new Set(JSON.parse(localStorage.getItem('ep_people_off') || '[]')) };
const branchOf = (ref) => ref.split('/')[0];
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** A chip in a branch's colour (h() cannot set a custom property). */
const colored = (color, el) => { el.style.setProperty('--c', color); return el; };
const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** People with Karchi's corrections applied, hidden ones and switched-off branches left out. */
function mapPeople() {
  const edits = S.account[FRIEND_EDITS] || {};
  // A name Karchi gave keeps the old one as an alias, so the search still finds the nickname.
  const rename = (p, e) => (e.name && e.name !== p.name ? { alias: [p.name, ...(p.alias || [])].filter((x) => x !== e.name) } : {});
  return (S.account[FRIENDS]?.people || []).map((p) => (edits[p.id] ? { ...p, ...edits[p.id], ...rename(p, edits[p.id]) } : p))
    .map((p) => (p.was ? { ...p, was: p.was.filter((r) => p.b.includes(r)) } : p))
    .filter((p) => (pm.shown || !p.hide) && p.b.some((ref) => !pm.off.has(branchOf(ref))));
}

/** Positions for everyone: Karchi in the middle, a hub per branch on a ring, a sub-hub per group around it, and each
 *  person pulled by a thread to every (sub)hub they belong to. People of several branches settle between them, as in
 *  Kumu or Obsidian's graph. Computed once per map; nothing moves afterwards. */
function layoutPeople(branches, people) {
  const seed = (s) => { let x = 2166136261; for (const ch of s) x = Math.imul(x ^ ch.charCodeAt(0), 16777619); return ((x >>> 0) % 1000) / 1000; };
  const count = new Map(branches.map((b) => [b.id, 0]));
  for (const p of people) for (const ref of new Set(p.b.map(branchOf))) count.set(ref, (count.get(ref) || 0) + 1);
  const shown = branches.filter((b) => count.get(b.id));
  const weight = shown.map((b) => Math.sqrt(count.get(b.id)) + 4); // a small branch (Rodina) still gets room for its name
  const total = weight.reduce((a, w) => a + w, 0);
  const hubs = new Map();
  let at = -Math.PI / 2;
  shown.forEach((b, i) => {
    const span = (weight[i] / total) * Math.PI * 2;
    const a = at + span / 2;
    at += span;
    const r = 380 + 22 * Math.sqrt(count.get(b.id));
    hubs.set(b.id, { x: Math.cos(a) * r, y: Math.sin(a) * r, a, span, b });
    const subs = (b.subs || []).filter((s) => people.some((p) => p.b.includes(`${b.id}/${s.id}`)));
    subs.forEach((s, j) => {
      // Sub-hubs fan out away from the middle, at least ~20° apart so their names do not collide.
      const fan = Math.max(Math.min(span * 0.8, 2.2), 0.35 * (subs.length - 1));
      const sa = a + (subs.length > 1 ? (j / (subs.length - 1) - 0.5) * fan : 0);
      hubs.set(`${b.id}/${s.id}`, { x: Math.cos(a) * r + Math.cos(sa) * 230, y: Math.sin(a) * r + Math.sin(sa) * 230, a: sa, sub: s, b });
    });
  });
  const nodes = people.map((p) => {
    const an = [];
    const past = new Set();
    for (const ref of p.b) {
      const hub = hubs.get(ref) || hubs.get(branchOf(ref));
      if (!hub || an.includes(hub)) continue;
      an.push(hub);
      if (p.was?.includes(ref)) past.add(hub);
    }
    // Where they belong now pulls harder than where they used to be.
    const pullOf = (x) => (past.has(x) && past.size < an.length ? 0.35 : 1);
    const sum = an.reduce((s, x) => s + pullOf(x), 0);
    const cx = an.reduce((s, x) => s + x.x * pullOf(x), 0) / sum;
    const cy = an.reduce((s, x) => s + x.y * pullOf(x), 0) / sum;
    const a = seed(p.id) * Math.PI * 2;
    const d = 30 + seed(`${p.id}.`) * 90;
    return { p, an, past, pullOf, x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, r: 4 + 3 * Math.log10(1 + (p.n || 0)) };
  });
  // Springs to the anchors, and no two people overlap (a grid keeps it linear).
  for (let step = 0; step < 160; step++) {
    const heat = 1 - step / 160;
    for (const n of nodes) {
      for (const an of n.an) {
        const dx = an.x - n.x;
        const dy = an.y - n.y;
        const d = Math.hypot(dx, dy) || 1;
        const pull = (d - (an.sub ? 60 : 90)) * 0.03 * heat * n.pullOf(an);
        n.x += (dx / d) * pull;
        n.y += (dy / d) * pull;
      }
    }
    const grid = new Map();
    for (const n of nodes) {
      const k = `${Math.floor(n.x / 40)},${Math.floor(n.y / 40)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(n);
    }
    for (const n of nodes) {
      const gx = Math.floor(n.x / 40);
      const gy = Math.floor(n.y / 40);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const m of grid.get(`${gx + i},${gy + j}`) || []) {
        if (m === n) continue;
        const dx = n.x - m.x;
        const dy = n.y - m.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const min = n.r + m.r + 6;
        if (d < min) {
          const push = (min - d) / 2;
          n.x += (dx / d) * push;
          n.y += (dy / d) * push;
          m.x -= (dx / d) * push;
          m.y -= (dy / d) * push;
        }
      }
    }
  }
  return { hubs, nodes };
}

/** A circle split into one slice per branch: Karchi's people of several branches show every colour they carry. */
/** `past` colours (branches the person has left) are faded slices. */
function slices(x, y, r, colors, past = new Set()) {
  const f = (v) => v.toFixed(1);
  const faded = (c) => (past.has(c) ? ' fill-opacity=".3"' : '');
  if (colors.length === 1) return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${colors[0]}"${faded(colors[0])}/>`;
  return colors.map((c, i) => {
    const a0 = (i / colors.length) * Math.PI * 2 - Math.PI / 2;
    const a1 = ((i + 1) / colors.length) * Math.PI * 2 - Math.PI / 2;
    const p = (a) => `${(x + Math.cos(a) * r).toFixed(1)} ${(y + Math.sin(a) * r).toFixed(1)}`;
    return `<path d="M${f(x)} ${f(y)}L${p(a0)}A${f(r)} ${f(r)} 0 0 1 ${p(a1)}Z" fill="${c}"${faded(c)}/>`;
  }).join('');
}
/** Branches a person has left entirely: every ref of it is in `was` (out of the choir but still in the class keeps the school). */
const leftBranches = (p) => new Set([...new Set(p.b.map(branchOf))].filter((id) => p.b.filter((r) => branchOf(r) === id).every((r) => p.was?.includes(r))));

/** The map's SVG markup, from data that came from the homeserver; every text goes through xml(). */
function mapMarkup(branches, lay) {
  const color = new Map(branches.map((b) => [b.id, b.color]));
  const out = ['<g class="threads">'];
  const f = (v) => v.toFixed(1);
  for (const [ref, hub] of lay.hubs) {
    const from = hub.sub ? lay.hubs.get(hub.b.id) : { x: 0, y: 0 };
    out.push(`<path data-hub="${xml(ref)}" d="M${f(from.x)} ${f(from.y)}L${f(hub.x)} ${f(hub.y)}" stroke="${hub.b.color}" class="${hub.sub ? 'stem' : 'trunk'}"/>`);
  }
  for (const n of lay.nodes) for (const an of n.an) {
    // A slight bend, so threads into one hub read as a bundle rather than a fan of straight lines.
    const mx = (n.x + an.x) / 2 + (an.y - n.y) * 0.12;
    const my = (n.y + an.y) / 2 - (an.x - n.x) * 0.12;
    out.push(`<path data-of="${xml(n.p.id)}"${n.past.has(an) ? ' class="past"' : ''} d="M${f(n.x)} ${f(n.y)}Q${f(mx)} ${f(my)} ${f(an.x)} ${f(an.y)}" stroke="${an.b.color}"/>`);
  }
  const sibs = new Map();
  for (const n of lay.nodes) if (n.p.sib) sibs.set(n.p.sib, [...(sibs.get(n.p.sib) || []), n]);
  for (const group of sibs.values()) for (let i = 1; i < group.length; i++) {
    const [a, b] = [group[i - 1], group[i]];
    out.push(`<path class="sib${a.p.sibq || b.p.sibq ? ' guess' : ''}" data-of="${xml(a.p.id)} ${xml(b.p.id)}" d="M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}"/>`);
  }
  out.push('</g><g class="hubs">');
  out.push(`<circle class="me" cx="0" cy="0" r="22"/><text class="mename" x="0" y="0">${T('Ty')}</text>`);
  for (const [ref, hub] of lay.hubs) {
    out.push(`<circle class="${hub.sub ? 'subhub' : 'hub'}" data-hub="${xml(ref)}" cx="${f(hub.x)}" cy="${f(hub.y)}" r="${hub.sub ? 7 : 13}" fill="${hub.b.color}"/>`);
  }
  out.push('</g><g class="people">');
  for (const n of lay.nodes) {
    // Someone who has left every branch is a faded circle; someone who left one of several, a faded slice.
    const ids = [...new Set(n.p.b.map(branchOf))].filter((id) => color.has(id));
    const left = leftBranches(n.p);
    const past = new Set(ids.filter((id) => left.has(id) && left.size < ids.length).map((id) => color.get(id)));
    out.push(`<g class="pnode${n.r >= 9 ? ' big' : ''}${n.p.hide ? ' gone' : ''}${left.size === ids.length ? ' former' : ''}" data-id="${xml(n.p.id)}">${slices(n.x, n.y, n.r, ids.map((id) => color.get(id)), past)}</g>`);
  }
  // People's names in a layer of their own, above every circle, so no one's circle covers a name.
  out.push('</g><g class="pnames">');
  for (const n of lay.nodes) out.push(`<text data-id="${xml(n.p.id)}" x="${f(n.x)}" y="${f(n.y + n.r + 2)}" dominant-baseline="hanging">${xml(n.p.name)}</text>`);
  // Branch names last, so a person's name never covers one.
  out.push('</g><g class="hubnames">');
  // Each name points away from the middle, so neighbouring branches' names spread apart instead of colliding.
  for (const [ref, hub] of lay.hubs) {
    const [c, s] = [Math.cos(hub.a), Math.sin(hub.a)];
    const r = (hub.sub ? 7 : 13) + 2;
    const anchor = c > 0.12 ? 'start' : c < -0.12 ? 'end' : 'middle';
    const dy = anchor === 'middle' ? (s < 0 ? -0.4 : 1.1) : s * 0.4 + 0.35;
    out.push(`<text class="${hub.sub ? 'subhub' : 'hub'}" data-hub="${xml(ref)}" x="${f(hub.x + c * r)}" y="${f(hub.y + s * r)}" `
      + `dx="${(anchor === 'middle' ? 0 : c * 0.3).toFixed(2)}em" dy="${dy.toFixed(2)}em" style="text-anchor:${anchor}">${xml(hub.sub ? hub.sub.name : hub.b.name)}</text>`);
  }
  out.push('</g><text class="tip" dominant-baseline="hanging" visibility="hidden"></text>');
  return out.join('');
}

/** The map element is built once per map and kept across renders, so its zoom, scroll and search stay put. */
function peopleView() {
  const data = S.account[FRIENDS];
  if (!data?.people?.length) return h('div', { class: 'empty' }, T('Mapa ľudí ešte nie je. Vytvára ju server/people na asuse.'));
  const key = [data.at, JSON.stringify(S.account[FRIEND_EDITS] || {}), [...pm.off].join(), pm.shown, pm.naming].join('|');
  if (pm.el && pm.key === key) { syncPeopleCard(); return pm.el; }
  pm.key = key;
  const people = mapPeople();
  const lay = layoutPeople(data.branches, people);
  const was = pm.sel && pm.nodes?.get(pm.sel);
  pm.nodes = new Map(lay.nodes.map((n) => [n.p.id, n]));
  pm.hubs = lay.hubs;
  pm.people = people;
  pm.size = new Map(); // people per branch and sub-branch: the bigger one's name wins a collision
  for (const p of people) for (const ref of new Set(p.b.flatMap((r) => [r, branchOf(r)]))) pm.size.set(ref, (pm.size.get(ref) || 0) + 1);
  if (pm.sel && !pm.nodes.has(pm.sel)) pm.sel = null;
  // A correction moves the open person between branches: the view follows them, so they stay where they were.
  const now = pm.sel && pm.nodes.get(pm.sel);
  if (was && now && pm.view) pm.view = { ...pm.view, x: pm.view.x - (now.x - was.x) * pm.view.k, y: pm.view.y - (now.y - was.y) * pm.view.k };
  const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); // ui-ignore: the people map is a drawing, not an icon
  svgEl.setAttribute('class', 'pmap');
  const world = document.createElementNS('http://www.w3.org/2000/svg', 'g'); // ui-ignore: the people map
  world.innerHTML = mapMarkup(data.branches, lay); // escaped by mapMarkup
  svgEl.append(world);
  for (const g of world.querySelectorAll('.pnode')) pm.nodes.get(g.dataset.id).el = g;
  for (const t of world.querySelectorAll('.pnames text')) pm.nodes.get(t.dataset.id).t = t;
  const chips = h('div', { class: 'pchips' }, data.branches.map((b) => colored(b.color, h('button', {
    class: `pchip${pm.off.has(b.id) ? ' off' : ''}`, title: pm.off.has(b.id) ? T('Zobraziť') : T('Skryť'),
    onclick: () => { pm.off.has(b.id) ? pm.off.delete(b.id) : pm.off.add(b.id); localStorage.setItem('ep_people_off', JSON.stringify([...pm.off])); render(); },
  }, h('i'), b.name))),
  // Hidden people stay one click away, faded, so hiding is never a one-way door.
  Object.values(S.account[FRIEND_EDITS] || {}).some((e) => e.hide)
    ? h('button', { class: `pchip ghostchip${pm.shown ? '' : ' off'}`, onclick: () => { pm.shown = !pm.shown; render(); } }, pm.shown ? T('Skryť skrytých') : T('Ukázať skrytých')) : null,
    nicknamed(people).length ? h('button', { class: `pchip ghostchip${pm.naming ? '' : ' off'}`, onclick: () => setNaming(!pm.naming) }, T`Doplniť mená (${nicknamed(people).length})`) : null);
  const input = h('input', {
    class: 'psearch', type: 'search', placeholder: T('Hľadať človeka, skupinu alebo družinu'), value: pm.query, 'data-root': '__people',
    oninput: (e) => { pm.query = e.target.value; findPeople(); },
    onkeydown: (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); stepHit(e.key === 'ArrowDown' ? 1 : -1); }
      else if (e.key === 'Enter' && pm.hits.length) { e.preventDefault(); pickPerson(pm.hits[pm.hit]); }
      else if (e.key === 'Escape' && (pm.sel || pm.query)) { e.preventDefault(); e.stopPropagation(); clearPeople(); }
    },
  });
  const card = h('div', { class: 'pcard', hidden: true });
  const none = h('div', { class: 'pnone', hidden: true }, T('Nikto taký na mape nie je.'));
  const stage = h('div', { class: 'pstage' }, svgEl, card, none, pm.naming ? namingList(people) : null);
  pm.el = h('div', { class: 'people' }, h('div', { class: 'phead pbar' }, input, chips), stage);
  Object.assign(pm, { svg: svgEl, world, card, input, none, tip: world.querySelector('.tip'), hover: null });
  wireMap(stage);
  // A name being typed stays: its card is built now, so the field is in the page when render puts the cursor back.
  if (pm.renaming) syncPeopleCard();
  // A rebuilt map (a correction, a chip, a new map) keeps where Karchi was looking.
  requestAnimationFrame(() => { if (pm.view) applyView(); else fitMap(); findPeople(false); syncPeopleCard(); });
  return pm.el;
}

const ruler = document.createElement('canvas').getContext('2d');
/** Width on screen of a map text, whose size does not change with the zoom. */
function textWidth(text, font) {
  ruler.font = `${font} ${getComputedStyle(document.body).fontFamily}`;
  return ruler.measureText(text).width;
}
const hubFont = (t) => (t.classList.contains('hub') ? (pm.svg.classList.contains('narrow') ? '700 14px' : '700 17px') : '600 13px');

/** The whole map in view. Branch names keep their size on screen, so the map shrinks until each one fits too. */
function fitMap() {
  const box = pm.svg.getBoundingClientRect();
  if (!box.width) return;
  const all = [...pm.nodes.values(), ...pm.hubs.values()];
  if (!all.length) return; // every branch switched off
  const [x0, x1] = [Math.min(...all.map((n) => n.x)), Math.max(...all.map((n) => n.x))];
  const [y0, y1] = [Math.min(...all.map((n) => n.y)), Math.max(...all.map((n) => n.y))];
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  // A narrow screen has no room for names pointing sideways: they sit centred on their branch there.
  const narrow = box.width < 600;
  pm.svg.classList.toggle('narrow', narrow);
  let k = Math.min((box.width - 24) / (x1 - x0 || 1), (box.height - 24) / (y1 - y0 || 1));
  for (const t of pm.world.querySelectorAll('.hubnames text')) {
    const hub = pm.hubs.get(t.dataset.hub);
    const w = textWidth(t.textContent, hubFont(t));
    const anchor = narrow ? 'middle' : t.style.textAnchor;
    const [dx, dy] = [hub.x - cx, hub.y - cy];
    const roomX = box.width / 2 - 8 - (anchor === 'middle' ? w / 2 : w);
    const outward = anchor === 'middle' || (anchor === 'start') === dx > 0;
    if (outward && dx && roomX > 0) k = Math.min(k, roomX / Math.abs(dx));
    const roomY = box.height / 2 - 30;
    if (dy && roomY > 0) k = Math.min(k, roomY / Math.abs(dy));
  }
  pm.view = { k, x: box.width / 2 - cx * k, y: box.height / 2 - cy * k };
  pm.moved = false;
  applyView();
}
function applyView() {
  // The map never scrolls away into emptiness, corners included: someone is always within 40 % of the view's smaller
  // side from its middle. When no one is, the view moves just enough toward the nearest person.
  const box = pm.svg.getBoundingClientRect();
  if (box.width && pm.nodes?.size) {
    const v = pm.view;
    const [cx, cy] = [(box.width / 2 - v.x) / v.k, (box.height / 2 - v.y) / v.k];
    let near = null;
    let best = Infinity;
    for (const n of pm.nodes.values()) { const d = Math.hypot(n.x - cx, n.y - cy); if (d < best) [best, near] = [d, n]; }
    const reach = (0.4 * Math.min(box.width, box.height)) / v.k;
    if (best > reach) {
      const pull = (best - reach) / best;
      v.x -= (near.x - cx) * pull * v.k;
      v.y -= (near.y - cy) * pull * v.k;
    }
  }
  const { k, x, y } = pm.view;
  pm.world.setAttribute('transform', `translate(${x} ${y}) scale(${k})`);
  pm.svg.style.setProperty('--k', k); // text keeps one size on screen
  pm.labels ||= requestAnimationFrame(placeLabels);
}
/** Which names show and where. Found and open people first (a search is for their names), then branch names, then
    the people he writes with most. A name that would cover another moves just below or above its place, or stays
    hidden until there is room for it (hovering shows it), as graph tools like Obsidian do. */
function placeLabels() {
  pm.labels = 0;
  if (!pm.view || !pm.svg.isConnected) return;
  const { k, x: vx, y: vy } = pm.view;
  const box = pm.svg.getBoundingClientRect();
  const taken = [];
  const free = (r) => r.x >= 0 && r.x + r.w <= box.width && r.y >= 0 && r.y + r.h <= box.height
    && !taken.some((t) => r.x < t.x + t.w && t.x < r.x + r.w && r.y < t.y + t.h && t.y < r.y + r.h);
  // Puts a name at the first free spot (or in place when it must show anyway) and says whether it shows.
  const put = (el, r, must) => {
    let d = [0, 15, -15, 30, -30, 45, -45, 60, -60, 75, -75].find((dy) => free({ ...r, y: r.y + dy }));
    if (d === undefined && must) d = 0;
    el.dataset.dw = (d || 0) / k; // the nudge in map units, as the transform holds it
    if (d) el.setAttribute('transform', `translate(0 ${(d / k).toFixed(2)})`);
    else el.removeAttribute('transform');
    if (d !== undefined) taken.push({ ...r, y: r.y + d });
    return d !== undefined;
  };
  const finding = pm.svg.classList.contains('finding');
  const narrow = pm.svg.classList.contains('narrow');
  const marked = (n) => n.el.classList.contains('hit') || n.el.classList.contains('on');
  const shown = new Set();
  const person = (n, must) => {
    n.w ??= textWidth(n.p.name, '400 12px');
    const r = { x: vx + n.x * k - n.w / 2 - 2, y: vy + (n.y + n.r + 2) * k, w: n.w + 4, h: 15 };
    if (r.x + r.w > 0 && r.x < box.width && r.y > -20 && r.y < box.height && put(n.t, r, must)) shown.add(n);
  };
  const order = [...pm.nodes.values()].sort((a, b) => (b.p.n || 0) - (a.p.n || 0));
  for (const n of order) if (marked(n)) person(n, true);
  // Main branches before sub-branches, bigger before smaller. A main branch shows even when crowded; on a phone's
  // overview the sub-branches wait for a zoom, so the main ones get the room.
  const rank = (t) => (t.classList.contains('hub') ? 1e6 : 0) + (pm.size.get(t.dataset.hub) || 0);
  for (const t of [...pm.world.querySelectorAll('.hubnames text')].sort((a, b) => rank(b) - rank(a))) {
    const b = t.getBoundingClientRect();
    const r = { x: b.x - box.x, y: b.y - box.y - (+t.dataset.dw || 0) * k, w: b.width, h: b.height };
    const main = t.classList.contains('hub');
    t.classList.toggle('cut', !((main || !narrow || k > 0.5) && put(t, r, main)));
  }
  // Overview: branch names only. Searching: only the people found.
  if (!finding && k > 0.7) for (const n of order) if (!marked(n) && !n.el.classList.contains('gone')) person(n, false);
  for (const n of pm.nodes.values()) {
    const c = n.el.classList;
    n.t.setAttribute('class', [shown.has(n) && 'lbl', pm.hover === n.p.id && 'hov', ...['on', 'cur', 'hit', 'gone'].filter((x) => c.contains(x))].filter(Boolean).join(' '));
  }
}
function mapZoom(px, py, factor) {
  const v = pm.view;
  const k = Math.min(8, Math.max(0.15, v.k * factor));
  pm.view = { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
  pm.moved = true;
  applyView();
}

/** Drag or two fingers on a touchpad to move, pinch or Ctrl+wheel to zoom (as in Figma), click a person to see them. */
function wireMap(stage) {
  const svgEl = pm.svg;
  const pts = new Map();
  let moved = false;
  svgEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const box = svgEl.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      // A touchpad pinch arrives as Ctrl+wheel in small steps (2–10), a mouse wheel's notch as ~100: the log keeps
      // small steps nearly as they are and tames big ones, without a jump in between.
      const step = Math.sign(e.deltaY) * 10 * Math.log1p(Math.abs(e.deltaY) / 10);
      return mapZoom(e.clientX - box.left, e.clientY - box.top, Math.exp(-step * 0.01));
    }
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.height : 1; // lines or pages, in Firefox
    pm.view.x -= e.deltaX * unit;
    pm.view.y -= e.deltaY * unit;
    pm.moved = true;
    applyView();
  }, { passive: false });
  // A person under the pointer, by their circle or by their name.
  const personAt = (el) => el.closest('.pnode')?.dataset.id || (el.closest('.pnames') && el.dataset.id) || null;
  svgEl.addEventListener('pointerover', (e) => {
    const id = personAt(e.target);
    if (id === pm.hover) return;
    if (pm.hover) pm.nodes.get(pm.hover)?.t?.classList.remove('hov');
    pm.hover = id;
    const n = id && pm.nodes.get(id);
    n?.t?.classList.add('hov');
    // The name of whoever the pointer is on, above everything (other names, branch names, the dimming of a search).
    pm.tip.setAttribute('visibility', n ? 'visible' : 'hidden');
    // Where the name shows now (placeLabels may have moved it off a crowded spot), so it does not jump.
    const dw = n?.t?.classList.contains('lbl') ? +n.t.dataset.dw || 0 : 0;
    if (n) { pm.tip.setAttribute('x', n.x.toFixed(1)); pm.tip.setAttribute('y', (n.y + n.r + 2 + dw).toFixed(1)); pm.tip.textContent = n.p.name; }
  });
  // The mouse leaving the map (to another window) takes the name with it.
  svgEl.addEventListener('pointerleave', () => {
    if (pm.hover) pm.nodes.get(pm.hover)?.t?.classList.remove('hov');
    pm.hover = null;
    pm.tip.setAttribute('visibility', 'hidden');
  });
  svgEl.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    moved = false;
  });
  svgEl.addEventListener('pointermove', (e) => {
    const last = pts.get(e.pointerId);
    if (!last) return;
    if (!e.buttons) return pts.delete(e.pointerId); // let go outside the map
    const box = svgEl.getBoundingClientRect();
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const other = a === last ? b : a;
      const before = Math.hypot(last.x - other.x, last.y - other.y);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      if (before > 0) mapZoom((e.clientX + other.x) / 2 - box.left, (e.clientY + other.y) / 2 - box.top, after / before);
    } else {
      pm.view.x += e.clientX - last.x;
      pm.view.y += e.clientY - last.y;
      pm.moved = true;
      applyView();
    }
    // A press turns into a drag 4 px from where it started, and only then is captured: a capture from the press
    // would send the click to the svg, not to the person.
    if (Math.hypot(e.clientX - last.x0, e.clientY - last.y0) > 4 && !svgEl.hasPointerCapture(e.pointerId)) {
      moved = true;
      svgEl.setPointerCapture(e.pointerId);
    }
    pts.set(e.pointerId, { ...last, x: e.clientX, y: e.clientY });
  });
  const up = (e) => pts.delete(e.pointerId);
  svgEl.addEventListener('pointerup', up);
  svgEl.addEventListener('pointercancel', up);
  svgEl.addEventListener('click', (e) => {
    if (moved) return;
    const id = personAt(e.target);
    const hub = e.target.closest('[data-hub]');
    if (id) pickPerson(id);
    else if (hub) { pm.query = hubName(hub.dataset.hub); pm.input.value = pm.query; findPeople(); }
    else pickPerson(null);
  });
  pm.resize?.disconnect();
  // Refits until he zooms or drags it himself; a phone turned to landscape still gets its names placed for the new width.
  pm.resize = new ResizeObserver(() => {
    const { width, height } = stage.getBoundingClientRect();
    if (pm.size2 === `${width}x${height}`) return; // a rebuilt map, not a new size
    pm.size2 = `${width}x${height}`;
    if (!pm.view || !pm.moved) return fitMap();
    pm.svg.classList.toggle('narrow', pm.svg.getBoundingClientRect().width < 600);
    pm.labels ||= requestAnimationFrame(placeLabels);
  });
  pm.resize.observe(stage);
}

const hubName = (ref) => {
  const b = S.account[FRIENDS].branches.find((x) => x.id === branchOf(ref));
  return ref.includes('/') ? b?.subs?.find((s) => `${b.id}/${s.id}` === ref)?.name || '' : b?.name || '';
};
/** Names and groups a person is found by: name, real name, every name they used, their branches and groups. */
const personWords = (p) => fold([p.name, ...(p.alias || []), ...p.b.map(hubName), p.rel, p.note].filter(Boolean).join(' '));

/** Highlights the people matching the search; the arrows walk through them, Enter opens one. */
function findPeople(move = true) {
  const words = fold(pm.query).split(/\s+/).filter(Boolean);
  // Who matches by name or branch comes before who only mentions the word in a note ("rodina" → family first).
  const direct = (p) => words.every((w) => fold([p.name, ...(p.alias || []), ...p.b.map(hubName), p.rel].filter(Boolean).join(' ')).includes(w));
  pm.hits = words.length ? pm.people.filter((p) => words.every((w) => personWords(p).includes(w)))
    .sort((a, b) => direct(b) - direct(a) || (b.n || 0) - (a.n || 0)).map((p) => p.id) : [];
  pm.hit = 0;
  const hits = new Set(pm.hits);
  pm.svg.classList.toggle('finding', words.length > 0);
  for (const g of pm.svg.querySelectorAll('.pnode')) g.classList.toggle('hit', hits.has(g.dataset.id));
  for (const t of pm.svg.querySelectorAll('.threads path[data-of]')) t.classList.toggle('hit', t.dataset.of.split(' ').some((id) => hits.has(id)));
  pm.none.hidden = !(words.length && !pm.hits.length);
  if (move && pm.hits.length === 1) centerOn(pm.hits[0]);
  else if (move && pm.hits.length) showNodes(pm.hits);
  syncPeopleCard();
}
/** Zooms so that all these people are in view (a group or družina that was searched for). */
function showNodes(ids) {
  let ns = ids.map((id) => pm.nodes.get(id)).filter(Boolean);
  const box = pm.svg.getBoundingClientRect();
  if (!ns.length || !box.width) return;
  // Zoom on where most of them are: a few far away (a teacher who is also in another branch) would otherwise keep the
  // view so wide that the names of the rest pile up. The far ones stay highlighted and named, a drag away.
  if (ns.length > 5) {
    const mid = (v) => v.sort((a, b) => a - b)[v.length >> 1];
    const [mx, my] = [mid(ns.map((n) => n.x)), mid(ns.map((n) => n.y))];
    ns = ns.sort((a, b) => Math.hypot(a.x - mx, a.y - my) - Math.hypot(b.x - mx, b.y - my)).slice(0, Math.ceil(ns.length * 0.8));
  }
  const [x0, x1, y0, y1] = [Math.min(...ns.map((n) => n.x)), Math.max(...ns.map((n) => n.x)), Math.min(...ns.map((n) => n.y)), Math.max(...ns.map((n) => n.y))];
  const room = box.width > 700 ? 340 : 0; // the card on the right
  const k = Math.min(2.5, (box.width - room - 80) / (x1 - x0 + 1), (box.height - 80) / (y1 - y0 + 1));
  pm.view = { k, x: (box.width - room) / 2 - ((x0 + x1) / 2) * k, y: box.height / 2 - ((y0 + y1) / 2) * k };
  applyView();
}
/** Esc: the open person and the search go away together; the next Esc closes the map. */
function clearPeople() {
  pm.query = '';
  pm.input.value = '';
  pm.sel = null;
  findPeople();
}
function stepHit(step) {
  if (!pm.hits.length) return;
  pm.hit = (pm.hit + step + pm.hits.length) % pm.hits.length;
  centerOn(pm.hits[pm.hit]);
  syncPeopleCard();
}
function centerOn(id) {
  const n = pm.nodes.get(id);
  if (!n || !pm.view) return;
  const box = pm.svg.getBoundingClientRect();
  const k = Math.max(pm.view.k, 1.4);
  pm.view = { k, x: box.width / 2 - n.x * k, y: box.height / 2 - n.y * k };
  applyView();
}
function pickPerson(id) {
  pm.sel = id;
  if (id) centerOn(id);
  syncPeopleCard();
}

/** The open person's card, and their threads lit up on the map. */
function syncPeopleCard() {
  if (!pm.svg) return;
  // A search shows the first one's card, except on a phone, where the card would cover the others found.
  const roomy = pm.svg.getBoundingClientRect().width > 700 || pm.hits.length === 1;
  const id = pm.sel || (pm.hits.length && roomy ? pm.hits[pm.hit] : null);
  const p = id && pm.people.find((x) => x.id === id);
  const near = new Set(p ? [p.id, ...pm.people.filter((x) => p.sib && x.sib === p.sib).map((x) => x.id)] : []);
  pm.svg.classList.toggle('focus', !!p);
  for (const g of pm.svg.querySelectorAll('.pnode')) { g.classList.toggle('on', near.has(g.dataset.id)); g.classList.toggle('cur', g.dataset.id === id); }
  pm.labels ||= requestAnimationFrame(placeLabels);
  for (const t of pm.svg.querySelectorAll('.threads path[data-of]')) t.classList.toggle('on', t.dataset.of.split(' ').some((x) => x === id));
  pm.card.hidden = !p;
  if (!p) return pm.card.replaceChildren();
  // While Karchi renames someone, a re-render (a sync) leaves the field alone: rebuilding it would blur it, and a blur
  // saves the name half-typed.
  if (pm.renaming === p.id && pm.card.querySelector('.prename')) return;
  const data = S.account[FRIENDS];
  const sibs = pm.people.filter((x) => p.sib && x.sib === p.sib && x.id !== p.id);
  const mine = new Set(p.b);
  const room = (p.rooms || []).find((r) => S.rooms.has(r));
  const span = p.first ? (p.first === p.last ? p.first : `${p.first} – ${p.last}`) : '';
  pm.card.replaceChildren(...[
    h('div', { class: 'pctop' },
      pm.renaming === p.id ? h('input', {
        class: 'prename', value: pm.renameText ?? p.name, placeholder: T('Meno a priezvisko'), 'data-root': '__rename',
        oninput: (e) => { pm.renameText = e.target.value; }, // a sync re-render keeps what is typed
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pm.renaming = null; syncPeopleCard(); }
        },
        // Saved when Karchi leaves the field; empty brings back the name from the map. A re-render moves the map in the
        // page, which blurs the field for a moment and focuses it again: that is not leaving it.
        onblur: (e) => {
          const el = e.target;
          setTimeout(() => {
            // Back in a name field (the same, or the rebuilt card's after a new map): still renaming.
            if (pm.renaming !== p.id || document.activeElement?.classList.contains('prename')) return;
            pm.renaming = null;
            const name = el.value.trim();
            const given = (S.account[FRIEND_EDITS] || {})[p.id]?.name;
            if (name ? name !== p.name : given) editPerson(p, { name: name || undefined }); else syncPeopleCard();
          });
        },
      }) : h('b', { class: 'pname', title: T('Premenovať'), onclick: () => startRename(p.id) }, p.name),
      p.alias ? h('small', {}, p.alias.slice(0, 2).join(', ')) : null,
      h('button', { class: 'pcx', title: T('Zavrieť (Esc)'), onclick: () => pickPerson(null) }, icon('close'))),
    p.note ? h('p', {}, p.note) : null,
    p.unsure ? h('p', { class: 'pstat' }, T('Zaradené podľa pár správ, nemusí sedieť. Oprav vetvy nižšie.')) : null,
    p.rel ? h('p', { class: 'prel' }, p.rel) : null,
    sibs.length ? h('p', { class: 'psibs' }, p.sibq ? T('Asi súrodenci (rovnaké priezvisko): ') : T('Súrodenci: '), sibs.map((s, i) => [i ? ', ' : '', h('a', { href: '#', onclick: (e) => { e.preventDefault(); pickPerson(s.id); } }, s.name)])) : null,
    p.n ? h('p', { class: 'pstat' }, T`${p.n} správ${span ? `, ${span}` : ''}`) : null,
    // Where the person belongs; a click moves them in or out of a branch (saved only on Karchi's homeserver).
    h('div', { class: 'pbranches' }, data.branches.flatMap((b) => [b, ...(b.subs || []).map((s) => ({ ...s, ref: `${b.id}/${s.id}`, color: b.color, sub: true }))])
      .filter((x) => (x.sub ? mine.has(x.ref) : true))
      .map((x) => {
        const ref = x.ref || x.id;
        const on = x.sub || p.b.some((r) => branchOf(r) === ref);
        const past = on && (x.sub ? !!p.was?.includes(ref) : leftBranches(p).has(ref));
        const title = !on ? T('Pridať do tejto vetvy') : past ? T('Odobrať úplne') : T('Už tu nie je (predtým)');
        return colored(x.color, h('button', { class: `pchip${on ? '' : ' off'}${past ? ' past' : ''}${x.sub ? ' sub' : ''}`, title, onclick: () => toggleBranch(p, ref) },
          h('i'), x.name, past ? h('small', {}, T('predtým')) : null));
      })),
    h('div', { class: 'pacts' },
      room ? h('button', { class: 'primary', onclick: () => { S.panel = null; select(room); } }, T('Otvoriť chat')) : null,
      h('button', { class: 'ghost', onclick: () => startRename(p.id) }, T('Premenovať')),
      p.hide ? h('button', { class: 'ghost', onclick: () => editPerson(p, { hide: false }) }, T('Vrátiť na mapu'))
        : h('button', { class: 'ghost', onclick: () => editPerson(p, { hide: true }) }, T('Skryť z mapy'))),
  ].filter(Boolean));
}

/** A click on a branch in the card steps through: in it now → used to be (predtým) → not in it → in it now. */
function toggleBranch(p, ref) {
  const has = p.b.filter((r) => r === ref || branchOf(r) === ref);
  const was = p.was || [];
  if (!has.length) return editPerson(p, { b: [...p.b, ref], was });
  if (!has.every((r) => was.includes(r))) return editPerson(p, { b: p.b, was: [...new Set([...was, ...has])] });
  const b = p.b.filter((r) => !has.includes(r));
  if (!b.length) return editPerson(p, { hide: true });
  editPerson(p, { b, was: was.filter((r) => b.includes(r)) });
}
/** "Jana Nováková", not "janka_n", "Janka" or "𝒥𝒶𝓃𝓀𝒶": two words of plain letters (as people.py's full()). */
const fullName = (n) => (n.match(/\p{L}{2,}/gu) || []).length >= 2 && !/[\d_.@]/.test(n) && n.normalize('NFKC') === n
  && [...n.trim()].every((ch) => /[\p{L}\s'-]/u.test(ch));
/** People on the map known only by a nickname, the ones he writes with most first. */
const nicknamed = (people) => people.filter((p) => !p.hide && !fullName(p.name)).sort((a, b) => (b.n || 0) - (a.n || 0));
function setNaming(on) {
  pm.naming = on;
  pm.drafts = {}; // closing the list (Esc, ✕) drops a half-typed name, as Esc does in the card
  render();
  if (on) requestAnimationFrame(() => pm.el.querySelector('.pnaming input')?.focus());
}
/** "Doplniť mená": every nickname in one list, with what tells who it is; Enter saves the real name and goes on to the
 *  next one, so naming 190 people is typing, not 190 cards. */
function namingList(people) {
  const rows = nicknamed(people);
  pm.drafts ||= {};
  // A name is saved when its field is left (Enter, Tab or a click elsewhere). A save rebuilds the map and this list,
  // which blurs the field for a moment; render then focuses the same row's field again, so that is not leaving it.
  const leave = (p, root) => setTimeout(() => {
    if (!pm.naming || document.activeElement?.dataset?.root === root) return;
    const name = (pm.drafts[p.id] || '').trim();
    delete pm.drafts[p.id];
    if (name && name !== p.name) editPerson(p, { name });
    // The field with the cursor stays in view after the list is rebuilt.
    requestAnimationFrame(() => document.activeElement?.closest?.('.nrow')?.scrollIntoView({ block: 'nearest' }));
  });
  return h('div', { class: 'pnaming', 'data-scroll': 'naming' },
    h('div', { class: 'ntop' }, h('b', {}, T('Doplniť mená')), h('small', {}, T('Napíš meno a priezvisko, Enter ho uloží a ide na ďalšieho. Prezývka ostane ako druhé meno.')),
      // mousedown keeps focus in the field, so no save rebuilds the list under the pointer before the click lands
      h('button', { class: 'pcx', title: T('Zavrieť (Esc)'), onmousedown: (e) => e.preventDefault(), onclick: () => setNaming(false) }, icon('close'))),
    rows.map((p) => h('label', { class: 'nrow' },
      h('span', { class: 'nwho' }, h('b', {}, p.name, p.alias ? h('small', { class: 'nalias' }, T` aj ${p.alias.slice(0, 2).join(', ')}`) : null),
        h('small', {}, [...new Set(p.b.map(hubName))].slice(0, 3).join(', '), p.n ? T`, ${p.n} správ` : '', p.note ? ` – ${p.note}` : '')),
      h('input', {
        placeholder: T('Meno a priezvisko'), 'data-root': `__name:${p.id}`, value: pm.drafts[p.id] || '',
        oninput: (e) => { pm.drafts[p.id] = e.target.value; },
        onblur: () => leave(p, `__name:${p.id}`),
        onkeydown: (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const next = e.target.closest('.nrow').nextElementSibling?.querySelector('input');
            if (next) next.focus(); else e.target.blur();
          } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNaming(false); }
        },
      }))));
}

/** The card's name becomes a field: Karchi writes the real name instead of a nickname. */
function startRename(id) {
  pm.sel = id; // the card stays this person's while the name is typed, whatever a search shows
  pm.renaming = id;
  pm.renameText = null;
  syncPeopleCard();
  const input = pm.card.querySelector('.prename');
  input?.focus();
  input?.select();
}
function editPerson(p, change) {
  const all = { ...(S.account[FRIEND_EDITS] || {}) };
  // A field set to undefined is dropped: an emptied name goes back to the map's.
  all[p.id] = Object.fromEntries(Object.entries({ ...all[p.id], ...change }).filter(([, v]) => v !== undefined));
  S.account[FRIEND_EDITS] = all;
  if (change.hide) pm.sel = null;
  putAccount(FRIEND_EDITS, all).catch(() => alert(T('Zmena sa neuložila.')));
  render();
}

// ------------------------------------------------------------------ chat accounts

/** Chat apps Karchi connects himself. Like Beeper, he logs in on the service's own page in a
 *  login window of the desktop shell (window.desktop), never by giving the bridge a password:
 *  Meta flagged the password route (Messenger iOS API) on 2026-11-03 and forced a password reset.
 *  Gmail signs in on Google's page in Karchi's own browser, where Google knows him (a new browser gets
 *  "couldn't verify it's you"), and he pastes the address Google sends him back to; an app password
 *  stays as the other way in. Outlook and Teams sign in the same way on Microsoft's page (server/microsoft). */
const LINKS = [
  // The Meta bridge searches people but keeps no contact list: GET /contacts answers 404.
  { id: 'messenger', name: 'Messenger', icon: '/messenger.ico', base: '/_bridges/messenger/_matrix/provision/v3', flow: 'facebook', noContactList: true },
  // guardsRelogin: its bridge refuses another account's cookies when a login is signed in again (our patch,
  // server/bridges/instagram-relogin.patch), so that login's id may go with the new sign-in.
  { id: 'instagram', name: 'Instagram', icon: '/instagram.png', base: '/_bridges/instagram/_matrix/provision/v3', flow: 'instagram', noContactList: true, guardsRelogin: true },
  // WhatsApp pairs as a linked device: Karchi scans a QR code with his phone. Pairing by phone number
  // and code stays as a fallback; on 2026-11-05 WhatsApp accepted the code but never finished pairing.
  // No login window is needed, so it works outside the desktop app too.
  {
    id: 'whatsapp', name: 'WhatsApp', icon: '/whatsapp.webp', base: '/_bridges/whatsapp/_matrix/provision/v3', flow: 'qr', anywhere: true,
    otherFlow: { qr: ['phone', T('Pripojiť kódom cez telefónne číslo')], phone: ['qr', T('Pripojiť QR kódom')] },
    // Menu names as in WhatsApp's English help; the app shows them in its own language.
    hints: {
      qr: T('Na mobile vo WhatsAppe: Settings → Linked devices → Link a device, a naskenuj tento kód.'),
      code: T('Na mobile vo WhatsAppe: Settings → Linked devices → Link a device → Link with phone number instead, a zadaj tento kód.'),
    },
  },
  // Any number of Gmail addresses, each its own login (multi): the bridge has no people to search.
  {
    id: 'gmail', name: 'Gmail', icon: '/gmail.ico', base: '/_bridges/gmail/_matrix/provision/v3', flow: 'google',
    anywhere: true, multi: true, noContactList: true, noSearch: true,
    otherFlow: { google: ['password', T('Pripojiť heslom aplikácie')], password: ['google', T('Pripojiť cez Google')] },
  },
  // Outlook mail and Teams chats: any number of Microsoft accounts each, signed in separately (one bridge, two APIs).
  {
    id: 'outlook', name: 'Outlook', icon: '/outlook.png', base: '/_bridges/outlook/_matrix/provision/v3', flow: 'microsoft',
    anywhere: true, multi: true, noContactList: true, noSearch: true,
  },
  {
    id: 'teams', name: 'Teams', icon: '/teams.png', base: '/_bridges/teams/_matrix/provision/v3', flow: 'microsoft',
    anywhere: true, multi: true, noContactList: true,
  },
  {
    id: 'discord', name: 'Discord', icon: '/discord.png', legacy: '/_bridges/discord/_matrix/provision/v1',
    // The legacy Discord bridge has no cookie step: the shell picks the token from the web client's API calls.
    login: {
      url: 'https://discord.com/login',
      wait_for_url_pattern: '^https://discord\\.com/channels/',
      fields: [{ id: 'token', required: true, sources: [{ type: 'request_header', name: 'Authorization', request_url_regex: '^https://discord\\.com/api/' }] }],
    },
  },
];

/** bridgev2 provisioning with Matrix auth: the bridge wants the user id next to the token. */
const prov = (app, method, path, body) =>
  call(method, `${path}${path.includes('?') ? '&' : '?'}user_id=${q(S.userId)}`, body ?? (method === 'POST' ? {} : undefined), app.base);

let linksRun = 0;
async function refreshLinks() {
  S.linksAt = Date.now();
  const run = ++linksRun;
  const fresh = {};
  await Promise.all(LINKS.map(async (app) => {
    try {
      if (app.legacy) {
        const ping = await call('GET', '/ping', undefined, app.legacy);
        fresh[app.id] = ping.Discord?.logged_in
          ? [{ id: ping.Discord.id, name: 'Discord', state: { state_event: ping.Discord.connected ? 'CONNECTED' : 'CONNECTING' } }]
          : [];
      } else {
        fresh[app.id] = (await prov(app, 'GET', '/whoami')).logins || [];
      }
    } catch {
      fresh[app.id] = null;
    }
  }));
  // An older answer that comes after a newer one (a check while a sign-in finished) never wins.
  if (run !== linksRun) return;
  const before = JSON.stringify(S.links);
  Object.assign(S.links, fresh);
  // A bar hidden for one breakage shows again when the account breaks the next time.
  if (S.dismissed) { const now = new Set(downAccounts().map(downKey)); for (const k of S.dismissed) if (!now.has(k)) S.dismissed.delete(k); }
  // The inbox bar follows a login that broke or came back, not only Settings; never under a login form.
  if (S.panel === 'settings' || (S.view === 'main' && S.panel !== 'link' && JSON.stringify(S.links) !== before)) render();
}

/** Bridge states change without Weft asking: the Meta and WhatsApp bridges' bots post each change into their rooms
 *  (applySync), and Gmail, Outlook, Teams and Discord are asked every 5 minutes while Weft is in sight. */
let linksTimer = null;
function linksSoon(ms = 1000) {
  clearTimeout(linksTimer);
  linksTimer = setTimeout(() => { if (S.token && S.view === 'main' && !S.offline) refreshLinks(); }, ms);
}
setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - (S.linksAt || 0) > 5 * 60e3) linksSoon(0); }, 60e3);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - (S.linksAt || 0) > 60e3) linksSoon(0); });

/** A login the bridge lost for good: only signing in again brings it back (Meta ends its web sessions by itself now
 *  and then: BAD_CREDENTIALS, "xs cookie was deleted"). A reconnect the bridge does itself is not one. */
const signedOut = (l) => {
  const s = l?.state;
  return !!s && (['BAD_CREDENTIALS', 'LOGGED_OUT'].includes(s.state_event) || s.user_action === 'RELOGIN'
    || (s.state_event === 'UNKNOWN_ERROR' && /logged out|relogin|not logged in/i.test(s.message || '')));
};

/** Signs a lost login (or a network whose login is gone: null) in again. Only a bridge that refuses another account
 *  gets the login's id: with it, finishing as another account would delete this login. Without it the same account
 *  takes its own login back (its chats stay) and another account becomes a second login. */
const signInAgain = (app, login) => startLink(app, app.flow, app.guardsRelogin ? login : null, login || {});

const linkStartPath = (flow, login) => `/login/start/${flow}${login ? `?login_id=${q(login.id)}` : ''}`;

function startLink(app, flow = app.flow, relogin = null, again = null) {
  S.panel = 'link';
  const l = S.link = { app, flow, relogin, again, id: null, step: null, error: '', busy: true };
  render();
  if (!window.desktop && !app.anywhere) return;
  if (app.legacy) return discordLogin(l);
  prov(app, 'POST', linkStartPath(flow, relogin))
    .then((step) => { if (S.link === l) { l.id = step.login_id; advance(step); } })
    .catch((err) => { if (S.link === l) { l.error = err.message; l.busy = false; render(); } });
}

/** Drops the bridge's current login and starts the app's other way in (WhatsApp: QR or phone code). */
function switchFlow(flow) {
  const l = S.link;
  if (l.id) prov(l.app, 'POST', `/login/cancel/${q(l.id)}`).catch(() => {});
  startLink(l.app, flow, l.relogin, l.again);
}

/** QR login steps: the generator loads the first time a bridge shows one. */
let qrcode = null;
function qrImage(data) {
  if (!qrcode) {
    import('/qrcode.js').then((m) => { qrcode = m.default; render(); });
    return h('p', {}, T('Kreslím QR kód…'));
  }
  const qr = qrcode(0, 'L');
  qr.addData(data);
  qr.make();
  // Whole pixels per module and a 4-module white margin keep it sharp and scannable in the dark theme.
  const cell = Math.max(2, Math.floor(260 / (qr.getModuleCount() + 8)));
  return h('img', { class: 'qr', src: qr.createDataURL(cell), alt: T('QR kód') });
}

/** Shows the bridge's next login step, or finishes when the account is connected. */
function advance(step) {
  const l = S.link;
  if (!l) return;
  if (step.type === 'complete') {
    S.link = null;
    S.panel = 'settings';
    S.setTab = 'accounts';
    refreshLinks();
    render();
    // Signed in again as somebody else: that is a second login, and the lost one still waits.
    const done = step.complete?.user_login_id;
    if (l.again?.id && done && String(done) !== String(l.again.id)) {
      // After the paint, so it stands over Settings and not over the closed login.
      setTimeout(() => alert(T`Prihlásil si sa iným účtom ${l.app.name}. ${l.again.name || l.again.id} ostáva odhlásený: prihlás sa znova jeho účtom, alebo ho v Nastaveniach odhlás.`), 50);
    }
    return;
  }
  l.step = step;
  l.busy = false;
  render();
  if (step.type === 'cookies') {
    window.desktop.collect({ ...step.cookies, title: T`Prihlásenie: ${l.app.name}` })
      .then((values) => S.link === l && submitLink(values))
      .catch((err) => { if (S.link === l) { l.error = err.message; render(); } });
  }
  if (step.type === 'display_and_wait') {
    prov(l.app, 'POST', `/login/step/${q(l.id)}/${q(step.step_id)}/display_and_wait`)
      .then((next) => S.link === l && advance(next))
      .catch((err) => { if (S.link === l) { l.error = err.message; render(); } });
  }
}

function submitLink(values) {
  const l = S.link;
  l.busy = true;
  l.error = '';
  l.values = values;
  l.draft = null;
  render();
  prov(l.app, 'POST', `/login/step/${q(l.id)}/${q(l.step.step_id)}/${l.step.type}`, values)
    .then((next) => S.link === l && advance(next))
    .catch((err) => {
      if (S.link !== l) return;
      // The Instagram bridge refuses cookies of another account on reconnect, which would replace the login.
      l.error = err.errcode === 'SK.KARCHI.WRONG_ACCOUNT'
        ? T('Prihlás sa do pôvodného Instagram účtu. Tento účet sa líši; pôvodné pripojenie ostalo zachované.')
        // Meta wants a check (confirm phone or email, "was this you"): it has to be finished before the login counts.
        : /challenge|checkpoint/i.test(err.message)
          ? T`${l.app.name} chce najprv overiť, že si to ty. Skús znova a overenie dokonči v prihlasovacom okne (alebo v appke ${l.app.name}); okno sa potom zavrie samo.`
          : err.message;
      // A Google address that is not one (nothing traded yet) leaves the sign-in open: paste the right one.
      if (l.step['sk.karchi.open_url'] && err.errcode === 'SK.KARCHI.INVALID_INPUT') { l.busy = false; render(); return; }
      // Cookie login needs a deliberate retry; automatically reopening the window can loop on a challenge.
      if (l.step.type === 'cookies') { l.busy = false; render(); return; }
      // A failed form step ends the login on the bridge: start a fresh one so the form works again.

      prov(l.app, 'POST', linkStartPath(l.flow, l.relogin))
        .then((step) => { if (S.link === l) { l.id = step.login_id; advance(step); } })
        .catch(() => { if (S.link === l) { l.busy = false; render(); } });
    });
}

function cancelLink() {
  const l = S.link;
  window.desktop?.cancelCollect();
  if (l?.id) prov(l.app, 'POST', `/login/cancel/${q(l.id)}`).catch(() => {});
  S.link = null;
  S.panel = 'settings';
  S.setTab = 'accounts';
  render();
}

function discordLogin(l) {
  window.desktop.collect({ ...l.app.login, title: T('Prihlásenie: Discord') })
    .then((values) => call('POST', '/login/token', { token: values.token }, l.app.legacy))
    .then(() => S.link === l && advance({ type: 'complete' }))
    .catch((err) => { if (S.link === l) { l.error = err.message; l.busy = false; render(); } });
  l.step = { type: 'window' };
  l.busy = false;
  render();
}

async function unlink(app, login, label = app.name) {
  if (!confirm(T`Odhlásiť ${label}? Správy ostanú, nové prestanú chodiť.`)) return;
  try {
    if (app.legacy) await call('POST', '/logout', {}, app.legacy);
    else await prov(app, 'POST', `/logout/${q(login.id)}`);
  } catch (err) {
    alert(T`Odhlásenie ${label} zlyhalo: ${err.message}`);
  }
  refreshLinks();
}

/** One login step of a bridge: a form (user_input, cookies) or something to show and wait on. */
function linkView() {
  const l = S.link;
  const step = l?.step;
  const head = h('h2', {}, h('img', { class: 'appicon', src: l.app.icon, alt: '' }), l.again ? T`Znova prihlásiť ${l.app.name}` : T`Pripojiť ${l.app.name}`,
    l.again?.name ? h('small', {}, ` · ${l.again.name}`) : null);
  const err = l.error ? h('div', { class: 'err' }, l.error) : null;
  const cancel = h('button', { class: 'ghost', type: 'button', onclick: cancelLink }, T('Zrušiť'));
  if (!window.desktop && !l.app.anywhere) {
    return h('div', { class: 'form inpanel' }, head,
      h('p', {}, T`${l.app.name} sa pripája v desktopovej appke Weft na x270: prihlásiš sa tam na stránke ${l.app.name} ako vždy.`), cancel);
  }
  const [flow, flowLabel] = l.app.otherFlow?.[l.flow] || [];
  const other = flow ? h('button', { class: 'ghost', type: 'button', onclick: () => switchFlow(flow) }, flowLabel) : null;
  if (!step) return h('div', { class: 'form inpanel' }, head, err || h('p', {}, T('Pripájam sa k mostu…')), h('div', { class: 'row' }, cancel, err ? other : null));
  if (step.type === 'cookies' || step.type === 'window') {
    return h('div', { class: 'form inpanel' }, head,
      h('p', {}, T`Prihlás sa v okne ${l.app.name}, ktoré sa otvorilo. Keď budeš prihlásený, okno sa samo zavrie.`), err, h('div', { class: 'row' }, err ? h('button', { class: 'primary', onclick: () => switchFlow(l.flow) }, T('Skúsiť znova')) : null, cancel));
  }
  if (step.type === 'display_and_wait') {
    const d = step.display_and_wait || {};
    // A failed wait ends the login on the bridge, so the code on screen no longer works.
    if (err) {
      return h('div', { class: 'form inpanel' }, head, err,
        h('div', { class: 'row' }, h('button', { class: 'primary', type: 'button', onclick: () => switchFlow(l.flow) }, T('Skúsiť znova')), cancel), other);
    }
    return h('div', { class: 'form inpanel' }, head,
      h('p', {}, l.app.hints?.[d.type] || step.instructions || ''),
      d.data ? (d.type === 'qr' ? qrImage(d.data) : h('div', { class: 'code' }, d.data)) : null,
      h('div', { class: 'row' }, cancel, other));
  }
  const fields = step.type === 'cookies'
    ? (step.cookies?.fields || []).map((f) => ({ id: f.id, name: f.id, type: 'text', optional: !f.required, description: T`Cookie ${f.id} z ${step.cookies?.url || T('prehliadača')}` }))
    : (step.user_input?.fields || []).map((f) => (f.type === 'phone_number'
      ? { ...f, name: T('Telefónne číslo'), description: T('V medzinárodnom tvare, napríklad +421 905 123 456.') } : f));
  const inputs = fields.map((f) => [f, f.type === 'select'
    ? h('select', { name: f.id }, (f.options || []).map((o) => h('option', { value: o }, o)))
    : h('input', {
      name: f.id,
      type: f.type === 'password' ? 'password' : f.type === 'phone_number' ? 'tel' : 'text',
      // Never offer Weft's own saved login here: a bridge's password (an EduPage or Google app password) is another one.
      autocomplete: f.type === 'password' ? 'new-password' : f.type === '2fa_code' ? 'one-time-code' : 'off',
      required: !f.optional,
      // What is typed survives a re-render (a window focus redraws everything); after a failed submit only the
      // non-secret fields come back, and not a Google sign-in's address (its code works once).
      value: l.draft?.[f.id] ?? ((f.type !== 'password' && !step['sk.karchi.open_url'] && l.values?.[f.id]) || f.default_value || ''),
      oninput: (e) => { (l.draft ||= {})[f.id] = e.target.value; },
      'data-root': `__link-${f.id}`,
    })]);
  return h('form', {
    class: 'form inpanel',
    onsubmit: (e) => { e.preventDefault(); submitLink(Object.fromEntries(inputs.map(([f, el]) => [f.id, el.value]))); },
  },
  head,
  step.instructions ? h('p', {}, step.instructions) : null,
  // A sign-in page to open in Karchi's browser (Gmail through Google, Outlook and Teams through Microsoft); the desktop
  // shell hands it to the default browser.
  step['sk.karchi.open_url'] ? h('div', { class: 'row' },
    h('button', { class: 'primary', type: 'button', onclick: () => window.open(step['sk.karchi.open_url'], '_blank', 'noopener') }, step['sk.karchi.open_label'] || T('Otvoriť Google'))) : null,
  inputs.map(([f, el]) => h('label', {}, f.name, el, f.description ? h('small', {}, f.description) : null)),
  err,
  h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit', disabled: l.busy }, l.busy ? T('Prihlasujem…') : T('Pokračovať')), cancel),
  other);
}

// Settings: one section at a time, chosen on the left (on a phone, tabs along the top). Arrow keys move
// between sections; a disconnected account shows on its section's name.
const SET_TABS = [['messages', T('Správy')], ['edupage', 'EduPage'], ['calendar', T('Kalendár')], ['feed', 'Feed'], ['accounts', T('Účty')], ['access', T('Prístupnosť')]];
function settingsTab(id) {
  S.setTab = id;
  render();
  document.querySelector(`.setnav [data-tab="${id}"]`)?.focus();
}
function settingsView() {
  const tab = SET_TABS.some(([id]) => id === S.setTab) ? S.setTab : 'messages';
  const down = downAccounts();
  const pane = { messages: batchSettings, edupage: eduSettings, calendar: calendarSettings, feed: feed.settings, accounts: accountSettings, access: accessSettings }[tab]();
  const move = (ev) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[ev.key];
    if (!step) return;
    ev.preventDefault();
    const i = SET_TABS.findIndex(([id]) => id === tab);
    settingsTab(SET_TABS[(i + step + SET_TABS.length) % SET_TABS.length][0]);
  };
  return h('div', { class: 'settings' },
    h('div', { class: 'setnav', role: 'tablist', 'aria-label': T('Nastavenia'), 'aria-orientation': 'vertical', onkeydown: move },
      h('h2', {}, T('Nastavenia')),
      SET_TABS.map(([id, label]) => h('button', {
        type: 'button', role: 'tab', 'data-tab': id, 'aria-selected': String(id === tab), tabindex: id === tab ? 0 : -1,
        class: id === tab ? 'on' : '', onclick: () => settingsTab(id),
      }, h('span', {}, label), id === 'accounts' && down.length ? h('small', { class: 'setwarn' }, T`odpojené: ${down.length}`) : null))),
    h('div', { class: 'form inpanel setpane', 'data-scroll': `settings:${tab}`, role: 'tabpanel', 'aria-label': SET_TABS.find(([id]) => id === tab)[1] }, pane));
}

// Settings → EduPage: how each type of school notice is made and shown, and which subjects are Karchi's. The bridge
// works out the facts from EduPage's own data (FACTS); everything here is his word over them (RULES), undone the same way.
const KIND_HINTS = {
  znamka: T('Nová známka.'), homework: T('Úloha s termínom a materiálom.'), event: T('Písomky, akcie a voľno.'), signin: T('Prihlasovanie na akcie a voľby.'),
  student_absent: T('Chýbanie zapísané v triednej knihe.'), ospravedlnenka: T('Ospravedlnenie chýbania.'), testpridelenie: T('Test pridelený na EduPage.'),
  testvysledok: T('Výsledok testu.'), contest: T('Súťaže a výzvy.'), payments: T('Platby.'), strava_kredit: T('Kredit v jedálni.'),
  strava_vydaj: T('Výdaj obeda. Skryté: bridge ich ani nepošle.'), stravamenu: T('Jedálny lístok.'), pipnutie: T('Pípnutie kartou pri vchode. Skryté: bridge ich ani nepošle.'),
  lost: T('Nájdené veci.'), genotif: T('Oznamy EduPage všetkým žiakom.'),
  substitution: T('Len „nahraté nové suplovanie“ pre celú školu; tvoje suplované hodiny sú v kalendári.'), confirmation: T('Učiteľ potvrdil, že si prečítal tvoju správu.'),
};
const SHOW_MODES = [['inbox', T('V inboxe')], ['quiet', T('Potichu')], ['hidden', T('Skryť')]];
const WHY = { rozvrh: 'rozvrh', 'známky': T('známky'), 'zoznam žiakov': T('menuje ťa medzi žiakmi'), 'skupina predmetu': T('píše tvojej skupine') };

async function putRules(next) {
  S.account[RULES] = next;
  render();
  await putAccount(RULES, next).catch(() => alert(T('Nastavenie sa neuložilo.')));
}
function setKindRule(kind, patch) {
  const rules = eduRules();
  if ('show' in patch && MADE_BY_PREF[kind]) setPref(MADE_BY_PREF[kind], patch.show !== 'hidden');
  putRules({ ...rules, kinds: { ...rules.kinds, [kind]: { ...rules.kinds?.[kind], ...patch } } });
}
/** Checking a subject back to what EduPage says forgets Karchi's word on it. */
function setSubjectMine(s, mine) {
  const rules = eduRules();
  const subjects = { ...rules.subjects };
  if (mine === (s.mine !== false)) delete subjects[s.id]; else subjects[s.id] = mine;
  putRules({ ...rules, subjects });
}
/** A type's mark as it shows now: its newest notice's (a subject colour needs one), else the rule's own. */
function kindPreview(kind, notices) {
  const last = notices.findLast((ev) => ev.content['sk.karchi.edupage.kind'] === kind && (kindRule(kind).color !== 'subject' || noticeFact(ev)?.subject));
  if (last) return noticeLook(last);
  const rule = kindRule(kind);
  return { color: Cal.isHexColor(rule.color) ? rule.color : '', mark: EDU_ICONS[rule.icon] || EDU_KINDS[kind]?.[1] };
}
function eduKindEditor(kind) {
  const rule = kindRule(kind);
  const pick = (on, attrs, ...kids) => h('button', { type: 'button', 'aria-pressed': String(on), class: on ? 'on' : '', ...attrs }, ...kids);
  return h('div', { class: 'ekedit', 'data-key': `${kind}-edit` },
    h('small', {}, T('Farba')),
    h('div', { class: 'swatches' },
      pick(!rule.color, { onclick: () => setKindRule(kind, { color: '' }) }, T('Pôvodná')),
      pick(rule.color === 'subject', { onclick: () => setKindRule(kind, { color: 'subject' }) }, T('Podľa predmetu')),
      Cal.ACCENT_PALETTE.map((c) => pick(rule.color === c, { class: `sw${rule.color === c ? ' on' : ''}`, title: c, 'aria-label': c, style: { background: c }, onclick: () => setKindRule(kind, { color: c }) }))),
    h('small', {}, T('Značka')),
    h('div', { class: 'swatches' },
      pick(!rule.icon, { onclick: () => setKindRule(kind, { icon: '' }) }, T('Pôvodná')),
      Object.entries(EDU_ICONS).map(([id, mark]) => pick(rule.icon === id, { class: `ic${rule.icon === id ? ' on' : ''}`, 'aria-label': id, onclick: () => setKindRule(kind, { icon: id }) }, icon(mark)))));
}
function eduSettings() {
  const facts = eduFacts();
  const rules = eduRules();
  const notices = eduAll().filter((ev) => ev.content.msgtype === 'm.notice' && ev.content[MARK]);
  const count = (pred) => notices.filter(pred).length;
  const kindOfEv = (ev) => ev.content['sk.karchi.edupage.kind'] || '';
  const kinds = Object.keys(EDU_KINDS);
  const subjects = facts?.subjects || [];
  const hiddenIn = (id) => count((ev) => noticeFact(ev)?.subject === id && !subjectMine(id));
  const forOthers = count((ev) => noticeFact(ev)?.others);
  return [
    h('h3', {}, T('Typy oznamov')),
    h('p', { class: 'hint' }, T('Potichu: oznam je v inboxe, ale nesvieti ako nový. Klik na značku zmení jej farbu a tvar.')),
    h('div', { class: 'ekinds' }, kinds.map((kind) => {
      const rule = kindRule(kind);
      const n = count((ev) => kindOfEv(ev) === kind);
      const open = S.eduKindOpen === kind;
      return [
        h('div', { class: `ekind${open ? ' open' : ''}`, 'data-key': kind },
          h('button', { type: 'button', class: 'ekmark', title: T('Farba a značka'), 'aria-expanded': String(open),
            onclick: () => { S.eduKindOpen = open ? null : kind; render(); } }, kindIcon(kind, kindPreview(kind, notices))),
          h('span', {}, EDU_KINDS[kind][0], h('small', {}, `${KIND_HINTS[kind] || ''}${n ? ` · ${n}` : ''}`)),
          h('div', { class: 'seg', role: 'radiogroup', 'aria-label': EDU_KINDS[kind][0] }, SHOW_MODES.map(([id, label]) =>
            h('button', { type: 'button', role: 'radio', 'aria-checked': String(rule.show === id), class: rule.show === id ? 'on' : '',
              onclick: () => { if (rule.show !== id) setKindRule(kind, { show: id }); } }, label)))),
        open ? eduKindEditor(kind) : null,
      ];
    })),
    h('h3', {}, T('Moje predmety')),
    h('p', { class: 'hint' }, facts
      ? T('Weft to zistí z EduPage sám: tvoj rozvrh, tvoje známky, keď ťa EduPage menuje medzi žiakmi alebo píše tvojej skupine predmetu. Oznamy predmetu, ktorý nie je tvoj, sa skryjú a jeho testy nejdú do kalendára. Tu to len opravíš. Farby sú z kalendára (EduPage rozvrh).')
      : T('EduPage ešte neposlal, ktoré predmety sú tvoje; dovtedy sa ukazuje všetko.')),
    h('div', { class: 'esubjects' }, subjects.map((s) => {
      const said = typeof rules.subjects?.[s.id] === 'boolean';
      const hidden = hiddenIn(s.id);
      const why = s.why?.length ? s.why.map((w) => WHY[w] || w).join(', ') : T('EduPage o ňom nič tvoje nehovorí');
      return h('label', { class: 'bcheck esubj', 'data-key': s.id },
        h('input', { type: 'checkbox', checked: subjectMine(s.id), onchange: (e) => setSubjectMine(s, e.currentTarget.checked) }),
        h('i', { style: { background: subjectColor(s.id) || 'var(--line-strong)' } }),
        h('span', {}, s.name, h('small', {}, [why, said ? T('nastavené ručne') : '', hidden ? T`skrytých oznamov: ${hidden}` : ''].filter(Boolean).join(' · '))));
    })),
    h('h3', {}, T('Iní žiaci')),
    h('label', { class: 'toggle' },
      h('span', {}, T('Ukázať aj oznamy pre iných žiakov a skupiny'),
        h('small', {}, T`EduPage pri nich vymenúva žiakov alebo skupinu bez teba, alebo opravnú písomku pre spolužiakov.${forOthers ? T` Takých je ${forOthers}.` : ''}`)),
      h('input', { type: 'checkbox', checked: !!rules.others, onchange: (e) => putRules({ ...eduRules(), others: e.currentTarget.checked }) })),
  ];
}

/** Účty: every account in one list; a disconnected one says so in its row. */
/** Discord servers Karchi switched off in Settings → Účty: their channels are in no list, search or count, in Weft
 *  and in `weft`. The bridge keeps them, so switching one back on is instant. { off: { [guild id]: name } } */
const DISCORD_SERVERS = 'sk.karchi.discord.servers';
const serversOff = () => S.account[DISCORD_SERVERS]?.off || {};
/** An old channel only the archive has is titled "Server / channel" (collect_history.py). */
const serverOff = (r, off) => r.app === 'discord' && (r.serverId ? r.serverId in off
  : r.archiveOnly && Object.values(off).some((name) => r.bridgeName?.startsWith(`${name} / `)));

async function loadDiscordServers() {
  try {
    S.discordServers = (await call('GET', '/guilds', undefined, LINKS.find((a) => a.id === 'discord').legacy)).guilds || [];
  } catch {
    S.discordServers = null;
  }
  if (S.panel === 'settings') render();
}

/** On: a server the bridge has not taken yet is bridged with all its channels (new messages only: the bridge
 *  fetches no channel history). Off: Weft only stops showing it. */
async function setServerShown(g, on) {
  const off = { ...serversOff() };
  // A busy checkbox is disabled and loses the keyboard; it gets it back once the bridge answered.
  const had = document.activeElement?.dataset?.root === `dcserver:${g.id}`;
  const back = () => { if (had && (!document.activeElement || document.activeElement === document.body)) document.querySelector(`[data-root="dcserver:${g.id}"]`)?.focus(); };
  if (on && g.bridging_mode === 'nothing') {
    S.serverBusy = g.id;
    render();
    try {
      await call('POST', `/guilds/${g.id}`, { auto_create_channels: true }, LINKS.find((a) => a.id === 'discord').legacy);
    } catch (err) {
      alert(T`Server ${g.name} sa nepripojil: ${err.message}`);
      return;
    } finally {
      S.serverBusy = null;
      loadDiscordServers().then(back);
    }
  }
  if (on) delete off[g.id]; else off[g.id] = g.name;
  if (!on && S.rooms.get(S.selected)?.serverId === g.id) closeThread();
  await putAccount(DISCORD_SERVERS, { off }).catch(() => alert(T('Nastavenie sa neuložilo.')));
  render();
  back();
}

function discordServers() {
  if (!S.links.discord?.length) return null;
  if (S.discordServers === undefined) { S.discordServers = 'loading'; loadDiscordServers(); }
  const list = Array.isArray(S.discordServers) ? [...S.discordServers].sort((a, b) => a.name.localeCompare(b.name, 'sk')) : [];
  const off = serversOff();
  return [
    h('h4', {}, T('Servery')),
    S.discordServers === null ? h('p', { class: 'hint' }, T('Most Discordu neodpovedá.')) : !Array.isArray(S.discordServers) ? h('p', { class: 'hint' }, T('Zisťujem…')) : null,
    list.length ? h('div', { class: 'calshown' }, list.map((g) => h('label', { class: 'bcheck', 'data-key': g.id },
      h('input', { type: 'checkbox', 'data-root': `dcserver:${g.id}`, checked: g.bridging_mode !== 'nothing' && !(g.id in off), disabled: S.serverBusy === g.id,
        onchange: (e) => setServerShown(g, e.currentTarget.checked) }),
      g.name, S.serverBusy === g.id ? h('small', {}, T(' · pripájam…')) : null))) : null,
    list.length ? h('p', { class: 'hint' }, T('Zapnutý server má vo Wefte svoje kanály a chodia z neho nové správy; staršie než zapnutie tu nebudú. Vypnutý sa neukazuje vo Wefte ani vo weft.')) : null,
  ];
}

/** An account row that opens its options below it (`S.acctOpen`), by click, Enter or Space; it keeps the keyboard. */
function openableAcct(id, src, name, sub) {
  const open = S.acctOpen === id;
  return h('div', {
    class: `acct click${open ? ' open' : ''}`, role: 'button', tabindex: 0, 'aria-expanded': String(open), 'data-key': `acct:${id}`, 'data-root': `acct:${id}`,
    onclick: () => { S.acctOpen = open ? null : id; render(); },
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } },
  },
    h('img', { class: 'appicon', src, alt: '' }),
    h('span', {}, name, h('small', {}, sub)),
    h('span', { class: 'chev' }, open ? '▾' : '▸'));
}

function accountSettings() {
  const login = S.logins[0];
  return [
    h('h3', {}, T('Pripojené účty')),
    openableAcct('edupage', '/edupage.png', 'EduPage', login ? login.name + (login.state?.message ? ` · ${login.state.message}` : '') : T('nepripojené')),
    S.acctOpen === 'edupage' ? h('div', { class: 'acctopts' },
      h('button', { class: 'ghost', type: 'button', onclick: () => settingsTab('edupage') }, T('Oznamy a predmety…')),
      login ? h('button', { class: 'ghost danger', onclick: edupageLogout }, T('Odhlásiť EduPage')) : null) : null,
    LINKS.map((app) => {
      const logins = S.links[app.id];
      // Two logins of a one-account network (signed in again as somebody else): each gets its own row.
      if ((app.multi || logins?.length > 1) && logins?.length) return multiLinkRows(app, logins);
      const first = logins?.[0];
      // Discord's row opens to its servers and its logout, like EduPage's.
      if (app.id === 'discord' && first) return [
        openableAcct('discord', app.icon, app.name, first.name + linkStatus(first)),
        S.acctOpen === 'discord' ? h('div', { class: 'acctopts' },
          discordServers(),
          signedOut(first) ? h('button', { class: 'primary', type: 'button', onclick: () => signInAgain(app, first) }, T('Znova prihlásiť')) : null,
          h('button', { class: 'ghost danger', type: 'button', onclick: () => unlink(app, first) }, T('Odhlásiť Discord'))) : null,
      ];
      return h('div', { class: 'acct' }, h('img', { class: 'appicon', src: app.icon, alt: '' }),
        h('span', {}, app.name, h('small', {},
          logins === undefined ? T('zisťujem…') : logins === null ? T('most neodpovedá')
            : first ? first.name + linkStatus(first) : T('nepripojené'))),
        logins === null ? null : first
          ? h('div', { class: 'row' }, signedOut(first) ? h('button', { class: 'primary', onclick: () => signInAgain(app, first) }, T('Znova prihlásiť')) : null, h('button', { class: 'ghost danger', onclick: () => unlink(app, first) }, T('Odhlásiť')))
          : h('button', { class: 'primary', onclick: () => startLink(app) }, T('Pripojiť')));
    }),
    // Two Discord logins get plain rows; their servers stay listed below them.
    S.links.discord?.length > 1 ? discordServers() : null,
    callSettings(),
  ];
}

/** Settings → Prístupnosť: where a person's profile opens (this device only; Weft's window only in the desktop app). */
function accessSettings() {
  const can = canFollowWindow();
  const inWeft = can && localStorage.getItem(BROWSER_PREF) === 'weft';
  const pick = (weft) => { if (weft) localStorage.setItem(BROWSER_PREF, 'weft'); else localStorage.removeItem(BROWSER_PREF); render(); };
  // data-root: the panel is drawn anew on each change, and the choice keeps the keyboard.
  const choice = (weft, label) => h('button', { type: 'button', role: 'radio', 'data-root': `browser:${weft ? 'weft' : 'external'}`, 'aria-checked': String(inWeft === weft), class: inWeft === weft ? 'on' : '',
    disabled: weft && !can, onclick: () => pick(weft) }, label);
  return [
    h('h3', {}, T('Prehliadač')),
    h('p', { class: 'hint' }, T('Kde sa otvorí profil človeka na Instagrame alebo Facebooku (Ctrl+N → Hľadať mimo kontaktov). Len na tomto zariadení.')),
    h('div', { class: 'seg', role: 'radiogroup', 'aria-label': T('Prehliadač') }, choice(false, T('Externý prehliadač')), choice(true, T('Vo Wefte'))),
    h('p', { class: 'hint' }, !can ? T('Vo Wefte to ide len v aplikácii Weft na počítači.')
      : inWeft ? T('Okno Weftu ukáže len meno a tlačidlo Sledovať alebo Pridať priateľa; nič iné sa v ňom otvoriť nedá. Ide cez asus, takže ho blokovanie stránky na tomto počítači nezastaví. Prihlásenie zdieľa s oknom hovorov.')
      : T('Profil sa otvorí celý v tvojom prehliadači.')),
  ];
}

/** The way out of the desktop shell's call windows: their own logins (never the bridges') are forgotten at once. */
function callSettings() {
  if (!window.desktop?.forgetCalls) return null;
  const nets = window.desktop.callNetworks || [];
  const names = nets.filter(callWindow).map((id) => appOf(id)?.name || id).join(', ');
  return [
    h('h3', {}, T('Okno hovorov')),
    h('p', { class: 'hint' }, T`Hovor cez ${names} beží v okne Weftu s vlastným prihlásením; most ostáva prihlásený zvlášť.`),
    nets.includes('discord') ? h('label', { class: 'toggle' },
      h('span', {}, T('Discord v okne hovoru (beta)'),
        h('small', {}, T('Telefón v DM otvorí chat v okne Weftu a okno samo stlačí hovor; v skupinovom DM zazvoní celej skupine. Keď je ten chat v okne už otvorený, zavoláš v ňom sám, a klik na iný DM bežiaci hovor zloží. Discord automatizáciu účtu zakazuje: riziko je malé, nie nulové. Len na tomto zariadení.'))),
      h('input', { type: 'checkbox', checked: discordBeta(), onchange: (e) => {
        if (e.currentTarget.checked) localStorage.setItem(DISCORD_BETA, '1'); else localStorage.removeItem(DISCORD_BETA);
        render();
      } })) : null,
    h('button', { class: 'ghost danger', type: 'button', onclick: async () => {
      if (!confirm(T('Zavrieť okno hovorov a odhlásiť ho?'))) return;
      try { await window.desktop.forgetCalls(); alert(T('Okno hovorov je odhlásené.')); } catch { alert(T('Odhlásenie okna hovorov sa nepodarilo.')); }
    } }, T('Odhlásiť okno hovorov')),
  ];
}


/** "7", "730", "7:30", "15.30" or "1530" -> "07:30" style; "" clears the time; anything else is null. */
function parseTime(typed) {
  const s = typed.trim();
  if (!s) return '';
  const m = s.match(/^(\d{1,2})(?:[:.]?(\d{2}))?$/);
  if (!m || Number(m[1]) > 23 || Number(m[2] || 0) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2] || '00'}`;
}

/** The three batch times as plain text fields (from tomorrow on); `where` keeps the menu's and Settings' fields apart. */
function timeInputs(where) {
  const b = batchTarget();
  const drafts = (S.timeDrafts ||= []);
  // Plain text, always 24 h: a time field follows the system's AM/PM and redraws on every digit typed.
  const setTime = (i, typed) => {
    drafts[i] = undefined;
    const value = parseTime(typed);
    if (value === null) { alert(T('Čas napíš ako 7:30 alebo 1930.')); return render(); } // the old one comes back
    const times = [...b.times];
    times[i] = value;
    saveBatches({ times });
  };
  return [0, 1, 2].map((i) => h('input', {
    value: drafts[i] ?? b.times[i] ?? '', placeholder: 'hh:mm', inputmode: 'numeric', maxlength: 5, spellcheck: false,
    'aria-label': T`${i + 1}. čas`, 'data-root': `__btime-${where}${i}`,
    oninput: (e) => { drafts[i] = e.target.value; },
    onchange: (e) => setTime(i, e.target.value),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); },
  }));
}
const timesValid = (b = batchPrefs()) => b.times.some((t) => /^\d\d:\d\d$/.test(t));
const WINDOW_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8];
const WINDOW_LENGTHS = [5, 10, 15, 20, 30];

/** Settings' first section: when messages from others come in (one switch, one line about the chosen way) and how
 *  many reading windows a day of how many minutes. Every change here applies from tomorrow. */
// Settings → Správy → Jazyk: per device, like the browser's own language. Each language is named in itself. The page
// reloads to switch; unsent text is kept (drafts live in localStorage), but an attachment, a mail or a recording waits.
const LANGS = [['sk', 'Slovenčina'], ['en', 'English']]; // i18n-ignore: each language's own names
function switchLang(lang) {
  if (lang === LANG) return;
  if (rec || S.attach.size || mailUnsent()) return alert(T('Pred zmenou jazyka odošli alebo zahoď prílohy, rozpísaný mail a nahrávanie.'));
  persistDrafts();
  setLang(lang);
  location.reload();
}
function langSetting() {
  return [
    h('h3', {}, T('Jazyk')),
    h('div', { class: 'seg', role: 'radiogroup', 'aria-label': T('Jazyk') }, LANGS.map(([id, label]) =>
      h('button', { type: 'button', role: 'radio', lang: id, 'aria-checked': String(LANG === id), class: LANG === id ? 'on' : '', onclick: () => switchLang(id) }, label))),
  ];
}
function batchSettings() {
  const now = batchPrefs();
  const b = batchTarget();
  const policy = feed.policy();
  const plan = policy?.next || policy || { count: readingWindow()?.count || 3, minutes: windowMinutes() };
  const setPolicy = (patch) => feed.setPolicy({ count: plan.count, minutes: plan.minutes, ...patch });
  const minutes = plan.minutes;
  const left = windowsLeft() ? T`ešte ${windowsWord(windowsLeft())}` : T('už žiadne');
  const line = {
    manual: h('p', { class: 'bline' }, T`Správy počkajú, kým klikneš na oko vedľa lupy. Potom ${minutes} minút chodia hneď.`),
    times: h('p', { class: 'bline' }, T('Správy prídu o'), ...timeInputs('settings'), timesValid(b) ? T`a ${minutes} minút potom chodia hneď.` : T('Zadaj aspoň jeden čas.')),
  }[b.mode];
  const modeNow = `${BATCH_MODES.find(([id]) => id === now.mode)?.[1] || ''}${now.mode === 'times' ? ` (${now.times.filter(Boolean).join(', ')})` : ''}${now.edupage && !b.edupage ? T(', EduPage počká') : ''}`;
  return [
    langSetting(),
    h('h3', {}, T('Nové správy')),
    h('div', { class: 'seg', role: 'radiogroup', 'aria-label': T('Nové správy') }, BATCH_MODES.map(([id, label]) =>
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(b.mode === id), class: b.mode === id ? 'on' : '', onclick: () => b.mode !== id && saveBatches({ mode: id }) }, label))),
    line,
    now.pending ? h('p', { class: 'hint bnext' }, T`Platí od zajtra, dnes ešte ${modeNow}.`) : null,
    h('p', { class: 'bline' }, T('Okná na čítanie:'),
      h('select', { 'aria-label': T('Počet okien denne'), onchange: (e) => setPolicy({ count: Number(e.target.value) }) },
        WINDOW_COUNTS.map((n) => h('option', { value: n, selected: plan.count === n }, `${n}×`))),
      T('denne po'),
      h('select', { 'aria-label': T('Dĺžka okna'), onchange: (e) => setPolicy({ minutes: Number(e.target.value) }) },
        WINDOW_LENGTHS.map((n) => h('option', { value: n, selected: plan.minutes === n }, `${n} min`)))),
    h('p', { class: 'hint' }, policy?.next ? T`Platí od zajtra, dnes ešte ${policy.count}× po ${policy.minutes} min (${left}).`
      : T`Dnes ${left}. Oko otvorí nové správy spolu s feedom; ďalšie kliknutie počas okna čas nepredĺži. Zmena počtu, dĺžky, režimu aj časov platí od zajtra.`),
    h('label', { class: 'bcheck' },
      h('input', { type: 'checkbox', checked: !!b.edupage, onchange: (e) => saveBatches({ edupage: e.target.checked }) }),
      h('span', {}, T('Aj EduPage počká'), h('small', {}, T('Inak ju vidíš hneď, aj na hodine.')))),
    workSettings(),
    ringSettings(),
    lookSettings(),
    h('h3', {}, T('Spojené chaty')),
    h('label', { class: 'bcheck' },
      h('input', { type: 'checkbox', checked: mergeData().auto !== false, onchange: (e) => { saveMerges({ ...mergeData(), auto: e.target.checked ? null : false }); autoMergeSoon(); } }),
      h('span', {}, T('Automaticky spájať chaty rovnakých ľudí'),
        h('small', {}, T('Rovnaké celé meno na viacerých sieťach, aj so zdrobneninou (Janka – Jana) alebo stredným menom, na každej sieti len raz, alebo človek z mapy ľudí. Rozpojené chaty sa znova nespoja, vypnutie nechá spojené tak, ako sú.')))),
    mergeSuggestions(),
  ];
}

// Settings → Správy → Vzhľad chatov: all chats alike (the default), or each chat its own colour of the palette, shown
// as a faint tint of its messages' background, with „Farba a tvar“ also each person's bubble corners. A one-to-one
// chat's colour is its person's: a merged chat is one person with one colour, and in a group that person's name and
// bubble edge wear the colour of their chat with Karchi; the others in the group take free colours. Colours come
// from the chat's or person's id, so every device shows the same. A colour picked in the chat's menu (Farba chatu…)
// or a person's profile wins and shows in every mode.
// Account data: { mode?: 'color' | 'both', people: { [user id | merge:<id> | group room id]: { color?, shape? } } }.
const LOOK = 'sk.karchi.people.look';
const LOOK_MODES = [['same', T('Rovnako')], ['color', T('Farba')], ['both', T('Farba a tvar')]];
const LOOK_COLORS = [T('Červená'), T('Žltá'), T('Zelená'), T('Modrá')]; // .look-c0… in app.css
const LOOK_SHAPES = [T('Oblá'), T('Cíp'), T('Hranatá')]; // .look-s0…
const lookData = () => S.account[LOOK] || {};
const lookMode = () => (['color', 'both'].includes(lookData().mode) ? lookData().mode : 'same');
function saveLook(data) {
  putAccount(LOOK, data).catch(() => alert(T('Nastavenie sa neuložilo.')));
  render();
}
/** Picks (or with null fields clears) the look of one key. */
function setLook(key, patch) {
  const data = lookData();
  const next = { ...(data.people?.[key] || {}), ...patch };
  for (const k of Object.keys(next)) if (next[k] == null) delete next[k];
  const people = { ...(data.people || {}) };
  if (Object.keys(next).length) people[key] = next; else delete people[key];
  saveLook({ ...data, people });
}
/** Who wears a merged chat's look and who has a one-to-one chat with Karchi. Rebuilt when any room changes (its
 *  version or members: a DM's person may arrive after the room) or Discord's channel list comes. */
let lookKeys = { idx: null, sig: '', channels: null, map: new Map(), dm: new Set() };
function lookIndex() {
  const idx = mergeIndex();
  let versions = 0;
  let members = 0;
  for (const r of S.rooms.values()) { versions += r.version; members += r.members?.size || 0; }
  const sig = `${S.rooms.size}|${versions}|${members}`;
  if (lookKeys.idx !== idx || lookKeys.sig !== sig || lookKeys.channels !== dc.channels) {
    const map = new Map();
    const dm = new Set();
    for (const r of S.rooms.values()) {
      const p = !r.archiveOnly && isChat(r) && dmPartner(r);
      if (!p) continue;
      dm.add(p[0]);
      const g = idx.get(r.id);
      if (g) map.set(p[0], mergeKey(g));
    }
    lookKeys = { idx, sig, channels: dc.channels, map, dm };
  }
  return lookKeys;
}
/** Whose look a sender wears: their merged chat's, else their own. */
const lookKey = (user) => lookIndex().map.get(user) || user;
/** The key of a chat's colour: its person's in a one-to-one chat, the room's in a group. */
const chatLookKey = (r) => { const p = dmPartner(r); return p ? lookKey(p[0]) : r.id; };
const lookHash = (key) => { let x = 2166136261; for (let i = 0; i < key.length; i++) x = Math.imul(x ^ key.charCodeAt(i), 16777619); return x >>> 0; };
const lookSlots = () => (lookMode() === 'both' ? LOOK_COLORS.length * LOOK_SHAPES.length : lookMode() === 'color' ? LOOK_COLORS.length : 0);
/** The look of a key: what Karchi picked, the rest from the key (colour and shape only where the mode shows them). */
function lookOf(key) {
  const p = lookData().people?.[key] || {};
  const n = lookSlots();
  const s = n ? lookHash(key) % n : 0;
  return { color: p.color ?? (n ? s % LOOK_COLORS.length : null), shape: p.shape ?? (lookMode() === 'both' ? Math.floor(s / LOOK_COLORS.length) : null), pickedColor: p.color != null, pickedShape: p.shape != null };
}
/** The classes of a chat's message area: its tint, none while chats look alike. */
const chatTint = (r) => { const c = lookOf(chatLookKey(r)).color; return c == null ? '' : ` tinted look-c${c}`; };
const lookClasses = (l) => `${l.color != null ? ` tinted look-c${l.color}` : ''}${l.shape ? ` look-s${l.shape}` : ''}`;
const lookMemo = new Map(); // room id -> { data, keys, version, size, looks: Map(user -> class names) }
/** The classes of a person's look in a room ('' for Karchi and while all look alike). */
function lookClass(r, user) {
  if (user === S.userId) return '';
  const data = lookData();
  const keys = lookIndex();
  let memo = lookMemo.get(r.id);
  if (!memo || memo.data !== data || memo.keys !== keys || memo.version !== r.version || memo.size !== r.members.size) {
    memo = { data, keys, version: r.version, size: r.members.size, looks: roomLooks(r) };
    lookMemo.set(r.id, memo);
  }
  if (!memo.looks.has(user)) memo.looks.set(user, lookClasses(lookOf(lookKey(user))));
  return memo.looks.get(user);
}
/** The looks of a group's people now in it (bridge bots too: they write). Who has a chat with Karchi wears its
 *  colour, as does one he picked a colour for; with „Farba a tvar“ two of the same colour get different shapes when
 *  one is free. The others take, by id, their own look or the next free one, a free colour before a free shape
 *  (shapes tell apart only those the colours cannot); a picked shape stays. With four colours two people with chats
 *  may share one. Someone who left keeps their own; a group fuller than the looks keeps everyone's own. */
function roomLooks(r) {
  const looks = new Map();
  const n = lookSlots();
  const C = LOOK_COLORS.length;
  const both = lookMode() === 'both';
  const joined = [...r.members].filter(([id, m]) => m.membership === 'join' && id !== S.userId).map(([id]) => id).sort();
  if (!n || dmPartner(r) || joined.length > n) return looks;
  const { dm } = lookIndex();
  const all = joined.map((id) => { const l = lookOf(lookKey(id)); l.fixedColor = l.pickedColor || dm.has(id); return [id, l]; });
  const slotOf = (l) => (both ? l.color + C * l.shape : l.color);
  const taken = new Set();
  const colors = new Set();
  const take = (l) => { taken.add(slotOf(l)); colors.add(l.color); };
  const free = (from, ok) => { for (let i = 0; i < n; i++) { const x = (from + i) % n; if (!taken.has(x) && ok(x)) return x; } return -1; };
  // A fixed colour (picked, or a chat's) goes first, most fixed first: a whole look, then a colour with any free
  // shape, then a picked shape with a free colour; the automatic ones share what is left.
  const place = (l, fits) => {
    let x = free(slotOf(l), (y) => fits(y) && !colors.has(y % C));
    if (x < 0) x = free(slotOf(l), fits);
    if (x >= 0) { l.color = x % C; if (both) l.shape = Math.floor(x / C); }
    take(l);
  };
  const rank = (l) => (l.fixedColor ? (l.pickedShape || !both ? 0 : 1) : l.pickedShape && both ? 2 : 3);
  for (const [, l] of all.filter(([, x]) => rank(x) === 0)) take(l);
  for (const [, l] of all.filter(([, x]) => rank(x) === 1)) place(l, (y) => y % C === l.color);
  for (const [, l] of all.filter(([, x]) => rank(x) === 2)) place(l, (y) => Math.floor(y / C) === l.shape);
  for (const [, l] of all.filter(([, x]) => rank(x) === 3)) place(l, () => true);
  // Where two still share a look, others move within what their picks allow (a matching over at most 12 looks), so
  // everyone differs whenever that is possible.
  for (const [, l] of all) Object.assign(l, { pick: slotOf(l), pickColor: l.color, pickShape: l.shape });
  const owner = new Array(n).fill(null);
  const claim = (l, seen) => {
    for (let i = 0; i < n; i++) {
      const x = (l.pick + i) % n;
      const ok = [x === l.pick, x % C === l.pickColor, Math.floor(x / C) === l.pickShape, true][rank(l)];
      if (seen.has(x) || !ok) continue;
      seen.add(x);
      if (!owner[x] || claim(owner[x], seen)) { owner[x] = l; l.slot = x; return true; }
    }
    return false;
  };
  const clash = [];
  for (const [, l] of all) { if (owner[l.pick]) clash.push(l); else { owner[l.pick] = l; l.slot = l.pick; } }
  for (const l of clash) claim(l, new Set());
  for (const [id, l] of all) {
    if (l.slot != null) { l.color = l.slot % C; if (both) l.shape = Math.floor(l.slot / C); }
    looks.set(id, lookClasses(l));
  }
  return looks;
}
/** Settings → Správy: how chats and people look. */
function lookSettings() {
  const mode = lookMode();
  const demo = [['Ema', T('Ideš zajtra?')], ['Peter', T('Jasné, o piatej.')], ['', T('Ja prídem neskôr.')]];
  return [
    h('h3', {}, T('Vzhľad chatov')),
    h('div', { class: 'seg', role: 'radiogroup', 'aria-label': T('Vzhľad chatov') }, LOOK_MODES.map(([id, label]) =>
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(mode === id), class: mode === id ? 'on' : '', onclick: () => mode !== id && saveLook({ ...lookData(), mode: id === 'same' ? undefined : id }) }, label))),
    h('p', { class: 'hint' }, {
      same: T('Všetky chaty a správy vyzerajú rovnako. Jednému chatu dáš farbu v jeho menu (Farba chatu…).'),
      color: T('Každý chat má jemne zafarbené pozadie, na každom zariadení rovnaké. Človek má v skupine farbu svojho chatu s tebou, ostatní voľnú.'),
      both: T('K farbe má každý človek aj svoj tvar rohov správy, takže sa rozoznajú aj vo väčšej skupine.'),
    }[mode]),
    h('div', { class: `lookdemo${mode === 'same' ? '' : ' tinted look-c3'}`, 'aria-hidden': 'true' }, demo.map(([name, text], i) => {
      const look = mode === 'same' || !name ? '' : ` tinted look-c${i}${mode === 'both' && i ? ` look-s${i}` : ''}`;
      return h('div', { class: `msg${name ? '' : ' mine'}${look}`, 'data-key': `${mode}${i}` }, name ? h('div', { class: 'mname' }, name) : null, h('div', { class: 'mrow' }, h('div', { class: 'bubble' }, text)));
    })),
  ];
}
/** The profile's „Vzhľad“: Karchi picks this person's colour (their chat's too) and shape, or leaves them automatic. */
function lookPicker(user) {
  const key = lookKey(user);
  const mine = lookData().people?.[key] || {};
  const row = (label, field, names, mark) => h('div', { class: 'seg lookpick', role: 'radiogroup', 'aria-label': label },
    [null, ...names.keys()].map((v) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String((mine[field] ?? null) === v), class: (mine[field] ?? null) === v ? 'on' : '',
      onclick: () => setLook(key, { [field]: v }),
    }, v == null ? T('Automaticky') : [h('i', { class: mark(v) }), names[v]])));
  return h('section', { class: 'prof-sec', 'data-key': 'look' },
    h('h3', {}, T('Vzhľad')),
    row(T('Farba'), 'color', LOOK_COLORS, (v) => `swatch look-c${v}`),
    row(T('Tvar'), 'shape', LOOK_SHAPES, (v) => `swatch shape look-s${v}`),
    h('p', { class: 'muted' }, T('Farba platí pre váš chat aj pre jeho správy v skupinách, na každom zariadení. Vybraná sa ukáže, aj keď ostatné vyzerajú rovnako.')));
}
/** Chat menu → Farba chatu…: the chat's colour, by number key or arrows. */
function openChatLook(e) {
  if (e?.room) openOverlay('chatlook', { key: e.key, index: 0 });
}
function chatLookView(o) {
  const e = entryOf(o.key);
  if (!e?.room) return null;
  const key = chatLookKey(e.room);
  const now = lookData().people?.[key]?.color ?? null;
  const choices = [[T('Automaticky'), null], ...LOOK_COLORS.map((name, i) => [name, i])];
  const pick = (v) => { S.overlay = null; setLook(key, { color: v }); };
  o.flat = choices.map(([, v]) => () => pick(v));
  return [
    h('div', { class: 'rsec' }, T`Farba chatu: ${e.title || ''}`),
    h('div', { class: 'results', tabindex: -1, 'data-root': '__overlay', onkeydown: (ev) => {
      const n = Number(ev.key);
      if (n >= 1 && n <= o.flat.length) { ev.preventDefault(); o.flat[n - 1](); }
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); o.index = (o.index + (ev.key === 'ArrowDown' ? 1 : -1) + o.flat.length) % o.flat.length; render(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); o.flat[o.index](); }
    } },
    choices.map(([label, v], i) => resultRow(o, null, i, [h('kbd', { class: 'num' }, String(i + 1)), v == null ? null : h('i', { class: `swatch look-c${v}` }),
      h('div', { class: 'rmeta' }, h('b', {}, label)), h('time', {}, now === v ? T('vybraná') : '')]))),
  ];
}

/** The network of a person: of a chat they are in. */
const workApp = (id) => [...S.rooms.values()].find((r) => r.app && r.members.has(id))?.app;
/** Settings → Správy: the people marked „Práca“, whose messages never wait; added from a chat's menu. */
function workSettings() {
  const people = workPeople().sort((a, b) => a[1].name.localeCompare(b[1].name, 'sk'));
  return [
    h('h3', {}, T`Práca (${people.length})`),
    h('p', { class: 'hint' }, T('Čo napíšu títo ľudia, uvidíš hneď, aj mimo okna na čítanie a aj v skupinách. Pridáš ich pravým klikom na chat → Práca.')),
    people.map(([id, w]) => h('div', { class: 'acct', 'data-key': id },
      h('span', {}, nickOf(id) || w.name, h('small', {}, appOf(workApp(id))?.name || '')),
      h('button', { class: 'ghost', onclick: () => setWork([[id]], false) }, T('Odobrať')))),
  ];
}

/** Settings → Správy: every pair the chats suggest („Aj na …“), to merge or refuse in one place. */
function mergeSuggestions() {
  const pairs = new Map();
  for (const r of S.rooms.values()) {
    if (!canMerge(r)) continue;
    const g = groupOf(r.id);
    for (const x of mergeHints(r)) pairs.set([g ? g.id : r.id, x.id].sort().join('|'), [g, r, x]);
  }
  if (!pairs.size) return null;
  const side = (r, g) => {
    const rooms = g ? g.rooms.map((id) => S.rooms.get(id)).filter(Boolean) : [r];
    return `${g ? mergedTitle(g, rooms) : roomTitle(r)} (${rooms.map((x) => appOf(x.app)?.name).join(', ')})`;
  };
  return [
    h('h3', {}, T`Možno ten istý človek (${pairs.size})`),
    [...pairs.entries()].map(([key, [g, r, x]]) => h('div', { class: 'acct', 'data-key': key },
      h('span', {}, side(r, g), h('small', {}, `+ ${side(x)}`)),
      h('button', { class: 'ghost', onclick: () => mergeChats([...(g ? g.rooms : [r.id]), x.id]) }, T('Spojiť')),
      h('button', { class: 'ghost', title: T('Neponúkať znova'), onclick: () => dismissHint(r.id, x.id) }, T('Nie')))),
  ];
}

/** What is wrong with a login, after its name: the bridge's own words when it has them. */
const linkStatus = (l) => {
  const state = l.state?.state_event;
  if (!state || state === 'CONNECTED' || state === 'CONNECTING') return '';
  return l.state.message ? ` · ${l.state.message}` : ` · ${state.toLowerCase()}`;
};

/** An app with several logins (Gmail): a row per account, each with its own logout, and one more to add. */
function multiLinkRows(app, logins) {
  return [
    logins.map((l) => h('div', { class: 'acct', 'data-key': `${app.id}:${l.id}` }, h('img', { class: 'appicon', src: app.icon, alt: '' }),
      h('span', {}, app.name, h('small', {}, l.name + linkStatus(l))),
      app.id === 'gmail' ? codeModeSelect(l) : null,
      h('div', { class: 'row' }, signedOut(l) ? h('button', { class: 'primary', onclick: () => signInAgain(app, l) }, T('Znova prihlásiť')) : null,
        h('button', { class: 'ghost danger', onclick: () => unlink(app, l, l.name) }, T('Odhlásiť'))))),
    app.multi ? h('div', { class: 'acct' }, h('img', { class: 'appicon', src: app.icon, alt: '' }),
      h('span', {}, app.name, h('small', {}, T('ďalší účet'))),
      h('button', { class: 'primary', onclick: () => startLink(app) }, T('Pridať'))) : null,
  ];
}

// ------------------------------------------------------------------ one-time codes (Gmail)
// The Gmail bridge watches each account's INBOX (IMAP IDLE) and keeps the codes of the last ten minutes in
// memory; Weft asks with a long poll, so a code shows a second or two after Gmail has it. Settings → Účty picks
// per Gmail account: a window, a window and a system notification, or nothing (the bridge keeps the choice and
// watches only accounts that want it). Copying or closing a code closes it on every device.

const CODE_MODES = [['popup', T('Kód: okno')], ['notify', T('Kód: okno a notifikácia')], ['off', T('Kód: nič')]];
const codes = { seq: 0, ttl: 600, skew: 0, list: [], seen: new Set(), gone: new Set(), copied: null, failed: null, notes: new Map(), run: 0, timer: 0 };
const gmailApp = () => LINKS.find((a) => a.id === 'gmail');

/** The code the window shows: the newest one not yet copied, closed or expired (by the bridge's clock). */
function activeCode() {
  const now = Date.now() - codes.skew;
  return codes.list.filter((c) => !c.dismissed && !codes.gone.has(c.id) && now - c.at < codes.ttl * 1000).sort((a, b) => b.at - a.at)[0] || null;
}

async function codesLoop() {
  const run = ++codes.run;
  let wait = 2000;
  pushSetup();
  while (run === codes.run && S.token) {
    const token = S.token;
    if (S.offline) { await new Promise((r) => setTimeout(r, 15000)); continue; }
    try {
      const r = await call('GET', `/codes?since=${codes.seq}&wait=25&user_id=${q(S.userId)}`, undefined, gmailApp().base, AbortSignal.timeout(40000));
      if (run !== codes.run || S.token !== token) return;
      wait = 2000;
      codes.seq = r.seq;
      codes.ttl = r.ttl || codes.ttl;
      if (Number.isFinite(r.now)) codes.skew = Date.now() - r.now;
      gotCodes(r.codes || []);
    } catch (err) {
      if (run !== codes.run) return;
      if (err.status === 401) return; // signed out; boot() starts a new loop
      // An older bridge without /codes, or asus away: ask again later, waiting longer each time.
      await new Promise((res) => setTimeout(res, err.status === 404 ? 5 * 60e3 : wait));
      wait = Math.min(wait * 2, 60e3);
    }
  }
}

function gotCodes(list) {
  const before = activeCode();
  codes.list = list;
  for (const c of list) {
    // Closed here while the bridge did not answer: tell it now, so the other devices close it too.
    if (codes.gone.has(c.id) && !c.dismissed) sendDismiss(c);
    if (c.dismissed) codes.gone.add(c.id); // closed elsewhere: still closed here if the bridge restarts and forgets
    if (codes.seen.has(c.id)) continue;
    codes.seen.add(c.id);
    // A system notification only for a code that just came, for an account that wants one, while Weft is not in front.
    // A device that gets Web Push hears of it from the service worker: two notifications for one code otherwise.
    if (c.mode === 'notify' && !codes.pushed && !c.dismissed && Date.now() - codes.skew - c.at < 120e3 && (document.hidden || !document.hasFocus())) notifyCode(c);
  }
  for (const [id, n] of codes.notes) if (!list.some((c) => c.id === id && !c.dismissed)) { n.close(); codes.notes.delete(id); }
  if (!list.some((c) => c.mode === 'notify' && !c.dismissed && !codes.gone.has(c.id))) closePushNotes();
  const now = activeCode();
  clearTimeout(codes.timer);
  if (now) codes.timer = setTimeout(() => render(), Math.max(1000, now.at + codes.ttl * 1000 - (Date.now() - codes.skew) + 500));
  if (now?.id === before?.id) return; // nothing to show differently: an open settings list keeps its place
  codes.failed = null;
  // The window never takes the keyboard: Enter copies only while nothing else has it (codeKey), so a code
  // never eats a message being typed or a key meant for the calendar.
  render();
}

const sendDismiss = (c) => call('POST', `/codes/${q(c.id)}/dismiss?user_id=${q(S.userId)}`, {}, gmailApp().base).catch(() => {});

/** Signing out: the codes were the old session's; the next session asks afresh. */
function forgetCodes() {
  codes.run++;
  for (const n of codes.notes.values()) n.close();
  clearTimeout(codes.timer);
  Object.assign(codes, { seq: 0, skew: 0, list: [], seen: new Set(), gone: new Set(), copied: null, failed: null, notes: new Map() });
}

/** Enter copies the code while no field, list or button has the keyboard (keydown handler; Esc closes it there
 *  once nothing else open takes Esc). */
function codeKey(e, key) {
  const c = activeCode();
  if (!c || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  const free = !document.activeElement || document.activeElement === document.body;
  if (key === 'enter' && free) { e.preventDefault(); copyCode(c); return true; }
  return false;
}

function notifyCode(c) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    // Without the code itself: the desktop keeps a history of notifications; the code is in Weft's window.
    // Nor may the sender or account carry it: every word with a digit in it goes ("G-583472", "583 473", "A7K2PQ").
    const hide = (s) => s.replace(/[^\s@]*\p{Nd}[^\s@]*(?:\s+\p{Nd}[^\s@]*)*/gu, '…');
    // The tag of the service worker's push notification: on a device that has both, one replaces the other.
    const n = new Notification(T('Prišiel overovací kód'), { body: `${hide(c.from)} · ${hide(c.account)}`, tag: 'weft-code' });
    n.onclick = () => { window.desktop?.focus?.(); window.focus(); n.close(); };
    codes.notes.set(c.id, n);
  } catch { /* a browser that only notifies from a service worker: the window still shows */ }
}

/** What goes to the clipboard: the digits of "482 913" or "G-482913", a code of letters and digits as it is. */
const codeText = (code) => (/^[A-Z]{0,3}-?\d{3}[ -]?\d{1,5}$/i.test(code) ? code.replace(/\D/g, '') : code);

async function copyCode(c) {
  const text = codeText(c.code);
  let done = false;
  try {
    await navigator.clipboard.writeText(text);
    done = true;
  } catch {
    const area = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(area);
    area.select();
    try { done = document.execCommand('copy'); } catch { done = false; }
    area.remove();
  }
  // Closed only once the code is really in the clipboard; otherwise it stays to be selected by hand.
  if (!done) { codes.failed = c.id; return render(); }
  codes.copied = c.id;
  render();
  setTimeout(() => dismissCode(c), 900);
}

function dismissCode(c) {
  if (!c || codes.gone.has(c.id)) return;
  codes.gone.add(c.id);
  codes.notes.get(c.id)?.close();
  codes.notes.delete(c.id);
  if (!activeCode()) closePushNotes();
  sendDismiss(c);
  render();
}

/** Web Push on this device (a phone, a browser): a code of an account set to „okno a notifikácia“ is heard of
 *  also while Weft is closed. The push carries nothing, so the code never passes through Google's or Apple's
 *  push service; the service worker (sw.js) says only that a code came, and opening Weft shows it. The desktop
 *  app has no push service: it notifies only while it is open (closing its window quits it, desktop/main.js). */
async function pushSetup() {
  try {
    if (!gmailApp() || !('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker?.ready;
    if (!reg?.pushManager) return;
    // The service worker has no T(): it shows what Weft last left it, in Weft's language.
    caches.open('weft-prefs').then((c) => c.put('/push-texts', new Response(JSON.stringify({ title: T('Prišiel overovací kód'), body: T('Otvor Weft, kód je v jeho okne.') })))).catch(() => {});
    const { key } = await call('GET', `/push/key?user_id=${q(S.userId)}`, undefined, gmailApp().base);
    const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
    let sub = await reg.pushManager.getSubscription();
    const had = sub?.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (sub && !(had?.length === raw.length && had.every((b, i) => b === raw[i]))) { await sub.unsubscribe(); sub = null; }
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
    await call('POST', `/push/subscribe?user_id=${q(S.userId)}`, { endpoint: sub.endpoint, key }, gmailApp().base);
    codes.pushed = true;
  } catch { /* no push service here (the desktop app, an old browser): Weft notifies while it runs */ }
}

/** A code closed or expired: its push notification goes too, on this device. */
function closePushNotes() {
  navigator.serviceWorker?.getRegistration().then((r) => r?.getNotifications({ tag: 'weft-code' })).then((list) => list?.forEach((n) => n.close())).catch(() => {});
}

function codeView() {
  const c = activeCode();
  if (!c) return null;
  const copied = codes.copied === c.id;
  return h('div', {
    class: 'codepop', role: 'alertdialog', 'aria-label': T('Overovací kód'), 'data-key': `code:${c.id}`,
  },
  h('div', { class: 'codepop-head' },
    h('span', {}, h('b', {}, c.from), c.subject ? h('small', {}, c.subject) : null, h('small', {}, c.account)),
    h('button', { class: 'ghost', title: T('Zavrieť (Esc)'), onclick: () => dismissCode(c) }, icon('close'), T('Zavrieť'))),
  h('div', { class: 'codepop-code', 'aria-live': 'polite' }, c.code),
  codes.failed === c.id ? h('div', { class: 'err', role: 'alert' }, T('Kód sa nedal skopírovať; označ ho a skopíruj sám.')) : null,
  h('button', { class: 'primary', 'data-copy': '', onclick: () => copyCode(c) }, copied ? T('Skopírované') : T('Kopírovať (Enter)')));
}

function codeModeSelect(l) {
  const mode = l['sk.karchi.codes'] || 'popup';
  return h('select', { class: 'codemode', 'aria-label': T`Overovacie kódy z ${l.name}`, title: T('Keď príde overovací kód'), onchange: (e) => setCodeMode(l, e.currentTarget) },
    CODE_MODES.map(([value, label]) => h('option', { value, selected: value === mode }, label)));
}

async function setCodeMode(l, select) {
  const mode = select.value;
  // A browser asks once whether Weft may notify; the choice is a click, so it may ask now (the desktop app may always).
  if (mode === 'notify' && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission().catch(() => {});
  try {
    await call('POST', `/codes/mode/${q(l.id)}?user_id=${q(S.userId)}`, { mode }, gmailApp().base);
    l['sk.karchi.codes'] = mode;
    if (mode === 'notify') pushSetup();
  } catch {
    select.value = l['sk.karchi.codes'] || 'popup'; // the list shows what the bridge kept
    alert(T('Nastavenie sa neuložilo.'));
  }
  render();
}


function loginView() {
  const user = h('input', { name: 'user', autocomplete: 'username', defaultValue: 'karchi' });
  const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password' });
  return h('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      if (S.busy) return;
      const form = e.currentTarget;
      const username = form.elements.user.value.trim();
      const password = form.elements.password.value;
      S.busy = true; S.error = ''; render();
      try {
        await matrixLogin(username, password);
        S.busy = false;
        boot();
      } catch (err) {
        S.busy = false;
        S.error = err.status === 403 ? T('Meno alebo heslo nesedí.') : err.message;
        render();
        if (form.isConnected) form.elements.password.focus();
      }
    },
  },
  h('h2', {}, T('Prihlásenie')),
  h('label', {}, T('Meno'), user),
  h('label', {}, T('Heslo'), pass),
  // Keep the live region mounted before its text changes, including on repeated refusals.
  h('div', { class: 'err', role: 'alert', 'aria-atomic': 'true' }, S.error),
  h('button', { class: 'primary', type: 'submit', disabled: S.busy }, S.busy ? T('Prihlasujem…') : T('Prihlásiť')));
}

function connectView() {
  const step = S.connect?.step;
  if (step?.type === 'display_and_wait') {
    return h('div', { class: 'form' },
      h('h2', {}, T('Pripoj EduPage')),
      h('p', {}, step.instructions),
      S.error ? h('div', { class: 'err' }, S.error) : null,
      h('button', { class: 'ghost', onclick: () => { bridge('POST', `/login/cancel/${q(S.connect.id)}`).catch(() => {}); S.connect = null; render(); } }, T('Zrušiť')));
  }
  const fields = step?.user_input?.fields || [];
  const inputs = fields.map((f) => [f, h('input', {
    name: f.id,
    type: f.type === 'password' ? 'password' : 'text',
    autocomplete: f.type === 'password' ? 'current-password' : f.type === 'username' ? 'username' : 'off',
    required: !f.optional,
  })]);
  return h('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      S.busy = true; S.error = ''; render();
      try {
        await connectStep(Object.fromEntries(inputs.map(([f, el]) => [f.id, el.value])));
      } catch (err) {
        S.error = err.message;
        if (err.errcode === 'SK.KARCHI.EXPIRED') S.connect = null;
      }
      S.busy = false;
      if (S.view === 'connect' && !S.connect) connectStep().then(render, () => render());
      render();
      waitConfirm();
    },
  },
  h('h2', {}, T('Pripoj EduPage')),
  h('p', {}, step?.instructions || T('Prihlás sa rovnako ako na edupage.org.')),
  inputs.map(([f, el]) => h('label', {}, f.name, el, f.description ? h('small', {}, f.description) : null)),
  S.error ? h('div', { class: 'err' }, S.error) : null,
  h('button', { class: 'primary', type: 'submit', disabled: S.busy || !step }, S.busy ? T('Prihlasujem…') : T('Pokračovať')));
}

function show(view) {
  S.view = view;
  S.error = view === 'login' ? S.error : '';
  if (view === 'connect' && !S.connect) connectStep().then(render, (err) => { S.error = err.message; render(); });
  render();
}

function render() {
  renderEpoch++;
  if (S.overlay?.kind !== 'search') searchRest = null; // rows not drawn yet belong to a closed search
  if (S.view === 'main') warmSearch();
  // The gallery covers the whole window: what changes under it is drawn once it closes.
  if (S.overlay?.kind === 'gallery' && gal?.el.isConnected) return galDraw();
  // Another window took its place; Ctrl+J over it keeps it for Esc to come back to.
  const galUnder = (o) => o?.kind === 'gallery' || o?.gallery;
  if (gal && !galUnder(S.overlay) && !galUnder(S.overlay?.back)) { gal.epoch++; gal = null; }
  if (!gal && galUnder(S.overlay)) S.overlay = null;
  if (membersPop && (membersPop.room !== S.selected || S.overlay || S.panel || S.view !== 'main')) closeMembers();
  // Leaving the chat throws its unsent voice message away, as Messenger does.
  if (rec && rec.room !== S.selected) { rec.stop(); rec = null; }
  if (bubbleMemoRoom && bubbleMemoRoom !== S.selected) { bubbleMemo.clear(); bubbleMemoRoom = null; } // the chat was left
  // An edit left unsaved in another chat is dropped; what was written before it comes back.
  if (S.editing && S.editing.room !== S.selected) {
    const { room, draft } = S.editing;
    S.editing = null;
    if (draft) setDraft(room, draft); else deleteDraft(room);
  }
  const root = document.getElementById('app');
  // The DOM is rebuilt: keep what is being typed and where each pane was scrolled.
  const active = document.activeElement;
  const calendarFocus = active?.matches('.home-calendar');
  const schoolFocus = active?.closest('.detail')
    ? (active.dataset.eduAction ? { action: active.dataset.eduAction } : active.matches('.back') ? { back: true } : null) : null;
  const typing = active?.dataset?.root ? { root: active.dataset.root, at: active.selectionStart, end: active.selectionEnd } : null;
  // Settings is drawn whole: its section tab or a control with data-focus keeps the keys through any render (a sync too).
  const setFocus = active?.closest('.setpane') && active.dataset.focus ? `.setpane [data-focus="${CSS.escape(active.dataset.focus)}"]`
    : active?.closest('.setnav') && active.dataset.tab ? `.setnav [data-tab="${CSS.escape(active.dataset.tab)}"]` : null;
  const same = S.shownThread === S.selected;
  const scroll = {};
  const left = {};
  for (const el of root.querySelectorAll('[data-scroll]')) { scroll[el.dataset.scroll] = el.scrollTop; left[el.dataset.scroll] = el.scrollLeft; }
  if (!same) delete scroll.detail;
  // The open chat sticks to its end, or keeps the message at its top where it was.
  let anchor = null;
  const chat = root.querySelector('[data-scroll=chat]');
  // Opened on the "Nové správy" line, it holds there even a few pixels from the end, until Karchi reaches the end.
  const gap = chat ? chat.scrollHeight - chat.scrollTop - chat.clientHeight : 0;
  if (gap <= 1) S.onLine = false;
  let spot = null;
  if (chat && (gap > 40 || (S.onLine && gap > 1))) {
    const top = chat.getBoundingClientRect().top;
    const first = [...chat.querySelectorAll('[data-event]')].find((el) => el.getBoundingClientRect().bottom > top);
    if (first) spot = { id: first.dataset.event, offset: first.getBoundingClientRect().top - top, drawFrom: drawnChat && (mergeViews.get(drawnChat) || S.rooms.get(drawnChat))?.drawFrom };
  }
  if (same) anchor = spot;
  // Leaving a chat (or merging it) remembers where it was; another chat opens where it was left.
  const key = S.selected ? selKey() : null;
  if (chat && S.shownKey && (!same || S.shownKey !== key)) { if (spot) chatSpots.set(S.shownKey, spot); else chatSpots.delete(S.shownKey); }
  // A search hit not shown yet wins; one Karchi already saw does not hold the chat there any more.
  const hit = !!S.focusEvent && S.focusScrolled !== S.focusEvent;
  if (!same && key) spotWant = !hit && chatSpots.has(key) ? { ...chatSpots.get(key), key, tries: 0 } : null;
  else if (same && S.shownKey !== key && spot) spotWant = { ...spot, key, tries: 0 };
  S.shownThread = S.selected;
  S.shownKey = key;
  if (S.overlay?.kind !== 'image') viewerVideo = null;
  let content;
  document.title = 'Weft';
  if (S.view === 'login') content = loginView();
  else if (S.view === 'connect') content = connectView();
  else if (S.view === 'main') content = mainView();
  else if (S.waiting) content = h('div', { class: 'form' }, h('p', {}, S.waiting),
    h('button', { class: 'ghost', onclick: () => { bootRun++; S.waiting = null; clearSession(); show('login'); } }, T('Prihlásiť sa znova')));
  else content = h('div', { class: 'empty' }, T('Načítavam…'));
  const kids = [content].flat().filter(Boolean);
  if (S.view !== 'main' && S.view !== 'login') kids.forEach(opaque);
  patchChildren(root, kids);
  if (!sideRowH) sideRowH = root.querySelector('.sidelist > .item')?.offsetHeight || 0;
  sideWatch(root);
  watchLinks(root);
  watchReels(root);
  if (gal && S.overlay?.kind === 'gallery') galDraw(); // re-attached: back where it was scrolled
  for (const el of root.querySelectorAll('[data-scroll]')) {
    if (scroll[el.dataset.scroll] && el.dataset.scroll !== 'chat') el.scrollTop = scroll[el.dataset.scroll];
    if (left[el.dataset.scroll]) el.scrollLeft = left[el.dataset.scroll];
  }
  // The narrow window's sideways strip brings a newly opened chat into view.
  const strip = root.querySelector('.sidelist');
  if (!same && strip && getComputedStyle(strip).flexDirection === 'row') {
    const sel = strip.querySelector('.item.sel');
    const box = strip.getBoundingClientRect();
    const at = sel?.getBoundingClientRect();
    if (at && at.left < box.left) strip.scrollLeft -= box.left - at.left + 8;
    else if (at && at.right > box.right) strip.scrollLeft += at.right - box.right + 8;
  }
  const chatNew = root.querySelector('[data-scroll=chat]');
  if (chatNew) {
    for (const el of root.querySelectorAll('.ccompose textarea')) if (el._sized !== el.value) autosize(el);
    const kept = anchor && chatNew.querySelector(`[data-event="${CSS.escape(anchor.id)}"]`);
    const mark = S.scrollNew && chatNew.querySelector('.cnew');
    // Just opened with unread messages: the first of them shows under the floating header; otherwise the end.
    const shown = S.rooms.get(S.selected);
    if (spotWant && (spotWant.key !== S.shownKey || (S.focusEvent && S.focusScrolled !== S.focusEvent))) spotWant = null;
    const back = spotWant && chatNew.querySelector(`[data-event="${CSS.escape(spotWant.id)}"]`);
    if (spotWant && !back && (spotWant.tries >= 20 || !shown || !spotCanCome(shown))) spotWant = null; // it is gone
    if (back) {
      chatNew.scrollTop += back.getBoundingClientRect().top - chatNew.getBoundingClientRect().top - spotWant.offset;
      spotWant = null;
      S.scrollNew = false;
    } else if (spotWant) {
      // Not drawn yet: older messages come in until it is (a merged chat may still be loading its other chats).
      spotWant.tries++;
      chatNew.scrollTop = 0;
      (globalThis.requestIdleCallback || setTimeout)(() => { if (S.selected === shown.id && spotWant) chatNearTop(shown); }, { timeout: 300 });
    } else if (S.scrollNew) {
      spotWant = null;
      chatNew.scrollTop = mark ? mark.getBoundingClientRect().top - chatNew.getBoundingClientRect().top - parseFloat(getComputedStyle(chatNew).paddingTop) + 8 : chatNew.scrollHeight;
      S.scrollNew = false;
      S.onLine = !!mark;
    } else if (kept) chatNew.scrollTop += kept.getBoundingClientRect().top - chatNew.getBoundingClientRect().top - anchor.offset;
    else if (anchor) chatNew.scrollTop = scroll.chat || 0;
    else chatNew.scrollTop = chatNew.scrollHeight;
    S.chatAway = null;
    chatAwayCheck(chatNew);
    const focus = S.focusEvent && S.focusScrolled !== S.focusEvent && chatNew.querySelector(`[data-event="${CSS.escape(S.focusEvent)}"]`);
    if (focus) { focus.scrollIntoView({ block: 'center' }); S.focusScrolled = S.focusEvent; }
    // Drawn messages too few to scroll up to the older ones: draw more of them.
    const open = S.rooms.get(S.selected);
    const t = open && timelineOf(open);
    if (t && t.holder.drawFrom && chatNew.scrollTop < 300 && t.msgs[0]?.event_id !== t.holder.drawFrom) {
      (globalThis.requestIdleCallback || setTimeout)(() => { if (S.selected === open.id) chatNearTop(open); }, { timeout: 300 });
    }
  }
  // An EduPage message opened from search: its underlined words come into view once.
  const found = S.focusEvent && S.focusScrolled !== S.focusEvent && root.querySelector('.detail mark.found');
  if (found) { found.scrollIntoView({ block: 'center' }); S.focusScrolled = S.focusEvent; }
  // An open overlay takes the keyboard (its second field, `__overlay-…`, keeps it); otherwise the field that had it keeps it.
  const overlayRoot = S.overlay && (typing?.root?.startsWith('__overlay-') && root.querySelector(`[data-root="${CSS.escape(typing.root)}"]`) ? typing.root : '__overlay');
  const again = root.querySelector(`[data-root="${CSS.escape(overlayRoot || typing?.root || '')}"]`);
  if (again) {
    again.focus({ preventScroll: true });
    // The message box was asked for (a picked name, an edit): its caret now, not at some later render.
    const asked = S.focusComposer && again.matches(".ccompose textarea, .compose textarea");
    if (asked && S.caret != null) again.setSelectionRange(S.caret, S.caret);
    else if (typing?.root === again.dataset.root) try { again.setSelectionRange(typing.at, typing.end); } catch { /* not a text field */ }
    if (asked) { S.focusComposer = false; S.caret = null; }
  } else if (same && schoolFocus && !S.overlay && !S.panel) {
    const target = schoolFocus.back ? root.querySelector('.detail .back')
      : root.querySelector(`[data-edu-action="${CSS.escape(schoolFocus.action)}"]`);
    target?.focus({ preventScroll: true });
  } else if (setFocus) {
    root.querySelector(setFocus)?.focus({ preventScroll: true });
  } else if (S.focusComposer) {
    const box = root.querySelector('.ccompose textarea, .compose textarea');
    if (box) {
      box.focus({ preventScroll: true });
      if (S.caret != null) box.setSelectionRange(S.caret, S.caret);
      S.focusComposer = false;
      S.caret = null;
    }
  }
  if (calendarFocus && !S.panel && !S.overlay && !cal.edit) root.querySelector('.home-calendar')?.focus({ preventScroll: true });
  if (S.view === 'main') { markRead(); if (!S.homeReady) { S.homeReady = true; cal.view = calDefault(); queueMicrotask(() => { loadCalendar(); if (S.surface === 'feed') feed.enter(); else feed.load(); }); } }
}

// Never reload an active conversation's unsent work or an open native login window.
const updates = createUpdates({
  url: import.meta.url,
  ready: () => !rec && !S.overlay && !S.panel && !cal.edit && S.surface !== 'feed' && !S.attach.size && !mailUnsent() && voice.el.paused && ![...S.drafts.values()].some((t) => t.trim()),
  changed: (available) => { if (S.updateAvailable !== available) { S.updateAvailable = available; if (S.view === 'main') refresh(); } },
  reload: (id) => location.replace(`/releases/${id}/index.html${location.search}${location.hash}`),
});
updates.check();
window.addEventListener('online', () => updates.check());
window.addEventListener('focus', () => updates.check());
setInterval(async () => { await updates.check(); if (!document.hasFocus() && !S.offline) updates.apply(); }, 60000);

boot();

// Rozoslať (beta): one message to many people, each in their own chat, with their own greeting. The parts that
// need no window: the text each person gets, the send-later items a confirmation writes, the day's limit and what
// an answer says. app.js draws the four steps.
//
// Account data `sk.karchi.broadcast`: { beta, lists: [{ id, name, people: [{ key, name }] }], items: [{ id, title,
// text, files, state: 'draft' | 'sent', at, stopped?, to: [{ key, name, room, net, greeting, extra?, rsvp?, sent?,
// event?, failed? }] }] }. A person's key is that of `sk.karchi.people.look` (user id, `merge:<id>`), and so is the
// key of the greetings Karchi corrected, `sk.karchi.people.names` { [key]: greeting }.
export const BROADCAST = 'sk.karchi.broadcast';
export const NAMES = 'sk.karchi.people.names';
export const BC_APPS = ['messenger', 'instagram', 'whatsapp', 'discord'];
export const BC_GAP = [25e3, 70e3]; // between two messages, at random; the service keeps the shorter per network
export const BC_DAY = 30; // people per network and day

/** A first name to greet by: „p. Kráľová“ stays as it is, „Janka Kováčová“ gives „Janka“. */
export const firstName = (name) => {
  const s = String(name || '').trim();
  return /^(p\.|pán|pani)\s/i.test(s) ? s : s.split(/\s+/)[0] || s;
};
/** The greeting Weft guesses when Karchi never wrote one; it goes to people, so it stays Slovak. */
export const guessGreeting = (name) => `Ahoj ${firstName(name)},`; // i18n-ignore: text sent to people

/** One person's message: the template with their greeting and first name, and their extra sentence after the
 *  greeting's paragraph (at the end when the template has one paragraph). */
export function personalText(text, t) {
  const greeting = String(t.greeting || '').trim();
  let out = String(text).replace(/\{oslovenie\}/g, greeting).replace(/\{meno\}/g, firstName(t.name)).trim();
  const extra = String(t.extra || '').trim();
  if (extra) {
    const cut = out.indexOf('\n\n');
    out = cut < 0 ? `${out}\n\n${extra}` : `${out.slice(0, cut)}\n\n${extra}${out.slice(cut)}`;
  }
  return out;
}

/** A short stable id of a person's key, for the ids of their send-later items. */
export const personId = (key) => {
  let x = 2166136261;
  for (let i = 0; i < key.length; i++) x = Math.imul(x ^ key.charCodeAt(i), 16777619);
  return (x >>> 0).toString(36);
};
export const batchOf = (bc, t) => `bc-${bc.id}-${personId(t.key)}`;

/** The send-later items of a confirmed broadcast: per person a batch of the text and the files (the same mxc for
 *  everyone), the first at `start`, the next ones 25–70 s apart. Ids come from the broadcast and the person, so a
 *  second confirmation (another device, a double press) writes the same ids and nothing more goes out.
 *  `rand` gives 0–1 (tests pass their own). Returns { items, at: { [key]: ms } }. */
export function laterItemsOf(bc, start, rand = Math.random) {
  const items = [];
  const at = {};
  let when = start;
  for (const t of bc.to) {
    const batch = batchOf(bc, t);
    const text = personalText(bc.text, t);
    const contents = [...(text ? [{ msgtype: 'm.text', body: text }] : []), ...(bc.files || [])];
    contents.forEach((content, seq) => items.push({ id: `${batch}-${seq}`, room: t.room, net: t.net, at: when, seq, batch, gap: BC_GAP[0], content }));
    at[t.key] = when;
    when += Math.round(BC_GAP[0] + rand() * (BC_GAP[1] - BC_GAP[0]));
  }
  return { items, at };
}
/** Adds the items the list does not have yet: the same list back when it has them all. */
export function addOnce(list, items) {
  const have = new Set(list.map((x) => x.id));
  const add = items.filter((x) => !have.has(x.id));
  return add.length ? [...list, ...add] : list;
}

/** People per network a broadcast would reach on the day of `now`, with what already went or waits that day
 *  (send-later's first parts of other broadcasts). { [net]: count } */
export function dayCounts(bc, later, now = Date.now()) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const from = day.getTime();
  const to = from + 864e5;
  const counts = {};
  for (const x of later) {
    if (!x.id?.startsWith('bc-') || x.id.startsWith(`bc-${bc.id}-`) || x.seq || x.failed) continue;
    const ts = x.sent || x.at;
    if (ts >= from && ts < to) counts[x.net] = (counts[x.net] || 0) + 1;
  }
  for (const t of bc.to) counts[t.net] = (counts[t.net] || 0) + 1;
  return counts;
}

/** Yes, no or maybe in an answer, or null. Unsure words win over yes („asi hej“), a no over a yes („nemôžem“). */
export function guessRsvp(text) {
  const t = String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/\b(mozno|asi|neviem|uvidim|uvidime|potvrdim|skusim|zatial nie som isty|zrejme)\b/.test(t)) return 'mozno';
  if (/\b(nie|nemozem|nestihnem|nepridem|nejdem|nebudem|nedam|bohuzial|zial|sorry|sry|nemam cas)\b/.test(t)) return 'nie';
  if (/\b(ano|jasne|jasnacka|jj|hej|ok|okej|oki|idem|pridem|mozem|beriem|budem|super|urcite|samozrejme|dobre|platí|plati|yes)\b/.test(t)
    || /\u{1F44D}|\u{1F44C}|✅/u.test(String(text))) return 'ano';
  return null;
}

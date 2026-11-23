// The calendar's pure part: calendars.json as Kalendarix writes it, the three-way merge with a computer's copy,
// the edits Weft sends and the EduPage timetable mirror. No I/O here; kalendar.ts and store.ts do that.
import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Obj = { [key: string]: Json };
export type Op = { op?: Json; cal?: Json; uid?: Json; event?: Json };

export const TIMETABLE_CAL = "lifeos-edupage";
const TIMETABLE_OURS = "@lifeos";

export const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const list = (x: Json | undefined): Json[] => (Array.isArray(x) ? x : []);

/** The file's text: two-space indent, non-ASCII as is, the same bytes Python's json.dumps(indent=2) gave. */
export const dump = (doc: Json): string => JSON.stringify(doc, null, 2);

/** What a client polls with: changes whenever the file's text does; "" before the first calendars arrive. */
export const version = (doc: Json | undefined): string =>
  doc === null || doc === undefined ? "" : createHash("sha1").update(dump(doc)).digest("hex").slice(0, 12);

/** Equality of JSON values the way the merge has always compared them: key order does not count, 1 equals true. */
export function same(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  const num = (x: Json) => typeof x === "number" || typeof x === "boolean";
  if (num(a) && num(b)) return Number(a) === Number(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && same(a[k], b[k]));
  }
  return false;
}

/** A value with its keys sorted: tells uid-less events apart by content. */
function blob(x: Json): string {
  const sorted = (v: Json): Json =>
    Array.isArray(v) ? v.map(sorted)
    : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k] as Json)]))
    : v;
  return JSON.stringify(sorted(x));
}

// A field or event that is not there, as opposed to one that is null.
const GONE = Symbol("gone");
type Maybe<T> = T | typeof GONE;
const eq = <T>(a: Maybe<T>, b: Maybe<T>, cmp: (x: T, y: T) => boolean) =>
  a === GONE || b === GONE ? a === b : cmp(a, b);

/** Three-way choice for one value: the side that changed it wins, the computer's (local) side when both did. */
function pick<T>(b: Maybe<T>, l: Maybe<T>, m: Maybe<T>, cmp: (x: T, y: T) => boolean): Maybe<T> {
  if (eq(l, m, cmp)) return l;
  if (eq(l, b, cmp)) return m;
  if (eq(m, b, cmp)) return l;
  return l;
}
const pickJson = (b: Maybe<Json>, l: Maybe<Json>, m: Maybe<Json>) => pick(b, l, m, same);
const field = (o: Obj, k: string): Maybe<Json> => (k in o ? (o[k] as Json) : GONE);

/** Items of a list by one of their fields; a later duplicate replaces an earlier one in its place. */
function byKey(items: Json | undefined, key: string): Map<Json, Obj> {
  const out = new Map<Json, Obj>();
  for (const x of list(items)) if (isObj(x) && key in x) out.set(keyOf(x[key] as Json), x);
  return out;
}
// Map keys must be primitive to find each other: ids are strings, anything else goes in by its text.
const keyOf = (v: Json): Json => (isObj(v) || Array.isArray(v) ? "\u0000" + blob(v) : v);

const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];
/** The same function over base, local and master. */
const three = <T, R>(xs: readonly [T, T, T], f: (x: T) => R): [R, R, R] => [f(xs[0]), f(xs[1]), f(xs[2])];
const keysOf = (...objs: Obj[]) => uniq(objs.flatMap((o) => Object.keys(o)));

function mergeFields(b: Obj, l: Obj, m: Obj): Obj {
  const out: Obj = {};
  for (const k of keysOf(m, l)) {
    const v = pickJson(field(b, k), field(l, k), field(m, k));
    if (v !== GONE) out[k] = v;
  }
  return out;
}

type Placed = [cal: Json, event: Obj];
const samePlaced = (x: Placed, y: Placed) => same(x[0], y[0]) && same(x[1], y[1]);

/**
 * Three-way merge of two calendars.json against their common base. Calendars merge field by field; an event whose
 * uid is in one calendar on every side is one thing with a home calendar, so a move and an edit on different sides
 * (or moves on both) end up as one event, each field picked on its own. A uid that some side keeps in several
 * calendars (the same .ics imported twice) merges calendar by calendar. Conflicts: local (the computer) wins.
 */
export function merge(baseIn: Json | undefined, localIn: Json | undefined, masterIn: Json | undefined): Obj {
  const base = isObj(baseIn) ? baseIn : {};
  const master = isObj(masterIn) ? masterIn : {};
  const local = timetableFrom(isObj(localIn) ? localIn : {}, master);
  const out: Obj = {};
  for (const k of keysOf(master, local)) {
    if (k === "calendars") continue;
    const v = pickJson(field(base, k), field(local, k), field(master, k));
    if (v !== GONE) out[k] = v;
  }
  const [bc, lc, mc] = three([base, local, master], (d) => byKey(d.calendars, "id"));
  const meta = (c: Obj): Obj => Object.fromEntries(Object.entries(c).filter(([k]) => k !== "events"));

  const mergedMeta = (cid: Json): Obj => {
    // A side that removed the calendar changes nothing about its name or colour.
    const mb = bc.has(cid) ? meta(bc.get(cid)!) : {};
    const ml = lc.has(cid) ? meta(lc.get(cid)!) : mb;
    const mm = mc.has(cid) ? meta(mc.get(cid)!) : mb;
    return mergeFields(mb, ml, mm);
  };

  const order = uniq([...mc.keys(), ...lc.keys()]);
  const kept = new Map<Json, Obj>();
  for (const cid of order) if (pick(bc.has(cid), lc.has(cid), mc.has(cid), Object.is)) kept.set(cid, mergedMeta(cid));
  const placed = new Map<Json, Json[]>(order.map((cid) => [cid, []]));

  const place = (cid: Json, event: Json, changed: boolean) => {
    // An event added or changed in a calendar the other side removed brings the calendar back.
    if (!kept.has(cid)) {
      if (!changed || !placed.has(cid)) return;
      kept.set(cid, mergedMeta(cid));
    }
    placed.get(cid)!.push(event);
  };

  const where = (cals: Map<Json, Obj>) => {
    const found = new Map<Json, Placed[]>();
    for (const [cid, c] of cals) {
      for (const e of list(c.events)) {
        if (!isObj(e) || !("uid" in e)) continue;
        const k = keyOf(e.uid as Json);
        if (!found.has(k)) found.set(k, []);
        found.get(k)!.push([cid, e]);
      }
    }
    return found;
  };
  const [bw, lw, mw] = three([bc, lc, mc], where);
  const single = (uid: Json) => [bw, lw, mw].every((w) => (w.get(uid)?.length ?? 0) <= 1);
  const uids = uniq(
    [mc, lc].flatMap((cals) =>
      [...cals.values()].flatMap((c) => list(c.events).filter((e) => isObj(e) && "uid" in e).map((e) => keyOf((e as Obj).uid as Json))),
    ),
  );
  for (const uid of uids) {
    if (single(uid)) {
      const [b, l, m] = three([bw, lw, mw], (w): Maybe<Placed> => w.get(uid)?.[0] ?? GONE);
      if (l === GONE || m === GONE) {
        const r = pick(b, l, m, samePlaced);
        if (r !== GONE) place(r[0], r[1], !eq(r, b, samePlaced));
        continue;
      }
      const [bh, be]: [Maybe<Json>, Obj] = b === GONE ? [GONE, {}] : b;
      const home = pick(bh, l[0], m[0], same) as Json;
      const event = mergeFields(be, l[1], m[1]);
      place(home, event, b === GONE || !samePlaced([home, event], b));
    } else {
      // In several calendars somewhere (an .ics imported twice, or one uid twice in a calendar): each calendar's
      // copies pair up in order and merge field by field.
      for (const cid of order) {
        const [bl, ll, ml] = three([bw, lw, mw], (w) => (w.get(uid) ?? []).filter(([c2]) => same(c2, cid)).map(([, e]) => e));
        for (let n = 0; n < Math.max(ll.length, ml.length); n++) {
          const [be, le, me] = three([bl, ll, ml], (x): Maybe<Obj> => x[n] ?? GONE);
          const e = le !== GONE && me !== GONE ? mergeFields(be === GONE ? {} : be, le, me) : pick(be, le, me, same);
          if (e !== GONE) place(cid, e, !eq(e, be, same));
        }
      }
    }
  }
  // Events without a uid (none of Kalendarix's own) are told apart only by their content: each distinct one is kept
  // as many times as the three-way pick of its counts says.
  const plain = (cals: Map<Json, Obj>, cid: Json) => list(cals.get(cid)?.events).filter((e) => !(isObj(e) && "uid" in e));
  for (const cid of order) {
    const [bl, ll, ml] = three([bc, lc, mc], (cals) => plain(cals, cid).map(blob));
    const count = (xs: string[], x: string) => xs.filter((y) => y === x).length;
    for (const x of uniq([...ml, ...ll])) {
      const e = JSON.parse(x) as Json;
      const times = pick(count(bl, x), count(ll, x), count(ml, x), Object.is) as number;
      for (let i = 0; i < times; i++) place(cid, e, times !== count(bl, x));
    }
  }
  // Each calendar keeps the order the computer's file had (then Weft's), whatever order events were merged in; the
  // n-th copy of a uid (or of a uid-less event) takes the n-th place of its kind.
  const rankKey = (e: Json, seen: Map<string, number>) => {
    const k = isObj(e) && "uid" in e ? "u" + blob(e.uid as Json) : "b" + blob(e);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return `${n}:${k}`;
  };
  for (const [cid, events] of placed) {
    const pos = new Map<string, number>();
    for (const cals of [lc, mc]) {
      const seen = new Map<string, number>();
      for (const e of list(cals.get(cid)?.events)) {
        const k = rankKey(e, seen);
        if (!pos.has(k)) pos.set(k, pos.size);
      }
    }
    const seen = new Map<string, number>();
    const keyed = events.map((e, i) => [pos.get(rankKey(e, seen)) ?? pos.size + i, e] as const);
    placed.set(cid, keyed.sort((x, y) => x[0] - y[0]).map(([, e]) => e));
  }
  out.calendars = order.filter((cid) => kept.has(cid)).map((cid) => ({ ...kept.get(cid)!, events: placed.get(cid)! }));
  return out;
}

/**
 * `local` with master's EduPage timetable lessons: asus mirrors the backend all the time, while a computer that
 * slept brings an old copy, and its stale lessons must not win the merge (nor have their uids, which are only a
 * day's row numbers, paired up field by field with other lessons).
 */
function timetableFrom(local: Obj, master: Obj): Obj {
  const mt = list(master.calendars).find((c): c is Obj => isObj(c) && c.id === TIMETABLE_CAL);
  if (mt === undefined || !Array.isArray(local.calendars)) return local;
  if (!local.calendars.some((c) => isObj(c) && c.id === TIMETABLE_CAL)) {
    // Removed on the computer (or never there): the service puts it back anyway, so keep it, history included.
    return { ...local, calendars: [...local.calendars, mt] };
  }
  const ours = list(mt.events).filter(timetableOwned);
  const calendars = local.calendars.map((c) =>
    isObj(c) && c.id === TIMETABLE_CAL ? { ...c, events: [...list(c.events).filter((e) => !timetableOwned(e)), ...ours] } : c,
  );
  return { ...local, calendars };
}

const text = (v: Json | undefined): string =>
  v === undefined ? "" : typeof v === "string" ? v : v === null ? "None" : typeof v === "boolean" ? (v ? "True" : "False") : JSON.stringify(v);

/** An event another program syncs (uid ending in @name of a calendar named name-…): Weft does not change it. */
function managed(event: Obj, calId: Json): boolean {
  if (event.remote === true) return true;
  const uid = text(event.uid);
  const at = uid.lastIndexOf("@");
  return at >= 0 && at < uid.length - 1 && text(calId).startsWith(uid.slice(at + 1) + "-");
}

/** A Python-style quoted value for error messages, as the clients have always shown them. */
const repr = (v: Json | undefined) => (typeof v === "string" ? `'${v}'` : text(v));

export class OpError extends Error {}

/** A calendars.json with nothing in it yet, in Kalendarix's current schema: Weft needs no Kalendarix to start one. */
export const empty = (): Obj => ({ schema: 2, calendars: [] });

const TESTS_NAME = "testy"; // the EduPage bridge finds the calendar it writes tests into by this name (TESTS_CALENDAR)

/** Why a calendar may not be removed, or null: a program fills it and would fail or bring it back. */
function undeletable(cal: Obj): string | null {
  if (cal.id === TIMETABLE_CAL || cal.sourceUrl || list(cal.events).some((e) => isObj(e) && managed(e, cal.id as Json))) return "this calendar belongs to a sync program";
  if (text((cal.name || "") as Json).trim().toLowerCase() === TESTS_NAME) return "the EduPage bridge writes tests into this calendar";
  return null;
}

/** Weft's edits into the doc (changed in place). Throws OpError on the first bad op, before anything is saved.
 * addcal of an id that is there and delcal of one that is not change nothing, so a batch sent again does no harm. */
export function applyOps(doc: Obj, ops: Json): Obj {
  if (!Array.isArray(ops)) throw new OpError("ops must be a list");
  const cals = byKey(doc.calendars, "id");
  for (const op of ops) {
    if (!isObj(op)) throw new OpError("an op must be an object");
    if (op.op === "addcal") {
      const { cal: id, name, color } = op;
      if (typeof id !== "string" || !id) throw new OpError("a calendar needs an id");
      if (typeof name !== "string" || !name.trim()) throw new OpError("a calendar needs a name");
      if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) throw new OpError("color must be #rrggbb");
      if (cals.has(id)) continue;
      const tests = (n: Json | undefined) => text((n || "") as Json).trim().toLowerCase() === TESTS_NAME;
      if (tests(name) && [...cals.values()].some((c) => tests(c.name))) throw new OpError("there is a Testy calendar already: the EduPage bridge writes into one");
      // Kalendarix's fields for a calendar of one's own; the colour it shows is customColor.
      const fresh: Obj = { id, name: name.trim(), color, customColor: color, visible: true, events: [] };
      if (!Array.isArray(doc.calendars)) doc.calendars = [];
      doc.calendars.push(fresh);
      cals.set(id, fresh);
      continue;
    }
    if (op.op === "delcal") {
      const cal = cals.get(keyOf(op.cal ?? null));
      if (cal === undefined) continue;
      const why = undeletable(cal);
      if (why) throw new OpError(why);
      doc.calendars = list(doc.calendars).filter((c) => c !== cal);
      cals.delete(keyOf(cal.id as Json));
      continue;
    }
    const cal = cals.get(keyOf(op.cal ?? null));
    if (cal === undefined) throw new OpError(`no calendar ${repr(op.cal ?? null)}`);
    if (!Array.isArray(cal.events)) cal.events = [];
    const events = cal.events;
    const fromEvent = isObj(op.event) ? op.event.uid : undefined;
    const uid = op.uid || fromEvent;
    if (typeof uid !== "string" || !uid) throw new OpError("an event needs a uid");
    const i = events.findIndex((e) => isObj(e) && e.uid === uid);
    const old = i >= 0 ? (events[i] as Obj) : undefined;
    if ((old && Object.keys(old).length && managed(old, cal.id as Json)) || managed({ uid }, cal.id as Json)) {
      throw new OpError("this event belongs to a sync program");
    }
    if (op.op === "del") {
      cal.events = events.filter((e) => !(isObj(e) && e.uid === uid));
    } else if (op.op === "put") {
      const event = op.event;
      if (!isObj(event)) throw new OpError("'event'");
      for (const k of ["title", "start", "end"]) {
        if (typeof event[k] !== "string") throw new OpError(`event.${k} must be text`);
      }
      // Fields Weft does not send (repetition, Kalendarix's colours, another program's) stay as they were.
      const fresh: Obj = { description: "", notes: "", location: "", allDay: false, rrule: null, exdates: [], alarmMinutes: "" };
      const next = { ...(old ?? fresh), ...event };
      if (old) events[i] = next;
      else events.push(next);
    } else {
      throw new OpError(`unknown op ${repr(op.op ?? null)}`);
    }
  }
  return doc;
}

// ------------------------------------------------------------------ the EduPage timetable

// Kalendarix EduPage's backend reads EduPage's daily plan, so a substitution, a cancelled or moved lesson and a school
// event are in its events within minutes. They go into the calendar its x270 client writes too, with the same id,
// uids and fields, so both copies hold the same thing; asus runs all the time, so for these events its copy is the one
// a merge keeps (see merge).

export type Lesson = {
  uid: string;
  title: string;
  description: string;
  location: string;
  start: string;
  end: string;
  all_day: boolean;
  color?: string | null;
};

export const timetableOwned = (e: Json): boolean => isObj(e) && typeof e.uid === "string" && e.uid.endsWith(TIMETABLE_OURS);

/** Kalendarix stores Date.toISOString(): UTC, whole seconds, ".000Z". A time without an offset, and a bare date
 * (its midnight), are local time, as they always were. */
export function utcMs(iso: string): string {
  const t = new Date(/^\d{4}-\d\d-\d\d$/.test(iso) ? `${iso}T00:00:00` : iso);
  if (!/^\d{4}-\d\d-\d\d/.test(iso) || Number.isNaN(t.getTime())) throw new Error(`not a time: ${iso}`);
  return t.toISOString().slice(0, 19) + ".000Z";
}

/** One backend event the way Kalendarix EduPage's own sync writes it into calendars.json. */
export function timetableEvent(e: Lesson): Obj {
  const out: Obj = {
    uid: e.uid, title: e.title, description: e.description, notes: e.description, location: e.location,
    start: utcMs(e.start), end: utcMs(e.end), allDay: e.all_day, rrule: null, exdates: [], alarmMinutes: "",
  };
  if (e.color) out.color = e.color;
  return out;
}

/**
 * The backend's events in place of the timetable calendar's earlier ones; true when anything changed. Events added
 * to that calendar by hand stay, as do its name, colour and visibility, and lessons of past days the backend no longer
 * has (uid "<date>-<n>@lifeos"; it serves 30 days back). `today` is YYYY-MM-DD in Bratislava.
 */
export function putTimetable(doc: Obj, events: Lesson[], today: string): boolean {
  if (!Array.isArray(doc.calendars)) doc.calendars = [];
  const cals = doc.calendars;
  let cal = cals.find((c): c is Obj => isObj(c) && c.id === TIMETABLE_CAL);
  if (cal === undefined) {
    cal = { id: TIMETABLE_CAL, name: "EduPage rozvrh", color: "#a6e3a1", visible: true, colorSlot: 1, customColor: "#a6e3a1", events: [] };
    cals.push(cal);
  }
  const current = list(cal.events);
  // Days the backend sent, and today and later, are replaced whole. A past day it sent nothing for stays: it never
  // reads past days again, so such a day is one its store does not have (too old, or it was off), not an empty one.
  const sent = new Set(events.map((e) => e.uid.slice(0, 10)));
  const day = (e: Json) => text((e as Obj).uid).slice(0, 10);
  const stays = (e: Json) => timetableOwned(e) && day(e) < today && !sent.has(day(e));
  // Always in this order (hand-made, kept lessons, the backend's), the order timetableFrom gives a merge too.
  const updated = [...current.filter((e) => !timetableOwned(e)), ...current.filter(stays), ...events.map(timetableEvent)];
  if (same(updated, current) && "events" in cal) return false;
  cal.events = updated;
  return true;
}

/** The backend's answer checked field by field before anything is written. */
export function readLessons(body: unknown): { events: Lesson[]; fresh: string | null } {
  if (!isObj(body as Json) || !Array.isArray((body as Obj).events)) throw new Error("not an events answer");
  const { events, last_success_at: fresh = null } = body as Obj;
  for (const e of events as Json[]) {
    const ok = isObj(e)
      && ["uid", "title", "description", "location", "start", "end"].every((k) => typeof e[k] === "string")
      && (e.uid as string).endsWith(TIMETABLE_OURS)
      && typeof e.all_day === "boolean"
      && (e.color === undefined || e.color === null || typeof e.color === "string");
    if (!ok) throw new Error("an event is not what the backend sends");
    timetableEvent(e as Lesson);
  }
  if (fresh !== null && !(typeof fresh === "string" && fresh)) throw new Error("last_success_at is not a time");
  return { events: events as Lesson[], fresh: fresh as string | null };
}

/** Today's date in Bratislava, YYYY-MM-DD. */
export const bratislavaToday = (now = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Bratislava" }).format(now);

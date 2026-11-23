export { textOn, ACCENT_PALETTE, isHex as isHexColor, titleKey } from './kalendarix-colors.js';
import { T } from './i18n.js';
import { autoAccents, eventAccent, isHex, titleKey } from './kalendarix-colors.js';

// Calendar core for Weft: the same calendars.json Kalendarix keeps (docs/calendars-json.md in
// github.com/Gooder24/kalendarix) and the same reading of it, so an event shows on the same days in
// both. Ported from Kalendarix 2 src/core (dates, recurrence, instances); no DOM here, app.js draws.

export const MS_MINUTE = 60e3;
export const MS_HOUR = 36e5;
export const MS_DAY = 864e5;

export const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const addMonths = (d, n) => { const x = new Date(d); const day = x.getDate(); x.setDate(1); x.setMonth(x.getMonth() + n); x.setDate(Math.min(day, daysInMonth(x.getFullYear(), x.getMonth()))); return x; };
export const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
export const startOfMonth = (d) => { const x = new Date(d); return new Date(x.getFullYear(), x.getMonth(), 1); };
/** Weeks start on Monday. */
export const startOfWeek = (d) => { const x = startOfDay(d); return addDays(x, -((x.getDay() + 6) % 7)); };
/** Local calendar day as a whole number: equal for any two instants on the same local day. */
export const dayNumber = (d) => { const x = new Date(d); return Math.round(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) / MS_DAY); };

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const MAX_STEPS = 20000;

export const allDayLength = (start, end) => Math.max(1, dayNumber(end > start ? end - 1 : start) - dayNumber(start) + 1);

/** UNTIL as iCalendar writes it; a bare date means the whole of that day. */
export function parseUntil(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(value));
  if (!m) { const t = Date.parse(value); return Number.isNaN(t) ? null : t; }
  const [y, mo, d] = [+m[1], +m[2] - 1, +m[3]];
  if (m[4] === undefined) return new Date(y, mo, d, 23, 59, 59, 999).getTime();
  const parts = [y, mo, d, +m[4], +m[5], +m[6]];
  return m[7] ? Date.UTC(...parts) : new Date(...parts).getTime();
}

/** Occurrences of an event that overlap [from, to), in order: [{ start, end }] in ms, end exclusive. */
export function occurrences(event, from, to) {
  const first = Date.parse(event.start);
  if (Number.isNaN(first)) return [];
  const lastRaw = Date.parse(event.end);
  const length = Number.isNaN(lastRaw) ? 0 : Math.max(0, lastRaw - first);
  // A whole-day event covers the days it touches, whatever hours the file holds.
  const days = event.allDay ? allDayLength(first, first + length) : 0;
  const endOf = (start) => (days ? addDays(startOfDay(start), days).getTime() : start.getTime() + length);
  const overlaps = (s, e) => (e > s ? s < to && e > from : s >= from && s < to);
  const rule = event.rrule;
  if (!rule || !rule.FREQ) {
    const end = endOf(new Date(first));
    return overlaps(first, end) ? [{ start: first, end }] : [];
  }
  const out = [];
  const start = new Date(first);
  const until = rule.UNTIL ? parseUntil(rule.UNTIL) : null;
  const count = rule.COUNT > 0 ? rule.COUNT : Infinity;
  const skipped = new Set((event.exdates || []).map((d) => dayNumber(Date.parse(d))));
  let produced = 0;
  const emit = (candidate) => {
    const s = candidate.getTime();
    if (produced >= count || (until !== null && s > until) || s >= to) return false;
    produced++;
    if (!skipped.has(dayNumber(s))) {
      const e = endOf(candidate);
      if (overlaps(s, e)) out.push({ start: s, end: e });
    }
    return true;
  };
  let step = 0;
  for (const period of periods(rule, start, firstUsefulPeriod(rule, first, endOf(start) - first, from))) {
    if (++step > MAX_STEPS) break;
    let alive = true;
    for (const candidate of candidatesIn(rule, start, period)) {
      if (candidate.getTime() < first) continue;
      if (!emit(candidate)) { alive = false; break; }
    }
    if (!alive) break;
  }
  return out;
}

const intervalOf = (rule) => (rule.INTERVAL > 0 ? Math.floor(rule.INTERVAL) : 1);

function firstUsefulPeriod(rule, first, length, from) {
  const gap = from - length - first;
  if (rule.COUNT || gap <= 0) return 0;
  const longest = { DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 }[rule.FREQ] * MS_DAY * intervalOf(rule);
  return Math.max(0, Math.floor(gap / longest) - 2);
}

function* periods(rule, start, firstIndex) {
  const interval = intervalOf(rule);
  const wall = [start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()];
  const [y, m, d] = [start.getFullYear(), start.getMonth(), start.getDate()];
  for (let n = firstIndex; ; n++) {
    if (rule.FREQ === 'DAILY') yield new Date(y, m, d + n * interval, ...wall);
    else if (rule.FREQ === 'WEEKLY') yield new Date(y, m, d + n * interval * 7, ...wall);
    else if (rule.FREQ === 'MONTHLY') yield new Date(y, m + n * interval, 1, ...wall);
    else if (rule.FREQ === 'YEARLY') yield new Date(y + n * interval, m, 1, ...wall);
    else return;
  }
}

function numbers(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : value == null ? [] : [value];
  return list.map((v) => Number.parseInt(String(v), 10)).filter((n) => Number.isFinite(n));
}
function weekdayTokens(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return list.map((v) => String(v).trim().toUpperCase()).filter(Boolean);
}
const weekdayOf = (token) => WEEKDAYS.indexOf(token.slice(-2));

function candidatesIn(rule, start, period) {
  const at = (y, m, d) => new Date(y, m, d, start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds());
  const y = period.getFullYear();
  const m = period.getMonth();
  const byDay = weekdayTokens(rule.BYDAY);
  switch (rule.FREQ) {
    case 'DAILY': {
      const allowed = byDay.map(weekdayOf).filter((i) => i >= 0);
      return !allowed.length || allowed.includes((period.getDay() + 6) % 7) ? [period] : [];
    }
    case 'WEEKLY': {
      if (!byDay.length) return [period];
      const monday = startOfWeek(period);
      return [...new Set(byDay.map(weekdayOf).filter((i) => i >= 0))].sort((a, b) => a - b)
        .map((i) => at(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
    }
    case 'MONTHLY':
      return nth(rule, daysOfMonth(rule, start, y, m, byDay).map((d) => at(y, m, d)));
    case 'YEARLY': {
      const months = numbers(rule.BYMONTH).map((n) => n - 1).filter((n) => n >= 0 && n < 12);
      return nth(rule, (months.length ? [...new Set(months)].sort((a, b) => a - b) : [start.getMonth()])
        .flatMap((month) => daysOfMonth(rule, start, y, month, byDay).map((d) => at(y, month, d))));
    }
    default:
      return [period];
  }
}

function daysOfMonth(rule, start, year, month, byDay) {
  const size = daysInMonth(year, month);
  const monthDays = numbers(rule.BYMONTHDAY).map((n) => (n < 0 ? size + 1 + n : n));
  let dates;
  if (byDay.length) {
    dates = byDay.flatMap((token) => weekdaysOfMonth(year, month, token));
    if (monthDays.length) dates = dates.filter((d) => monthDays.includes(d));
  } else {
    dates = monthDays.length ? monthDays : [start.getDate()];
  }
  return [...new Set(dates)].filter((d) => d >= 1 && d <= size).sort((a, b) => a - b);
}

function nth(rule, days) {
  const positions = numbers(rule.BYSETPOS);
  if (!positions.length) return days;
  const picked = positions.map((p) => (p > 0 ? days[p - 1] : days[days.length + p])).filter(Boolean);
  return [...new Set(picked)].sort((a, b) => a - b);
}

function weekdaysOfMonth(year, month, token) {
  const m = /^(-?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(token);
  if (!m) return [];
  const weekday = WEEKDAYS.indexOf(m[2]);
  const all = [];
  for (let d = 1; d <= daysInMonth(year, month); d++) if ((new Date(year, month, d).getDay() + 6) % 7 === weekday) all.push(d);
  if (!m[1]) return all;
  const picked = +m[1] > 0 ? all[+m[1] - 1] : all[all.length + +m[1]];
  return picked === undefined ? [] : [picked];
}

// ------------------------------------------------------------------ calendars and colours

/** The categories that come with Kalendarix (src/core/categories.ts). */
export const CATEGORIES = [
  { id: 'school', name: T('Školské predmety'), color: '#4fae6b', match: /predmet|rozvrh|vyuc|subject|timetable|lesson/ },
  { id: 'school-events', name: T('Školské akcie'), color: '#b9e6a2', match: /skolsk\w* akc|skola akc|school event/ },
  { id: 'tests', name: T('Testy'), color: '#e5584f', match: /test|pisomk|skusk|exam|quiz/ },
  { id: 'trips', name: 'Trips', color: '#f0913a', match: /trip|vylet|cest|travel|dovolenk/ },
  { id: 'holidays', name: T('Prázdniny'), color: '#f2d14e', match: /prazd|holiday|vacation|volno/ },
  { id: 'family', name: T('Rodinné'), color: '#9fd0f5', match: /rodin|family/ },
];
/** Colours for a calendar of its own colour, and for a category of Karchi's own (none taken by one that comes with Kalendarix). */
export const CALENDAR_PALETTE = ['#628790', '#d98cb3', '#7fb8a4', '#c9a26b', '#8fa3d9', '#c98f7a', '#9ab86a', '#b79ad6'];
export const CATEGORY_PALETTE = ['#a374e0', '#2f55b0', '#a8713f', '#6e4526', '#e06c9f', '#3aa6b9', '#7d8a2e', '#8d99ae'];

/** Category id -> colour, the file's own over the ones that come with Kalendarix. */
export function categoryColors(doc) {
  const out = new Map(CATEGORIES.map((c) => [c.id, c.color]));
  for (const c of doc.categories || []) if (c?.id && /^#[0-9a-f]{6}$/i.test(c.color)) out.set(c.id, c.color);
  for (const c of doc.calendars || []) if (c.category && !out.has(c.category)) { const color = [c.customColor, c.color].find(isHex); if (color) out.set(c.category, color); }
  return out;
}
export const calendarColor = (cal, cats) => (cal.category && cats.get(cal.category)) || [cal.customColor, cal.color].find(isHex) || '#628790';

/** Written by a sync program (its uid ends in @name and the calendar id starts with name-) or a feed: shown, not edited. */
export function isManaged(event, calendarId) {
  if (event.remote === true) return true;
  const at = event.uid.lastIndexOf('@');
  return at >= 0 && at < event.uid.length - 1 && calendarId.startsWith(`${event.uid.slice(at + 1)}-`);
}
export const isSynced = (cal) => !!cal.sourceUrl || cal.events.some((e) => isManaged(e, cal.id));

/** Every category an event or a calendar can take: the ones that come with Kalendarix, then the file's own (`own`, which
 *  Settings renames, recolours and removes). A calendar naming a category nobody defines is itself that category, with
 *  its name and colour, as Kalendarix reads it (categoriesOf). */
export function categoryList(doc) {
  const out = new Map(CATEGORIES.map((c) => [c.id, c]));
  for (const c of doc.categories || []) if (c?.id && isHex(c.color)) out.set(c.id, { id: c.id, name: String(c.name || '').trim() || c.id, color: c.color.toLowerCase(), own: true });
  for (const c of doc.calendars || []) {
    if (typeof c.category !== 'string' || !c.category || out.has(c.category)) continue;
    const color = [c.customColor, c.color].find(isHex);
    if (color) out.set(c.category, { id: c.category, name: String(c.name || '').trim() || c.category, color: color.toLowerCase(), own: true });
  }
  return [...out.values()];
}

const plainName = (text) => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** An id for a new category of this name that no other has: "Krúžok" → "kruzok". */
export function categoryId(name, list) {
  const stem = plainName(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'category';
  let id = stem;
  for (let n = 2; list.some((c) => c.id === id); n++) id = `${stem}-${n}`;
  return id;
}
/** The category a calendar of this name most likely is, or null (an imported file's calendar gets it, as in Kalendarix). */
export function guessCategory(name, list) {
  const plain = plainName(name);
  if (!plain) return null;
  const squeezed = plain.replace(/(.)\1+/g, '$1');
  const named = list.find((c) => c.own && plainName(c.name) === plain);
  if (named) return named;
  // School events before school subjects: both are "školské".
  for (const c of [...list.filter((x) => x.id === 'school-events'), ...list.filter((x) => x.id !== 'school-events')]) if (c.match && (c.match.test(plain) || c.match.test(squeezed))) return c;
  return null;
}

/** Every occurrence overlapping [from, to) of the shown calendars (by default the ones the file has visible), earliest first. */
export function expand(doc, from, to, shown = (cal) => cal.visible !== false) {
  const cats = categoryColors(doc);
  const out = [];
  for (const cal of doc.calendars || []) {
    if (!shown(cal)) continue;
    const calColor = calendarColor(cal, cats);
    // Legacy timetable files predate autoAccent; Kalendarix's upgraded school view supplies it.
    const auto = (cal.autoAccent ?? cal.category === 'school') ? autoAccents(cal, calColor) : null;
    for (const event of cal.events || []) {
      const color = (event.category && cats.get(event.category)) || calColor;
      const accent = eventAccent(cal, event, auto);
      const managed = isManaged(event, cal.id);
      for (const { start, end } of occurrences(event, from, to)) {
        out.push({ key: `${cal.id}|${event.uid}|${start}`, cal, event, start, end, allDay: !!event.allDay, recurring: !!event.rrule?.FREQ,
          firstDay: dayNumber(start), lastDay: dayNumber(end > start ? end - 1 : start), color, accent: accent && accent !== color.toLowerCase() ? accent : null, calendarColor: calColor, managed });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end || a.event.title.localeCompare(b.event.title));
}

/** Drawn in the strip above the hours: whole-day, or a day long or more. */
export const isBar = (i) => i.allDay || i.end - i.start >= MS_DAY;

/** Side-by-side columns for the timed events of one day: each gets { col, cols }. */
export function columns(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let group = [];
  let groupEnd = -Infinity;
  const close = () => {
    const ends = [];
    for (const it of group) {
      let col = ends.findIndex((e) => e <= it.start);
      if (col < 0) col = ends.length;
      ends[col] = Math.max(it.end, it.start + 15 * MS_MINUTE);
      out.push({ ...it, col });
    }
    for (const it of out.slice(out.length - group.length)) it.cols = ends.length;
    group = [];
  };
  for (const it of sorted) {
    if (it.start >= groupEnd && group.length) close();
    group.push(it);
    groupEnd = Math.max(groupEnd, it.end, it.start + 15 * MS_MINUTE);
  }
  if (group.length) close();
  return out;
}

/** A new event id in Kalendarix's form. */
export const newUid = () => `kx-${Date.now()}-0-${Math.random().toString(36).slice(2, 7)}`;

// ------------------------------------------------------------------ changing a series (Kalendarix src/core/document.ts)

export const minuteOfDay = (d) => { const x = new Date(d); return x.getHours() * 60 + x.getMinutes(); };

/** An instant moved by whole days, keeping its time of day across a clock change. */
export function shiftDays(iso, days) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || !days) return iso;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).toISOString();
}

/**
 * A rule after its event moved from one day to another: a weekly rule's weekdays move along; a monthly or yearly
 * rule that named its day described where the event used to be and now simply follows the new start.
 */
export function shiftRule(rule, from, to) {
  const days = dayNumber(to) - dayNumber(from);
  if (!rule || !days) return rule;
  const next = { ...rule };
  if (rule.FREQ === 'WEEKLY') {
    const moved = weekdayTokens(rule.BYDAY).map(weekdayOf).filter((i) => i >= 0).map((i) => (((i + days) % 7) + 7) % 7);
    if (moved.length) next.BYDAY = [...new Set(moved)].sort((a, b) => a - b).map((i) => WEEKDAYS[i]);
  } else if (rule.FREQ === 'MONTHLY' || rule.FREQ === 'YEARLY') {
    // "The 3rd Wednesday" / "the last Friday" (Weft's editor writes these) stays that kind of day at the new date.
    const one = weekdayTokens(rule.BYDAY);
    const m = rule.FREQ === 'MONTHLY' && one.length === 1 && rule.BYMONTHDAY == null && rule.BYSETPOS == null && /^(-?\d)(MO|TU|WE|TH|FR|SA|SU)$/.exec(one[0]);
    delete next.BYDAY; delete next.BYMONTHDAY; delete next.BYSETPOS; delete next.BYMONTH;
    if (m) {
      const d = new Date(to);
      const wd = WEEKDAYS[(d.getDay() + 6) % 7];
      const last = d.getDate() + 7 > daysInMonth(d.getFullYear(), d.getMonth());
      // A 5th weekday exists only in some months: on the last week it is "the last", so no month is skipped.
      next.BYDAY = [(m[1] === '-1' || d.getDate() > 28) && last ? `-1${wd}` : `${Math.ceil(d.getDate() / 7)}${wd}`];
    }
  }
  if (rule.UNTIL) next.UNTIL = shiftUntil(rule.UNTIL, days);
  return next;
}

/** UNTIL moved by whole local days with its series, written the way it was (date, local or UTC time). */
function shiftUntil(value, days) {
  const at = parseUntil(value);
  if (at === null || !days) return value;
  const d = new Date(at);
  const moved = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes(), d.getSeconds());
  const p = (n) => String(n).padStart(2, '0');
  const s = String(value);
  if (/^\d{8}$/.test(s)) return `${moved.getFullYear()}${p(moved.getMonth() + 1)}${p(moved.getDate())}`;
  if (/Z$/.test(s)) return moved.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${moved.getFullYear()}${p(moved.getMonth() + 1)}${p(moved.getDate())}T${p(moved.getHours())}${p(moved.getMinutes())}${p(moved.getSeconds())}`;
}

/**
 * The event moved so that its occurrence that began at `from` begins at `to`, by days and by the clock (a daily
 * 08:00 stays 08:00 across a clock change). A series moves whole: its skipped days and weekly weekdays follow.
 */
export function moved(event, from, to) {
  const start = new Date(event.start);
  if (Number.isNaN(start.getTime())) return event;
  const endRaw = new Date(event.end);
  const end = Number.isNaN(endRaw.getTime()) ? start : endRaw;
  const days = dayNumber(to) - dayNumber(from);
  const minutes = event.allDay ? 0 : minuteOfDay(to) - minuteOfDay(from);
  if (!days && !minutes) return event;
  const shifted = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes() + minutes, d.getSeconds(), d.getMilliseconds());
  // The rule is read at the occurrence that was moved: dropped on a 3rd Thursday, the series is "the 3rd Thursday".
  const rrule = shiftRule(event.rrule, from, to);
  let newStart = shifted(start);
  if (days) newStart = anchorStart(rrule, newStart, newStart) || newStart;
  const newEnd = event.allDay ? new Date(newStart.getFullYear(), newStart.getMonth(), newStart.getDate() + dayNumber(end) - dayNumber(start), end.getHours(), end.getMinutes())
    : new Date(newStart.getTime() + (end.getTime() - start.getTime()));
  const next = { ...event, start: newStart.toISOString(), end: newEnd.toISOString(), rrule };
  return { ...next, exdates: movedExdates(event, next, days) };
}

/** Skipped days follow their occurrence: the 3rd one skipped stays the 3rd, also when the series changed its kind of day. */
function movedExdates(before, after, days) {
  const list = before.exdates || [];
  if (!list.length || !days) return list;
  const all = (e, to) => occurrences({ ...e, exdates: [] }, -Infinity, to).map((o) => o.start);
  const last = Math.max(...list.map((d) => Date.parse(d)).filter((t) => !Number.isNaN(t)));
  const old = all(before, last + MS_DAY);
  const fresh = all(after, last + (Math.abs(days) + 400) * MS_DAY);
  return list.map((d) => {
    const i = old.findIndex((t) => dayNumber(t) === dayNumber(Date.parse(d)));
    return i >= 0 && fresh[i] !== undefined ? new Date(fresh[i]).toISOString() : shiftDays(d, days);
  });
}

/**
 * A monthly "nth weekday" series must start on such a day, or its first month is lost: the first fitting day from the
 * month of `month` (the moved start's) on, at the time of day of `clock`. Null for any other rule.
 */
export function anchorStart(rule, month, clock) {
  const one = weekdayTokens(rule?.BYDAY);
  if (rule?.FREQ !== 'MONTHLY' || one.length !== 1 || rule.BYMONTHDAY != null || rule.BYSETPOS != null || !/^-?\d/.test(one[0])) return null;
  const m = new Date(month);
  const c = new Date(clock);
  for (let k = 0; k < 24; k++) {
    const y = m.getFullYear(), mo = m.getMonth() + k;
    const [day] = weekdaysOfMonth(new Date(y, mo, 1).getFullYear(), new Date(y, mo, 1).getMonth(), one[0]);
    if (day !== undefined) return new Date(y, mo, day, c.getHours(), c.getMinutes(), c.getSeconds(), c.getMilliseconds());
  }
  return null;
}

/** UNTIL for "to the end of this local day", in UTC as iCalendar wants it. */
export const untilOf = (day) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** How many occurrences of the series start before `at`, skipped days included (they count toward COUNT). */
export const countBefore = (event, at) => occurrences({ ...event, exdates: [] }, -Infinity, at).filter((o) => o.start < at).length;

/**
 * A series cut so that it ends before `at` (the occurrence there and after are left out): UNTIL just before it,
 * in place of COUNT. Null when nothing would be left.
 */
export function endBefore(event, at) {
  if (!countBefore(event, at)) return null;
  const rule = { ...event.rrule };
  delete rule.COUNT;
  rule.UNTIL = new Date(at - 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return { ...event, rrule: rule, exdates: (event.exdates || []).filter((d) => Date.parse(d) < at) };
}

/** What EduPage changed about a lesson of the timetable calendar, read from Kalendarix EduPage's title ("Odpadlo: X",
 *  "Suplovanie: X", "Zmena: X") and description ("Učiteľ: Y (namiesto: Z)", "Učebňa: …"); null for an ordinary lesson. */
export function lessonChange(event) {
  const m = /^\s*(Odpadlo|Suplovanie|Zmena)\s*:/i.exec(event?.title || '');
  if (!m) return null;
  const teacher = /^Učiteľ: (.+?) \(namiesto: (.+)\)\s*$/m.exec(event.description || '');
  const room = /^Učebňa: (.+?) \(namiesto: (.+)\)\s*$/m.exec(event.description || '');
  return { kind: { odpadlo: 'cancelled', suplovanie: 'substitution', zmena: 'changed' }[m[1].toLowerCase()],
    who: teacher?.[1] || '', instead: teacher?.[2] || '', room: room?.[1] || '', roomBefore: room?.[2] || '' };
}

/** The colour each subject of a timetable calendar wears in the calendar (its accent, else the calendar's), by
 *  titleKey of the lesson's name: grades and school notices take the same colour as their lessons. */
export function subjectColors(doc, calendarId) {
  const out = new Map();
  const cal = (doc?.calendars || []).find((c) => c.id === calendarId);
  if (!cal) return out;
  const calColor = calendarColor(cal, categoryColors(doc));
  const auto = (cal.autoAccent ?? cal.category === 'school') ? autoAccents(cal, calColor) : null;
  for (const event of cal.events || []) {
    const key = titleKey(event.title || '');
    if (key && !out.has(key)) out.set(key, eventAccent(cal, event, auto) || calColor);
  }
  return out;
}

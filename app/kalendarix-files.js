// Kalendarix 2's files and texts (MIT, Copyright 2026 esyst): iCalendar in and out, the export to a feature phone,
// the rows read out of an event's notes, and finding events by what is written in them.
// Source: Gooder24/kalendarix src/core/ics.ts, phone.ts, details.ts, search.ts; license in kalendarix-LICENSE.
// No DOM here: app.js asks for files and draws.
import { MS_HOUR, addDays, startOfDay, allDayLength, newUid } from './calendar.js';

const pad2 = (n) => String(n).padStart(2, '0');

/** Lower case, no diacritics, single spaces. */
export const normaliseName = (text) => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ iCalendar: reading

/** Lines of the file with folded continuations (leading space or tab) joined back. */
function unfold(text) {
  const out = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

function parseLine(line) {
  // The value starts at the first colon outside a quoted parameter.
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) { colon = i; break; }
  }
  if (colon === -1) return null;
  const [name, ...rest] = line.slice(0, colon).split(';');
  const params = {};
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq !== -1) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

const unescapeText = (value) => value.replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

/** A wall-clock time in a named zone as an instant: guess, see what the zone's clock shows, correct by the difference. */
function zoned(parts, zone) {
  try {
    const format = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    const wanted = Date.UTC(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]);
    let guess = wanted;
    for (let i = 0; i < 2; i++) {
      const shown = {};
      for (const p of format.formatToParts(guess)) if (p.type !== 'literal') shown[p.type] = +p.value;
      guess += wanted - Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
    }
    return guess;
  } catch {
    return null; // a zone this system does not know
  }
}

function parseDateValue(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : { at: new Date(t), allDay: false };
  }
  const [y, mo, d] = [+m[1], +m[2] - 1, +m[3]];
  if (m[4] === undefined || params.VALUE === 'DATE') return { at: new Date(y, mo, d), allDay: true };
  if (m[7]) return { at: new Date(Date.UTC(y, mo, d, +m[4], +m[5], +m[6])), allDay: false };
  const inZone = params.TZID ? zoned([y, mo, d, +m[4], +m[5], +m[6]], params.TZID) : null;
  return { at: inZone !== null ? new Date(inZone) : new Date(y, mo, d, +m[4], +m[5], +m[6]), allDay: false };
}

export function parseRRule(value) {
  const rule = {};
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).toUpperCase();
    const v = part.slice(eq + 1);
    if (key === 'INTERVAL' || key === 'COUNT') rule[key] = parseInt(v, 10);
    else if (key === 'BYDAY') rule.BYDAY = v.split(',');
    else if (key === 'BYMONTHDAY' || key === 'BYSETPOS' || key === 'BYMONTH') rule[key] = v.split(',').map((x) => parseInt(x, 10));
    else rule[key] = v;
  }
  return typeof rule.FREQ === 'string' ? rule : null;
}

/** DURATION (P5D, PT2H, P1W, P1DT12H) as days and milliseconds; days are calendar days. */
function parseDuration(value) {
  const m = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  return { days: +(m[1] ?? 0) * 7 + +(m[2] ?? 0), ms: (+(m[3] ?? 0) * 60 + +(m[4] ?? 0)) * 60000 + +(m[5] ?? 0) * 1000 };
}

/** The first lines of a real calendar, and its last: not a web page, and not cut short. */
export const isCalendarText = (text) => /^\s*BEGIN:VCALENDAR/i.test(text) && /END:VCALENDAR\s*$/i.test(text);

/** -PT15M, -P1D, -PT2H as minutes before the start. */
function parseTrigger(value) {
  const m = /^-P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?)?$/.exec(value.trim());
  if (!m) return null;
  return (+(m[1] ?? 0) * 7 + +(m[2] ?? 0)) * 1440 + +(m[3] ?? 0) * 60 + +(m[4] ?? 0);
}

/** The end of an event that names none: its DURATION, else a day for a whole-day event and an hour otherwise. */
function endFrom(start, allDay, length) {
  const days = length ? length.days : allDay ? 1 : 0;
  const ms = length ? length.ms : allDay ? 0 : MS_HOUR;
  return new Date(addDays(start, days).getTime() + ms);
}

/** { name: X-WR-CALNAME or null, events } in calendars.json's event layout. */
export function parseIcs(text) {
  const events = [];
  let name = null;
  let current = null;
  let inAlarm = false;
  const overrides = []; // occurrences of a series changed on their own: [uid of the series, the occurrence they stand in for]
  for (const raw of unfold(text)) {
    const line = parseLine(raw);
    if (!line) continue;
    const { name: prop, params, value } = line;
    if (prop === 'BEGIN' && value === 'VEVENT') { current = { exdateAt: [], alarmMinutes: '' }; continue; }
    if (prop === 'END' && value === 'VEVENT') {
      if (current?.startAt) {
        const start = current.startAt;
        const end = current.endAt ?? endFrom(start, !!current.allDay, current.length);
        const notes = current.description ?? '';
        let id = current.uid || newUid();
        if (current.replaces) {
          // A changed occurrence is an event of its own; the series skips the day it stands in for.
          overrides.push([id, current.replaces]);
          id = `${id}#${current.replaces.toISOString()}`;
        }
        events.push({ uid: id, title: current.title ?? '', description: notes, notes, location: current.location ?? '', start: start.toISOString(), end: end.toISOString(),
          allDay: !!current.allDay, rrule: current.rrule ?? null, exdates: current.exdateAt.map((d) => d.toISOString()), alarmMinutes: current.alarmMinutes ?? '' });
      }
      current = null;
      continue;
    }
    if (prop === 'BEGIN' && value === 'VALARM') inAlarm = true;
    if (prop === 'END' && value === 'VALARM') inAlarm = false;
    if (!current) { if (prop === 'X-WR-CALNAME') name = unescapeText(value); continue; }
    if (inAlarm) { const minutes = prop === 'TRIGGER' ? parseTrigger(value) : null; if (minutes !== null) current.alarmMinutes = minutes; continue; }
    if (/base64|^b$/i.test(params.ENCODING ?? '')) continue;
    switch (prop) {
      case 'UID': current.uid = value; break;
      case 'SUMMARY': current.title = unescapeText(value); break;
      case 'DESCRIPTION': current.description = unescapeText(value); break;
      case 'LOCATION': current.location = unescapeText(value); break;
      case 'DTSTART': { const p = parseDateValue(value, params); if (p) { current.startAt = p.at; current.allDay = p.allDay; } break; }
      case 'DTEND': { const p = parseDateValue(value, params); if (p) current.endAt = p.at; break; }
      case 'DURATION': current.length = parseDuration(value) ?? undefined; break;
      case 'RECURRENCE-ID': current.replaces = parseDateValue(value, params)?.at; break;
      case 'RRULE': current.rrule = parseRRule(value); break;
      case 'EXDATE': for (const v of value.split(',')) { const p = parseDateValue(v, params); if (p) current.exdateAt.push(p.at); } break;
      default: break;
    }
  }
  for (const [seriesUid, day] of overrides) {
    const series = events.find((e) => e.uid === seriesUid && e.rrule);
    if (series) series.exdates.push(day.toISOString());
  }
  return { name, events };
}

// ------------------------------------------------------------------ iCalendar: writing

const escapeText = (value) => value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Fold to 75 octets, never inside a character. */
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const decoder = new TextDecoder();
  const chunks = [];
  let from = 0;
  while (from < bytes.length) {
    let to = Math.min(bytes.length, from + (chunks.length ? 74 : 75));
    while (to < bytes.length && (bytes[to] & 0xc0) === 0x80) to--;
    chunks.push(decoder.decode(bytes.subarray(from, to)));
    from = to;
  }
  return chunks.join('\r\n ');
}

const utc = (d) => `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
const localDate = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
/** Local time with no zone ("floating"): the reader takes it by its own clock. */
const floating = (d) => `${localDate(d)}T${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;

export function rruleText(rule) {
  if (!rule?.FREQ) return null;
  const parts = [`FREQ=${rule.FREQ}`];
  if (rule.INTERVAL > 1) parts.push(`INTERVAL=${rule.INTERVAL}`);
  if (rule.COUNT) parts.push(`COUNT=${rule.COUNT}`);
  if (rule.UNTIL) parts.push(`UNTIL=${rule.UNTIL}`);
  if (rule.BYDAY?.length) parts.push(`BYDAY=${[].concat(rule.BYDAY).join(',')}`);
  if (rule.BYMONTHDAY?.length) parts.push(`BYMONTHDAY=${[].concat(rule.BYMONTHDAY).join(',')}`);
  for (const key of ['BYMONTH', 'BYSETPOS']) {
    const value = rule[key];
    if (Array.isArray(value) && value.length) parts.push(`${key}=${value.join(',')}`);
    else if (typeof value === 'string' || typeof value === 'number') parts.push(`${key}=${value}`);
  }
  return parts.join(';');
}

export function generateIcs(calendarName, events, now = new Date()) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//esyst//Kalendarix 2//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${escapeText(calendarName || '')}`];
  for (const event of events) {
    const start = new Date(event.start);
    const end = new Date(event.end || event.start);
    if (Number.isNaN(start.getTime())) continue;
    lines.push('BEGIN:VEVENT', `UID:${event.uid}`, `DTSTAMP:${utc(now)}`);
    if (event.allDay) {
      // By the days it covers: a file may hold a whole-day event with hours in it.
      const after = addDays(startOfDay(start), allDayLength(start.getTime(), end.getTime()));
      lines.push(`DTSTART;VALUE=DATE:${localDate(start)}`, `DTEND;VALUE=DATE:${localDate(after)}`);
    }
    // A repeating event repeats by the clock on the wall, which a UTC time cannot say across a clock change.
    else if (event.rrule?.FREQ) lines.push(`DTSTART:${floating(start)}`, `DTEND:${floating(end)}`);
    else lines.push(`DTSTART:${utc(start)}`, `DTEND:${utc(end)}`);
    if (event.title) lines.push(`SUMMARY:${escapeText(event.title)}`);
    const notes = event.notes || event.description;
    if (notes) lines.push(`DESCRIPTION:${escapeText(notes)}`);
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    const rule = rruleText(event.rrule);
    if (rule) lines.push(`RRULE:${rule}`);
    for (const ex of event.exdates ?? []) {
      const at = new Date(ex);
      if (!Number.isNaN(at.getTime())) lines.push(event.allDay ? `EXDATE;VALUE=DATE:${localDate(at)}` : `EXDATE:${floating(at)}`);
    }
    if (typeof event.alarmMinutes === 'number') {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(event.title || 'Kalendarix')}`, `TRIGGER:-PT${event.alarmMinutes}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ------------------------------------------------------------------ export to a feature phone (see gammu/ in Kalendarix)

const base = { format: 'vCalendar 1.0', encoding: 'QUOTED-PRINTABLE', charset: 'UTF-8', alarm: 'AALARM', recurring: 'simple', location: true, categories: false, timezone: false, uid: false, prefix: true, script: 'generic' };
export const PHONE_PROFILES = [
  { ...base, id: 'nokia-s40', name: 'Nokia Series 40', examples: '3310, 6300, C2-01, 6700, Asha', maxSummary: 40, maxDescription: 255, script: 'nokia-s40' },
  { ...base, id: 'nokia-s60', name: 'Nokia S60 (Symbian)', examples: 'N95, E71, 6600, N70', format: 'iCalendar 2.0', encoding: 'UTF-8', maxSummary: 100, maxDescription: 1000, alarm: 'VALARM', recurring: 'full', categories: true, timezone: true, uid: true, prefix: false, script: 'nokia-s60' },
  { ...base, id: 'sonyericsson', name: 'Sony Ericsson', examples: 'W800, K750, W810, K800', maxSummary: 35, maxDescription: 200, script: 'sonyericsson' },
  { ...base, id: 'motorola-razr', name: 'Motorola RAZR / ROKR', examples: 'V3, V3i, L7, ROKR E1', charset: 'ISO-8859-1', maxSummary: 32, maxDescription: 128, location: false },
  { ...base, id: 'samsung-bada', name: 'Samsung Feature', examples: 'E250, D900, Corby', maxSummary: 50, maxDescription: 300 },
  { ...base, id: 'siemens', name: 'Siemens / BenQ-Siemens', examples: 'A65, C65, SL75', charset: 'ISO-8859-1', maxSummary: 30, maxDescription: 100, recurring: false, location: false },
  { ...base, id: 'generic-vcal', name: 'Generic vCalendar', examples: 'Any other feature phone', maxSummary: 32, maxDescription: 128, alarm: null, recurring: false, location: false },
];
export const phoneProfile = (id) => PHONE_PROFILES.find((p) => p.id === id) ?? PHONE_PROFILES[PHONE_PROFILES.length - 1];

/** Up to three capitals from the calendar's name. */
export const calendarPrefix = (name) => name.replace(/[^a-zA-ZÀ-ž]/g, '').toUpperCase().slice(0, 3) || 'XX';

function plain(text, max) {
  const flat = String(text ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}

// Letters outside Latin-1 that these phones cannot draw, folded to the nearest one they can.
const FOLD = { č: 'c', Č: 'C', š: 's', Š: 'S', ž: 'z', Ž: 'Z', ť: 't', Ť: 'T', ľ: 'l', Ľ: 'L', ň: 'n', Ň: 'N', ď: 'd', Ď: 'D', ŕ: 'r', Ŕ: 'R', ĺ: 'l', Ĺ: 'L',
  ě: 'e', Ě: 'E', ř: 'r', Ř: 'R', ů: 'u', Ů: 'U', ő: 'o', Ő: 'O', ű: 'u', Ű: 'U', đ: 'd', Đ: 'D', ł: 'l', Ł: 'L', '€': 'EUR', '–': '-', '—': '-', '“': '"', '”': '"', '„': '"', '‘': "'", '’': "'" };

function bytes(text, charset) {
  if (charset === 'UTF-8') return [...new TextEncoder().encode(text)];
  const out = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code <= 0xff) out.push(code);
    else for (const c of FOLD[ch] ?? '?') out.push(c.charCodeAt(0));
  }
  return out;
}

/** NAME;ENCODING=QUOTED-PRINTABLE;CHARSET=…:value, soft-wrapped at 75 without splitting an =HH. */
function quotedPrintable(name, value, charset) {
  const units = bytes(value, charset).map((b) => (b === 0x3d || b < 0x20 || b > 0x7e ? '=' + b.toString(16).toUpperCase().padStart(2, '0') : String.fromCharCode(b)));
  let out = '';
  let line = `${name};ENCODING=QUOTED-PRINTABLE;CHARSET=${charset}:`;
  for (const unit of units) {
    if (line.length + unit.length > 75) { out += line + '=\r\n'; line = ''; }
    line += unit;
  }
  return out + line;
}

function foldIcal(line) {
  if (line.length <= 74) return line;
  const parts = [line.slice(0, 74)];
  for (let i = 74; i < line.length; i += 73) parts.push(' ' + line.slice(i, i + 73));
  return parts.join('\r\n');
}

const textLine = (name, value, profile) => (profile.encoding === 'QUOTED-PRINTABLE' ? quotedPrintable(name, value, profile.charset) : foldIcal(`${name}:${escapeText(value)}`));

/** vCalendar 1.0 shorthand: D1, W2, MD1, YM1, then how long. */
function rruleVcal(rule) {
  const token = { DAILY: 'D', WEEKLY: 'W', MONTHLY: 'MD', YEARLY: 'YM' }[rule.FREQ];
  if (!token) return null;
  const head = token + (rule.INTERVAL > 0 ? rule.INTERVAL : 1);
  if (rule.COUNT) return `${head} #${rule.COUNT}`;
  const until = /^(\d{8})/.exec(String(rule.UNTIL ?? ''));
  return until ? `${head} ${until[1]}T000000` : `${head} #0`;
}

function rruleIcal(rule) {
  let out = `FREQ=${rule.FREQ}`;
  if (rule.INTERVAL > 1) out += `;INTERVAL=${rule.INTERVAL}`;
  if (rule.COUNT) out += `;COUNT=${rule.COUNT}`;
  else if (rule.UNTIL) out += `;UNTIL=${rule.UNTIL}`;
  return out;
}

const ZONE = 'Europe/Bratislava';
const VTIMEZONE = ['BEGIN:VTIMEZONE', `TZID:${ZONE}`,
  'BEGIN:DAYLIGHT', 'DTSTART:19700329T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'TZNAME:CEST', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'TZNAME:CET', 'END:STANDARD',
  'END:VTIMEZONE'];

/** One file for the phone: `items` are { event, calendarName }; `defaultAlarm` (minutes or '') for events without one. */
export function generatePhoneFile(items, profile, { defaultAlarm = 120, now = new Date() } = {}) {
  const ical = profile.format === 'iCalendar 2.0';
  const isZoned = ical && profile.timezone;
  const lines = ['BEGIN:VCALENDAR', `VERSION:${ical ? '2.0' : '1.0'}`, 'PRODID:-//esyst//Kalendarix//EN'];
  if (ical) lines.push('CALSCALE:GREGORIAN', 'METHOD:PUBLISH');
  if (isZoned) lines.push(...VTIMEZONE);
  for (const { event, calendarName } of items) {
    const start = new Date(event.start);
    const end = new Date(event.end || event.start);
    if (Number.isNaN(start.getTime())) continue;
    const title = plain(event.title, 999);
    const summary = (profile.prefix ? `[${calendarPrefix(calendarName)}] ${title}` : title).slice(0, profile.maxSummary);
    lines.push('BEGIN:VEVENT');
    if (ical) lines.push(`DTSTAMP:${utc(now)}`);
    if (profile.uid) lines.push(`UID:${event.uid}`);
    lines.push(textLine('SUMMARY', summary, profile));
    const notes = event.notes || event.description;
    if (notes) lines.push(textLine('DESCRIPTION', plain(notes, profile.maxDescription), profile));
    if (profile.location && event.location) lines.push(textLine('LOCATION', plain(event.location, profile.maxDescription), profile));
    if (profile.categories && calendarName) lines.push(textLine('CATEGORIES', plain(calendarName, 100), profile));
    const tz = isZoned ? `;TZID=${ZONE}` : '';
    lines.push(`DTSTART${tz}:${floating(start)}`, `DTEND${tz}:${floating(end)}`);
    if (profile.recurring && event.rrule?.FREQ) {
      const rule = ical ? rruleIcal(event.rrule) : rruleVcal(event.rrule);
      if (rule) lines.push(`RRULE:${rule}`);
    }
    const alarm = typeof event.alarmMinutes === 'number' ? event.alarmMinutes : defaultAlarm;
    if (profile.alarm && typeof alarm === 'number') {
      if (profile.alarm === 'VALARM') lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', textLine('DESCRIPTION', summary || 'Reminder', profile), `TRIGGER:-PT${Math.max(0, alarm)}M`, 'END:VALARM');
      else lines.push(`AALARM:${floating(new Date(start.getTime() - alarm * 60000))}`);
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// ------------------------------------------------------------------ rows read out of an event's notes

// Feeds such as a school timetable put "Učiteľ: …", "Skupina: …" on lines of the description.
const KINDS = [
  ['teacher', /^(ucitel|ucitelia|vyucujuci|teacher|teachers|lektor)$/],
  ['group', /^(skupina|skupiny|trieda|triedy|group|groups|class|classes)$/],
  ['topic', /^(tema|ucivo|topic|subject)$/],
  ['link', /^(online|link|odkaz|url|meet|zoom|teams)$/],
];
// A label is a word or three, not a sentence, a time ("12:30") or a URL scheme.
const LABELLED = /^\s*([A-Za-zÀ-ž][A-Za-zÀ-ž .\-/]{1,23}):\s+(\S.*)$/;
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/g;
const isUrl = (text) => /^https?:\/\/\S+$/.test(text.trim());

/** { fields: [{ kind, label, value }], notes: what is left once the labelled lines are taken out }. */
export function parseDetails(text) {
  const fields = [];
  const rest = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = LABELLED.exec(line);
    if (!m || /^https?$/i.test(m[1])) { rest.push(line); continue; }
    const key = normaliseName(m[1]);
    const kind = KINDS.find(([, pattern]) => pattern.test(key))?.[0] ?? (isUrl(m[2]) ? 'link' : 'other');
    fields.push({ kind, label: m[1].trim(), value: m[2].trim() });
  }
  return { fields, notes: rest.join('\n').trim() };
}

/** Text cut into plain stretches and links, in order. */
export function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(URL_RE)) {
    const href = m[0].replace(/[.,;:!?]+$/, ''); // sentence punctuation right after a link is not part of it
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: href, href });
    last = m.index + href.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** "Zrušené: Matematika" is Matematika that is not happening. */
export function splitCancelled(title) {
  const m = /^\s*(zrušené|zrusene|cancelled|canceled)\s*:\s*(.*)$/i.exec(title);
  return m ? { title: m[2], cancelled: true } : { title, cancelled: false };
}

// ------------------------------------------------------------------ finding events

/** How well a query matches a text: higher is better, -1 is no match. Diacritics do not matter. */
export function score(query, text) {
  const needle = normaliseName(query);
  const hay = normaliseName(text ?? '');
  if (!needle) return 0;
  if (!hay) return -1;
  const at = hay.indexOf(needle);
  if (at !== -1) return 1000 - at - (hay.length - needle.length) * 0.1;
  // Otherwise the letters must at least appear in order; runs score higher.
  let from = 0, total = 0, run = 0;
  for (const ch of needle) {
    const found = hay.indexOf(ch, from);
    if (found === -1) return -1;
    if (found === from) total += 5 + ++run;
    else { run = 0; total += 1; }
    from = found + 1;
  }
  return total;
}

/** Best matches first; a repeating event is one result, its next occurrence (or its last, when all are past). */
export function search(query, items, now, limit = 30) {
  if (!query.trim()) return [];
  const best = new Map();
  const ahead = (i) => i.end >= now;
  const closer = (a, b) => (ahead(a) !== ahead(b) ? ahead(a) : ahead(a) ? a.start < b.start : a.start > b.start);
  for (const i of items) {
    let value = -1;
    for (const [text, weight] of [[i.event.title, 3], [i.event.location, 2], [i.event.notes || i.event.description, 1.5], [i.cal.name, 1]]) {
      const s = score(query, text);
      if (s >= 0) value = Math.max(value, s * weight);
    }
    if (value < 0) continue;
    const id = `${i.cal.id}|${i.event.uid}`;
    const kept = best.get(id);
    if (!kept || closer(i, kept.i)) best.set(id, { i, score: value });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || Math.abs(a.i.start - now) - Math.abs(b.i.start - now)).slice(0, limit).map((r) => r.i);
}

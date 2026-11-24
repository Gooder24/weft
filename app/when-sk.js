// Slovak for chrono (app/chrono.js): the days and times a Slovak message names, as chrono parsers. It reads text
// already folded by when.js (lower case, no diacritics, one character for one). Each result carries `weft`, what
// when.js needs to judge it: a day ({ day, endDay?, date?, weekday?, unsure?, bad? }) or a time ({ h, m, minutes, lead,
// prefixed, am, pm, word?, endH, endM, endFixed, bad? }). chrono keeps the longest of overlapping results.

import { Chrono, OverlapRemovalRefiner } from './chrono.js';

export const DAY = 864e5;
export const startOf = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };

const WEEKDAYS = [ // Monday first; the forms that follow v/na/do/od/budúci
  'pondelok|pondelka|pondelku', 'utorok|utorka|utorku', 'streda|stredu|stredy', 'stvrtok|stvrtka|stvrtku',
  'piatok|piatka|piatku', 'sobota|sobotu|soboty', 'nedela|nedelu|nedele',
];
const MONTHS = ['januara|januar', 'februara|februar', 'marca|marec', 'aprila|april', 'maja|maj', 'juna|jun', 'jula|jul',
  'augusta|august', 'septembra|september', 'oktobra|oktober', 'novembra|november', 'decembra|december'];
export const ORDINALS = ['jednej', 'druhej', 'tretej', 'stvrtej', 'piatej', 'siestej', 'siedmej', 'osmej', 'deviatej', 'desiatej', 'jedenastej', 'dvanastej'];
const MONTH_WORDS = MONTHS.join('|');

/** A written date; without a year it is this year's, or next year's when this year's was long ago. undefined: no
 *  date at all ("19.00."); null: a day that does not exist, or one just past (the message is about the past). */
export function dateOf(day, month, year, ref) {
  if (!(month >= 0 && month < 12 && day >= 1 && day <= 31)) return undefined;
  let y = year ? (year < 100 ? 2000 + year : year) : new Date(ref).getFullYear();
  if (!year && new Date(y, month, Math.min(day, 28)).getTime() < startOf(ref) - 60 * DAY) y += 1;
  // 29. 2. in a year without one is a slip, not a date more than a year ahead.
  const d = new Date(y, month, day);
  if (d.getMonth() !== month) return null;
  return !year && d.getTime() < startOf(ref) ? null : d.getTime();
}

/** The day a weekday names from `ref`: `which` is "this" or "next" when the words said so. */
export function weekdayOf(idx, which, ref) {
  const day = startOf(ref);
  const today = (new Date(day).getDay() + 6) % 7;
  if (which === 'next') return { day: addDays(day, 7 - today + idx) };
  const diff = (idx - today + 7) % 7;
  // "v piatok" said on a Friday may be today or a week on: no guess.
  return { day: addDays(day, diff), unsure: diff === 0 && which !== 'this' };
}

/** A chrono parser from a pattern and a function of the match giving `weft` (or nothing to skip it). */
const parser = (name, re, read) => ({
  name,
  // chrono searches what is left of the text after each result; searching the whole text from there keeps the
  // look-behinds ("not after a digit") seeing the characters before.
  pattern(context) {
    const g = new RegExp(re.source, `${re.flags}g`);
    const full = context.text;
    return { exec(rest) {
      g.lastIndex = full.length - rest.length;
      const m = g.exec(full);
      if (m) m.index -= full.length - rest.length;
      return m;
    } };
  },
  extract(context, m) {
    const weft = read(m, context.refDate.getTime(), context.text);
    if (!weft) return null;
    const c = context.createParsingComponents();
    if (weft.day != null) {
      const d = new Date(weft.day);
      c.assign('year', d.getFullYear()).assign('month', d.getMonth() + 1).assign('day', d.getDate());
    } else if (weft.h != null) c.assign('hour', weft.h).assign('minute', weft.m);
    const r = context.createParsingResult(m.index, m[0], c.addTag(`parser/${name}`));
    r.weft = weft;
    return r;
  },
});

const days = [
  parser('SKCasualDay', /(?<![\p{L}\d])(dnes|dneska|dnesny|dnesnu|zajtra|zajtrajs\p{L}*|pozajtra)(?![\p{L}\d])/u, (m, ref) =>
    ({ day: addDays(startOf(ref), m[1] === 'pozajtra' ? 2 : m[1].startsWith('zajtra') ? 1 : 0) })),
  parser('SKWeekday', new RegExp(String.raw`(?<![\p{L}\d])(?:(v|vo|na|do|od|tento|tuto|toto|buduci|buducu|buduce|najblizsi|najblizsiu|najblizsie)\s+)?(${WEEKDAYS.join('|')})(?![\p{L}\d])`, 'u'), (m, ref) => {
    const idx = WEEKDAYS.findIndex((w) => w.split('|').includes(m[2]));
    // Oblique forms only after do/od: "piatka" alone is also a five; "v utorku" is a slip no day is guessed from.
    if (/^(pondel|utor|stvrt|piat)k[au]$/.test(m[2]) && !/^(do|od)$/.test(m[1] || '')) return /^piat/.test(m[2]) ? null : { day: startOf(ref), unsure: true, weekday: true };
    const which = /^(buduc|najbliz)/.test(m[1] || '') ? 'next' : /^(tento|tuto|toto)$/.test(m[1] || '') ? 'this' : '';
    return { ...weekdayOf(idx, which === 'next' && /^najbliz/.test(m[1]) ? '' : which, ref), weekday: true };
  }),
  // 28. 11. / 28.11.2026 (the closing dot keeps "28.11 €" a price); "o 9.10." is a time.
  parser('SKNumericDate', /(?<![\d.,])(?<!\d)(\d{1,2})\.\s?(\d{1,2})(?:\.(?:\s?(\d{4}))?|(?=\s(?:o|at)\s\d))(?![\d,])/, (m, ref, t) => {
    if (/(^|\s)(o|od|at)\s$/.test(t.slice(Math.max(0, m.index - 4), m.index))) return null;
    // "3. 4. úloha", "5. 6. ročník": numbered things, not a date.
    if (/^\s?(uloh|rocn|tried|kapit|kap\b|stran|str\b|bod|miest|cvic|priklad|lekci|odsek|vers)/.test(t.slice(m.index + m[0].length))) return null;
    const day = dateOf(+m[1], +m[2] - 1, m[3] && +m[3], ref);
    return day === undefined ? null : day === null ? { day: startOf(ref), bad: true, date: true } : { day, date: true };
  }),
  // 23.–25. 11., od 23. do 25. 11., 30. 11. – 2. 12.: a few days in a row.
  parser('SKDateRange', /(?<![\d.,])(?:od\s)?(\d{1,2})\.\s?(?:(\d{1,2})\.\s?)?(?:-|–|—|do|az)\s?(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}))?(?![\d,])/, (m, ref) => {
    const end = dateOf(+m[3], +m[4] - 1, m[5] && +m[5], ref);
    const start = dateOf(+m[1], (m[2] ? +m[2] : +m[4]) - 1, m[5] && +m[5], ref);
    if (end == null || start == null) return end === undefined || start === undefined ? null : { day: startOf(ref), bad: true, date: true };
    // Without a year "30. 12. – 2. 1." ends in the next one.
    const last = end < start && !m[5] ? new Date(end).setFullYear(new Date(end).getFullYear() + 1) : end;
    return last > start && last - start <= 31 * DAY ? { day: start, endDay: last, date: true } : { day: startOf(ref), bad: true, date: true };
  }),
  parser('SKISODate', /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/, (m, ref) => {
    const day = dateOf(+m[3], +m[2] - 1, +m[1], ref);
    return day == null ? null : { day, date: true };
  }),
  parser('SKMonthNameDate', new RegExp(String.raw`(?<![\p{L}\d])(?<!(?:^|\s)(?:o|od)\s)(\d{1,2})\.?\s?(${MONTH_WORDS})(?![\p{L}\d])(?:\s(\d{4}))?`, 'u'), (m, ref) => {
    const day = dateOf(+m[1], MONTHS.findIndex((w) => w.split('|').includes(m[2])), m[3] && +m[3], ref);
    return day === undefined ? null : day === null ? { day: startOf(ref), bad: true, date: true } : { day, date: true };
  }),
];

// Units after a bare hour make it an amount: "o 5 minút", "o 2 hodiny".
export const UNIT = /^\s?(?:min|minut|minuty|minutu|sek|sekund|eur|euro|e\b|€|%|percent|km|kg|g\b|m\b|cm|rok|roky|rokov|rocn|den|dni|dna|tyzd|mesiac|hodin|hodiny|hodinu|korun|ludi|ludia|kus|krat|x\b|bod|stup|deti|osob|people|minutes?|hours?|days?|weeks?|months?|years?|euros?|dollars?|percent|times|points?|\$|\d)/;
// A plural place or an amount after a bare hour: "o 5 otázkach", "o 5 bodov", "o 5 odpovedí viac".
export const AMOUNT = /^\s*(?:\p{L}*(?:ach|och|ov|sie)\b|(?:\p{L}+\s)?(?:viac|menej|more|less|fewer)\b)/u;

/** After a clock: it is a place in a video or a song. */
export const MEDIA = /^,?\s+(?:vo\s+videu|vo\s+videjku|v\s+pesnicke|v\s+piesni|v\s+nahravke|v\s+klipe|(?:in|of|into)\s+(?:the|this|that|my|your)\s+(?:video|song|clip|track|recording|movie))\b/;
const MONEY = /^\s?(?:eur|euro|e\b|€|\$|usd|kc|czk|korun|dollars?|euros?)/;

/** A clock as written: `bad` for one that cannot be ("17:75", "14pm"). */
function clock(m, { h, min, suf, eh, em, esuf, prefixed, plain }) {
  const hour = +h;
  const s = (suf || '').replace(/\./g, '');
  const es = (esuf || '').replace(/\./g, '');
  const bad = { h: 0, m: 0, bad: true };
  if ((min != null && (+min > 59 || hour > 23)) || (em != null && (+em > 59 || +eh > 23))) return bad;
  if (!(hour >= 0 && hour <= 23)) return null;
  if (((s === 'am' || s === 'pm') && !(hour >= 1 && hour <= 12)) || (es && !(+eh >= 1 && +eh <= 12))) return bad;
  const rest = m.input.slice(m.index + m[0].length);
  // "na 20.50 eur" is money, "na 12:30 vo videu" a place in a video.
  if (MONEY.test(rest) || MEDIA.test(rest)) return null;
  if (min == null && !s) {
    if (UNIT.test(rest.replace(/^\s+/, ' ')) || AMOUNT.test(rest)) return null;
    // "o 3. hodine" is a lesson, "o 2. svetovej vojne" a topic; "o 5. Tešíme sa" ends a sentence.
    if (/^\.\s*\p{Ll}/u.test(plain.slice(m.index + m[0].length))) return null;
  }
  return { h: hour, m: min == null ? 0 : +min, minutes: min != null, lead: /^0/.test(h), prefixed, am: s === 'am', pm: s === 'pm',
    hourMark: /^(h|hod|hodine|-?tej|-?ej)$/.test(s),
    endH: eh == null ? null : es === 'am' && +eh === 12 ? 0 : +eh + (es === 'pm' && +eh < 12 ? 12 : 0), endM: em == null ? 0 : +em, endFixed: !!es,
    // "from 8 to 11 pm": the end's pm is the start's too.
    ...(!s && es === 'pm' && +h <= +eh ? { pm: true } : {}), ...(!s && es === 'am' ? { am: true } : {}) };
}

const RANGE = String.raw`(?:\s?(?:-|–|—|do|az)\s?(\d{1,2})(?:[:.](\d{2}))?(?:\s?(am|pm|a\.m\.|p\.m\.))?)?`;
const SUFFIX = String.raw`(?:\s?(am|pm|a\.m\.|p\.m\.|h(?![\p{L}])|hod(?![\p{L}])|hodine(?![\p{L}])|-?tej(?![\p{L}])|-?ej(?![\p{L}])))?`;

// "preskoč na", "pretoč si to na": a place in a video or a song follows.
const SEEK = /(?:preskoc|pretoc|prejdi|pust|pozri|klikn|skip|jump)\w*(?:\s+(?:si|to|mi|ti|tam|az|rovno|hned|priamo|len))*\s+(?:na\s+)?$/;
const seek = (m) => SEEK.test(m.input.slice(Math.max(0, m.index - 30), m.index));

/** Times; `plain` (the text before folding) tells a capital after a dot. */
const times = (plain) => [
  parser('SKTime', new RegExp(String.raw`(?<![\p{L}\d])(o|od|okolo|cca|na)\s(\d{1,2})(?:[:.](\d{2}))?${SUFFIX}${RANGE}(?!\d|[:.,]\d)`, 'u'), (m) => {
    // "na 5" only with minutes ("na 17:00"); "na" is too common before plain numbers.
    if (m[1] === 'na' && m[3] == null) return null;
    // "preskoč na 12:34" is a place in a video, not a time.
    if (m[1] === 'na' && seek(m)) return null;
    // "na 20.11." is a day: a dot clock that closes like a date is left to the dates.
    if (m[1] === 'na' && m[3] && !m[0].includes(':') && +m[3] >= 1 && +m[3] <= 12 && m.input[m.index + m[0].length] === '.') return null;
    return clock(m, { h: m[2], min: m[3], suf: m[4], eh: m[5], em: m[6], esuf: m[7], prefixed: m[1], plain });
  }),
  // "17:00", "17.00", "16:00–17:30" without "o"; "17–18" as a range of hours.
  parser('SKBareTime', new RegExp(String.raw`(?<![\d.:,\p{L}])(\d{1,2})[:.](\d{2})${SUFFIX}${RANGE}(?!\d|[:.]\d|\.\s?\d)`, 'u'), (m) =>
    (seek(m) ? null : clock(m, { h: m[1], min: m[2], suf: m[3], eh: m[4], em: m[5], esuf: m[6], prefixed: '', plain }))),
  parser('SKHourRange', /(?<![\d.:,])(\d{1,2})\s?[-–—]\s?(\d{1,2})(?:\s?(h|hod)(?![\p{L}]))?(?![\d.:,]|\s?(?:€|%|eur|km|kg|rok|minut|bod))/u, (m) => {
    // A score ("2-1") or a count is no range: both hours of the day, the end later.
    if (!(+m[1] >= 7 && +m[1] < +m[2] && +m[2] <= 23)) return null;
    return clock(m, { h: m[1], min: null, suf: m[3], eh: m[2], em: null, esuf: null, prefixed: '', plain });
  }),
  // "medzi 5 a 7", "medzi 17:00 a 18:30": a range.
  parser('SKBetween', /(?<![\p{L}\d])medzi\s(\d{1,2})(?:[:.](\d{2}))?\s(?:a|az)\s(\d{1,2})(?:[:.](\d{2}))?(?!\d|[:.,]\d)/u, (m) =>
    clock(m, { h: m[1], min: m[2], suf: null, eh: m[3], em: m[4], esuf: null, prefixed: 'medzi', plain })),
  // Words: "o pol 6" (5:30), "o štvrť na 8" (7:15), "o trištvrte na 5" (4:45), "o šiestej", "na obed".
  parser('SKWordTime', new RegExp(String.raw`(?<![\p{L}\d])(?:o|okolo|na)\s(pol|stvrt na|tri ?stvrte na)\s(\d{1,2}|${ORDINALS.join('|')})(?![\p{L}\d])(?![\d:.,]|\s?\.?\s?hod)`, 'u'), (m) => { // i18n-ignore: a parser pattern, not text
    const n = /^\d+$/.test(m[2]) ? +m[2] : ORDINALS.indexOf(m[2]) + 1;
    if (!(n >= 1 && n <= 12) || UNIT.test(m.input.slice(m.index + m[0].length))) return null;
    return { h: n === 1 ? 12 : n - 1, m: m[1] === 'pol' ? 30 : m[1] === 'stvrt na' ? 15 : 45, word: true, prefixed: 'o', endH: null, endM: 0 };
  }),
  // "o druhej hodine" is the second lesson as often as two o'clock: not read.
  parser('SKOrdinalTime', new RegExp(String.raw`(?<![\p{L}\d])(?:o|okolo)\s(${ORDINALS.join('|')})(?![\p{L}\d])(?!\s(?:hod|veci?(?![\p{L}])|stran|otazk|uloh))`, 'u'), (m) =>
    ({ h: ORDINALS.indexOf(m[1]) + 1, m: 0, word: true, prefixed: 'o', endH: null, endM: 0 })),
  parser('SKNoon', /(?<![\p{L}])(na obed|napoludnie|na poludnie)(?![\p{L}])/u, () => ({ h: 12, m: 0, word: true, lead: true, prefixed: 'na', endH: null, endM: 0 })),
];

/** chrono for Slovak; parse the folded text, with `plain` the same text before folding. */
export const slovak = (plain) => new Chrono({ parsers: [...days, ...times(plain)], refiners: [new OverlapRemovalRefiner()] });

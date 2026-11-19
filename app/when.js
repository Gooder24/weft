// Finds a time to put into the calendar in a message ("zajtra o 17:00 tréning", "on Friday at 5pm"), on this
// device only. chrono (app/chrono.js) reads English, app/when-sk.js is its Slovak; this file judges what they found.
// findWhen(text, { ref, now }) gives { start, end, allDay, title, doubt } or null: `ref` is when the message was
// sent (relative words count from it), `now` hides what is already over. It would rather miss a time than offer one
// that is not meant: a day without a time needs a word naming an event, a time needs "o"/"at", a part of the day, a
// range or a whole quarter hour, and past, repeating plans, two different days or two different times give nothing.
// `doubt` marks a plan that may be refused, moved or not one at all ("nemôžem", "presúva sa", "pošlem ti"): Weft
// offers it only when the judge on asus (server/when/) says it is a plan.

import { Chrono, en } from './chrono.js';
import { slovak, startOf, addDays, dateOf, weekdayOf, DAY, UNIT, AMOUNT, MEDIA } from './when-sk.js';

/** Lower case without diacritics, one character for one, so positions in it are positions in the text. */
export const fold = (s) => s.replace(/[\s\S]/g, (c) => { const x = c.normalize('NFD')[0].toLowerCase(); return x.length === 1 ? x : c; });

// Words that make a plain day an event worth a calendar entry (stems, folded).
const EVENT = /\b(test\w*|pisom\w*|skusk\w*|skuse?\w*|previer\w*|zapocet\w*|maturit\w*|ustn\w*|trening\w*|treningy|zapas\w*|turnaj\w*|stretnut\w*|stretko|schodz\w*|porad[auey]|meeting\w*|oslav\w*|narodenin\w*|party|parties|koncert\w*|ples\w*|vylet\w*|sustreden\w*|tabor\w*|deadline\w*|odovzd\w*|termin\w*|exam\w*|quiz\w*|practice|training|match|appointment|interview\w*|pohovor\w*|dentist|zubar\w*|lekar\w*|doktor\w*|kino|kina|movie|film|divadl\w*|svadb\w*|wedding|birthday|konzultac\w*|vystup\w*|recital\w*|premier\w*|prednask\w*|lecture|seminar\w*|kurz\w*|lesson|omsa|omsu|veceru|obed|dinner|lunch|brunch|kava|kavu|coffee|sraz\w*|diktat\w*|ustne|kontroln\w*|zraz\w*|vecierok|vecierk\w*|konferenc\w*|festival\w*|trip|trips|tournament\w*|conference\w*|camp|hike|hiking|skolen\w*|workshop\w*|webinar\w*|sutaz\w*|olympiad\w*|competition\w*)\b/;
// Over or repeating (a series is Karchi's to set up): nothing.
// Moved away from a time: "moved from Friday at 5 pm", "presunuli zo štvrtka": that time is the old one.
const MOVED_FROM = /\b(?:moved|reschedul\w*|postpon\w*|presun\w*|posun\w*|preloz\w*|odloz\w*)\b[^.!?\n]*?\b(?:from|zo?\s+(?:pondelk|utork|stred|stvrtk|piatk|sobot|nedel|dnes|zajtr|\d)\w*|od\s+\d)/;
const OVER = /\b(vcera|predvcerom|minul\w*|yesterday|last|ago|kazd\w*|vzdy|every|polnoc\w*|midnight)\b/;
// Maybe not a plan: past verbs ("mali by sme" is a plan), refused, cancelled, moved, sent, guessed, or when it ends
// ("končí o 14:00", "koniec o 16:00", "trvá do 16:00", "will be over at 11", "wraps up at 5pm").
const PAST = /(?<!\bby\s)\b(bol|bola|bolo|boli|mal|mala|malo|mali)\b(?!\s+(?:by|sme by|ste by)\b)/;
const DOUBT = /\b(was|were|had|nevyjde|nemozem|nemozeme|nemozes|nestihnem|nestihneme|nepridem|nepride|nepridu|neprideme|nejdem|nejdeme|nebudem|nebude|nebudeme|nekona|zrusen\w*|zrusil\w*|zrusi|zrusime|zrusia|rusi|rusia|rusime|odpada\w*|odpad(?:ol|la|lo|li|ne|nu)|neuskutocn\w*|nemame|nemam|nie je|nieje|neni|cant|can't|cannot|wont|won't|cancel\w*|never|nikdy|vysled\w*|skore|score|tipujem|tipnem|predict\w*|bet|presuv\w*|presun\w*|posuv\w*|posun\w*|odklad\w*|odloz\w*|prelozen\w*|postpon\w*|moved|reschedul\w*|delay\w*|poslem|posielam|posles|posli|preskoc\w*|skip|skipp\w*|dokonci\w*|dokonc\w*|done|hotov[oaey]?|continu\w*|pokracuj\w*|konca|koncom|trva\w*|potrva\w*|ends?|ending|finish\w*|wraps?|wrapping|closes?|closing|lasts?|lasting|over(?!\s+the\s+weekend)|send|sending|sent|(?:is|are|s) off|called off|(?:don'?t|do not|doesn'?t) have|no\s+(?:meeting|training|practice|class|school|lesson|exam|test|party)\w*|not)\b(?<!\bnot(?= forget))/;
// Only when it ends, or that it is still going then: "končí o 14:00", "trvá do 16:00", "wraps up at 5pm",
// "runs until 5pm", "is still going at 5pm". Such a message offers nothing, and the judge is not asked.
const END = /\b((?:ne)?(?:s|u)?konci\w*|(?:ne)?ukonc\w*|koniec|ends?|ending|wraps?\s+up|wrapping\s+up|closes?|closing|(?:is|are|be|'s)\s+done|still\s+(?:going|running|happening|in progress)|(?:este|stale)\s+(?:bezi|trva|prebieha|ide)|(?:runs?|running|goes|go|going|lasts?|lasting|continu\w*|is on|keeps? going)\b[^.!?\n]{0,40}?\b(?:until|till|til)|(?:trva\w*|potrva\w*|bezi|bezat|prebieha|pokracuj\w*|ide)\b[^.!?\n]{0,40}?\bdo\s+\d+)\b/;
const AM = /\b(rano|rana|doobeda|dopoludnia|morning|am)\b/;
const PM = /\b(poobede|popoludni|popoludnie|poludni|vecer|veceri|vecerom|po skole|po treningu|evening|afternoon|tonight|after school|after work|pm)\b/;
const NIGHT = /\b(v noci|nocou|at night|night|tonight|midnight|polnoc\w*)\b/;

// English or Slovak: the words a message is made of.
const EN_WORDS = /\b(the|at|on|tomorrow|today|tonight|next|this|is|are|was|we|you|my|lets|let's|meet|see|from|to|with|for|dont|don't|have|will|it|in|after|before|pm|am|and|i|our|your|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g;
const SK_WORDS = /\b(zajtra|dnes|pozajtra|o|v|vo|na|je|sa|sme|mame|bude|od|do|aj|ale|ze|si|som|ti|mi|ma|tento|buduci|uz|ked|ako|pondelok|utorok|stredu|stvrtok|piatok|sobotu|nedelu)\b/g;
const english = (plain, t) => {
  const en = (t.match(EN_WORDS) || []).length;
  const sk = (t.match(SK_WORDS) || []).length + (/[^\x00-\x7f]/.test(plain.replace(/\p{Extended_Pictographic}|[‘’“”–—…]/gu, '')) ? 2 : 0);
  return en > sk || (!sk && !!en) || (!sk && /\d(?:st|nd|rd|th)\b|\b(?:january|february|march|april|june|july|august|september|october|november|december)\b/.test(t)
    || (!sk && /\b(?:jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?\s?\d|\d(?:st|nd|rd|th)?\s(?:jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b/.test(t)));
};

// chrono's English without counted durations ("in 5 minutes", "2 days ago", "next week"): those are no appointments.
const ENGLISH = (() => {
  const c = en.createCasualConfiguration(false);
  c.parsers = c.parsers.filter((p) => !/TimeUnit|RelativeDate|EndOfCurrentMonth/.test(p.constructor.name));
  return new Chrono(c);
})();

const DAY_WORDS = /\b(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b/g;

/** What chrono's English found, as when-sk.js gives it: days and times with their place in the text. */
function englishFound(folded, ref) {
  // "between 5 and 7" read as chrono's "from 5 to 7", in as many characters.
  const t = folded.replace(/\bbetween(\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+)and(?=\s+\d)/g, (_, a) => `   from${a} to`);
  const out = [];
  for (const r of ENGLISH.parse(t, new Date(ref))) {
    const s = r.start;
    const tags = r.tags();
    if (tags.has('result/relativeDate') || tags.has('casualReference/now')) continue;
    const at = r.index;
    const end = r.index + r.text.length;
    let day;
    // A weekend is read in extras(), never as chrono's Saturday; its clock stays.
    if (/\bweekends?\b/.test(r.text)) day = undefined;
    else if (/\b(today|tonight|tomorrow|tmrw?|overmorrow|day after tomorrow)\b/.test(r.text)) day = { day: startOf(s.date().getTime()) };
    else if (s.isCertain('day')) {
      const d = dateOf(s.get('day'), s.get('month') - 1, s.isCertain('year') ? s.get('year') : null, ref);
      if (d !== undefined) day = d === null ? { day: startOf(ref), bad: true } : { day: d, date: true };
    } else if (s.isCertain('weekday')) {
      const which = /\bnext\b/.test(r.text) ? 'next' : /\bthis\b/.test(r.text) ? 'this' : '';
      day = { ...weekdayOf((s.get('weekday') + 6) % 7, which, ref), weekday: true };
    }
    // "Nov 23-25", "from Monday to Wednesday": a few days in a row.
    if (day && r.end && !s.isCertain('hour') && !r.end.isCertain('hour')) {
      const e = r.end;
      // A weekday that ends one is the first after its start.
      const last = e.isCertain('day') ? dateOf(e.get('day'), e.get('month') - 1, e.isCertain('year') ? e.get('year') : null, ref)
        : e.isCertain('weekday') && day.weekday ? addDays(day.day, (e.get('weekday') - s.get('weekday') + 7) % 7 || 7) : undefined;
      out.push({ at, end, weft: last > day.day && last - day.day <= 31 * DAY ? { ...day, endDay: last } : { day: startOf(ref), bad: true } });
      continue;
    }
    // A day and a time in one result: the day gets no length of its own, the time the whole of it.
    if (day) out.push({ at, end: s.isCertain('hour') ? at : end, weft: day });
    if (!s.isCertain('hour')) continue;
    // The written clock is the number chrono took as the hour: in "November 27 at 9:00" that is 9, not 27.
    const clocks = [...r.text.matchAll(/(?:\b(at|from|around|about|by)\s*)?\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.m\.|p\.m\.|am|pm)?(?!\d)/g)];
    const H = s.get('hour');
    const fits = clocks.filter(([, , h, min]) => (+h === H || +h + 12 === H || (+h === 12 && H === 0)) && +(min || 0) === s.get('minute'));
    const m = fits.find((c) => c[1] || c[3] || c[4]) || fits[0] || clocks.at(-1);
    const word = !m || /\b(noon|midnight|evening|morning|afternoon)\b/.test(r.text) && !/\d/.test(r.text);
    const certain = s.isCertain('meridiem');
    const rest = t.slice(end);
    // "at 12:30 in the video" is a place in it.
    if (MEDIA.test(rest)) continue;
    // A move from one day to another ("from Friday at 5 pm to Monday at 9 am") names two days.
    if (r.end && (r.text.match(DAY_WORDS) || []).length > 1 && startOf(r.end.date().getTime()) !== startOf(s.date().getTime())) out.push({ at: end, end, weft: { day: startOf(r.end.date().getTime()) } });
    // "at 3 euros", "at 5 guys" are amounts.
    if (m && !m[3] && !m[4] && !r.end && (UNIT.test(rest.replace(/^\s+/, ' ')) || AMOUNT.test(rest))) continue;
    // The hour as written: chrono already moved "tonight at 1" to 13:00, which when.js judges itself.
    const raw = !certain && m ? +m[2] : s.get('hour');
    out.push({ at, end, weft: {
      h: raw, m: s.get('minute'), minutes: !!m?.[3], lead: /^0/.test(m?.[2] || ''), word,
      prefixed: m?.[1] || (/\b(at|from)\s$/.test(t.slice(Math.max(0, at - 5), at)) ? 'at' : ''),
      // Morning or afternoon only as written ("5pm"); chrono also calls "13:34" certain afternoon.
      am: /^a/.test(m?.[4] || ''), pm: /^p/.test(m?.[4] || ''),
      endH: r.end?.isCertain('hour') ? r.end.get('hour') : null, endM: r.end ? r.end.get('minute') : 0, endFixed: !!r.end?.isCertain('meridiem'),
    } });
  }
  return out;
}

// What neither chrono nor when-sk.js reads, in both languages: a weekend, "in 2 hours", a part of the day.
// "(The) weekend practice footage" names no weekend: a word before it does ("cez víkend", "this weekend").
const WEEKEND = /(?<![\p{L}])(cez|na|tento|tuto|cely|buduci|najblizsi|this|next|over the|on the|for the)\s+(?:vikend|vikendu|weekend)(?![\p{L}])/u;
const NEXT_WEEK = /(?<![\p{L}])(?:na\s+)?(?:buduci|buduce|buducu|next)\s+(?:tyzden|week)(?![\p{L}])/u;
const IN_HOURS = /(?<![\p{L}\d])(o|za|in)\s+(?:(?:about|around|roughly|asi|cca|zhruba|priblizne)\s+)?(?:(\d{1,2}|jednu|dve|dva|tri|styri|pat|sest|an?|one|two|three|four|five|six)\s+|(pol|half an?)\s+)?(?:hodinu|hodiny|hodin|hour|hours)(\s+a\s+pol|\s+and\s+a\s+half)?(?![\p{L}])/u;
const COUNT = { jednu: 1, dve: 2, dva: 2, tri: 3, styri: 4, pat: 5, sest: 6, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
// "o hodinu neskôr", "posunuli o hodinu", "o 2 hodiny dlhšie", "za hodinu končí": a shift, a length or an end, not a time.
const SHIFT = /\b(neskor\w*|skor|skorej|later|earlier|posun\w*|presun\w*|predlz\w*|skrat\w*|meska\w*|late|delay\w*|moved|postpon\w*|dlhs\w*|kratsi\w*|longer|shorter|viac|menej|more|less|konci\w*|skonci\w*|ends?|ending|finish\w*|done|hotov[oaey]?)\b/;
// "Dobré ráno" is a greeting. A part of the day stands for these hours (Google Calendar's morning, afternoon, evening).
const PART = /(?<![\p{L}])(?<!(?:dobre|dobry|good)\s)(rano|doobeda|dopoludnia|poobede|popoludni|navecer|vecer|morning|afternoon|evening|tonight)(?![\p{L}])/gu;
const PART_HOURS = { rano: [8, 12], doobeda: [8, 12], dopoludnia: [8, 12], morning: [8, 12], poobede: [13, 17], popoludni: [13, 17],
  afternoon: [13, 17], navecer: [18, 21], vecer: [18, 21], evening: [18, 21], tonight: [18, 21] };
// Meeting someone is a plan even without an event's name: "v piatok poobede sa stretneme".
const MEET = /\b(stretneme|stretnime|stretnem|stretnes|uvidime sa|vidime sa|zideme sa|zastavim sa|zastav sa|meet|see you|hang out)\b/;

/** Days and times read here, as the parsers give them; `own` ones replace what a parser read in the same words. */
function extras(t, ref) {
  const out = [];
  const w = t.match(WEEKEND);
  if (w) {
    // The coming weekend, the one going on, or with "budúci"/"next" the next week's.
    const today = (new Date(ref).getDay() + 6) % 7;
    const sat = /^(buduci|next)$/.test(w[1]) ? weekdayOf(5, 'next', ref).day : addDays(startOf(ref), Math.max(0, 5 - today));
    const sun = today === 6 && sat === startOf(ref) ? sat : addDays(sat, 1);
    out.push({ at: w.index, end: w.index + w[0].length, weft: { day: sat, ...(sun > sat ? { endDay: sun } : {}), own: true, weekend: true } });
  }
  const nw = t.match(NEXT_WEEK);
  if (nw) out.push({ at: nw.index, end: nw.index + nw[0].length, weft: { nextWeek: true } });
  const r = t.match(IN_HOURS);
  // "5 eur za hodinu" is a price.
  if (r && !SHIFT.test(t) && !/(?:\d|eur\w*|€|\$|kc|dollars?)\s*$/.test(t.slice(0, r.index))) {
    const n = (r[3] ? 0.5 : r[2] ? (/\d/.test(r[2]) ? +r[2] : COUNT[r[2]]) : 1) + (r[4] ? 0.5 : 0);
    if (n > 0 && n <= 12) {
      const at = new Date(Math.round((ref + n * 36e5) / 3e5) * 3e5); // to five minutes
      const span = { at: r.index, end: r.index + r[0].length };
      out.push({ ...span, weft: { day: startOf(+at), own: true } }, { ...span, weft: { h: at.getHours(), m: at.getMinutes(), fixed: true, relative: true, prefixed: r[1],
        // "I'll be over in an hour" arrives, "practice will be over, in an hour" ends: the judge tells them apart.
        doubtful: /\bover\b/.test(t) } });
    }
  }
  for (const p of t.matchAll(PART)) {
    const [h, eh] = PART_HOURS[p[1]];
    out.push({ at: p.index, end: p.index + p[0].length, weft: { h, m: 0, endH: eh, endM: 0, fixed: true, part: true, prefixed: 'part' } });
  }
  return out;
}

/** Nothing but the time and filler words: a reply like "v piatok poobede?" or "o 2 hodiny". */
const alone = (t, spans) => {
  let s = t;
  for (const [a, b] of spans) s = s.slice(0, a) + ' '.repeat(b - a) + s.slice(b);
  return !s.split(/[^\p{L}\d]+/u).some((w) => w && !STOP.has(w) && !FILLER.has(w) && !/^(v|vo|o|na|at|on|in|od|do|za|cez|from|over)$/.test(w));
};

const STOP = new Set(('a aj ale ahoj cau caute cus nazdar zdravim tak takze teda ze ked lebo preto mame mam mas mate mame bude budeme '
  + 'budem budes budu je su sme som si ide ideme idem ides idete pojdeme pojdes pojdem pojdete nezabudni nezabudnite pripominam pripomienka '
  + 'uz este potom tam tu sa mi ti nam vam my vy ja ty on ona oni ono len iba asi mozno hej ok okej jasne prosim dakujem vdaka by '
  + 'mozes mozete mozeme mozem chces chcete chceme chcem treba musime musim musis dalo da daj dajte teda tiez vlastne bud '
  + 'hi hey hello so and but that we you i have has is are am there theres its our my the a an to for let lets dont forget '
  + 'remember will ll going gonna be please okay yeah then just also can could would wanna want shall should does do not see').split(' '));

// Words dropped from inside a title too: the verb of "X bude o 5" and parts of the day the time already holds.
const FILLER = new Set(('bude budeme budu je su sme mame mate mam is are rano doobeda dopoludnia poobede popoludni vecer veceri navecer morning afternoon evening tonight '
  + 'stretneme stretnime stretnem stretnes uvidime vidime zideme meet').split(' '));

const DAYPART = new RegExp(String.raw`\b(dnes|zajtra|pozajtra|today|tomorrow|pondelok|utorok|stredu|stvrtok|piatok|sobotu|nedelu|monday|tuesday|wednesday|thursday|friday|saturday|sunday`
  + String.raw`)\s(vecer|rano|poobede|popoludni|doobeda|dopoludnia|v noci|evening|morning|afternoon|night)\b`);
const CLAUSE = /[,;!?\n]|\.(?!\d)|\s(?:a|ale|potom|a potom|and|but|then)\s/g;
/** The words around a time, in its part of the sentence. */
function nearOf(x, t) {
  // The part of the day said in the same part of the sentence: "o 9:00 porada, večer kino" is 9 in the morning.
  const from = Math.max(x.at - 24, ...[...t.slice(0, x.at).matchAll(CLAUSE)].map((m) => m.index + m[0].length), 0);
  const to = Math.min(x.end + 24, ...[...t.slice(x.end).matchAll(CLAUSE)].map((m) => x.end + m.index), t.length);
  const near = t.slice(from, to);
  // A part of the day said with the day holds for the whole message: "zajtra večer, o 7 kino".
  return AM.test(near) || PM.test(near) || NIGHT.test(near) ? near : `${near} ${t.match(DAYPART)?.[2] || ''}`;
}
/** The clock time a match means, with the day's part from words around it. */
function clockOf(x, t) {
  if (x.fixed) return { h: x.h, m: x.m, eh: x.endH ?? null, em: x.endM || 0 };
  const near = nearOf(x, t);
  let h = x.h;
  const am = x.am || (!x.pm && AM.test(near));
  const pm = x.pm || (!am && PM.test(near));
  // "o 4:30" could be a flight or a training: with minutes and no part of the day, 1:00 to 6:59 offers nothing.
  if (x.minutes && !x.lead && !x.am && !x.pm && !am && !pm && !NIGHT.test(near) && h >= 1 && h <= 6) return null;
  // "o 1 v noci" is after midnight, a day the words do not name: no guess. "o 10 v noci" is 22:00.
  if (!x.am && !x.pm && NIGHT.test(near)) { if (h <= 5 || h === 12) return null; if (h < 12) h += 12; }
  if (x.pm && h === 12) h = 12;
  else if (x.am && h === 12) h = 0;
  else if (pm && h < 12) h += 12;
  else if (!am && !x.minutes && !x.lead && h >= 1 && h <= 6) h += 12; // "o 5" is five in the afternoon
  let eh = x.endH;
  if (eh != null) {
    if (!x.endFixed && eh < h && eh + 12 > h && eh + 12 <= 23) eh += 12; // "od 5 do 7" in the afternoon
    if (eh > 23 || eh * 60 + x.endM <= h * 60 + x.m) eh = null;
  }
  if (h > 23) return null;
  return { h, m: x.m, eh, em: x.endM };
}

/** The words of the message that name the event: its part with the time, without the time and filler words. */
function titleOf(text, spans) {
  let masked = text;
  for (const [a, b] of spans) masked = masked.slice(0, a) + '\u0000'.repeat(b - a) + masked.slice(b);
  const at = spans[0][0];
  // Sentences, then their parts between commas; the part with the time, or the next one when it held only the time.
  const pieces = [];
  const re = /(?:[^.!?\n;,]|(?<=[\d\u0000])\.(?= \p{Ll}))+[.!?\n;,]*/gu; // "o 2. svetovej vojne", "o 18 hod. tréning" are one piece
  for (const m of masked.matchAll(re)) pieces.push({ at: m.index, end: m.index + m[0].length, s: m[0] });
  const i = Math.max(0, pieces.findIndex((p) => at >= p.at && at < p.end));
  const clean = (s) => {
    let words = s.replace(/\u0000+/g, ' ').replace(/(^|\s)['’]s(?=\s|$)/g, ' ').replace(/(^|\s)[-–—]+(?=\s|$)/g, ' ').replace(/['‚‘’]/g, '').replace(/(?<!\d)\.+|\.(?=\s*$)|[!?;,:()"„“”]+/g, ' ').split(/\s+/).filter(Boolean);
    while (words.length && STOP.has(fold(words[0]))) words.shift();
    while (words.length && STOP.has(fold(words.at(-1)))) words.pop();
    words = words.filter((w) => !FILLER.has(fold(w)));
    // Leftover prepositions from a removed time ("v", "o") at the ends.
    while (words.length && /^(v|vo|o|na|at|on|in|od|do)$/i.test(words.at(-1))) words.pop();
    while (words.length > 1 && /^(v|vo|o|na|at|on|in|do|od|za|cez|from|over)$/i.test(words[0])) words.shift();
    while (words.length && !/[\p{L}\d]/u.test(words[0])) words.shift();
    while (words.length && !/[\p{L}\d]/u.test(words.at(-1))) words.pop();
    let out = words.join(' ');
    if (out.length > 60) out = out.slice(0, 60).replace(/\s+\S*$/, '');
    return /\p{L}{3}/u.test(out) ? out : '';
  };
  const sameSentence = (p, q) => !/[.!?\n;]/.test(masked.slice(Math.min(p.end, q.end) - 1, Math.max(p.at, q.at) + 1).replace(/\u0000/g, ''));
  let title = clean(pieces[i]?.s || '');
  if (!title && pieces[i + 1] && sameSentence(pieces[i], pieces[i + 1])) title = clean(pieces[i + 1].s);
  if (!title && pieces[i - 1] && sameSentence(pieces[i - 1], pieces[i])) title = clean(pieces[i - 1].s);
  return title ? title[0].toLocaleUpperCase() + title.slice(1) : null;
}

/** A time is meant when it is said as one: "o 5", "at 5", "5pm", "17:00" a whole or quarter hour, a range, "o 17-tej",
 *  or with a part of the day. "tipujem 9:10" and "preskoč na 12:34" are not. */
const said = (x, near) => x.prefixed || x.am || x.pm || x.word || x.hourMark || x.endH != null
  || AM.test(near) || PM.test(near) || NIGHT.test(near) || (x.minutes && x.m % 15 === 0 && (x.h >= 7 || x.lead));

export function findWhen(text, { ref = Date.now(), now = Date.now() } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 500) return null;
  // Typographic apostrophes as plain ones ("don’t"); links, and times inside them, are not plans.
  const plain = text.replace(/[’‘]/g, "'").replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, (u) => ' '.repeat(u.length));
  const t = fold(plain);
  // Over, repeating, or a clock that cannot be ("14pm").
  if (OVER.test(t) || MOVED_FROM.test(t) || /(?<![:.\d])\b(?:1[3-9]|2\d|00?)\s?(?:am|pm|a\.m\.|p\.m\.)(?!\w)/.test(t)) return null;
  const parsed = english(plain, t) ? englishFound(t, ref) : slovak(plain).parse(t, new Date(ref)).map((r) => ({ at: r.index, end: r.index + r.text.length, weft: r.weft }));
  const more = extras(t, ref);
  const own = more.filter((x) => x.weft.own);
  // Days only: "this weekend at 10:30" keeps its clock (and then names no one day).
  let found = [...parsed.filter((f) => f.weft.day == null || !own.some((x) => f.at < x.end && x.at < f.end)), ...more].sort((a, b) => a.at - b.at);
  // "budúci týždeň v utorok", "Tuesday next week": the weekday of the next week, also when said on a Monday.
  if (found.some((f) => f.weft.nextWeek)) found = found.map((f) => (f.weft.weekday ? { ...f, weft: { ...weekdayOf((new Date(f.weft.day).getDay() + 6) % 7, 'next', ref), weekday: true } } : f));
  // "od pondelka do stredy", "30. 11. – 2. 12.": two days joined as a range are the days between; a weekday that ends one
  // is the first after its start, also when it is today's.
  const pair = found.filter((f) => f.weft.day != null);
  const joined = pair.length === 2 && (/^\s*(?:-|–|—|do|az|to|till|until|through|thru)\s*$/.test(t.slice(pair[0].end, pair[1].at))
    || (/^\s*$/.test(t.slice(pair[0].end, pair[1].at)) && /^(?:do|az)\s/.test(t.slice(pair[1].at)))); // "do stredy" is the weekday's own match
  if (joined && !pair.some((f) => f.weft.endDay || f.weft.bad)) {
    const [a, b] = pair.map((f) => f.weft);
    const last = a.weekday && b.weekday ? addDays(a.day, (new Date(b.day).getDay() - new Date(a.day).getDay() + 7) % 7 || 7) : b.day;
    if (!(last > a.day && last - a.day <= 31 * DAY)) return null;
    found = [...found.filter((f) => !pair.includes(f)), { at: pair[0].at, end: pair[1].end, weft: { ...a, endDay: last, weekday: false } }];
  }
  // A date that cannot be or has just passed, a clock that cannot be, a weekday said on that day: no guess.
  if (found.some(({ weft: w }) => w.bad || w.unsure)) return null;
  let days = found.filter(({ weft: w }) => w.day != null).map(({ at, end, weft: w }) => ({ at, end, ...w }));
  // "this weekend, Saturday at 10:30": the day named inside the weekend is the one.
  let range = days.find((d) => d.endDay);
  // "next weekend, Saturday": the weekday is the weekend's, not the coming one.
  if (range) days = days.map((d) => {
    if (!d.weekday || (d.day >= range.day && d.day <= range.endDay)) return d;
    const day = addDays(range.day, (new Date(d.day).getDay() - new Date(range.day).getDay() + 7) % 7);
    return day <= range.endDay ? { ...d, day } : d;
  });
  const within = range && days.filter((d) => !d.endDay && d.day >= range.day && d.day <= range.endDay);
  const named = within?.length ? [[range.at, range.end]] : [];
  if (named.length) { days = days.filter((d) => d !== range); range = undefined; }
  let dayValues = [...new Set(days.map((d) => d.day))];
  // "v sobotu 28. 11.": a weekday that agrees with the written date is the same day.
  const dates = [...new Set(days.filter((d) => d.date).map((d) => d.day))];
  if (dayValues.length > 1 && dates.length === 1 && days.every((d) => d.date || (d.weekday && new Date(d.day).getDay() === new Date(dates[0]).getDay()))) dayValues = dates;
  if (dayValues.length > 1) return null;
  let clocks = found.filter(({ weft: w }) => w.h != null).map(({ at, end, weft: w }) => ({ x: { at, end, ...w }, c: clockOf({ at, end, ...w }, t) }))
    .filter(({ x }) => said(x, nearOf(x, t)));
  // A part of the day counts only without a written clock, said with its day: "v piatok poobede", "tomorrow morning".
  const written = clocks.filter(({ x }) => !x.part);
  const beside = (x, d) => (x.at < d.end && d.at < x.end) || /^[\s,]*(?:(?:v|vo|na|in the|on)\s+)?$/.test(x.at >= d.end ? t.slice(d.end, x.at) : t.slice(x.end, d.at));
  // "zajtra ráno a večer" names two.
  if (!written.length && new Set(clocks.map(({ x }) => x.h)).size > 1) return null;
  clocks = written.length ? written : clocks.filter(({ x }) => days.some((d) => beside(x, d)));
  if (clocks.some((y) => !y.c)) return null; // "o 12 v noci": which day is it?
  if (new Set(clocks.map(({ c }) => c.h * 60 + c.m)).size > 1) return null;
  const event = EVENT.test(t);
  const clock = clocks[0];
  if (range && clock) return null; // "cez víkend o 10:00": which of the days?
  let day = dayValues[0];
  if (day == null) {
    if (!clock || !event) return null;
    day = startOf(ref);
  }
  if (!clock && !event) return null;
  const spans = [...days.map((d) => [d.at, d.end]), ...clocks.map(({ x }) => [x.at, x.end]), ...found.filter((f) => f.weft.nextWeek).map((f) => [f.at, f.end]), ...named]
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  // A part of the day or "o 2 hodiny" is a plan when it names an event or a meeting, or is the whole message.
  if (clock && (clock.x.part || clock.x.relative) && !event && !MEET.test(t) && !alone(t, spans)) return null;
  const title = titleOf(plain, spans.length ? spans : [[days[0]?.at ?? 0, days[0]?.at ?? 0]]);
  // An end word means only the end ("končí cez víkend"). With a span written out ("runs from 3 until 5", "končí zajtra
  // medzi 3 a 5") it may be a plan or the end window, so the judge decides.
  const ends = END.test(t);
  if (ends && !(range && !range.weekend) && !(clock && clock.c.eh != null && !clock.x.part)) return null;
  const doubt = DOUBT.test(t) || PAST.test(t) || ends || found.some((f) => f.weft.doubtful);
  if (!clock) {
    if (day < startOf(now)) return null;
    return { start: new Date(day), end: range ? new Date(range.endDay) : null, allDay: true, title, doubt };
  }
  const d = new Date(day);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), clock.c.h, clock.c.m);
  if (start.getTime() <= now || start.getTime() < ref - 60e3) return null;
  // A clock the day skips (2:30 when summer time begins) is no guess.
  if (start.getHours() !== clock.c.h || start.getMinutes() !== clock.c.m) return null;
  const end = clock.c.eh == null ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate(), clock.c.eh, clock.c.em);
  if (end && (end.getHours() !== clock.c.eh || end.getMinutes() !== clock.c.em)) return null;
  return { start, end, allDay: false, title, doubt };
}

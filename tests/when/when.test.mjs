// The corpus for app/when.js: sentences that must offer a calendar entry, with what it holds, and sentences that
// must offer none. Run: node --test tests/when/when.test.mjswhen.test.mjs
process.env.TZ = 'Europe/Bratislava'; // Karchi's clock; read before the first date is made
import test from 'node:test';
import assert from 'node:assert/strict';
import { findWhen } from '../../app/when.js';

// Wednesday 18 November 2026, 10:00: Thursday is the 19th, Friday the 20th, next week's Monday the 23rd.
const REF = new Date(2026, 10, 18, 10, 0).getTime();
const at = (d, h = null, m = 0) => (h == null ? new Date(2026, 10, d) : new Date(2026, 10, d, h, m));

// [text, start (day of November, or a Date), hour, minute, { end, allDay, title }]
const YES = [
  ['zajtra o 17:00 tréning', 19, 17, 0, { title: 'Tréning' }],
  ['v piatok test z mat', 20, null, 0, { allDay: true, title: 'Test z mat' }],
  ['28. 11. o 9:00', 28, 9, 0, { title: null }],
  ['Ahoj, nezabudni že zajtra o 17:00 máme tréning na štadióne', 19, 17, 0, { title: 'Tréning na štadióne' }],
  ['Zajtra o 5 sa stretneme pri fontáne', 19, 17, 0, {}],
  ['V sobotu o 19:30 oslava u Jany', 21, 19, 30, { title: 'Oslava u Jany' }],
  ['dnes o 18h kino?', 18, 18, 0, { title: 'Kino' }],
  ['Pozajtra od 14:00 do 16:00 konzultácia', 20, 14, 0, { end: [20, 16, 0], title: 'Konzultácia' }],
  ['budúci pondelok o 8:00 písomka z fyziky', 23, 8, 0, { title: 'Písomka z fyziky' }],
  ['v pondelok o 8:00 písomka z fyziky', 23, 8, 0, {}],
  ['Stretnutie bude 25. 11. o 15:30 v kancelárii', 25, 15, 30, { title: 'Stretnutie v kancelárii' }],
  ['25.11.2026 o 10:00 porada', 25, 10, 0, { title: 'Porada' }],
  ['Maturitný ples je 5. decembra', at(5).setMonth(11), null, 0, { allDay: true }],
  ['do piatka treba odovzdať projekt', 20, null, 0, { allDay: true, title: 'Odovzdať projekt' }],
  ['Vo štvrtok o 7 večer hráme zápas', 19, 19, 0, {}],
  ['zajtra ráno o 7:30 lekár', 19, 7, 30, { title: 'Lekár' }],
  ['tréning o 17:00', 18, 17, 0, { title: 'Tréning' }],
  ['Zajtra 16:00–17:30 hodina klavíra', 19, 16, 0, { end: [19, 17, 30] }],
  ['v nedeľu o 10:00 omša', 22, 10, 0, { title: 'Omša' }],
  ['Na 17:00 zajtra, ok?', 19, 17, 0, {}],
  ['Narodeniny mám 3. 12.', at(3).setMonth(11), null, 0, { allDay: true }],
  ['tento piatok o 20:00 koncert', 20, 20, 0, { title: 'Koncert' }],
  ['zajtra o 17-tej tréning', 19, 17, 0, {}],
  ['Skúška bude 2026-12-02 o 9:00', new Date(2026, 11, 2).getTime(), 9, 0, { title: 'Skúška' }],
  ['môžeš zajtra o 17:00?', 19, 17, 0, {}],
  ['V piatok o 5 poobede výlet', 20, 17, 0, {}],
  // English
  ['tomorrow at 5pm dinner', 19, 17, 0, { title: 'Dinner' }],
  ['Meeting on Friday at 10:30', 20, 10, 30, { title: 'Meeting' }],
  ['Next Monday 9am interview', 23, 9, 0, { title: 'Interview' }],
  ['Exam on November 27', 27, null, 0, { allDay: true, title: 'Exam' }],
  ['Party at my place on Saturday from 8 to 11 pm', 21, 20, 0, { end: [21, 23, 0] }],
  ["Let's have lunch tomorrow at 12:30", 19, 12, 30, {}],
  ['Dentist appointment 30th November 3:15pm', 30, 15, 15, {}],
  ['tonight at 7 movie?', 18, 19, 0, {}],
  ['Dec 4 at 18:00 concert', new Date(2026, 11, 4).getTime(), 18, 0, { title: 'Concert' }],
  ['Training today 6pm', 18, 18, 0, { title: 'Training' }],
  // the council's sentences
  ['zajtra o pol 6 tréning', 19, 17, 30, { title: 'Tréning' }],
  ['v piatok o štvrť na 8 ráno zraz', 20, 7, 15, {}],
  ['zajtra o trištvrte na 5 u zubára', 19, 16, 45, { title: 'U zubára' }],
  ['v sobotu o šiestej večer oslava', 21, 18, 0, { title: 'Oslava' }],
  ['zajtra o pol šiestej?', 19, 17, 30, {}],
  ['zajtra na obed?', 19, 12, 0, {}],
  ['Nezabudni na test v piatok', 20, null, 0, { allDay: true, title: 'Test' }],
  ["Don't forget the test on Friday", 20, null, 0, { allDay: true, title: 'Test' }],
  ['mali by sme ísť v piatok o 5 do kina', 20, 17, 0, {}],
  ['28.11 o 9 porada', 28, 9, 0, { title: 'Porada' }],
  ['od 5 do 7 tréning zajtra', 19, 17, 0, { end: [19, 19, 0], title: 'Tréning' }],
  ['Ples bude v sobotu 28. 11.', 28, null, 0, { allDay: true, title: 'Ples' }],
  ['zajtra o druhej hodine písomka', 19, null, 0, { allDay: true }], // the second lesson, not 14:00
  ['zajtra o 3. hodine písomka', 19, null, 0, { allDay: true }],
  ['zajtra o 3.  hodine písomka', 19, null, 0, { allDay: true }],
  ['tonight at 9 party', 18, 21, 0, {}],
  ['o 10 v noci zajtra party', 19, 22, 0, {}],
  ['urob 3. 4. úlohu, zajtra o 8:00 písomka', 19, 8, 0, { title: 'Písomka' }],
  ['tomorrow from 8 am to 12 am party', 19, 8, 0, {}], // the end before the start is left out
  // "o" with a number and a noun is a topic, not a time: the test is all day
  ['Zajtra píšeme test o 2. svetovej vojne', 19, null, 0, { allDay: true, title: 'Píšeme test o 2. svetovej vojne' }],
  // the verifier's third round
  ['Zajtra 17.00 tréning', 19, 17, 0, { title: 'Tréning' }],
  ['Tréning zajtra 17–18', 19, 17, 0, { end: [19, 18, 0], title: 'Tréning' }],
  ['Tomorrow 5-7 pm practice', 19, 17, 0, { end: [19, 19, 0], title: 'Practice' }],
  ['V pondelok máme diktát zo slovenčiny', 23, null, 0, { allDay: true, title: 'Diktát zo slovenčiny' }],
  ['Meet at 5:30 tomorrow after school?', 19, 17, 30, {}],
  ['zajtra test o 5 otázkach', 19, null, 0, { allDay: true, title: 'Test o 5 otázkach' }],
  ['zajtra písomka o 20 slovíčkach', 19, null, 0, { allDay: true }],
  ['zajtra test o 3 kapitolách', 19, null, 0, { allDay: true }],
  ['do piatku odovzdať projekt', 20, null, 0, { allDay: true, title: 'Odovzdať projekt' }],
  ['zajtra o 5.', 19, 17, 0, {}],
  ['zajtra o 5 🙂', 19, 17, 0, {}],
  // the second round: commas, colons, dashes, parts of the day in another clause
  ['zajtra o 9:00 porada, večer kino', 19, 9, 0, { title: 'Porada' }],
  ['zajtra ráno o 7:00 odchod, večer návrat', 19, 7, 0, {}],
  ['zajtra o 17:00, dobre?', 19, 17, 0, {}],
  ['v piatok o 9:00, budem tam', 20, 9, 0, {}],
  ['zajtra o 17:00: tréning', 19, 17, 0, { title: 'Tréning' }],
  ['zajtra o 17:00 – tréning', 19, 17, 0, { title: 'Tréning' }],
  ['😊 zajtra o 17:00 tréning', 19, 17, 0, { title: 'Tréning' }],
  ['zajtra o tri štvrte na 5 tréning', 19, 16, 45, { title: 'Tréning' }],
  ['zajtra do 17:00 odovzdať úlohu', 19, 17, 0, { title: 'Odovzdať úlohu' }],
  // the third round
  ['Zajtra tréning od 17.00 do 19.00.', 19, 17, 0, { end: [19, 19, 0], title: 'Tréning' }],
  ['Zajtra o 9:00 porada a večer kino', 19, 9, 0, {}],
  // the third round's Opus
  ['zajtra o 18 hod. tréning v telocvični', 19, 18, 0, { title: 'Tréning v telocvični' }],
  ['Tréning bude zajtra o 18 h. v hale', 19, 18, 0, {}],
  ['Zajtra o 5. Tešíme sa', 19, 17, 0, {}],
  // the verifier's third round
  ['zajtra test o 5 otázkach', 19, null, 0, { allDay: true, title: 'Test o 5 otázkach' }], // a test, at no time
  ['zajtra o 5 máme tréning', 19, 17, 0, { title: 'Tréning' }],
  ['zajtra o 5 hráme futbal', 19, 17, 0, {}],
  ['tomorrow at 5 see you', 19, 17, 0, {}],
  ['zajtra večer, o 7 kino', 19, 19, 0, { title: 'Kino' }],
  ['zajtra o 4:30 ráno na letisko', 19, 4, 30, {}],
  ['zajtra o 04:30 na letisko', 19, 4, 30, {}],
  ['do not forget the test on Friday', 20, null, 0, { allDay: true, title: 'Test' }],
  // Sol's first round
  ['Zajtra 06:00 tréning', 19, 6, 0, { title: 'Tréning' }],
  ['November 27 at 9:00 exam', 27, 9, 0, { title: 'Exam' }],
  ['Practice Dec 4', at(4).setMonth(11), null, 0, { allDay: true, title: 'Practice' }],
  ['November 24 at 12:00 exam', 24, 12, 0, { title: 'Exam' }],
  ['Na 17:10 zajtra, ok?', 19, 17, 10, {}],
  ['Test je na 20.11.', 20, null, 0, { allDay: true, title: 'Test' }],
  ['Tréning zajtra na 17.00.', 19, 17, 0, { title: 'Tréning' }],
  // Karchi's edge sentences (19. 11.): a bare hour is the afternoon's
  ['zajtra o 5', 19, 17, 0, { title: null }],
  ['tomorrow at 5', 19, 17, 0, { title: null }],
  ['see you tomorrow at 5', 19, 17, 0, { title: null }],
  ['12.12. o 18:00', at(12).setMonth(11), 18, 0, { title: null }],
  ['12. 12. o 18:00 vianočný večierok', at(12).setMonth(11), 18, 0, { title: 'Vianočný večierok' }],
  ['Dec 12 at 6pm party', at(12).setMonth(11), 18, 0, { title: 'Party' }],
  // a part of the day said with its day stands for its hours
  ['v piatok poobede', 20, 13, 0, { end: [20, 17, 0], title: null }],
  ['v piatok poobede tréning', 20, 13, 0, { end: [20, 17, 0], title: 'Tréning' }],
  ['v piatok poobede sa stretneme', 20, 13, 0, { end: [20, 17, 0], title: null }],
  ['Môžeš v piatok poobede?', 20, 13, 0, { end: [20, 17, 0] }],
  ['zajtra ráno lekár', 19, 8, 0, { end: [19, 12, 0], title: 'Lekár' }],
  ['dnes večer kino', 18, 18, 0, { end: [18, 21, 0], title: 'Kino' }],
  ['Friday afternoon practice', 20, 13, 0, { end: [20, 17, 0], title: 'Practice' }],
  ["let's meet Friday afternoon", 20, 13, 0, { end: [20, 17, 0], title: null }],
  ['dinner tonight', 18, 18, 0, { end: [18, 21, 0], title: 'Dinner' }],
  ['tomorrow morning dentist', 19, 8, 0, { end: [19, 12, 0], title: 'Dentist' }],
  // a greeting is no part of the day
  ['Dobré ráno, zajtra test z matiky', 19, null, 0, { allDay: true, title: 'Test z matiky' }],
  ['Good morning! Exam on Friday', 20, null, 0, { allDay: true, title: 'Exam' }],
  // next week's weekday (said on a Wednesday; a Monday is below)
  ['budúci týždeň v utorok o 17:00 tréning', 24, 17, 0, { title: 'Tréning' }],
  ['v utorok budúci týždeň o 9:00 porada', 24, 9, 0, { title: 'Porada' }],
  ['na budúci týždeň v pondelok o 8:00 písomka', 23, 8, 0, { title: 'Písomka' }],
  ['next week on Tuesday at 5pm practice', 24, 17, 0, { title: 'Practice' }],
  // in two hours from the message (10:00), to five minutes
  ['o 2 hodiny', 18, 12, 0, { title: null }],
  ['o 2 hodiny tréning', 18, 12, 0, { title: 'Tréning' }],
  ['za hodinu tréning', 18, 11, 0, { title: 'Tréning' }],
  ['o pol hodiny porada', 18, 10, 30, { title: 'Porada' }],
  ['za hodinu a pol sa stretneme', 18, 11, 30, {}],
  ['in 2 hours meeting', 18, 12, 0, { title: 'Meeting' }],
  ['in an hour meeting', 18, 11, 0, { title: 'Meeting' }],
  ['meeting in about two hours', 18, 12, 0, { title: 'Meeting' }],
  ['O dve hodiny tréning, vezmi si hotovosť.', 18, 12, 0, {}],
  ['The party is still on tomorrow at 8pm.', 19, 20, 0, {}],
  ['Zajtra o 14:00 tréning, vezmi si hotovosť.', 19, 14, 0, {}],
  ['porada asi o 2 hodiny', 18, 12, 0, { title: 'Porada' }],
  // a weekend, and a few days in a row, all day
  ['cez víkend ideme na výlet', 21, null, 0, { allDay: true, end: [22], title: 'Výlet' }],
  ['tento víkend oslava', 21, null, 0, { allDay: true, end: [22], title: 'Oslava' }],
  ['budúci víkend turnaj', 28, null, 0, { allDay: true, end: [29], title: 'Turnaj' }],
  ['this weekend hiking trip', 21, null, 0, { allDay: true, end: [22], title: 'Hiking trip' }],
  ['next weekend tournament', 28, null, 0, { allDay: true, end: [29], title: 'Tournament' }],
  ['od 23. do 25. 11. sústredenie', 23, null, 0, { allDay: true, end: [25], title: 'Sústredenie' }],
  ['23.–25. 11. sústredenie', 23, null, 0, { allDay: true, end: [25], title: 'Sústredenie' }],
  ['od 30. 11. do 2. 12. sústredenie', 30, null, 0, { allDay: true, end: [32], title: 'Sústredenie' }],
  ['od pondelka do stredy sústredenie', 23, null, 0, { allDay: true, end: [25], title: 'Sústredenie' }],
  ['od pondelka do piatku tábor', 23, null, 0, { allDay: true, end: [27], title: 'Tábor' }],
  ['Nov 23-25 conference', 23, null, 0, { allDay: true, end: [25], title: 'Conference' }],
  ['from Monday to Wednesday training camp', 23, null, 0, { allDay: true, end: [25], title: 'Training camp' }],
  ['Školenie od štvrtka do soboty', 19, null, 0, { allDay: true, end: [21], title: 'Školenie' }],
  ['Workshop Nov 24-26', 24, null, 0, { allDay: true, end: [26], title: 'Workshop' }],
  // a day named inside the weekend is the one; "come over" is no shift
  ['This weekend, Saturday at 10:30 practice', 21, 10, 30, { title: 'Practice' }],
  ['cez víkend v sobotu o 10:00 turnaj', 21, 10, 0, { title: 'Turnaj' }],
  ['Next weekend, Saturday at 10:30 practice', 28, 10, 30, { title: 'Practice' }],
  ['budúci víkend v nedeľu o 10:00 omša', 29, 10, 0, { title: 'Omša' }],
  // ranges of hours
  ['zajtra medzi 5 a 7', 19, 17, 0, { end: [19, 19, 0] }],
  ['zajtra medzi 17:00 a 18:30 konzultácia', 19, 17, 0, { end: [19, 18, 30], title: 'Konzultácia' }],
  ['tomorrow between 5 and 7 practice', 19, 17, 0, { end: [19, 19, 0], title: 'Practice' }],
  ['zajtra 17:00 - 19:00 tréning', 19, 17, 0, { end: [19, 19, 0], title: 'Tréning' }],
  ['zajtra 17 – 19 h tréning', 19, 17, 0, { end: [19, 19, 0], title: 'Tréning' }],
  ['tomorrow from 17:00 to 19:00 meeting', 19, 17, 0, { end: [19, 19, 0], title: 'Meeting' }],
];

const NO = [
  'o 5 minút som tam', // an amount of minutes
  'prídem o 10 minút',
  'zajtra ti to pošlem', // a day, no time, no event
  'v piatok som bol v kine', // past
  'Včera o 17:00 bol tréning',
  'minulý piatok sme mali test',
  'zajtra o 17:00 nemôžem', // refused
  'Tréning zajtra o 17:00 je zrušený', // cancelled
  'zajtra nebude tréning',
  'stojí to 28.11 €', // a price
  'mám 17:00 hodín roboty', // not a clock time... has no day either
  'skóre bolo 2:1',
  'verzia 1.2.3 je vonku',
  'Kúpil som to 12. 11.', // a recent past date
  'pozri https://example.com/2026/11/28/zajtra-o-17-00',
  'o 17:00?', // a time alone
  'dnes alebo zajtra o 17:00?', // two days
  'zajtra o 17:00 alebo o 18:00', // two times
  "I can't make it tomorrow at 5",
  'The meeting was on Friday at 10',
  'see you in 5 minutes',
  'it costs 5 euros tomorrow',
  'Friday was great',
  'I had an exam yesterday',
  'tomorrow is fine', // a day, no time, no event
  'v utorok som mal test', // past
  'piatka z matiky', // a grade, not Friday
  'čakám od 9 do 5 rokov', // not times
  'o 2 hodiny som doma',
  'Meeting cancelled tomorrow at 3pm',
  // the council's sentences
  'zápas skončil 2:1',
  'urob 3. 4. úlohu',
  'každý piatok o 17:00 tréning', // a series
  'Every Monday at 6pm training',
  'tonight at 1 we go out', // after midnight: which day?
  'zajtra o 1 v noci',
  'budúci týždeň test',
  'o týždeň sa vidíme',
  'v pondelok 24. 11. o 9:00 porada? nie, v utorok', // two days
  'zajtra o 5 eur lacnejšie',
  'mám 5 rokov, nie o 5',
  // the second round
  'Skúška 31. 11. o 15:00', // no such day: no guess
  'skúška 29. 2.',
  'Zajtra od 17:00 do 18:75 tréning', // no such minute
  'Zajtra o 17:75 tréning',
  'Zajtra o 17:00 nie je tréning',
  'zajtra nemáme tréning',
  'tomorrow at 5pm no meeting',
  'I will not come tomorrow at 5',
  'zajtra o 12 v noci', // midnight: which day?
  'Zajtra o 12 v noci tréning',
  'Tomorrow at 5pm no meetings',
  'Tomorrow at 5pm no  meeting',
  // the verifier's sentences
  'Zajtra tipujem výsledok 2:10', // a score
  'Tomorrow at 5pm the meeting is off',
  'Tomorrow at 14pm meeting',
  'pozajtra o polnoci tréning', // midnight: which day?
  'zajtra o 4:30 tréning', // half past four: morning or afternoon?
  'zajtra o 2:30 na letisko',
  'v utorku o 17:00 tréning', // a slip: no day is guessed
  'zajtra zdražie o 5 centov',
  'tomorrow about 5 guys are coming',
  // the verifier's third round
  'Zajtrajší tréning sa presúva, čas ešte nevieme',
  "Tomorrow's practice is postponed",
  "Tomorrow we don't have practice",
  'Zajtra tipujem 9:10',
  'Zajtra ti pošlem video, preskoč na 12:34',
  'zajtra ti pošlem test z matiky',
  // the verifier's second round
  'Zajtra tipujem výsledok 9:10',
  'Zajtra budeme mať o 5 odpovedí viac',
  // the verifier's fourth round
  'Zajtra klikni na 12:30 vo videu',
  'Zajtra sa rozpočet zmení na 20.50 eur',
  'I paid 12.50 for the bus ticket yesterday',
  // the verifier's fifth round
  'I moved the appointment from Friday at 5 pm, still waiting for the new time',
  'Dentist moved from Friday at 5 pm to Monday at 9 am',
  'Tréning presunuli zo štvrtka o 17:00, nový čas pošlem',
  'Tomorrow, look at 12:30 in the video',
  'Tomorrow at 12:30 in the song',
  'Zajtra je to na 12:30  vo videu',
  'Tomorrow at 12:30 in   the video',
  'Zajtra je to na 13:30 vo   videu',
  // Karchi's edge sentences (19. 11.): the past
  'včera o 5',
  'včera o 5 bol tréning',
  'yesterday at 5',
  'predvčerom o 17:00 porada',
  'minulý týždeň v utorok o 17:00 porada',
  'last Friday at 5 meeting',
  'pred 2 hodinami bola porada',
  // a weekend, a part of the day or hours without a plan; a weekend with a time
  'cez víkend',
  'cez víkend o 10:00 turnaj',
  'dnes večer som unavený',
  'zajtra ráno a večer tréning', // two parts of the day
  // a shift, a length or a price is no time
  'prídem o hodinu neskôr',
  'tréning posunuli o hodinu',
  'zarábam 5 eur za hodinu',
  // the verifier's round on these: a weekend with a clock, a weekend named as no time, an end in an hour
  'This weekend at 10:30 practice',
  'Weekend practice footage looks great.',
  'The weekend practice footage looks great.',
  'Practice will be over in an hour.', // an end, not a start
  "It's over in an hour, then dinner",
  'The workshop will be over in an hour.',
  'The workshop will probably be over in an hour.',
  'The meetings are over in an hour.',
  'They said practice will probably be over in an hour.',
  'The meeting we booked should probably be over in an hour.',
  'Konzultácia is over in an hour',
  'cez víkend v pondelok o 10:00 turnaj', // Monday is no day of the weekend
  'Za hodinu končí tréning.',
  // two days that are no range, a range that cannot be
  'od 23. do 25. 13. sústredenie',
  'Zrušili sme tréning v piatok o 17:00, nový termín je v sobotu o 10:00',
  // cancelled: only the judge could let these through
  'zajtra odpadá tréning',
  'tréning v piatok o 5 odpadol',
  'Zajtra o 9:00 sa porada neuskutoční',
  'Meeting tomorrow at 3 is cancelled',
  "Tomorrow's practice is called off",
  "We're skipping practice tomorrow at 5",
];

for (const [text, day, h, m, o] of YES) {
  test(`yes: ${text}`, () => {
    const w = findWhen(text, { ref: REF, now: REF });
    assert.ok(w, 'expected a suggestion');
    assert.equal(w.doubt, false, 'not doubted');
    const want = typeof day === 'number' && day > 1000 ? new Date(day) : at(day);
    if (h != null) want.setHours(h, m);
    assert.equal(w.start.getTime(), want.getTime(), `start ${w.start}`);
    assert.equal(w.allDay, !!o.allDay);
    if (o.end) assert.equal(w.end?.getTime(), at(...o.end).getTime(), `end ${w.end}`);
    else assert.equal(w.end, null);
    if ('title' in o) assert.equal(w.title, o.title);
  });
}

// Without the judge on asus a doubted plan is not offered either.
const offered = (w) => (w && !w.doubt ? w : null);
for (const text of NO) test(`no: ${text}`, () => assert.equal(offered(findWhen(text, { ref: REF, now: REF })), null));

// Says only when something ends or that it is still going: no suggestion, and the judge is not asked.
for (const text of ['Tréning končí o 14:00, za štyri hodiny.', 'Tréning končí o 14:00.', 'The meeting ends at 3pm.', 'Practice runs at least until 5pm.', 'Practice is still going at 5pm.', 'Tréning sa neskončí skôr než zajtra o 17:00.', 'Practice runs right up until tomorrow at 3pm.', 'Practice will continue until tomorrow at 4pm.', 'Tréning sa ukončí o 14:00.', 'Tréning ukončíme o 15:00.', 'The meeting is done at 3pm.', 'Practice runs until tomorrow at 3pm.', 'The party goes on until 11pm.', 'Koniec tréningu o 16:00.', 'Tréning trvá do 16:00.', 'Tréning potrvá do 17:00.', 'Practice wraps up at 5pm.', 'The party closes at 11pm.', 'Practice runs a little longer today, until 5pm.', 'Tréning beží do 17:00.', 'Kurz končí v piatok.', 'Kurz končí cez víkend.', 'Turnaj končí tento víkend.', 'Školenie končí budúci víkend.', 'Školenie končí v piatok poobede.', 'The conference ends tomorrow.', 'O 17:00 ešte beží tréning.']) {
  test(`end: ${text}`, () => assert.equal(findWhen(text, { ref: REF, now: REF }), null));
}

// Plans that may be refused or moved: the judge on asus decides, so they come with `doubt`.
for (const text of ['Come over in an hour for dinner.', 'Practice runs from 3 until 5 tomorrow.', 'Kurz od pána Nováka končí zajtra medzi 3 a 5.', 'Krúžok končí zajtra medzi 3 a 5, mám to od mamy.', 'Kurz končí od 23. do 25. 11.', 'Kurz končí zajtra medzi 3 a 5.', 'Sústredenie trvá od 23. do 25. 11.', 'The workshop ends between 3 and 4 tomorrow.', 'Tréning zajtra o 5, trvá dve hodiny.', "I'll be over in two hours for dinner.", 'We will all probably be over in an hour for dinner.', 'The interview with you will be over in an hour.', 'The interview with you will be over—in an hour.', 'The workshop will be over, in two hours.', 'Practice will be over (in three hours).', 'The interview will be over soon, in an hour.', 'Practice will be over at 11am, in an hour.', 'Practice will be over at 11am.', 'Practice will be over at 12pm, in about two hours.', 'Tréning pokračuje zajtra o 16:00.', 'Dokončíme to zajtra o 15:00.', 'Hotovo bude zajtra o 15:00.', 'zajtra odpadá tréning', 'Zajtra o 9:00 sa porada neuskutoční', 'Meeting tomorrow at 3 is cancelled', 'Krúžok presunuli na štvrtok o 16:00', 'Tomorrow we don’t have practice', 'Zajtra o 17:00 tréning, nemôžem ostať dlho', 'My appointment was moved to tomorrow at 5 pm', 'Tréning zajtra o 17:00 je zrušený']) {
  test(`doubt: ${text}`, () => assert.equal(findWhen(text, { ref: REF, now: REF })?.doubt, true));
}

test('a place in a video is no time, not even for the judge', () => {
  for (const text of ['Zajtra ti pošlem video, preskoč na 12:34', 'Zajtra ti pošlem video, preskoč na 12:30', 'zajtra si to pretoč na 13:00', 'Zajtra pošlem video, preskoč na  12:30', 'Zajtra pošlem video, preskoč rovno na 12:34']) {
    assert.equal(findWhen(text, { ref: REF, now: REF }), null, text);
  }
});

test('relative words count from when the message was sent', () => {
  const sent = new Date(2026, 10, 16, 9, 0).getTime(); // Monday
  const w = findWhen('zajtra o 17:00 tréning', { ref: sent, now: sent });
  assert.equal(w.start.getTime(), at(17, 17).getTime());
});

test('a time already over offers nothing', () => {
  const sent = new Date(2026, 10, 16, 9, 0).getTime();
  assert.equal(findWhen('zajtra o 17:00 tréning', { ref: sent, now: REF }), null);
  assert.equal(findWhen('dnes test z mat', { ref: sent, now: REF }), null);
});

test('a weekday said on that day is no guess, unless it says this one', () => {
  const friday = new Date(2026, 10, 20, 9, 0).getTime();
  assert.equal(findWhen('v piatok o 18:00 kino', { ref: friday, now: friday }), null);
  assert.equal(findWhen('tento piatok o 18:00 kino', { ref: friday, now: friday }).start.getTime(), at(20, 18).getTime());
});

test('a date without a year counts from the message: 15. 1. in December is next January', () => {
  const dec = new Date(2026, 11, 20, 9, 0).getTime();
  assert.equal(findWhen('skúška 15. 1. o 9:00', { ref: dec, now: dec }).start.getTime(), new Date(2027, 0, 15, 9).getTime());
});

test('a date long past without a year is next year\'s', () => {
  const w = findWhen('skúška 5. 1. o 8:00', { ref: REF, now: REF });
  assert.equal(w.start.getTime(), new Date(2027, 0, 5, 8).getTime());
});

test('29. 2. said in December is the next leap year\'s', () => {
  const dec = new Date(2023, 11, 20, 9, 0).getTime();
  assert.equal(findWhen('skúška 29. 2. o 9:00', { ref: dec, now: dec }).start.getTime(), new Date(2024, 1, 29, 9).getTime());
});

test('29. 2. said in a December before a year without one is a slip', () => {
  const dec = new Date(2026, 11, 20, 9, 0).getTime();
  assert.equal(findWhen('29. 2. o 17:00 tréning', { ref: dec, now: dec }), null);
});

test('next week\'s weekday said on a Monday is not tomorrow', () => {
  const monday = new Date(2026, 10, 16, 9, 0).getTime();
  for (const text of ['budúci týždeň v utorok o 17:00 tréning', 'Tuesday next week at 9 meeting', 'budúci týždeň v utorok písomka']) {
    assert.equal(findWhen(text, { ref: monday, now: monday }).start.getDate(), 24, text);
  }
  assert.equal(findWhen('v utorok o 17:00 tréning', { ref: monday, now: monday }).start.getDate(), 17);
});

test('a weekend said on Saturday is this one, on Sunday what is left of it', () => {
  const sat = new Date(2026, 10, 21, 9, 0).getTime();
  const sun = new Date(2026, 10, 22, 9, 0).getTime();
  const w = findWhen('cez víkend ideme na výlet', { ref: sat, now: sat });
  assert.deepEqual([+w.start, +w.end], [+at(21), +at(22)]);
  const v = findWhen('cez víkend ideme na výlet', { ref: sun, now: sun });
  assert.deepEqual([+v.start, v.end], [+at(22), null]);
  assert.deepEqual([+findWhen('budúci víkend turnaj', { ref: sat, now: sat }).start], [+at(28)]);
});

test('a range of weekdays that ends today ends a week on', () => {
  // Said on Wednesday: "do stredy" is next week's Wednesday, after Monday.
  const w = findWhen('od pondelka do stredy sústredenie', { ref: REF, now: REF });
  assert.deepEqual([+w.start, +w.end], [+at(23), +at(25)]);
});

test('an hour shown later in the day: "o 2 hodiny" at 23:00 is tomorrow', () => {
  const late = new Date(2026, 10, 18, 23, 0).getTime();
  assert.equal(+findWhen('o 2 hodiny sa stretneme', { ref: late, now: late }).start, +new Date(2026, 10, 19, 1, 0));
});

// Karchi's clock is Europe/Bratislava (TZ above): the hour written is the hour on the wall, summer time or winter.
test('summer time ending between the message and the day keeps the written hour', () => {
  const fri = new Date(2026, 9, 23, 10, 0).getTime(); // Friday; summer time ends on Sunday the 25th
  for (const text of ['v pondelok o 9:00 porada', 'Monday at 9am meeting']) {
    assert.equal(findWhen(text, { ref: fri, now: fri }).start.toISOString(), '2026-10-26T08:00:00.000Z', text); // 9:00 CET
  }
  const thu = new Date(2026, 9, 22, 10, 0).getTime();
  assert.equal(findWhen('v piatok o 9:00 porada', { ref: thu, now: thu }).start.toISOString(), '2026-10-23T07:00:00.000Z'); // 9:00 CEST
});

test('a clock summer time skips is no guess', () => {
  const fri = new Date(2027, 2, 26, 10, 0).getTime(); // summer time begins on Sunday 28 March at 2:00
  assert.equal(findWhen('v nedeľu o 2:30 ráno odchod', { ref: fri, now: fri }), null);
  assert.equal(findWhen('Sunday at 2:30am flight', { ref: fri, now: fri }), null);
  assert.equal(findWhen('March 28, 2027 between 1:30am and 2:40am practice', { ref: fri, now: fri }), null); // an end it skips too
  assert.equal(findWhen('v nedeľu od 1:30 do 2:40 ráno tréning', { ref: fri, now: fri }), null);
  assert.equal(findWhen('v nedeľu o 10:00 omša', { ref: fri, now: fri }).start.toISOString(), '2027-03-28T08:00:00.000Z'); // 10:00 CEST
});

test('a cancellation said before the time is still for the judge only', () => {
  const early = new Date(2026, 10, 18, 7, 0).getTime();
  assert.equal(findWhen('porada o 9:00 sa ruší', { ref: early, now: early }).doubt, true);
});

test('long texts are not read', () => assert.equal(findWhen(`zajtra o 17:00 tréning ${'x'.repeat(500)}`, { ref: REF, now: REF }), null));

test('the corpus is large enough', () => assert.ok(YES.length + NO.length >= 40));

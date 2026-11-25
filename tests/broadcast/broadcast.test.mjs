// Rozoslať's parts without a window (app/broadcast.js): run with `node --test tests/broadcast/`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { firstName, guessGreeting, personalText, laterItemsOf, addOnce, dayCounts, guessRsvp, batchOf, BC_DAY } from '../../app/broadcast.js';

test('the greeting is guessed from the first name, a title stays whole', () => {
  assert.equal(guessGreeting('Janka Testová'), 'Ahoj Janka,');
  assert.equal(firstName('p. Skúšobná'), 'p. Skúšobná');
});

test('each person gets the template with their greeting, name and extra sentence after the first paragraph', () => {
  const t = { key: '@a:x', name: 'Peter Vzorový', greeting: 'Čau Peťo,', extra: 'Ty by si mohol robiť foto?' };
  assert.equal(personalText('{oslovenie}\n\nv sobotu robíme akciu, {meno}.\n\nPríď!', t),
    'Čau Peťo,\n\nTy by si mohol robiť foto?\n\nv sobotu robíme akciu, Peter.\n\nPríď!');
  assert.equal(personalText('{oslovenie} príď', { ...t, extra: 'Ďakujem.' }), 'Čau Peťo, príď\n\nĎakujem.');
});

const bc = { id: 'b1', text: '{oslovenie}\n\noznam', files: [{ msgtype: 'm.image', body: 'p.png', url: 'mxc://x/1' }],
  to: [{ key: '@a:x', name: 'A', room: '!a', net: 'messenger', greeting: 'Ahoj A,' }, { key: 'merge:g', name: 'B', room: '!b', net: 'whatsapp', greeting: 'Ahoj B,' }] };

test('a confirmation writes a batch per person, 25–70 s apart, with ids that do not change', () => {
  const { items, at } = laterItemsOf(bc, 1000, () => 0.5);
  assert.deepEqual(items.map((x) => x.id), [`${batchOf(bc, bc.to[0])}-0`, `${batchOf(bc, bc.to[0])}-1`, `${batchOf(bc, bc.to[1])}-0`, `${batchOf(bc, bc.to[1])}-1`]);
  assert.ok(items.every((x) => x.id.startsWith('bc-b1-') && x.gap === 25e3));
  assert.equal(items[1].content.url, items[3].content.url, 'the same mxc for everyone');
  assert.equal(at['merge:g'] - at['@a:x'], 47500);
  assert.equal(items[0].content.body, 'Ahoj A,\n\noznam');
  const again = laterItemsOf(bc, 99999, () => 0.9).items;
  const list = addOnce(addOnce([], items), again);
  assert.equal(list.length, 4, 'a second confirmation adds nothing');
  assert.equal(addOnce(list, again), list);
});

test('the day limit counts this broadcast and what went or waits today, per network', () => {
  const now = new Date(2026, 10, 25, 12).getTime();
  const later = [
    ...Array.from({ length: BC_DAY - 1 }, (_, i) => ({ id: `bc-old-${i}-0`, seq: 0, net: 'messenger', at: now - 3600e3 })),
    { id: 'bc-old-x-1', seq: 1, net: 'messenger', at: now }, // a file: the same person
    { id: 'bc-yday-y-0', seq: 0, net: 'messenger', at: now - 86400e3 }, // yesterday
    { id: 'plain', seq: 0, net: 'messenger', at: now },
  ];
  assert.deepEqual(dayCounts(bc, later, now), { messenger: BC_DAY, whatsapp: 1 });
});

test('yes, no and maybe from an answer', () => {
  assert.equal(guessRsvp('Jasné, prídem 👍'), 'ano');
  assert.equal(guessRsvp('v sobotu nemôžem, sorry'), 'nie');
  assert.equal(guessRsvp('asi hej, potvrdím v stredu'), 'mozno');
  assert.equal(guessRsvp('idem, beriem aj foťák'), 'ano');
  assert.equal(guessRsvp('👍'), 'ano');
  assert.equal(guessRsvp('a kedy presne?'), null);
});

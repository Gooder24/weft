// bun test server/connect: the rules over made-up mails, then the host against a fake homeserver and a throwaway
// archive. Nothing here reaches a network or a real account.
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as packeta, place } from './connectors/packeta.ts';
import { parse as vinted, vinted as vintedConnector } from './connectors/vinted.ts';
import { packeta as packetaConnector } from './connectors/packeta.ts';
import { number } from './connectors/phone.ts';
import { CONNECTORS } from './connectors/index.ts';
import { Host } from './host.ts';
import { items, Phones } from './phone.ts';
import { flatten } from './mail.ts';
import { Matrix } from './matrix.ts';

const CSS = `\n @media screen and (max-width: 600px) {\n .email-container {\n width: 100% !important;\n }\n }\n .x { color: red }\n`;
const mail = (subject: string, text: string, from = 'Vinted <no-reply@vinted.sk>', id = 'm1', ts = 1_800_000_000_000) =>
  ({ id, from, ts, ...flatten(`${subject}\n${CSS}\n Vinted Email \n ${text}`) });

describe('mail', () => {
  test('flatten drops <style> rules and folds whitespace', () => {
    expect(flatten(`Hello there\n${CSS}\n  one \n\n two `)).toEqual({ subject: 'Hello there', text: 'one two' });
  });
});

describe('vinted', () => {
  test('a new message names who wrote, in the item\'s chat', () => {
    const [item] = vinted(mail('New message about Lampa retro', 'kupec42, predajca77 just sent you a message about Lampa retro. View message This email was sent by Vinted'));
    expect(item).toEqual({ thread: 'item:Lampa retro', title: 'Lampa retro', from: 'predajca77', text: 'Nová správa. Prečítaš ju a odpíšeš vo Vinted.' });
  });
  test('an offer keeps both prices', () => {
    const [item] = vinted(mail('New offer for Hrnček', 'kupec42, zberatel just offered to sell you Hrnček for a lower price. 4,00 € New offer: 4,00 € instead of 5,50 € Respond to offer Follow us:'));
    expect(item?.from).toBe('zberatel');
    expect(item?.text).toBe('Ponuka: 4,00 € namiesto 5,50 €.');
  });
  test('a receipt sums up what was paid, in the same chat as the item', () => {
    const [item] = vinted(mail('Your receipt for "Lampa retro“', 'Hello kupec42, Your payment has been received. Your Vinted purchase receipt: Seller predajca77 Order Lampa retro Paid €9.10 Item €6.00 Postage €2.10 Vinted fee €1.00 Payment method Visa'));
    expect(item).toEqual({ thread: 'item:Lampa retro', title: 'Lampa retro', text: 'Zaplatené €9.10 (tovar €6.00, poštovné €2.10, poplatok €1.00), predajca predajca77.' });
  });
  test('an order update keeps Vinted\'s sentence without greeting or footer', () => {
    const [item] = vinted(mail('Order update for Lampa retro', 'Hi, Your parcel is waiting for you at Z-BOX Horná Dolná, Hlavná 1. Please pick it up. Go to conversation This email was sent by Vinted'));
    expect(item?.text).toBe('Čaká na vyzdvihnutie: Z-BOX Horná Dolná, Hlavná 1.');
  });
  test('a delivered order asks for the confirmation with its deadline, in Slovak', () => {
    const [item] = vinted(mail('Hrnček - Confirmation needed', 'Hi kupec42, Your order has been marked as delivered. If you received it, confirm this. You have until 2 Mar 16:48 to report an issue. To do this, go to your conversation. Go to conversation'));
    expect(item).toEqual({ thread: 'item:Hrnček', title: 'Hrnček', text: 'Doručené. Potvrď, že je všetko v poriadku, alebo nahlás problém do 2 Mar 16:48.' });
  });
  test('an unknown sentence stays as Vinted wrote it', () => {
    const [item] = vinted(mail('Order update for Hrnček', 'Hi, Something new happened. Go to conversation'));
    expect(item?.text).toBe('Something new happened.');
  });
  test('anything else goes to one chat „Vinted“ by its subject', () => {
    expect(vinted(mail('Leave feedback for the seller', 'Hi'))).toEqual([{ thread: 'vinted', title: 'Vinted', text: 'Leave feedback for the seller' }]);
  });
  test('Packeta\'s mails forwarded by Vinted are not Vinted\'s', () => {
    expect(vintedConnector.mail?.from('Vinted <no-reply@vinted.sk>')).toBe(true);
    expect(vintedConnector.mail?.from('Packeta Slovakia via Vinted <shipping@relay.vinted.com>')).toBe(false);
    expect(packetaConnector.mail?.from('Packeta Slovakia via Vinted <shipping@relay.vinted.com>')).toBe(true);
    expect(vintedConnector.mail?.from('Someone <someone@example.com>')).toBe(false);
  });
});

describe('packeta', () => {
  const P = 'Packeta Slovakia <noreply@packeta.sk>';
  const ready = 'Zásielka Z 111 2222 333 Dobrý deň, vaša zásielka od odosielateľa Obchodík je pre vás pripravená na vyzdvihnutie v Z-BOXe. Kód pre otvorenie schránky 1 2 3 4 5 6 Miesto, kde je vaša zásielka uložená Z-BOX Horná Dolná, Hlavná 1 Hlavná 1 000 00 Horná Dolná Zobraziť na mape Po–Ne 00:00–23:59 Na vyzdvihnutie najneskôr do 2.3.2030 23:59. Zaplatené';
  test('the box keeps its street once', () => {
    expect(place(ready)).toBe('Z-BOX Horná Dolná, Hlavná 1');
  });
  test('ready: box, deadline and code, in the parcel\'s chat', () => {
    expect(packeta(mail('Zásielka je pripravená na vyzdvihnutie', ready, P))).toEqual([{
      thread: 'parcel:Z1112222333', title: 'Zásielka Z 111 2222 333 od Obchodík',
      text: 'Pripravená na vyzdvihnutie: Z-BOX Horná Dolná, Hlavná 1, do 2.3.2030 23:59, kód 123456.',
    }]);
  });
  test('handed over by the sender', () => {
    const [item] = packeta(mail('Zásielka bola prijatá do prepravy', 'Dobrý deň, internetový obchod Obchodík nám odovzdal Vašu zásielku číslo Z 111 2222 333, ktorá bude doručená', P));
    expect(item?.thread).toBe('parcel:Z1112222333');
    expect(item?.text).toBe('Obchodík ju odovzdal Packete.');
  });
  test('an unknown mail without a number goes to „Packeta“', () => {
    expect(packeta(mail('Novinky z Packety', 'Ahoj', P))).toEqual([{ thread: 'packeta', title: 'Packeta', text: 'Novinky z Packety' }]);
  });
});

// ---------------------------------------------------------------- the host

type Call = { method: string; path: string; user: string | null; body: Record<string, unknown> };
const dirs: string[] = [];
const servers: { stop: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A homeserver that answers what the host asks and remembers every call; `seen` null: Karchi has no „seen up to“ yet. */
function fakeHomeserver(seen: Record<string, unknown> | null = { keep: 5 }) {
  const calls: Call[] = [];
  let n = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname.replace('/_matrix/client/v3', ''));
      const body: Record<string, unknown> = req.method === 'GET' ? {} : await req.json().catch(() => ({}));
      calls.push({ method: req.method, path, user: url.searchParams.get('user_id'), body });
      if (path === '/createRoom') return Response.json({ room_id: `!r${++n}:test` });
      if (path.includes('/send/')) return Response.json({ event_id: `$e${++n}` });
      if (req.method === 'GET' && path.includes('/account_data/')) return seen ? Response.json(seen) : Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 });
      return Response.json({});
    },
  });
  servers.push(server);
  return { calls, url: `http://127.0.0.1:${server.port}` };
}

const NOW = 1_800_000_000_000;
function setup(seen?: Record<string, unknown> | null) {
  const dir = mkdtempSync(join(tmpdir(), 'connect-'));
  dirs.push(dir);
  const archive = new Database(join(dir, 'archive.db'), { strict: true });
  archive.exec(`CREATE TABLE chats (id TEXT PRIMARY KEY, network TEXT, title TEXT, room TEXT, source TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, chat TEXT NOT NULL, ts INTEGER NOT NULL, sender TEXT NOT NULL, me INTEGER NOT NULL, body TEXT NOT NULL);
    INSERT INTO chats VALUES ('gmail:a:1', 'gmail', 't', NULL, 'gmail'), ('messenger:x', 'messenger', 't', NULL, 'x');`);
  const add = (id: string, sender: string, body: string, ts = NOW - 60_000, chat = 'gmail:a:1') =>
    archive.query('INSERT OR REPLACE INTO messages VALUES (?, ?, ?, ?, 0, ?)').run(id, chat, ts, sender, body);
  const hs = fakeHomeserver(seen);
  const matrix = new Matrix(hs.url, 'as', 'puppet', '@karchi:test', '@connectbot:test');
  const host = new Host({ archive: join(dir, 'archive.db'), state: join(dir, 'connect.db'), matrix, connectors: CONNECTORS, now: () => NOW });
  return { add, hs, host };
}
const V = 'Vinted <no-reply@vinted.sk>';
const sends = (calls: Call[]) => calls.filter((c) => c.path.includes('/send/'));

describe('host', () => {
  test('posts each item once into its thread\'s room, as the right ghost, Karchi joined', async () => {
    const { add, hs, host } = setup();
    add('g1', V, 'New message about Lampa retro\n predajca77 just sent you a message about Lampa retro.');
    add('g2', V, 'Your receipt for "Lampa retro“\n Seller predajca77 Paid €9.10');
    add('g3', 'Someone <a@example.com>', 'Hello\n nothing to see');
    add('x1', V, 'New message about Lampa retro\n not a mail', NOW - 60_000, 'messenger:x');
    expect(await host.round()).toBe(2);
    expect(hs.calls.filter((c) => c.path === '/createRoom')).toHaveLength(1);
    const [msg, paid] = sends(hs.calls);
    expect(msg?.user).toBe(`@cx_vinted_${new Bun.CryptoHasher('sha256').update('predajca77').digest('hex').slice(0, 12)}:test`);
    expect(paid?.user).toBe('@cx_vinted:test');
    expect(hs.calls.some((c) => c.path === '/join/!r1:test' && c.user === '@karchi:test')).toBe(true);
    expect(hs.calls.some((c) => c.path.includes('/receipt/'))).toBe(false); // a minute old: news, left unread
    expect(await host.round()).toBe(0);
    add('g1', V, 'New message about Lampa retro\n predajca77 just sent you a message about Lampa retro.'); // the archive wrote it again: new rowid
    expect(await host.round()).toBe(0);
    expect(host.status().find((s) => s.id === 'vinted')).toMatchObject({ on: true, chats: 1, items: 2 });
  });

  test('history older than a day comes read; older than 30 days not at all', async () => {
    const { add, hs, host } = setup();
    add('old', V, 'Order update for Hrnček\n Hi, Shipped.', NOW - 3 * 86_400_000);
    add('ancient', V, 'Order update for Váza\n Hi, Shipped.', NOW - 40 * 86_400_000);
    expect(await host.round()).toBe(1);
    expect(hs.calls.filter((c) => c.path.includes('/receipt/m.read/'))).toEqual([expect.objectContaining({ user: '@karchi:test' })]);
    // Weft's own „seen up to“ (what its inbox reads) gets the room at the item's time, as Karchi
    const put = hs.calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/account_data/sk.karchi.edupage.seen'));
    expect(put).toEqual([expect.objectContaining({ user: '@karchi:test', body: { keep: 5, '!r1:test': NOW - 3 * 86_400_000 } })]);
    expect(await host.round()).toBe(0);
    expect(hs.calls.filter((c) => c.method === 'PUT' && c.path.includes('/account_data/'))).toHaveLength(1);
  });

  test('without any „seen up to“ yet, history writes none: everything before Weft\'s first run counts as seen', async () => {
    const { add, hs, host } = setup(null);
    add('old', V, 'Order update for Hrnček\n Hi, Shipped.', NOW - 3 * 86_400_000);
    expect(await host.round()).toBe(1);
    expect(hs.calls.some((c) => c.method === 'PUT' && c.path.includes('/account_data/'))).toBe(false);
  });

  test('news is not marked seen, and a later seen value stays', async () => {
    const { add, hs, host } = setup();
    add('new', V, 'Order update for Hrnček\n Hi, Shipped.');
    await host.round();
    expect(hs.calls.some((c) => c.path.includes('/account_data/'))).toBe(false);
  });

  test('a connector that fails does not stop the others', async () => {
    const { add, hs, host } = setup();
    const broken = { ...vintedConnector, mail: { from: () => true, parse: () => { throw new Error('rules choked'); } } };
    const both = new Host({ ...host.opts, connectors: [broken, packetaConnector] });
    add('v', V, 'Order update for Hrnček\n Hi, Shipped.');
    add('p', 'Packeta Slovakia <noreply@packeta.sk>', 'Zásielka bola prevzatá\n Číslo zásielky Z 111 2222 333');
    await expect(both.round()).rejects.toThrow('rules choked');
    expect(sends(hs.calls)).toHaveLength(1);
    expect(await host.round()).toBe(1); // the fixed rules pick up where the broken ones stopped
  });

  test('off stops new items; on again catches up without repeating', async () => {
    const { add, hs, host } = setup();
    add('g1', V, 'Order update for Hrnček\n Hi, Shipped.');
    await host.round();
    host.setOn('vinted', false);
    add('g2', V, 'Order update for Hrnček\n Hi, Delivered.');
    expect(await host.round()).toBe(0);
    expect(host.setOn('nope', true)).toBe(false);
    host.setOn('vinted', true);
    expect(await host.round()).toBe(1);
    expect(sends(hs.calls).map((c) => c.body.body)).toEqual(['Shipped.', 'Delivered.']);
  });

  test('a homeserver failure leaves the mail for the next round', async () => {
    const { add, hs, host } = setup();
    add('g1', V, 'Order update for Hrnček\n Hi, Shipped.');
    const broken = new Matrix('http://127.0.0.1:9', 'as', 'puppet', '@karchi:test', '@connectbot:test');
    const failing = new Host({ ...host.opts, matrix: broken });
    await expect(failing.round()).rejects.toThrow();
    expect(await host.round()).toBe(1);
    expect(sends(hs.calls)).toHaveLength(1);
  });
});

describe('order', () => {
  test('mail the archive took newest first still goes into the chat oldest first', async () => {
    const { add, hs, host } = setup();
    add('b', V, 'Order update for Hrnček\n Hi, Delivered.', NOW - 60_000);
    add('a', V, 'Order update for Hrnček\n Hi, Shipped.', NOW - 120_000);
    await host.round();
    expect(sends(hs.calls).map((c) => c.body.body)).toEqual(['Shipped.', 'Delivered.']);
  });
  test('a pick-up point\'s street comes once', () => {
    const [item] = vinted(mail('Order update for Hrnček', 'Hi, Your parcel is waiting for you at Z-BOX Horná Dolná, Hlavná 1, Hlavná 1, 000 00 Horná Dolná. Please pick it up. Go to conversation'));
    expect(item?.text).toBe('Čaká na vyzdvihnutie: Z-BOX Horná Dolná, Hlavná 1, 000 00 Horná Dolná.');
  });
});

describe('phone', () => {
  const sms = (id: string, address: string, text: string, ts = NOW - 60_000, name?: string) => ({ id, kind: 'sms' as const, ts, address, text, name });

  test('a code pairs one phone once, within ten minutes; the token is its own and forgetting it ends it', () => {
    let now = NOW;
    const { host } = setup();
    const phones = new Phones(host.db, () => now);
    const { code } = phones.code();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const got = phones.claim(code.toLowerCase().replace('-', ' '), 'Starý telefón');
    expect(got?.token).toMatch(/^wp_/);
    expect(phones.claim(code, 'druhý')).toBeNull();
    expect(phones.auth(`Bearer ${got?.token}`)).toBe(got?.id ?? 'x');
    expect(phones.list()).toEqual([{ id: got?.id ?? 'x', name: 'Starý telefón', created: NOW, seen: NOW, items: 0 }]);
    phones.count(got?.id ?? 'x', 3);
    expect(phones.list()[0]?.items).toBe(3);
    expect(phones.auth('Bearer wp_guess')).toBeNull();
    const late = phones.code();
    now += 11 * 60_000;
    expect(phones.claim(late.code, 'x')).toBeNull();
    phones.remove(got?.id ?? 'x');
    expect(phones.auth(`Bearer ${got?.token}`)).toBeNull();
  });

  test('five wrong codes void the pending one', () => {
    const { host } = setup();
    const phones = new Phones(host.db, () => NOW);
    const { code } = phones.code();
    for (let i = 0; i < 5; i++) expect(phones.claim('AAAA-AAAA', 'x')).toBeNull();
    expect(phones.claim(code, 'x')).toBeNull();
  });

  test('SMS go into one chat per number however it is written, each once; notifications into one per app', async () => {
    const { hs, host } = setup();
    const taken = await host.phone('p1', [
      sms('1', '+421 900 123 456', 'Ahoj', NOW - 120_000, 'Mama'),
      sms('2', '0900123456', 'Kde si?', NOW - 60_000, 'Mama'),
      { id: 'n1', kind: 'notification', ts: NOW - 30_000, app: 'com.example.shop', appName: 'Obchod', title: 'Obchod', text: 'Zľava 20 %' },
    ]);
    expect(taken).toEqual({ taken: ['1', '2', 'n1'], posted: 3 });
    expect(hs.calls.filter((c) => c.path === '/createRoom').map((c) => c.body.name)).toEqual(['Mama', 'Obchod']);
    expect(sends(hs.calls).map((c) => c.body.body)).toEqual(['Ahoj', 'Kde si?', 'Zľava 20 %']);
    expect(await host.phone('p1', [sms('1', '+421900123456', 'Ahoj', NOW - 120_000, 'Mama')])).toEqual({ taken: ['1'], posted: 0 });
    // Paired again (a new device id) or a second phone with the same SIM: its 30 days come once more, none is posted.
    expect(await host.phone('p2', [sms('77', '00421 900 123 456', 'Ahoj', NOW - 120_000, 'Mama'), sms('78', '0900123456', 'Kde si?', NOW - 60_000)])).toEqual({ taken: ['77', '78'], posted: 0 });
    expect(sends(hs.calls)).toHaveLength(3);
    // The same words again later are a new message.
    expect((await host.phone('p2', [sms('79', '0900123456', 'Ahoj', NOW - 1_000, 'Mama')])).posted).toBe(1);
    expect(number('00421 900 123 456')).toBe('+421900123456');
    expect(number('Packeta')).toBe('packeta');
  });

  test('a switched-off SMS connector takes the item without posting it; empty texts are dropped', async () => {
    const { hs, host } = setup();
    host.setOn('sms', false);
    expect((await host.phone('p1', [sms('1', '0900123456', 'Ahoj'), { id: 'n', kind: 'notification', ts: NOW, app: 'a', text: '  ' }])).taken).toEqual(['1', 'n']);
    expect(sends(hs.calls)).toHaveLength(0);
  });

  test('old SMS come read, as old mail does', async () => {
    const { hs, host } = setup();
    await host.phone('p1', [sms('1', '0900123456', 'Včera', NOW - 2 * 86_400_000)]);
    expect(hs.calls.some((c) => c.path.includes('/receipt/m.read/'))).toBe(true);
  });

  test('an SMS Karchi sent is his own message in the chat, through his own account', async () => {
    const { hs, host } = setup();
    await host.phone('p1', [sms('1', '0900123456', 'Ahoj', NOW - 120_000, 'Mama'), { ...sms('2', '0900123456', 'Čau', NOW - 60_000, 'Mama'), out: true }]);
    expect(sends(hs.calls).map((c) => c.user)).toEqual([expect.stringMatching(/^@cx_sms_/), '@karchi:test']);
    expect(hs.calls.filter((c) => c.path === '/createRoom')).toHaveLength(1);
  });

  test('only what the phone sends is taken', () => {
    expect(items({ items: [{ id: '1', kind: 'sms', ts: 1, text: 'a', address: '1' }] })).toHaveLength(1);
    expect(items({ items: [{ id: '1', kind: 'call', ts: 1, text: 'a' }] })).toBeNull();
    expect(items({ items: [{ id: '1', kind: 'sms', ts: 'x', text: 'a' }] })).toBeNull();
    expect(items({ items: Array.from({ length: 501 }, (_, i) => ({ id: String(i), kind: 'sms', ts: 1, text: 'a' })) })).toBeNull();
    expect(items(null)).toBeNull();
  });
});

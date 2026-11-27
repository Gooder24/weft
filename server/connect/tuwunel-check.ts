// The phone's way back (outbox.ts) against a real, throwaway Tuwunel: the connector host as the service runs it, a
// paired stand-in phone over HTTP, and Karchi writing through his own account. Nothing reaches a real account.
//   TUWUNEL=~/matrix-spike/bin/tuwunel bun tuwunel-check.ts
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TUWUNEL = (process.env.TUWUNEL ?? 'tuwunel').replace(/^~/, process.env.HOME ?? '');
const base = mkdtempSync(join(tmpdir(), 'weft-outbox-'));
const free = () => { const s = Bun.serve({ port: 0, fetch: () => new Response() }); const p = s.port; s.stop(true); return p; };
const [hsPort, hostPort] = [free(), free()];
const hex = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
const [asToken, hsToken, dpToken, reg] = [hex(), hex(), hex(), hex()];
const procs: Bun.Subprocess[] = [];
let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed++; };

try {
  mkdirSync(join(base, 'appservices'));
  writeFileSync(join(base, 'appservices', 'connect.yaml'), `id: connect\nurl: http://127.0.0.1:${hostPort}\nas_token: ${asToken}\nhs_token: ${hsToken}
sender_localpart: connectbot\nrate_limited: false\nnamespaces:\n  users:\n  - regex: ^@connectbot:weft\\.test$\n    exclusive: true\n  - regex: ^@cx_.*:weft\\.test$\n    exclusive: true\n`);
  writeFileSync(join(base, 'appservices', 'doublepuppet.yaml'), `id: doublepuppet\nurl: null\nas_token: ${dpToken}\nhs_token: ${hex()}
sender_localpart: doublepuppet\nrate_limited: false\nnamespaces:\n  users:\n  - regex: ^@karchi:weft\\.test$\n    exclusive: false\n`);
  writeFileSync(join(base, 'tuwunel.toml'), ['[global]', 'server_name = "weft.test"', `database_path = "${join(base, 'db')}"`, 'address = ["127.0.0.1"]',
    `port = ${hsPort}`, 'allow_registration = true', `registration_token = "${reg}"`, 'allow_federation = false', 'log = "warn"',
    `appservice_dir = "${join(base, 'appservices')}"`, ''].join('\n'));
  procs.push(Bun.spawn([TUWUNEL, '-c', join(base, 'tuwunel.toml')], { stdout: Bun.file(join(base, 'hs.log')), stderr: 'pipe' }));
  const hs = `http://127.0.0.1:${hsPort}`;
  const until = async <T>(what: string, get: () => Promise<T | null | undefined | false>, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await get().catch(() => null);
      if (v) return v;
      await Bun.sleep(250);
    }
    throw new Error(`timed out: ${what}`);
  };
  await until('homeserver', async () => (await fetch(`${hs}/_matrix/client/versions`)).ok);

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await fetch(`${hs}/_matrix/client/v3${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return (await res.json()) as Record<string, unknown>;
  };
  // Karchi's own account, as Weft logs in.
  const first = await fetch(`${hs}/_matrix/client/v3/register`, { method: 'POST', body: JSON.stringify({ username: 'karchi', password: 'pw-test-only' }) }).then((r) => r.json()) as { session?: string };
  const made = await fetch(`${hs}/_matrix/client/v3/register`, { method: 'POST', body: JSON.stringify({ username: 'karchi', password: 'pw-test-only', auth: { type: 'm.login.registration_token', token: reg, session: first.session } }) }).then((r) => r.json()) as { access_token: string };
  const me = made.access_token;

  writeFileSync(join(base, 'reg.yaml'), `as_token: ${asToken}\nhs_token: ${hsToken}\n`);
  writeFileSync(join(base, 'puppet.yaml'), `as_token: ${dpToken}\n`);
  const archive = new Database(join(base, 'archive.db'), { create: true });
  archive.exec(`CREATE TABLE chats (id TEXT PRIMARY KEY, network TEXT, title TEXT, room TEXT, source TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, chat TEXT NOT NULL, ts INTEGER NOT NULL, sender TEXT NOT NULL, me INTEGER NOT NULL, body TEXT NOT NULL);`);
  archive.close();
  procs.push(Bun.spawn([process.execPath, join(import.meta.dir, 'main.ts')], {
    env: { ...process.env, ADMIN_MXID: '@karchi:weft.test', HOMESERVER: hs, REGISTRATION: join(base, 'reg.yaml'), DOUBLEPUPPET: join(base, 'puppet.yaml'),
      ARCHIVE_DB: join(base, 'archive.db'), CONNECT_STATE: join(base, 'connect.db'), CONNECT_PORT: String(hostPort), PHONE_URL: '' },
    stdout: Bun.file(join(base, 'host.log')), stderr: Bun.file(join(base, 'host.err')),
  }));
  const host = `http://127.0.0.1:${hostPort}`;
  const post = async (path: string, token: string, body: unknown) => {
    const res = await fetch(`${host}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return (await res.json()) as Record<string, unknown>;
  };
  const code = await until('host', async () => (await post('/_connect/phones/code', me, {})).code as string);
  const phone = (await post('/_connect/phone/claim', '', { code, name: 'Test' })).token as string;
  const now = Date.now();
  await post('/_connect/phone/items', phone, { items: [
    { id: 'sms:1', kind: 'sms', ts: now - 60_000, address: '0900123456', name: 'Mama', text: 'Kedy prídeš?' },
    { id: 'n:com.app:1:a', kind: 'notification', ts: now - 30_000, app: 'com.app', appName: 'App', title: 'Jano', text: 'Ideš večer?' },
  ] });
  const state = new Database(join(base, 'connect.db'), { readonly: true });
  const room = (c: string) => state.query<{ room: string }, [string]>('SELECT room FROM rooms WHERE connector = ?').get(c)!.room;
  const [smsRoom, appRoom] = [room('sms'), room('phone')];
  const asked = state.query<{ event: string }, []>("SELECT event FROM posted WHERE key LIKE 'phone:n:%'").get()!.event;
  const say = (r: string, content: Record<string, unknown>) => call('PUT', `/rooms/${encodeURIComponent(r)}/send/m.room.message/t${hex()}`, me, content);
  const messages = async (r: string) => ((await call('GET', `/rooms/${encodeURIComponent(r)}/messages?dir=b&limit=50`, me)).chunk as { type: string; sender: string; content: Record<string, unknown> }[])
    .filter((e) => e.type === 'm.room.message');

  const sent = await say(smsRoom, { msgtype: 'm.text', body: 'O siedmej' });
  const out = await until('the SMS in the outbox', async () => ((await post('/_connect/phone/outbox', phone, { wait: 5 })).items as { id: string; kind: string; to: string; text: string }[]).at(0));
  check(out.id === sent.event_id && out.kind === 'sms' && out.to === '+421900123456' && out.text === 'O siedmej', 'Karchi\'s SMS reaches the phone through the homeserver\'s transaction');
  await post('/_connect/phone/outbox', phone, { done: [{ id: out.id, ok: true }] });
  const status = await call('GET', `/rooms/${encodeURIComponent(smsRoom)}/messages?dir=b&limit=50`, me);
  check((status.chunk as { type: string; sender: string; content: { status?: string; 'm.relates_to'?: { event_id?: string } } }[])
    .some((e) => e.type === 'com.beeper.message_send_status' && e.sender === '@connectbot:weft.test' && e.content.status === 'SUCCESS' && e.content['m.relates_to']?.event_id === out.id),
  'the phone\'s „sent“ is the bridge bot\'s send status Weft shows as ✓');
  const before = (await messages(smsRoom)).length;
  await post('/_connect/phone/items', phone, { items: [{ id: 'sms:2', kind: 'sms', ts: Date.now(), address: '+421 900 123 456', name: 'Mama', text: 'O siedmej', out: true }] });
  check((await messages(smsRoom)).length === before, 'its echo from the phone\'s SMS store posts nothing');

  await say(appRoom, { msgtype: 'm.text', body: 'Hej' });
  await until('the notice for an answer to nobody', async () => (await messages(appRoom)).some((e) => e.content.msgtype === 'm.notice' && String(e.content.body).startsWith('\u26a0\ufe0f Your message was not bridged: Odpovedz na konkrétnu správu')));
  check(true, 'a message in an app\'s chat that answers nothing is refused in the chat');
  const answer = await say(appRoom, { msgtype: 'm.text', body: '> <@cx_phone:weft.test> Ideš večer?\n\nÁno', 'm.relates_to': { 'm.in_reply_to': { event_id: asked } } });
  const reply = await until('the answer in the outbox', async () => ((await post('/_connect/phone/outbox', phone, { wait: 5 })).items as { id: string; kind: string; to: string; text: string }[]).at(0));
  check(reply.id === answer.event_id && reply.kind === 'reply' && reply.to === 'n:com.app:1:a' && reply.text === 'Áno', 'an answer goes to the notification it answers, without the quote');
  await post('/_connect/phone/outbox', phone, { done: [{ id: reply.id, ok: false, error: 'Táto notifikácia už v telefóne nie je.' }] });
  check((await messages(appRoom)).some((e) => e.content.msgtype === 'm.notice' && e.content.body === '\u26a0\ufe0f Your message was not bridged: Táto notifikácia už v telefóne nie je.'), 'what the phone could not send is said under it');
  check(((await post('/_connect/phone/outbox', phone, {})).items as unknown[]).length === 0, 'nothing is handed out again');
  state.close();
} catch (err) {
  console.log(`FAIL ${err instanceof Error ? err.message : err}`);
  failed++;
} finally {
  for (const p of procs) p.kill();
  await Promise.all(procs.map((p) => p.exited));
  if (failed) console.log(`logs kept in ${base}`);
  else rmSync(base, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);

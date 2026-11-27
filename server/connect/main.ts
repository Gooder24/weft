// matrix-spike-connect: the connector host as a service. Environment (asus ~/.config/weft/weft.env and the unit):
// ADMIN_MXID, HOMESERVER, REGISTRATION (appservices/connect.yaml), DOUBLEPUPPET, ARCHIVE_DB, CONNECT_STATE, CONNECT_PORT.
//
// HTTP on 127.0.0.1 only:
//   /_matrix/app/v1/…           the homeserver's appservice calls (hs_token): Karchi's messages in the phone's chats
//   GET /_connect/connectors     Karchi's token: each connector, whether it is on, its chats and items
//   PUT /_connect/connectors/<id> {"on": bool}
//   POST /_connect/phones/code      Karchi's token: a pairing code for a phone (10 minutes, once)
//   GET /_connect/phones, DELETE /_connect/phones/<id>
//   POST /_connect/phone/claim {code, name}   the phone: its id and token for a valid code
//   POST /_connect/phone/items {items}        the phone's token: SMS and notifications, answers the ids it took
//   POST /_connect/phone/outbox {done, wait}  the phone's token: how what it sent went, and what to send (outbox.ts);
//                                             with wait (≤ 50 s) it waits for something new
//   POST /_connect/phone/forget               the phone's token: the phone unpaired itself, the token ends
//   GET /_connect/phone/ca.crt, /_connect/phone/weft-telefon.apk   for setting a phone up (nothing secret)
import { CONNECTORS } from './connectors/index.ts';
import { Host } from './host.ts';
import { Matrix, registrationToken } from './matrix.ts';
import { reports } from './outbox.ts';
import { items, Phones } from './phone.ts';

const env = (key: string, fallback?: string) => {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`${key} is not set`);
  return v;
};
const home = env('HOME');
const admin = env('ADMIN_MXID');
const registration = await Bun.file(env('REGISTRATION', `${home}/matrix-spike/appservices/connect.yaml`)).text();
const puppet = await Bun.file(env('DOUBLEPUPPET', `${home}/matrix-spike/appservices/doublepuppet.yaml`)).text();
const hsToken = registrationToken(registration, 'hs_token');
const matrix = new Matrix(env('HOMESERVER', 'http://127.0.0.1:8008'), registrationToken(registration, 'as_token'),
  registrationToken(puppet, 'as_token'), admin, `@connectbot:${admin.slice(admin.indexOf(':') + 1)}`);
const host = new Host({
  archive: env('ARCHIVE_DB', `${home}/matrix-spike/archive/archive.db`),
  state: env('CONNECT_STATE', `${home}/matrix-spike/connect/state/connect.db`),
  matrix, connectors: CONNECTORS,
});

const phones = new Phones(host.db, () => host.now());
const files: Record<string, [string, string]> = {
  '/_connect/phone/ca.crt': [env('CADDY_CA', `${home}/matrix-spike/web/pki/root.crt`), 'application/x-x509-ca-cert'],
  '/_connect/phone/weft-telefon.apk': [env('PHONE_APK', `${home}/matrix-spike/connect/state/weft-telefon.apk`), 'application/vnd.android.package-archive'],
};

const owners = new Map<string, number>(); // token → when whoami said it is Karchi's
async function isOwner(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/, '');
  if (!token) return false;
  const at = owners.get(token);
  if (at && Date.now() - at < 300_000) return true;
  if ((await matrix.whoami(token)) !== admin) return false;
  owners.set(token, Date.now());
  return true;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function round(why: string) {
  try {
    const n = await host.round();
    if (n) console.log(`${why}: ${n} new`);
  } catch (err) {
    console.log(`${why}: ${err instanceof Error ? err.message : err}`); // the cursor stays before the mail; the next round retries
  }
}

Bun.serve({
  hostname: '127.0.0.1',
  port: Number(env('CONNECT_PORT', '29335')),
  maxRequestBodySize: 4 * 1024 * 1024, // a phone sends at most 500 items at once
  idleTimeout: 120, // a phone's outbox request waits up to 50 s
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/_matrix/app/')) {
      const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/, '') || url.searchParams.get('access_token');
      if (token !== hsToken) return json({ errcode: 'M_FORBIDDEN' }, 403);
      if (req.method === 'PUT' && url.pathname.startsWith('/_matrix/app/v1/transactions/')) {
        const body: { events?: unknown } = await req.json().catch(() => ({}));
        await host.outbox.take(Array.isArray(body.events) ? body.events : []);
        return json({});
      }
      if (url.pathname === '/_matrix/app/v1/ping') return json({});
      return json({ errcode: 'M_NOT_FOUND' }, 404); // ghosts and rooms exist only when the host makes them
    }
    if (url.pathname.startsWith('/_connect/phone/')) return phone(req, url);
    if (!/^\/_connect\/(connectors|phones)(\/|$)/.test(url.pathname)) return json({ errcode: 'M_NOT_FOUND' }, 404);
    if (!(await isOwner(req))) return json({ errcode: 'M_FORBIDDEN' }, 403);
    if (req.method === 'GET' && url.pathname === '/_connect/phones') return json({ phones: phones.list() });
    // The address the phone types: Weft on the Tailscale address (PHONE_URL), whatever origin this Weft window has.
    if (req.method === 'POST' && url.pathname === '/_connect/phones/code') return json({ ...phones.code(), address: process.env.PHONE_URL || null });
    const phoneId = url.pathname.match(/^\/_connect\/phones\/([0-9a-f]+)$/)?.[1];
    if (req.method === 'DELETE' && phoneId) {
      if (!phones.remove(phoneId)) return json({ errcode: 'M_NOT_FOUND' }, 404);
      console.log(`phone ${phoneId} removed`);
      return json({ phones: phones.list() });
    }
    if (req.method === 'GET' && url.pathname === '/_connect/connectors') return json({ connectors: host.status() });
    const id = url.pathname.match(/^\/_connect\/connectors\/([a-z0-9-]+)$/)?.[1];
    if (req.method === 'PUT' && id) {
      const body: { on?: unknown } = await req.json().catch(() => ({}));
      if (typeof body.on !== 'boolean' || !host.setOn(id, body.on)) return json({ errcode: 'M_BAD_JSON' }, 400);
      console.log(`${id} turned ${body.on ? 'on' : 'off'}`);
      if (body.on) void round(id);
      return json({ connectors: host.status() });
    }
    return json({ errcode: 'M_NOT_FOUND' }, 404);
  },
});

async function phone(req: Request, url: URL) {
  const file = req.method === 'GET' ? files[url.pathname] : undefined;
  if (file) {
    const f = Bun.file(file[0]);
    return (await f.exists()) ? new Response(f, { headers: { 'Content-Type': file[1] } }) : json({ errcode: 'M_NOT_FOUND' }, 404);
  }
  if (req.method !== 'POST') return json({ errcode: 'M_NOT_FOUND' }, 404);
  const body: unknown = await req.json().catch(() => null);
  if (url.pathname === '/_connect/phone/claim') {
    const { code, name } = (body ?? {}) as { code?: unknown; name?: unknown };
    const got = typeof code === 'string' ? phones.claim(code, typeof name === 'string' ? name : '') : null;
    if (!got) return json({ errcode: 'M_FORBIDDEN', error: 'wrong or expired code' }, 403);
    console.log(`phone ${got.id} paired`);
    return json({ device: got.id, token: got.token });
  }
  if (url.pathname === '/_connect/phone/forget') {
    const device = phones.auth(req.headers.get('Authorization'));
    if (!device) return json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    phones.remove(device);
    console.log(`phone ${device} unpaired itself`);
    return json({});
  }
  if (url.pathname === '/_connect/phone/outbox') {
    const device = phones.auth(req.headers.get('Authorization'));
    if (!device) return json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    const done = reports(body);
    const wait = (body as { wait?: unknown } | null)?.wait;
    if (!done) return json({ errcode: 'M_BAD_JSON' }, 400);
    return json({ items: await host.outbox.next(device, done, typeof wait === 'number' ? Math.min(Math.max(wait, 0), 50) : 0) });
  }
  if (url.pathname === '/_connect/phone/items') {
    const device = phones.auth(req.headers.get('Authorization'));
    if (!device) return json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    const list = items(body);
    if (!list) return json({ errcode: 'M_BAD_JSON' }, 400);
    try {
      const { taken } = await host.phone(device, list, () => phones.count(device, 1));
      return json({ taken });
    } catch (err) {
      console.log(`phone ${device}: ${err instanceof Error ? err.message : err}`); // the phone keeps them and sends again
      return json({ errcode: 'M_UNKNOWN', error: 'try again later' }, 503);
    }
  }
  return json({ errcode: 'M_NOT_FOUND' }, 404);
}

await round('start');
setInterval(() => {
  void round('mail');
  host.outbox.expire().catch((err) => console.log(`outbox: ${err instanceof Error ? err.message : err}`));
}, 60_000);

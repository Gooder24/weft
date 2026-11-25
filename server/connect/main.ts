// matrix-spike-connect: the connector host as a service. Environment (asus ~/.config/weft/weft.env and the unit):
// ADMIN_MXID, HOMESERVER, REGISTRATION (appservices/connect.yaml), DOUBLEPUPPET, ARCHIVE_DB, CONNECT_STATE, CONNECT_PORT.
//
// HTTP on 127.0.0.1 only:
//   /_matrix/app/v1/…           the homeserver's appservice calls (hs_token); nothing comes back from Weft's side
//   GET /_connect/connectors     Karchi's token: each connector, whether it is on, its chats and items
//   PUT /_connect/connectors/<id> {"on": bool}
import { CONNECTORS } from './connectors/index.ts';
import { Host } from './host.ts';
import { Matrix, registrationToken } from './matrix.ts';

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
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/_matrix/app/')) {
      const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/, '') || url.searchParams.get('access_token');
      if (token !== hsToken) return json({ errcode: 'M_FORBIDDEN' }, 403);
      if (req.method === 'PUT' && url.pathname.startsWith('/_matrix/app/v1/transactions/')) return json({});
      if (url.pathname === '/_matrix/app/v1/ping') return json({});
      return json({ errcode: 'M_NOT_FOUND' }, 404); // ghosts and rooms exist only when the host makes them
    }
    if (!url.pathname.startsWith('/_connect/connectors')) return json({ errcode: 'M_NOT_FOUND' }, 404);
    if (!(await isOwner(req))) return json({ errcode: 'M_FORBIDDEN' }, 403);
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

await round('start');
setInterval(() => void round('mail'), 60_000);

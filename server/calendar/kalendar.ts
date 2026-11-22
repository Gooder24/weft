// Weft's calendar on asus: the master copy of Kalendarix's calendars.json and the API Weft edits it through.
//
// The doc keeps Kalendarix's layout (docs/calendars-json.md in github.com/Gooder24/kalendarix), so the same data
// shows in Weft, in Kalendarix on x270 and in its desktop widget. It lives in Postgres (database "weft" on the local
// socket, or DATABASE_URL); the first start takes over the calendars.json the Python service kept in CALENDAR_DATA.
// Ways in:
//
//   HTTP on 127.0.0.1:29327 behind Caddy /_calendar/ (Karchi's Matrix token):
//     GET  /_calendar/doc               -> {"version", "doc"}  (doc is null until a computer has sent its calendars)
//     GET  /_calendar/doc?have=<version> -> {"version", "same": true} when nothing changed since that version
//     POST /_calendar/ops {"ops": [{"op": "put", "cal": id, "event": {...}} | {"op": "del", "cal": id, "uid": uid}]}
//   CLI:
//     node kalendar.ts merge < {"base": what it last wrote from here (or null), "local": its calendars.json}
//       -> the merged file on stdout, which is now also the master (x270 runs it over ssh, see x270/). The computer
//       keeps the base itself and moves it on only once it has written the file, so a merge it could not write is
//       merged again next time instead of reading as deletions.
//     node kalendar.ts export > calendars.json   the master as a file again (a backup, or the way back to Python)
//
// Events a sync program owns (uid ending in @name) are not changed through the API. The EduPage timetable is one:
// with TIMETABLE_URL set, the service keeps it in step with Kalendarix EduPage's backend.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { applyOps, bratislavaToday, dump, isObj, merge, OpError, putTimetable, readLessons, same, version, type Json } from "./core.ts";
import { openStore, type Store } from "./store.ts";

const env = process.env;
const HS = env.HS ?? "http://127.0.0.1:8008";
const OWNER = env.OWNER ?? ""; // the owner's Matrix ID, from ~/.config/weft/weft.env on asus
const PORT = Number(env.PORT ?? "29327");
const LEGACY = join(env.CALENDAR_DATA ?? join(import.meta.dirname, "data"), "calendars.json");
const TIMETABLE_URL = (env.TIMETABLE_URL ?? "").replace(/\/+$/, ""); // empty turns the mirror off
const TIMETABLE_TOKEN = env.TIMETABLE_TOKEN ?? ""; // the backend's KX_TOKEN, when it has one
const TIMETABLE_EVERY = Number(env.TIMETABLE_EVERY ?? "120");

// ------------------------------------------------------------------ the EduPage timetable

/** One round: the backend's timetable into the master. Returns the events written (null if unchanged) and the
 * backend's last successful read of EduPage. */
export async function mirrorTimetable(store: Store, url = TIMETABLE_URL) {
  const headers: Record<string, string> = TIMETABLE_TOKEN ? { Authorization: `Bearer ${TIMETABLE_TOKEN}` } : {};
  const r = await fetch(`${url}/api/events`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const { events, fresh } = readLessons(await r.json());
  if (fresh === null) return { written: null, fresh }; // never read EduPage yet: an empty list says nothing
  const written = await store.update((doc) => {
    if (doc === null) return { result: null }; // the first calendars come from x270
    if (!putTimetable(doc, events, bratislavaToday())) return { result: null };
    return { save: doc, result: events.length };
  });
  return { written, fresh };
}

async function mirrorLoop(store: Store) {
  let failing = false;
  let seen: string | null | undefined;
  for (;;) {
    try {
      const { written, fresh } = await mirrorTimetable(store);
      if (written !== null) console.log(`timetable: ${written} events from the backend (EduPage read at ${fresh})`);
      else if (fresh !== seen) console.log(`timetable: unchanged (EduPage read at ${fresh})`);
      if (failing) console.log("timetable: backend reachable again");
      failing = false;
      seen = fresh;
    } catch (e) {
      // dell asleep or restarting: the last copy stays, the next round tries again
      if (!failing) console.log(`timetable: backend unreachable (${e instanceof Error ? e.message : e}); keeping the last copy`);
      failing = true;
    }
    await sleep(TIMETABLE_EVERY * 1000);
  }
}

// ------------------------------------------------------------------ HTTP

/** The Matrix user behind a token; `user` is for an appservice token (the EduPage bridge's double puppet). */
async function whoami(token: string, user: string | null): Promise<string> {
  const query = user ? `?${new URLSearchParams({ user_id: user })}` : "";
  const r = await fetch(`${HS}/_matrix/client/v3/account/whoami${query}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`whoami: HTTP ${r.status}`);
  return ((await r.json()) as { user_id: string }).user_id;
}

const allowed = new Map<string, number>(); // token and user -> when the homeserver last said it is Karchi

async function karchi(req: IncomingMessage, url: URL): Promise<boolean> {
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "").trim();
  if (!token) return false;
  const user = url.searchParams.get("user_id");
  const key = JSON.stringify([token, user]);
  const now = Date.now();
  for (const [k, at] of allowed) if (now - at >= 60_000) allowed.delete(k);
  if (allowed.has(key)) return true;
  const ok = await whoami(token, user).then((id) => id === OWNER, () => false);
  if (ok) allowed.set(key, now);
  return ok;
}

function send(res: ServerResponse, code: number, body: Json) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": data.length, "Cache-Control": "no-store" });
  res.end(data);
}

async function body(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? (JSON.parse(text) as Json) : {};
  } catch {
    throw new OpError("the body is not JSON");
  }
}

export function serve(store: Store, port = PORT) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://calendar");
      if (req.method !== "GET" && req.method !== "POST") return send(res, 501, { error: "unsupported method" });
      if (!(await karchi(req, url))) return send(res, 401, { error: "Karchi's token only" });
      if (req.method === "GET") {
        if (url.pathname !== "/_calendar/doc") return send(res, 404, { error: "not found" });
        const doc = await store.read();
        const v = version(doc);
        // A client polling for changes gets the whole doc only when it differs from what it has.
        const have = url.searchParams.get("have");
        if (have && have === v) return send(res, 200, { version: v, same: true });
        return send(res, 200, { version: v, doc });
      }
      if (url.pathname !== "/_calendar/ops") return send(res, 404, { error: "not found" });
      const input = await body(req);
      // A missing or empty "ops" is no change, as before.
      const raw = isObj(input) ? input.ops : undefined;
      const ops = !raw || (isObj(raw) && !Object.keys(raw).length) ? [] : raw;
      const out = await store.update((doc) => {
        if (doc === null) return { result: null };
        const changed = applyOps(doc, ops);
        return { save: changed, result: changed };
      });
      if (out === null) return send(res, 409, { error: "no calendars yet: x270 has not sent them" });
      send(res, 200, { version: version(out), doc: out });
    } catch (e) {
      if (e instanceof OpError) return send(res, 400, { error: e.message });
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: "calendar failed" });
    }
  });
  return new Promise<typeof server>((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
}

// ------------------------------------------------------------------ CLI and service

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const store = openStore(env.DATABASE_URL);
  await store.setup(LEGACY);
  const command = process.argv.slice(2);
  if (command[0] === "merge") {
    const input = JSON.parse(await stdin()) as Json;
    const local = isObj(input) && isObj(input.local) ? input.local : {};
    if (!Array.isArray(local.calendars)) throw new Error("merge: local is not a calendars.json");
    const base = isObj(input) ? input.base : null;
    const merged = await store.update((master) => {
      const out = master === null ? local : merge(base, local, master);
      return { save: same(out, master) ? undefined : out, result: out };
    });
    process.stdout.write(dump(merged));
    return store.close();
  }
  if (command[0] === "export") {
    const doc = await store.read();
    if (doc === null) throw new Error("export: no calendars yet");
    process.stdout.write(dump(doc));
    return store.close();
  }
  if (command.length) throw new Error(`unknown command ${command.join(" ")}: merge, export or none for the service`);
  if (!OWNER) throw new Error("OWNER is not set: add it to ~/.config/weft/weft.env");
  await serve(store);
  if (TIMETABLE_URL) void mirrorLoop(store);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

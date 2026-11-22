// node --test. The Postgres part needs TEST_DATABASE_URL: a throwaway database, its calendar table is dropped.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import postgres from "postgres";
import { applyOps, merge, OpError, putTimetable, version, type Lesson, type Obj } from "./core.ts";

const cal = (id: string, events: Obj[], extra: Obj = {}): Obj => ({ id, name: id, ...extra, events });
const doc = (...calendars: Obj[]): Obj => ({ version: 1, calendars });
const ev = (uid: string, fields: Obj = {}): Obj => ({ uid, title: uid, start: "2026-11-20T08:00:00.000Z", end: "2026-11-20T09:00:00.000Z", ...fields });
const events = (d: Obj, id: string) => ((d.calendars as Obj[]).find((c) => c.id === id)?.events ?? null) as Obj[] | null;

test("edits to different fields on both sides both survive; the computer wins a conflict", () => {
  const base = doc(cal("home", [ev("a", { location: "x", notes: "n" })]));
  const local = doc(cal("home", [ev("a", { location: "gym", notes: "mine" })]));
  const master = doc(cal("home", [ev("a", { location: "x", notes: "weft", title: "Tréning" })]));
  assert.deepEqual(events(merge(base, local, master), "home"), [ev("a", { location: "gym", notes: "mine", title: "Tréning" })]);
});

test("a move on one side and an edit on the other end as one event", () => {
  const base = doc(cal("home", [ev("a")]), cal("school", []));
  const local = doc(cal("home", []), cal("school", [ev("a")]));
  const master = doc(cal("home", [ev("a", { title: "Test" })]), cal("school", []));
  const out = merge(base, local, master);
  assert.deepEqual(events(out, "home"), []);
  assert.deepEqual(events(out, "school"), [ev("a", { title: "Test" })]);
});

test("a deletion on either side wins over no change; between a deletion and a change, the computer's side wins", () => {
  const base = doc(cal("home", [ev("a"), ev("b"), ev("c"), ev("d")]));
  const local = doc(cal("home", [ev("b"), ev("d", { title: "kept" })]));
  const master = doc(cal("home", [ev("a"), ev("c", { title: "lost" })]));
  assert.deepEqual(events(merge(base, local, master), "home"), [ev("d", { title: "kept" })]);
});

test("a computer that slept does not bring back old timetable lessons", () => {
  const old = ev("2026-11-20-1@lifeos", { title: "Matematika" });
  const now = ev("2026-11-20-1@lifeos", { title: "Odpadlo: Matematika" });
  const base = doc(cal("lifeos-edupage", [old]));
  const out = merge(base, doc(cal("lifeos-edupage", [old])), doc(cal("lifeos-edupage", [now])));
  assert.deepEqual(events(out, "lifeos-edupage"), [now]);
});

test("ops: a put keeps fields Weft does not send, synced events are refused, errors read as before", () => {
  const d = doc(cal("home", [ev("a", { rrule: { FREQ: "WEEKLY" }, color: "#fff" })]), cal("gmail-x", [ev("m@gmail")]));
  applyOps(d, [{ op: "put", cal: "home", event: { uid: "a", title: "New", start: "s", end: "e" } }]);
  assert.deepEqual(events(d, "home"), [{ ...ev("a", { rrule: { FREQ: "WEEKLY" }, color: "#fff" }), title: "New", start: "s", end: "e" }]);
  applyOps(d, [{ op: "put", cal: "home", event: { uid: "b", title: "B", start: "s", end: "e" } }]);
  assert.deepEqual(events(d, "home")?.[1], { description: "", notes: "", location: "", allDay: false, rrule: null, exdates: [], alarmMinutes: "", uid: "b", title: "B", start: "s", end: "e" });
  assert.throws(() => applyOps(d, [{ op: "del", cal: "gmail-x", uid: "m@gmail" }]), new OpError("this event belongs to a sync program"));
  assert.throws(() => applyOps(d, [{ op: "move", cal: "home", uid: "a" }]), new OpError("unknown op 'move'"));
  assert.throws(() => applyOps(d, [{ op: "del", cal: "nope", uid: "a" }]), new OpError("no calendar 'nope'"));
});

test("the version is the one the Python service gave the same doc", () => {
  const d = { version: 1, calendars: [{ id: "home", name: "Domov č", events: [{ uid: "a", title: "Tréning", allDay: false, rrule: null, exdates: [] }] }] };
  assert.equal(version(d), "171cfaa9701b");
  assert.equal(version(null), "");
});

test("the timetable: days the backend sent are replaced, an older day it no longer has stays", () => {
  const lesson = (uid: string, title: string): Lesson => ({ uid, title, description: "", location: "A1", start: "2026-11-20T08:00:00+01:00", end: "2026-11-20T08:45:00+01:00", all_day: false, color: null });
  const d = doc(cal("lifeos-edupage", [ev("mine"), ev("2026-10-01-1@lifeos"), ev("2026-11-20-1@lifeos"), ev("2026-11-30-1@lifeos")]));
  assert.equal(putTimetable(d, [lesson("2026-11-20-1@lifeos", "Odpadlo: Fyzika")], "2026-11-22"), true);
  assert.deepEqual(events(d, "lifeos-edupage")?.map((e) => [e.uid, e.title, e.start]), [
    ["mine", "mine", "2026-11-20T08:00:00.000Z"],
    ["2026-10-01-1@lifeos", "2026-10-01-1@lifeos", "2026-11-20T08:00:00.000Z"],
    ["2026-11-20-1@lifeos", "Odpadlo: Fyzika", "2026-11-20T07:00:00.000Z"],
  ]);
  assert.equal(putTimetable(d, [lesson("2026-11-20-1@lifeos", "Odpadlo: Fyzika")], "2026-11-22"), false);
});

// ------------------------------------------------------------------ against Postgres

const DB = process.env.TEST_DATABASE_URL;
const OWNER = "@owner:example.org";

async function fakeHomeserver(): Promise<Server> {
  const hs = createServer((req, res) => {
    const ok = req.headers.authorization === "Bearer good";
    res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ok ? { user_id: OWNER } : { errcode: "M_UNKNOWN_TOKEN" }));
  });
  await new Promise<void>((ok) => hs.listen(0, "127.0.0.1", ok));
  return hs;
}
const portOf = (s: Server) => (s.address() as AddressInfo).port;

test("the service on Postgres: takes over the file, serves, saves, and one writer at a time", { skip: !DB && "TEST_DATABASE_URL not set" }, async () => {
  const admin = postgres(DB!, { onnotice: () => {} });
  await admin`drop table if exists calendar_master`;
  const hs = await fakeHomeserver();
  const dir = mkdtempSync(join(tmpdir(), "kalendar-"));
  const legacy = doc(cal("home", [ev("a")]));
  writeFileSync(join(dir, "calendars.json"), JSON.stringify(legacy, null, 2));
  Object.assign(process.env, { HS: `http://127.0.0.1:${portOf(hs)}`, OWNER, CALENDAR_DATA: dir });
  const { serve } = await import("./kalendar.ts");
  const { openStore } = await import("./store.ts");
  const store = openStore(DB!);
  let server: Server | undefined;
  try {
    await store.setup(join(dir, "calendars.json"));
    server = await serve(store, 0);
    const base = `http://127.0.0.1:${portOf(server)}/_calendar`;
    const call = (path: string, init: RequestInit = {}, token = "good") =>
      fetch(base + path, { ...init, headers: { Authorization: `Bearer ${token}` } }).then(async (r) => ({ status: r.status, body: (await r.json()) as Obj }));

    assert.equal((await call("/doc", {}, "bad")).status, 401);
    const first = await call("/doc");
    assert.deepEqual(first.body, { version: version(legacy), doc: legacy });
    assert.deepEqual((await call(`/doc?have=${version(legacy)}`)).body, { version: version(legacy), same: true });
    assert.equal((await call("/ops", { method: "POST", body: JSON.stringify({ ops: [{ op: "del", cal: "nope", uid: "a" }] }) })).status, 400);

    // Twenty edits at once: none is lost.
    const puts = Array.from({ length: 20 }, (_, i) =>
      call("/ops", { method: "POST", body: JSON.stringify({ ops: [{ op: "put", cal: "home", event: ev(`n${i}`) }] }) }));
    assert.deepEqual((await Promise.all(puts)).map((r) => r.status), Array(20).fill(200));
    const saved = await store.read();
    assert.equal(events(saved!, "home")?.length, 21);

    // x270's merge through the CLI, and the way back to a file.
    const run = (args: string[], input: string) => {
      const child = promisify(execFile)("node", [join(import.meta.dirname, "kalendar.ts"), ...args], { env: { ...process.env, DATABASE_URL: DB } });
      child.child.stdin!.end(input);
      return child;
    };
    const local = structuredClone(saved!);
    events(local, "home")!.push(ev("from-x270"));
    const merged = JSON.parse((await run(["merge"], JSON.stringify({ base: saved, local }))).stdout) as Obj;
    assert.equal(events(merged, "home")?.at(-1)?.uid, "from-x270");
    assert.deepEqual(JSON.parse((await run(["export"], "")).stdout), merged);
  } finally {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
    await store.close();
    await admin.end();
    hs.close();
  }
});

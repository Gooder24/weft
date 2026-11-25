// The connector host: reads new mail from the archive (read-only) and takes what Karchi's phone sends, lets each
// switched-on connector make items of it, and posts them into one Matrix room per thread through the appservice. Its own state (where each connector
// is in the archive, rooms, ghosts, what was posted, the switches) is one SQLite file.
import { Database } from 'bun:sqlite';
import { flatten } from './mail.ts';
import { Matrix, MatrixError } from './matrix.ts';
import { key as phoneKey, parse as phoneItem } from './connectors/phone.ts';
import type { Connector, Item, Mail, PhoneItem } from './types.ts';

const DAY = 86_400_000;
export const BACK = 30 * DAY; // how far back a connector looks the first time (and after being off)
const SEEN = DAY; // an item older than this when it comes is posted read: it is history, not news
const MARK = 'sk.karchi.connect';
const WEFT_SEEN = 'sk.karchi.edupage.seen'; // „seen up to“ per room that `weft chats` reads; Weft's inbox counts by receipt

type Row = { rowid: number; id: string; ts: number; sender: string; body: string };

export class Host {
  readonly db: Database;
  readonly archive: Database;
  private busy: Promise<number> | null = null;
  private line: Promise<unknown> = Promise.resolve(); // mail and the phone post one at a time: a new thread gets one room

  constructor(readonly opts: { archive: string; state: string; matrix: Matrix; connectors: Connector[]; now?: () => number }) {
    this.db = new Database(opts.state, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cursors (connector TEXT PRIMARY KEY, rowid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS switches (connector TEXT PRIMARY KEY, active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms (connector TEXT NOT NULL, thread TEXT NOT NULL, room TEXT NOT NULL, PRIMARY KEY (connector, thread));
      CREATE TABLE IF NOT EXISTS ghosts (mxid TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (room TEXT NOT NULL, mxid TEXT NOT NULL, PRIMARY KEY (room, mxid));
      CREATE TABLE IF NOT EXISTS posted (key TEXT PRIMARY KEY, connector TEXT NOT NULL, room TEXT NOT NULL, event TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS unseen (room TEXT PRIMARY KEY, ts INTEGER NOT NULL);`);
    this.archive = new Database(opts.archive, { readonly: true, strict: true });
  }

  now() {
    return (this.opts.now ?? Date.now)();
  }

  isOn(id: string) {
    const row = this.db.query<{ active: number }, [string]>('SELECT active FROM switches WHERE connector = ?').get(id);
    return row ? row.active === 1 : true; // a connector reads only mail already here: on unless Karchi turns it off
  }

  /** Off stops new items at once; on again catches up on the last BACK as on the first start (nothing comes twice). */
  setOn(id: string, active: boolean) {
    if (!this.opts.connectors.some((c) => c.id === id)) return false;
    this.db.query('INSERT INTO switches VALUES (?, ?) ON CONFLICT (connector) DO UPDATE SET active = excluded.active').run(id, active ? 1 : 0);
    if (!active) this.db.query('DELETE FROM cursors WHERE connector = ?').run(id);
    return true;
  }

  status() {
    return this.opts.connectors.map((c) => {
      const n = this.db.query<{ chats: number }, [string]>('SELECT COUNT(*) AS chats FROM rooms WHERE connector = ?').get(c.id);
      const p = this.db.query<{ items: number; last: number | null }, [string]>('SELECT COUNT(*) AS items, MAX(ts) AS last FROM posted WHERE connector = ?').get(c.id);
      return { id: c.id, name: c.name, on: this.isOn(c.id), chats: n?.chats ?? 0, items: p?.items ?? 0, last: p?.last ?? null };
    });
  }

  /** One pass over new mail for every connector that is on; returns how many items it posted. Never two at once. */
  round() {
    this.busy ??= this.serial(() => this.pass()).finally(() => { this.busy = null; });
    return this.busy;
  }

  private serial<T>(work: () => Promise<T>) {
    const run = this.line.then(work, work);
    this.line = run.catch(() => {});
    return run;
  }

  /** What a phone sent: each item once (`phoneKey`), into its SMS or app chat; returns the ids taken, which the phone
   *  may forget, and how many were new (`counted` hears each at once, so a request that fails halfway still counts
   *  what it posted). An item a switched-off connector does not take is taken too, so the phone stops sending it. */
  phone(device: string, items: PhoneItem[], counted: () => void = () => {}) {
    return this.serial(async () => {
      const taken: string[] = [];
      let posted = 0;
      for (const p of items.toSorted((a, b) => a.ts - b.ts)) {
        const made = phoneItem(p);
        if (made && this.isOn(made[0].id) && this.now() - p.ts < BACK) {
          await this.post(made[0], `phone:${phoneKey(p)}`, p.ts, made[1], { phone: device }, () => {
            posted++;
            counted();
          });
        }
        taken.push(p.id);
      }
      await this.markSeen();
      return { taken, posted };
    });
  }

  /** Each connector on its own: one that fails (the homeserver down, a mail its rules choke on) keeps its place in the
   *  archive for the next pass and does not stop the others. History is marked seen at the end, also after a failure. */
  private async pass() {
    let posted = 0;
    const failed: unknown[] = [];
    for (const c of this.opts.connectors) {
      if (!c.mail || !this.isOn(c.id)) continue;
      try {
        posted += await this.read(c);
      } catch (err) {
        failed.push(err);
      }
    }
    try {
      await this.markSeen();
    } catch (err) {
      failed.push(err);
    }
    if (failed.length) throw failed[0];
    return posted;
  }

  private async read(c: Connector) {
    const rules = c.mail;
    if (!rules) return 0;
    let posted = 0;
    const cursor = this.db.query<{ rowid: number }, [string]>('SELECT rowid FROM cursors WHERE connector = ?').get(c.id)?.rowid ?? 0;
    const rows = this.archive.query<Row, [number, number]>(`SELECT m.rowid AS rowid, m.id AS id, m.ts AS ts, m.sender AS sender, m.body AS body
      FROM messages m JOIN chats c ON c.id = m.chat
      WHERE c.network IN ('gmail', 'outlook') AND m.me = 0 AND m.rowid > ? AND m.ts > ? ORDER BY m.rowid LIMIT 2000`).all(cursor, this.now() - BACK);
    // The archive takes old mail newest first: a batch goes in by time, so a chat reads in order. The cursor moves
    // only past a whole batch; a failure retries it, and what was posted is not posted again.
    for (const row of rows.toSorted((a, b) => a.ts - b.ts)) {
      if (!rules.from(row.sender)) continue;
      const mail: Mail = { id: row.id, from: row.sender, ts: row.ts, ...flatten(row.body) };
      for (const [i, item] of rules.parse(mail).entries()) if (await this.post(c, `${c.id}:${mail.id}:${i}`, mail.ts, item, { mail: mail.id })) posted++;
    }
    const last = rows.at(-1);
    if (last) this.db.query('INSERT INTO cursors VALUES (?, ?) ON CONFLICT (connector) DO UPDATE SET rowid = excluded.rowid').run(c.id, last.rowid);
    return posted;
  }

  /** History shows as seen in `weft` too: each room's newest old item goes into Karchi's „seen up to“ (kept in `unseen` until
   *  written, so a failure retries it). A later value already there (he opened the chat) stays. */
  private async markSeen() {
    const rows = this.db.query<{ room: string; ts: number }, []>('SELECT room, ts FROM unseen').all();
    if (!rows.length) return;
    const m = this.opts.matrix;
    const path = `/user/${q(m.admin)}/account_data/${WEFT_SEEN}`;
    const seen = await m.call('GET', path, undefined, { user: m.admin }).catch((err): Record<string, unknown> => {
      // None yet: everything before now counts as seen (Weft starts it so on its first run), so history needs no write.
      if (err instanceof MatrixError && err.status === 404) return { _all: this.now() };
      throw err;
    });
    let changed = false;
    for (const { room, ts } of rows) {
      const was = Number(seen[room] ?? seen._all ?? 0);
      if (!(was >= ts)) { seen[room] = ts; changed = true; }
    }
    if (changed) await m.call('PUT', path, seen, { user: m.admin });
    const done = this.db.query('DELETE FROM unseen WHERE room = ? AND ts = ?');
    for (const { room, ts } of rows) done.run(room, ts);
  }

  /** `key` makes it once; `origin` says in the event where it came from (a mail's archive id, a phone). `stored` hears
   *  it the moment it is in the chat, before the read receipt that may still fail. */
  private async post(c: Connector, key: string, ts: number, item: Item, origin: Record<string, string>, stored = () => {}) {
    if (this.db.query('SELECT 1 FROM posted WHERE key = ?').get(key)) return false;
    const room = await this.room(c, item);
    const sender = item.mine ? this.opts.matrix.admin : await this.ghost(c, item.from); // his own SMS as himself, joined with the room
    await this.join(room, sender);
    const txn = `cx-${new Bun.CryptoHasher('sha256').update(key).digest('hex').slice(0, 32)}`;
    const content = { msgtype: 'm.text', body: item.text, [MARK]: { connector: c.id, ...origin } };
    const sent = await this.opts.matrix.call('PUT', `/rooms/${q(room)}/send/m.room.message/${txn}`, content, { user: sender, query: { ts } });
    const event = String(sent.event_id);
    this.db.query('INSERT INTO posted VALUES (?, ?, ?, ?, ?)').run(key, c.id, room, event, ts);
    stored();
    if (!item.mine && this.now() - ts > SEEN) {
      this.db.query('INSERT INTO unseen VALUES (?, ?) ON CONFLICT (room) DO UPDATE SET ts = MAX(ts, excluded.ts)').run(room, ts);
      await this.opts.matrix.call('POST', `/rooms/${q(room)}/receipt/m.read/${q(event)}`, {}, { user: this.opts.matrix.admin });
    }
    return true;
  }

  /** The connector's own ghost („Vinted“) or a person's in it („kupec42“). */
  private async ghost(c: Connector, person?: string) {
    const m = this.opts.matrix;
    const local = person ? `cx_${c.id}_${new Bun.CryptoHasher('sha256').update(person).digest('hex').slice(0, 12)}` : `cx_${c.id}`;
    const mxid = `@${local}:${m.server}`;
    const name = person ?? c.name;
    const known = this.db.query<{ name: string }, [string]>('SELECT name FROM ghosts WHERE mxid = ?').get(mxid);
    if (known?.name === name) return mxid;
    if (!known) {
      try {
        await m.call('POST', '/register', { type: 'm.login.application_service', username: local }, { user: null });
      } catch (err) {
        if (!(err instanceof MatrixError && err.errcode === 'M_USER_IN_USE')) throw err;
      }
    }
    await m.call('PUT', `/profile/${q(mxid)}/displayname`, { displayname: name }, { user: mxid });
    this.db.query('INSERT INTO ghosts VALUES (?, ?) ON CONFLICT (mxid) DO UPDATE SET name = excluded.name').run(mxid, name);
    return mxid;
  }

  private async room(c: Connector, item: Item) {
    const known = this.db.query<{ room: string }, [string, string]>('SELECT room FROM rooms WHERE connector = ? AND thread = ?').get(c.id, item.thread);
    if (known) return known.room;
    const m = this.opts.matrix;
    const bridge = {
      bridgebot: m.bot, creator: m.bot,
      protocol: { id: c.id, displayname: c.name, ...(c.link ? { external_url: c.link } : {}) },
      channel: { id: item.thread, displayname: item.title },
    };
    const made = await m.call('POST', '/createRoom', {
      preset: 'private_chat', invite: [m.admin], name: item.title,
      initial_state: [{ type: 'm.bridge', state_key: `${c.id}://${item.thread}`, content: bridge }],
      creation_content: { 'm.federate': false },
    });
    const room = String(made.room_id);
    this.db.query('INSERT INTO rooms VALUES (?, ?, ?)').run(c.id, item.thread, room);
    this.db.query('INSERT OR IGNORE INTO members VALUES (?, ?)').run(room, m.bot);
    await this.join(room, m.admin);
    return room;
  }

  private async join(room: string, mxid: string) {
    if (this.db.query('SELECT 1 FROM members WHERE room = ? AND mxid = ?').get(room, mxid)) return;
    const m = this.opts.matrix;
    if (mxid !== m.admin) {
      try {
        await m.call('POST', `/rooms/${q(room)}/invite`, { user_id: mxid });
      } catch (err) {
        if (!(err instanceof MatrixError && err.errcode === 'M_FORBIDDEN')) throw err; // already in
      }
    }
    await m.call('POST', `/join/${q(room)}`, {}, { user: mxid });
    this.db.query('INSERT OR IGNORE INTO members VALUES (?, ?)').run(room, mxid);
  }
}

const q = encodeURIComponent;

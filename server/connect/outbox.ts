// What Karchi writes in Weft into an SMS chat or an app's chat (beta): the homeserver hands it to the appservice, a
// paired phone takes it and sends it (an SMS, or the answer through that notification's own Reply button) and says
// how it went. A message goes out at most once: the phone keeps what it took and never sends it twice, and one no
// phone took within an hour is not sent at all (an SMS that late is worse than none). What did not go is said in
// the chat, as a notice under the message.
import type { Database } from 'bun:sqlite';
import { number } from './connectors/phone.ts';
import type { Matrix } from './matrix.ts';
import type { PhoneItem } from './types.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX = 2000; // characters of one message: an SMS of a dozen parts at most
export const MARK = 'sk.karchi.connect'; // in what the host itself writes; never taken as Karchi's

/** What a phone gets to send: an SMS to a number, or an answer to the notification the phone knows by `to`. */
export type Out = { id: string; kind: 'sms' | 'reply'; to: string; text: string };
export type Report = { id: string; ok: boolean; error?: string };

type Row = { event: string; room: string; kind: 'sms' | 'reply'; target: string; text: string };
type Ev = { type?: unknown; event_id?: unknown; room_id?: unknown; sender?: unknown; content?: unknown };
type Content = { msgtype?: unknown; body?: unknown; 'm.relates_to'?: { rel_type?: unknown; 'm.in_reply_to'?: { event_id?: unknown } } } & Record<string, unknown>;

export class Outbox {
  private waiting = new Set<() => void>();

  constructor(private db: Database, private matrix: Matrix, private now: () => number) {
    db.exec(`CREATE TABLE IF NOT EXISTS outbox (event TEXT PRIMARY KEY, room TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
      text TEXT NOT NULL, created INTEGER NOT NULL, device TEXT, leased INTEGER, state TEXT NOT NULL, done INTEGER, echoed INTEGER NOT NULL DEFAULT 0)`);
  }

  /** The homeserver's events (an appservice transaction): Karchi's messages in the phone's chats join the outbox once
   *  (a transaction sent again adds nothing). One that cannot go gets its notice at once. */
  async take(events: unknown[]) {
    for (const ev of events as Ev[]) {
      if (ev?.type !== 'm.room.message' || ev.sender !== this.matrix.admin || typeof ev.event_id !== 'string' || typeof ev.room_id !== 'string') continue;
      const c = (ev.content ?? {}) as Content;
      if (c[MARK]) continue; // his SMS from the phone, which the host posted as him
      const chat = this.db.query<{ connector: string; thread: string }, [string]>("SELECT connector, thread FROM rooms WHERE room = ? AND connector IN ('sms', 'phone')").get(ev.room_id);
      if (!chat || this.db.query('SELECT 1 FROM outbox WHERE event = ?').get(ev.event_id)) continue;
      const why = this.refuse(chat, c);
      if (typeof why === 'string') {
        await this.notice(ev.room_id, ev.event_id, why);
        continue;
      }
      this.db.query("INSERT OR IGNORE INTO outbox (event, room, kind, target, text, created, state) VALUES (?, ?, ?, ?, ?, ?, 'new')")
        .run(ev.event_id, ev.room_id, why.kind, why.target, why.text, this.now());
      for (const wake of this.waiting) wake();
    }
  }

  /** Why a message cannot go (said to Karchi), or what goes. */
  private refuse(chat: { connector: string; thread: string }, c: Content): string | { kind: 'sms' | 'reply'; target: string; text: string } {
    const rel = c['m.relates_to'];
    if (rel?.rel_type === 'm.replace') return 'Úpravu do telefónu poslať nejde, platí pôvodná správa.';
    if (c.msgtype !== 'm.text' || typeof c.body !== 'string') return 'Cez telefón ide zatiaľ len text.';
    const text = plain(c.body, !!rel?.['m.in_reply_to']).trim();
    if (!text) return 'Prázdna správa sa neposiela.';
    if (text.length > MAX) return `Správa je dlhšia než ${MAX} znakov, neodišla.`;
    if (!this.db.query("SELECT 1 FROM sqlite_master WHERE name = 'phones'").get() || !this.db.query('SELECT 1 FROM phones LIMIT 1').get()) return 'Nemáš spárovaný telefón (Nastavenia → Účty → Telefón).';
    if (chat.connector === 'sms') {
      if (!/^\+?\d{3,}$/.test(chat.thread)) return 'Na odosielateľa s menom namiesto čísla sa odpovedať nedá.';
      return { kind: 'sms', target: chat.thread, text };
    }
    // An app's chat holds many conversations: the answer goes only to the message it answers, never to a guess.
    const to = rel?.['m.in_reply_to']?.event_id;
    const key = typeof to === 'string'
      ? this.db.query<{ key: string }, [string]>("SELECT key FROM posted WHERE event = ? AND key LIKE 'phone:n:%'").get(to)?.key
      : undefined;
    if (!key) return 'Odpovedz na konkrétnu správu (Odpovedať), aby odišla správnemu človeku.';
    return { kind: 'reply', target: key.slice('phone:n:'.length), text };
  }

  /** A phone's turn: first what it reports, then what it may send (what waits, and what it took before and has not
   *  reported). With `wait` (seconds) it waits that long for something new. */
  async next(device: string, reports: Report[], wait = 0): Promise<Out[]> {
    await this.report(device, reports);
    let out = this.lease(device);
    if (out.length || wait <= 0) return out;
    await new Promise<void>((done) => {
      const wake = () => { clearTimeout(timer); this.waiting.delete(wake); done(); };
      const timer = setTimeout(wake, wait * 1000);
      this.waiting.add(wake);
    });
    out = this.lease(device);
    return out;
  }

  private lease(device: string): Out[] {
    const rows = this.db.query<Row & { state: string }, [string]>(`SELECT event, room, kind, target, text, state FROM outbox
      WHERE state = 'new' OR (state = 'out' AND device = ?) ORDER BY created LIMIT 20`).all(device);
    const mark = this.db.query("UPDATE outbox SET state = 'out', device = ?, leased = ? WHERE event = ? AND state = 'new'");
    for (const r of rows) if (r.state === 'new') mark.run(device, this.now(), r.event);
    return rows.map((r) => ({ id: r.event, kind: r.kind, to: r.target, text: r.text }));
  }

  private async report(device: string, reports: Report[]) {
    for (const r of reports) {
      const row = this.db.query<{ room: string }, [string, string]>("SELECT room FROM outbox WHERE event = ? AND device = ? AND state = 'out'").get(r.id, device);
      if (!row) continue; // reported before, or not this phone's
      this.db.query('UPDATE outbox SET state = ?, done = ? WHERE event = ?').run(r.ok ? 'sent' : 'failed', this.now(), r.id);
      if (!r.ok) await this.notice(row.room, r.id, `Neodišlo: ${(r.error || 'telefón nepovedal prečo').slice(0, 200)}`);
    }
  }

  /** Every minute: what no phone took within an hour is not sent any more; what a phone took and never reported is
   *  said to be unsure. */
  async expire() {
    const hour = this.now() - HOUR;
    for (const r of this.db.query<{ event: string; room: string }, [number]>("SELECT event, room FROM outbox WHERE state = 'new' AND created < ?").all(hour)) {
      this.db.query("UPDATE outbox SET state = 'failed', done = ? WHERE event = ? AND state = 'new'").run(this.now(), r.event);
      await this.notice(r.room, r.event, 'Telefón sa hodinu neozval, správu som už neposlal.');
    }
    for (const r of this.db.query<{ event: string; room: string }, [number]>("SELECT event, room FROM outbox WHERE state = 'out' AND leased < ?").all(hour)) {
      this.db.query("UPDATE outbox SET state = 'unknown', done = ? WHERE event = ? AND state = 'out'").run(this.now(), r.event);
      await this.notice(r.room, r.event, 'Telefón nepovedal, či správa odišla. Pozri sa do neho.');
    }
    this.db.query("DELETE FROM outbox WHERE state != 'new' AND state != 'out' AND done < ?").run(this.now() - 30 * DAY);
  }

  /** A sent SMS the phone reads back from its own store is Karchi's message from Weft: the room has it already. */
  echo(p: PhoneItem) {
    if (p.kind !== 'sms' || !p.out || !p.address) return null;
    const row = this.db.query<{ event: string; room: string }, [string, string, number, number]>(`SELECT event, room FROM outbox
      WHERE kind = 'sms' AND target = ? AND text = ? AND echoed = 0 AND state IN ('out', 'sent', 'unknown') AND created BETWEEN ? AND ?
      ORDER BY created LIMIT 1`).get(number(p.address), p.text.trim(), p.ts - DAY, p.ts + 5 * 60_000);
    if (row) this.db.query('UPDATE outbox SET echoed = 1 WHERE event = ?').run(row.event);
    return row;
  }

  private async notice(room: string, event: string, body: string) {
    const txn = `cxo-${new Bun.CryptoHasher('sha256').update(`${event}\n${body}`).digest('hex').slice(0, 32)}`;
    const content = { msgtype: 'm.notice', body, 'm.relates_to': { 'm.in_reply_to': { event_id: event } }, [MARK]: { outbox: true } };
    await this.matrix.call('PUT', `/rooms/${encodeURIComponent(room)}/send/m.room.message/${txn}`, content).catch((err) => {
      console.log(`notice in ${room}: ${err instanceof Error ? err.message : err}`);
    });
  }
}

/** The text without the quote of the message it answers (a reply's fallback). */
function plain(body: string, reply: boolean) {
  if (!reply || !body.startsWith('> ')) return body;
  const lines = body.split('\n');
  const i = lines.findIndex((l) => !l.startsWith('>'));
  return lines.slice(i < 0 ? lines.length : i).join('\n');
}

/** What a phone reports, or null when it is not that. */
export function reports(body: unknown): Report[] | null {
  const list = (body as { done?: unknown } | null)?.done ?? [];
  if (!Array.isArray(list) || list.length > 100) return null;
  const out: Report[] = [];
  for (const x of list as Record<string, unknown>[]) {
    if (typeof x?.id !== 'string' || typeof x.ok !== 'boolean') return null;
    out.push({ id: x.id, ok: x.ok, ...(typeof x.error === 'string' ? { error: x.error } : {}) });
  }
  return out;
}

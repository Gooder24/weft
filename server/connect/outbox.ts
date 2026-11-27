// What Karchi writes in Weft into an SMS chat or an app's chat (beta): the homeserver hands it to the appservice, a
// paired phone takes it and sends it (an SMS, or the answer through that notification's own Reply button) and says
// how it went. A message goes out at most once: the phone keeps what it took and never sends it twice, and one no
// phone took within an hour is not sent at all (an SMS that late is worse than none). Weft hears it as from any
// bridge: the bot's com.beeper.message_send_status once the phone sent it (✓), the mautrix bridges' „⚠️ Your message
// was not bridged: <why>“ notice when it did not (Weft marks the message Neodoslané with the reason).
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
type Ev = { type?: unknown; event_id?: unknown; room_id?: unknown; sender?: unknown; origin_server_ts?: unknown; content?: unknown };
type Content = { msgtype?: unknown; body?: unknown; 'm.relates_to'?: { rel_type?: unknown; 'm.in_reply_to'?: { event_id?: unknown } } } & Record<string, unknown>;

export class Outbox {
  private waiting = new Set<() => void>();

  constructor(private db: Database, private matrix: Matrix, private now: () => number) {
    // device: the phone it must go from (the one the answered notification or the number's last SMS came from; null:
    // any), then the one that took it. said: Weft heard how it went (the status or notice is written again until then).
    db.exec(`CREATE TABLE IF NOT EXISTS outbox (event TEXT PRIMARY KEY, room TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
      text TEXT NOT NULL, created INTEGER NOT NULL, device TEXT, leased INTEGER, state TEXT NOT NULL, done INTEGER, echoed INTEGER NOT NULL DEFAULT 0,
      said INTEGER NOT NULL DEFAULT 0)`);
    if (!db.query<{ name: string }, []>('PRAGMA table_info(outbox)').all().some((c) => c.name === 'said')) {
      db.exec('ALTER TABLE outbox ADD COLUMN said INTEGER NOT NULL DEFAULT 0'); // a table from the first beta
    }
  }

  /** The homeserver's events (an appservice transaction): Karchi's messages in the phone's chats join the outbox once
   *  (a transaction sent again adds nothing). One that cannot go is refused at once, with its reason. */
  async take(events: unknown[]) {
    for (const ev of events as Ev[]) {
      if (ev?.type !== 'm.room.message' || ev.sender !== this.matrix.admin || typeof ev.event_id !== 'string' || typeof ev.room_id !== 'string') continue;
      const c = (ev.content ?? {}) as Content;
      if (c[MARK]) continue; // his SMS from the phone, which the host posted as him
      const chat = this.db.query<{ connector: string; thread: string }, [string]>("SELECT connector, thread FROM rooms WHERE room = ? AND connector IN ('sms', 'phone')").get(ev.room_id);
      if (!chat || this.db.query('SELECT 1 FROM outbox WHERE event = ?').get(ev.event_id)) continue;
      // Written more than an hour ago (the homeserver delivers late, or again after a long outage): never sent now.
      const ts = typeof ev.origin_server_ts === 'number' ? ev.origin_server_ts : this.now();
      const why = this.now() - ts > HOUR ? 'Správa prišla k telefónu až po hodine, tak som ju už neposlal.' : this.refuse(chat, ev.room_id, c);
      if (typeof why === 'string') {
        this.db.query("INSERT OR IGNORE INTO outbox (event, room, kind, target, text, created, state, done) VALUES (?, ?, 'refused', '', ?, ?, 'failed', ?)")
          .run(ev.event_id, ev.room_id, why, this.now(), this.now());
        await this.tell(ev.event_id);
        continue;
      }
      this.db.query("INSERT OR IGNORE INTO outbox (event, room, kind, target, text, created, device, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'new')")
        .run(ev.event_id, ev.room_id, why.kind, why.target, why.text, ts, why.device);
      for (const wake of this.waiting) wake();
    }
  }

  /** Why a message cannot go (said to Karchi), or what goes and from which phone. */
  private refuse(chat: { connector: string; thread: string }, room: string, c: Content): string | { kind: 'sms' | 'reply'; target: string; text: string; device: string | null } {
    const rel = c['m.relates_to'];
    if (rel?.rel_type === 'm.replace') return 'Úpravu do telefónu poslať nejde, platí pôvodná správa.';
    if (c.msgtype !== 'm.text' || typeof c.body !== 'string') return 'Cez telefón ide zatiaľ len text.';
    const text = plain(c.body).trim();
    if (!text) return 'Prázdna správa sa neposiela.';
    if (text.length > MAX) return `Správa je dlhšia než ${MAX} znakov, neodišla.`;
    if (!this.db.query("SELECT 1 FROM sqlite_master WHERE name = 'phones'").get() || !this.db.query('SELECT 1 FROM phones LIMIT 1').get()) return 'Nemáš spárovaný telefón (Nastavenia → Účty → Telefón).';
    const known = (device: string | null | undefined) => (device && this.db.query('SELECT 1 FROM phones WHERE id = ?').get(device) ? device : null);
    if (chat.connector === 'sms') {
      if (!/^\+?\d{3,}$/.test(chat.thread)) return 'Na odosielateľa s menom namiesto čísla sa odpovedať nedá.';
      // From the phone this number last wrote to or from (its SIM); any phone when none is known.
      const last = this.db.query<{ device: string | null }, [string]>("SELECT device FROM posted WHERE room = ? AND device IS NOT NULL ORDER BY ts DESC LIMIT 1").get(room);
      return { kind: 'sms', target: chat.thread, text, device: known(last?.device) };
    }
    // An app's chat holds many conversations: the answer goes only to the message of this chat it answers, from the
    // phone that has its notification, never to a guess.
    const to = rel?.['m.in_reply_to']?.event_id;
    const row = typeof to === 'string'
      ? this.db.query<{ key: string; device: string | null }, [string, string]>("SELECT key, device FROM posted WHERE event = ? AND room = ? AND key LIKE 'phone:n:%'").get(to, room)
      : null;
    if (!row) return 'Odpovedz na konkrétnu správu (Odpovedať), aby odišla správnemu človeku.';
    if (row.device && !known(row.device)) return 'Telefón, z ktorého táto správa prišla, už nie je spárovaný.';
    return { kind: 'reply', target: row.key.slice('phone:n:'.length), text, device: row.device };
  }

  /** A phone's turn: first what it reports, then what it may send. A long poll (`wait` seconds) gets only what is new
   *  and waits for it; a plain request also gets again what this phone took and has not reported (the phone never
   *  sends one twice, it reports it instead). */
  async next(device: string, reports: Report[], wait = 0): Promise<Out[]> {
    await this.report(device, reports);
    const again = wait > 0 ? [] : this.taken(device);
    let out = this.lease(device);
    if (out.length || wait <= 0) return [...again, ...out];
    await new Promise<void>((done) => {
      const wake = () => { clearTimeout(timer); this.waiting.delete(wake); done(); };
      const timer = setTimeout(wake, wait * 1000);
      this.waiting.add(wake);
    });
    // Unpaired while it waited: nothing more for it.
    if (!this.db.query('SELECT 1 FROM phones WHERE id = ?').get(device)) return [];
    out = this.lease(device);
    return out;
  }

  private lease(device: string): Out[] {
    const rows = this.db.query<Row, [string, number]>(`SELECT event, room, kind, target, text FROM outbox
      WHERE state = 'new' AND (device IS NULL OR device = ?) AND created >= ? ORDER BY created LIMIT 20`).all(device, this.now() - HOUR);
    const mark = this.db.query("UPDATE outbox SET state = 'out', device = ?, leased = ? WHERE event = ? AND state = 'new'");
    return rows.filter((r) => mark.run(device, this.now(), r.event).changes > 0).map(out);
  }

  private taken(device: string): Out[] {
    return this.db.query<Row, [string]>("SELECT event, room, kind, target, text FROM outbox WHERE state = 'out' AND device = ? ORDER BY created LIMIT 20").all(device).map(out);
  }

  private async report(device: string, reports: Report[]) {
    for (const r of reports) {
      const done = this.db.query("UPDATE outbox SET state = ?, done = ?, text = CASE WHEN ? THEN text ELSE ? END WHERE event = ? AND device = ? AND state = 'out'")
        .run(r.ok ? 'sent' : 'failed', this.now(), r.ok ? 1 : 0, (r.error || 'Telefón nepovedal prečo.').slice(0, 200), r.id, device);
      if (done.changes) await this.tell(r.id); // else reported before, or not this phone's
    }
  }

  /** Every minute: what no phone took within an hour is not sent any more; what a phone took and never reported is
   *  said to be unsure; what Weft did not hear yet is said again. */
  async expire() {
    const hour = this.now() - HOUR;
    this.db.query("UPDATE outbox SET state = 'failed', done = ?, text = 'Telefón sa hodinu neozval, správu som už neposlal.' WHERE state = 'new' AND created < ?").run(this.now(), hour);
    this.db.query("UPDATE outbox SET state = 'unknown', done = ? WHERE state = 'out' AND leased < ?").run(this.now(), hour);
    for (const r of this.db.query<{ event: string }, [number]>("SELECT event FROM outbox WHERE said = 0 AND state IN ('sent', 'failed', 'unknown') AND done > ?").all(this.now() - DAY)) {
      await this.tell(r.event);
    }
    this.db.query("DELETE FROM outbox WHERE state != 'new' AND state != 'out' AND done < ?").run(this.now() - 30 * DAY);
  }

  /** A sent SMS the phone reads back from its own store is Karchi's message from Weft: the room has it already. Only
   *  one sent after the phone took the message (an SMS he typed on the phone before is his own). */
  echo(p: PhoneItem) {
    if (p.kind !== 'sms' || !p.out || !p.address) return null;
    const row = this.db.query<{ event: string; room: string }, [string, string, number, number]>(`SELECT event, room FROM outbox
      WHERE kind = 'sms' AND target = ? AND text = ? AND echoed = 0 AND state IN ('out', 'sent', 'unknown') AND leased BETWEEN ? AND ?
      ORDER BY created LIMIT 1`).get(number(p.address), p.text.trim(), p.ts - DAY, p.ts + 60_000);
    if (row) this.db.query('UPDATE outbox SET echoed = 1 WHERE event = ?').run(row.event);
    return row;
  }

  /** Weft hears how it went: the bot's send status (✓) once the phone sent it, else the bridges' notice with the reason
   *  (a failed one's reason is kept in `text`). */
  private async tell(event: string) {
    const r = this.db.query<{ room: string; state: string; text: string }, [string]>('SELECT room, state, text FROM outbox WHERE event = ?').get(event);
    if (!r) return;
    const [type, content] = r.state === 'sent'
      ? ['com.beeper.message_send_status', { 'm.relates_to': { rel_type: 'm.reference', event_id: event }, status: 'SUCCESS', network: 'phone' }]
      : ['m.room.message', {
        msgtype: 'm.notice', 'm.relates_to': { 'm.in_reply_to': { event_id: event } }, [MARK]: { outbox: true },
        body: r.state === 'unknown' ? '\u26a0\ufe0f Your message may not have been bridged: Telefón nepovedal, či správa odišla. Pozri sa do neho.'
          : `\u26a0\ufe0f Your message was not bridged: ${r.text}`,
      }];
    const txn = `cxo-${new Bun.CryptoHasher('sha256').update(`${event}\n${r.state}`).digest('hex').slice(0, 32)}`;
    try {
      await this.matrix.call('PUT', `/rooms/${encodeURIComponent(r.room)}/send/${type}/${txn}`, content);
      this.db.query('UPDATE outbox SET said = 1 WHERE event = ?').run(event);
    } catch (err) {
      console.log(`${type} in ${r.room}: ${err instanceof Error ? err.message : err}`); // said again next minute
    }
  }
}

const out = (r: Row): Out => ({ id: r.event, kind: r.kind, to: r.target, text: r.text });

/** The text without the quote of the message it answers (the spec's reply fallback, „> <@who> …“ lines and an
 *  empty one). Weft sends none; Karchi's own lines starting with „> “ stay. */
function plain(body: string) {
  if (!body.startsWith('> <')) return body;
  const lines = body.split('\n');
  const i = lines.findIndex((l) => !l.startsWith('>'));
  return i < 0 ? '' : lines.slice(i).join('\n');
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

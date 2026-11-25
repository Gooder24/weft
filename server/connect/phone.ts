// Karchi's phones (android/, Weft Telefón): pairing and their tokens. Weft asks for a short code (Karchi's token), the
// phone claims it within ten minutes and gets its own token, which can only send items. „Odpojiť“ in Weft forgets
// the phone: its token stops working at once. Tokens are kept only as their sha256.
import type { Database } from 'bun:sqlite';
import type { PhoneItem } from './types.ts';

const CODE_LIFE = 10 * 60_000;
const MISSES = 5; // wrong codes that void every pending one: guessing has five tries per code
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I: it is typed by hand on a phone

const sha = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex');
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export type Phone = { id: string; name: string; created: number; seen: number | null; items: number };

export class Phones {
  private misses = 0;

  constructor(private db: Database, private now: () => number) {
    db.exec(`CREATE TABLE IF NOT EXISTS phones (id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, seen INTEGER);
      CREATE TABLE IF NOT EXISTS pairing (code TEXT PRIMARY KEY, expires INTEGER NOT NULL);`);
  }

  /** A new code for one phone, „ABCD-EFGH“. */
  code() {
    const code = [...random(8)].map((b) => LETTERS[b % LETTERS.length]).join('');
    this.db.query('DELETE FROM pairing WHERE expires < ?').run(this.now());
    this.db.query('INSERT INTO pairing VALUES (?, ?)').run(code, this.now() + CODE_LIFE);
    this.misses = 0;
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expires: this.now() + CODE_LIFE };
  }

  /** The phone's side: a valid code gives it an id and a token once; else null. */
  claim(code: string, name: string) {
    const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const row = this.db.query<{ expires: number }, [string]>('SELECT expires FROM pairing WHERE code = ?').get(clean);
    if (!row || row.expires < this.now()) {
      if (++this.misses >= MISSES) this.db.exec('DELETE FROM pairing');
      return null;
    }
    this.db.query('DELETE FROM pairing WHERE code = ?').run(clean);
    const id = Buffer.from(random(6)).toString('hex');
    const token = `wp_${Buffer.from(random(32)).toString('base64url')}`;
    this.db.query('INSERT INTO phones VALUES (?, ?, ?, ?, NULL)').run(id, name.trim().slice(0, 60) || 'Telefón', sha(token), this.now());
    return { id, token };
  }

  /** The phone a token belongs to, which is now seen. */
  auth(header: string | null) {
    const token = (header ?? '').replace(/^Bearer\s+/, '');
    if (!token.startsWith('wp_')) return null;
    const row = this.db.query<{ id: string }, [string]>('SELECT id FROM phones WHERE token = ?').get(sha(token));
    if (row) this.db.query('UPDATE phones SET seen = ? WHERE id = ?').run(this.now(), row.id);
    return row?.id ?? null;
  }

  list() {
    return this.db.query<Phone, []>(`SELECT id, name, created, seen, (SELECT COUNT(*) FROM posted WHERE key LIKE 'phone:' || phones.id || ':%') AS items
      FROM phones ORDER BY created`).all();
  }

  remove(id: string) {
    return this.db.query('DELETE FROM phones WHERE id = ?').run(id).changes > 0;
  }
}

/** The items of a phone's request, or null when it is not what the phone sends. At most 500 a request. */
export function items(body: unknown): PhoneItem[] | null {
  const list = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(list) || list.length > 500) return null;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const out: PhoneItem[] = [];
  for (const x of list as Record<string, unknown>[]) {
    const id = str(x?.id, 200);
    const text = str(x?.text, 20_000);
    if (!id || text === undefined || (x.kind !== 'sms' && x.kind !== 'notification') || typeof x.ts !== 'number' || !Number.isFinite(x.ts)) return null;
    out.push({
      id, kind: x.kind, ts: x.ts, text,
      address: str(x.address, 100), name: str(x.name, 100), out: x.out === true, app: str(x.app, 200), appName: str(x.appName, 100), title: str(x.title, 200),
    });
  }
  return out;
}

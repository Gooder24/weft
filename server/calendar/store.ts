// Where the calendar lives: one row in Postgres. Without a URL it is the database "weft" over the local socket as
// the user running it (peer login, no password; PGHOST moves the socket). A transaction-scoped advisory lock keeps
// one writer at a time, as the HTTP service and a merge from x270 may run together.
import { existsSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { dump, type Json, type Obj } from "./core.ts";

const LOCK = 7_301_202_611; // any fixed number; only this service takes it

export type Store = ReturnType<typeof openStore>;

export function openStore(url?: string) {
  const options = { max: 4, onnotice: () => {} };
  const sql = url ? postgres(url, options) : postgres({ ...options, host: process.env.PGHOST ?? "/run/postgresql", database: "weft" });

  const read = async (tx: postgres.Sql | postgres.TransactionSql): Promise<Obj | null> => {
    // `json` keeps the text as written, so key order survives; parsed here rather than by the driver.
    const rows = await tx<{ doc: string }[]>`select doc::text as doc from calendar_master where id`;
    return rows.length ? (JSON.parse(rows[0]!.doc) as Obj) : null;
  };

  // Sent as text and cast, so the driver does not encode it as a JSON string a second time.
  const write = async (tx: postgres.TransactionSql, doc: Json) => {
    await tx`insert into calendar_master (id, doc) values (true, ${dump(doc)}::text::json)
             on conflict (id) do update set doc = excluded.doc, updated_at = now()`;
  };

  return {
    /** The table, and once, the calendars.json the Python service kept (the file stays as it was). */
    async setup(legacyFile?: string) {
      await sql`create table if not exists calendar_master (
        id boolean primary key default true check (id),
        doc json not null,
        updated_at timestamptz not null default now())`;
      if (!legacyFile || !existsSync(legacyFile)) return;
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(${LOCK})`;
        if ((await read(tx)) === null) await write(tx, JSON.parse(readFileSync(legacyFile, "utf8")) as Json);
      });
    },
    read: () => read(sql),
    /** Reads the master under the lock; `change` returns the new doc to save, or undefined to leave it. */
    async update<T>(change: (doc: Obj | null) => { save?: Json; result: T }): Promise<T> {
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(${LOCK})`;
        const { save, result } = change(await read(tx));
        if (save !== undefined) await write(tx, save);
        return result;
      }) as Promise<T>;
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

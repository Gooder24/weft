// node --test with a throwaway Postgres 17 of its own (embedded-postgres: real server binaries, run as the current
// user in a temporary directory), so the Postgres tests need neither Docker nor an installed server. CI runs this.
// usage: node with-db.ts [arguments for node --test]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const port = await new Promise<number>((ok, fail) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address() as { port: number };
    s.close(() => ok(port));
  }).on("error", fail);
});
const dir = mkdtempSync(join(tmpdir(), "weft-calendar-pg-"));
const pg = new EmbeddedPostgres({ databaseDir: join(dir, "data"), port, user: "postgres", password: "test", persistent: false, onLog: () => {} });
let code = 1;
try {
  await pg.initialise();
  await pg.start();
  const child = spawn(process.execPath, ["--test", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, TEST_DATABASE_URL: `postgres://postgres:test@127.0.0.1:${port}/postgres` },
  });
  code = await new Promise<number>((ok) => child.on("exit", (c) => ok(c ?? 1)));
} finally {
  await pg.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);

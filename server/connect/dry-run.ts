// bun dry-run.ts [archive.db] [days]: what the connectors would post from the archive's recent mail, written
// nowhere. Shows each chat with its lines, and the subjects that fell to a connector's catch-all chat.
import { Database } from 'bun:sqlite';
import { CONNECTORS } from './connectors/index.ts';
import { flatten } from './mail.ts';

const archive = new Database(process.argv[2] ?? `${process.env.HOME}/matrix-spike/archive/archive.db`, { readonly: true, strict: true });
const days = Number(process.argv[3] ?? 30);
const rows = archive.query<{ id: string; ts: number; sender: string; body: string }, [number]>(`SELECT m.id, m.ts, m.sender, m.body
  FROM messages m JOIN chats c ON c.id = m.chat WHERE c.network IN ('gmail', 'outlook') AND m.me = 0 AND m.ts > ? ORDER BY m.ts`).all(Date.now() - days * 86_400_000);
for (const c of CONNECTORS) {
  const rules = c.mail;
  if (!rules) continue; // the phone's connectors have no mail rules
  const chats = new Map<string, string[]>();
  for (const row of rows) {
    if (!rules.from(row.sender)) continue;
    for (const item of rules.parse({ id: row.id, from: row.sender, ts: row.ts, ...flatten(row.body) })) {
      const key = `${item.title}`;
      chats.set(key, [...(chats.get(key) ?? []), `${new Date(row.ts).toISOString().slice(5, 16)} ${item.from ?? c.name}: ${item.text}`]);
    }
  }
  console.log(`\n== ${c.name}: ${[...chats.values()].flat().length} items in ${chats.size} chats`);
  for (const [title, lines] of chats) console.log(`  # ${title}\n${lines.map((l) => `    ${l}`).join('\n')}`);
}

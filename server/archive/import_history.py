#!/usr/bin/env python3
"""Import collect_history.py's private source archive, retaining source IDs and raw data.

No network requests. Run --dry-run first; every actual import backs up the live SQLite database.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time

import archive
import discord_weft


def ids(network, account, chat, remote_id):
    digest = lambda parts: hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()
    return "history:" + network + ":" + digest([account, chat]), "history:" + network + ":" + digest([account, chat, remote_id])


def learn_room(c, chat, room, network, channel):
    """A chat still on its own archive view (never linked, joined elsewhere or unlinked) takes the live room the
    collector learned, with the old chats joined to it, as link_chat takes them. In Discord only when every one of
    them is that very channel's (discord_weft.link_allowed's rule); otherwise it waits for Weft's guarded link."""
    if not c.execute("SELECT 1 FROM chats AS c WHERE id = ? AND c.room = 'archive:' || c.id AND id NOT IN (SELECT chat FROM unlinked)",
                     (chat,)).fetchone(): return
    along = [x for x, in c.execute("SELECT id FROM chats WHERE room = ? AND id != ?", ("archive:" + chat, chat))]
    if network == "discord" and any(discord_weft.channel_of_chat(c, x) != channel for x in along): return
    c.execute("UPDATE chats SET room = ? WHERE id = ? OR room = ?", (room, chat, "archive:" + chat))


def import_history(source, target, dry_run=False):
    source = Path(source).resolve()
    target = Path(target).resolve()
    if source == target: raise ValueError("Source and target must differ")
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as src:
        src.row_factory = sqlite3.Row
        # Take one consistent read snapshot even while the collector is committing new pages.
        src.execute("BEGIN")
        counts = {n: {"messages": count, "chats": chats} for n, count, chats in src.execute(
            "SELECT network,count(*),count(DISTINCT account||':'||chat) FROM items GROUP BY network")}
        # Validate every row before making a backup or mutating the destination.
        for row in src.execute("SELECT * FROM items"):
            if row["network"] not in ("discord", "whatsapp", "edupage"): raise ValueError("Unknown network")
            if not row["chat"] or not row["id"] or not isinstance(row["ts"], int): raise ValueError("Invalid identity/timestamp")
            json.loads(row["raw"])
            native = json.loads(row["native"])
            if not isinstance(native, list) or any(not isinstance(i, str) or not i.startswith("$") for i in native): raise ValueError("Invalid native mapping")
        if dry_run: return {"dry_run": True, "source": counts}
        backup = None
        if target.exists():
            backup = target.with_name(target.name + f".bak-{time.time_ns()}-history")
            with closing(sqlite3.connect(target.as_uri() + "?mode=ro", uri=True)) as old, closing(sqlite3.connect(backup)) as saved:
                old.backup(saved)
            os.chmod(backup, 0o600)
        previous = archive.DB
        archive.DB = str(target)
        try: c = archive.db()
        finally: archive.DB = previous
        with c:
            c.executescript("""
                CREATE TABLE IF NOT EXISTS history_data (
                    message TEXT PRIMARY KEY, network TEXT NOT NULL, account TEXT NOT NULL,
                    chat TEXT NOT NULL, remote_id TEXT NOT NULL, raw TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS history_native (
                    message TEXT NOT NULL, native_id TEXT NOT NULL, PRIMARY KEY(message,native_id));
                CREATE INDEX IF NOT EXISTS history_native_message ON history_native(message);
            """)
            added = 0
            # The collector keeps each channel's current room in `channels`; its items keep the room of their day.
            try: learned = {(n, a, ch): r for n, a, ch, r in src.execute("SELECT network,account,chat,room FROM channels") if r}
            except sqlite3.OperationalError: learned = {}
            learn = {}  # chat -> (live room, network, account, channel): taken after every message is in
            for row in src.execute("SELECT * FROM items ORDER BY network,account,chat,id"):
                chat, ident = ids(row["network"], row["account"], row["chat"], row["id"])
                # An unlinked conversation has its own read-only archive view, never a fake Matrix room.
                # The channel's newest room first: a portal made again replaces the one the old items name.
                room = learned.get((row["network"], row["account"], row["chat"])) or row["room"] or "archive:" + chat
                if row["network"] == "edupage": room = "archive:" + chat
                if not room.startswith("archive:"): learn[chat] = (room, row["network"], row["account"], row["chat"])
                # An existing chat keeps its room here (a link, a join, an unlink); a new one starts in the room known.
                c.execute("""INSERT INTO chats VALUES (?,?,?,?, 'history') ON CONFLICT(id)
                    DO UPDATE SET title=excluded.title""", (chat, row["network"], row["title"], room))
                added += c.execute("INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?)",
                    (ident, chat, row["ts"], row["sender"], row["me"], row["body"])).rowcount
                c.execute("INSERT INTO history_data VALUES (?,?,?,?,?,?) ON CONFLICT(message) DO UPDATE SET raw=excluded.raw",
                    (ident,row["network"],row["account"],row["chat"],row["id"],row["raw"]))
                for native in json.loads(row["native"]):
                    c.execute("INSERT OR IGNORE INTO history_native VALUES (?,?)", (ident,native))
            for chat, (room, network, account, channel) in learn.items():
                learn_room(c, chat, room, network, (account, channel))
        c.close()
        return {"source": counts, "added_messages": added, "backup": str(backup) if backup else None}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--db", type=Path, default=Path(archive.DB))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    print(json.dumps(import_history(args.source,args.db,args.dry_run),ensure_ascii=False,indent=2))

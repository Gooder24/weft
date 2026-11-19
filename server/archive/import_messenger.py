#!/usr/bin/env python3
"""Import Messenger's encrypted-chat messages.zip into Weft, without contacting Meta.

    python3 import_messenger.py ~/exports/messenger/messages.zip --dry-run
    python3 import_messenger.py ~/exports/messenger/messages.zip

Run beside archive.py on asus. The original ZIP is never changed. A SQLite backup precedes
each import; attachments are content-addressed, and repeated imports add no duplicate rows.
Unmatched conversations are kept for the local text/SQLite copy, without guessing a Matrix room.
"""
import argparse
import collections
from contextlib import closing
import hashlib
import json
import mimetypes
import os
from pathlib import Path, PurePosixPath
import sqlite3
import tempfile
import time
import uuid
import zipfile

import archive


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(packed(value).encode()).hexdigest()


def norm(value):
    return " ".join(value.casefold().split())


def media_name(uri):
    # Meta includes this literal marker when it could not place an attachment in the export.
    if uri == "Failed to download media":
        return None
    path = PurePosixPath(uri)
    if path.is_absolute() or ".." in path.parts or "\\" in uri or "\0" in uri:
        raise ValueError("Unsafe attachment path in export")
    name = str(path)
    if not name.startswith("media/") or len(path.parts) < 2:
        raise ValueError("Attachment must be inside the ZIP's media directory")
    return name


def read_threads(zips):
    threads = []
    for source in zips:
        with zipfile.ZipFile(source) as z:
            files = collections.Counter(str(PurePosixPath(i.filename)) for i in z.infolist())
            if any(n > 1 for n in files.values()):
                raise ValueError("Duplicate ZIP member names")
            for item in z.infolist():
                if item.is_dir() or len(PurePosixPath(item.filename).parts) != 1 or not item.filename.endswith(".json"):
                    continue
                with z.open(item) as f:
                    data = json.load(f)
                if not isinstance(data, dict) or not {"threadName", "participants", "messages"} <= data.keys():
                    raise ValueError(f"Not a Messenger secure-storage thread: {item.filename}")
                people, title, messages = data["participants"], data["threadName"], data["messages"]
                if not isinstance(title, str) or not isinstance(people, list) or not people or not all(isinstance(p, str) for p in people):
                    raise ValueError("Invalid conversation title or participants")
                if not isinstance(messages, list):
                    raise ValueError("Invalid messages list")
                for m in messages:
                    if not isinstance(m, dict) or not isinstance(m.get("senderName"), str) or type(m.get("timestamp")) is not int or m["timestamp"] < 0:
                        raise ValueError("Invalid message sender or millisecond timestamp")
                    if not isinstance(m.get("text", ""), str) or not isinstance(m.get("media", []), list):
                        raise ValueError("Invalid message text or media")
                    if type(m.get("isUnsent", False)) is not bool or not isinstance(m.get("reactions", []), list):
                        raise ValueError("Invalid removed-message flag or reactions")
                    for attachment in m.get("media", []):
                        if not isinstance(attachment, dict) or not isinstance(attachment.get("uri"), str):
                            raise ValueError("Invalid attachment URI")
                        media_name(attachment["uri"])
                threads.append({"zip": str(source), "member": item.filename, "data": data,
                                "identity": digest([title, sorted(people)])})
    if not threads:
        raise ValueError("No Messenger secure-storage JSON conversations found")
    return threads


def portals(path):
    if not path or not Path(path).is_file():
        return []
    with closing(sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)) as c:
        rooms = {}
        for room, name, ts in c.execute("""SELECT p.mxid, p.name, m.timestamp FROM portal p
                LEFT JOIN message m ON m.room_id=p.id AND m.room_receiver=p.receiver
                WHERE p.mxid IS NOT NULL"""):
            entry = rooms.setdefault(room, {"room": room, "name": norm(name or ""), "times": set()})
            if ts is not None:
                # bridgev2 stores nanoseconds; older bridge databases may store milliseconds.
                entry["times"].add(ts // 1_000_000 if ts > 10**17 else ts)
    return list(rooms.values())


def choose_room(thread, rooms, owner, name_counts):
    data = thread["data"]
    names = {norm(data["threadName"])}
    if len(data["participants"]) == 2:
        names.update(norm(p) for p in data["participants"] if p != owner)
    named = [r for r in rooms if r["name"] and r["name"] in names]
    times = {m["timestamp"] for m in data["messages"]}
    ranked = sorted(((len(r["times"] & times), r) for r in rooms), key=lambda x: x[0], reverse=True)
    if ranked:
        best, room = ranked[0]
        runner = ranked[1][0] if len(ranked) > 1 else 0
        if best >= 3 and best >= 2 * runner:
            return room["room"], "timestamps"
        if best and runner == 0 and len(named) == 1 and room == named[0] and name_counts[room["name"]] == 1:
            return room["room"], "name-and-timestamp"
    # Some older Messenger portals only retained whole seconds. Require several distinct
    # shared seconds, a clear winner, and a matching participant/title before using that precision.
    seconds = {ts // 1000 for ts in times}
    rounded = sorted(((len({ts // 1000 for ts in r["times"]} & seconds), r) for r in rooms),
                     key=lambda x: x[0], reverse=True)
    if rounded:
        best, room = rounded[0]
        runner = rounded[1][0] if len(rounded) > 1 else 0
        if best >= 3 and best >= 2 * runner and room in named:
            return room["room"], "rounded-timestamps"
    if len(named) == 1 and name_counts[named[0]["name"]] == 1:
        return named[0]["room"], "unique-name"
    return None, "unmatched"


def message_key(message):
    # Reactions can change between exports, but that does not create another message.
    return digest({k: v for k, v in message.items() if k != "reactions"})


def assign_chats(threads, database):
    """Persist chat IDs; titles, membership and a minimum hash are not immutable identifiers.

    The export omits native thread IDs. Reuse a saved chat by overlapping messages (or a unique
    native room); allocate one chat per thread per ZIP, even for indistinguishable conversations.
    Unknown disjoint conversations stay separate instead of being merged solely by a display name.
    """
    stored = {}
    database = Path(database).resolve()
    if database.exists():
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as c:
            if c.execute("SELECT 1 FROM sqlite_master WHERE name='messenger_export_threads'").fetchone():
                for chat, identity, people, room in c.execute("""SELECT t.chat,t.identity,t.participants,c.room
                        FROM messenger_export_threads t JOIN chats c ON c.id=t.chat"""):
                    stored[chat] = {"identity": identity, "people": set(json.loads(people)), "room": room, "keys": set()}
                for chat, raw in c.execute("""SELECT m.chat,d.data FROM messenger_message_data d
                        JOIN messages m ON m.id=d.message JOIN messenger_export_threads t ON t.chat=m.chat"""):
                    stored[chat]["keys"].add(message_key(json.loads(raw)))
    batches = collections.defaultdict(list)
    for t in threads:
        t["keys"] = {message_key(m) for m in t["data"]["messages"]}
        batches[t["zip"]].append(t)
    for batch in batches.values():
        used = set()
        room_counts = collections.Counter(t["room"] for t in batch if t["room"])
        identity_counts = collections.Counter(t["identity"] for t in batch)
        # Resolve the strongest evidence first, before a new same-name thread can take its place.
        batch.sort(key=lambda t: (-max((len(t["keys"] & s["keys"]) for s in stored.values()), default=0),
                                  -len(t["keys"]), t["member"]))
        for t in batch:
            people = set(t["data"]["participants"])
            candidates = {chat: s for chat, s in stored.items() if chat not in used and
                          not (t["room"] and s["room"] and t["room"] != s["room"])}
            ranked = sorted(((len(t["keys"] & s["keys"]), chat) for chat, s in candidates.items()), reverse=True)
            chat = None
            if ranked and ranked[0][0]:
                best, winner = ranked[0]
                runner = ranked[1][0] if len(ranked) > 1 else 0
                s = candidates[winner]
                corroborated = s["identity"] == t["identity"] or s["people"] == people or best >= 2
                if corroborated and best > runner and best >= 2 * runner:
                    chat = winner
                elif runner == best:
                    # Symmetric identical threads cannot be told apart, but must retain their count.
                    common = candidates[winner]["keys"]
                    identical = [key for score, key in ranked if score == best and
                                 candidates[key]["identity"] == t["identity"] and
                                 candidates[key]["keys"] == common and common <= t["keys"]]
                    if len(identical) == sum(score == best for score, _ in ranked):
                        chat = min(identical)
            if chat is None and t["room"] and room_counts[t["room"]] == 1:
                native = [key for key, s in candidates.items() if s["room"] == t["room"]]
                if len(native) == 1:
                    chat = native[0]
            if chat is None:
                empty = [key for key, s in candidates.items() if s["identity"] == t["identity"] and
                         (not s["keys"] or not t["keys"])]
                if len(empty) == 1 and identity_counts[t["identity"]] == 1:
                    chat = empty[0]
                elif empty and not t["keys"] and all(not candidates[key]["keys"] for key in empty):
                    chat = min(empty)
            if chat is None:
                chat = "messenger-export:" + uuid.uuid4().hex
                stored[chat] = {"keys": set(), "room": None}
            used.add(chat)
            stored[chat].update(identity=t["identity"], people=people, room=t["room"] or stored[chat]["room"])
            stored[chat]["keys"].update(t["keys"])
            t["chat"] = chat


def kind(uri):
    mime = mimetypes.guess_type(uri)[0] or "application/octet-stream"
    category = mime.split("/")[0]
    return category if category in ("image", "video", "audio") else "file", mime


def body(message):
    if message.get("isUnsent"):
        return "[Správa bola odstránená]"
    labels = {"image": "[Fotka]", "video": "[Video]", "audio": "[Zvuková správa]", "file": "[Súbor]"}
    parts = ["[Príloha v exporte chýba]" if media_name(m["uri"]) is None else labels[kind(m["uri"])[0]]
             for m in message.get("media", [])]
    if message.get("text"):
        parts.append(message["text"])
    return " ".join(parts) or "[Správa bez textu v exporte]"


def store_media(z, name, folder):
    """Never extract ZIP paths. Verify the ZIP CRC, then use a hash as the destination name."""
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(dir=folder, prefix=".import-", delete=False) as target:
            tmp = Path(target.name)
            h = hashlib.sha256()
            with z.open(name) as source:
                while chunk := source.read(1024 * 1024):
                    h.update(chunk)
                    target.write(chunk)
        ext = PurePosixPath(name).suffix.lower()
        if len(ext) > 10 or not ext.removeprefix(".").isalnum():
            ext = ""
        dest = folder / (h.hexdigest() + ext)
        if dest.exists():
            with dest.open("rb") as f:
                actual = hashlib.file_digest(f, "sha256").hexdigest()
            if actual != h.hexdigest():
                raise ValueError("Existing archived attachment failed its checksum")
        else:
            os.link(tmp, dest)
        return "messenger/" + dest.name, tmp.stat().st_size
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


def run(zips, database, media_root, bridge_db=None, owner=None, dry_run=False):
    threads = read_threads(zips)
    counts = collections.Counter(p for t in threads for p in set(t["data"]["participants"]))
    if owner is None:
        ranking = counts.most_common(2)
        if len(ranking) > 1 and ranking[0][1] == ranking[1][1]:
            raise ValueError("Owner is ambiguous; provide --owner with your name from the export")
        owner = ranking[0][0]
    if owner not in counts:
        raise ValueError("The supplied owner is not an export participant")
    rooms = portals(bridge_db)
    names = collections.Counter()
    for t in threads:
        d = t["data"]
        candidates = {norm(d["threadName"])}
        if len(d["participants"]) == 2:
            candidates.update(norm(p) for p in d["participants"] if p != owner)
        names.update(candidates)
    summary = collections.Counter(chats=len(threads), messages=sum(len(t["data"]["messages"]) for t in threads),
                                  empty_chats=sum(not t["data"]["messages"] for t in threads),
                                  added_messages=0, media_references=0, missing_media=0)
    known_media = {}
    match_methods = collections.Counter()
    for t in threads:
        t["room"], method = choose_room(t, rooms, owner, names)
        match_methods[method] += 1
        with zipfile.ZipFile(t["zip"]) as z:
            members = {str(PurePosixPath(n)): n for n in z.namelist()}
            for m in t["data"]["messages"]:
                for a in m.get("media", []):
                    summary["media_references"] += 1
                    name = media_name(a["uri"])
                    if name not in members:
                        summary["missing_media"] += 1
                    known_media[(t["zip"], name)] = members.get(name)
    summary["matched_chats"] = len(threads) - match_methods["unmatched"]
    summary["unmatched_chats"] = match_methods["unmatched"]
    summary["media_files"] = sum(member is not None for member in known_media.values())
    result = dict(summary) | {"match_methods": dict(match_methods), "dry_run": dry_run}
    # Validate every available referenced file before even a backup or media directory is created.
    # This also makes --dry-run detect a damaged download without publishing orphaned attachments.
    for source in zips:
        with zipfile.ZipFile(source) as z:
            for (which, name), member in known_media.items():
                if which == str(source) and member is not None:
                    with z.open(member) as f:
                        while f.read(1024 * 1024):
                            pass
    if dry_run:
        return result

    assign_chats(threads, database)
    database, media_root = Path(database).resolve(), Path(media_root).resolve()
    database.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Use SQLite's backup API: copying archive.db alone would omit live WAL transactions.
    if database.exists():
        backup = database.with_name(database.name + f".bak-{time.time_ns()}-messenger")
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as src, closing(sqlite3.connect(backup)) as dest:
            src.backup(dest)
        result["backup"] = str(backup)
    saved = {}
    media_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    for source in zips:
        with zipfile.ZipFile(source) as z:
            for (which, name), member in known_media.items():
                if which == str(source) and member is not None:
                    saved[(which, name)] = store_media(z, member, media_root / "messenger")
    archive.DB = str(database)
    c = archive.db()
    try:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS messenger_message_data (message TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS messenger_export_threads (chat TEXT PRIMARY KEY,
                identity TEXT NOT NULL, participants TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS message_media (message TEXT NOT NULL, position INTEGER NOT NULL,
                path TEXT, kind TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER,
                original_uri TEXT NOT NULL, PRIMARY KEY (message, position));
        """)
        with c:
            for t in threads:
                d, chat = t["data"], t["chat"]
                c.execute("""INSERT INTO chats VALUES (?, 'messenger', ?, ?, 'messenger-export')
                    ON CONFLICT(id) DO UPDATE SET title=excluded.title, room=COALESCE(excluded.room,chats.room)""",
                          (chat, d["threadName"], t["room"]))
                c.execute("""INSERT INTO messenger_export_threads VALUES (?,?,?) ON CONFLICT(chat)
                    DO UPDATE SET identity=excluded.identity, participants=excluded.participants""",
                          (chat, t["identity"], packed(sorted(d["participants"]))))
                occurrences = collections.Counter()
                for m in d["messages"]:
                    signature = message_key(m)
                    occurrences[signature] += 1
                    mid = f"{chat}:{signature}:{occurrences[signature]}"
                    cur = c.execute("INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?)",
                                    (mid, chat, m["timestamp"], m["senderName"], int(m["senderName"] == owner), body(m)))
                    result["added_messages"] += cur.rowcount
                    c.execute("INSERT INTO messenger_message_data VALUES (?,?) ON CONFLICT(message) DO UPDATE SET data=excluded.data",
                              (mid, packed(m)))
                    for position, a in enumerate(m.get("media", [])):
                        path, size = saved.get((t["zip"], media_name(a["uri"])), (None, None))
                        category, mime = kind(a["uri"])
                        c.execute("""INSERT INTO message_media (message, position, path, kind, mime, bytes, original_uri)
                            VALUES (?,?,?,?,?,?,?) ON CONFLICT(message,position) DO UPDATE SET path=excluded.path, bytes=excluded.bytes""",
                                  (mid, position, path, category, mime, size, a["uri"]))
        result["media_bytes"] = sum(size for path, size in saved.values())
        return result
    finally:
        c.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("zip", nargs="+", type=Path)
    parser.add_argument("--db", type=Path, default=Path(archive.DB))
    parser.add_argument("--media-dir", type=Path, default=Path(archive.HERE) / "media")
    parser.add_argument("--bridge-db", type=Path, default=Path(archive.SPIKE) / "messenger/bridge.db")
    parser.add_argument("--owner", help="Your exact participant name; inferred when unambiguous")
    parser.add_argument("--dry-run", action="store_true", help="Only validate/count; do not write anything")
    args = parser.parse_args()
    try:
        result = run(args.zip, args.db, args.media_dir, args.bridge_db, args.owner, args.dry_run)
    except (ValueError, KeyError, OSError, sqlite3.Error, zipfile.BadZipFile) as e:
        parser.exit(1, f"Messenger import failed: {e}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

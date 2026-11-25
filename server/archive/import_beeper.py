#!/usr/bin/env python3
"""Bring a Beeper Desktop user's chat history into Weft's archive, without contacting Beeper or any network.

    python3 import_beeper.py ~/imports/BeeperTexts --dry-run
    python3 import_beeper.py ~/imports/BeeperTexts --media

The source is a copy of Beeper Desktop's data folder (~/.config/BeeperTexts on Linux, %APPDATA%/BeeperTexts on
Windows, ~/Library/Application Support/BeeperTexts on macOS) taken while Beeper is closed; only its index.db and,
with --media, media/local.beeper.com/ are read. Nothing in the copy is changed.

A Beeper chat of a network Weft bridges lands in the live Weft room of the same chat: both use mautrix bridges, so
Beeper's m.bridge channel id and receiver are the bridge's portal key. A chat Weft has no room for joins the
archive chat that already holds its messages (an earlier export), else it gets its own read-only archive view,
which keeps networks Weft does not bridge (Telegram, Signal, SMS) readable. A message the same Weft chat already has
(within 3 s, same text) is never added twice. Each real import backs up archive.db first; a repeat adds nothing.
"""
import argparse
import collections
from contextlib import closing
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import time

import archive
import estimate

# Beeper's bridge protocol id -> Weft's network name and its bridge folder in ~/matrix-spike.
NETWORKS = {"facebookgo": ("messenger", "messenger"), "facebook": ("messenger", "messenger"),
            "instagramgo": ("instagram", "instagram"), "instagram": ("instagram", "instagram"),
            "whatsapp": ("whatsapp", "whatsapp"), "discordgo": ("discord", "discord"), "discord": ("discord", "discord")}
SKIP = {"REACTION", "MEMBERSHIP", "HIDDEN"}
SAFE_ID = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}")  # a cached file's name that is safe as a path
BATCH = 2000  # messages per write transaction: the archive service keeps writing in between
LABELS = {"IMAGE": "[Fotka]", "VIDEO": "[Video]", "VOICE": "[Zvuková správa]", "AUDIO": "[Zvuk]",
          "FILE": "[Súbor]", "STICKER": "[Nálepka]", "POLL": "[Anketa]"}


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(packed(value).encode()).hexdigest()


def norm(text):
    return " ".join((text or "").casefold().split())


def obj(d, key):
    """d[key] when it is a dict, else an empty one: Beeper's JSON is read without trusting its shape."""
    x = d.get(key)
    return x if isinstance(x, dict) else {}


def string(d, key):
    x = d.get(key)
    return x if isinstance(x, str) else ""


def network_of(bridge):
    proto = string(obj(bridge, "protocol"), "id")
    if proto in NETWORKS: return NETWORKS[proto][0], NETWORKS[proto][1]
    return (proto or "beeper"), None


def portals(spike):
    """(folder) -> {(channel id, receiver): room} from Weft's own bridges; a missing bridge has none."""
    out = {}
    for folder in {f for _, f in NETWORKS.values()}:
        path = (Path(spike) / folder / "bridge.db").resolve()
        if not path.exists(): continue
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as c:
            q = "SELECT dcid, receiver, mxid FROM portal" if folder == "discord" else "SELECT id, receiver, mxid FROM portal"
            out[folder] = {(i, r or ""): m for i, r, m in c.execute(q) if m}
    return out


def live_room(ports, folder, channel):
    """The Weft room of the same chat: the bridge's portal for this channel and this account, or the channel's
    portal shared by every account (a group, a Discord server channel)."""
    if not folder or folder not in ports or not channel.get("id"): return None
    known = ports[folder]
    cid, receiver = str(channel["id"]), str(channel.get("fi.mau.receiver") or "")
    return known.get((cid, receiver)) or known.get((cid, ""))


def body(row, message):
    text = string(message, "text")
    label = LABELS.get(row["type"])
    if row["type"] == "STICKER" or not label: return text or label or "[Správa]"
    return (label + " " + text).strip()


LABEL = re.compile(r"\[[^\]]{3,}\]")  # an attachment's label: "[Fotka]", "[Hlasová správa] …", not "[x] hotovo"
# A bridge's text for a file is its name: a known file type, not an address, a time or a dotted word.
FILE_NAME = re.compile(r"[^\s/:]+\.(jpe?g|png|gif|webp|heic|bmp|mp4|mov|webm|mkv|m4a|aac|ogg|oga|opus|mp3|wav|pdf"
                       r"|docx?|xlsx?|pptx?|odt|ods|zip|rar|7z|txt|csv|apk)")


def same_message(have_in_room, ts, text, media):
    """Whether the room already has this message. Bridges stamp the same message up to a few seconds apart, a reply
    or edit may carry extra text, and an attachment is a file name in one and a label in the other."""
    x = norm(text)
    for d in (0, -1, 1, -2, 2, -3, 3):
        for have in have_in_room.get(ts // 1000 + d, ()):
            if have == x: return True
            short = min(have, x, key=len)
            if len(short) >= 8 and (have in x or x in have): return True
            if media and (LABEL.match(have) or FILE_NAME.fullmatch(have)): return True
    return False


def cut_key(x):
    """A string without the key of an encrypted file it carries: cut where its query or the key's name begins."""
    low = x.lower()
    at = low.find("encryptedfileinfo")
    if at < 0: return x
    return x[:min([i for i in (low.find(c) for c in ("?", "#", "&", ";", "%3f")) if 0 <= i < at] + [at])]


def scrub(raw):
    """Beeper's message JSON without the keys of encrypted files: every string that carries one loses it (a media
    address keeps the part before "?"), and so does every object that is one (Matrix's EncryptedFile: a JSON web
    key "k", "iv", "hashes"); a message that is no JSON is not kept at all."""
    def secret(k, v):
        return "encryptedfileinfo" in k.lower() or isinstance(v, dict) and ("k" in v or "iv" in v or "kty" in v)
    def clean(x):
        if isinstance(x, dict): return {k: clean(v) for k, v in x.items() if not secret(k, v) and k not in ("iv", "hashes")}
        if isinstance(x, list): return [clean(v) for v in x if not secret("", v)]
        if isinstance(x, str): return cut_key(x)
        return x
    try: return json.dumps(clean(json.loads(raw)), ensure_ascii=False)
    except (TypeError, ValueError): return "{}"


def file_id(attachment):
    """The bare id of a Beeper media address: the cache keeps the decrypted file under it."""
    return re.split(r"[?#&;]", cut_key(attachment["srcURL"]), maxsplit=1)[0].rsplit("/", 1)[-1]


def as_object(raw):
    """A JSON column of Beeper's as a dict; anything else (NULL, broken, a list) as an empty one."""
    try: x = json.loads(raw)
    except (TypeError, ValueError): return {}
    return x if isinstance(x, dict) else {}


def read_beeper(folder):
    index = Path(folder) / "index.db"
    if not index.exists(): raise FileNotFoundError(f"{index} is missing: copy Beeper's whole data folder")
    c = sqlite3.connect(index.resolve().as_uri() + "?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


def read_archive(database):
    """What the archive holds: each chat's room, each room's messages by second, live rooms' floors, exports'
    exact texts by network and second (to find which export a Beeper chat continues), and unlinked chats."""
    out = {"chat_room": {}, "by_room": collections.defaultdict(dict), "exact": {}, "floor": {}, "unlinked": set(),
           "native": set(), "no_file": set(), "joined": {}, "imported": set()}
    path = Path(database).resolve()
    if not path.exists(): return out
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as a:
        if not a.execute("SELECT 1 FROM sqlite_master WHERE name = 'chats'").fetchone(): return out
        for cid, room, source in a.execute("SELECT id, COALESCE(room, 'archive:' || id), source FROM chats"):
            out["chat_room"][cid] = room
            if source in ("matrix", "bridge"): out["native"].add(cid)
        # Beeper's own rows are matched by id (imported): compared by text and time, an import stopped after some batches
        # would take the rest of a burst (photos a second apart, the same short text twice) for duplicates.
        for net, chat, ts, text in a.execute("""SELECT c.network, m.chat, m.ts, m.body FROM messages m JOIN chats c ON c.id = m.chat
                                                WHERE m.id NOT LIKE 'beeper:%'"""):
            t = norm(text)
            out["by_room"][out["chat_room"][chat]].setdefault(ts // 1000, []).append(t)
            if chat not in out["native"]: out["exact"].setdefault((net, ts // 1000, t), chat)
        # A live room's first message on the homeserver or among its bridge's pages: the archive shows an import in a
        # live room only below it (archive.room_stats, export_caps).
        out["floor"] = dict(a.execute("""SELECT c.room, min(m.ts) FROM messages m JOIN chats c ON c.id = m.chat
                                         WHERE c.source IN ('matrix', 'bridge') AND c.room IS NOT NULL GROUP BY c.room"""))
        if a.execute("SELECT 1 FROM sqlite_master WHERE name = 'unlinked'").fetchone():
            out["unlinked"] = {x for x, in a.execute("SELECT chat FROM unlinked")}
        out["imported"] = {x for x, in a.execute("SELECT id FROM messages WHERE id LIKE 'beeper:%'")}
        # Beeper messages imported earlier whose file was not copied (no --media then, or not in the cache yet).
        if a.execute("SELECT 1 FROM sqlite_master WHERE name = 'message_media'").fetchone():
            out["no_file"] = set(a.execute(
                "SELECT message, position FROM message_media WHERE message LIKE 'beeper:%' AND path IS NULL"))
        if a.execute("SELECT 1 FROM sqlite_master WHERE name = 'joined'").fetchone():
            out["joined"] = dict(a.execute("SELECT chat, target FROM joined"))
    return out


def continues(arch, net, msgs):
    """The export chat that already holds most of these messages (same network, text and second, within 3 s), or None."""
    votes = collections.Counter()
    for ts, text in msgs:
        for d in (0, -1, 1, -2, 2, -3, 3):
            hit = arch["exact"].get((net, ts // 1000 + d, text))
            if hit: votes[hit] += 1; break
    best = votes.most_common(1)
    return best[0][0] if best and best[0][1] >= 3 and best[0][1] * 2 >= len(msgs) else None


def plan(source, database, spike):
    """Everything an import would do, as rows to write and counts to show, without writing."""
    ports = portals(spike)
    arch = read_archive(database)
    stats = collections.defaultdict(collections.Counter)
    chats, messages, fill, state = [], [], [], collections.Counter()
    cache = Path(source) / "media" / "local.beeper.com"
    planned, oldest, wanted = set(), {}, {}

    def want(row, positions=None):
        for i, a in enumerate(row["media"]):
            if a and (positions is None or i in positions) and SAFE_ID.fullmatch(fid := file_id(a)):
                stated = a.get("fileSize")
                wanted[fid] = stated if isinstance(stated, int) and 0 <= stated < 1 << 62 else None
    with closing(read_beeper(source)) as b:
        account_of = {r["threadID"]: r["accountID"] for r in b.execute("SELECT threadID, accountID FROM threads")}
        names = {(r["room_id"], r["id"]): r["full_name"] or r["nickname"] for r in b.execute(
            "SELECT room_id, id, full_name, nickname FROM participants")}
        for t in b.execute("SELECT threadID, accountID, thread FROM threads WHERE COALESCE(room_type,'') NOT IN "
                           "('m.space','com.beeper.reminders','com.beeper.removed_messages','com.beeper.transcriptions')"):
            thread = as_object(t["thread"])
            extra = obj(thread, "extra")
            bridge = obj(extra, "bridge")
            net, folder = network_of(bridge)
            channel = obj(bridge, "channel")
            s = stats[net]
            s["chats"] += 1
            if obj(extra, "tags").get("m.lowpriority") is not None: state["low_priority"] += 1
            if thread.get("reminder"): state["reminders"] += 1
            if extra.get("isArchivedUpto"): state["archived"] += 1
            if thread.get("isPinned"): state["pinned"] += 1
            chat = "beeper:" + net + ":" + digest([t["accountID"], channel.get("id") or t["threadID"]])
            rows = [(m, as_object(m["message"])) for m in b.execute(
                "SELECT * FROM mx_room_messages WHERE roomID = ? AND isDeleted = 0 ORDER BY timestamp, id", (t["threadID"],))
                    if m["type"] not in SKIP and isinstance(m["timestamp"], int) and m["timestamp"] > 0]
            rows = [(m, msg, body(m, msg)) for m, msg in rows]
            s["messages"] += len(rows)
            # Where the chat goes, decided before any message is compared: duplicates are looked for only there.
            joins = None
            if chat in arch["chat_room"]: room = arch["chat_room"][chat]  # an earlier import placed it: keep that
            elif chat not in arch["unlinked"] and (room := live_room(ports, folder, channel)): s["linked_to_live_room"] += 1
            elif joins := continues(arch, net, [(m["timestamp"], norm(text)) for m, _, text in rows]):
                room = arch["chat_room"][joins]; s["beside_earlier_export"] += 1
                # An export joined into another one: the Beeper chat joins where that one did (join_chat's root), so
                # it follows that one's link and unlink too.
                seen = {joins}
                while arch["joined"].get(joins) not in (None, *seen): joins = arch["joined"][joins]; seen.add(joins)
                if joins not in arch["joined"] and room.startswith("archive:"): joins = room.removeprefix("archive:")
            else: room = "archive:" + chat; s["own_view"] += 1
            have = arch["by_room"].get(room, {})
            new = []
            for m, msg, text in rows:
                me = int(bool(m["isSentByMe"]))
                sender = "Ja" if me else (names.get((t["threadID"], m["senderContactID"])) or m["senderContactID"] or "?")
                row = {"id": "beeper:" + digest([t["accountID"], t["threadID"], m["eventID"] or f"row {m['id']}"]), "chat": chat,
                       "ts": m["timestamp"], "sender": sender, "me": me, "body": text, "raw": scrub(m["message"]),
                       "media": [a if isinstance(a, dict) and isinstance(a.get("srcURL"), str) else {}
                                 for a in (msg.get("attachments") if isinstance(msg.get("attachments"), list) else [])]}
                # Imported before (also if Beeper's copy was edited since), or the same event twice in Beeper's.
                if row["id"] in arch["imported"] or row["id"] in planned or same_message(have, m["timestamp"], text, m["type"] in LABELS):
                    s["already_in_weft"] += 1
                    # Imported before without its file, and Beeper's cache has it now: --media fills it in.
                    missing = {i for i, a in enumerate(row["media"]) if (row["id"], i) in arch["no_file"] and a}
                    want(row, missing)
                    need = {i for i in missing if (cache / file_id(row["media"][i])).is_file()}
                    if need: fill.append({**row, "need": need}); s["files_to_fill"] += len(need)
                    continue
                new.append(row); planned.add(row["id"])
            if room in arch["floor"]:
                # Weft's own history of the room covers this time: an import there would never show. A few seconds
                # of margin: Beeper may keep the room's first message rounded to the second.
                inside = [r for r in new if r["ts"] >= arch["floor"][room] - 3000]
                s["inside_weft_history"] += len(inside)
                new = [r for r in new if r["ts"] < arch["floor"][room] - 3000]
                s["older_than_weft"] += len(new)
            s["new"] += len(new)
            for r in new: want(r)
            s["media"] += sum(1 for r in new for a in r["media"] if a)
            # What the new rows take in archive.db, counted as estimate.py does (its OVERHEAD is indexes and search).
            s["archive_bytes"] += sum(estimate.OVERHEAD + len(r["body"].encode()) + len(r["raw"].encode()) for r in new)
            if new: oldest[net] = min(oldest.get(net, new[0]["ts"]), new[0]["ts"])
            if new: chats.append((chat, net, string(thread, "title"), room, t["accountID"], packed(channel), joins))
            messages.extend(new)
    return {"chats": chats, "messages": messages, "fill": fill,
            "report": {"networks": {k: dict(v) | ({"oldest": oldest[k]} if k in oldest else {}) for k, v in sorted(stats.items())},
                       "inbox_state": dict(state),
                       # Beeper's cached files these messages show, by id with the size Beeper states (or null): Weft
                       # sends only these from the data folder's media/local.beeper.com/.
                       "media_wanted": sorted(wanted.items()),
                       "account_count": len(set(account_of.values()))}}


def store_media(src, folder, ext=""):
    """Copy one Beeper media file content-addressed into the archive's media folder; never move the source."""
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    h = hashlib.sha256()
    with tempfile.NamedTemporaryFile(dir=folder, prefix=".import-", delete=False) as target:
        tmp = Path(target.name)
        with src.open("rb") as f:
            while chunk := f.read(1 << 20): h.update(chunk); target.write(chunk)
    try:
        dest = folder / (h.hexdigest() + ext)  # the type's extension, for the archive's media folders
        if not dest.exists(): os.link(tmp, dest)
        return "beeper/" + dest.name, tmp.stat().st_size
    finally:
        tmp.unlink(missing_ok=True)


def run(source, database, spike, media_root=None, dry_run=False):
    p = plan(source, database, spike)
    report = p["report"]
    if dry_run or not (p["messages"] or media_root and p["fill"]):
        report["dry_run" if dry_run else "added_messages"] = True if dry_run else 0
        return report  # nothing to write: no backup either
    database = Path(database).resolve()
    backup = None
    if database.exists():
        backup = database.with_name(database.name + f".bak-{time.time_ns()}-beeper")
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as old, closing(sqlite3.connect(backup)) as saved:
            old.backup(saved)
        os.chmod(backup, 0o600)
    previous = archive.DB
    archive.DB = str(database)
    try: c = archive.db()
    finally: archive.DB = previous
    files = Path(source) / "media" / "local.beeper.com"
    added = copied = copied_bytes = 0
    with c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS beeper_chats (chat TEXT PRIMARY KEY, account TEXT NOT NULL, channel TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS beeper_data (message TEXT PRIMARY KEY, raw TEXT NOT NULL);""")
        for chat, net, title, room, account, channel, joins in p["chats"]:
            # An existing chat keeps its room (a link, a join or an unlink Karchi made since).
            fresh = c.execute("""INSERT INTO chats VALUES (?,?,?,?, 'beeper') ON CONFLICT(id) DO UPDATE SET title=excluded.title""",
                              (chat, net, title, room)).rowcount and not c.execute(
                                  "SELECT 1 FROM joined WHERE chat = ?", (chat,)).fetchone()
            # Beside an export it is joined to it, as join_chat does: it follows the export's link and unlink.
            if joins and fresh:
                c.execute("INSERT OR IGNORE INTO joined (chat, target) VALUES (?, ?)", (chat, joins))
                # An export that never had a room gets its own, as join_chat gives it: one conversation, not two.
                c.execute("UPDATE chats SET room = ? WHERE id = ? AND room IS NULL", ("archive:" + joins, joins))
            c.execute("INSERT OR IGNORE INTO beeper_chats VALUES (?,?,?)", (chat, account, channel))
    rows = p["messages"] + (p["fill"] if media_root else [])
    # Batches, each its own transaction, so the archive service's writes never wait for the whole import; an import
    # that stops midway is finished by the next one (ids are kept, files without a copy are filled in).
    for start in range(0, len(rows), BATCH):
        batch, media = rows[start:start + BATCH], []
        for m in batch:
            for position, a in enumerate(m["media"]):
                if not a or ("need" in m and position not in m["need"]): continue  # no file, or one copied already
                path = size = None
                name = cut_key(string(a, "fileName"))
                # Beeper Cloud media carry their key after "?": the cache keeps the decrypted file under the bare id.
                local = files / file_id(a)
                mime = a.get("mimeType") if isinstance(a.get("mimeType"), str) else None
                mime = mime or mimetypes.guess_type(name)[0] or "application/octet-stream"
                if media_root and local.is_file():  # copied before the transaction: it holds no lock meanwhile
                    ext = os.path.splitext(name)[1].lower() or mimetypes.guess_extension(mime) or ""
                    path, size = store_media(local, Path(media_root) / "beeper", ext if re.fullmatch(r"\.[a-z0-9]{1,5}", ext) else "")
                    copied += 1; copied_bytes += size
                kind = mime.split("/")[0] if mime.split("/")[0] in ("image", "video", "audio") else "file"
                box = {k: v for k, v in obj(a, "size").items() if isinstance(v, int) and 0 < v < 1 << 31}  # the picture's
                stated = a.get("fileSize") if isinstance(a.get("fileSize"), int) and 0 <= a["fileSize"] < 1 << 62 else None
                # "beeper:<id>", not the mxc: Beeper's media server is not Weft's homeserver, so the archive must not
                # try to fetch it there; without a copied file the label stays. Ending in Beeper's file name, the
                # archive's download keeps that name.
                media.append((m["id"], position, path, kind, mime, size or stated,
                              "beeper:" + file_id(a) + "/" + name.replace("/", "_").replace("?", "_"),
                              box.get("width"), box.get("height")))
        with c:
            for m in batch:
                added += c.execute("INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?)",
                                   (m["id"], m["chat"], m["ts"], m["sender"], m["me"], m["body"])).rowcount
                c.execute("INSERT OR IGNORE INTO beeper_data VALUES (?,?)", (m["id"], m["raw"]))
            c.executemany("""INSERT INTO message_media (message, position, path, kind, mime, bytes, original_uri, w, h)
                VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(message, position) DO UPDATE SET
                path=COALESCE(excluded.path, message_media.path), bytes=COALESCE(excluded.bytes, message_media.bytes)""", media)
    c.close()
    report.update({"added_messages": added, "media_copied": copied, "media_bytes": copied_bytes,
                   "backup": str(backup) if backup else None})
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="copy of Beeper Desktop's data folder (holds index.db)")
    parser.add_argument("--db", type=Path, default=Path(archive.DB))
    parser.add_argument("--spike", type=Path, default=Path(archive.SPIKE), help="folder with Weft's bridges")
    parser.add_argument("--media", action="store_true", help="also copy the photos and files Beeper kept")
    parser.add_argument("--media-dir", type=Path, default=Path(archive.MEDIA))
    parser.add_argument("--dry-run", action="store_true", help="only count; write nothing")
    args = parser.parse_args()
    os.umask(0o077)
    print(json.dumps(run(args.source, args.db, args.spike, args.media_dir if args.media else None, args.dry_run),
                     ensure_ascii=False, indent=2))

#!/usr/bin/env python3
"""How much room a history import would take, told before anything is imported or downloaded.

    estimate.py archive                  what Weft keeps now, and this archive's own sizes per message
    estimate.py gmail ADDRESS            a connected Gmail account: every mail's date and exact size (IMAP
                                         metadata only: no bodies, no flags, read-only mailbox)
    estimate.py messenger ZIP...         a Messenger end-to-end export (messages.zip)
    estimate.py instagram ZIP...         Instagram "Download your information" exports
    estimate.py beeper DIR               a copy of Beeper Desktop's data folder (index.db, media/)
    estimate.py whatsapp                 the history the phone sent at pairing, still in the bridge's database

Each answers for the last 30, 90 and 365 days and for everything: messages, the archive database, photos and
files, thumbnails and the total. Sizes a source states (export files, Gmail's message sizes, Beeper's cached
files) are counted as they are ("exact"); the rest comes from per-message sizes measured in a real archive
(PROFILES), recomputed from the local archive with --calibrate. --text prints Slovak lines instead of JSON.

Nothing here writes, sends or marks anything. Import code can call summarize(items) on what it is about to add.
"""
import argparse
import collections
from contextlib import closing
import dataclasses
import imaplib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import sys
import time
import zipfile

HERE = Path(__file__).resolve().parent
SPIKE = Path(os.environ.get("WEFT_SPIKE", Path.home() / "matrix-spike"))
PERIODS = (("30", 30), ("90", 90), ("365", 365), ("all", None))
DAY_MS = 86_400_000
THUMB = 7_500  # one stored thumbnail (archive.py thumbs), measured: 110 MB for about 14 600 photos and videos


@dataclasses.dataclass
class Profile:
    """Sizes of one network's messages in archive.db and its media folder."""
    body: float          # text bytes per message
    raw: float           # bytes of the source's original data kept beside it (history_data, export data)
    media_share: float   # messages with at least one file
    files: float         # files per such message
    file_bytes: float    # bytes per file


# Measured on 2026-11-24 in one archive of about 260 000 messages (aggregates only). OVERHEAD is every byte of
# archive.db that is neither text nor raw data (indexes, full-text search, rows), divided by the messages.
OVERHEAD = 790
PROFILES = {
    "messenger": Profile(40, 135, 0.050, 1.04, 1_026_000),
    "instagram": Profile(35, 0, 0.044, 1.16, 371_000),
    "whatsapp": Profile(51, 2_100, 0.156, 1.0, 1_825_000),
    "discord": Profile(35, 1_250, 0.053, 1.1, 586_000),
    "gmail": Profile(6_900, 0, 0.056, 2.3, 677_000),
    "outlook": Profile(6_900, 0, 0.056, 2.3, 677_000),
    "teams": Profile(60, 0, 0.03, 1.0, 500_000),
    "edupage": Profile(490, 1_200, 0.02, 1.0, 300_000),
}
FALLBACK = Profile(60, 0, 0.05, 1.0, 600_000)


@dataclasses.dataclass
class Item:
    """One message a source would bring. media: the sizes of its files (None for a file of unknown size);
    None instead of a list when the source cannot tell whether the message has files at all."""
    network: str
    ts: int
    body: int = None
    raw: int = None
    media: list = None


def profile(network, profiles):
    return profiles.get(network) or FALLBACK


def summarize(items, now_ms=None, profiles=None, overhead=OVERHEAD):
    """Per period and network: messages, archive bytes, media files and bytes (exact or estimated), thumbnails."""
    profiles = profiles or PROFILES
    now_ms = now_ms or int(time.time() * 1000)
    out = {name: collections.defaultdict(collections.Counter) for name, _ in PERIODS}
    oldest = {}
    for it in items:
        p = profile(it.network, profiles)
        body = p.body if it.body is None else it.body
        raw = p.raw if it.raw is None else it.raw
        row = collections.Counter(messages=1, archive_bytes=overhead + body + raw)
        if it.media is None:
            files = p.media_share * p.files
            row.update(media_files=files, media_bytes=files * p.file_bytes, thumb_bytes=files * THUMB, guessed_media_bytes=files * p.file_bytes)
        else:
            known = [b for b in it.media if b is not None]
            unknown = len(it.media) - len(known)
            row.update(media_files=len(it.media), media_bytes=sum(known) + unknown * p.file_bytes,
                       thumb_bytes=len(it.media) * THUMB, guessed_media_bytes=unknown * p.file_bytes)
        age = now_ms - it.ts
        for name, days in PERIODS:
            if days is None or age <= days * DAY_MS:
                out[name][it.network].update(row)
        oldest[it.network] = min(oldest.get(it.network, it.ts), it.ts)
    result = {"periods": {}, "oldest": {k: v for k, v in sorted(oldest.items())}}
    for name, _ in PERIODS:
        nets = {}
        total = collections.Counter()
        for net, c in sorted(out[name].items()):
            nets[net] = finish(c)
            total.update(c)
        result["periods"][name] = {"networks": nets, "total": finish(total)}
    return result


def finish(c):
    d = {k: round(c[k]) for k in ("messages", "media_files", "archive_bytes", "media_bytes", "thumb_bytes")}
    d["total_bytes"] = d["archive_bytes"] + d["media_bytes"] + d["thumb_bytes"]
    # How much of the media figure is a guess from PROFILES rather than sizes the source stated.
    d["media_exact"] = round(1 - c["guessed_media_bytes"] / c["media_bytes"], 2) if c["media_bytes"] else 1.0
    return d


# ---------------------------------------------------------------- sources

def ro(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)


def has_table(c, name):
    return c.execute("SELECT 1 FROM sqlite_master WHERE name = ?", (name,)).fetchone() is not None


def from_archive(db):
    """What archive.db holds now, with each message's real sizes."""
    with closing(ro(db)) as c:
        raw = collections.Counter()
        for table, key in (("history_data", "message"), ("messenger_message_data", "message")):
            if has_table(c, table):
                for mid, n in c.execute(f"SELECT {key}, length(CAST(raw AS BLOB)) FROM {table}" if table == "history_data"
                                        else f"SELECT {key}, length(CAST(data AS BLOB)) FROM {table}"):
                    raw[mid] += n
        media = collections.defaultdict(list)
        if has_table(c, "message_media"):
            # Only files it holds: Discord's are fetched on request (the rows of the others carry their size anyway).
            for mid, size in c.execute("SELECT message, bytes FROM message_media WHERE path IS NOT NULL"):
                media[mid].append(size)
        for mid, net, ts, n in c.execute("SELECT m.id, coalesce(c.network, ''), m.ts, length(CAST(m.body AS BLOB)) "
                                         "FROM messages m JOIN chats c ON c.id = m.chat"):
            yield Item(net or "other", ts, n, raw.get(mid, 0), media.get(mid, []))


def calibrate(db):
    """PROFILES and OVERHEAD from the local archive, for networks with enough messages to say something."""
    stats = collections.defaultdict(collections.Counter)
    for it in from_archive(db):
        s = stats[it.network]
        s["n"] += 1
        s["body"] += it.body
        s["raw"] += it.raw
        if it.media:
            s["with_media"] += 1
            s["files"] += len(it.media)
            sized = [b for b in it.media if b is not None]
            s["sized"] += len(sized)
            s["bytes"] += sum(sized)
    n = sum(s["n"] for s in stats.values())
    text = sum(s["body"] + s["raw"] for s in stats.values())
    overhead = max(200, round((os.path.getsize(db) - text) / n)) if n else OVERHEAD
    profiles = dict(PROFILES)
    for net, s in stats.items():
        if s["n"] < 200: continue
        base = profile(net, PROFILES)
        profiles[net] = Profile(s["body"] / s["n"], s["raw"] / s["n"], s["with_media"] / s["n"],
                                s["files"] / s["with_media"] if s["with_media"] else base.files,
                                s["bytes"] / s["sized"] if s["sized"] >= 20 else base.file_bytes)
    return profiles, overhead


FETCH_ROW = re.compile(rb'RFC822\.SIZE (\d+)')


def from_gmail(conn):
    """Every mail in All Mail: its date and its exact size, from one metadata FETCH. The text Weft keeps is the
    mail's plain text, the rest (attachments, base64-encoded in the mail) goes to the media folder."""
    import_cleanup = load_cleanup()
    reply = import_cleanup.ok(conn.select(import_cleanup.mailbox(conn, "\\All"), readonly=True))
    if not int(reply[0] or 0): return
    for row in import_cleanup.ok(conn.uid("fetch", "1:*", "(RFC822.SIZE INTERNALDATE)")):
        line = row[0] if isinstance(row, tuple) else row
        size = FETCH_ROW.search(line or b"")
        when = imaplib.Internaldate2tuple(line or b"")
        if not size or not when: continue
        size = int(size[1])
        body = min(size, PROFILES["gmail"].body)
        # Attachments: what is left beyond the text and headers, decoded from base64 (3 bytes for every 4).
        rest = size - body - 4_000
        yield Item("gmail", int(time.mktime(when) * 1000), body, 0, [rest * 3 // 4] if rest > 50_000 else [])


def load_cleanup():
    import importlib.util
    spec = importlib.util.spec_from_file_location("gmail_cleanup", HERE.parent / "gmail" / "cleanup.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def gmail_account(address):
    accounts = json.loads((SPIKE / "gmail/state/accounts.json").read_text())
    for creds in accounts.values():
        if creds.get("email", "").lower() == address.lower(): return creds
    raise SystemExit("No such Gmail account is connected")


def zip_sizes(z):
    """Member sizes by path and, for references that differ in their leading folders, by file name."""
    full = {str(PurePosixPath(i.filename)): i.file_size for i in z.infolist() if not i.is_dir()}
    names = collections.defaultdict(list)
    for path, size in full.items(): names[PurePosixPath(path).name].append(size)
    return full, {k: v[0] for k, v in names.items() if len(v) == 1}


def lookup(sizes, uri):
    full, names = sizes
    uri = str(PurePosixPath(uri))
    return full.get(uri, names.get(PurePosixPath(uri).name))


def from_messenger(zips):
    sys.path.insert(0, str(HERE))
    import import_messenger
    sizes = {}
    for t in import_messenger.read_threads(zips):
        if t["zip"] not in sizes:
            with zipfile.ZipFile(t["zip"]) as z: sizes[t["zip"]] = zip_sizes(z)
        for m in t["data"]["messages"]:
            # As import_messenger.py keeps them: a removed message stays as a line, a file the export lacks has none.
            names = [import_messenger.media_name(a["uri"]) for a in m.get("media", [])]
            files = [lookup(sizes[t["zip"]], n) for n in names if n]
            yield Item("messenger", m["timestamp"], len(import_messenger.body(m).encode()), len(json.dumps(m, ensure_ascii=False).encode()), files)


def from_instagram(zips):
    sys.path.insert(0, str(HERE))
    import archive
    sizes = {}
    for z in zips:
        with zipfile.ZipFile(z) as f: sizes[z] = zip_sizes(f)
    merged = (dict(collections.ChainMap(*[s[0] for s in sizes.values()])), dict(collections.ChainMap(*[s[1] for s in sizes.values()])))
    for t in archive.ig_threads(zips).values():
        for ts, _sender, body, files in t["messages"].values():
            yield Item("instagram", ts, len(body.encode()), 0, [lookup(merged, uri) for _kind, uri in files])


def from_beeper(folder):
    """Beeper Desktop's index.db: each message of every chat, with the sizes of the files Beeper cached."""
    sys.path.insert(0, str(HERE))
    from import_beeper import network_of, SKIP
    folder = Path(folder)
    cached = folder / "media" / "local.beeper.com"
    with closing(ro(folder / "index.db")) as b:
        b.row_factory = sqlite3.Row
        nets = {}
        for t in b.execute("SELECT threadID, thread FROM threads"):
            nets[t["threadID"]] = network_of(((json.loads(t["thread"]).get("extra") or {}).get("bridge")))[0]
        for m in b.execute("SELECT roomID, type, timestamp, message FROM mx_room_messages WHERE isDeleted = 0"):
            if m["type"] in SKIP or not m["timestamp"] or m["roomID"] not in nets: continue
            msg = json.loads(m["message"])
            files = []
            for a in msg.get("attachments") or []:
                if not a.get("srcURL"): continue
                local = cached / a["srcURL"].split("?", 1)[0].rsplit("/", 1)[-1]
                size = a.get("fileSize")
                files.append(local.stat().st_size if local.is_file() else size if isinstance(size, int) else None)
            yield Item(nets[m["roomID"]], m["timestamp"], len((msg.get("text") or "").encode()), len(m["message"].encode()), files)


def from_whatsapp(db):
    """What the phone sent at pairing (3 months, or a year with a full sync); the bridge deletes it once bridged."""
    with closing(ro(db)) as c:
        for ts, n in c.execute("SELECT timestamp, length(data) FROM whatsapp_history_sync_message"):
            yield Item("whatsapp", ts * 1000, None, n, None)


def on_disk(db):
    """What the archive takes now, to hold the estimate against: media files are stored once however many messages
    share them, and the homeserver's own media (media/matrix) belong to no archived message."""
    def tree(path):
        return sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) if path.is_dir() else 0
    return {"archive_db": db.stat().st_size, "media": tree(db.parent / "media"), "thumbs": tree(db.parent / "thumbs")}


# ---------------------------------------------------------------- output

def human(n):
    for unit, size in (("GB", 1e9), ("MB", 1e6), ("kB", 1e3)):
        if n >= size: return f"{n / size:.1f} {unit}".replace(".", ",")
    return f"{n} B"


LABELS = {"30": "posledných 30 dní", "90": "posledné 3 mesiace", "365": "posledný rok", "all": "celá história"}


def text(result):
    lines = []
    for name, _ in PERIODS:
        t = result["periods"][name]["total"]
        guess = "" if t["media_exact"] >= 0.95 else " (prílohy odhadom)" if t["media_exact"] < 0.05 else f" (prílohy z {round(t['media_exact'] * 100)} % presne)"
        lines.append(f"{LABELS[name]}: {t['messages']:,} správ".replace(",", " ")
                     + f", text {human(t['archive_bytes'])}, fotky a súbory {human(t['media_bytes'] + t['thumb_bytes'])}{guess}"
                     + f" → spolu asi {human(t['total_bytes'])}")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", choices=("archive", "gmail", "messenger", "instagram", "beeper", "whatsapp"))
    parser.add_argument("paths", nargs="*", help="ZIP files, Beeper's folder or a Gmail address")
    parser.add_argument("--db", default=os.environ.get("ARCHIVE_DB", str(SPIKE / "archive/archive.db")))
    parser.add_argument("--calibrate", action="store_true", help="per-message sizes from --db instead of the built-in ones")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()
    profiles, overhead = calibrate(args.db) if args.calibrate else (PROFILES, OVERHEAD)
    conn = None
    try:
        if args.source == "archive": items = from_archive(args.db)
        elif args.source == "gmail":
            if len(args.paths) != 1: parser.error("gmail takes one address")
            conn = load_cleanup().connect(gmail_account(args.paths[0]))
            items = from_gmail(conn)
        elif args.source == "messenger": items = from_messenger(args.paths)
        elif args.source == "instagram": items = from_instagram(args.paths)
        elif args.source == "beeper":
            if len(args.paths) != 1: parser.error("beeper takes one folder")
            items = from_beeper(args.paths[0])
        else: items = from_whatsapp(SPIKE / "whatsapp/bridge.db")
        result = summarize(items, profiles=profiles, overhead=overhead)
        if args.source == "archive": result["disk"] = on_disk(Path(args.db))
    finally:
        if conn is not None: conn.logout()
    if not args.text: print(json.dumps(result, ensure_ascii=False, indent=1))
    else:
        print(text(result))
        if "disk" in result: print("dnes na disku: " + ", ".join(f"{k} {human(v)}" for k, v in result["disk"].items()))


if __name__ == "__main__":
    main()

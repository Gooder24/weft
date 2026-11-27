#!/usr/bin/env python3
"""Weft's message archive: every conversation kept on asus, also what the bridges never brought over.

Matrix rooms only hold what a bridge backfilled (about the last 50 messages of a chat), and a homeserver
cannot put older messages in front of them. So the history lives here, in archive.db (SQLite), and Weft
asks for it when Karchi scrolls past a chat's first message on Matrix.

    archive.py serve                  HTTP for Weft on 127.0.0.1:29324 (Caddy: /_archive/), every hour
                                      a copy of every message on the homeserver (`mirror`), and every read
                                      receipt of others as it comes (GET /_archive/rooms/{room}/receipts)
                                      (install.sh runs it with ARCHIVE_OWNER_FILE: only the HTTP, for
                                      „Prejsť z Beeperu“ and old chats, owned by the server's first account)
    archive.py mirror                 that copy once
    archive.py history teams          every Teams chat paged back to its start now (the bridge's GET /history)
    archive.py instagram ZIP...       import Instagram's "Download your information" exports (JSON)
    import_messenger.py ZIP --dry-run validate/count Messenger's encrypted-chat export, without writing
    import_messenger.py ZIP           import it with a SQLite backup, raw message data and local attachments
    archive.py export DIR             one text file per conversation
    archive.py local                  that export plus a copy of archive.db into ./local, which x270 pulls
                                      every hour (server/archive/x270/); `serve` refreshes it hourly too
    archive.py unlink CHAT            undo Weft's "Napísať" on an old chat: it is read-only on its own again
    archive.py join CHAT INTO         two old chats of one person on one network become INTO's conversation

The history comes from the homeserver, from export files Karchi downloaded himself, and for Messenger and
Instagram from the bridges: when Weft reaches the oldest message the archive has for a chat, the bridge fetches
one more page of it from Meta, as the web client does on scrolling up (server/archive/messenger-archivefetch.patch (Instagram: instagram-archivefetch.patch);
one page at a time, two seconds apart). Their photos and videos up to 50 MB the bridge saves into ./media/<network>/
(never to Matrix); the homeserver's own are copied into ./media/matrix and the exports' into ./media/<network>.
Weft's gallery (Ctrl+P) reads them all through /_archive/rooms/{room}/media and /_archive/media/{id}?w=320.
    archive.py instagram-media ZIP... the attachments of already imported Instagram messages
    archive.py thumbs                 every stored photo's and video's thumbnail made ahead (also hourly)
Build those bridges on asus: the running commit with its patch applied (Messenger upstream main efc4c92 in
~/build/meta-calls, branch weft-calls, for its call records; Instagram tag v0.2610.0 in ~/build/meta-carousel),
`go build -tags goolm ./cmd/mautrix-meta` (or ./cmd/mautrix-instagram), plus bridge-archive.conf.
Its own device logs in once with a token from mint-login-token.py; the token stays in ./token (0600)."""
import collections, datetime, filecmp, statistics, gzip, hashlib, json, os, re, shutil, sqlite3, stat, subprocess, sys, threading, time, unicodedata, zipfile
import urllib.error, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import discord_weft

HERE = os.path.dirname(os.path.abspath(__file__))
SPIKE = os.environ.get("ARCHIVE_SPIKE", os.path.expanduser("~/matrix-spike"))
HS = os.environ.get("HS", "http://127.0.0.1:8008")
DB = os.environ.get("ARCHIVE_DB", os.path.join(HERE, "archive.db"))
TOKEN_FILE = os.path.join(HERE, "token")
MEDIA = os.environ.get("ARCHIVE_MEDIA", os.path.join(HERE, "media"))
THUMBS = os.environ.get("ARCHIVE_THUMBS", os.path.join(HERE, "thumbs"))
PORT = int(os.environ.get("ARCHIVE_PORT", "29324"))
# install.sh's Weft: no login of its own (no mirror, receipts or bridge pages); the server's first account that calls it
# owns it, kept in this file. Without it (asus) the owner is the account of ./token.
OWNER_FILE = os.environ.get("ARCHIVE_OWNER_FILE")
# Bridges patched with messenger-archivefetch.patch (Instagram: instagram-archivefetch.patch), and the token they expect (./bridge-token, 0600).
BRIDGES = {"messenger": "http://127.0.0.1:29325", "instagram": "http://127.0.0.1:29326", "teams": "http://127.0.0.1:29330"}
# Networks `history` may page back whole ahead of time (Karchi's yes, 2026-11-27); Meta's only as Weft scrolls.
HISTORY_AHEAD = {"teams"}
BRIDGE_TOKEN_FILE = os.path.join(HERE, "bridge-token")
PROTOCOLS = {"whatsapp": "whatsapp", "facebookgo": "messenger", "facebook": "messenger", "instagramgo": "instagram",
             "instagram": "instagram", "discordgo": "discord", "discord": "discord", "teams": "teams"}
q = lambda s: urllib.parse.quote(s, safe="")


def call(method, path, body=None, token=None, timeout=120):
    req = urllib.request.Request(HS + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def login():
    if os.path.exists(TOKEN_FILE):
        token = open(TOKEN_FILE).read().strip()
        try:
            call("GET", "/_matrix/client/v3/account/whoami", token=token)
            return token
        except urllib.error.HTTPError as e:
            if e.code != 401: raise
    mint = subprocess.check_output([sys.executable, f"{SPIKE}/homeserver/mint-login-token.py"], text=True).strip()
    token = call("POST", "/_matrix/client/v3/login", {"type": "m.login.token", "token": mint,
                                                     "initial_device_display_name": "Weft archive"})["access_token"]
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
    os.write(fd, token.encode()); os.close(fd)
    return token


def db():
    c = sqlite3.connect(DB, timeout=30)
    c.execute("PRAGMA journal_mode=WAL")
    c.executescript("""
        CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, network TEXT, title TEXT, room TEXT, source TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chat TEXT NOT NULL, ts INTEGER NOT NULL,
            sender TEXT NOT NULL, me INTEGER NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages (chat, ts);
        CREATE INDEX IF NOT EXISTS chats_room ON chats (room);
        CREATE INDEX IF NOT EXISTS chats_archive_room ON chats (COALESCE(room,'archive:'||id));
        -- How far back a bridge has fetched a room: the oldest message so far and the network's cursor past it.
        CREATE TABLE IF NOT EXISTS fetched (room TEXT PRIMARY KEY, cursor TEXT NOT NULL DEFAULT '', before_id TEXT,
            before_ts INTEGER, done INTEGER NOT NULL DEFAULT 0, fails INTEGER NOT NULL DEFAULT 0, failed_at REAL);
        CREATE TABLE IF NOT EXISTS history_native (
            message TEXT NOT NULL, native_id TEXT NOT NULL, PRIMARY KEY(message,native_id));""")
    if "empty" not in [r[1] for r in c.execute("PRAGMA table_info(fetched)")]:
        c.execute("ALTER TABLE fetched ADD COLUMN empty INTEGER NOT NULL DEFAULT 0")  # pages in a row without a message
    # A message's attachments. path: the file under ./media (content-addressed); original_uri: where it came from
    # (an mxc:// on the homeserver, a path in an export, bridge:<file>). w/h in pixels, duration in ms, thumb an mxc.
    # The gallery's ids are this table's rowid: never VACUUM (see messages_fts).
    c.executescript("""
        CREATE TABLE IF NOT EXISTS message_media (message TEXT NOT NULL, position INTEGER NOT NULL,
            path TEXT, kind TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER,
            original_uri TEXT NOT NULL, PRIMARY KEY (message, position));
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        -- Old chats join_chat put into another one's conversation; unlink_chat brings back only these.
        CREATE TABLE IF NOT EXISTS joined (chat TEXT PRIMARY KEY, target TEXT NOT NULL);
        -- Old chats Karchi took back from a live room (unlink_chat): an import never links them again.
        CREATE TABLE IF NOT EXISTS unlinked (chat TEXT PRIMARY KEY);
        -- Every read receipt of others the archive saw (see watch_receipts). base: it came in the first sync after
        -- a start, so earlier moves of that person's receipt are unknown. event_ts: the read message's time.
        CREATE TABLE IF NOT EXISTS receipts (room TEXT NOT NULL, user TEXT NOT NULL, event TEXT NOT NULL,
            ts INTEGER NOT NULL, event_ts INTEGER, base INTEGER NOT NULL, PRIMARY KEY (room, user, event));
        CREATE INDEX IF NOT EXISTS receipts_room_event_ts ON receipts (room, event_ts);""")
    have = [r[1] for r in c.execute("PRAGMA table_info(message_media)")]
    for col in ("w INTEGER", "h INTEGER", "duration INTEGER", "thumb TEXT"):
        if col.split()[0] not in have: c.execute(f"ALTER TABLE message_media ADD COLUMN {col}")
    # Full-text index for Ctrl+K, kept by triggers. It points at messages' rowid: never VACUUM archive.db (that can
    # renumber a table without an INTEGER PRIMARY KEY); rebuild the index if it ever happens.
    if not c.execute("SELECT 1 FROM sqlite_master WHERE name='messages_fts'").fetchone():
        c.executescript("""
            CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='rowid',
                tokenize='unicode61 remove_diacritics 2');
            CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body); END;
            CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
                INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body); END;
            CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
                INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
                INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body); END;
            INSERT INTO messages_fts (messages_fts) VALUES ('rebuild');""")
    os.chmod(DB, 0o600)
    return c


# ---------------------------------------------------------------- homeserver copy

KINDS = {"m.image": "[Fotka]", "m.video": "[Video]", "m.audio": "[Zvuková správa]", "m.file": "[Súbor]"}
MEDIA_KINDS = {"m.image": "image", "m.video": "video", "m.audio": "audio", "m.file": "file"}
MEDIA_COLS = "message, position, path, kind, mime, bytes, original_uri, w, h, duration, thumb"
ADD_MEDIA = f"INSERT OR IGNORE INTO message_media ({MEDIA_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
MAX_MEDIA = 50_000_000  # bigger attachments stay on the homeserver or at Meta

# ---------------------------------------------------------------- Discord attachments of collected history

# collect_history.py keeps each Discord message whole (history_data.raw), its attachments as CDN links that expire
# after a day. Their rows here have no file until Weft or `weft file` asks for one: fetch_discord_file then has
# Discord sign the link anew, as its own app does, and keeps the file in ./media/discord.
DISCORD_BRIDGE_DB = os.path.join(SPIKE, "discord", "bridge.db")
DISCORD_CDN = re.compile(r"https://cdn\.discordapp\.com/attachments/\d+/\d+/[^?#/\s]+")
discord_locks = collections.defaultdict(threading.Lock)


def discord_media_rows(message, raw):
    """message_media rows, without a file yet, for a collected Discord message's attachments."""
    out = []
    for i, a in enumerate(raw.get("attachments") or []):
        uri = str(a.get("url") or "").split("?")[0]
        if not DISCORD_CDN.fullmatch(uri): continue
        mime = str(a.get("content_type") or "application/octet-stream").split(";")[0].strip()
        kind = next((k for k in ("image", "video", "audio") if mime.startswith(k + "/")), "file")
        num = lambda k: a.get(k) if isinstance(a.get(k), int) and a.get(k) > 0 else None
        out.append((message, i, None, kind, mime, num("size"), uri, num("width"), num("height"), None, None))
    return out


def index_discord_media(c):
    """Rows for the attachments of collected Discord messages that have none yet; the files stay at Discord."""
    rows = []
    for message, raw in c.execute("""SELECT h.message, h.raw FROM history_data h WHERE h.network = 'discord'
            AND h.raw LIKE '%"attachments":[{%' AND NOT EXISTS (SELECT 1 FROM message_media mm WHERE mm.message = h.message)"""):
        try: rows += discord_media_rows(message, json.loads(raw))
        except (ValueError, AttributeError): continue
    if rows:
        c.executemany(ADD_MEDIA, rows)
        c.commit()
    return len(rows)


def discord_token():
    b = sqlite3.connect(f"file:{DISCORD_BRIDGE_DB}?mode=ro", uri=True, timeout=10)
    try: row = b.execute("SELECT discord_token FROM user WHERE discord_token IS NOT NULL AND discord_token != ''").fetchone()
    finally: b.close()
    if not row: raise ValueError("the Discord bridge is not logged in")
    return row[0]


def fetch_discord_file(rowid, uri):
    """The attachment's path under ./media, downloaded once (one Discord request and one CDN download)."""
    with discord_locks[rowid]:
        c = db()
        try:
            row = c.execute("SELECT path, bytes FROM message_media WHERE rowid = ?", (rowid,)).fetchone()
            if row and row[0]: return row[0]
            if row and (row[1] or 0) > MAX_MEDIA: raise ValueError("too large")
            req = urllib.request.Request("https://discord.com/api/v9/attachments/refresh-urls", method="POST",
                data=json.dumps({"attachment_urls": [uri]}).encode(),
                headers={"Authorization": discord_token(), "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as r: answer = json.load(r)
            try: fresh = answer["refreshed_urls"][0]["refreshed"]
            except (KeyError, IndexError, TypeError): raise ValueError("Discord did not sign the link") from None
            if str(fresh).split("?")[0] != uri: raise ValueError("Discord signed another link")
            folder = os.path.join(MEDIA, "discord")
            os.makedirs(folder, mode=0o700, exist_ok=True)
            fd, tmp = __import__("tempfile").mkstemp(dir=folder, prefix=".fetch-")
            try:
                h, size = hashlib.sha256(), 0
                with os.fdopen(fd, "wb") as out, urllib.request.urlopen(
                        urllib.request.Request(fresh, headers={"User-Agent": "Mozilla/5.0"}), timeout=60) as src:
                    while chunk := src.read(1 << 20):
                        size += len(chunk)
                        if size > MAX_MEDIA: raise ValueError("too large")
                        h.update(chunk); out.write(chunk)
                ext = os.path.splitext(uri)[1].lower()
                if len(ext) > 10 or not ext[1:].isalnum(): ext = ""
                dest = os.path.join(folder, h.hexdigest() + ext)
                if not os.path.exists(dest): os.link(tmp, dest)
            finally: os.unlink(tmp)
            rel = os.path.relpath(dest, MEDIA)
            c.execute("UPDATE message_media SET path = ?, bytes = ? WHERE rowid = ?", (rel, size, rowid))
            c.commit()
            return rel
        finally: c.close()


def discord_poll(p):
    """A collected Discord poll as Weft draws it: answers with Discord's counts as they stood when collected."""
    if not isinstance(p, dict): return None
    def text(m):
        e, t = m.get("emoji") or {}, m.get("text") or ""
        if e.get("name") and not e.get("id"): return f"{e['name']} {t}".strip()
        return t or (f":{e['name']}:" if e.get("name") else "")
    answers = [{"id": str(a["answer_id"]), "text": text(a.get("poll_media") or {})} for a in p.get("answers") or [] if "answer_id" in a]
    results = p.get("results") or {}
    counts = {str(c["id"]): c.get("count", 0) for c in results.get("answer_counts") or [] if "id" in c}
    try: expiry = int(datetime.datetime.fromisoformat(p["expiry"]).timestamp() * 1000) if p.get("expiry") else None
    except ValueError: expiry = None
    return {"question": text(p.get("question") or {}), "answers": answers, "multi": bool(p.get("allow_multiselect")),
            "counts": counts, "mine": [str(c["id"]) for c in results.get("answer_counts") or [] if c.get("me_voted")],
            "closed": bool(results.get("is_finalized")), "expiry": expiry}


def poll_end_body(m):
    """What Discord's poll result message (type 46) says, from its poll_result embed."""
    f = {x.get("name"): x.get("value") for e in m.get("embeds") or [] if e.get("type") == "poll_result" for x in e.get("fields") or []}
    if not f.get("poll_question_text"): return None
    win = f.get("victor_answer_text") or ""
    if f.get("victor_answer_emoji_name") and not f.get("victor_answer_emoji_id"): win = f"{f['victor_answer_emoji_name']} {win}".strip()
    return "Anketa skončila: " + f["poll_question_text"] + (
        f"\nVyhrala odpoveď: {win} ({f.get('victor_answer_votes', '?')} z {f.get('total_votes', '?')} hlasov)" if win else "")


def message_polls(c, ids):
    """{message id: {poll} or {body}} for the collected Discord polls and poll results among ids."""
    out = {}
    ids = list(ids)
    if not c.execute("SELECT 1 FROM sqlite_master WHERE name = 'history_data'").fetchone(): return out  # nothing collected yet
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        for msg, raw in c.execute(f"""SELECT message, raw FROM history_data WHERE network = 'discord'
                AND message IN ({",".join("?" * len(chunk))}) AND (raw LIKE '%"poll":{{%' OR raw LIKE '%"type":46%')""", chunk):
            try:
                m = json.loads(raw)
                poll = discord_poll(m.get("poll"))
                body = poll_end_body(m) if m.get("type") == 46 else None
            except (ValueError, AttributeError, TypeError): continue
            if poll and poll["answers"]: out[msg] = {"poll": poll}
            elif body: out[msg] = {"body": body}
    return out


def message_extras(c, ids):
    """{message id: {files?, poll?, body?}} for archive rows: a poll result's own words replace its placeholder."""
    ids = list(ids)
    files, polls = message_files(c, ids), message_polls(c, ids)
    return {i: {**({"files": files[i]} if i in files else {}), **polls.get(i, {})} for i in ids}


def media_name(uri, path):
    """The name a downloaded attachment gets: Discord's own, else what the export or the bridge called it."""
    if uri.startswith('gmail-attachment/'): return urllib.parse.unquote(uri.split('/', 1)[1])
    if DISCORD_CDN.fullmatch(uri): return urllib.parse.unquote(uri.rsplit("/", 1)[1])
    name = os.path.basename(uri.split("?")[0]) if not uri.startswith("mxc://") else ""
    return name if "." in name else "subor" + os.path.splitext(path or "")[1]


def message_files(c, ids):
    """{message id: [{id, name, kind, mime, size}]} of the attachments Weft can download (/_archive/media/{id})."""
    out = collections.defaultdict(list)
    ids = list(ids)
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        for rowid, msg, kind, mime, size, uri, path, w, h, dur in c.execute(f"""SELECT rowid, message, kind, mime, bytes, original_uri,
                path, w, h, duration FROM message_media WHERE message IN ({",".join("?" * len(chunk))}) ORDER BY message, position""", chunk):
            if path or uri.startswith("mxc://") or DISCORD_CDN.fullmatch(uri):
                # here: the file is on asus or the homeserver, so Weft may show it in place (a Discord one waits for a click)
                out[msg].append({"id": rowid, "name": media_name(uri, path), "kind": kind, "mime": mime, "size": size,
                                 "here": bool(path or uri.startswith("mxc://")), **({"w": w, "h": h} if w and h else {}),
                                 **({"dur": dur} if dur else {})})
    return out


def matrix_media(ev):
    """The attachment of a homeserver message as a message_media row, or None."""
    c = ev.get("content") or {}
    kind = MEDIA_KINDS.get(c.get("msgtype"))
    if not kind or not str(c.get("url") or "").startswith("mxc://"): return None
    info = c.get("info") if isinstance(c.get("info"), dict) else {}
    num = lambda k: info.get(k) if isinstance(info.get(k), int) else None
    thumb = info.get("thumbnail_url") if str(info.get("thumbnail_url") or "").startswith("mxc://") else None
    return (ev["event_id"], 0, None, kind, str(info.get("mimetype") or "application/octet-stream"), num("size"), c["url"],
            num("w"), num("h"), num("duration"), thumb)


def matrix_body(ev):
    c = ev.get("content") or {}
    if ev["type"] == "m.sticker": return "[Nálepka]"
    body = re.sub(r"^(> .*\n)+\n", "", str(c.get("body") or "")).strip()
    kind = KINDS.get(c.get("msgtype"))
    if kind: return f"{kind} {body}".strip() if c.get("filename") and body != c.get("filename") else kind
    return body


def mirror(token, log=print):
    """Copies every message of every joined room; pages back only until it meets what it already has. The first run
    with attachments (settings matrix_media) reads every room whole once, for the attachments of messages it had."""
    c = db()
    me = call("GET", "/_matrix/client/v3/account/whoami", token=token)["user_id"]
    full = not c.execute("SELECT 1 FROM settings WHERE key='matrix_media'").fetchone()
    added, failed = 0, False
    for room in call("GET", "/_matrix/client/v3/joined_rooms", token=token)["joined_rooms"]:
        try: added += mirror_room(c, token, me, room, full)
        except Exception as e:
            # Keep none of a half-copied room: the next run stops at the first message it has.
            c.rollback()
            failed = True
            log(f"mirror: {room} failed: {e}")
    if full and not failed:
        c.execute("INSERT OR REPLACE INTO settings VALUES ('matrix_media', ?)", (str(int(time.time())),)); c.commit()
    log(f"mirror: {added} new messages")
    return added


def mirror_room(c, token, me, room, full=False):
    added = 0
    state = call("GET", f"/_matrix/client/v3/rooms/{q(room)}/state", token=token)
    network, title, names = None, None, {}
    for ev in state:
        if ev["type"] in ("m.bridge", "uk.half-shot.bridge"):
            pid = ev["content"].get("protocol", {}).get("id")
            network = PROTOCOLS.get(pid, pid)
        elif ev["type"] == "m.room.name": title = ev["content"].get("name")
        elif ev["type"] == "m.room.member": names[ev["state_key"]] = ev["content"].get("displayname") or ev["state_key"]
    if network is None and any(k.startswith("@edupage") for k in names): network = "edupage"
    c.execute("INSERT INTO chats VALUES (?,?,?,?, 'matrix') ON CONFLICT (id) DO UPDATE SET network=excluded.network, title=excluded.title",
              (room, network, title, room))
    frm, seen = "", False
    flt = q(json.dumps({"types": ["m.room.message", "m.sticker"]}))
    while not seen:
        page = call("GET", f"/_matrix/client/v3/rooms/{q(room)}/messages?dir=b&limit=500&filter={flt}" + (f"&from={q(frm)}" if frm else ""), token=token)
        rows, files = [], []
        for ev in page.get("chunk", []):
            if not ev.get("content"): continue  # redacted
            rel = ev["content"].get("m.relates_to", {})
            if rel.get("rel_type") == "m.replace": continue  # an edit; the original is kept as it was sent
            if (att := matrix_media(ev)) and (full or not seen): files.append(att)
            if c.execute("SELECT 1 FROM messages WHERE id=?", (ev["event_id"],)).fetchone():
                seen = not full
                continue
            rows.append((ev["event_id"], room, ev["origin_server_ts"], names.get(ev["sender"], ev["sender"]), int(ev["sender"] == me), matrix_body(ev)))
        c.executemany("INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?)", rows)
        c.executemany(ADD_MEDIA, files)
        added += len(rows)
        if not page.get("end") or not page.get("chunk"): break
        frm = page["end"]
    c.commit()
    return added


# ---------------------------------------------------------------- Instagram export

def fix(s):
    """Meta writes UTF-8 bytes as if each were a Latin-1 character."""
    try: return s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError): return s


REACTION = re.compile(r"^(.+ )?(liked a message|reacted .{1,16} to your message)\s*$", re.I | re.S)


def ig_body(m):
    if m.get("is_unsent") or REACTION.match(fix(m.get("content") or "")): return None
    parts = []
    if m.get("photos"): parts.append("[Fotka]" if len(m["photos"]) == 1 else f"[{len(m['photos'])} fotky]")
    if m.get("videos"): parts.append("[Video]")
    if m.get("audio_files"): parts.append("[Zvuková správa]")
    if m.get("gifs"): parts.append("[GIF]")
    if m.get("files"): parts.append("[Súbor]")
    if "call_duration" in m: parts.append(f"[Hovor {m['call_duration'] // 60}:{m['call_duration'] % 60:02d}]")
    text = fix(m.get("content") or "")
    share = m.get("share") or {}
    if share.get("link") and share["link"] not in text: text = f"{text} {share['link']}".strip()
    if text: parts.append(text)
    return " ".join(parts) or None


def bridge_rooms(bridge):
    """Each portal of a bridge: its room, name and the seconds its messages were sent at."""
    c = sqlite3.connect(f"file:{SPIKE}/{bridge}/bridge.db?mode=ro", uri=True)
    portals = {pid: {"room": mxid, "name": name, "secs": set()} for pid, mxid, name in
               c.execute("SELECT id, mxid, name FROM portal WHERE mxid IS NOT NULL")}
    for pid, ts in c.execute("SELECT room_id, timestamp FROM message"):
        if pid in portals: portals[pid]["secs"].add(ts // 1_000_000_000 if ts > 1e14 else ts // 1000)
    return list(portals.values())


def match_room(portals, title, people, secs):
    """The portal that shares the most send times with the thread; by name only when no message overlaps
    (a chat that started after the export): the group's title, or the other person of a one-to-one chat."""
    ranked = sorted(portals, key=lambda p: len(p["secs"] & secs), reverse=True)
    best, runner = (len(p["secs"] & secs) for p in (ranked + [{"secs": set()}] * 2)[:2])
    # A few shared seconds can be chance: the winner needs them and twice as many as any other room.
    if best and best >= min(3, len(ranked[0]["secs"])) and best >= 2 * runner: return ranked[0]["room"]
    named = [p for p in portals if p["name"] and (p["name"] == title or (len(people) == 2 and p["name"] in people))]
    return named[0]["room"] if len(named) == 1 else None


IG_MEDIA = (("photos", "image"), ("videos", "video"), ("gifs", "image"), ("audio_files", "audio"), ("files", "file"))


def ig_threads(zips):
    """Every conversation in Instagram's exports: title, people and messages by key, each with its attachments."""
    threads = collections.defaultdict(lambda: {"title": "", "people": set(), "messages": {}})
    for z in zips:
        zf = zipfile.ZipFile(z)
        for name in zf.namelist():
            m = re.search(r"/messages/((?:inbox|message_requests)/[^/]+)/message_\d+\.json$", name)
            if not m: continue
            d = json.load(zf.open(name))
            t = threads[m.group(1)]
            t["title"] = fix(d.get("title") or "")
            t["people"] |= {fix(p["name"]) for p in d.get("participants", [])}
            for msg in d.get("messages", []):
                body = ig_body(msg)
                if body is None: continue
                sender = fix(msg.get("sender_name") or "")
                key = hashlib.sha1(f"{msg['timestamp_ms']}|{sender}|{body}".encode()).hexdigest()[:16]
                files = [(kind, a["uri"]) for field, kind in IG_MEDIA for a in msg.get(field) or [] if isinstance(a, dict) and a.get("uri")]
                t["messages"][key] = (msg["timestamp_ms"], sender, body, files)
    return threads


def import_instagram(zips, log=print):
    threads = ig_threads(zips)
    owner = collections.Counter(p for t in threads.values() for p in t["people"]).most_common(1)[0][0]
    portals = bridge_rooms("instagram")
    c = db()
    matched = 0
    for path, t in threads.items():
        secs = {ts // 1000 for ts, _, _, _ in t["messages"].values()}
        room = match_room(portals, t["title"], t["people"], secs)
        matched += room is not None
        chat = f"instagram:{path}"
        c.execute("INSERT INTO chats VALUES (?, 'instagram', ?, ?, 'instagram-export') ON CONFLICT (id) DO UPDATE SET title=excluded.title, room=COALESCE(excluded.room, chats.room)",
                  (chat, t["title"], room))
        c.executemany("INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?)",
                      [(f"ig:{path}:{k}", chat, ts, s, int(s == owner), b) for k, (ts, s, b, _) in t["messages"].items()])
    c.commit()
    log(f"instagram: {len(threads)} conversations ({matched} with a room in Weft), "
        f"{sum(len(t['messages']) for t in threads.values())} messages")
    import_instagram_media(zips, threads, log)


def backup(c, what):
    """A consistent copy of archive.db beside it (the SQLite backup API also takes what is still in the WAL)."""
    dest = f"{DB}.bak-{time.strftime('%Y%m%d-%H%M%S')}-{what}"
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.close(fd)
    out = sqlite3.connect(dest); c.backup(out); out.close()
    return dest


def store_file(z, member, folder):
    """Copies a ZIP member into folder under its SHA-256 (never extracting ZIP paths); returns (path under ./media, size)."""
    os.makedirs(folder, mode=0o700, exist_ok=True)
    fd, tmp = __import__("tempfile").mkstemp(dir=folder, prefix=".import-")
    try:
        h = hashlib.sha256()
        with os.fdopen(fd, "wb") as out, z.open(member) as src:
            while chunk := src.read(1 << 20): h.update(chunk); out.write(chunk)
        ext = os.path.splitext(member)[1].lower()
        if len(ext) > 10 or not ext[1:].isalnum(): ext = ""
        dest = os.path.join(folder, h.hexdigest() + ext)
        if os.path.exists(dest):
            with open(dest, "rb") as f:
                if hashlib.file_digest(f, "sha256").hexdigest() != h.hexdigest():
                    raise ValueError(f"{dest} failed its checksum")
        else: os.link(tmp, dest)
        return os.path.relpath(dest, MEDIA), os.path.getsize(dest)
    finally: os.unlink(tmp)


def probe(path, kind):
    """(mime, w, h, duration ms) of a stored file, w and h as it is shown (a phone's turned photo or video upright);
    Nones where it cannot tell."""
    full = os.path.join(MEDIA, path)
    if kind == "image":
        try:
            from PIL import Image
            with Image.open(full) as im:
                w, h = im.size
                if im.getexif().get(0x0112) in (5, 6, 7, 8): w, h = h, w  # EXIF Orientation: turned a quarter
                return Image.MIME.get(im.format, "image/jpeg"), w, h, None
        except Exception: pass
    if kind in ("video", "audio", "image"):
        try:
            out = json.loads(subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", full],
                                            capture_output=True, timeout=60).stdout or b"{}")
            video = next((s for s in out.get("streams", []) if s.get("codec_type") == "video"), {})
            turn = [d.get("rotation") for d in video.get("side_data_list") or [] if "rotation" in d] or [(video.get("tags") or {}).get("rotate")]
            try: turned = round(float(turn[0] or 0)) % 180 == 90
            except (TypeError, ValueError): turned = False
            if turned: video = {**video, "width": video.get("height"), "height": video.get("width")}
            dur = float((out.get("format") or {}).get("duration") or 0)
            names = (out.get("format") or {}).get("format_name", "")
            mime = {"video": "video/mp4", "audio": "audio/mp4"}.get(kind, "image/jpeg") if "mp4" in names else __import__("mimetypes").guess_type(full)[0]
            return mime or "application/octet-stream", video.get("width"), video.get("height"), int(dur * 1000) or None
        except Exception: pass
    return __import__("mimetypes").guess_type(full)[0] or "application/octet-stream", None, None, None


def import_instagram_media(zips, threads=None, log=print):
    """The attachments of the Instagram messages archive.db has (`archive.py instagram-media ZIP...`), into
    ./media/instagram. Only adds: messages, chats and earlier rows stay as they are, and a rerun adds nothing twice."""
    threads = threads or ig_threads(zips)
    members = {}
    for z in zips:
        for n in zipfile.ZipFile(z).namelist(): members.setdefault(n, z)
    c = db()
    want = []  # (message, position, kind, uri)
    for path, t in threads.items():
        for k, (_, _, _, files) in t["messages"].items():
            want += [(f"ig:{path}:{k}", i, kind, uri) for i, (kind, uri) in enumerate(files)]
    have = {r[0] for r in c.execute("SELECT id FROM messages WHERE id LIKE 'ig:%'")}
    done = {(m, p) for m, p in c.execute("SELECT message, position FROM message_media WHERE message LIKE 'ig:%'")}
    todo = [w for w in want if w[0] in have and (w[0], w[1]) not in done]
    log(f"instagram media: {len(want)} attachments, {sum(w[0] in have for w in want)} of messages in the archive, {len(todo)} new")
    if not todo: return {"references": len(want), "added": 0}
    log(f"instagram media: backup {backup(c, 'instagram-media')}")
    saved, zfs = {}, {z: zipfile.ZipFile(z) for z in zips}
    for n, (msg, pos, kind, uri) in enumerate(todo):
        if uri not in saved:
            saved[uri] = None
            if uri in members:
                rel, size = store_file(zfs[members[uri]], uri, os.path.join(MEDIA, "instagram"))
                saved[uri] = (rel, size, *probe(rel, kind))
        got = saved[uri]
        c.execute(ADD_MEDIA, (msg, pos, got and got[0], kind, got[2] if got else "application/octet-stream", got and got[1],
                              uri, got and got[3], got and got[4], got and got[5], None))
        if n % 500 == 499: c.commit(); log(f"instagram media: {n + 1}/{len(todo)}")
    c.commit()
    missing = sum(v is None for v in saved.values())
    log(f"instagram media: {len(todo)} rows, {len(saved) - missing} files, {missing} not in the export")
    return {"references": len(want), "added": len(todo), "files": len(saved) - missing, "missing": missing}


# ---------------------------------------------------------------- export

# A native event at the same millisecond identifies the exported event. Older portals round
# times to seconds: there the text must agree too. A whole covered time range is not evidence
# that the bridge retained every individual message in it.
NATIVE_DUPLICATE = """EXISTS (SELECT 1 FROM messages n JOIN chats nc ON nc.id=n.chat
    WHERE nc.room=c.room AND nc.source IN ('matrix','bridge')
      AND n.ts >= (m.ts/1000)*1000 AND n.ts < (m.ts/1000)*1000+1000
      AND (n.ts=m.ts OR n.body=m.body))"""

HISTORY_VISIBLE = """(c.source!='history' OR c.room LIKE 'archive:%' OR NOT EXISTS (
    SELECT 1 FROM history_native hn JOIN messages n ON n.id=hn.native_id WHERE hn.message=m.id))"""


# A conversation that is no live room's history: no room, or its own read-only archive identity.
UNLINKED = "(c.room IS NULL OR c.room = 'archive:' || c.id)"


def reach(c):
    """How each unlinked conversation's person can be written to again, by its chat id: Instagram by the export's
    username (Weft finds them through the bridge's search), WhatsApp by the history's JID, Gmail and Outlook by mail to
    the newest sender. Groups, Discord and EduPage have none: those stay read-only."""
    out = {}
    others = dict(c.execute(f"""SELECT m.chat, count(DISTINCT m.sender) FROM messages m JOIN chats c ON c.id = m.chat
        WHERE {UNLINKED} AND c.network = 'instagram' AND m.me = 0 GROUP BY m.chat"""))
    for chat, in c.execute(f"SELECT id FROM chats c WHERE {UNLINKED} AND network = 'instagram'"):
        m = re.fullmatch(r"instagram:(?:inbox|message_requests)/([a-z0-9._]+)_\d+", chat)
        if m and m.group(1) != "instagramuser" and others.get(chat, 0) <= 1: out[chat] = {"app": "instagram", "query": m.group(1)}
    if c.execute("SELECT 1 FROM sqlite_master WHERE name = 'history_data'").fetchone():
        for chat, jid in c.execute(f"""SELECT x.chat, min(h.chat) FROM history_data h JOIN messages x ON x.id = h.message
                JOIN chats c ON c.id = x.chat WHERE {UNLINKED} AND h.network = 'whatsapp' GROUP BY x.chat"""):
            user, _, server = jid.partition("@")
            if user.isdigit() and server == "lid": out[chat] = {"app": "whatsapp", "id": "lid-" + user}
            elif user.isdigit() and user != "0" and server == "s.whatsapp.net": out[chat] = {"app": "whatsapp", "id": "+" + user}
    # SQLite takes the other columns from the row with max(ts): the newest mail someone else sent.
    for chat, network, title, sender, _ in c.execute("""SELECT m.chat, c.network, c.title, m.sender, max(m.ts) FROM messages m
            JOIN chats c ON c.id = m.chat WHERE c.network IN ('gmail', 'outlook') AND c.room LIKE 'archive:%' AND m.me = 0 GROUP BY m.chat"""):
        addr = re.search(r"<([^<>@\s]+@[^<>\s]+)>\s*$", sender) or re.fullmatch(r"\s*([^<>@\s]+@[^<>\s]+)\s*", sender)
        if not addr: continue
        account, _, subject = (title or "").partition(" · ")
        subject = subject if re.match(r"(?i)re:", subject) else f"Re: {subject}" if subject else ""
        out[chat] = {"app": network, "mail": addr.group(1), "subject": subject, "account": account}
    return out


def link_chat(c, chat, room):
    """An archived conversation becomes the history of a live room: Weft found its person on the bridge. The old
    chats joined to it (join_chat) go along."""
    chat = chat.removeprefix("archive:")
    with c:
        n = c.execute(f"UPDATE chats AS c SET room = ? WHERE id = ? AND network NOT IN ('gmail', 'outlook') AND {UNLINKED}", (room, chat)).rowcount
        if n:
            c.execute("UPDATE chats SET room = ? WHERE room = ? AND id != ?", (room, "archive:" + chat, chat))
            c.execute("DELETE FROM unlinked WHERE chat = ?", (chat,))
    return n == 1


def discord_allowed(c, chat, room, discord_room=False):
    """link_chat's guard for Discord (discord_weft.link_allowed): an old Discord chat goes only to its own channel's
    room, and nothing else goes into a Discord room. Without the bridge's database only non-Discord chats pass; when it
    is there but fails, nothing does (None)."""
    try: b = discord_weft.bridge_db()
    except sqlite3.Error: b = None
    try: return discord_weft.link_allowed(c, b, Api.owner, chat, room, discord_room)
    except sqlite3.Error: return None  # the bridge's database is there but did not answer: nothing moves (503)
    finally:
        if b: b.close()


def join_chat(c, chat, into):
    """Two old chats of one person (Instagram's export keeps a new thread when the old one was cut off) become one
    conversation, `into`'s. The way back: `archive.py unlink <chat>`."""
    chat, into = chat.removeprefix("archive:"), into.removeprefix("archive:")
    with c:
        ok = c.execute(f"""SELECT count(*) FROM chats AS c WHERE id IN (?, ?) AND network NOT IN ('gmail', 'outlook') AND {UNLINKED}
                           AND network = (SELECT network FROM chats WHERE id = ?)""", (chat, into, into)).fetchone()[0] == 2 and chat != into
        if ok:
            c.execute("UPDATE chats SET room = ? WHERE id IN (?, ?) OR room = ?", ("archive:" + into, chat, into, "archive:" + chat))
            c.execute("UPDATE joined SET target = ? WHERE target = ?", (into, chat))
            c.execute("INSERT OR REPLACE INTO joined (chat, target) VALUES (?, ?)", (chat, into))
    return ok


def unlink_chat(c, chat):
    """The way back from link_chat: the conversation is again its own read-only chat in the archive, with the old
    chats that went along into the live room joined to it again. A joined chat leaves its conversation."""
    chat = chat.removeprefix("archive:")
    with c:
        room = (c.execute("SELECT room FROM chats WHERE id = ?", (chat,)).fetchone() or [None])[0]
        n = c.execute(f"UPDATE chats AS c SET room = 'archive:' || id WHERE id = ? AND source NOT IN ('matrix', 'bridge', 'gmail', 'outlook') AND NOT {UNLINKED}",
                      (chat,)).rowcount
        if n:
            c.execute("DELETE FROM joined WHERE chat = ?", (chat,))
            c.execute("INSERT OR IGNORE INTO unlinked VALUES (?)", (chat,))
            if not room.startswith("archive:"):
                c.execute("UPDATE chats SET room = ? WHERE room = ? AND id IN (SELECT chat FROM joined WHERE target = ?)",
                          ("archive:" + chat, room, chat))
    return n == 1


def conversations(c):
    """Unlinked exports remain real conversations, with an explicitly read-only archive identity."""
    to = reach(c)
    rows = c.execute("""SELECT c.id,c.network,c.title,COALESCE(c.room,'archive:'||c.id),m.id,m.ts,m.sender,m.me,substr(m.body,1,500)
        FROM chats c JOIN messages m ON m.chat=c.id
        WHERE (c.room IS NULL OR c.room LIKE 'archive:%') AND m.id=(
            SELECT x.id FROM messages x WHERE x.chat=c.id ORDER BY x.ts DESC,x.id DESC LIMIT 1)
        ORDER BY m.ts DESC,c.id""")
    # Joined old chats are one conversation, under its newest chat's name; Meta's export may spell a name decomposed.
    seen = set()
    return [{"id": room, "network": network, "title": unicodedata.normalize("NFC", title or "Chat"), "to": to.get(chat) or to.get(room.removeprefix("archive:")), "last":
        {"id": ident,"ts": ts,"sender": sender,"me": bool(me),"body": body,"preview": True}}
        for chat,network,title,room,ident,ts,sender,me,body in rows if not (room in seen or seen.add(room))]

# /_archive/chats is several MB (every old mail thread): built once and kept, as JSON and gzip, until a message is
# added, a chat is linked here, or a minute passed (edits and other processes' changes). One build at a time.
CHATS = {"key": None, "at": 0.0, "raw": b"", "gz": b"", "tag": "", "gen": 0}
CHATS_LOCK = threading.Lock()


def chats_body(c):
    """(json bytes, gzip bytes, hash for the ETags) of {"chats": conversations(c)}, from CHATS while the archive is
    unchanged. A link bumps gen (chats_changed), also during a build, which then is not taken as current."""
    with CHATS_LOCK:
        key = (CHATS["gen"], *c.execute("SELECT (SELECT max(rowid) FROM messages), (SELECT count(*) FROM chats)").fetchone())
        if CHATS["key"] != key or time.monotonic() - CHATS["at"] > 60:
            raw = json.dumps({"chats": conversations(c)}, ensure_ascii=False).encode()
            CHATS.update(key=key, at=time.monotonic(), raw=raw, gz=gzip.compress(raw, 6, mtime=0), tag=hashlib.sha256(raw).hexdigest()[:32])
        return CHATS["raw"], CHATS["gz"], CHATS["tag"]


def chats_changed():
    CHATS["gen"] += 1  # without the lock: a build running now keeps the old gen in its key


def accepts_gzip(header):
    """Whether an Accept-Encoding header allows gzip: its own entry decides, else *; a q=0 refuses."""
    q = {}
    for part in (header or "").lower().split(","):
        coding, *params = [x.strip() for x in part.split(";")]
        try: q.setdefault(coding, float(next((p[2:] for p in params if p.startswith("q=")), "1")))
        except ValueError: q.setdefault(coding, 0.0)
    return next((q[k] for k in ("gzip", "x-gzip", "*") if k in q), 0.0) > 0


def etag_matches(values, tag):
    """If-None-Match (all its field lines; a list, weak tags, or *) names the weak tag W/"<opaque>". A field that is
    not a lone * or a list of quoted tags is ignored, as if it were not sent."""
    joined = ",".join(values or [])
    if joined.strip() == "*": return True
    if not ETAG_LIST.fullmatch(joined): return False
    return tag.removeprefix("W/") in re.findall(r'(?:W/)?("[^"]*")', joined)


ETAG_LIST = re.compile(r'[\s,]*(?:W/)?"[^"\x00-\x1f]*"(?:\s*,[\s,]*(?:W/)?"[^"\x00-\x1f]*")*[\s,]*')


def export(folder, c=None):
    """One text file per conversation: a Weft chat with everything the archive has of it (its messages on the
    homeserver, the bridge's older pages, the export below them), and each exported chat that has no Weft chat.
    Returns each conversation's (network folder, file name without .txt) by its room (or chat)."""
    c = c or db()
    out = {}
    os.makedirs(folder, mode=0o700, exist_ok=True)
    names = collections.Counter()
    convs = collections.defaultdict(lambda: {"network": None, "title": None, "chats": []})
    for chat, network, title, room, source in c.execute("SELECT * FROM chats").fetchall():
        conv = convs[room or chat]
        conv["chats"].append((chat, source))
        if source == "matrix" or not conv["network"]: conv["network"] = network
        if source == "matrix" and title or not conv["title"]: conv["title"] = title or conv["title"]
    caps = export_caps(c)
    for key, conv in convs.items():
        floor = caps.get(key, 2**62)
        rows = []
        for ch, src in conv["chats"]:
            if src == "history":
                rows += c.execute(f"""SELECT m.ts,m.sender,m.me,m.body FROM messages m JOIN chats c ON c.id=m.chat
                    WHERE m.chat=? AND {HISTORY_VISIBLE}""", (ch,)).fetchall()
                continue
            if src == "messenger-export":
                rows += c.execute(f"""SELECT m.ts,m.sender,m.me,m.body FROM messages m JOIN chats c ON c.id=m.chat
                    WHERE m.chat=? AND NOT {NATIVE_DUPLICATE}""", (ch,)).fetchall()
                continue
            cap = floor if src not in ("matrix", "bridge") else 2**62  # the homeserver and the bridge cover the export above it
            rows += c.execute("SELECT ts, sender, me, body FROM messages WHERE chat=? AND ts < ?", (ch, cap)).fetchall()
        if not rows: continue
        rows.sort(key=lambda r: r[0])
        # At most 150 bytes (file names allow 255), and no leading dot (a hidden file).
        name = re.sub(r'[/\\:*?"<>|\x00-\x1f]', "_", conv["title"] or key).lstrip(".") or "_"
        name = name.encode()[:150].decode(errors="ignore")
        names[(conv["network"], name)] += 1
        if names[(conv["network"], name)] > 1: name += f" ({names[(conv['network'], name)]})"
        os.makedirs(os.path.join(folder, conv["network"] or "iné"), mode=0o700, exist_ok=True)
        with open(os.path.join(folder, conv["network"] or "iné", f"{name}.txt"), "w") as f:
            for ts, sender, me, body in rows:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M', time.localtime(ts / 1000))}  {'ja' if me else sender}: {body}\n")
        out[key] = (conv["network"] or "iné", name)
    return out


def media_folders(folder, names, c):
    """médiá/<network>/<chat>/<date time>.<ext>: every stored attachment, as hard links of ./media (no extra disk)."""
    used = collections.Counter()
    for room, path, ts, _ in c.execute("""SELECT COALESCE(c.room, c.id), mm.path, min(m.ts), min(mm.position) FROM message_media mm
            JOIN messages m ON m.id = mm.message JOIN chats c ON c.id = m.chat
            WHERE mm.path IS NOT NULL GROUP BY 1, 2 ORDER BY 3, 4, 2"""):
        if room not in names or not os.path.isfile(os.path.join(MEDIA, path)): continue
        net, chat = names[room]
        stem = os.path.join(folder, net, chat, time.strftime("%Y-%m-%d %H.%M.%S", time.localtime(ts / 1000)))
        used[stem] += 1
        dest = stem + (f" ({used[stem]})" if used[stem] > 1 else "") + os.path.splitext(path)[1]
        for d in (folder, os.path.join(folder, net), os.path.dirname(dest)): os.makedirs(d, mode=0o700, exist_ok=True)
        os.link(os.path.join(MEDIA, path), dest)


README = """Kópia všetkých správ, ktoré má Weft (asus ~/matrix-spike/archive). Obnovuje sa každú hodinu,
keď je x270 zapnutý (weft-spravy.timer); naposledy {}. Čo tu zmeníš, ďalšia kópia prepíše.

správy/<sieť>/<chat>.txt   jeden rozhovor = jeden súbor, od najstaršej správy; hľadať: grep -ri "slovo" správy
archive.db                 to isté ako SQLite (tabuľky chats, messages; fulltext messages_fts)
médiá/<sieť>/<chat>/       fotky, videá a ostatné prílohy, pomenované dátumom a časom správy

Staršie správy z Messengera a Instagramu pribúdajú, keď ich vo Wefte doscrolluješ (alebo nájdeš cez Ctrl+K).
"""


def local(c=None):
    """./local: the text export and a consistent copy of archive.db, for x270 to pull (rsync)."""
    c = c or db()
    tmp, cur, old = (os.path.join(HERE, n) for n in ("local.new", "local", "local.old"))
    for d in (tmp, old): subprocess.run(["rm", "-rf", d], check=True)
    os.makedirs(tmp, mode=0o700)
    names = export(os.path.join(tmp, "správy"), c)
    # A chat the hour did not change keeps its old time: rsync on x270 then skips it, and x270's file search
    # (dsearch) does not reindex all ~8000 chats every hour.
    for root, _, files in os.walk(os.path.join(tmp, "správy")):
        for f in files:
            new = os.path.join(root, f); prev = os.path.join(cur, os.path.relpath(new, tmp))
            if os.path.isfile(prev) and filecmp.cmp(new, prev, shallow=False):
                st = os.stat(prev); os.utime(new, ns=(st.st_atime_ns, st.st_mtime_ns))
    with open(os.open(os.path.join(tmp, "ČÍTAJ.txt"), os.O_WRONLY | os.O_CREAT, 0o600), "w") as f:
        f.write(README.format(time.strftime("%d. %m. %Y %H:%M")))
    dst = sqlite3.connect(os.path.join(tmp, "archive.db"))
    c.backup(dst); dst.close()
    os.chmod(os.path.join(tmp, "archive.db"), 0o600)
    # Immutable, content-addressed attachments linked under their chat: no extra disk copy on each hourly refresh,
    # and rsync from x270 sends only new ones. rsync sends ordinary files, so x270's copy has no links back to asus.
    media_folders(os.path.join(tmp, "médiá"), names, c)
    # The previous copy stays as local.old until the next run: an rsync from x270 reading it meanwhile still finishes.
    if os.path.exists(cur): os.rename(cur, old)
    os.rename(tmp, cur)


# ---------------------------------------------------------------- older history through the bridges

class BridgeDown(Exception):
    """The bridge could not fetch now (Meta slow, bridge restarting): Weft asks again later."""


class StillEmpty(Exception):
    """Pages came back without a message to show yet (only reactions, calls, unsent messages): Weft asks again."""


# fetched.done: 0 still paging, 1 reached the chat's start, 2 the bridge cannot page this room (retried after a day)
GAVE_UP_RETRY = 86400
MAX_EMPTY = 20  # pages in a row with nothing to show (undecryptable stretch, only calls): the bridge gives up there
room_locks = collections.defaultdict(threading.Lock)


def bridge_page(network, room, owner, st):
    """One page older than what the archive has of the room, oldest first; None when the bridge cannot page it."""
    args = {"room": room, "user": owner, "cursor": st["cursor"] or ""}
    if st["before_id"]: args |= {"before_id": st["before_id"], "before_ts": st["before_ts"]}
    req = urllib.request.Request(f"{BRIDGES[network]}/history?{urllib.parse.urlencode(args)}",
                                 headers={"Authorization": f"Bearer {open(BRIDGE_TOKEN_FILE).read().strip()}"})
    try:
        with urllib.request.urlopen(req, timeout=100) as r: return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code in (404, 501): return None  # not a portal of it, or nothing bridged to start from
        raise BridgeDown(f"{network} {e.code}: {e.read()[:200].decode(errors='replace')}")
    except (OSError, ValueError) as e: raise BridgeDown(f"{network}: {e}")


def bridge_media(network, room, m):
    """message_media rows for the files the bridge saved into ./media/<network>/ while converting a page."""
    out = []
    for i, p in enumerate(m.get("parts") or []):
        f, kind = str(p.get("file") or ""), MEDIA_KINDS.get(p.get("kind"))
        if not f or not kind: continue
        rel = os.path.normpath(f)
        if not rel.startswith(network + "/") or ".." in rel.split("/") or not os.path.isfile(os.path.join(MEDIA, rel)): continue
        num = lambda k: p.get(k) if isinstance(p.get(k), int) and p.get(k) > 0 else None
        out.append((f"bridge:{room}:{m['id']}", i, rel, kind, str(p.get("mime") or "application/octet-stream"),
                    os.path.getsize(os.path.join(MEDIA, rel)), f"bridge:{rel}", num("w"), num("h"), num("duration"), None))
    return out


def part_body(p):
    if p["kind"] == "m.sticker": return "[Nálepka]"
    return KINDS.get(p["kind"]) or p["body"].strip()


def fetch_more(c, network, room, owner, has_older):
    """Pages back until a page brings messages (at most ten per call, MAX_EMPTY in a row across calls).
    False: the bridge has nothing more. has_older() tells whether another request fetched meanwhile."""
    with room_locks[room]:
        if has_older(): return True
        row = c.execute("SELECT cursor, before_id, before_ts, done, fails, failed_at, empty FROM fetched WHERE room=?", (room,)).fetchone()
        st = dict(zip(("cursor", "before_id", "before_ts", "done", "fails", "failed_at", "empty"), row or ("", None, None, 0, 0, None, 0)))
        if st["done"] == 1 or (st["done"] == 2 and time.time() - (st["failed_at"] or 0) < GAVE_UP_RETRY): return False
        if st["done"] == 2: st["empty"] = 0  # a day later: one more try
        for _ in range(10):
            try: page = bridge_page(network, room, owner, st)
            except BridgeDown:
                c.execute("""INSERT INTO fetched (room, fails, failed_at) VALUES (?, 1, ?) ON CONFLICT (room)
                             DO UPDATE SET fails = fails + 1, failed_at = excluded.failed_at""", (room, time.time()))
                c.commit()
                raise
            msgs = [m for m in (page or {}).get("messages", []) if m.get("id")]
            rows = [(f"bridge:{room}:{m['id']}", f"bridge:{room}", m["ts"], "" if m["me"] else m["sender"], int(m["me"]),
                     " ".join(b for b in map(part_body, m["parts"]) if b)) for m in msgs]
            rows = [r for r in rows if r[5]]
            c.execute("INSERT INTO chats VALUES (?, ?, NULL, ?, 'bridge') ON CONFLICT (id) DO NOTHING", (f"bridge:{room}", network, room))
            c.executemany("INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?)", rows)
            c.executemany(ADD_MEDIA, [r for m in msgs for r in bridge_media(network, room, m)])
            oldest = min(msgs, key=lambda m: m["ts"], default=None)
            moved = oldest is not None or (page or {}).get("cursor", "") not in ("", st["cursor"])
            advanced = (page or {}).get("cursor", "") not in ("", st["cursor"])  # Teams: only a new page cursor is progress
            st["empty"] = 0 if rows else st["empty"] + 1
            st |= {"cursor": (page or {}).get("cursor", "") or st["cursor"], "failed_at": None,
                   # Teams' bridge says has_more false only at the chat's start, also on an empty page (a chat no longer
                   # than what its room has), and its empty pages (system notes) go on while the cursor does; Meta's say it also when they cannot page
                   "done": 2 if page is None else (1 if not page.get("has_more") else 0 if advanced else 2) if network in HISTORY_AHEAD
                           else 2 if not moved or st["empty"] >= MAX_EMPTY else 0 if page.get("has_more") else 1}
            if st["done"] == 2: st["failed_at"] = time.time()
            if oldest: st |= {"before_id": oldest["id"], "before_ts": oldest["ts"]}
            c.execute("""INSERT INTO fetched VALUES (:room, :cursor, :before_id, :before_ts, :done, 0, :failed_at, :empty) ON CONFLICT (room)
                         DO UPDATE SET cursor=excluded.cursor, before_id=excluded.before_id, before_ts=excluded.before_ts,
                         done=excluded.done, fails=0, failed_at=excluded.failed_at, empty=excluded.empty""", st | {"room": room})
            c.commit()
            if rows: return True
            if st["done"]: return False
        raise StillEmpty()


def history_ahead(network, log=print):
    """Every room of the network paged back to its chat's start now, so Ctrl+K finds all of it (archive.py history)."""
    if network not in HISTORY_AHEAD: sys.exit(f"history: only {', '.join(sorted(HISTORY_AHEAD))}")
    token = login()
    mirror(token, log)  # rooms the bridge made since the last hourly copy
    owner = call("GET", "/_matrix/client/v3/account/whoami", token=token)["user_id"]
    c = db()
    rooms = [r for (r,) in c.execute("SELECT id FROM chats WHERE source = 'matrix' AND network = ? ORDER BY id", (network,))]
    count = lambda room: c.execute("SELECT count(*) FROM messages WHERE chat = ?", (f"bridge:{room}",)).fetchone()[0]
    for n, room in enumerate(rooms, 1):
        downs = 0
        # asked now: a room held after a failed or empty page (a day, six hours) is tried again
        c.execute("""UPDATE fetched SET done = CASE done WHEN 2 THEN 0 ELSE done END, empty = CASE done WHEN 2 THEN 0 ELSE empty END,
                     fails = 0, failed_at = NULL WHERE room = ? AND done != 1""", (room,)); c.commit()
        while (st := bridge_state(c, room)) and not st[1]:
            try: fetch_more(c, network, room, owner, lambda: False)
            except StillEmpty: continue
            except BridgeDown as e:
                downs += 1
                log(f"history: {room}: {e}")
                if downs >= 3: break
                time.sleep(60)
        log(f"history: {n}/{len(rooms)} {room}: {count(room)} older messages")


def bridge_state(c, room):
    """(network, done, reached_start) for a room a bridge can page back, else None. done also covers a room the bridge
    gave up on (for a day) and one resting six hours after three failed fetches in a row; there the exports fill in
    below what was fetched, with the note where they end."""
    row = c.execute("SELECT network FROM chats WHERE id=? AND source='matrix'", (room,)).fetchone()
    if not row or row[0] not in BRIDGES or not os.path.exists(BRIDGE_TOKEN_FILE): return None
    st = c.execute("SELECT done, fails, failed_at FROM fetched WHERE room=?", (room,)).fetchone()
    done, fails, failed_at = st or (0, 0, None)
    age = time.time() - (failed_at or 0)
    resting = fails >= 3 and age < 6 * 3600
    return row[0], done == 1 or (done == 2 and age < GAVE_UP_RETRY) or resting, done == 1


# Meta's bridges by network: their database and the localpart prefix of their ghosts.
META_GHOSTS = {"instagram": "instagram", "messenger": "facebook"}


def room_people(c, room, spike=SPIKE):
    """GET /_archive/rooms/{room}/people: {mxid: {name, handle}} for the people of a Messenger or Instagram room, read
    from the bridge's own database (read-only, nothing asks Meta): its name and username for each ghost. A ghost Meta
    never named (a group member Karchi does not follow) gets the name that Karchi's export of the chat gives the
    messages sent at the very same millisecond as that ghost's, when they all agree on one name."""
    row = c.execute("SELECT network FROM chats WHERE id=? AND source='matrix'", (room,)).fetchone()
    prefix = META_GHOSTS.get(row[0]) if row else None
    path = os.path.join(spike, row[0], "bridge.db") if prefix else ""
    if not prefix or not os.path.exists(path): return {}
    b = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
    try:
        portal = b.execute("SELECT id FROM portal WHERE mxid=?", (room,)).fetchone()
        users = [u for (u,) in b.execute("SELECT user_id FROM mx_user_profile WHERE room_id=? AND membership='join'", (room,))]
        out, unnamed = {}, []
        for user in users:
            m = re.fullmatch(rf"@{prefix}_(\d+):.+", user)
            g = m and b.execute("SELECT name, metadata FROM ghost WHERE id=?", (m.group(1),)).fetchone()
            if not g: continue
            try: handle = (json.loads(g[1] or "{}") or {}).get("username") or ""
            except ValueError: handle = ""
            if g[0] or handle: out[user] = {"name": g[0], "handle": handle}
            if not g[0] and portal: unnamed.append((user, m.group(1)))
        taken, found = {p["name"] for p in out.values() if p["name"]}, {}
        for user, ghost in unnamed:
            stamps = [ts // 1_000_000 for (ts,) in b.execute("""SELECT DISTINCT timestamp FROM message WHERE room_id=? AND sender_id=?
                                                                ORDER BY timestamp DESC LIMIT 200""", (portal[0], ghost))]
            if not stamps: continue
            names = {s for (s,) in c.execute(f"""SELECT DISTINCT m.sender FROM messages m JOIN chats c ON c.id = m.chat
                WHERE c.room = ? AND c.source NOT IN ('matrix', 'bridge') AND m.me = 0
                  AND m.ts IN ({','.join('?' * len(stamps))})""", (room, *stamps))}
            if len(names) == 1 and not names & taken: found[user] = names.pop()
        # One export name for two ghosts (their messages in the same millisecond) names neither.
        for user, name in found.items():
            if list(found.values()).count(name) == 1: out.setdefault(user, {"name": "", "handle": ""})["name"] = name
        return out
    finally: b.close()


# ---------------------------------------------------------------- the gallery

def room_media(c, room, kind=None):
    """A chat's photos and videos, newest first: the homeserver's, the bridge's older pages and the exports. An exported
    attachment within 1.5 s of one the homeserver or the bridge has is the same one: it counts once."""
    rows = c.execute("""SELECT mm.rowid, m.id, m.ts, m.sender, m.me, m.body, mm.kind, mm.w, mm.h, mm.duration, c.source
        FROM chats c JOIN messages m ON m.chat = c.id JOIN message_media mm ON mm.message = m.id
        WHERE COALESCE(c.room, 'archive:' || c.id) = ? AND mm.kind IN ('image', 'video')
          AND (mm.path IS NOT NULL OR mm.original_uri LIKE 'mxc://%')""", (room,)).fetchall()
    native = sorted(r[2] for r in rows if r[10] in ("matrix", "bridge"))
    def dup(ts):
        i = __import__("bisect").bisect_left(native, ts - 1500)
        return i < len(native) and native[i] <= ts + 1500
    rows = [r for r in rows if (r[10] in ("matrix", "bridge") or not dup(r[2])) and (not kind or r[6] == kind)]
    rows.sort(key=lambda r: (r[2], r[0]), reverse=True)
    return [{"id": i, "msg": mid, "ts": ts, "sender": "" if me else sender, "me": bool(me), "body": body, "kind": k,
             "w": w, "h": h, "dur": dur} for i, mid, ts, sender, me, body, k, w, h, dur, _ in rows]


def month_counts(items):
    """[["2026-10", 37], ...] newest first, in asus's time zone (Karchi's)."""
    out = []
    for it in items:
        mon = time.strftime("%Y-%m", time.localtime(it["ts"] / 1000))
        if out and out[-1][0] == mon: out[-1][1] += 1
        else: out.append([mon, 1])
    return out


# ---------------------------------------------------------------- what a person and Karchi wrote each other

STATS_REPLY_GAP = 24 * 3600_000  # a later answer is a new conversation, not a reply
STATS_MONTHS = 24
mirrored_at = {}  # room -> time.monotonic() of its last mirror_room for /stats


def room_stats(c, rooms, today=None):
    """GET /_archive/stats?room=..: what Karchi and the person of these rooms (one person's chats, merged) wrote each
    other over the whole history the archive has: counts, the first message, the longest run of days with a message,
    the median time each side takes to answer (gaps under a day) and STATS_MONTHS months of counts, oldest first.
    Days and months are asus's time zone (Karchi's). An exported message also on the homeserver or among the bridge's
    pages counts once, as in the chat itself: history unless mapped to a native message (HISTORY_VISIBLE), Messenger's
    export unless the same message is native (NATIVE_DUPLICATE), other exports only below the room's first native one."""
    marks = ",".join("?" * len(rooms))
    rows = c.execute(f"""SELECT m.ts, m.me FROM messages m JOIN chats c ON c.id = m.chat
        WHERE COALESCE(c.room, 'archive:' || c.id) IN ({marks}) AND {HISTORY_VISIBLE}
          AND (c.source IN ('matrix', 'bridge', 'history')
               OR (c.source = 'messenger-export' AND NOT {NATIVE_DUPLICATE})
               OR (c.source != 'messenger-export' AND m.ts < COALESCE((SELECT min(n.ts) FROM messages n JOIN chats nc ON nc.id = n.chat
                                   WHERE nc.room = c.room AND nc.source IN ('matrix', 'bridge')), 1e18)))
        ORDER BY m.ts""", rooms).fetchall()
    mine = sum(me for _, me in rows)
    days, gaps, prev = set(), {0: [], 1: []}, None
    months = collections.Counter()
    for ts, me in rows:
        t = time.localtime(ts / 1000)
        days.add(datetime.date(t.tm_year, t.tm_mon, t.tm_mday))
        months[f"{t.tm_year:04d}-{t.tm_mon:02d}"] += 1
        if prev and prev[1] != me and 0 <= ts - prev[0] < STATS_REPLY_GAP: gaps[me].append(ts - prev[0])
        prev = (ts, me)
    streak = run = 0
    last = None
    for d in sorted(days):
        run = run + 1 if last and (d - last).days == 1 else 1
        streak, last = max(streak, run), d
    median = lambda xs: statistics.median(xs) if xs else None
    today = today or datetime.date.today()
    y, mo, span = today.year, today.month, []
    for _ in range(STATS_MONTHS):
        span.append(f"{y:04d}-{mo:02d}")
        y, mo = (y, mo - 1) if mo > 1 else (y - 1, 12)
    return {"total": len(rows), "me": mine, "them": len(rows) - mine, "first": rows[0][0] if rows else None,
            "streak": streak, "reply": {"them": median(gaps[0]), "me": median(gaps[1])},
            "months": [[k, months.get(k, 0)] for k in reversed(span)]}


def fresh_rooms(rooms, token, me, log=print):
    """Copies the homeserver's newest messages of these rooms first (at most once a minute each), so the counts
    include what came since the hourly mirror. A room that fails keeps what the archive has."""
    c = db()
    try:
        for room in rooms:
            if not room.startswith("!") or time.monotonic() - mirrored_at.get(room, -1e9) < 60: continue
            mirrored_at[room] = time.monotonic()
            try: mirror_room(c, token, me, room)
            except Exception as e:
                c.rollback()
                log(f"stats: {room} not mirrored: {e}")
    finally: c.close()


thumb_slots = threading.Semaphore(1)  # Keep full-size decode buffers out of concurrent HTTP requests.
THUMB = 320


def square(img_bytes=None, path=None, scaled=0):
    """A THUMB-px square JPEG of a picture (center crop); with `scaled`, the whole picture within that many px."""
    from PIL import Image, ImageOps
    import io
    with Image.open(path or io.BytesIO(img_bytes)) as im:
        im.draft("RGB", (max(THUMB, scaled) * 2,) * 2)  # JPEG decodes at a fraction of its size: fast and small
        # PNG/TIFF do not support JPEG's reduced-resolution decode. Never let one
        # large attachment exhaust the shared archive service; its original stays downloadable.
        if im.width * im.height > 4_000_000:
            raise ValueError("Image too large for bounded thumbnail decoding")
        im = ImageOps.exif_transpose(im)
        if im.mode not in ("RGB", "L"): im = im.convert("RGBA").convert("RGB") if im.mode != "P" else im.convert("RGB")
        out = io.BytesIO()
        if scaled: im.thumbnail((scaled, scaled), Image.Resampling.BILINEAR)
        (im if scaled else ImageOps.fit(im, (THUMB, THUMB), Image.Resampling.BILINEAR)).save(out, "JPEG", quality=78)
        return out.getvalue()


def video_frame(path):
    """A frame near the start of a video, as JPEG bytes ('' when ffmpeg finds none)."""
    for at in ("1", "0"):
        r = subprocess.run(["ffmpeg", "-v", "error", "-ss", at, "-i", path, "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
                           capture_output=True, timeout=60)
        if r.stdout: return r.stdout
    return b""


def hs_get(path, token, limit=MAX_MEDIA):
    req = urllib.request.Request(HS + path, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read(limit + 1)
        if len(data) > limit: raise ValueError("too large")
        return data


def mxc_path(mxc, thumb=False):
    server, mid = mxc[6:].split("/", 1)
    return (f"/_matrix/client/v1/media/thumbnail/{q(server)}/{q(mid)}?width={THUMB}&height={THUMB}&method=crop" if thumb
            else f"/_matrix/client/v1/media/download/{q(server)}/{q(mid)}")


def thumbnail(row, token, scaled=0):
    """JPEG bytes of a media row's square thumbnail (with `scaled`: the whole picture within that many px, for a
    message's bubble), made once and cached in ./thumbs."""
    path, kind, uri, thumb = row
    name = os.path.join(THUMBS, hashlib.sha1(f"{path}|{uri}".encode()).hexdigest() + (f"-{scaled}" if scaled else "") + ".jpg")
    try:
        with open(name, "rb") as f: return f.read()
    except FileNotFoundError: pass
    pic = lambda data=None, path=None: square(data, path, scaled)
    with thumb_slots:
        if path:
            full = os.path.join(MEDIA, path)
            data = pic(video_frame(full)) if kind == "video" else pic(path=full)
        elif kind == "image" or thumb:
            data = pic(hs_get(mxc_path(thumb or uri, thumb=True), token))
        else:  # a homeserver video without a thumbnail (WhatsApp): its first frame
            import tempfile
            with tempfile.NamedTemporaryFile(dir=THUMBS, prefix=".video-") as f:
                f.write(hs_get(mxc_path(uri), token)); f.flush()
                data = pic(video_frame(f.name))
    os.makedirs(THUMBS, mode=0o700, exist_ok=True)
    tmp = f"{name}.{threading.get_ident()}"
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as f: f.write(data)
    os.replace(tmp, name)
    return data


def cache_matrix_media(token, log=print):
    """The homeserver's photos and videos copied into ./media/matrix (from the local homeserver, never from a network),
    so x270's copy has them too and the gallery reads them from disk."""
    c = db()
    rows = c.execute("""SELECT rowid, original_uri, mime FROM message_media WHERE path IS NULL AND original_uri LIKE 'mxc://%'
        AND kind IN ('image', 'video') AND (bytes IS NULL OR bytes <= ?)""", (MAX_MEDIA,)).fetchall()
    folder, got, bad = os.path.join(MEDIA, "matrix"), 0, 0
    os.makedirs(folder, mode=0o700, exist_ok=True)
    for rowid, uri, mime in rows:
        try: data = hs_get(mxc_path(uri), token)
        except (OSError, ValueError): bad += 1; continue
        ext = {"image/jpeg": ".jpg", "video/quicktime": ".mov"}.get(mime) or __import__("mimetypes").guess_extension(mime) or ""
        dest = os.path.join(folder, hashlib.sha256(data).hexdigest() + ext)
        if not os.path.exists(dest):
            tmp = f"{dest}.part"
            with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as f: f.write(data)
            os.replace(tmp, dest)
        c.execute("UPDATE message_media SET path=?, bytes=? WHERE rowid=?", (os.path.relpath(dest, MEDIA), len(data), rowid))
        c.commit()
        got += 1
    if rows: log(f"matrix media: {got} copied, {bad} not on the homeserver")
    c.close()


def warm_thumbs(log=print):
    """`archive.py thumbs`: every stored photo's and video's size, length and thumbnail made ahead, so the gallery never
    waits on one. An .mp4 without a picture (a voice message in Messenger's export) becomes audio."""
    c = db()
    rows = c.execute("""SELECT rowid, path, kind, original_uri, thumb, w, duration FROM message_media
        WHERE kind IN ('image','video') AND path IS NOT NULL""").fetchall()
    bad = 0
    for i, (rowid, path, kind, uri, thumb, w, dur) in enumerate(rows):
        if w is None or (kind == "video" and dur is None):
            mime, w, h, dur = probe(path, kind)
            if kind == "video" and not w: kind = "audio"
            c.execute("UPDATE message_media SET kind=?, w=?, h=?, duration=COALESCE(?, duration) WHERE rowid=?", (kind, w, h, dur, rowid))
            c.commit()
            if kind == "audio": continue
        try: thumbnail((path, kind, uri, thumb), None)
        except Exception as e: bad += 1; log(f"thumbs: {path}: {e}")
        if i % 500 == 499: log(f"thumbs: {i + 1}/{len(rows)}")
    log(f"thumbs: {len(rows)} files, {bad} without a thumbnail")


def fix_sizes(log=print):
    """`archive.py sizes`: stored photos and videos whose width and height were read before probe() knew a phone's
    turned ones, set upright, so Weft's bubble has the picture's own shape. Changes only w and h."""
    c = db()
    rows = c.execute("SELECT rowid, path, kind, w, h FROM message_media WHERE kind IN ('image','video') AND path IS NOT NULL AND w IS NOT NULL").fetchall()
    fixed = 0
    for rowid, path, kind, w, h in rows:
        _, nw, nh, _ = probe(path, kind)
        if nw and nh and (nw, nh) == (h, w) and w != h:
            c.execute("UPDATE message_media SET w=?, h=? WHERE rowid=?", (nw, nh, rowid))
            c.commit()  # one at a time: the running archive keeps writing meanwhile
            fixed += 1
    c.close()
    log(f"sizes: {len(rows)} files, {fixed} turned upright")


# ---------------------------------------------------------------- HTTP for Weft

# ---------------------------------------------------------------- read receipts

# Matrix keeps only each person's newest read receipt: when they saw an older message is gone once they read on.
# The archive keeps every receipt it sees, so Weft can say when each of Karchi's messages was seen.
RECEIPT_FILTER = json.dumps({"presence": {"types": []}, "account_data": {"types": []}, "room": {
    "timeline": {"limit": 0}, "state": {"types": []}, "account_data": {"types": []}, "ephemeral": {"types": ["m.receipt"]}}})


def store_receipts(c, token, me, rooms, base):
    """The m.read receipts of others in one sync response; returns how many were new."""
    new = 0
    for room, data in rooms.items():
        for ev in (data.get("ephemeral") or {}).get("events") or []:
            if ev.get("type") != "m.receipt": continue
            for event, kinds in (ev.get("content") or {}).items():
                reads = kinds.get("m.read") if isinstance(kinds, dict) else None
                for user, r in (reads or {}).items():
                    if user == me or not isinstance(r, dict) or not r.get("ts"): continue
                    if c.execute("SELECT 1 FROM receipts WHERE room=? AND user=? AND event=?", (room, user, event)).fetchone(): continue
                    try: at = call("GET", f"/_matrix/client/v3/rooms/{q(room)}/event/{q(event)}", token=token, timeout=30).get("origin_server_ts")
                    except Exception: at = None
                    c.execute("INSERT OR IGNORE INTO receipts VALUES (?,?,?,?,?,?)", (room, user, event, int(r["ts"]), at, base))
                    new += 1
    c.commit()
    return new


def watch_receipts(token, me):
    """Follows the homeserver's receipts for good. A sync after a start or an error brings only each person's newest
    receipt, so its rows are base: what moved before them is unknown."""
    c, base = db(), 1
    row = c.execute("SELECT value FROM settings WHERE key='receipts_since'").fetchone()
    since = row[0] if row else None
    while True:
        try:
            s = call("GET", f"/_matrix/client/v3/sync?timeout=30000&filter={q(RECEIPT_FILTER)}" + (f"&since={q(since)}" if since else ""),
                     token=token, timeout=90)
            new = store_receipts(c, token, me, (s.get("rooms") or {}).get("join") or {}, base)
            if base: print("receipts: following,", new, "new", flush=True)
            since, base = s["next_batch"], 0
            c.execute("INSERT OR REPLACE INTO settings VALUES ('receipts_since', ?)", (since,))
            c.commit()
        except Exception as e:
            print("receipts:", type(e).__name__, e, flush=True)
            base = 1
            time.sleep(30)


def room_receipts(c, room, since):
    """Receipts on messages from `since` on, and each person's last one before it (where their reading stood)."""
    rows = c.execute("""SELECT user, event, ts, event_ts, base FROM receipts WHERE room = ? AND (event_ts IS NULL OR event_ts >= ?)
        UNION SELECT user, event, max(ts), event_ts, base FROM receipts WHERE room = ? AND event_ts < ? GROUP BY user
        ORDER BY 3""", (room, since, room, since)).fetchall()
    return [{"user": u, "event": e, "ts": ts, "event_ts": ets, "base": bool(b)} for u, e, ts, ets, b in rows]


# ---------------------------------------------------------------- moving over from Beeper Desktop

# Weft's Settings → Účty → „Prejsť z Beeperu“ sends Beeper Desktop's index.db (and its -wal beside it) in pieces;
# import_beeper.py first only counts (plan), then imports. An upload is a copy of someone's chats: it is deleted
# after the import, on „Zrušiť“, when a new one starts and after a day.
BEEPER_UPLOADS = os.path.join(os.path.dirname(os.path.abspath(DB)), "beeper-uploads")
BEEPER_FILES = {"index.db": b"SQLite format 3\0", "index.db-wal": (b"\x37\x7f\x06\x82", b"\x37\x7f\x06\x83")}
BEEPER_MAX = 8 << 30  # per file; Beeper's index.db holds the decrypted messages and their search index
BEEPER_PIECE = 64 << 20
BEEPER_MEDIA = re.compile(r"media/([A-Za-z0-9_-][A-Za-z0-9._-]{0,199})")  # a file of Beeper's media cache, by its id
BEEPER_SPARE = int(os.environ.get("ARCHIVE_BEEPER_SPARE", str(2 << 30)))  # disk an upload must leave free
beeper_lock = threading.Lock()  # one count or import at a time: both read the whole archive
# Uploads' folders: a piece is written and a folder deleted under it, so a piece arriving while „Zrušiť“ deletes its
# upload never brings the folder back.
beeper_files = threading.RLock()
beeper_busy = collections.Counter()  # uploads a count or import reads now (marked under beeper_files): never pruned
beeper_planned = {}  # upload folder -> what its count said the new rows take in archive.db


def beeper_folder(upload):
    if not isinstance(upload, str) or not re.fullmatch(r"[0-9a-f]{32}", upload): return None
    path = os.path.join(BEEPER_UPLOADS, upload)
    return path if os.path.isdir(path) else None


def beeper_forget(folder):
    beeper_planned.pop(folder, None)
    with beeper_files: shutil.rmtree(folder, ignore_errors=True)


def beeper_size(path):
    """A file's size, 0 once it is gone (SQLite deletes a -wal when its last connection closes)."""
    try: return os.path.getsize(path)
    except OSError: return 0


def beeper_bytes(folder):
    return sum(beeper_size(os.path.join(d, f)) for d, _, fs in os.walk(folder) for f in fs)


def beeper_prune(keep=None, everything=False):
    try: names = os.listdir(BEEPER_UPLOADS)
    except FileNotFoundError: return
    for name in names:
        path = os.path.join(BEEPER_UPLOADS, name)
        try: old = time.time() - os.path.getmtime(path) > 86400
        except FileNotFoundError: continue
        with beeper_files:
            if name != keep and not beeper_busy[path] and (everything or old): beeper_forget(path)


def beeper_sweep():
    """An upload left behind (a closed tab) goes after a day even when no one moves from Beeper again."""
    while True:
        try: beeper_prune()
        except OSError as e: print("archive: beeper uploads not pruned:", e, flush=True)
        time.sleep(3600)


def beeper_piece(upload, name, offset, stream, length):
    """Write one piece of an uploaded file at its end. Returns (upload, size) or raises ValueError (bad piece) or
    LookupError (no such upload) or IndexError (the offset is not the file's end: the size there lets it resume)
    or OSError (the disk would get too full). A photo or file of Beeper's cache is media/<id>, after index.db."""
    media = BEEPER_MEDIA.fullmatch(name)
    if not (name in BEEPER_FILES or media) or not 0 < length <= BEEPER_PIECE or offset < 0 or offset + length > BEEPER_MAX:
        raise ValueError("not a piece of Beeper's index.db")
    if upload is None and (name != "index.db" or offset): raise ValueError("an upload starts with index.db")
    os.makedirs(BEEPER_UPLOADS, mode=0o700, exist_ok=True)
    if shutil.disk_usage(BEEPER_UPLOADS).free < length + BEEPER_SPARE: raise OSError("the server's disk is nearly full")
    data = stream.read(length)
    if len(data) != length: raise ValueError("the piece ended early")
    if offset == 0 and not media and not data.startswith(BEEPER_FILES[name]):
        raise ValueError("not Beeper's index.db" if name == "index.db" else "not a SQLite -wal file")
    with beeper_files:
        if upload is None:
            upload = os.urandom(16).hex()
            os.makedirs(os.path.join(BEEPER_UPLOADS, upload), mode=0o700)
            os.chmod(BEEPER_UPLOADS, 0o700)
            beeper_prune(keep=upload, everything=True)  # one person's archive, one move at a time
        folder = beeper_folder(upload)
        if not folder: raise LookupError(upload)
        if media:  # where import_beeper.py reads the cache: the data folder's media/local.beeper.com/
            os.makedirs(os.path.join(folder, "media", "local.beeper.com"), mode=0o700, exist_ok=True)
            path = os.path.join(folder, "media", "local.beeper.com", media[1])
        else: path = os.path.join(folder, name)
        have = os.path.getsize(path) if os.path.exists(path) else 0
        if offset != have: raise IndexError(have)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try: os.write(fd, data)
        finally: os.close(fd)
        os.utime(folder)
        return upload, have + length


BEEPER_MEMORY = os.environ.get("ARCHIVE_BEEPER_MEMORY", "2G")
_scope = []


def beeper_scope():
    """systemd-run's prefix that gives the importer its own scope and memory limit, outside this service's cgroup
    (MemoryMax=384M with OOMPolicy=stop: an importer running out of memory inside it would stop the archive). Empty
    where no user systemd answers."""
    if _scope: return _scope[0]
    prefix = ["systemd-run", "--user", "--scope", "--quiet", "--collect", "-p", f"MemoryMax={BEEPER_MEMORY}"]
    try: ok = subprocess.run(prefix + ["true"], capture_output=True, timeout=30).returncode == 0
    except (OSError, subprocess.SubprocessError): ok = False
    if not ok:  # asked again next time: user systemd may answer later
        print("archive: no systemd scope for the Beeper import, it runs inside this service's memory limit", flush=True)
        return []
    _scope.append(prefix)
    return prefix


def beeper_run(folder, dry_run):
    """import_beeper.py in its own process and memory limit: it reads the whole archive and index.db, and running out
    of memory there must not end the archive service."""
    cmd = beeper_scope() + [sys.executable, os.path.join(HERE, "import_beeper.py"), folder, "--db", DB, "--spike", SPIKE,
                            "--media", "--media-dir", MEDIA]  # the photos and files sent along, if any
    out = subprocess.run(cmd + (["--dry-run"] if dry_run else []), capture_output=True, text=True, timeout=3600)
    if out.returncode:
        last = (out.stderr.strip().splitlines() or ["the import stopped"])[-1]
        print("archive: beeper import failed:", last[:300], flush=True)
        if out.returncode in (-9, 137): raise RuntimeError("the import ran out of memory")  # its scope's MemoryMax
        raise RuntimeError("not Beeper's index.db" if "no such table" in last or "not a database" in last else "the import stopped")
    return json.loads(out.stdout)


class Api(BaseHTTPRequestHandler):
    tokens = {}  # access token -> time it was last confirmed as Karchi's; a minute, so a logout counts soon
    owner = None
    hs_token = None  # the archive's own login, for attachments on the homeserver

    def log_message(self, *a): pass

    def send(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def karchi(self):
        token = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
        if not token: return False
        now = time.time()
        for t in [t for t, at in list(self.tokens.items()) if now - at >= 60]: self.tokens.pop(t, None)  # other threads prune too
        if token in self.tokens: return True
        try: who = call("GET", "/_matrix/client/v3/account/whoami", token=token, timeout=10)["user_id"]
        except Exception: return False
        if Api.owner is None and OWNER_FILE: claim_owner(who)
        if who != Api.owner: return False
        self.tokens[token] = now
        return True

    def send_bytes(self, data, mime):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, max-age=31536000, immutable")
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path, mime, name=""):
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Type", mime)
        if name: self.send_header("Content-Disposition", f"inline; filename*=UTF-8''{q(name)}")
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "private, max-age=31536000, immutable")
        self.end_headers()
        with open(path, "rb") as f: shutil.copyfileobj(f, self.wfile, 1 << 20)

    def gallery(self, room, args):
        """GET /_archive/rooms/{room}/media?kind=image|video&before=<ts>&id=<id>&limit=: newest first; the first page
        (no before) also has every month's count and the total, so Weft can lay the whole gallery out at once."""
        try:
            limit = max(1, min(2000, int(args.get("limit", 500))))
            before, after_id = int(args.get("before", 2**62)), int(args.get("id", 2**62))
        except ValueError: return self.send(400, {"error": "before, id and limit are numbers"})
        kind = args.get("kind") if args.get("kind") in ("image", "video") else None
        c = db()
        try: items = room_media(c, room, kind)
        finally: c.close()
        page = [it for it in items if (it["ts"], it["id"]) < (before, after_id)][:limit]
        body = {"items": page}
        if "before" not in args: body |= {"total": len(items), "months": month_counts(items)}
        self.send(200, body)

    def media_file(self, ident, args):
        """GET /_archive/media/{id}?w=320: the square thumbnail; ?w=480&fit=scale the whole picture within 480 px (a
        message's bubble); without w the original."""
        c = db()
        try: row = c.execute("SELECT path, kind, original_uri, thumb, mime FROM message_media WHERE rowid=?", (ident,)).fetchone()
        finally: c.close()
        if not row or not (row[0] or row[2].startswith("mxc://") or DISCORD_CDN.fullmatch(row[2])): return self.send(404, {"error": "no such file"})
        path, kind, uri, thumb, mime = row
        try:
            if not path and DISCORD_CDN.fullmatch(uri): path = fetch_discord_file(ident, uri)
            if args.get("w"):
                if kind == "file" and mime.startswith("video/"): kind = "video"  # a video kept as a file still has a frame
                scaled = 480 if args.get("fit") == "scale" else 0
                return self.send_bytes(thumbnail((path, kind, uri, thumb), Api.hs_token, scaled), "image/jpeg")
            if path: return self.send_file(os.path.join(MEDIA, path), mime, media_name(uri, path))
            return self.send_bytes(hs_get(mxc_path(uri), Api.hs_token), mime)
        except FileNotFoundError: return self.send(404, {"error": "file is gone"})
        except (OSError, ValueError, subprocess.SubprocessError, urllib.error.URLError) as e:
            print("archive: media", ident, type(e).__name__, e, flush=True)
            return self.send(502, {"error": "cannot read the file"})
        except Exception as e:  # Pillow's own errors for a damaged picture
            print("archive: media", ident, type(e).__name__, e, flush=True)
            return self.send(415, {"error": "not a picture"})

    def do_POST(self):
        """POST /_archive/chats/link {chat, room}: Weft found the person of an old chat on a bridge; the
        conversation's history then belongs to that room. Karchi must be in the room. An old Discord chat goes only
        to the bridge's room of its own channel."""
        url = urllib.parse.urlparse(self.path)
        path = url.path
        if path != "/_archive/chats/link" and not path.startswith("/_archive/beeper/"):
            return self.send(404, {"error": "not found"})
        if not self.karchi(): return self.send(401, {"error": "not Karchi"})
        if path.startswith("/_archive/beeper/"): return self.beeper(path.removeprefix("/_archive/beeper/"), dict(urllib.parse.parse_qsl(url.query)))
        token = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 65536)) or b"{}")
            chat, room = str(body["chat"]), str(body["room"])
        except (ValueError, KeyError, TypeError): return self.send(400, {"error": "chat and room are needed"})
        if not chat.startswith("archive:") or not re.fullmatch(r"![^/:\s]+(?::[^/\s]+)?", room):
            return self.send(400, {"error": "not an archived chat and a room"})
        try: joined = call("GET", "/_matrix/client/v3/joined_rooms", token=token, timeout=15).get("joined_rooms", [])
        except Exception: return self.send(502, {"error": "the homeserver did not answer"})
        if room not in joined: return self.send(403, {"error": "Karchi is not in that room"})
        # The room's own m.bridge: a new Discord portal the archive has not mirrored yet counts as Discord too.
        try: bridged = [(ev.get("content") or {}).get("protocol", {}).get("id") for ev in call("GET", f"/_matrix/client/v3/rooms/{q(room)}/state", token=token, timeout=15)
                        if ev.get("type") in ("m.bridge", "uk.half-shot.bridge")]
        except Exception: return self.send(502, {"error": "the homeserver did not answer"})
        c = db()
        try:
            # The guard and the move in one write transaction: a join_chat in between cannot slip a chat along.
            c.execute("BEGIN IMMEDIATE")
            allowed = discord_allowed(c, chat, room, "discord" in [PROTOCOLS.get(x, x) for x in bridged])
            if not allowed:
                c.rollback()
                if allowed is None: return self.send(503, {"error": "the Discord bridge's database did not answer"})
                return self.send(409, {"error": "that room is another Discord chat"})
            ok = link_chat(c, chat, room)
            now = c.execute("SELECT room FROM chats WHERE id = ?", (chat.removeprefix("archive:"),)).fetchone()
        finally: c.close()
        if ok:
            chats_changed()  # the chat left the list of old conversations
            return self.send(200, {"linked": True})
        # Already linked (Weft in another window): say where, so that window opens the live room.
        if now and now[0] and not now[0].startswith("archive:"):
            return self.send(409, {"error": "already linked", "room": now[0]})
        return self.send(409, {"error": "already linked or not in the archive"})

    def beeper(self, what, args):
        """POST /_archive/beeper/upload?file=index.db|index.db-wal|media/<id>&offset=N[&upload=ID] with a piece as
        the body (without upload: a new one, from index.db's start) → {upload, size}; a wrong offset answers 409 with
        the size there, a nearly full disk 507. The count's media_wanted names the media files worth sending. POST /_archive/beeper/{plan,import,forget} {upload}: count only, import (backs up the archive first,
        then deletes the upload) or delete it."""
        beeper_prune()
        if what == "upload":
            try: offset, length = int(args.get("offset", "0")), int(self.headers.get("Content-Length") or 0)
            except ValueError: return self.send(400, {"error": "offset and length are numbers"})
            try: upload, size = beeper_piece(args.get("upload"), args.get("file", ""), offset, self.rfile, length)
            except ValueError as e: return self.send(400, {"error": str(e)})
            except IndexError as e: return self.send(409, {"error": "another offset", "size": e.args[0]})  # before LookupError, its base
            except LookupError: return self.send(404, {"error": "no such upload"})
            except OSError as e: return self.send(507, {"error": str(e)})
            return self.send(200, {"upload": upload, "size": size})
        if what not in ("plan", "import", "forget"): return self.send(404, {"error": "not found"})
        try: upload = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 4096)) or b"{}").get("upload")
        except (ValueError, AttributeError): return self.send(400, {"error": "upload is needed"})
        with beeper_files:  # marked as read before a prune (it looks under the same lock) can take it
            folder = beeper_folder(upload)
            if folder and what != "forget": beeper_busy[folder] += 1
        if not folder: return self.send(404, {"error": "no such upload"})
        if what == "forget":
            beeper_forget(folder)
            return self.send(200, {"forgotten": True})
        try:
            if not os.path.exists(os.path.join(folder, "index.db")): return self.send(400, {"error": "index.db is missing"})
            if not beeper_lock.acquire(blocking=False): return self.send(409, {"error": "another count or import is running"})
            try:
                # The import backs the archive up (every page, those still in its -wal too), copies the sent files
                # beside it and adds its rows (as the count said; without one, at most what was sent), first into the
                # -wal and then into archive.db: room for all, the spare left.
                if what == "import":
                    backup = beeper_size(DB) + beeper_size(DB + "-wal")
                    rows = beeper_planned.get(folder)
                    if rows is None: rows = sum(beeper_size(os.path.join(folder, n)) for n in BEEPER_FILES)
                    if shutil.disk_usage(os.path.dirname(os.path.abspath(DB))).free < backup + 2 * rows + beeper_bytes(os.path.join(folder, "media")) + BEEPER_SPARE:
                        return self.send(507, {"error": "the server's disk is nearly full"})
                report = beeper_run(folder, dry_run=what == "plan")
                if what == "plan": beeper_planned[folder] = sum(n.get("archive_bytes", 0) for n in report.get("networks", {}).values())
                if what == "import":
                    beeper_forget(folder)
                    chats_changed()
            except RuntimeError as e: return self.send(422 if "not Beeper" in str(e) else 500, {"error": str(e)})
            except subprocess.TimeoutExpired: return self.send(504, {"error": "the import took too long"})
            finally: beeper_lock.release()
        finally:
            with beeper_files:
                beeper_busy[folder] -= 1
                if beeper_busy[folder] <= 0: del beeper_busy[folder]
        return self.send(200, report)

    def discord(self, what, args):
        """GET /_archive/discord/{dms,channels,people}: read from the bridge's database and the archive only."""
        try: b = discord_weft.bridge_db()
        except sqlite3.Error: return self.send(503, {"error": "no Discord bridge"})
        c = db()
        try:
            if what == "channels": return self.send(200, {"channels": discord_weft.channels(b, Api.owner)})
            if what == "people":
                if not re.fullmatch(r"\d{1,25}", args.get("guild", "")): return self.send(400, {"error": "guild is needed"})
                return self.send(200, {"people": discord_weft.people(c, b, Api.owner, args["guild"], args.get("q", "")[:40])})
            account, _ = discord_weft.me(b, Api.owner)
            return self.send(200, {"me": account, "dms": discord_weft.dms(b, Api.owner, discord_weft.archive_titles(c, account))})
        except sqlite3.Error as e:
            print("archive: discord", what, type(e).__name__, e, flush=True)
            return self.send(503, {"error": "cannot read the Discord bridge"})
        finally: c.close(); b.close()

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        m = re.fullmatch(r"/_archive/rooms/([^/]+)/messages", url.path)
        g = re.fullmatch(r"/_archive/rooms/([^/]+)/media", url.path)
        f = re.fullmatch(r"/_archive/media/(\d+)", url.path)
        rc = re.fullmatch(r"/_archive/rooms/([^/]+)/receipts", url.path)
        pp = re.fullmatch(r"/_archive/rooms/([^/]+)/people", url.path)
        dc = url.path in ("/_archive/discord/dms", "/_archive/discord/channels", "/_archive/discord/people")
        if not (m or g or f or rc or pp or dc) and url.path not in ("/_archive/search", "/_archive/chats", "/_archive/stats"): return self.send(404, {"error": "not found"})
        if not self.karchi(): return self.send(401, {"error": "not Karchi"})
        if url.path == "/_archive/stats":
            rooms = list(dict.fromkeys(urllib.parse.parse_qs(url.query).get("room", [])))
            if not rooms: return self.send(400, {"error": "room=… missing"})
            fresh_rooms(rooms, Api.hs_token, Api.owner, lambda *a: print(*a, flush=True))
            c = db()
            try: return self.send(200, room_stats(c, rooms))
            finally: c.close()
        args = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        if dc: return self.discord(url.path.rsplit("/", 1)[1], args)
        if g: return self.gallery(urllib.parse.unquote(g.group(1)), args)
        if f: return self.media_file(int(f.group(1)), args)
        if rc:
            try: since = int(args.get("since", 0))
            except ValueError: return self.send(400, {"error": "since is a number"})
            c = db()
            try: return self.send(200, {"receipts": room_receipts(c, urllib.parse.unquote(rc.group(1)), since)})
            finally: c.close()
        if pp:
            c = db()
            try: return self.send(200, {"people": room_people(c, urllib.parse.unquote(pp.group(1)))})
            except sqlite3.Error as e:
                print("archive: people", type(e).__name__, e, flush=True)
                return self.send(503, {"error": "cannot read the bridge"})
            finally: c.close()
        if url.path == "/_archive/chats":
            c = db()
            try: raw, gz, sha = chats_body(c)
            finally: c.close()
            zipped = accepts_gzip(",".join(self.headers.get_all("Accept-Encoding") or []))
            tag = f'W/"{sha}"'  # weak: the gzip and plain lists are the same list, also when Caddy unzips it
            if etag_matches(self.headers.get_all("If-None-Match"), tag):  # Weft already has this list: nothing to parse again
                self.send_response(304)
                self.send_header("ETag", tag)
                self.send_header("Vary", "Accept-Encoding")
                return self.end_headers()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Vary", "Accept-Encoding")
            self.send_header("ETag", tag)
            if zipped: self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(gz if zipped else raw)))
            self.end_headers()
            return self.wfile.write(gz if zipped else raw)
        if not m:
            try: limit = max(1, min(500, int(args.get("limit", 100))))
            except ValueError: return self.send(400, {"error": "limit is a number"})
            c = db()
            try: return self.send(200, {"results": search(c, args.get("q", ""), limit)})
            finally: c.close()
        try:
            before = int(args.get("before", 2**62))
            after = int(args.get("after", 0))
            limit = max(1, min(500, int(args.get("limit", 200))))
        except ValueError: return self.send(400, {"error": "before, after and limit are numbers"})
        after_id = args.get("id", "")  # paging on: older than this archived message, also within the same ms
        room = urllib.parse.unquote(m.group(1))
        c = db()
        older = "(m.ts < ? OR (m.ts = ? AND m.id < ?))"
        page = lambda where, *a: c.execute(f"""SELECT m.id, m.ts, m.sender, m.me, m.body FROM messages m JOIN chats c ON c.id = m.chat
            WHERE COALESCE(c.room,'archive:'||c.id) = ? AND {HISTORY_VISIBLE} AND {where} AND {older}
            ORDER BY m.ts DESC, m.id DESC LIMIT ?""", (room, *a, before, before, after_id, limit)).fetchall()
        if args.get("local") == "1":
            # Overlay exported messages missing inside a loaded Matrix history page. This path
            # only reads SQLite: it must never ask a bridge for remote history.
            rows = page(f"(c.source='history' OR (c.source='messenger-export' AND NOT {NATIVE_DUPLICATE})) AND m.ts >= ?", after)
            extras = message_extras(c, [r[0] for r in rows])
            c.close()
            return self.send(200, {"messages": [{"id": i, "ts": ts, "sender": s, "me": bool(me), "body": b, **extras[i]}
                                                for i, ts, s, me, b in rows]})
        # Only what came from elsewhere: the room's own messages are on the homeserver already.
        state, until = bridge_state(c, room), None
        if state:
            # The bridge's pages run back without gaps from the room's first message. Exports only fill in below
            # the oldest one, once the bridge has nothing older (or is resting).
            floor = lambda: c.execute("""SELECT min(m.ts) FROM messages m JOIN chats c ON c.id = m.chat
                                         WHERE c.room = ? AND c.source = ?""", (room, "bridge")).fetchone()[0]
            # Weft pages on from an export row (it read exports while the bridge rested): stay in the exports.
            in_exports = bool(after_id) and not after_id.startswith("bridge:")
            # Once the bridge's pages (or the room's first message on the homeserver) reach the room's newest exported
            # message, the export has the rest: no more fetching.
            low = c.execute("""SELECT min(m.ts) FROM messages m JOIN chats c ON c.id = m.chat
                               WHERE c.room = ? AND c.source IN ('bridge', 'matrix')""", (room,)).fetchone()[0]
            exp_end = room_export_end(c, room)
            if low is not None and exp_end is not None and low <= exp_end: state = (state[0], True, True)
            rows = [] if in_exports else page("c.source = 'bridge'")
            if not rows and not state[1] and not in_exports:
                try: fetch_more(c, state[0], room, Api.owner, lambda: bool(page("c.source = 'bridge'")))
                except (BridgeDown, StillEmpty) as e:
                    print("archive:", room, type(e).__name__, e, flush=True)
                    return self.send(503, {"error": "the bridge cannot fetch now"})
                rows = page("c.source = 'bridge'")
                state = bridge_state(c, room)
            if not rows and (state[1] or in_exports):
                # below both the bridge's oldest page and the room's first message on the homeserver
                low = c.execute("""SELECT min(m.ts) FROM messages m JOIN chats c ON c.id = m.chat
                                   WHERE c.room = ? AND c.source IN ('bridge', 'matrix')""", (room,)).fetchone()[0]
                rows = page("c.source NOT IN ('matrix', 'bridge') AND m.ts < ?", 2**62 if low is None else low)
                if not state[2]: until = export_until(c, room)
        else:
            rows = page("c.source != 'matrix'")
            until = export_until(c, room)
        extras = message_extras(c, [r[0] for r in rows])
        c.close()
        self.send(200, {"until": until, "messages": [{"id": i, "ts": ts, "sender": s, "me": bool(me), "body": b, **extras[i]}
                                                      for i, ts, s, me, b in rows]})


def room_export_end(c, room):
    """The newest message of the room's exports, which hold everything older. Not Beeper's: its cache keeps only a
    chat's last messages, so the bridge pages on below them (import_beeper.py)."""
    return c.execute("""SELECT max(m.ts) FROM messages m JOIN chats c ON c.id = m.chat
                        WHERE c.room = ? AND c.source NOT IN ('matrix', 'bridge', 'beeper')""", (room,)).fetchone()[0]


def export_caps(c):
    """Per room, the time from which its exported messages are also on the homeserver or among the bridge's pages:
    above it an export row is a duplicate (same time to the ms, same text)."""
    return dict(c.execute("""SELECT c.room, min(m.ts) FROM messages m JOIN chats c ON c.id = m.chat
                             WHERE c.source IN ('bridge', 'matrix') AND c.room IS NOT NULL GROUP BY c.room"""))


def search(c, text, limit):
    """Archived messages (not the homeserver's own: Weft searches those there) whose words start with every word of
    the query, newest first. An export row the homeserver or the bridge also has counts once."""
    words = re.findall(r"\w+", text)
    if not words: return []
    match = " AND ".join('"' + w.replace('"', '""') + '"*' for w in words)
    floors = export_caps(c)
    out = []
    for i, room, ts, sender, me, body, source in c.execute(f"""
            SELECT m.id, COALESCE(c.room,'archive:'||c.id), m.ts, m.sender, m.me, m.body, c.source FROM messages_fts f
            JOIN messages m ON m.rowid = f.rowid JOIN chats c ON c.id = m.chat
            WHERE messages_fts MATCH ? AND c.source != 'matrix' AND {HISTORY_VISIBLE}
              AND (c.source != 'messenger-export' OR NOT {NATIVE_DUPLICATE})
            ORDER BY m.ts DESC""", (match,)):
        if source not in ("bridge", "matrix", "messenger-export", "history") and room in floors and ts >= floors[room]: continue
        out.append({"id": i, "room": room, "ts": ts, "sender": sender, "me": bool(me), "body": body})
        if len(out) >= limit: break
    return out


def export_until(c, room):
    """Where the room's exports end: messages after that and before the next one Weft has are in neither."""
    ends = export_ends(c)
    return min((ends.get(src) for (src,) in c.execute("SELECT source FROM chats WHERE room = ? AND source NOT IN ('matrix', 'bridge')", (room,))
                if ends.get(src)), default=None)


_ends = (0, {})


def export_ends(c):
    """The newest message of each export, recounted every ten minutes (an import runs as another process)."""
    global _ends
    if time.time() - _ends[0] > 600:
        _ends = (time.time(), dict(c.execute("""SELECT c.source, max(m.ts) FROM messages m JOIN chats c ON c.id = m.chat
                                                WHERE c.source NOT IN ('matrix', 'bridge') GROUP BY c.source""").fetchall()))
    return _ends[1]


_claim = threading.Lock()


def claim_owner(who):
    """The first account to call an install.sh archive becomes its owner, for good (the file is written once)."""
    with _claim:
        if Api.owner is not None: return
        # Written whole beside it, then linked in (which fails if another got there first): never an empty owner file.
        if os.path.exists(OWNER_FILE) and not open(OWNER_FILE).read().strip(): os.unlink(OWNER_FILE)  # an older empty one
        tmp = f"{OWNER_FILE}.{os.getpid()}.{threading.get_ident()}"
        try:
            with open(tmp, "w") as f: f.write(who); f.flush(); os.fsync(f.fileno())
            os.chmod(tmp, 0o600)
            try: os.link(tmp, OWNER_FILE); Api.owner = who
            except FileExistsError: Api.owner = open(OWNER_FILE).read().strip() or None
        finally:
            try: os.unlink(tmp)
            except FileNotFoundError: pass
        print("archive: owned by", Api.owner, flush=True)


def serve():
    threading.Thread(target=beeper_sweep, daemon=True).start()
    if OWNER_FILE:
        Api.owner = (open(OWNER_FILE).read().strip() or None) if os.path.exists(OWNER_FILE) else None
        print("archive: serving", DB, "for", Api.owner or "the first account that calls it", flush=True)
        ThreadingHTTPServer(("127.0.0.1", PORT), Api).serve_forever()
        return
    token = login()
    Api.owner = call("GET", "/_matrix/client/v3/account/whoami", token=token)["user_id"]
    Api.hs_token = token

    def hourly():
        while True:
            try:
                c = db()
                try: index_discord_media(c)
                finally: c.close()
            except Exception as e: print("discord attachments failed:", e, flush=True)
            try: mirror(token)
            except Exception as e: print("mirror failed:", e, flush=True)
            try: cache_matrix_media(token)
            except Exception as e: print("matrix media failed:", e, flush=True)
            try: warm_thumbs(lambda *a: None)
            except Exception as e: print("thumbnails failed:", e, flush=True)
            try: local()
            except Exception as e: print("local copy failed:", e, flush=True)
            time.sleep(3600)
    threading.Thread(target=hourly, daemon=True).start()
    threading.Thread(target=watch_receipts, args=(token, Api.owner), daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Api).serve_forever()


if __name__ == "__main__":
    cmd, args = (sys.argv[1:2] or ["serve"])[0], sys.argv[2:]
    if cmd == "serve": serve()
    elif cmd == "mirror": mirror(login())
    elif cmd == "instagram": import_instagram(args)
    elif cmd == "instagram-media": import_instagram_media(args)
    elif cmd == "history" and args: history_ahead(args[0])
    elif cmd == "thumbs": warm_thumbs()
    elif cmd == "sizes": fix_sizes()
    elif cmd == "export": export(args[0])
    elif cmd == "local": local()
    elif cmd == "unlink" and args: print("unlinked" if unlink_chat(db(), args[0]) else "no such linked chat")
    elif cmd == "join" and len(args) == 2: print("joined" if join_chat(db(), *args) else "not two unlinked old chats of one network")
    else: sys.exit(__doc__)

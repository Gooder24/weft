#!/usr/bin/env python3
"""Collect existing history without sending messages or receipts. Credentials stay in bridge state.

Writes a private, resumable SQLite source archive, never a bridge database. Discord uses GET only;
EduPage uses its read-only getData request with the existing session. WhatsApp reads local history.
"""
import argparse
import base64
from contextlib import closing
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request


def ro(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)


def packed(data):
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def open_store(path):
    path = Path(path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    c = sqlite3.connect(path, timeout=60)
    os.chmod(path, 0o600)
    c.executescript("""
      CREATE TABLE IF NOT EXISTS items (
        network TEXT, account TEXT, chat TEXT, id TEXT, ts INTEGER NOT NULL,
        sender TEXT NOT NULL, me INTEGER NOT NULL, body TEXT NOT NULL,
        title TEXT NOT NULL, room TEXT, native TEXT NOT NULL, raw TEXT NOT NULL,
        PRIMARY KEY(network, account, chat, id));
      CREATE TABLE IF NOT EXISTS progress (
        network TEXT, account TEXT, chat TEXT, cursor TEXT NOT NULL DEFAULT '',
        done INTEGER NOT NULL DEFAULT 0, error TEXT, updated REAL NOT NULL,
        PRIMARY KEY(network, account, chat));
      CREATE TABLE IF NOT EXISTS channels (
        network TEXT, account TEXT, chat TEXT, title TEXT, room TEXT, type INTEGER, guild TEXT,
        PRIMARY KEY(network,account,chat));
    """)
    return c


def keep(c, network, account, chat, ident, ts, sender, me, body, title, room, native, raw):
    c.execute("""INSERT INTO items VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(network,account,chat,id)
      DO UPDATE SET ts=excluded.ts,sender=excluded.sender,me=excluded.me,body=excluded.body,
      title=excluded.title,room=excluded.room,native=excluded.native,raw=excluded.raw""",
      (network, account, chat, str(ident), ts, sender, int(me), body, title, room or None,
       packed(native), packed(raw)))


class Reader:
    def __init__(self, token, delay=1.1):
        self.token, self.delay, self.last = token, delay, 0
        self.requests = 0

    def get(self, path):
        # The caller cannot turn this into an arbitrary authenticated request.
        if not re.fullmatch(r"/(?:channels/\d+/(?:messages|threads/archived/(?:public|private)|users/@me/threads/archived/private)|guilds/\d+/(?:channels|threads/active)|users/@me/channels)(?:\?[^#]*)?", path):
            raise ValueError("Not a history endpoint")
        for attempt in range(6):
            time.sleep(max(0, self.last + self.delay - time.monotonic()))
            req = urllib.request.Request("https://discord.com/api/v9" + path,
                headers={"Authorization": self.token, "User-Agent": "Mozilla/5.0"}, method="GET")
            self.last = time.monotonic()
            self.requests += 1
            try:
                with urllib.request.urlopen(req, timeout=45) as res:
                    return json.load(res)
            except urllib.error.HTTPError as err:
                if err.code == 429:
                    retry = json.loads(err.read()).get("retry_after", 5)
                    if not isinstance(retry, (int, float)) or retry > 300: raise RuntimeError("Discord requested a long pause") from None
                    time.sleep(max(retry, 1))
                elif err.code >= 500 and attempt < 5:
                    time.sleep(min(30, 2 ** attempt))
                else: raise
        raise RuntimeError("Discord rate limit did not clear")


def discord_body(m):
    parts = [m.get("content") or ""]
    for a in m.get("attachments", []):
        kind = a.get("content_type", "")
        label = "[Fotka]" if kind.startswith("image/") else "[Video]" if kind.startswith("video/") else "[Zvuková správa]" if kind.startswith("audio/") else "[Súbor]"
        parts.append(f"{label} {a.get('filename', '')}".strip())
    parts += ["[Nálepka] " + s.get("name", "") for s in m.get("sticker_items", [])]
    for embed in m.get("embeds", []):
        if embed.get("description") and not m.get("content"): parts.append(embed["description"])
        if embed.get("title") and not m.get("content"): parts.append(embed["title"])
    if m.get("poll"): parts.append("[Anketa] " + m["poll"].get("question", {}).get("text", ""))
    return "\n".join(p for p in parts if p) or f"[Udalosť Discordu: {m.get('type', 0)}]"


def discord(c, root, guild, dms=True):
    with closing(ro(root / "discord/bridge.db")) as b:
        account, token = b.execute("SELECT dcid,discord_token FROM user WHERE discord_token IS NOT NULL AND discord_token!=''").fetchone()
        server = (b.execute("SELECT plain_name FROM guild WHERE dcid=?", (guild,)).fetchone() or [""])[0] or guild
        reader = Reader(token)
        portals = {r[0]: dict(zip(("id", "title", "room", "type", "guild"), r)) for r in b.execute(
            "SELECT dcid,plain_name,mxid,type,dc_guild_id FROM portal WHERE (? AND type IN (1,3)) OR dc_guild_id=?", (int(dms), guild))}
        # Retain previously discovered channels even when Discord omits them from today's inventory.
        # A vanished/inaccessible channel must be checked and reported, never silently counted as complete.
        for channel, title, room, typ, old_guild in c.execute(
                "SELECT chat,title,room,type,guild FROM channels WHERE network='discord' AND account=? AND (guild=? OR (? AND type IN (1,3)))",
                (account, guild, int(dms))):
            portals.setdefault(channel, {"id": channel, "title": title, "room": room, "type": typ, "guild": old_guild})
        native = {}
        for remote, channel, mxid in b.execute("SELECT dcid,COALESCE(NULLIF(dc_thread_id,''),dc_chan_id),mxid FROM message"):
            native.setdefault((channel, remote), []).append(mxid)
        # Current channels include DMs not yet known to the bridge; never create/join a channel.
        for d in reader.get("/users/@me/channels") if dms else []:
            if d.get("type") not in (1, 3): continue
            p = portals.setdefault(d["id"], {"id": d["id"], "room": None, "title": "", "type": d["type"], "guild": None})
            if not p["title"]:
                p["title"] = d.get("name") or ", ".join(x.get("global_name") or x.get("username", "") for x in d.get("recipients", [])) or d["id"]
        for d in reader.get(f"/guilds/{guild}/channels"):
            if d.get("type") not in (0, 2, 5, 13, 15, 16): continue
            p = portals.setdefault(d["id"], {"id": d["id"], "room": None, "type": d["type"], "guild": guild})
            p["title"] = d.get("name") or p.get("title") or d["id"]
        # One denied channel must not suppress discovery in every later channel.
        discovery_errors = []
        try:
            threads = reader.get(f"/guilds/{guild}/threads/active").get("threads", [])
        except urllib.error.HTTPError as err:
            if err.code not in (403, 404): raise
            threads = []
            discovery_errors.append({"scope": "active_threads", "http": err.code})
        for parent in list(portals.values()):
            if parent.get("guild") != guild or parent["type"] not in (0, 5, 15, 16): continue
            scopes = ["threads/archived/public"]
            if parent["type"] == 0: scopes.append("users/@me/threads/archived/private")
            for scope in scopes:
                before = ""
                while True:
                    args = urllib.parse.urlencode({"limit": 100, **({"before": before} if before else {})})
                    try:
                        result = reader.get(f"/channels/{parent['id']}/{scope}?{args}")
                    except urllib.error.HTTPError as err:
                        if err.code not in (403, 404): raise
                        discovery_errors.append({"channel": parent['id'], "scope": scope, "http": err.code})
                        break
                    chunk = result.get("threads", [])
                    threads.extend(chunk)
                    if not result.get("has_more") or not chunk: break
                    # Joined private archives use a thread ID cursor; public archives use archive time.
                    cursor = chunk[-1]["id"] if scope.startswith("users/") else chunk[-1]["thread_metadata"]["archive_timestamp"]
                    if cursor == before: raise ValueError("Archived thread cursor did not advance")
                    before = cursor
        for d in threads:
            portals.setdefault(d["id"], {"id": d["id"], "room": None, "type": d["type"], "guild": guild,
                "title": d.get("name") or d["id"]})
        counts = {"channels": len(portals), "complete": 0, "unavailable": 0, "messages": 0}
        c.executemany("INSERT OR REPLACE INTO channels VALUES ('discord',?,?,?,?,?,?)",
            [(account,p["id"],p["title"],p["room"],p["type"],p.get("guild")) for p in portals.values()])
        c.commit()
        for channel, p in sorted(portals.items(), key=lambda x: (x[1]["type"] not in (1, 3), x[0])):
            if p["type"] in (15, 16): continue  # messages live in their threads
            state = c.execute("SELECT cursor,done FROM progress WHERE network='discord' AND account=? AND chat=?", (account, channel)).fetchone()
            if state and state[1]:
                # A reached historical start does not mean the head stayed unchanged since the last run.
                newest = c.execute("SELECT max(CAST(id AS INTEGER)) FROM items WHERE network='discord' AND account=? AND chat=?",
                                   (account, channel)).fetchone()[0] or 0
                head_before = ""
                try:
                    while True:
                        data = reader.get(f"/channels/{channel}/messages?" + urllib.parse.urlencode({"limit": 100, **({"before": head_before} if head_before else {})}))
                        if not isinstance(data, list): raise ValueError("Discord did not return a message list")
                        for m in data:
                            if str(m.get("channel_id")) != channel: raise ValueError("Message belongs to another channel")
                            if int(m["id"]) <= newest: continue
                            author = m.get("author", {})
                            title = p["title"] or channel
                            if p.get("guild"): title = f"{server} / {title}"
                            keep(c, "discord", account, channel, m["id"], int(dt.datetime.fromisoformat(m["timestamp"]).timestamp()*1000),
                                author.get("global_name") or author.get("username") or author.get("id", "Discord"),
                                str(author.get("id")) == account, discord_body(m), title, p["room"], native.get((channel,m["id"]),[]),m)
                            counts["messages"] += 1
                        c.commit()
                        cursor = str(min(int(m["id"]) for m in data)) if data else ""
                        if not data or int(cursor) <= newest: break
                        if head_before and int(cursor) >= int(head_before): raise ValueError("Discord head cursor did not advance")
                        head_before = cursor
                    c.execute("UPDATE progress SET error=NULL,updated=? WHERE network='discord' AND account=? AND chat=?", (time.time(),account,channel))
                    c.commit()
                    counts["complete"] += 1
                except urllib.error.HTTPError as err:
                    if err.code not in (403,404): raise
                    c.execute("UPDATE progress SET error=?,updated=? WHERE network='discord' AND account=? AND chat=?", (f"HTTP {err.code}",time.time(),account,channel))
                    c.commit(); counts["unavailable"] += 1
                continue
            before = state[0] if state else ""
            while True:
                try:
                    data = reader.get(f"/channels/{channel}/messages?" + urllib.parse.urlencode({"limit": 100, **({"before": before} if before else {})}))
                except urllib.error.HTTPError as err:
                    if err.code not in (403, 404): raise
                    c.execute("INSERT OR REPLACE INTO progress VALUES ('discord',?,?,?,?,?,?)", (account, channel, before, 0, f"HTTP {err.code}", time.time()))
                    c.commit(); counts["unavailable"] += 1
                    break
                if not isinstance(data, list): raise ValueError("Discord did not return a message list")
                for m in data:
                    if str(m.get("channel_id")) != channel: raise ValueError("Message belongs to another channel")
                    author = m.get("author", {})
                    ts = int(dt.datetime.fromisoformat(m["timestamp"]).timestamp() * 1000)
                    title = p["title"] or channel
                    if p.get("guild"): title = f"{server} / {title}"
                    keep(c, "discord", account, channel, m["id"], ts,
                        author.get("global_name") or author.get("username") or author.get("id", "Discord"),
                        str(author.get("id")) == account, discord_body(m), title, p["room"], native.get((channel, m["id"]), []), m)
                cursor = str(min(int(m["id"]) for m in data)) if data else before
                if data and before and int(cursor) >= int(before): raise ValueError("Discord cursor did not advance")
                # A short page is not proof of the start; an empty successful page is.
                done = not data
                c.execute("INSERT OR REPLACE INTO progress VALUES ('discord',?,?,?,?,?,?)", (account, channel, cursor, int(done), None, time.time()))
                c.commit()
                counts["messages"] += len(data)
                print(packed({"network": "discord", "channel": channel, "received": len(data), "done": done}), flush=True)
                if done:
                    counts["complete"] += 1
                    break
                before = cursor
        counts["discovery_errors"] = discovery_errors
        counts["requests"] = reader.requests
        return counts


def fields(data):
    """Bounds-checked protobuf wire reader; raw bytes are also retained without alteration."""
    out, pos = {}, 0
    def varint():
        nonlocal pos
        value = 0
        for shift in range(0, 70, 7):
            if pos >= len(data): raise ValueError("Truncated protobuf varint")
            byte = data[pos]; pos += 1
            value |= (byte & 127) << shift
            if byte < 128: return value
        raise ValueError("Protobuf varint is too long")
    while pos < len(data):
        tag = varint(); number, kind = tag >> 3, tag & 7
        if not number: raise ValueError("Invalid protobuf field")
        if kind == 0: value = varint()
        elif kind in (1, 2, 5):
            size = varint() if kind == 2 else 8 if kind == 1 else 4
            if pos + size > len(data): raise ValueError("Truncated protobuf field")
            value = data[pos:pos + size]; pos += size
        else: raise ValueError("Unsupported protobuf wire type")
        out.setdefault(number, []).append(value)
    return out


def text(f, n):
    value = f.get(n, [b""])[0]
    return value.decode("utf-8") if isinstance(value, bytes) else ""


def interactive_body(raw):
    f = fields(raw)
    parts = [text(fields(f[n][0]), 1) for n in (1, 2, 3) if n in f]
    return "\n".join(t for t in parts if t) or "[Interaktívna správa WhatsAppu]"


def wa_body(raw, depth=0):
    if depth > 10: raise ValueError("Nested WhatsApp message is too deep")
    f = fields(raw)
    if 1 in f: return text(f, 1)
    if 6 in f: return text(fields(f[6][0]), 1)
    if 25 in f:
        template = fields(f[25][0])
        hydrated = template.get(4) or template.get(2)
        if hydrated:
            h = fields(hydrated[0])
            return "\n".join(t for t in (text(h, 2), text(h, 6), text(h, 7)) if t) or "[Šablóna WhatsAppu]"
        if 5 in template: return interactive_body(template[5][0])
    if 45 in f:
        return interactive_body(f[45][0])
    for wrapper in (37, 40, 53, 55, 58, 59, 62, 67, 74, 85, 87, 91, 92, 93, 95, 96):
        if wrapper in f:
            nested = fields(f[wrapper][0]).get(1)
            if nested: return wa_body(nested[0], depth + 1)
    for n, label, caption in ((3, "[Fotka]", 3), (7, "[Súbor]", 8), (8, "[Zvuková správa]", 0),
                               (9, "[Video]", 7), (26, "[Nálepka]", 0), (66, "[Video]", 7)):
        if n in f: return label + ((" " + text(fields(f[n][0]), caption)) if caption else "")
    return "[Položka WhatsAppu]"


def whatsapp(c, root):
    with closing(ro(root / "whatsapp/bridge.db")) as b:
        portals = {row[0]: (row[1], row[2]) for row in b.execute("SELECT id,name,mxid FROM portal")}
        contacts = {row[0]: next((v for v in row[1:] if v), row[0]) for row in b.execute("SELECT their_jid,full_name,push_name,first_name,business_name FROM whatsmeow_contacts")}
        lids = dict(b.execute("SELECT pn,lid FROM whatsmeow_lid_map"))
        native = {}
        for ident, chat, mxid in b.execute("SELECT id,room_id,mxid FROM message"):
            native.setdefault((chat, ident), []).append(mxid)
        counts = {"messages": 0, "chats": set(), "linked": 0}
        for account, chat, sender, ident, ts, raw in b.execute("SELECT user_login_id,chat_jid,sender_jid,message_id,timestamp,data FROM whatsapp_history_sync_message"):
            info = fields(fields(raw)[1][0])  # HistorySyncMsg.message -> WebMessageInfo
            key = fields(info.get(1, [b""])[0])
            canonical = chat
            if chat.endswith("@s.whatsapp.net"):
                lid = lids.get(chat.split("@")[0])
                if lid: canonical = lid + "@lid"
            title, room = portals.get(canonical, (contacts.get(chat, chat), None))
            content = info.get(2)
            body = wa_body(content[0]) if content else f"[Udalosť WhatsAppu: {info.get(24, [0])[0]}]"
            keep(c, "whatsapp", account, canonical, ident, ts * 1000,
                text(info, 19) or contacts.get(sender, sender), bool(key.get(2, [0])[0]), body,
                title or contacts.get(chat, chat), room, native.get((canonical, ident), []),
                {"encoding": "HistorySyncMsg.protobuf.base64", "data": base64.b64encode(raw).decode(), "chat_jid": chat, "sender_jid": sender})
            counts["messages"] += 1; counts["chats"].add(canonical); counts["linked"] += bool(room)
        c.commit()
        counts["chats"] = len(counts["chats"])
        counts["coverage"] = "Only history retained by the linked device; a phone export is needed for missing older chats."
        return counts


def edupage(c, root):
    base = root / "edupage/state"
    creds = json.loads((base / "account.json").read_text())
    school, account = creds["school"], creds["login_id"]
    if not re.fullmatch(r"[a-zA-Z0-9-]+", school): raise ValueError("Invalid school")
    with closing(ro(base / "edupage.db")) as b:
        items = {str(i): json.loads(raw) for i, raw in b.execute("SELECT id,item FROM raw")}
        native = {str(i): [ev] for i, ev in b.execute("SELECT id,event_id FROM items UNION ALL SELECT id,event_id FROM notices")}
        row = b.execute("SELECT value FROM kv WHERE key='school_room'").fetchone()
        room = row[0] if row else None
    requests = []
    try:
        from edupage_api import Edupage
        from edupage_api.login_session import LoginSession
        edu = Edupage(request_timeout=30)
        try:
            LoginSession(edu).reload_data(school, creds["session"], creds["username"])
        except Exception:
            edu = Edupage(request_timeout=30)
            if edu.login(creds["username"], creds["password"], school) is not None:
                raise RuntimeError("EduPage needs login confirmation")
        for tab in ("", "messages"):
            params = [("module", "todo"), ("filterTab", ""), ("akcia", "getData")] + ([("filterTab", tab)] if tab else [])
            res = edu.session.post(f"https://{school}.edupage.org/timeline/", params=params,
                data=urllib.parse.urlencode({"datefrom": "2000-01-01"}),
                headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=60)
            res.raise_for_status()
            data = res.json()
            batch = data.get("timelineItems")
            if not isinstance(batch, list): raise ValueError("No timeline data")
            requests.append({"tab": tab, "returned": len(batch), "since": "2000-01-01"})
            items.update({str(i["timelineid"]): i for i in batch if i.get("timelineid")})
            time.sleep(1)
    except Exception as err:
        requests.append({"error": "School history unavailable: " + type(err).__name__})
    counts = {"source_items": len(items), "messages": 0, "requests": requests}
    for ident, item in items.items():
        if item.get("typ") != "sprava": continue
        data = item.get("data") or {}
        if isinstance(data, str): data = json.loads(data or "{}")
        if not isinstance(data, dict): data = {}
        body = data.get("messageContent") or item.get("text") or "[Správa bez textu]"
        if str(item.get("removed")) == "1": body = "[Odstránená správa]"
        stamp = item.get("cas_pridania") or item.get("timestamp")
        ts = int(dt.datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S").timestamp() * 1000)
        mine = (item.get("vlastnik") or "").replace("Only", "") == creds["user_id"]
        # A dedicated archive view retains old school threads without sending them back to EduPage.
        keep(c, "edupage", account, school, ident, ts, item.get("vlastnik_meno") or item.get("user_meno") or "EduPage",
            mine, body, "EduPage – história", None, native.get(ident, []), item)
        counts["messages"] += 1
    c.commit()
    counts["coverage"] = ("Cached bridge messages only; the saved session could not load older school years."
        if any("error" in r for r in requests) else
        "All message items returned by both timeline tabs since 2000; school-side retention may limit older years.")
    return counts


def local_setting(name):
    """A KEY=value line of ~/.config/weft/weft.env, the local values kept out of the repo; None when it is not there."""
    try:
        lines = (Path.home() / ".config/weft/weft.env").read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return None
    return next((l.split("=", 1)[1].strip() for l in lines if l.startswith(name + "=")), None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("network", choices=("discord", "whatsapp", "edupage"))
    parser.add_argument("--root", type=Path, default=Path.home() / "matrix-spike")
    parser.add_argument("--store", type=Path, default=Path.home() / "exports/weft-history/history.db")
    guild = os.environ.get("WEFT_DISCORD_GUILD") or local_setting("WEFT_DISCORD_GUILD")
    parser.add_argument("--guild", default=guild,
                        help="authorized Discord guild ID (default: WEFT_DISCORD_GUILD in ~/.config/weft/weft.env)")
    parser.add_argument("--no-dms", action="store_true", help="only the guild's channels, not direct messages")
    args = parser.parse_args()
    if args.network == "discord" and not args.guild: parser.error("Discord requires --guild or WEFT_DISCORD_GUILD")
    os.umask(0o077)
    with closing(open_store(args.store)) as c:
        report = discord(c, args.root, args.guild, not args.no_dms) if args.network == "discord" else globals()[args.network](c, args.root)
        print(packed({"network": args.network, "result": report}), flush=True)


if __name__ == "__main__":
    main()

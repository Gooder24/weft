"""Discord in Weft without touching the bridge (DISCORD-PLAN.md, phase 0).

The legacy mautrix-discord bridge opens only the 5 newest DMs at its start and every other one when a new message
comes. The archive reads the bridge's own database (read-only) and lets Weft:

    GET  /_archive/discord/dms                  Karchi's DM and group channels: channel, person, name, room
    POST /_archive/discord/open {channel}       one of them as a live room, through the bridge's own command
    GET  /_archive/discord/channels             each bridged room's channel type (5: announcements) and server
    GET  /_archive/discord/people?guild=&q=     people who wrote on a server, from the collected history (for "@")

Nothing here talks to Discord. `open` sends `!discord create-portal <channel>` to Karchi's management room with
the bridge; the bridge then reads the channel and backfills its last messages (initial backfill limit) with their
avatars and files, as for any new message.
One command at a time, and none again for a channel that is still opening (2 minutes)."""
import json, os, re, sqlite3, threading, time, urllib.error, urllib.parse

BRIDGE_DB = os.environ.get("DISCORD_BRIDGE_DB", os.path.expanduser("~/matrix-spike/discord/bridge.db"))
BOT_LOCALPART = os.environ.get("DISCORD_BOT", "discordbot")
OPEN_WAIT = float(os.environ.get("DISCORD_OPEN_WAIT", "20"))  # seconds to wait for the room and Karchi in it
PENDING_FOR = 120  # a channel still opening gets no second command this long
DM, GROUP, ANNOUNCEMENTS = 1, 3, 5
q = lambda s: urllib.parse.quote(s, safe="")

lock = threading.Lock()  # one command at a time, also from two windows or devices
pending = {}  # channel -> when its command went out


def bridge_db():
    return sqlite3.connect(f"file:{BRIDGE_DB}?mode=ro", uri=True, timeout=10)


def me(b, owner):
    """Karchi's Discord id and his management room with the bridge, from the bridge's own user row."""
    row = b.execute("SELECT dcid, management_room FROM user WHERE mxid = ?", (owner,)).fetchone()
    return (row[0] or "", row[1] or "") if row else ("", "")


def dms(b, owner, titles=None):
    """Karchi's DMs (portal type 1, his own as receiver) and groups (type 3, his through user_portal), newest
    first by the archive's last message where it has one. Only these may be opened or linked."""
    mine, _ = me(b, owner)
    if not mine: return []
    rows = b.execute("""SELECT p.dcid, p.type, p.other_user_id, COALESCE(p.mxid, ''), p.name, p.plain_name,
            COALESCE(pu.name, ''), COALESCE(pu.global_name, ''), COALESCE(pu.username, ''), COALESCE(pu.is_bot, 0)
        FROM portal p LEFT JOIN puppet pu ON pu.id = p.other_user_id
        WHERE (p.type = ? AND p.receiver = ?)
           OR (p.type = ? AND p.receiver = '' AND EXISTS (SELECT 1 FROM user_portal up WHERE up.discord_id = p.dcid AND up.user_mxid = ?))""",
        (DM, mine, GROUP, owner)).fetchall()
    titles = titles or {}
    out = []
    for channel, kind, other, room, name, plain, pname, gname, uname, bot in rows:
        title = name or plain or (titles.get(channel) or {}).get("title") or gname or pname or uname or ""
        out.append({"channel": channel, "type": "dm" if kind == DM else "group", "user": other or "", "username": uname,
                    "name": title, "bot": bool(bot), "room": room, "chat": (titles.get(channel) or {}).get("chat", ""),
                    "ts": (titles.get(channel) or {}).get("ts", 0)})
    out.sort(key=lambda x: (-x["ts"], x["name"].lower()))
    return out


def archive_titles(c, account):
    """The archive's old Discord chats by channel: their id, title and newest message (collect_history.py)."""
    if not c.execute("SELECT 1 FROM sqlite_master WHERE name = 'history_data'").fetchone(): return {}
    out = {}
    for channel, chat, title, ts in c.execute("""SELECT h.chat, m.chat, c.title, max(m.ts) FROM history_data h
            JOIN messages m ON m.id = h.message JOIN chats c ON c.id = m.chat
            WHERE h.network = 'discord' AND h.account = ? GROUP BY h.chat, m.chat""", (account,)):
        if ts >= out.get(channel, {}).get("ts", -1): out[channel] = {"chat": chat, "title": title or "", "ts": ts}
    return out


def channel_of_chat(c, chat):
    """(account, channel) of an old Discord chat from its collected messages, or None when it has none or several."""
    rows = c.execute("""SELECT DISTINCT h.account, h.chat FROM history_data h JOIN messages m ON m.id = h.message
                        WHERE m.chat = ? AND h.network = 'discord'""", (chat,)).fetchall()
    return rows[0] if len(rows) == 1 else None


def link_allowed(c, b, owner, chat, room, discord_room=False):
    """May old chat `chat` (and every old chat that goes along with it) become the history of `room`? When either
    side is Discord, only when the room is the bridge's portal of that very channel, of Karchi's account, and every
    chat that moves is that channel's. Otherwise (no Discord on either side): always. `discord_room`: the room's own
    m.bridge says Discord (read from the homeserver by the caller)."""
    chat = chat.removeprefix("archive:")
    # The chat itself and the old chats joined to it (join_chat), which link_chat moves along.
    along = [chat] + [x for x, in c.execute("SELECT id FROM chats WHERE room = ? AND id != ?", ("archive:" + chat, chat))]
    nets = [(c.execute("SELECT network FROM chats WHERE id = ?", (x,)).fetchone() or [None])[0] for x in along]
    portal = b.execute("SELECT dcid, type, receiver FROM portal WHERE mxid = ?", (room,)).fetchone() if b else None
    # The archive's own copy of the room says Discord too (mirror reads its m.bridge), also without bridge.db.
    mirrored = (c.execute("SELECT network FROM chats WHERE id = ?", (room,)).fetchone() or [None])[0]
    if not portal and not discord_room and mirrored != "discord" and "discord" not in nets: return True
    mine, _ = me(b, owner) if b else ("", "")
    if not mine or not portal: return False
    channel, kind, receiver = portal
    if kind == DM and receiver != mine: return False
    if kind == GROUP and not b.execute("SELECT 1 FROM user_portal WHERE discord_id = ? AND user_mxid = ?", (channel, owner)).fetchone():
        return False
    return all(channel_of_chat(c, x) == (mine, channel) for x in along)


def channels(b, owner):
    """Each bridged room of Karchi's servers and DMs: {room: {type, guild, channel}}."""
    mine, _ = me(b, owner)
    return {room: {"type": kind, "guild": guild or "", "channel": channel}
            for room, kind, guild, channel in b.execute(
                "SELECT mxid, type, dc_guild_id, dcid FROM portal WHERE mxid IS NOT NULL AND mxid != '' AND (receiver = '' OR receiver = ?)",
                (mine,))}


def people(c, b, owner, guild, text, limit=10):
    """Who wrote on server `guild` in the collected history, by a name starting with `text` (any word of it).
    Each {user, name, username}; Karchi himself is left out."""
    mine, _ = me(b, owner)
    chans = [x for x, in b.execute("SELECT dcid FROM portal WHERE dc_guild_id = ?", (guild,))]
    if not chans or not c.execute("SELECT 1 FROM sqlite_master WHERE name = 'history_data'").fetchone(): return []
    found = {}
    for i in range(0, len(chans), 500):
        part = chans[i:i + 500]
        for user, gname, uname, ts in c.execute(f"""SELECT json_extract(raw, '$.author.id'), json_extract(raw, '$.author.global_name'),
                json_extract(raw, '$.author.username'), max(m.ts) FROM history_data h JOIN messages m ON m.id = h.message
                WHERE h.network = 'discord' AND h.chat IN ({','.join('?' * len(part))}) GROUP BY 1""", part):
            if not user or user == mine or (found.get(user) and found[user]["ts"] >= ts): continue
            found[user] = {"user": user, "name": gname or uname or user, "username": uname or "", "ts": ts}
    want = fold(text)
    hits = [p for p in found.values() if not want or any(w.startswith(want) for w in fold(f"{p['name']} {p['username']}").split())]
    hits.sort(key=lambda p: -p["ts"])
    return [{k: p[k] for k in ("user", "name", "username")} for p in hits[:limit]]


def fold(s):
    import unicodedata
    return "".join(ch for ch in unicodedata.normalize("NFD", s or "").lower() if unicodedata.category(ch) != "Mn")


def open_channel(b_open, call, owner, token, channel, sleep=time.sleep, now=time.monotonic, cmd_token=None):
    """POST /_archive/discord/open: (http status, body). The room once Karchi is in it; `pending` when the bridge
    has not finished within OPEN_WAIT seconds (Weft asks again later; no second command for 2 minutes).
    `cmd_token`: the one login that sends commands (the archive's own), so a resent transaction id is the same
    transaction whichever window or device asks; `token` (Karchi's, from the request) reads and joins."""
    cmd_token = cmd_token or token

    def look():
        b = b_open()
        try:
            _, mgmt = me(b, owner)
            row = next((x for x in dms(b, owner) if x["channel"] == channel), None)
            accounts = b.execute("SELECT count(*) FROM user WHERE dcid IS NOT NULL AND dcid != ''").fetchone()[0]
            portals = {x for x, in b.execute("SELECT mxid FROM portal WHERE mxid IS NOT NULL AND mxid != ''")}
        finally: b.close()
        if not row: return None, (404, {"error": "not one of Karchi's Discord chats"})
        # The bridge invites every member of a group who is logged in to it too: only Karchi may be. The bridge's
        # permissions admit Karchi's Matrix account alone (one Discord login), so no account can appear between
        # this check and the bridge running the command; this only guards a config that changed.
        if row["type"] == "group" and accounts != 1: return None, (409, {"error": "the bridge has other accounts"})
        return (mgmt, row["room"], portals), None

    joined = lambda: set(call("GET", "/_matrix/client/v3/joined_rooms", token=token, timeout=15).get("joined_rooms", []))
    inside = lambda room: room in joined() or try_join(call, token, room)
    opening = lambda: channel in pending and now() - pending[channel]["at"] < PENDING_FOR
    got, refused = look()
    if refused: return refused
    if got[1]:
        if inside(got[1]): return 200, {"room": got[1]}
        # The bridge writes the room before it invites: a channel still opening waits below.
        # Otherwise it does not invite again for a chat it has already ("That channel is already bridged").
        if not opening(): return 409, {"error": "not_joined", "room": got[1]}
    # Another chat opening holds the lock for at most OPEN_WAIT: wait a little, then this one is `busy` (not sent).
    if not lock.acquire(timeout=5): return 202, {"state": "pending" if opening() else "busy"}
    try:
        # Everything again under the lock: another request may have opened it, or the bridge changed meanwhile.
        got, refused = look()
        if refused: return refused
        mgmt, room, portals = got
        if room and inside(room):
            pending.pop(channel, None)
            return 200, {"room": room}
        if room and not opening(): return 409, {"error": "not_joined", "room": room}
        entry = pending.get(channel) if opening() else None
        if not entry or not entry["sent"]:
            # Checked before every send, also a resend: the command goes only to Karchi's room with the bot.
            if not mgmt or mgmt in portals: return 409, {"error": "the bridge has no management room"}
            bot = f"@{BOT_LOCALPART}:{owner.split(':', 1)[1]}"
            try: members = call("GET", f"/_matrix/client/v3/rooms/{q(mgmt)}/joined_members", token=token, timeout=15).get("joined", {})
            except urllib.error.HTTPError: members = {}
            if set(members) != {owner, bot}: return 409, {"error": "the bridge has no management room"}
            if not entry or entry["mgmt"] != mgmt:
                entry = pending[channel] = {"at": now(), "txn": f"weft-open-{channel}-{int(time.time() * 1000)}",
                                            "sent": False, "mgmt": mgmt}
            # The same transaction id when a first try got no answer: the homeserver keeps one command.
            call("PUT", f"/_matrix/client/v3/rooms/{q(mgmt)}/send/m.room.message/{q(entry['txn'])}",
                 {"msgtype": "m.text", "body": f"!discord create-portal {channel}"}, token=cmd_token, timeout=15)
            entry["sent"] = True
        deadline = now() + OPEN_WAIT
        while True:
            sleep(1)
            got, refused = look()
            if refused: return refused
            if got[1] and inside(got[1]):
                pending.pop(channel, None)
                return 200, {"room": got[1]}
            if now() >= deadline: return 202, {"state": "pending"}
    finally: lock.release()


def try_join(call, token, room):
    """Takes an invitation the bridge left (without one the homeserver refuses, and nothing happens)."""
    try:
        call("POST", f"/_matrix/client/v3/rooms/{q(room)}/join", {}, token=token, timeout=15)
        return True
    except urllib.error.HTTPError:
        return False

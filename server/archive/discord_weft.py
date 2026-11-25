"""Discord in Weft from the bridge's own database (DISCORD-PLAN.md, phase 0), read-only:

    GET  /_archive/discord/dms                  Karchi's DM and group channels: channel, person, name, room
    GET  /_archive/discord/channels             each bridged room's channel type (5: announcements) and server
    GET  /_archive/discord/people?guild=&q=     people who wrote on a server, from the collected history (for "@")

Nothing here talks to Discord. Opening one of the DMs as a live room is the bridge's own
POST /v1/channels/<id>/open (server/bridges/discord-weft.patch); link_allowed guards the old history it gets."""
import os, sqlite3

BRIDGE_DB = os.environ.get("DISCORD_BRIDGE_DB", os.path.expanduser("~/matrix-spike/discord/bridge.db"))
DM, GROUP, ANNOUNCEMENTS = 1, 3, 5

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


#!/usr/bin/env python3
"""Weft's reply relay: when someone answers a message Karchi is waiting on, a picture of that answer goes into
a friend's chat as a draft, so he does not have to screenshot and forward it himself. Nothing is ever sent.

Weft (or `weft relay`) keeps what to watch in his account data under sk.karchi.relay as
{"items": [{id, room, rooms?, from_event?, from_ts, to_room, note?, at, expires, status}]}: `room` is the chat he
waits in (`rooms`, when given, all rooms of a merged chat), `to_room` the friend's chat. While an item is
"waiting", the first message from someone else after `from_ts` is an answer. Once the answer has settled (no new
message from them for a while, Karchi wrote again, or it is long), this draws Karchi's message and the answer as
Weft draws them (snap.html with Weft's app.css, in headless Chromium), uploads the PNG and adds a draft
{id: "relay-<id>", room: to_room, body: note, files: [{url, name, mimetype, size, w, h}]} to sk.karchi.drafts,
which Weft puts into the friend's message box. The item turns "captured" (or "expired" / "failed").

Reading here never sends a receipt or read marker, and the service never sends a message.
Its own device logs in once with a token from mint-login-token.py; the token stays in ./token (0600)."""
import base64, datetime as dt, fcntl, html, io, json, os, re, shutil, stat, subprocess, sys, tempfile, time, unicodedata
import urllib.error, urllib.parse, urllib.request
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("HS", "http://127.0.0.1:8008")
KEY = "sk.karchi.relay"
DRAFTS = "sk.karchi.drafts"
TOKEN_FILE = os.environ.get("TOKEN_FILE", os.path.join(HERE, "token"))
MINT = os.path.expanduser("~/matrix-spike/homeserver/mint-login-token.py")
APP_DIR = os.environ.get("APP_DIR", os.path.expanduser("~/matrix-spike/app"))  # the served Weft: its app.css, font, icons
CHROMIUM = os.environ.get("CHROMIUM", "/usr/bin/chromium")
# The same lock as tools/browser-slot: one headless browser at a time on this machine.
BROWSER_LOCK = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}", "browser-slot.lock")
SETTLE_MS = int(os.environ.get("RELAY_SETTLE_MS", 90_000))  # an answer is whole after this long without more from them
MAX_REPLY = 10   # at most this many of their messages in one picture
MAX_ANCHOR = 4   # and the last this many of Karchi's before them
KEEP_DONE_MS = 7 * 24 * 3600e3
TRIES = 3        # a picture that fails this often turns the item "failed"
TZ = ZoneInfo("Europe/Bratislava")
MESSAGE_TYPES = ["m.room.message", "m.sticker"]
BOT = re.compile(r"^@(messenger|instagram|discord|edupage|whatsapp|gmail|telegram|meta|teams)bot:")
NETWORKS = {"facebookgo": "messenger", "facebook": "messenger", "instagramgo": "instagram", "instagram": "instagram",
            "discordgo": "discord", "discord": "discord", "whatsapp": "whatsapp", "edupage": "edupage", "gmail": "gmail",
            "teams": "teams"}
ICONS = {"messenger": ("Messenger", "messenger.ico"), "instagram": ("Instagram", "instagram.png"), "discord": ("Discord", "discord.png"),
         "whatsapp": ("WhatsApp", "whatsapp.webp"), "edupage": ("EduPage", "edupage.png"), "gmail": ("Gmail", "gmail.ico"),
         "teams": ("Teams", "teams.png")}
q = lambda s: urllib.parse.quote(s, safe="")
log = lambda s: print(s, flush=True)  # counts and ids only, never what anyone wrote


class HttpError(Exception):
    def __init__(self, status, body):
        super().__init__(f"{status} {body.get('errcode', '')}")
        self.status, self.body = status, body


def request(method, path, body=None, token=None, timeout=60, raw=None, ctype="application/json"):
    data = raw if raw is not None else None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, method=method, data=data,
                                 headers={"Content-Type": ctype, **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        try:
            raise HttpError(e.code, json.load(e)) from None
        except json.JSONDecodeError:
            raise HttpError(e.code, {}) from None


def call(method, path, body=None, token=None, timeout=60):
    return json.loads(request(method, path, body, token, timeout)[0] or b"{}")


def login():
    if os.path.exists(TOKEN_FILE):
        token = open(TOKEN_FILE).read().strip()
        try:
            return token, call("GET", "/_matrix/client/v3/account/whoami", token=token)["user_id"]
        except HttpError as e:
            if e.status != 401:
                raise
    one_time = subprocess.run([sys.executable, MINT], capture_output=True, text=True, check=True).stdout.strip()
    r = call("POST", "/_matrix/client/v3/login", {"type": "m.login.token", "token": one_time,
                                                  "initial_device_display_name": "Weft: screenshot odpovede"})
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
    os.write(fd, r["access_token"].encode())
    os.close(fd)
    return r["access_token"], r["user_id"]


class Matrix:
    def __init__(self, token, user):
        self.token, self.user = token, user

    def __call__(self, method, path, body=None, timeout=60):
        return call(method, "/_matrix/client/v3" + path, body, self.token, timeout)

    def account(self, key):
        try:
            return self("GET", f"/user/{q(self.user)}/account_data/{key}")
        except HttpError as e:
            if e.status == 404:
                return {}
            raise

    def put_account(self, key, content):
        self("PUT", f"/user/{q(self.user)}/account_data/{key}", content)

    def upload(self, data, name, mimetype):
        body, _ = request("POST", "/_matrix/media/v3/upload?filename=" + q(name), token=self.token, timeout=120, raw=data, ctype=mimetype)
        return json.loads(body)["content_uri"]

    def media(self, mxc, thumb=640):
        """A picture as a data: URI (authenticated media, a thumbnail when the server makes one), or None."""
        m = re.match(r"^mxc://([^/]+)/([^/?#]+)$", mxc or "")
        if not m:
            return None
        paths = ([f"/_matrix/client/v1/media/thumbnail/{m[1]}/{m[2]}?width={thumb}&height={thumb}&method=scale"] if thumb else []) + \
            [f"/_matrix/client/v1/media/download/{m[1]}/{m[2]}"]
        for path in paths:
            try:
                data, ctype = request("GET", path, token=self.token, timeout=60)
            except (HttpError, OSError):
                continue
            if data and ctype.startswith("image/") and len(data) < 8e6:
                return f"data:{ctype.split(';')[0]};base64,{base64.b64encode(data).decode()}"
        return None


# ------------------------------------------------------------------ what the answer is

def room_info(mx, rid):
    """Name, network and members ({mxid: {name, avatar}}) of a room, from its state."""
    info = {"name": "", "net": "", "bridge": "", "members": {}}
    for ev in mx("GET", f"/rooms/{q(rid)}/state"):
        t, c, key = ev.get("type"), ev.get("content") or {}, ev.get("state_key", "")
        if t == "m.room.name" and key == "":
            info["name"] = c.get("name", "")
        elif t == "m.bridge" and NETWORKS.get((c.get("protocol") or {}).get("id")):
            info["net"] = NETWORKS[c["protocol"]["id"]]
            info["bridge"] = (c.get("channel") or {}).get("displayname") or ""
        elif t == "m.room.member" and c.get("membership") == "join":
            info["members"][key] = {"name": c.get("displayname") or key[1:].split(":")[0], "avatar": c.get("avatar_url")}
            bot = BOT.match(key)
            if bot and not info["net"]:
                info["net"] = {"meta": ""}.get(bot[1], bot[1])
    return info


def people(info, me):
    return [u for u in info["members"] if u != me and not BOT.match(u)]


def title(info, me):
    if info["name"]:
        return info["name"]
    if info["bridge"]:
        return info["bridge"]
    names = [info["members"][u]["name"] for u in people(info, me)]
    return ", ".join(names[:3]) + (f" +{len(names) - 3}" if len(names) > 3 else "") if names else "Chat"


def messages_since(mx, rid, since):
    """The room's messages from `since` (ms) on, oldest first, each with its newest edit and the room id."""
    flt = q(json.dumps({"types": MESSAGE_TYPES, "lazy_load_members": True}))
    out, edits, frm = [], {}, None
    for _ in range(6):  # at most 300 messages back: an answer comes after them or not at all
        r = mx("GET", f"/rooms/{q(rid)}/messages?dir=b&limit=50&filter={flt}" + (f"&from={q(frm)}" if frm else ""))
        chunk = r.get("chunk", [])
        for ev in chunk:
            c = ev.get("content") or {}
            rel = c.get("m.relates_to") or {}
            if rel.get("rel_type") == "m.replace":
                edits.setdefault(rel.get("event_id"), c.get("m.new_content") or c)
            elif ev["origin_server_ts"] >= since:
                out.append(ev)
        frm = r.get("end")
        if not frm or not chunk or chunk[-1]["origin_server_ts"] < since:
            break
    for ev in out:
        ev["room_id"] = rid
        if ev["event_id"] in edits:
            ev["content"] = edits[ev["event_id"]]
    return sorted(out, key=lambda ev: ev["origin_server_ts"])


def is_answer(ev, me):
    """A message from a person other than Karchi: not his, not a bridge bot's, not a bridge notice, not removed."""
    c = ev.get("content") or {}
    return bool(c) and ev["sender"] != me and not BOT.match(ev["sender"]) and c.get("msgtype") != "m.notice"


def answer(events, me, now, settle=SETTLE_MS):
    """(anchor, reply) once the answer to Karchi's messages has settled, else (None, None) and when to look again.
    `events` are the watched rooms' messages from the item's from_ts on, oldest first."""
    first = next((i for i, ev in enumerate(events) if is_answer(ev, me)), None)
    if first is None:
        return None, None, None
    anchor = [ev for ev in events[:first] if ev["sender"] == me and ev.get("content")][-MAX_ANCHOR:]
    reply, done = [], False
    for ev in events[first:]:
        if ev["sender"] == me and ev.get("content"):
            done = True  # Karchi wrote again: their answer is what came before
            break
        if is_answer(ev, me):
            reply.append(ev)
            if len(reply) >= MAX_REPLY:
                done = True
                break
    last = reply[-1]["origin_server_ts"]
    if done or now - last >= settle:
        return anchor, reply, None
    return None, None, last + settle


# ------------------------------------------------------------------ the picture

DAYS = ["Pondelok", "Utorok", "Streda", "Štvrtok", "Piatok", "Sobota", "Nedeľa"]


def day_label(ts, now):
    """Weft's day row ("Pondelok 16.11."): a date, not "Dnes", so the picture stays true when it goes out later."""
    d = dt.datetime.fromtimestamp(ts / 1000, TZ).date()
    year = "" if d.year == dt.datetime.fromtimestamp(now / 1000, TZ).year else str(d.year)
    return f"{DAYS[d.weekday()]} {d.day:02d}.{d.month:02d}.{year}"


def time_label(ts):
    return dt.datetime.fromtimestamp(ts / 1000, TZ).strftime("%H:%M")


def bubble(mx, ev):
    """What one message shows, as Weft's bubbleBody draws it, without anything to click."""
    c = ev.get("content") or {}
    kind, body = c.get("msgtype"), re.sub(r"^(> .*\n)+\n", "", str(c.get("body") or ""))
    caption = body if c.get("filename") and body and body != c.get("filename") else ""
    if ev["type"] == "m.sticker" or kind == "m.image":
        info = c.get("info") or {}
        most = 180 if ev["type"] == "m.sticker" else 300
        w = min(info.get("w") or most, most)
        h = round(w * info["h"] / info["w"]) if info.get("w") and info.get("h") else 200
        src = mx.media(c.get("url"), 0 if info.get("mimetype") == "image/gif" else 640)
        if src:
            return {"kind": "image", "src": src, "w": w, "h": min(h, 360), "caption": caption[:1500]}
        return {"kind": "label", "text": "[Obrázok]", "caption": caption[:1500]}
    if kind == "m.video":
        info = c.get("info") or {}
        src = mx.media(info.get("thumbnail_url"), 640)
        if src:
            w = min(info.get("w") or 300, 300)
            h = round(w * info["h"] / info["w"]) if info.get("w") and info.get("h") else 200
            return {"kind": "image", "src": src, "w": w, "h": min(h, 360), "caption": ("▶ Video" + (f" · {caption}" if caption else ""))[:1500]}
        return {"kind": "label", "text": "▶ Video", "caption": caption[:1500]}
    if kind == "m.audio":
        secs = round(((c.get("info") or {}).get("duration") or 0) / 1000)
        return {"kind": "label", "text": f"Hlasová správa {secs // 60}:{secs % 60:02d}" if secs else "Hlasová správa"}
    if kind == "m.file":
        return {"kind": "label", "text": f"Súbor: {c.get('filename') or body or 'súbor'}", "caption": caption}
    poll = c.get("org.matrix.msc3381.poll.start") or c.get("m.poll")
    if poll:
        question = poll.get("question") or {}
        return {"kind": "label", "text": "Anketa: " + str(question.get("body") or question.get("org.matrix.msc1767.text") or "" if isinstance(question, dict) else question)}
    text = (f"* {body}" if kind == "m.emote" else body).strip()
    return {"kind": "text", "text": text}


def snap_data(mx, infos, me, events, now):
    """snap.html's JSON: the chat's head and its messages, grouped and dated as Weft's chatView does."""
    rid = events[-1]["room_id"]
    info = infos[rid]
    person = people(info, me)
    group = len(person) > 1
    net = info["net"]
    icon = ICONS.get(net)
    head_avatar = None if group or not person else mx.media(info["members"][person[0]].get("avatar"), 96)
    avatars, out, prev, day = {}, [], None, ""
    for ev in events:
        sender = ev["sender"]
        who = infos[ev["room_id"]]["members"].get(sender) or {"name": sender[1:].split(":")[0]}
        if sender != me and sender not in avatars:
            avatars[sender] = mx.media(who.get("avatar"), 96)
        label = day_label(ev["origin_server_ts"], now)
        grouped = bool(prev) and prev["sender"] == sender and ev["origin_server_ts"] - prev["origin_server_ts"] < 5 * 60e3 and label == day
        out.append({**bubble(mx, ev), "mine": sender == me, "name": who["name"], "avatar": avatars.get(sender), "time": time_label(ev["origin_server_ts"]),
                    "grouped": grouped, "day": label if label != day else None})
        prev, day = ev, label
    return {"title": title(info, me), "group": group, "avatar": head_avatar,
            "net": {"name": icon[0], "icon": "file://" + os.path.join(APP_DIR, icon[1])} if icon else None, "messages": out}


def page(data):
    template = open(os.path.join(HERE, "snap.html"), encoding="utf-8").read()
    # Inside <script type="application/json"> no "<" may stay: "</script" ends the block, "<!--<script" escapes it.
    return template.replace("{{APP}}", "file://" + html.escape(APP_DIR, quote=True)).replace(
        "{{DATA}}", json.dumps(data, ensure_ascii=False).replace("<", "\\u003c"))


END = (255, 0, 255)  # snap.html's #end bar


class TooLong(Exception):
    """An answer no window holds: drawing it again cannot help, so the item fails at once with this reason."""


def render(data):
    """PNG bytes of the snap, 420 CSS px wide, cut at snap.html's end bar; and its size in pixels. A long answer is
    drawn again in a taller window until the bar is inside it (a very long one at 1× instead of 2×); an answer too
    long for the last window fails rather than giving a cut picture."""
    from PIL import Image
    work = tempfile.mkdtemp(prefix="weft-relay-")
    try:
        src, out = os.path.join(work, "snap.html"), os.path.join(work, "snap.png")
        with open(src, "w", encoding="utf-8") as f:
            f.write(page(data))
        with open(BROWSER_LOCK, "a") as lock:
            # Inside tools/browser-slot (a test) the slot is ours already: taking it again would wait on ourselves.
            if not os.environ.get("BROWSER_SLOT"):
                fcntl.flock(lock, fcntl.LOCK_EX)  # released when the file closes
            for height, scale in ((2400, 2), (6000, 2), (16000, 1), (32000, 1)):
                subprocess.run([CHROMIUM, "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", "--mute-audio",
                                f"--user-data-dir={os.path.join(work, 'profile')}", "--allow-file-access-from-files",
                                f"--force-device-scale-factor={scale}", f"--window-size=420,{height}", "--virtual-time-budget=4000",
                                "--blink-settings=preferredColorScheme=0",  # Weft is dark, as Karchi's desktop
                                f"--screenshot={out}", "file://" + src],
                               check=True, capture_output=True, timeout=120)
                img = Image.open(out).convert("RGB")
                px = img.load()
                bar = lambda y: all(px[x, y] == END for x in range(0, img.width, 7))
                end = next((y for y in range(img.height - 1, -1, -1) if bar(y)), None)
                if end is not None:
                    while end > 0 and bar(end - 1):
                        end -= 1
                    break
            else:
                raise TooLong("odpoveď je na obrázok príliš dlhá")
        img = img.crop((0, 0, img.width, end))
        # A page that did not draw (a broken template, Chromium without fonts) is not sent on as a picture.
        if img.height < 60 * scale or len(img.getcolors(4096) or range(4096)) < 8:
            raise ValueError("prázdny obrázok")
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=True)
        return buf.getvalue(), img.width, img.height
    finally:
        shutil.rmtree(work, ignore_errors=True)


def slug(text):
    text = "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c))
    return re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()[:40] or "chat"


# ------------------------------------------------------------------ the list

def items(mx):
    return mx.account(KEY).get("items", [])


def mark(mx, changes, now):
    """Writes what happened onto the list as it is now on the server: Weft may have changed it meanwhile.
    Done items stay a week, so Weft and `weft relays` can still say what happened."""
    current = items(mx)
    for it in current:
        if it.get("id") in changes and it.get("status", "waiting") == "waiting":
            it.update(changes[it["id"]])
    keep = [it for it in current if it.get("status", "waiting") == "waiting" or now - (it.get("done_at") or it.get("at") or now) < KEEP_DONE_MS]
    if changes or len(keep) != len(current):
        mx.put_account(KEY, {"items": keep})


def add_draft(mx, draft):
    """One draft per item, also when a crash makes this run twice."""
    current = mx.account(DRAFTS).get("items", [])
    if any(d.get("id") == draft["id"] for d in current):
        return
    mx.put_account(DRAFTS, {"items": current + [draft]})


def capture(mx, it, infos, anchor, reply, now):
    events = anchor + reply
    data = snap_data(mx, infos, mx.user, events, now)
    png, w, h = render(data)
    name = f"odpoved-{slug(data['title'])}.png"
    url = mx.upload(png, name, "image/png")
    draft = {"id": f"relay-{it['id']}", "room": it["to_room"], "body": it.get("note") or "", "at": now, "by": "relay",
             "files": [{"url": url, "name": name, "mimetype": "image/png", "size": len(png), "w": w, "h": h}],
             "relay": {"id": it["id"], "room": events[-1]["room_id"], "title": data["title"]}}
    add_draft(mx, draft)
    return {"status": "captured", "done_at": now, "draft_id": draft["id"], "reply_events": [ev["event_id"] for ev in reply]}


def process(mx, now=None):
    """One look at every waiting item. Returns when to look again (ms), or None when nothing waits."""
    now = int(time.time() * 1000) if now is None else now
    changes, wake, infos = {}, None, {}
    for it in items(mx):
        if it.get("status", "waiting") != "waiting":
            continue
        if not it.get("to_room") or not (it.get("rooms") or it.get("room")):
            changes[it["id"]] = {"status": "failed", "done_at": now, "error": "chýba chat"}
            continue
        if it.get("expires") and now >= it["expires"]:
            changes[it["id"]] = {"status": "expired", "done_at": now}
            continue
        if it.get("expires"):
            wake = it["expires"] if wake is None else min(wake, it["expires"])
        rooms = it.get("rooms") or [it["room"]]
        try:
            events = sorted((ev for rid in rooms for ev in messages_since(mx, rid, it.get("from_ts") or it.get("at") or now)),
                            key=lambda ev: ev["origin_server_ts"])
            anchor, reply, later = answer(events, mx.user, now)
            if reply is None:
                if later:
                    wake = later if wake is None else min(wake, later)
                continue
            for rid in rooms:
                if rid not in infos:
                    infos[rid] = room_info(mx, rid)
            changes[it["id"]] = capture(mx, it, infos, anchor, reply, now)
            log(f"captured {it['id']}: {len(anchor)}+{len(reply)} messages")
        except HttpError as e:
            if e.status == 429 or e.status >= 500:
                continue  # the server is busy: the same item on the next round
            changes[it["id"]] = {"status": "failed", "done_at": now, "error": f"server: {e.body.get('error') or e}"}
            log(f"failed {it['id']}: {e}")
        except TooLong as e:
            changes[it["id"]] = {"status": "failed", "done_at": now, "error": str(e)}
            log(f"failed {it['id']}: too long")
        except (subprocess.SubprocessError, OSError, ValueError) as e:
            tries = it.get("tries", 0) + 1
            changes[it["id"]] = {"tries": tries} if tries < TRIES else {"status": "failed", "done_at": now, "error": f"obrázok sa nepodaril: {type(e).__name__}"}
            log(f"try {tries} of {it['id']} failed: {type(e).__name__}: {e}")
            wake = now + 60_000 if wake is None else min(wake, now + 60_000)
    mark(mx, changes, now)
    return wake


def main():
    token, user = login()
    mx = Matrix(token, user)
    since = None
    log(f"watching for answers of {user}")
    while True:
        try:
            wake = process(mx)
            watched = sorted({rid for it in items(mx) if it.get("status", "waiting") == "waiting" for rid in (it.get("rooms") or [it.get("room")]) if rid})
            # /sync returns at once when the list changes or a watched room gets a message, else after `wait`.
            flt = q(json.dumps({"presence": {"not_types": ["*"]}, "account_data": {"types": [KEY]},
                                "room": {"rooms": watched, "timeline": {"limit": 1, "types": MESSAGE_TYPES},
                                         "state": {"not_types": ["*"]}, "ephemeral": {"not_types": ["*"]}, "account_data": {"not_types": ["*"]}}}))
            left = None if wake is None else wake - int(time.time() * 1000)
            wait = 30000 if left is None else max(1000, min(30000, left))
            first = since is None  # the first sync only takes a since-token; what it holds is read through /messages
            r = mx("GET", f"/sync?filter={flt}&set_presence=offline&timeout={0 if first else wait}" + ("" if first else f"&since={q(since)}"), timeout=wait / 1000 + 30)
            since = r.get("next_batch", since)
        except HttpError as e:
            if e.status == 401:
                mx.token, mx.user = login()
            else:
                log(f"error: {e}")
                time.sleep(10)
        except (OSError, ValueError) as e:
            log(f"error: {type(e).__name__}: {e}")
            time.sleep(10)


if __name__ == "__main__":
    main()

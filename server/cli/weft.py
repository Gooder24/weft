#!/usr/bin/env python3
"""weft: Karchi's Weft inbox for agents. Runs on asus; other machines reach it as `ssh asus weft ...`
(karchi-skills `weft/weft` does that by itself).

    weft chats [TEXT] [--unread] [--net NETWORK] [-n 30]   chats, newest first (TEXT filters by name)
    weft read CHAT [-n 30] [--before TS]                    the chat's messages, oldest first
    weft search TEXT [--chat CHAT] [-n 30]                  messages, homeserver and archive, newest first
    weft file ID > PATH                                     an old message's attachment (the id `read` prints with it)
    weft send CHAT [TEXT] [--file PATH]... [--reply ID] [--yes]
                                                            sends as Karchi; without --yes only says where it would go
    weft send EduPage TEXT --to TEACHER|--reply ID [--file PATH]... [--yes]
                                                            EduPage: a new message to one teacher, or an answer
    weft mail TO [TEXT] [--subject S] [--cc CC] [--from ACCOUNT] [--file PATH]... [--yes]
                                                            a new mail from Gmail or Outlook (kept in its Sent)
    weft draft CHAT [TEXT] [--file PATH]...                 a draft (text, files) that Weft puts on top of that chat's stash;
                                                            in a mail thread (archive:gmail:..., archive:outlook:...) it is
                                                            an answer by mail, in that thread, from the account it came to
    weft draft --mail TO [TEXT] [--subject S] [--cc CC] [--from ACCOUNT] [--file PATH]...
                                                            a new mail's draft: Weft shows it over the inbox, Karchi sends it
    weft drafts [--clear CHAT]                              the stash (Karchi's and agents' drafts not sent yet);
                                                            --clear takes the agents' ones in CHAT away (mail:new: new mails)
    weft relay CHAT --to FRIEND [--note TEXT] [--from ID] [--days 7] [--draft] [--show-name]
                                                            when CHAT answers Karchi, a picture of the answer is sent
                                                            to FRIEND's chat (--draft: only a draft there), without
                                                            CHAT's name and photo unless --show-name (server/relay/)
    weft relays [--cancel ID]                               what waits for an answer, and what came of it
    weft meet TITLE --start "YYYY-MM-DD HH:MM" [--end ...|--minutes 30] --with WHO... [--no-link] [--yes]
                                                            a meeting in the Teams calendar, with a Teams link unless
                                                            --no-link; WHO is an address or a name from the Teams
                                                            directory; Exchange sends the invitations (--yes to make it)
    weft ms-consent                                         what Outlook and Teams may do in Weft, what still waits
                                                            for consent, what is turned off, and the admin's link
    weft cals                                               calendars
    weft cal [--from YYYY-MM-DD] [--days 7]                 events, repeating ones expanded as Weft draws them
    weft cal-add TITLE --start "YYYY-MM-DD[ HH:MM]" [--end ...|--minutes 60] [--cal NAME] [--location] [--notes]
                 [REPEAT] [--alarm MINUTES]
    weft cal-edit UID [--title] [--start] [--end] [--location] [--notes] [--cal NAME] [REPEAT] [--alarm MINUTES|nie]
                                                            a repeating event changes as a whole series
    weft cal-del UID [--on YYYY-MM-DD]                      --on: only that day's occurrence of a series
        REPEAT: --repeat nie|denne|pracovne|tyzdenne|mesacne|rocne [--every N] [--days po,st | 2ut | -1pi]
                [--count N | --until YYYY-MM-DD]

ID is a message id from `weft --json read`. Files go up to 25 MB each (a mail's files together 18 MB on Gmail, 20 MB on Outlook); on
another machine the `weft` wrapper copies them to asus first. CHAT is a room id (!...:server, or archive:... for an old exported chat) or part of its name; a name that fits
more than one chat is refused with the list. TEXT `-` reads standard input. Every command takes --json.
Times are Europe/Bratislava. The tool logs in once as its own device ("Weft: agenti"); the token stays in
./token (0600) next to this file."""
import argparse, datetime as dt, json, mimetypes, os, re, sqlite3, stat, subprocess, sys, time, unicodedata, uuid
import urllib.error, urllib.parse, urllib.request
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
SPIKE = os.path.expanduser("~/matrix-spike")
HS = os.environ.get("HS", "http://127.0.0.1:8008")
ARCHIVE = os.environ.get("ARCHIVE", "http://127.0.0.1:29324")
CALENDAR = os.environ.get("CALENDAR", "http://127.0.0.1:29327")
LINKS = os.environ.get("LINKS", "http://127.0.0.1:29329")  # server/links/links.py: what a shared link points to
BRIDGES = os.environ.get("BRIDGES", "http://127.0.0.1:8080/_bridges")  # Caddy: /_bridges/<net>/_matrix/provision/...
TOKEN_FILE = os.environ.get("TOKEN_FILE", os.path.join(HERE, "token"))
MINT = os.path.join(SPIKE, "homeserver", "mint-login-token.py")
TZ = ZoneInfo("Europe/Bratislava")
INBOX = "sk.karchi.inbox"         # Weft's per-chat state (low, archived, ...)
MERGES = "sk.karchi.merges"       # {"groups": [{id, rooms}]}: one person's chats Weft shows as one (app.js mergeData)
DISCORD_SERVERS = "sk.karchi.discord.servers"  # {"off": {guild id: name}}: servers Karchi switched off in Weft's Settings → Účty
NICKS = "sk.karchi.nicknames"     # names Karchi gave: {user id: name} for a person, {room id: name} for a group (app.js NICKS)
DRAFTS = "sk.karchi.drafts"       # {"items": [{id, room, body, files?, at, by}]}; Weft moves each into the stash as agent:<id>
STASH = "sk.karchi.stash"         # {"items": [{id, room, body, files?, at, pos, by?}], "gone": {id: ms}} (app/stash.js)
STASH_GONE_MS = 30 * 864e5        # tombstones kept this long, as in app/stash.js


def adopted(stash, draft):
    """Weft has the agent draft in the stash, or had it and it was taken, sent or deleted."""
    sid = f"agent:{draft.get('id')}"
    return sid in (stash.get("gone") or {}) or any(it.get("id") == sid for it in stash.get("items") or [])


def drafts_left(mx):
    """sk.karchi.drafts without what Weft took into the stash. Only weft writes that list (a window writing it could
    lose a draft an agent wrote meanwhile), so it is pruned here, when an agent writes anyway."""
    stash = mx.account(STASH)
    return [x for x in mx.account(DRAFTS).get("items", []) if not adopted(stash, x)]
RELAY = "sk.karchi.relay"         # {"items": [{id, room, from_ts, to_room, note, expires, status}]}; server/relay/relay.py
RELAY_STATUS = {"waiting": "čaká na odpoveď", "captured": "odpoveď je v koncepte", "sent": "obrázok odpovede ide kamošovi", "cancelled": "zrušené", "expired": "vypršalo",
                "failed": "nepodarilo sa"}
NETWORKS = {"facebookgo": "messenger", "facebook": "messenger", "instagramgo": "instagram", "instagram": "instagram",
            "discordgo": "discord", "discord": "discord", "whatsapp": "whatsapp", "teams": "teams",
            "vinted": "vinted", "packeta": "packeta", "sms": "sms", "phone": "phone"}
READ_ONLY = {"vinted", "packeta"}  # connectors (server/connect) made from mail: nothing goes back
PHONE = {"sms", "phone"}  # beta: Karchi's phone sends it (server/connect/outbox.ts), an app's chat only as an answer
BOT = re.compile(r"^@(messenger|instagram|discord|edupage|whatsapp|gmail|telegram|teams)bot:")
EDU_FILES = "sk.karchi.edupage.files"          # files of an EduPage message, as Weft sends them
EDU_TO = "sk.karchi.edupage.to"                # the teacher's name a new EduPage message shows
EDU_RECIPIENT = "sk.karchi.edupage.recipient"  # the teacher's ghost a new EduPage message goes to
EDU_FACTS = "sk.karchi.edupage.facts"          # the bridge's facts: each notice's subject, whether it is for others
EDU_RULES = "sk.karchi.edupage.rules"          # Weft's Settings → EduPage: which types and subjects show
MAX_FILE = 25 * 1024 * 1024          # EduPage's own limit for one file
MAX_MAIL = 25 * 1024 * 1024 * 3 // 4  # a mail's files together, so Gmail still takes them after base64
MAIL_APPS = {"gmail": ("Gmail", MAX_MAIL, 18), "outlook": ("Outlook", 20 * 1024 * 1024, 20)}  # name, files' limit, MB
MESSAGE_TYPES = ["m.room.message", "m.sticker", "org.matrix.msc3381.poll.start", "m.poll.start"]
q = lambda s: urllib.parse.quote(s, safe="")


class Fail(Exception):
    pass


class HttpError(Exception):
    def __init__(self, status, body):
        super().__init__(f"{status} {body.get('errcode', '')} {body.get('error', '')}".strip())
        self.status, self.body = status, body


def http(base, method, path, body=None, token=None, timeout=60):
    req = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try: raise HttpError(e.code, json.load(e)) from None
        except json.JSONDecodeError: raise HttpError(e.code, {}) from None


class Matrix:
    def __init__(self):
        self.token, self.user = self.login()
        self.links = True  # read and search also say what shared links point to (server/links/links.py)

    @staticmethod
    def login():
        if os.path.exists(TOKEN_FILE):
            token = open(TOKEN_FILE).read().strip()
            try: return token, http(HS, "GET", "/_matrix/client/v3/account/whoami", token=token)["user_id"]
            except HttpError as e:
                if e.status != 401: raise
        one_time = subprocess.run([sys.executable, MINT], capture_output=True, text=True, check=True).stdout.strip()
        r = http(HS, "POST", "/_matrix/client/v3/login", {"type": "m.login.token", "token": one_time,
                                                          "initial_device_display_name": "Weft: agenti"})
        fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
        os.write(fd, r["access_token"].encode()); os.close(fd)
        return r["access_token"], r["user_id"]

    def __call__(self, method, path, body=None, timeout=60):
        return http(HS, method, "/_matrix/client/v3" + path, body, self.token, timeout)

    def bridge(self, net, method, path, body=None):
        sep = "&" if "?" in path else "?"
        return http(BRIDGES, method, f"/{net}/_matrix/provision/v3{path}{sep}user_id={q(self.user)}",
                    body if body is not None or method == "GET" else {}, self.token, timeout=300)

    def upload(self, f):
        req = urllib.request.Request(HS + "/_matrix/media/v3/upload?filename=" + q(f["name"]), method="POST", data=f["data"],
                                     headers={"Content-Type": f["mimetype"], "Authorization": f"Bearer {self.token}"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r: return json.load(r)["content_uri"]
        except urllib.error.HTTPError as e:
            try: raise HttpError(e.code, json.load(e)) from None
            except json.JSONDecodeError: raise HttpError(e.code, {}) from None

    def account(self, key, empty=None):
        try: return self("GET", f"/user/{q(self.user)}/account_data/{key}")
        except HttpError as e:
            if e.status == 404: return {} if empty is None else empty
            raise

    def put_account(self, key, content):
        self("PUT", f"/user/{q(self.user)}/account_data/{key}", content)


# ------------------------------------------------------------------ rooms

def fold(s):
    return "".join(c for c in unicodedata.normalize("NFD", s or "") if not unicodedata.combining(c)).casefold()


def oneline(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def summary(c):
    """One line for a message, as Weft's list shows it."""
    if not c: return "(odstránená)"
    poll = c.get("org.matrix.msc3381.poll.start") or c.get("m.poll")
    if poll:
        question = poll.get("question", {})
        return "Anketa: " + (question.get("body") or question.get("org.matrix.msc1767.text") or "" if isinstance(question, dict) else str(question))
    kinds = {"m.image": "Obrázok", "m.video": "Video", "m.audio": "Zvuková správa", "m.file": "Súbor"}
    body = re.sub(r"^(> .*\n)+\n", "", str(c.get("body", ""))).strip()
    if c.get("msgtype") in kinds:
        caption = body if c.get("filename") and body != c.get("filename") else ""
        return f"[{kinds[c['msgtype']]}{': ' + (c.get('filename') or body) if c['msgtype'] == 'm.file' else ''}]" + (" " + caption if caption else "")
    return body


def bare(name):
    """A name as its network gives it, without the WhatsApp bridge's "(WA)" tag."""
    return re.sub(r"\s+\(WA\)$", "", name or "")


class Rooms:
    """Every joined room with its name, network and last message, from one short /sync (about a second). A
    since-token would not help: Tuwunel holds every incremental /sync for at least five seconds."""
    FILTER = json.dumps({"presence": {"not_types": ["*"]}, "account_data": {"not_types": ["*"]},
                         "room": {"timeline": {"limit": 5, "types": MESSAGE_TYPES + ["m.room.member", "m.room.name", "m.bridge"]},
                                  "state": {"types": ["m.room.name", "m.room.member", "m.bridge"]},
                                  "ephemeral": {"types": ["m.receipt"]}, "account_data": {"not_types": ["*"]}}})

    def __init__(self, mx):
        self.mx = mx
        self.data = {"rooms": {}}
        self.nicks = mx.account(NICKS)
        self.servers_off = mx.account(DISCORD_SERVERS).get("off") or {}
        r = self.mx("GET", f"/sync?timeout=0&filter={q(self.FILTER)}", timeout=300)
        for rid, room in r.get("rooms", {}).get("join", {}).items():
            it = self.data["rooms"].setdefault(rid, {"id": rid, "name": "", "net": "", "bridge": "", "members": {}, "last": None})
            timeline = room.get("timeline", {}).get("events", [])
            for ev in room.get("state", {}).get("events", []) + timeline:
                self.apply(it, ev)
            # As in Weft: the server's count, and Karchi's own receipt for rooms the server does not count.
            it["count"] = (room.get("unread_notifications") or {}).get("notification_count") or 0
            it["timeline"] = {ev.get("event_id"): ev.get("origin_server_ts") for ev in timeline}
            for ev in room.get("ephemeral", {}).get("events", []):
                if ev.get("type") != "m.receipt": continue  # the server sends typing too
                for eid, kinds in (ev.get("content") or {}).items():
                    # Weft reads only public receipts (it sends no private ones); the latest sent one wins.
                    if mx.user not in (kinds.get("m.read") or {}): continue
                    sent = (kinds["m.read"][mx.user] or {}).get("ts") or 0
                    if sent >= it.get("receipt_ts", 0): it["receipt"], it["receipt_ts"] = eid, sent

    def muted(self):
        """Rooms muted on the network (a push rule without notify): the server counts none of their messages."""
        if not hasattr(self, "_muted"):
            try: g = self.mx("GET", "/pushrules/").get("global") or {}
            except (HttpError, OSError): g = {}  # without them every chat counts as the server counts it
            silent = lambda rule: rule.get("enabled") is not False and "notify" not in (rule.get("actions") or [])
            ids = {rule["rule_id"] for rule in g.get("room") or [] if silent(rule)}
            ids |= {c.get("pattern") for rule in g.get("override") or [] if not rule.get("default") and silent(rule)
                    for c in rule.get("conditions") or [] if c.get("key") == "room_id"}
            self._muted = ids
        return self._muted

    def is_new(self, rid, it):
        """Someone else wrote after Karchi read the chat, as Weft's inbox judges it (wherever he read it)."""
        last = it["last"]
        if last["sender"] == self.mx.user: return False
        if it.get("count"): return True
        if rid not in self.muted(): return False
        receipt = it.get("receipt")
        if not receipt: return True
        # Read up to the receipt's message, or up to when it was sent if later (Weft's readAt). Messages Weft still
        # holds for a reading window count here as unread.
        at = it["timeline"].get(receipt)
        if at is None:
            try: at = self.mx("GET", f"/rooms/{q(rid)}/event/{q(receipt)}").get("origin_server_ts") or 0
            except (HttpError, OSError): at = 0
        return last["ts"] > max(at, it.get("receipt_ts") or 0)

    def apply(self, it, ev):
        t, c = ev.get("type"), ev.get("content") or {}
        if t == "m.room.name" and ev.get("state_key") == "": it["name"] = c.get("name", "")
        elif t == "m.bridge" and NETWORKS.get((c.get("protocol") or {}).get("id")):
            it["net"] = NETWORKS[c["protocol"]["id"]]
            it["bridge"] = (c.get("channel") or {}).get("displayname") or ""
            net = c.get("network") or {}  # a Discord server's channel: its server, as in Weft
            if it["net"] == "discord" and net.get("id") and net["id"] != (c.get("channel") or {}).get("id"):
                it["server"], it["server_id"] = net.get("displayname") or "", net["id"]
        elif t == "m.room.member":
            who = ev.get("state_key", "")
            m = BOT.match(who)
            if m and not it["net"]: it["net"] = m.group(1)
            if who == "@hermes:" + self.mx.user.split(":", 1)[1] and not it["net"]: it["net"] = "hermes"
            if c.get("membership") == "join": it["members"][who] = c.get("displayname") or it["members"].get(who) or ""
            else: it["members"].pop(who, None)
        elif t in MESSAGE_TYPES and "state_key" not in ev:
            rel = c.get("m.relates_to") or {}
            if rel.get("rel_type") == "m.replace" or not c: return
            if not it["last"] or ev["origin_server_ts"] >= it["last"]["ts"]:
                it["last"] = {"ts": ev["origin_server_ts"], "sender": ev["sender"], "text": summary(c)[:300]}

    def people(self, it, nick=True):
        return [(nick and self.nicks.get(u)) or bare(n) or u[1:].split(":")[0] for u, n in it["members"].items() if u != self.mx.user and not BOT.match(u)]

    def title(self, it, nick=True):
        """As in Weft: Karchi's nickname for the chat or its one person, else the network's name (`nick` False: always)."""
        others = [u for u in it["members"] if u != self.mx.user and not BOT.match(u)]
        mine = nick and (self.nicks.get(it.get("id")) or (len(others) == 1 and self.nicks.get(others[0])))
        if mine: return mine
        name = it["name"] or it["bridge"]
        if name: return f"{bare(name)} · {it['server']}" if it.get("server") else bare(name)
        p = self.people(it, nick)
        return ", ".join(p[:3]) + (f" +{len(p) - 3}" if len(p) > 3 else "") if p else "Chat"

    def sender(self, rid, user):
        if user == self.mx.user: return "Ja"
        it = self.data["rooms"].get(rid) or {}
        return self.nicks.get(user) or bare((it.get("members") or {}).get(user)) or user[1:].split(":")[0]

    def name(self, rid):
        """A chat's title, also for one only the archive has."""
        if rid in self.data["rooms"]: return self.title(self.data["rooms"][rid])
        return (self.old(rid) or {}).get("title", rid)

    def old(self, rid):
        """A chat only the archive has (archive_chats), or None."""
        if not hasattr(self, "_old"): self._old = {c["room"]: c for c in archive_chats(self.mx)}
        return self._old.get(rid)

    def written(self, rid, what):
        """Fail for a chat only the archive has, saying what to do instead (`what`: koncept, správa, odpoveď). Weft never
        guesses who an old export's person is (three accounts may share the name), so nothing goes into one until Karchi
        has picked the person under it in Weft; a mail thread takes only a draft (weft draft)."""
        if not rid.startswith("archive:"): return
        c = self.old(rid) or {}
        net, title = c.get("network") or rid.split(":")[1], c.get("title") or rid
        if net in MAIL_APPS:
            raise Fail(f"„{title}“ je mailové vlákno: odpoveď do neho daj ako koncept, weft draft {rid} TEXT (Karchi ho vo Wefte upraví a odošle)")
        same = [r for r in self.listing(merge=False) if r["room"].startswith("!") and r["network"] == net and fold(r["title"]) == fold(title)]
        live = "".join(f"\n  {r['room']}  {r['network']:9} {r['title']}" for r in same[:5])
        raise Fail(f"„{title}“ je starý chat z exportu ({net}): kým ho Karchi vo Wefte nespojí so živým chatom, Weft nevie, komu presne patrí, "
                   f"tak doňho {what} nedá. " + (f"Živý chat s tým menom (over, že je to ten človek):{live}\nPotom: weft draft ROOM TEXT" if same else
                   f"Živý chat s tým menom nie je. Karchi otvorí starý chat vo Wefte a pod ním vyberie človeka (Napísať / Otvoriť chat); "
                   f"potom weft chats MENO ukáže živý chat a weft draft ROOM TEXT dá koncept tam."))

    def off(self, rid, title=None):
        """A channel of a Discord server switched off in Weft; an old one only the archive has is "Server / channel"."""
        it = self.data["rooms"].get(rid)
        if it: return it.get("server_id") in self.servers_off
        if not self.servers_off or not rid.startswith("archive:"): return False
        title = title if title is not None else self.name(rid)
        return any(title.startswith(f"{name} / ") for name in self.servers_off.values())

    def listing(self, merge=True):
        state = self.mx.account(INBOX)
        out = []
        for rid, it in self.data["rooms"].items():
            if not it["last"] or (it["net"] == "" and not it["name"] and not self.people(it)) or self.off(rid): continue
            last = it["last"]
            st = state.get(rid) or {}
            # As in Weft: someone else wrote after Karchi read it, or he marked it unread himself.
            new = self.is_new(rid, it)
            unread = bool(st.get("unread")) or new
            title, own = self.title(it), self.title(it, False)
            out.append({"room": rid, "title": title, **({"name": own} if own != title else {}), "network": it["net"] or "matrix", "ts": last["ts"],
                        "unread": unread, "new": new, "low": bool(st.get("low")), "archived": (st.get("done") or 0) >= last["ts"],
                        "last": f"{self.sender(rid, last['sender'])}: {last['text']}"})
        if merge: out = merged(out, self.mx.account(MERGES), state)  # find_chat keeps one row per network to write to
        old = [c for c in archive_chats(self.mx) if not (c["network"] == "discord" and self.off(c["room"], c["title"]))]
        return sorted(out + old, key=lambda x: -x["ts"])


def archive_chats(mx):
    """Chats only the archive has (old exports, Gmail): read-only, as in Weft's inbox."""
    try: chats = http(ARCHIVE, "GET", "/_archive/chats", token=mx.token, timeout=30).get("chats", [])
    except (HttpError, OSError) as e:
        print(f"weft: archive: {e}", file=sys.stderr)
        return []
    return [{"room": c["id"], "title": oneline(c.get("title")) or "Chat", "network": c.get("network") or "archive", "ts": c["last"]["ts"],
             "unread": False, "low": False, "archived": False, "readonly": True, **({"to": c["to"]} if isinstance(c.get("to"), dict) else {}),
             "last": f"{'Ja' if c['last'].get('me') else c['last'].get('sender', '')}: {oneline(c['last'].get('body'))[:300]}"} for c in chats]


def merged(rows, merges, state):
    """Chats Weft merged into one (sk.karchi.merges) as one row, as in its inbox: the newest member's room and
    message, networks joined with "+", `rooms` every member. Low, archived and marked unread come from the merged
    chat's own state (sk.karchi.inbox["merge:<id>"]); unread also when any member has a new message."""
    group = {rid: g.get("id") for g in merges.get("groups", []) for rid in g.get("rooms", [])}
    members = {}
    for r in sorted(rows, key=lambda x: -x["ts"]):
        gid = group.get(r["room"])
        if gid is not None: members.setdefault(gid, []).append(r)
    out = []
    for r in rows:
        gid = group.get(r["room"])
        parts = members.get(gid, [])
        if gid is None or len(parts) < 2: out.append(r); continue
        if r is not parts[0]: continue
        st = state.get("merge:" + gid) or {}
        nets = list(dict.fromkeys(p["network"] for p in parts))
        out.append(dict(r, network="+".join(nets), rooms=[p["room"] for p in parts], low=bool(st.get("low")),
                        unread=bool(st.get("unread")) or any(p.get("new") for p in parts),
                        archived=(st.get("done") or 0) >= r["ts"]))
    return out


def find_chat(rooms, mx, text):
    """A room id, or the one chat whose name contains `text` (an exact name wins over a partial one)."""
    if text.startswith("!") or text.startswith("archive:"): return text
    listing = rooms.listing(merge=False)
    want = fold(text)
    names = lambda c: [fold(c["title"]), fold(c.get("name", ""))]  # a nicknamed chat by its own name too
    exact = [c for c in listing if want in names(c)]
    hits = exact or [c for c in listing if any(want in n for n in names(c) if n)]
    if len(hits) == 1: return hits[0]["room"]
    if not hits: raise Fail(f"žiadny chat sa nevolá „{text}“ (weft chats {text!r} hľadá aj časť mena)")
    lines = "\n".join(f"  {c['room']}  {c['network']:9} {c['title']}" for c in hits[:20])
    raise Fail(f"„{text}“ sedí na {len(hits)} chatov, zadaj room id:\n{lines}")


# ------------------------------------------------------------------ shared links (the same cards as app/links.js)

LINK_NAMES = {"instagram": "Instagram", "youtube": "YouTube", "tiktok": "TikTok", "facebook": "Facebook", "x": "X"}
LINK_KINDS = {"profile": "profil", "post": "príspevok", "reel": "reel", "video": "video", "short": "Shorts", "story": "príbeh",
              "page": "stránka", "short_link": "krátky odkaz"}
LINK_SOURCES = {"oembed": "oEmbed", "oembed+watch-page": "oEmbed + stránka videa", "opengraph": "metadáta stránky",
                "video-page": "stránka videa", "video-page+subtitles": "stránka videa + titulky"}
LINK_RE = re.compile(r'https?://(?:(?!https?://)[^\s<>"\[\]])+', re.I)
# A mail's links are often its sender's click tracking: in mail only a known platform's link is read by itself.
LINK_HELD = {"status": "held", "reason": "Odkaz z mailu sa nečíta sám — môže byť sledovací. Prečítaj ho: weft link <odkaz>"}


def links_in(text):
    """The links in a text worth a card, each page once, at most three, without the sentence's closing punctuation;
    not one inside an HTML attribute and not a picture (a mail's pictures are often tracking pixels)."""
    out, text = [], str(text or "")
    for m in LINK_RE.finditer(text):
        if re.search(r'=["\']?$', text[max(0, m.start() - 2):m.start()]): continue
        url = m.group(0)
        while url:
            last = url[-1]
            if last in ".,;:!?'\"»“”’…\ufe0f" or unicodedata.category(last) in ("So", "Sk", "Cf"): url = url[:-1]  # also an emoji
            elif last == ")" and url.count("(") < url.count(")"): url = url[:-1]
            elif last == "]" and "[" not in url: url = url[:-1]
            else: break
        try: parts = urllib.parse.urlsplit(url)
        except ValueError: continue
        if not parts.hostname or re.search(r"\.(gif|png|jpe?g|webp|svg|ico|bmp)$", parts.path, re.I): continue
        try: url = link_href(url)
        except ValueError: continue
        if not any(_same(u, url) for u in out): out.append(url)
        if len(out) == 3: break
    return out


def link_href(url):
    """The address as a browser writes it (WHATWG URL.href, as Weft's app sends it): the host lowercased and an IDN
    one in punycode, the default port dropped, non-ASCII and unsafe characters percent-encoded. ValueError if bad."""
    p = urllib.parse.urlsplit(url)
    scheme, host = p.scheme.lower(), p.hostname or ""
    try:
        host = host.lower() if host.isascii() else host.encode("idna").decode("ascii")
    except UnicodeError as e:
        raise ValueError(f"bad host: {e}") from None
    if ":" in host:
        host = f"[{host}]"
    port = p.port  # ValueError for a port that is not a number
    netloc = host + (f":{port}" if port is not None and port != {"http": 80, "https": 443}.get(scheme) else "")
    if "@" in p.netloc:
        netloc = p.netloc.rsplit("@", 1)[0] + "@" + netloc
    enc = lambda s, unsafe: "".join(c if c.isascii() and c > " " and c not in unsafe else urllib.parse.quote(c, safe="") for c in s)
    return urllib.parse.urlunsplit((scheme, netloc, enc(p.path or "/", '"<>`{}'), enc(p.query, "\"<>'"), enc(p.fragment, '"<>`')))


def _same(a, b):
    """One page under two spellings, as app/links.js same(): ?v= and ?id= name the page."""
    def key(u):
        u = urllib.parse.urlsplit(u)
        if (u.hostname or "") == "youtu.be":
            return ("youtube.com", "/watch", (u.path.split("/") + [""])[1], "")
        qs = urllib.parse.parse_qs(u.query)
        return (re.sub(r"^(www|m)\.", "", u.netloc.lower()), u.path.rstrip("/"), (qs.get("v") or [""])[0], (qs.get("id") or [""])[0])
    return key(a) == key(b)


def link_classify(url):
    """(platform, kind) from the address alone, as app/links.js classify()."""
    try: u = urllib.parse.urlsplit(url)
    except ValueError: return "web", "page"
    host = re.sub(r"^(www|m)\.", "", (u.hostname or "").lower())
    parts = [x for x in u.path.split("/") if x]
    p0 = parts[0] if parts else ""
    if host in ("instagram.com", "instagr.am"):
        if p0 == "p": return "instagram", "post"
        if p0 in ("reel", "reels", "tv"): return "instagram", "reel"
        if p0 == "stories": return "instagram", "story"
        return "instagram", "profile" if parts else "page"
    if host in ("youtube.com", "music.youtube.com", "youtu.be", "youtube-nocookie.com"):
        if host == "youtu.be" or p0 in ("watch", "live", "embed"): return "youtube", "video"
        if p0 == "shorts": return "youtube", "short"
        return "youtube", "profile" if p0.startswith("@") or p0 in ("channel", "c", "user") else "page"
    if host in ("vm.tiktok.com", "vt.tiktok.com") or (host == "tiktok.com" and p0 == "t"): return "tiktok", "short_link"
    if host == "tiktok.com":
        if len(parts) >= 3 and parts[1] in ("video", "photo"): return "tiktok", "video" if parts[1] == "video" else "post"
        return "tiktok", "profile" if p0.startswith("@") else "page"
    if host in ("facebook.com", "fb.com", "fb.watch", "web.facebook.com"):
        if host == "fb.watch" or "videos" in parts or p0 in ("watch", "reel"): return "facebook", "video"
        if p0 == "share" or "posts" in parts or p0 == "permalink.php": return "facebook", "post"
        return "facebook", "profile" if parts else "page"
    if host in ("x.com", "twitter.com", "mobile.twitter.com"): return "x", "post" if "status" in parts else "profile" if parts else "page"
    return "web", "page"


def from_bridge(c, links):
    out = {}
    previews = c.get("com.beeper.linkpreviews") if isinstance(c.get("com.beeper.linkpreviews"), list) else []
    for url in links:
        p = next((x for x in previews if isinstance(x, dict) and any(isinstance(u, str) and (u == url or _same(u, url))
                                                                      for u in (x.get("matched_url"), x.get("og:url")))), None)
        if p:
            out[url] = {"title": str(p.get("og:title") or ""), "description": str(p.get("og:description") or ""), "source": "bridge"}
    shared = c.get("external_url") if isinstance(c.get("external_url"), str) else ""
    caption, title = str(c.get("com.beeper.meta.caption_body_text") or ""), str(c.get("com.beeper.meta.full_post_title") or "")
    if shared and (caption or title):
        key = next((u for u in links if _same(u, shared)), shared)
        out[key] = {**out.get(key, {}), "title": title or out.get(key, {}).get("title", ""), "description": caption, "source": "bridge-post"}
    return out


def link_card(url, bridge, read):
    ok = not read or read.get("status") in ("ok", "partial")
    platform, kind = ((read["platform"], read.get("kind") or "page") if (read or {}).get("platform") else link_classify(url))
    name = LINK_NAMES.get(platform) or urllib.parse.urlsplit((read or {}).get("final_url") or url).hostname.removeprefix("www.")
    c = {"url": url, "platform": platform, "kind": kind, "name": name, "kindName": LINK_KINDS.get(kind, kind),
         "title": (read and ok and read.get("title")) or ((not read or not ok or (bridge or {}).get("source") == "bridge-post") and (bridge or {}).get("title")) or "",
         "description": (read and ok and read.get("description")) or ((not read or not ok or (bridge or {}).get("source") == "bridge-post") and (bridge or {}).get("description")) or "",
         "author": (ok and ((read or {}).get("author") or {}).get("name")) or "",
         "status": read["status"] if read else "bridge" if bridge else "error", "reason": (read or {}).get("reason", "")}
    src = [x for x in ((bridge and ("príspevok z mosta" if bridge.get("source") == "bridge-post" else "náhľad z mosta")),
                       (read and ok and LINK_SOURCES.get(read.get("source"), read.get("source")))) if x]
    c["source"] = " + ".join(src)
    cap = (read or {}).get("captions") or {}
    c["transcript"] = "" if kind not in ("video", "short", "reel") else \
        f"Prepis: nečítaný — {name} má titulky ({', '.join(cap.get('languages') or [])}), ale bez prehliadača ich nevydá." if cap.get("state") == "listed" else \
        f"Prepis z titulkov{' (' + cap['language'] + ')' if cap.get('language') else ''}: {cap.get('text', '')}" if cap.get("state") == "read" else \
        "Prepis: nie je k dispozícii — video samo nikto neprečítal, toto je iba jeho popis."
    return c


def card_text(c):
    head = f"[{c['name']} · {c['kindName']}{' · ' + c['author'] if c['author'] else ''}]"
    if c["status"] not in ("ok", "partial", "bridge") and not c["title"]:
        return [f"{head} {c['reason'] or 'nedostupné'}"]
    return [x for x in (f"{head} {c['title']}".strip(), c["description"], c["transcript"],
                        c["reason"] if c["reason"] and c["status"] != "ok" else "", f"zdroj: {c['source']}" if c["source"] else "") if x]


def room_net(rooms, rid):
    """A chat's network; mail lives only in the archive, under ids its importer gives (archive:gmail:..., archive:outlook:...)."""
    for app in MAIL_APPS:
        if rid.startswith(f"archive:{app}:"): return app
    return rooms.data["rooms"].get(rid, {}).get("net", "")


def link_read(mx, url):
    try: return http(LINKS, "GET", f"/_links/resolve?url={q(url)}", token=mx.token, timeout=30)
    except (HttpError, OSError) as e: return {"status": "error", "reason": f"čítačka odkazov neodpovedala ({e})", "platform": "", "kind": ""}


def link_cards(mx, c, net=""):
    """Cards for the links of one message content; the original text and links stay as they are. In mail (gmail, outlook)
    only links to a known platform are read; others say how to read them on purpose."""
    links = links_in(re.sub(r"^(> .*\n)+\n", "", str(c.get("body", ""))))
    if isinstance(c.get("external_url"), str) and not any(_same(u, c["external_url"]) for u in links):
        links = (links + [c["external_url"]])[:3]
    if not links: return []
    bridge = from_bridge(c, links)
    cards = []
    for url in links:
        read = LINK_HELD if net in MAIL_APPS and link_classify(url)[0] == "web" else link_read(mx, url)
        card = link_card(url, bridge.get(url), read)
        card["lines"] = card_text(card)
        cards.append(card)
    return cards


# ------------------------------------------------------------------ messages

def edu_hidden(mx):
    """Whether Weft hides a school notice by Karchi's Settings → EduPage over the bridge's facts (app.js noticeShow),
    so agents read EduPage as he sees it and never have to guess what is his."""
    facts, rules = mx.account(EDU_FACTS), mx.account(EDU_RULES)
    prefs = {"arrivals": False, "meals": False, **mx.account("sk.karchi.edupage.prefs")}
    by_pref = {"pipnutie": "arrivals", "strava_vydaj": "meals"}
    auto = {s["id"]: s.get("mine") is not False for s in facts.get("subjects") or []}
    said = rules.get("subjects") if isinstance(rules.get("subjects"), dict) else {}

    def hidden(c):
        if c.get("msgtype") != "m.notice" or not c.get("sk.karchi.edupage"): return False
        kind = c.get("sk.karchi.edupage.kind") or ""
        rule = ((rules.get("kinds") or {}).get(kind) or {}).get("show") or ("hidden" if kind == "substitution" else "inbox")
        if rule == "hidden" or (kind in by_pref and not prefs.get(by_pref[kind])): return True
        fact = (facts.get("items") or {}).get(str(c["sk.karchi.edupage"])) or {}
        if fact.get("others") and not rules.get("others"): return True
        subject = fact.get("subject")
        return bool(subject) and said.get(subject, auto.get(subject, True)) is False
    return hidden


def matrix_messages(mx, rooms, rid, limit, before=None):
    flt = json.dumps({"types": MESSAGE_TYPES, "lazy_load_members": True})
    out, edits, frm = [], {}, None
    while len(out) < limit:
        path = f"/rooms/{q(rid)}/messages?dir=b&limit={min(100, limit * 2)}&filter={q(flt)}" + (f"&from={q(frm)}" if frm else "")
        r = mx("GET", path)
        for ev in r.get("state", []):
            if ev.get("type") == "m.room.member" and (ev.get("content") or {}).get("displayname"):
                rooms.data["rooms"].setdefault(rid, {"members": {}}).setdefault("members", {}).setdefault(ev["state_key"], ev["content"]["displayname"])
        for ev in r.get("chunk", []):
            c = ev.get("content") or {}
            rel = c.get("m.relates_to") or {}
            if rel.get("rel_type") == "m.replace":
                edits.setdefault(rel.get("event_id"), c.get("m.new_content") or c)
                continue
            if before and ev["origin_server_ts"] >= before: continue
            out.append(ev)
        frm = r.get("end")
        if not frm or not r.get("chunk"): break
    msgs = []
    hidden = edu_hidden(mx) if room_net(rooms, rid) == "edupage" else (lambda c: False)
    for ev in out[:limit]:
        c = edits.get(ev["event_id"]) or ev.get("content") or {}
        if hidden(c): continue
        msgs.append({"id": ev["event_id"], "ts": ev["origin_server_ts"], "sender": rooms.sender(rid, ev["sender"]),
                     "me": ev["sender"] == mx.user, "text": summary(c), "edited": ev["event_id"] in edits,
                     "links": link_cards(mx, c, room_net(rooms, rid)) if c and mx.links else []})
    return msgs


def matrix_raw(mx, rid, limit):
    """The room's last messages as events, oldest first, without edits."""
    flt = json.dumps({"types": MESSAGE_TYPES, "lazy_load_members": True})
    r = mx("GET", f"/rooms/{q(rid)}/messages?dir=b&limit={limit}&filter={q(flt)}")
    return [ev for ev in reversed(r.get("chunk", [])) if not ((ev.get("content") or {}).get("m.relates_to") or {}).get("rel_type") == "m.replace"]


def archive_messages(mx, rid, limit, before, net=""):
    """Older messages from the archive's SQLite on asus, read-only: never asks a bridge for more history."""
    sys.path.insert(0, os.path.join(SPIKE, "archive"))
    import archive  # its query conditions, so an export row the homeserver also has shows once
    c = sqlite3.connect(f"file:{archive.DB}?mode=ro", uri=True, timeout=30)
    try:
        rows = c.execute(f"""SELECT m.id, m.ts, m.sender, m.me, m.body FROM messages m JOIN chats c ON c.id = m.chat
            WHERE COALESCE(c.room,'archive:'||c.id) = ? AND m.ts < ? AND {archive.HISTORY_VISIBLE}
              AND c.source != 'matrix' AND (c.source != 'messenger-export' OR NOT {archive.NATIVE_DUPLICATE})
            ORDER BY m.ts DESC, m.id DESC LIMIT ?""", (rid, before or 2**62, limit)).fetchall()
        files = archive.message_files(c, [r[0] for r in rows])
    finally: c.close()
    return [{"id": i, "ts": ts, "sender": "Ja" if me else s, "me": bool(me), "text": with_files(b, files.get(i, [])), "archive": True,
             **({"files": files[i]} if i in files else {}),
             "links": link_cards(mx, {"body": b}, net) if mx.links else []} for i, ts, s, me, b in rows]


FILE_LABELS = {"image": "Fotka", "video": "Video", "audio": "Zvuková správa", "file": "Súbor"}


def with_files(text, files):
    """An old message's text with each attachment line naming the id `weft file` downloads it by."""
    lines = text.split("\n") if text else []
    for f in files:
        tag = f"  (weft file {f['id']}" + (f", {size_of(f['size'])}" if f.get("size") else "") + ")"
        label = f"[{FILE_LABELS.get(f['kind'], 'Súbor')}]"
        # "[Súbor] name" from Discord, a bare "[Fotka]" from an export: either line becomes the file's.
        at = next((n for n, line in enumerate(lines) if line.startswith("[") and line.endswith("] " + f["name"])), None)
        if at is None: at = next((n for n, line in enumerate(lines) if line.strip() == label), None)
        if at is None: lines.append(f"{label} {f['name']}{tag}")
        else: lines[at] = f"{label} {f['name']}{tag}"
    return "\n".join(lines)


def read(mx, rooms, rid, limit, before=None):
    msgs = [] if rid.startswith("archive:") else matrix_messages(mx, rooms, rid, limit, before)
    if len(msgs) < limit:
        oldest = min([m["ts"] for m in msgs], default=before)
        seen = {(m["ts"] // 1000, m["text"]) for m in msgs}
        msgs += [m for m in archive_messages(mx, rid, limit - len(msgs), oldest, room_net(rooms, rid)) if (m["ts"] // 1000, m["text"]) not in seen]
    return sorted(msgs, key=lambda m: m["ts"])


def search(mx, rooms, text, limit, room=None):
    out = []
    try:
        body = {"search_categories": {"room_events": {"search_term": text, "order_by": "recent",
                                                      "filter": {"types": MESSAGE_TYPES, **({"rooms": [room]} if room else {}), "limit": limit}}}}
        res = mx("POST", "/search", body, timeout=60)["search_categories"]["room_events"].get("results", [])
        hidden = None
        for hit in res:
            ev = hit["result"]
            if room_net(rooms, ev["room_id"]) == "edupage":
                hidden = hidden or edu_hidden(mx)
                if hidden(ev.get("content") or {}): continue
            out.append({"room": ev["room_id"], "ts": ev["origin_server_ts"], "sender": rooms.sender(ev["room_id"], ev["sender"]),
                        "text": summary(ev.get("content")), "content": ev.get("content") or {}})
    except HttpError as e:
        print(f"weft: homeserver search: {e}", file=sys.stderr)
    try:
        for m in http(ARCHIVE, "GET", f"/_archive/search?q={q(text)}&limit={limit * 3 if room else limit}", token=mx.token, timeout=60).get("results", []):
            if room and m["room"] != room: continue
            out.append({"room": m["room"], "ts": m["ts"], "sender": "Ja" if m.get("me") else m["sender"], "text": m["body"], "archive": True,
                        "content": {"body": m["body"]}})
    except (HttpError, OSError) as e:
        print(f"weft: archive search: {e}", file=sys.stderr)
    seen, uniq = set(), []
    for m in sorted(out, key=lambda m: -m["ts"]):
        key = (m["room"], m["ts"] // 1000, m["text"])
        if key in seen or rooms.off(m["room"]): continue
        seen.add(key)
        m["chat"] = rooms.name(m["room"])
        uniq.append(m)
    for m in uniq[:limit]:
        content = m.pop("content", {})
        m["links"] = link_cards(mx, content, room_net(rooms, m["room"])) if mx.links else []
    return uniq[:limit]


# ------------------------------------------------------------------ calendar

def cal_doc(mx):
    r = http(CALENDAR, "GET", "/_calendar/doc", token=mx.token)
    if not r.get("doc"): raise Fail("kalendár je zatiaľ prázdny (kalendár sa pridá vo Wefte: Nastavenia → Kalendár)")
    return r["doc"]


def cal_ops(mx, ops):
    try: return http(CALENDAR, "POST", "/_calendar/ops", {"ops": ops}, token=mx.token)
    except HttpError as e: raise Fail(f"kalendár odmietol zmenu: {e.body.get('error') or e}") from None


def parse_when(s, end=False):
    """'2026-11-12' (a whole day) or '2026-11-12 14:00' / 'T14:00', local time -> (datetime, all_day)."""
    s = s.strip().replace("T", " ")
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s): return dt.datetime.fromisoformat(s).replace(tzinfo=TZ), True
        return dt.datetime.fromisoformat(s).replace(tzinfo=TZ), False
    except ValueError: raise Fail(f"nerozumiem času „{s}“: píš 2026-11-12 alebo 2026-11-12 14:00") from None


def iso(d):
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def from_iso(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(TZ)


def find_cal(doc, name):
    cals = doc["calendars"]
    if not name: return next((c for c in cals if not c["id"].startswith("lifeos-")), cals[0])
    hits = [c for c in cals if c["id"] == name] or [c for c in cals if fold(name) in fold(c.get("name", ""))]
    if len(hits) != 1: raise Fail(f"kalendár „{name}“: " + ("žiadny" if not hits else "viac") + ". Sú: " + ", ".join(c.get("name", c["id"]) for c in cals))
    return hits[0]


WD = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
UTC = dt.timezone.utc


def _list(v):
    return v if isinstance(v, list) else str(v).split(",") if v not in (None, "") else []


def _ints(v):
    return [int(str(x).strip()) for x in _list(v) if re.fullmatch(r"-?\d+", str(x).strip())]


def _weekdays(v):
    return [str(x).strip().upper() for x in _list(v) if str(x).strip()]


def parse_until(v):
    """UNTIL as iCalendar writes it; a bare date means the whole of that local day."""
    m = re.fullmatch(r"(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?", str(v or ""))
    if not m: return None
    y, mo, d = int(m[1]), int(m[2]), int(m[3])
    if m[4] is None: return dt.datetime(y, mo, d, 23, 59, 59, 999000, tzinfo=TZ)
    return dt.datetime(y, mo, d, int(m[4]), int(m[5]), int(m[6]), tzinfo=UTC if m[7] else TZ)


def _month_days(y, m, first, byday, bymd):
    size = (dt.date(y + m // 12, m % 12 + 1, 1) - dt.timedelta(days=1)).day
    md = [size + 1 + n if n < 0 else n for n in bymd]
    if byday:
        dates = []
        for t in byday:
            mt = re.fullmatch(r"(-?\d+)?(MO|TU|WE|TH|FR|SA|SU)", t)
            if not mt: continue
            days = [d for d in range(1, size + 1) if dt.date(y, m, d).weekday() == WD.index(mt[2])]
            if not mt[1]: dates += days
            else:
                k = int(mt[1]); i = k - 1 if k > 0 else len(days) + k
                if 0 <= i < len(days): dates.append(days[i])
        if md: dates = [d for d in dates if d in md]
    else: dates = md or [first.day]
    return sorted({d for d in dates if 1 <= d <= size})


def _setpos(rule, dates):
    pos = _ints(rule.get("BYSETPOS"))
    if not pos: return dates
    return sorted({dates[p - 1] if p > 0 else dates[p] for p in pos if p and abs(p) <= len(dates)})


def occurrences(ev, lo, hi):
    """The event's (start, end) overlapping [lo, hi): the same reading of the rule as Weft (app/calendar.js) and
    Kalendarix 2: FREQ, INTERVAL, COUNT, UNTIL, BYDAY (2TU, -1FR), BYMONTHDAY, BYMONTH, BYSETPOS, EXDATE days."""
    start = from_iso(ev["start"])
    end = from_iso(ev["end"]) if ev.get("end") else start
    length = max(end - start, dt.timedelta())
    all_day = bool(ev.get("allDay"))
    last = (start.astimezone(UTC) + length - dt.timedelta(milliseconds=1)).astimezone(TZ) if length else start
    span = max(1, last.date().toordinal() - start.date().toordinal() + 1)

    def end_of(s):
        if all_day: return dt.datetime.combine(s.date() + dt.timedelta(days=span), dt.time(), TZ)
        return (s.astimezone(UTC) + length).astimezone(TZ)

    def overlaps(s, e): return s < hi and e > lo if e > s else lo <= s < hi
    rule = ev.get("rrule") or None
    if not rule or not rule.get("FREQ"):
        e = end_of(start)
        return [(start, e)] if overlaps(start, e) else []
    freq = rule["FREQ"]
    interval = max(1, int(rule.get("INTERVAL") or 1))
    until = parse_until(rule.get("UNTIL")) if rule.get("UNTIL") else None
    count = int(rule["COUNT"]) if rule.get("COUNT") else None
    skip = {from_iso(x).date() for x in ev.get("exdates") or [] if isinstance(x, str) and x}
    byday, bymd = _weekdays(rule.get("BYDAY")), _ints(rule.get("BYMONTHDAY"))
    bymonth = sorted({m for m in _ints(rule.get("BYMONTH")) if 1 <= m <= 12})
    allowed = sorted({WD.index(t[-2:]) for t in byday if t[-2:] in WD})
    wall = start.replace(tzinfo=None).time()

    def dates(n):
        if freq == "DAILY":
            d = start.date() + dt.timedelta(days=n * interval)
            return [d] if not allowed or d.weekday() in allowed else []
        if freq == "WEEKLY":
            d = start.date() + dt.timedelta(weeks=n * interval)
            monday = d - dt.timedelta(days=d.weekday())
            return [monday + dt.timedelta(days=i) for i in allowed] if allowed else [d]
        if freq == "MONTHLY":
            m0 = start.month - 1 + n * interval
            y, m = start.year + m0 // 12, m0 % 12 + 1
            return _setpos(rule, [dt.date(y, m, d) for d in _month_days(y, m, start, byday, bymd)])
        if freq == "YEARLY":
            y = start.year + n * interval
            return _setpos(rule, [dt.date(y, m, d) for m in (bymonth or [start.month]) for d in _month_days(y, m, start, byday, bymd)])
        return None

    # A long series without COUNT starts a little before the window instead of at its first day.
    longest = {"DAILY": 1, "WEEKLY": 7, "MONTHLY": 31, "YEARLY": 366}.get(freq, 1) * interval
    gap = (lo - length - start).days
    n0 = 0 if count or gap <= 0 else max(0, gap // longest - 2)
    out, produced = [], 0
    for n in range(n0, n0 + 20000):
        ds = dates(n)
        if ds is None: break
        for d in ds:
            s = dt.datetime.combine(d, wall).replace(tzinfo=TZ)
            if s < start: continue
            if (count is not None and produced >= count) or (until is not None and s > until) or s >= hi: return out
            produced += 1
            if d not in skip:
                e = end_of(s)
                if overlaps(s, e): out.append((s, e))
    return out


REPEATS = {"nie": None, "none": None, "denne": "DAILY", "daily": "DAILY", "pracovne": "WORKDAYS", "workdays": "WORKDAYS",
           "tyzdenne": "WEEKLY", "weekly": "WEEKLY", "mesacne": "MONTHLY", "monthly": "MONTHLY", "rocne": "YEARLY", "yearly": "YEARLY"}
DAY_NAMES = {"po": "MO", "ut": "TU", "st": "WE", "št": "TH", "stv": "TH", "pi": "FR", "so": "SA", "ne": "SU", **{d.lower(): d for d in WD}}


def rule_from(a, start, old=None):
    """The rrule asked for by --repeat/--every/--days/--count/--until (Weft's editor writes the same)."""
    if a.repeat is None and not any(x is not None for x in (a.every, a.days, a.count, a.until)): return old
    if a.repeat is not None:
        if fold(a.repeat) not in REPEATS: raise Fail(f"--repeat: {a.repeat}? Píš nie, denne, pracovne, tyzdenne, mesacne alebo rocne")
        kind = REPEATS[fold(a.repeat)]
        if kind is None: return None
        rule = {"FREQ": "DAILY", "INTERVAL": 1, "BYDAY": WD[:5]} if kind == "WORKDAYS" else {"FREQ": kind, "INTERVAL": 1}
    elif old: rule = dict(old)
    else: raise Fail("--every/--days/--count/--until patria k --repeat")
    if a.every is not None: rule["INTERVAL"] = max(1, a.every)
    if a.days is not None:
        days = []
        for t in a.days.split(","):
            m = re.fullmatch(r"(-?\d)?\s*(\S+)", t.strip().lower())
            code = m and (DAY_NAMES.get(m[2]) or DAY_NAMES.get(fold(m[2])))
            if not code: raise Fail(f"--days: deň „{t.strip()}“? Píš po,ut,st,št,pi,so,ne (mesačne aj 2ut, -1pi)")
            days.append((m[1] or "") + code)
        rule["BYDAY"] = days
    if a.count is not None or a.until is not None: rule.pop("COUNT", None); rule.pop("UNTIL", None)
    if a.count is not None: rule["COUNT"] = max(1, a.count)
    if a.until is not None:
        day = parse_when(a.until)[0]
        rule["UNTIL"] = day.replace(hour=23, minute=59, second=59).astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
    return rule


def alarm_from(v):
    if v is None: return None
    if fold(v) in ("nie", "none", ""): return ""
    if not v.isdigit(): raise Fail("--alarm: minúty pred začiatkom (15, 60, 1440) alebo nie")
    return int(v)


# ------------------------------------------------------------------ output

def when(ts):
    d = dt.datetime.fromtimestamp(ts / 1000, TZ)
    return d.strftime("%H:%M" if d.date() == dt.datetime.now(TZ).date() else "%d.%m.%Y %H:%M")


def text_arg(words):
    text = sys.stdin.read() if words == ["-"] else " ".join(words)
    if not text.strip(): raise Fail("prázdny text")
    return text.strip()


def size_of(n):
    return f"{n / 2**20:.1f} MB" if n >= 2**20 else f"{max(1, round(n / 1024))} kB"


def files_arg(paths, limit=MAX_FILE):
    """The files to send, read before anything goes out, so a missing or too big one stops the whole message."""
    out = []
    for path in paths or []:
        if not os.path.isfile(path): raise Fail(f"súbor {path} neexistuje")
        size = os.path.getsize(path)
        if size > limit: raise Fail(f"{os.path.basename(path)} má {size_of(size)}, viac ako {limit // 2**20} MB")
        name = os.path.basename(path)
        out.append({"name": name, "mimetype": mimetypes.guess_type(name)[0] or "application/octet-stream", "size": size,
                    "data": open(path, "rb").read()})
    return out


def mail_accounts(mx):
    """Mail logins that can send, each with its app (gmail, outlook); Fail when there is none."""
    accounts, down = [], []
    for app in MAIL_APPS:  # one mail bridge down must not stop mail from the other
        try:
            logins = mx.bridge(app, "GET", "/whoami").get("logins") or []
            accounts += [{**l, "app": app} for l in logins if isinstance(l, dict) and isinstance(l.get("id"), str)
                         and l["id"] and (l.get("name") is None or isinstance(l["name"], str))
                         and not (isinstance(l.get("state"), dict) and l["state"].get("state_event") == "BAD_CREDENTIALS")]
        except (HttpError, OSError, ValueError, AttributeError, TypeError):  # down, or an answer that is not a bridge's
            down.append(MAIL_APPS[app][0])
    if not accounts:
        raise Fail(f"{' ani '.join(down)} teraz neodpovedá" if down else "vo Wefte nie je pripojený žiadny Gmail ani Outlook")
    return accounts


def put_draft(mx, room, text, files, mail=None):
    """An agent's draft in sk.karchi.drafts; Weft puts it on top of the chat's stash (room "mail:new": over the inbox
    as a new mail). `mail`: {to, subject, from: "<app>:<login>", cc?}, what the mail form opens with."""
    item = {"id": str(uuid.uuid4()), "room": room, "body": text, "at": int(time.time() * 1000), "by": os.environ.get("WEFT_BY") or "agent"}
    if mail: item["mail"] = mail
    if files: item["files"] = [{"url": mx.upload(f), "name": f["name"], "mimetype": f["mimetype"], "size": f["size"]} for f in files]
    mx.put_account(DRAFTS, {"items": drafts_left(mx) + [item]})
    return item


def pick(items, text, what, label):
    """The one item whose label is `text` or contains it; otherwise the candidates."""
    want = fold(text)
    exact = [i for i in items if fold(label(i)) == want]
    hits = exact or [i for i in items if want in fold(label(i))]
    if len(hits) == 1: return hits[0]
    if not hits: raise Fail(f"žiadny {what} sa nevolá „{text}“")
    raise Fail(f"„{text}“ sedí na viac ({len(hits)}), spresni:\n" + "\n".join("  " + label(i) for i in hits[:20]))


def discord_reply_ok(ev):
    """The Discord bridge has no threads: a reply to a message from one would go to the whole channel, and so may a
    reply to a deleted one (no content left to tell)."""
    content = ev.get("content") or {}
    if content.get("m.relates_to", {}).get("rel_type") == "m.thread":
        raise Fail("správa je z vlákna na Discorde: odpoveď by odišla do celého kanála, odpovedz v appke Discord")
    if not content or "redacted_because" in (ev.get("unsigned") or {}):
        raise Fail("správa je zmazaná: odpoveď na ňu by mohla odísť do celého kanála, napíš bez --reply")


def message_of(mx, rid, eid):
    try: return mx("GET", f"/rooms/{q(rid)}/event/{q(eid)}")
    except HttpError as e:
        if e.status in (400, 404): raise Fail(f"správa {eid} v tomto chate nie je (id daj z weft --json read)")
        raise


def main(argv=None):
    p = argparse.ArgumentParser(prog="weft", description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 1)[1])
    p.add_argument("--json", action="store_true", help="JSON instead of lines")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("chats"); s.add_argument("text", nargs="?"); s.add_argument("--unread", action="store_true")
    s.add_argument("--net"); s.add_argument("-n", type=int, default=30); s.add_argument("--all", action="store_true", help="also low and archived")
    s = sub.add_parser("read"); s.add_argument("chat"); s.add_argument("-n", type=int, default=30); s.add_argument("--before", type=int, help="ms timestamp")
    s.add_argument("--no-links", action="store_true", help="skip what shared links point to")
    s = sub.add_parser("search"); s.add_argument("text", nargs="+"); s.add_argument("--chat"); s.add_argument("-n", type=int, default=30)
    s.add_argument("--no-links", action="store_true", help="skip what shared links point to")
    s = sub.add_parser("file", help="an old message's attachment, to standard output"); s.add_argument("id", type=int)
    s = sub.add_parser("link", help="what one link points to (also a mail's link that is not read by itself)"); s.add_argument("url")
    s = sub.add_parser("send"); s.add_argument("chat"); s.add_argument("text", nargs="*"); s.add_argument("--yes", action="store_true")
    s.add_argument("--file", action="append", metavar="PATH"); s.add_argument("--reply", metavar="ID"); s.add_argument("--to", metavar="TEACHER")
    s = sub.add_parser("mail"); s.add_argument("to"); s.add_argument("text", nargs="*"); s.add_argument("--yes", action="store_true")
    s.add_argument("--subject", default=""); s.add_argument("--cc", default=""); s.add_argument("--from", dest="frm", metavar="ACCOUNT")
    s.add_argument("--file", action="append", metavar="PATH")
    s = sub.add_parser("meet"); s.add_argument("title", nargs="+"); s.add_argument("--start", required=True); s.add_argument("--end")
    s.add_argument("--minutes", type=int, default=30); s.add_argument("--with", dest="who", action="append", default=[], metavar="WHO")
    s.add_argument("--no-link", action="store_true"); s.add_argument("--yes", action="store_true")
    sub.add_parser("ms-consent")
    s = sub.add_parser("draft"); s.add_argument("chat", nargs="?"); s.add_argument("text", nargs="*"); s.add_argument("--file", action="append", metavar="PATH")
    s.add_argument("--mail", metavar="TO"); s.add_argument("--subject", default=""); s.add_argument("--cc", default=""); s.add_argument("--from", dest="frm", metavar="ACCOUNT")
    s = sub.add_parser("relay"); s.add_argument("chat"); s.add_argument("--to", required=True, metavar="FRIEND")
    s.add_argument("--note", default=""); s.add_argument("--from", dest="frm", metavar="ID"); s.add_argument("--days", type=float, default=7)
    s.add_argument("--draft", action="store_true"); s.add_argument("--show-name", action="store_true")
    s = sub.add_parser("relays"); s.add_argument("--cancel", metavar="ID")
    s = sub.add_parser("drafts"); s.add_argument("--clear", metavar="CHAT")
    sub.add_parser("cals")
    s = sub.add_parser("cal"); s.add_argument("--from", dest="frm"); s.add_argument("--days", type=int, default=7); s.add_argument("--cal")
    def repeat_args(s):
        s.add_argument("--repeat"); s.add_argument("--every", type=int); s.add_argument("--days"); s.add_argument("--count", type=int)
        s.add_argument("--until"); s.add_argument("--alarm")
    s = sub.add_parser("cal-add"); s.add_argument("title", nargs="+"); s.add_argument("--start", required=True); s.add_argument("--end")
    s.add_argument("--minutes", type=int); s.add_argument("--cal"); s.add_argument("--location", default=""); s.add_argument("--notes", default="")
    repeat_args(s)
    s = sub.add_parser("cal-edit"); s.add_argument("uid"); s.add_argument("--title"); s.add_argument("--start"); s.add_argument("--end")
    s.add_argument("--location"); s.add_argument("--notes"); s.add_argument("--cal"); repeat_args(s)
    s = sub.add_parser("cal-del"); s.add_argument("uid"); s.add_argument("--on")
    a = p.parse_args(argv)

    mx = Matrix()
    mx.links = not getattr(a, "no_links", False)
    out = lambda obj, lines: print(json.dumps(obj, ensure_ascii=False, indent=1) if a.json else "\n".join(lines))

    if a.cmd.startswith("cal"):
        doc = cal_doc(mx)
        if a.cmd == "cals":
            return out([{"id": c["id"], "name": c.get("name"), "events": len(c.get("events", []))} for c in doc["calendars"]],
                       [f"{c['id']}  {c.get('name')}  ({len(c.get('events', []))})" for c in doc["calendars"]])
        if a.cmd == "cal":
            lo = parse_when(a.frm)[0] if a.frm else dt.datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0)
            hi = lo + dt.timedelta(days=a.days)
            rows = []
            for c in [find_cal(doc, a.cal)] if a.cal else doc["calendars"]:
                for ev in c.get("events", []):
                    for s0, e0 in occurrences(ev, lo, hi):
                        rows.append({"start": s0.isoformat(), "end": e0.isoformat(), "allDay": bool(ev.get("allDay")), "title": ev.get("title"),
                                     "calendar": c.get("name"), "uid": ev.get("uid"), "location": ev.get("location") or "", "repeats": bool(ev.get("rrule")),
                                     "rrule": ev.get("rrule") or None})
            rows.sort(key=lambda r: r["start"])
            fmt = lambda r: (f"{r['start'][:10]} celý deň" if r["allDay"] else f"{r['start'][:10]} {r['start'][11:16]}–{r['end'][11:16]}") + \
                f"  {r['title']}  [{r['calendar']}]" + (f" @ {r['location']}" if r["location"] else "") + ("  ↻" if r["repeats"] else "") + f"  uid={r['uid']}"
            return out(rows, [fmt(r) for r in rows] or ["(nič)"])
        if a.cmd == "cal-add":
            start, all_day = parse_when(a.start)
            if a.end: end = parse_when(a.end)[0] + (dt.timedelta(days=1) if all_day else dt.timedelta())
            else: end = start + (dt.timedelta(days=1) if all_day else dt.timedelta(minutes=a.minutes or 60))
            if end <= start: raise Fail("koniec je pred začiatkom")
            c = find_cal(doc, a.cal)
            ev = {"uid": f"weft-{uuid.uuid4()}", "title": " ".join(a.title), "start": iso(start), "end": iso(end), "allDay": all_day,
                  "location": a.location, "notes": a.notes, "description": a.notes, "rrule": rule_from(a, start), "exdates": [],
                  "alarmMinutes": alarm_from(a.alarm) if a.alarm is not None else ""}
            cal_ops(mx, [{"op": "put", "cal": c["id"], "event": ev}])
            return out({"calendar": c.get("name"), **ev}, [f"pridané do {c.get('name')}: {ev['title']}  uid={ev['uid']}" + ("  ↻" if ev["rrule"] else "")])
        found = [(c, e) for c in doc["calendars"] for e in c.get("events", []) if e.get("uid") == a.uid]
        if not found: raise Fail(f"žiadna udalosť s uid {a.uid}")
        c, old = found[0]
        if a.cmd == "cal-del" and a.on:
            if not old.get("rrule"): raise Fail("--on patrí k opakovanej udalosti; táto sa neopakuje")
            day = parse_when(a.on)[0].replace(hour=0, minute=0)
            hit = occurrences(old, day, day + dt.timedelta(days=1))
            hit = [x for x in hit if x[0].date() == day.date()]
            if not hit: raise Fail(f"{a.on} sa „{old.get('title')}“ nekoná")
            cal_ops(mx, [{"op": "put", "cal": c["id"], "event": {**old, "exdates": [*(old.get("exdates") or []), iso(hit[0][0])]}}])
            return out({"deleted": a.uid, "on": a.on}, [f"zmazané len {a.on}: {old.get('title')}"])
        if a.cmd == "cal-del":
            cal_ops(mx, [{"op": "del", "cal": c["id"], "uid": a.uid}])
            return out({"deleted": a.uid}, [f"zmazané: {old.get('title')}" + (" (celá séria)" if old.get("rrule") else "")])
        ev = dict(old)
        if a.title is not None: ev["title"] = a.title
        if a.location is not None: ev["location"] = a.location
        if a.notes is not None: ev["notes"] = ev["description"] = a.notes
        if a.start:
            start, all_day = parse_when(a.start)
            # The length stays, unless the event turns all-day (one day) or timed (an hour).
            length = from_iso(old["end"]) - from_iso(old["start"]) if all_day == bool(old.get("allDay")) else \
                dt.timedelta(days=1) if all_day else dt.timedelta(hours=1)
            ev |= {"start": iso(start), "allDay": all_day, "end": iso(start + (length if not a.end else dt.timedelta()))}
        if a.end:
            end, day = parse_when(a.end)
            ev["end"] = iso(end + (dt.timedelta(days=1) if day else dt.timedelta()))
        if from_iso(ev["end"]) <= from_iso(ev["start"]): raise Fail("koniec je pred začiatkom")
        ev["rrule"] = rule_from(a, from_iso(ev["start"]), old.get("rrule"))
        if a.alarm is not None: ev["alarmMinutes"] = alarm_from(a.alarm)
        to = find_cal(doc, a.cal) if a.cal else c
        ops = ([{"op": "del", "cal": c["id"], "uid": a.uid}] if to["id"] != c["id"] else []) + [{"op": "put", "cal": to["id"], "event": ev}]
        cal_ops(mx, ops)
        return out(ev, [f"zmenené: {ev['title']} ({to.get('name')})"])

    if a.cmd == "meet":
        start, all_day = parse_when(a.start)
        if all_day: raise Fail("stretnutie potrebuje čas: --start \"2026-11-12 14:00\"")
        end = parse_when(a.end)[0] if a.end else start + dt.timedelta(minutes=a.minutes)
        if end <= start: raise Fail("koniec je pred začiatkom")
        if not a.who: raise Fail("s kým? --with adresa alebo meno")
        logins = [l for l in mx.bridge("teams", "GET", "/whoami").get("logins") or [] if isinstance(l, dict) and l.get("id")
                  and not (isinstance(l.get("state"), dict) and l["state"].get("state_event") == "BAD_CREDENTIALS")]
        if not logins: raise Fail("vo Wefte nie je pripojený Teams")
        people = []
        for who in a.who:
            if "@" in who: people.append((who, who)); continue
            found = [r for r in mx.bridge("teams", "POST", "/search_users", {"query": who}).get("results") or []
                     if any(str(i).startswith("teams:") and "@" in str(i) for i in r.get("identifiers") or [])]
            person = pick(found, who, "človek v Teams", lambda r: r.get("name") or "")
            people.append((person["name"], next(str(i)[6:] for i in person["identifiers"] if str(i).startswith("teams:") and "@" in str(i))))
        utc = lambda d: d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        lines = [f"Stretnutie: {' '.join(a.title)}", f"Kedy: {start:%Y-%m-%d %H:%M}–{end:%H:%M}" + ("" if end.date() == start.date() else f" ({end:%Y-%m-%d})"),
                 "S: " + ", ".join(f"{n} <{m}>" if n != m else m for n, m in people), "Teams link: " + ("nie" if a.no_link else "áno")]
        if not a.yes:
            return out({"sent": False, "attendees": [m for _, m in people]}, ["NEVYTVORENÉ (pozvánky by odišli hneď)."] + lines + ["Pridaj --yes, ak to Karchi chce."])
        body = {"subject": " ".join(a.title), "start": utc(start), "end": utc(end), "online": not a.no_link,
                "attendees": ", ".join(f"{n.replace(',', ' ')} <{m}>" if n != m else m for n, m in people)}
        try: made = mx.bridge("teams", "POST", f"/meeting/{q(logins[0]['id'])}", body)
        except HttpError as e: raise Fail(e.body.get("error") or str(e)) from None
        return out({"sent": True, **made}, lines + [f"vytvorené v Teams kalendári; pozvánky poslal Microsoft" + ("; Teams link je v pozvánke" if made.get("joinUrl") else "")])

    if a.cmd == "ms-consent":
        reports, lines, link = {}, [], ""
        for app in ("outlook", "teams"):
            try: reports[app] = mx.bridge(app, "GET", "/consent")
            except (HttpError, OSError, ValueError) as e: lines.append(f"{app}: neodpovedá ({e})"); continue
            link = link or reports[app].get("admin_url", "")
            for l in reports[app].get("logins") or []:
                missing = l.get("missing") or []
                head = f"{app.capitalize()} {l.get('name')}: "
                if l.get("error"): lines.append(head + l["error"]); continue
                lines.append(head + ("smie všetko" if not missing else "čaká: " + ", ".join(
                    m["what"] + (" (len správca)" if m.get("admin") else "") for m in missing)))
        if not any(r.get("logins") for r in reports.values()): lines.append("vo Wefte nie je pripojený Outlook ani Teams")
        off = [c["name"] for r in list(reports.values())[:1] for c in r.get("choices") or [] if not c.get("on")]
        if off: lines.append("vypnuté vo Wefte (Nastavenia → Účty → Outlook/Teams): " + ", ".join(off))
        return out(reports, lines + ([f"Správca schváli všetko vybrané pre celú firmu týmto odkazom: {link}"] if link else []))

    if a.cmd == "mail" or (a.cmd == "draft" and a.mail):
        if a.cmd == "draft":
            a.to, a.text, a.yes = a.mail, ([a.chat] if a.chat else []) + a.text, False
            if not re.search(r"[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+", a.to): raise Fail(f"„{a.to}“ nie je e-mailová adresa")
        text = text_arg(a.text) if a.text else ""
        if not text and not a.file: raise Fail("mail je prázdny")
        accounts = mail_accounts(mx)
        label = lambda l: l.get("name") or l["id"]
        acc = pick(accounts, a.frm, "účet", label) if a.frm else accounts[0]
        app_name, limit, mb = MAIL_APPS[acc["app"]]
        files = files_arg(a.file, limit)
        if sum(f["size"] for f in files) > limit: raise Fail(f"prílohy sú spolu väčšie ako {mb} MB, {app_name} ich neprijme")
        sender = label(acc)
        lines = [f"Z: {sender}", f"Komu: {a.to}"] + ([f"Kópia: {a.cc}"] if a.cc else []) + [f"Predmet: {a.subject}", f"Text: {text}"] + \
            [f"Príloha: {f['name']} ({size_of(f['size'])})" for f in files]
        if a.cmd == "draft":
            mail = {"to": a.to, "subject": a.subject, "from": f"{acc['app']}:{acc['id']}", **({"cc": a.cc} if a.cc else {})}
            item = put_draft(mx, "mail:new", text, files, mail)
            return out(item, ["koncept mailu je vo Wefte navrchu zoznamu (Koncept mailu); odošle ho Karchi"] + lines)
        if not a.yes:
            return out({"from": sender, "to": a.to, "sent": False}, ["NEODOSLANÉ."] + lines +
                       ["Pridaj --yes, ak to Karchi chce poslať, alebo ho daj Karchimu do Weftu: weft draft --mail ADRESA TEXT --subject ..."])
        uploaded = [{"url": mx.upload(f), "name": f["name"], "mimetype": f["mimetype"]} for f in files]
        mx.bridge(acc["app"], "POST", f"/send/{q(acc['id'])}", {"to": a.to, "cc": a.cc, "subject": a.subject, "text": text, "files": uploaded})
        return out({"from": sender, "to": a.to, "sent": True}, [f"mail odišiel z {sender} na {a.to}; {app_name} ho má v Odoslanej pošte"])

    if a.cmd == "file":
        if sys.stdout.isatty(): raise Fail(f"súbor ide na štandardný výstup: weft file {a.id} > NÁZOV")
        req = urllib.request.Request(f"{ARCHIVE}/_archive/media/{a.id}", headers={"Authorization": f"Bearer {mx.token}"})
        try: res = urllib.request.urlopen(req, timeout=180)
        except urllib.error.HTTPError as e:
            raise Fail({404: f"súbor {a.id} archív nemá", 502: f"súbor {a.id} sa teraz nedá stiahnuť (Discord alebo homeserver neodpovedá)"}.get(e.code, f"súbor {a.id}: {e.code}")) from None
        with res:
            name = urllib.parse.unquote((re.search(r"filename\*=UTF-8''([^;]+)", res.headers.get("Content-Disposition") or "") or [None, ""])[1])
            size = 0
            while chunk := res.read(1 << 20):
                sys.stdout.buffer.write(chunk); size += len(chunk)
        sys.stdout.buffer.flush()
        print(f"{name or a.id} ({size_of(size)})", file=sys.stderr)
        return
    if a.cmd == "link":
        url = (links_in(a.url) or [""])[0]
        if not url: raise Fail("to nie je http(s) odkaz")
        card = link_card(url, None, link_read(mx, url))
        card["lines"] = card_text(card)
        return out(card, card["lines"])

    rooms = Rooms(mx)
    if a.cmd == "chats":
        rows = rooms.listing()
        if not a.all: rows = [r for r in rows if not r["archived"]]
        if a.unread: rows = [r for r in rows if r["unread"] and not r["low"]]
        if a.net: rows = [r for r in rows if a.net in r["network"].split("+")]
        if a.text: rows = [r for r in rows if fold(a.text) in fold(r["title"]) or fold(a.text) in fold(r.get("name", ""))]
        rows = rows[:a.n]
        # A Discord announcement channel says so, as in Weft (the archive reads its type from the bridge).
        if any("discord" in r["network"].split("+") for r in rows):
            try: kinds = http(ARCHIVE, "GET", "/_archive/discord/channels", token=mx.token, timeout=30).get("channels", {})
            except Exception: kinds = {}
            for r in rows:
                if (kinds.get(r["room"]) or {}).get("type") == 5: r["kind"] = "oznamy"
        return out(rows, [f"{'●' if r['unread'] else ' '} {when(r['ts']):>16}  {r['network']:9} {r['title']}{' [oznamy]' if r.get('kind') else ''}  —  {oneline(r['last'])[:120]}  ({r['room']})" for r in rows] or ["(nič)"])
    if a.cmd == "read":
        rid = find_chat(rooms, mx, a.chat)
        msgs = read(mx, rooms, rid, a.n, a.before)
        head = f"# {rooms.name(rid)} ({rid})"
        return out({"room": rid, "messages": msgs}, [head] + [line for m in msgs for line in
                   [f"{when(m['ts']):>16}  {m['sender']}: {m['text']}"] + [f"{'':>18}↳ {x}" for card in m.get("links", []) for x in card["lines"]]])
    if a.cmd == "search":
        rid = find_chat(rooms, mx, a.chat) if a.chat else None
        hits = search(mx, rooms, " ".join(a.text), a.n, rid)
        return out(hits, [line for m in hits for line in [f"{when(m['ts']):>16}  {m['chat']}  {m['sender']}: {oneline(m['text'])[:200]}"]
                          + [f"{'':>18}↳ {oneline(x)[:300]}" for card in m.get("links", []) for x in card["lines"]]] or ["(nič)"])
    if a.cmd == "send":
        rid = find_chat(rooms, mx, a.chat)
        rooms.written(rid, "správu")
        text, files = text_arg(a.text) if a.text else "", files_arg(a.file)
        if not text and not files: raise Fail("prázdny text")
        net = rooms.data["rooms"].get(rid, {}).get("net") or "matrix"
        if net in READ_ONLY: raise Fail(f"{net} je len na čítanie (z mailov): odpíš priamo v ňom")
        if net in PHONE and files: raise Fail("cez telefón ide zatiaľ len text")
        if net == "phone" and not a.reply: raise Fail("chat appky z telefónu má veľa ľudí: odpovedz na konkrétnu správu, --reply ID")
        where = f"{rooms.name(rid)} ({net}, {rid})"
        edu = net == "edupage"
        lines = []
        if a.reply:
            ev = message_of(mx, rid, a.reply)
            if net == "discord": discord_reply_ok(ev)
            lines.append(f"Odpoveď na: {rooms.sender(rid, ev['sender'])}: {oneline(summary(ev.get('content')))[:120]}")
        teacher = None
        if a.to:
            if not edu: raise Fail("--to je len pre EduPage; inde napíš do chatu toho človeka")
            if a.reply: raise Fail("buď --to (nová správa), alebo --reply (odpoveď), nie oboje")
            teacher = pick(mx.bridge("edupage", "GET", "/contacts").get("contacts", []), a.to, "učiteľ", lambda t: t["name"])
            lines.append(f"Nová správa pre: {teacher['name']}")
        elif edu and not a.reply:
            raise Fail("EduPage potrebuje adresáta: --to UČITEĽ (nová správa) alebo --reply ID (odpoveď na správu)")
        lines += [f"Text: {text}"] + [f"Súbor: {f['name']} ({size_of(f['size'])})" for f in files]
        if not a.yes:
            return out({"room": rid, "sent": False}, [f"NEODOSLANÉ. Odišlo by do: {where}"] + lines + ["Pridaj --yes, ak to Karchi chce poslať."])
        send = lambda content: mx("PUT", f"/rooms/{q(rid)}/send/m.room.message/weft-cli-{uuid.uuid4()}", content).get("event_id")
        reply = {"m.relates_to": {"m.in_reply_to": {"event_id": a.reply}}} if a.reply else {}
        if edu:
            # One message, as Weft sends it: the bridge uploads the files to EduPage and says in the chat if it refuses.
            content = {"msgtype": "m.text", "body": text or ", ".join(f["name"] for f in files), **reply}
            if teacher: content |= {EDU_TO: teacher["name"], EDU_RECIPIENT: teacher["id"]}
            if files: content[EDU_FILES] = [{"name": f["name"], "url": mx.upload(f), "mimetype": f["mimetype"], "size": f["size"]} for f in files]
            ids = [send(content)]
            note = "; EduPage ju dostane do pár sekúnd (ak ju odmietne, most to napíše do chatu: weft read EduPage)"
        else:
            ids, urls = [], [mx.upload(f) for f in files]
            # Read again after the uploads: the message may have been deleted meanwhile.
            if net == "discord" and a.reply: discord_reply_ok(message_of(mx, rid, a.reply))
            for f, url in zip(files, urls):
                kind = {"image": "m.image", "video": "m.video", "audio": "m.audio"}.get(f["mimetype"].split("/")[0], "m.file")
                ids.append(send({"msgtype": kind, "body": f["name"], "filename": f["name"], "url": url,
                                 "info": {"mimetype": f["mimetype"], "size": f["size"]}, **(reply if not ids else {})}))
            if text: ids.append(send({"msgtype": "m.text", "body": text, **(reply if not ids else {})}))
            note = ""
        if net in PHONE: note = f"; odíde z telefónu (beta), a ak neodíde, prečo uvidíš v chate: weft read {rid}"
        return out({"room": rid, "sent": True, "event_ids": ids}, [f"odoslané do {where}" + note])
    if a.cmd == "draft":
        if not a.chat: raise Fail("komu: weft draft CHAT TEXT, alebo weft draft --mail ADRESA TEXT")
        rid = find_chat(rooms, mx, a.chat)
        net = room_net(rooms, rid)
        mail = None
        if rid.startswith("archive:"):
            if net not in MAIL_APPS: rooms.written(rid, "koncept")
            # An answer by mail, as Weft's „Odpovedať mailom“: to the newest sender, from the account it came to.
            to = (rooms.old(rid) or {}).get("to") or {}
            if not to.get("mail"):
                raise Fail(f"vo vlákne „{rooms.name(rid)}“ písal len Karchi, Weft nevie, komu odpovedať: weft draft --mail ADRESA TEXT --subject 'Re: …'")
            acc = next((l for l in mail_accounts(mx) if l["app"] == net and (l.get("name") or l["id"]).lower() == str(to.get("account") or "").lower()), None)
            if not acc: raise Fail(f"účet {to.get('account')}, na ktorý vlákno prišlo, nie je vo Wefte pripojený; odpovedať sa dá až po jeho pripojení")
            mail = {"to": to["mail"], "subject": to.get("subject") or "", "from": f"{net}:{acc['id']}"}
        text = text_arg(a.text) if a.text else ""
        files = files_arg(a.file, MAIL_APPS[net][1]) if mail else files_arg(a.file)
        if not text and not files: raise Fail("koncept je prázdny")
        if mail and sum(f["size"] for f in files) > MAIL_APPS[net][1]: raise Fail(f"prílohy sú spolu väčšie ako {MAIL_APPS[net][2]} MB, {MAIL_APPS[net][0]} ich neprijme")
        item = put_draft(mx, rid, text, files, mail)
        where = f"v mailovom vlákne {rooms.name(rid)} (navrchu v Odložených; Vziať ho otvorí ako odpoveď: Komu {mail['to']}, {mail['subject']})" if mail \
            else f"v chate {rooms.name(rid)} (navrchu v Odložených)"
        return out(item, [f"koncept je vo Wefte {where}" + (f" ({len(files)} súbor/y)" if files else "") + "; odošle ho Karchi"])
    if a.cmd == "relay":
        rid, to = find_chat(rooms, mx, a.chat), find_chat(rooms, mx, a.to)
        if rid.startswith("archive:") and room_net(rooms, rid) not in MAIL_APPS: rooms.written(rid, "sledovanie")
        if rid.startswith("archive:"): raise Fail("mailové vlákno: na odpoveď v ňom Weft nečaká (len chaty)")
        rooms.written(to, "obrázok")
        if rid == to: raise Fail("odpoveď a kamoš sú ten istý chat")
        now = int(time.time() * 1000)
        if a.frm: anchor = message_of(mx, rid, a.frm)
        else: anchor = next((ev for ev in reversed(matrix_raw(mx, rid, 30)) if ev["sender"] == mx.user), None)
        item = {"id": str(uuid.uuid4()), "room": rid, "from_event": anchor and anchor["event_id"], "from_ts": anchor["origin_server_ts"] if anchor else now,
                "to_room": to, "note": a.note, "send": not a.draft, "who": a.show_name, "at": now, "expires": now + int(a.days * 864e5), "status": "waiting", "by": os.environ.get("WEFT_BY") or "agent"}
        mx.put_account(RELAY, {"items": mx.account(RELAY).get("items", []) + [item]})
        how = "ako koncept do" if a.draft else "rovno do"
        return out(item, [f"čakám na odpoveď v {rooms.name(rid)}; obrázok pôjde {how} {rooms.name(to)}"
                          + ("" if a.show_name else f" (bez mena a fotky z {rooms.name(rid)})")])
    if a.cmd == "relays":
        items = mx.account(RELAY).get("items", [])
        if a.cancel:
            hit = [x for x in items if x["id"] == a.cancel or x["id"].startswith(a.cancel)]
            if len(hit) != 1: raise Fail(f"„{a.cancel}“ nesedí na jedno sledovanie (weft relays ukáže id)")
            if hit[0].get("status", "waiting") != "waiting": raise Fail(f"už {RELAY_STATUS.get(hit[0]['status'], hit[0]['status'])}")
            hit[0].update({"status": "cancelled", "done_at": int(time.time() * 1000)})
            mx.put_account(RELAY, {"items": items})
            return out(hit[0], [f"zrušené: {rooms.name(hit[0]['room'])} → {rooms.name(hit[0]['to_room'])}"])
        return out(items, [f"{x['id'][:8]}  {when(x['at']):>16}  {rooms.name(x['room'])} → {rooms.name(x['to_room'])}: "
                           f"{RELAY_STATUS.get('sent' if x.get('later') else x.get('status', 'waiting'), x.get('status'))}" + (f" ({x['error']})" if x.get("error") else "")
                           for x in items] or ["(nič nečaká)"])
    if a.cmd == "drafts":
        stash = mx.account(STASH)
        if a.clear:
            rid = a.clear if a.clear == "mail:new" else find_chat(rooms, mx, a.clear)  # mail:new: the new mails' drafts
            items = drafts_left(mx)
            mx.put_account(DRAFTS, {"items": [x for x in items if x["room"] != rid]})
            # The agents' items in the stash get a tombstone, as Weft's own removal does; Karchi's stay. Read again
            # right before writing: a window's change made meanwhile is kept (and windows re-apply theirs anyway).
            stash = mx.account(STASH)
            now = int(time.time() * 1000)
            gone = {k: v for k, v in (stash.get("gone") or {}).items() if isinstance(v, (int, float)) and now - v < STASH_GONE_MS}
            mine = [it for it in stash.get("items") or [] if it.get("room") == rid and it.get("by")]
            gone.update({it["id"]: now for it in mine} | {f"agent:{x['id']}": now for x in items if x["room"] == rid})
            mx.put_account(STASH, {"items": [it for it in stash.get("items") or [] if it.get("id") not in gone], "gone": gone})
            return out({"cleared": rid}, [f"koncepty agentov v {rooms.name(rid)} zmazané"])
        items = sorted(stash.get("items") or [], key=lambda x: -(x.get("pos") or x.get("at") or 0))
        waiting = [x for x in mx.account(DRAFTS).get("items", []) if not adopted(stash, x)]
        shown = items + [{**x, "waiting": True} for x in waiting]
        name = lambda x: f"nový mail pre {(x.get('mail') or {}).get('to', '?')}: {(x.get('mail') or {}).get('subject', '')}" if x["room"] == "mail:new" else rooms.name(x["room"])
        return out(shown, [f"{when(x.get('at') or 0):>16}  {name(x)}: {oneline(x.get('body') or '')[:200]}" +
                           (f" [{', '.join(f['name'] for f in x['files'])}]" if x.get("files") else "") +
                           (f" (od {x['by']})" if x.get("by") else "") + (" (Weft ho ešte nevzal)" if x.get("waiting") else "")
                           for x in shown] or ["(žiadne)"])


if __name__ == "__main__":
    try: main()
    except Fail as e: sys.exit(f"weft: {e}")
    except HttpError as e: sys.exit(f"weft: server: {e}")
    except (OSError, urllib.error.URLError) as e: sys.exit(f"weft: asus neodpovedá: {e}")

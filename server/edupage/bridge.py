"""EduPage in the matrix-spike client.

All of EduPage is one Matrix room, "EduPage", in time order. A message that starts a thread is a
plain message; replies in that thread are Matrix replies to it. People are ghost users
(@edupage_<id>); messages the admin wrote are sent as the admin through the double-puppet
appservice. EduPage has no push, so the bridge polls it every few minutes. What the admin
writes in the room is pushed to the bridge by the homeserver (appservice transactions); a
Matrix reply goes to EduPage as a reply in the thread of the message it answers.

The admin chooses in the client (account data sk.karchi.edupage.prefs) whether arrivals and
meals appear in the room as notices; grade notifications also appear in the inbox; the full grade book goes to account data
sk.karchi.edupage.grades for the client's grade bar.

Login speaks the subset of the mautrix bridgev2 provisioning API that the client's Accounts
page uses, so EduPage looks like any other bridge there:

  GET  /_matrix/provision/v3/whoami
  POST /_matrix/provision/v3/login/start/password
  POST /_matrix/provision/v3/login/step/<process>/<step>/<user_input|display_and_wait>
  POST /_matrix/provision/v3/login/cancel/<process>
  POST /_matrix/provision/v3/logout/<login>

Only the admin Matrix user may call it.
"""
import collections
import hashlib
import html
import json
import os
import queue
import re
import sqlite3
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import closing
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from edupage_api import Edupage
from edupage_api.exceptions import (
    BadCredentialsException,
    CaptchaException,
    SecondFactorFailedException,
)
from edupage_api.compression import RequestData
from edupage_api.login_session import LoginSession

HOMESERVER = os.environ.get("HOMESERVER", "http://127.0.0.1:8008")
ADMIN = os.environ["ADMIN_MXID"]
SERVER_NAME = ADMIN.split(":", 1)[1]
STATE_DIR = Path(os.environ.get("STATE_DIR", Path(__file__).resolve().parent))
ACCOUNT_FILE = STATE_DIR / "account.json"
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "300"))
# Each poll re-reads this many days; the first sync after a login reads the whole school year.
RECENT_DAYS = 7
# On the first sync, messages older than this start as read instead of all looking new.
SETTLE_AFTER_DAYS = 7
PREFS_TYPE = "sk.karchi.edupage.prefs"
GRADES_TYPE = "sk.karchi.edupage.grades"
# Written by the bridge for the client: {"colors": {ghost mxid: "#rrggbb"}, "me": "<own name>"}.
PEOPLE_TYPE = "sk.karchi.edupage.people"
# Written by the bridge: what EduPage's own data says about whose things are whose (see school_facts), so neither
# Weft nor an agent has to guess which subject a notice is about or whether it is Karchi's.
FACTS_TYPE = "sk.karchi.edupage.facts"
# Written by Weft (Settings → EduPage): {"kinds": {kind: {"show", "color", "icon"}}, "subjects": {id: bool}}; the
# bridge reads "subjects", Karchi's own word on which subjects are his, for the Testy calendar.
RULES_TYPE = "sk.karchi.edupage.rules"
# Subject ids once seen in Karchi's own timetable stay his: a subject taught in blocks is not in every week.
LEARNED_KV = "timetable_subjects"
ACTIONS_KEY = "sk.karchi.edupage.actions"
# Content key on a thread's first message: whom it was sent to, as EduPage words it.
TO_KEY = "sk.karchi.edupage.to"
# Content key on a new message the admin starts in Matrix: the ghost mxid of the one person it goes to.
RECIPIENT_KEY = "sk.karchi.edupage.recipient"
# Content key on a reply the admin writes: "all" sends it to everyone the thread went to, anything else only to its
# author. Weft asks only in threads REPLIES_TYPE marks "all"; elsewhere EduPage has one answer anyway.
REPLY_TO_KEY = "sk.karchi.edupage.reply_to"
# Written by the bridge for Weft: {root event id: "all" | "author"} for threads that did not go to Karchi alone:
# "all" when a reply may go to everyone or to the author alone, "author" when the author allowed only the latter.
REPLIES_TYPE = "sk.karchi.edupage.replies"
DEFAULT_PREFS = {"polls": True, "arrivals": False, "meals": False}
# Timeline types shown as notices when the admin turns them on, with the pref that controls them.
NOTICE_TYPES = {"pipnutie": "arrivals", "strava_vydaj": "meals"}
# School announcements are inbox items, independently of optional arrival/meal notifications.
SCHOOL_TYPES = {"znamka", "signin", "event", "homework", "confirmation"}


def school_notice(item: dict) -> bool:
    """Keep future text announcement types too; only optional notices and chat messages are excluded."""
    kind = item.get("typ")
    return bool(kind and kind not in {"sprava", "substitution", *NOTICE_TYPES}
                and (kind in SCHOOL_TYPES or item_message(item)))
SCHOOL_PATHS = {"znamka": "znamky/", "signin": "signin/", "event": "user/", "homework": "user/"}
# Notices are about today; turning a type on does not replay the whole school year.
NOTICE_MAX_AGE = 24 * 3600 * 1000
GRADES_EVERY = 30 * 60
# Content key on a homework notice: the files its material cards carry, uploaded to Matrix:
# [{"name", "url": mxc, "mimetype", "size", "w", "h"}]. Text from the cards goes into the body.
FILES_KEY = "sk.karchi.edupage.files"
# The same list on a message the admin writes: those files go to EduPage with it as attachments.
# Content key on a sign-up notice: {"name", "type", "from", "to", "chosen": [option], "confirmed"}, times
# as EduPage's local "YYYY-MM-DD HH:MM:SS"; "chosen" is absent until Karchi has signed up on EduPage.
SIGNIN_KEY = "sk.karchi.edupage.signin"
# Each homework's material is read once; a handful per poll keeps a fresh login's backfill gentle.
MATERIALS_PER_POLL = 5
MAX_FILE_BYTES = 25 * 1024 * 1024
WEEKDAYS = ["pondelok", "utorok", "streda", "štvrtok", "piatok", "sobota", "nedeľa"]
# Content key on everything the bridge posts, so its own events are never sent back to EduPage.
MARK = "sk.karchi.edupage"
# Tests go into Weft's calendar (server/calendar/kalendar.py) under this calendar name.
CALENDAR_URL = os.environ.get("CALENDAR_URL", "http://127.0.0.1:29327")
TESTS_CALENDAR = "Testy"
TIMETABLE_CALENDAR = "lifeos-edupage"
# Kalendarix EduPage's backend (on dell), which fills that calendar from EduPage's daily plan. When the school uploads
# a substitution or a school event, EduPage posts a timeline notice ("Na stránku bolo nahraté nové suplovanie"); the
# bridge then asks the backend to read the plan again at once instead of at its next round. Empty turns it off.
TIMETABLE_URL = os.environ.get("TIMETABLE_URL", "").rstrip("/")  # from ~/.config/weft/weft.env
TIMETABLE_TOKEN = os.environ.get("TIMETABLE_TOKEN", "")  # the backend's KX_TOKEN, when it has one
TIMETABLE_KV = "timetable_notice"
TIMETABLE_TRIES_KV = "timetable_tries"  # survives a restart, so a failing notice is not tried 3 more times
TIMETABLE_NOTICES = {"substitution", "event"}
# A refresh that failed (backend down, EduPage slow) is asked again on the next polls, this many times per notice.
TIMETABLE_TRIES = 3
# Handled notices remembered (they leave the fetched week anyway); the newest ids sort last.
TIMETABLE_KEEP = 500
LOCAL = ZoneInfo("Europe/Bratislava")
FLOW = {"id": "password", "name": "Meno a heslo", "description": "Prihlásenie ako na edupage.org"}


def log(*args) -> None:
    print(*args, file=sys.stderr, flush=True)


def as_token(path: str, key: str = "as_token") -> str:
    match = re.search(rf"^{key}:\s*['\"]?([^'\"\s]+)", Path(path).read_text(), re.M)
    if not match:
        raise SystemExit(f"no {key} in {path}")
    return match.group(1)


AS_TOKEN = as_token(os.environ["REGISTRATION"])
HS_TOKEN = as_token(os.environ["REGISTRATION"], "hs_token")
PUPPET_TOKEN = as_token(os.environ["DOUBLEPUPPET"])
BOT = f"@edupagebot:{SERVER_NAME}"


# ---------------------------------------------------------------- Matrix


class MatrixError(Exception):
    def __init__(self, status: int, errcode: str, message: str):
        super().__init__(f"{status} {errcode} {message}")
        self.errcode = errcode


def matrix(method: str, path: str, body=None, *, user: str | None = BOT, query=None) -> dict:
    """Client-server API call as an appservice user; the admin goes through the double puppet."""
    params = {**({"user_id": user} if user else {}), **(query or {})}
    url = f"{HOMESERVER}/_matrix/client/v3{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    token = PUPPET_TOKEN if user == ADMIN else AS_TOKEN
    req = urllib.request.Request(
        url,
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as err:
        try:
            data = json.loads(err.read() or b"{}")
        except ValueError:
            data = {}
        raise MatrixError(err.code, data.get("errcode", ""), data.get("error", "")) from None


def q(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def whoami(token: str) -> str | None:
    req = urllib.request.Request(
        HOMESERVER + "/_matrix/client/v3/account/whoami",
        headers={"Authorization": "Bearer " + token},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.load(resp).get("user_id")
    except (urllib.error.URLError, ValueError):
        return None


# ---------------------------------------------------------------- EduPage -> rooms


def open_db() -> sqlite3.Connection:
    db = sqlite3.connect(STATE_DIR / "edupage.db")
    db.executescript(
        """
        DROP TABLE IF EXISTS threads;  -- one room per thread, before everything moved into one room
        CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, root INTEGER NOT NULL, event_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ghosts (mxid TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS members (room_id TEXT NOT NULL, mxid TEXT NOT NULL, PRIMARY KEY (room_id, mxid));
        -- Every timeline item as EduPage sent it (arrivals, meals, grades, polls...), newest copy wins.
        CREATE TABLE IF NOT EXISTS raw (id INTEGER PRIMARY KEY, typ TEXT NOT NULL, ts INTEGER NOT NULL, item TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY, event_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        -- A homework's material cards ({"text", "files"}) by its EduPage superid, read once.
        CREATE TABLE IF NOT EXISTS materials (superid TEXT PRIMARY KEY, material TEXT NOT NULL);
        """
    )
    return db


def item_ts(item: dict) -> int:
    """EduPage times are local wall-clock strings; asus runs in the school's time zone."""
    stamp = item.get("cas_pridania") or item.get("timestamp") or ""
    try:
        return int(datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S").timestamp() * 1000)
    except ValueError:
        return int(time.time() * 1000)


def item_data(item: dict) -> dict:
    data = item.get("data")
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            data = {}
    return data if isinstance(data, dict) else {}


def item_message(item: dict) -> str:
    # Important messages carry a localized placeholder in `text` and the body in messageContent.
    content = item_data(item).get("messageContent")
    text = content if isinstance(content, str) and content.strip() else item.get("text") or ""
    if not text.strip() and item.get("typ") == "homework":
        text = str(item_data(item).get("nazov") or "")
    return text.strip()


def homework_superid(item: dict) -> str:
    return str(item_data(item).get("superid") or "") if item.get("typ") == "homework" else ""


def html_text(markup: str) -> str:
    """Plain text of a card's rich text, keeping its paragraphs and list items on lines of their own."""
    markup = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h[1-6]|tr)>", "\n", markup or "")
    text = html.unescape(re.sub(r"<[^>]+>", "", markup)).replace("\xa0", " ")
    return "\n".join(line.strip() for line in text.splitlines() if line.strip())


def homework_due(item: dict) -> str:
    try:
        due = date.fromisoformat(str(item_data(item).get("date") or ""))
    except ValueError:
        return ""
    return f"Termín: {WEEKDAYS[due.weekday()]} {due.day}. {due.month}."


def item_actions(item: dict, school: str) -> list[dict]:
    """Preserve EduPage's actual action without executing it or inventing a confirmation."""
    link = item_data(item).get("edupageLink")
    if not isinstance(link, dict) or not re.fullmatch(r"[a-z0-9-]+", school):
        return []
    raw = link.get("url")
    name = link.get("name")
    if not isinstance(raw, str) or not isinstance(name, str) or not name.strip():
        return []
    url = urllib.parse.urljoin(f"https://{school}.edupage.org/", raw)
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc != f"{school}.edupage.org":
        return []
    return [{"label": name.strip(), "url": url}]


def signin_info(item: dict) -> dict:
    """What a sign-up is, when it is open and what Karchi chose; EduPage's text says only the dates."""
    data = item_data(item)
    info = {
        "name": str(data.get("name") or "").strip(),
        "type": str(data.get("typeName") or "").strip(),
        "from": str(data.get("time_from") or ""),
        "to": str(data.get("time_to") or ""),
    }
    chosen = [str(n).strip() for n in data.get("targetNames") or [] if str(n).strip()]
    if chosen:
        info["chosen"] = chosen
        info["confirmed"] = str(data.get("confirmTime") or "")
    return {k: v for k, v in info.items() if v}


def local_label(stamp: str) -> str:
    """'2026-11-11 23:50:00' -> '11. 11. 23:50'."""
    try:
        when = datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return stamp
    return f"{when.day}. {when.month}. {when:%H:%M}"


def signin_text(info: dict) -> str:
    lines = [f"Prihlasovanie: {info.get('name') or 'bez názvu'}"]
    if info.get("type"):
        lines.append(info["type"])
    if info.get("from") or info.get("to"):
        lines.append(f"Otvorené {local_label(info.get('from', ''))} – {local_label(info.get('to', ''))}")
    if info.get("chosen"):
        when = f" ({local_label(info['confirmed'])})" if info.get("confirmed") else ""
        lines.append(f"Zvolené: {', '.join(info['chosen'])}{when}")
    return "\n".join(lines)


def item_text(item: dict, school: str) -> str:
    """The message with links to its attachments (they open on edupage.org, logged in)."""
    text = item_message(item)
    attachments = item_data(item).get("attachements")
    if isinstance(attachments, dict) and attachments:
        base = f"https://{school}.edupage.org"
        lines = [f"- {name}: {urllib.parse.urljoin(base, path)}" for path, name in attachments.items()]
        text = f"{text}\n\nPrílohy:\n" + "\n".join(lines)
    return text.strip() or "(prázdna správa)"


def is_mine(item: dict, user_id: str) -> bool:
    return bool(user_id) and (item.get("vlastnik") or "").replace("Only", "") == user_id


def item_data(item: dict) -> dict:
    data = item.get("data")
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            return {}
    return data if isinstance(data, dict) else {}


# A recipient that is one person (with or without their parents), not a class, a group or everyone.
ONE_PERSON = re.compile(r"(Ucitel|Student|StudentOnly|Rodic|RodicOnly)-?\d+")


def reply_audience(item: dict, user_id: str) -> str | None:
    """Whom a reply in the thread of this first message may go to: None when EduPage has one answer (Karchi wrote it,
    or it went to him alone), "author" when its author allowed replies only to themselves, "all" when Karchi may
    choose between everyone it went to and its author alone (edupage.org's reply box offers the same)."""
    if is_mine(item, user_id):
        return None
    data = item_data(item)
    if str(data.get("repliesToAllDisabled") or "0") == "1":
        return "author"
    if data.get("toMultiple") or not ONE_PERSON.fullmatch(str(item.get("user") or "")):
        return "all"
    return None


def reply_recipient(root_item: dict | None, user_id: str, reply_to: str) -> str:
    """createReply's recipient: "" is everyone the thread went to (and the only choice in a two-person thread), an
    author's user string that author alone. Without Karchi's explicit "all" a reply never goes to a whole class."""
    if not root_item or not root_item.get("vlastnik"):
        return ""
    audience = reply_audience(root_item, user_id)
    if audience == "author" or (audience == "all" and reply_to != "all"):
        return str(root_item["vlastnik"])
    return ""


def own_item(items: list, user_id: str, text: str, root: int | None, known: set[int]) -> int | None:
    """The newest of Karchi's own items with this text, as a reply in `root` or as a new message when root is None;
    how a send is found when EduPage's answer does not name it."""
    norm = lambda t: " ".join(str(t or "").split())
    found = [
        int(i["timelineid"]) for i in items
        if isinstance(i, dict) and str(i.get("timelineid") or "").isdigit() and int(i["timelineid"]) not in known
        and is_mine(i, user_id) and not i.get("pomocny_zaznam") and norm(i.get("text")) == norm(text)
        and (int(i.get("reakcia_na") or 0) == root if root is not None else not i.get("reakcia_na"))
    ]
    return max(found) if found else None


class Rooms:
    """Writes EduPage message items into Matrix; idempotent per EduPage item id."""

    def __init__(self, db: sqlite3.Connection):
        self.db = db

    def ghost(self, item: dict) -> str:
        owner = item.get("vlastnik") or ""
        name = item.get("vlastnik_meno") or owner or "EduPage"
        key = re.sub(r"[^a-z0-9]", "", owner.lower()) or hashlib.sha1(name.encode()).hexdigest()[:12]
        mxid = f"@edupage_{key}:{SERVER_NAME}"
        row = self.db.execute("SELECT name FROM ghosts WHERE mxid = ?", (mxid,)).fetchone()
        if row is None:
            try:
                matrix("POST", "/register", {"type": "m.login.application_service", "username": f"edupage_{key}"}, user=None)
            except MatrixError as err:
                if err.errcode != "M_USER_IN_USE":
                    raise
        if row is None or row[0] != name:
            matrix("PUT", f"/profile/{q(mxid)}/displayname", {"displayname": name}, user=mxid)
            self.db.execute("INSERT OR REPLACE INTO ghosts VALUES (?, ?)", (mxid, name))
            self.db.commit()
        return mxid

    def join(self, room_id: str, mxid: str) -> None:
        if self.db.execute("SELECT 1 FROM members WHERE room_id = ? AND mxid = ?", (room_id, mxid)).fetchone():
            return
        try:
            matrix("POST", f"/rooms/{q(room_id)}/invite", {"user_id": mxid})
        except MatrixError as err:
            if err.errcode != "M_FORBIDDEN":  # already invited or joined
                raise
        matrix("POST", f"/join/{q(room_id)}", {}, user=mxid)
        self.db.execute("INSERT OR IGNORE INTO members VALUES (?, ?)", (room_id, mxid))
        self.db.commit()

    def root_of(self, event_id: str) -> int | None:
        """The EduPage thread a Matrix event belongs to."""
        row = self.db.execute("SELECT root FROM items WHERE event_id = ?", (event_id,)).fetchone()
        return row[0] if row else None

    def root_event(self, root: int) -> str | None:
        row = self.db.execute("SELECT event_id FROM items WHERE id = ?", (root,)).fetchone()
        return row[0] if row else None

    def raw_item(self, item_id: int | None) -> dict | None:
        row = self.db.execute("SELECT item FROM raw WHERE id = ?", (item_id,)).fetchone() if item_id is not None else None
        return json.loads(row[0]) if row else None

    def reply_audiences(self, user_id: str) -> dict[str, str]:
        """REPLIES_TYPE: each thread's first message event whose replies Weft must ask about or explain."""
        out = {}
        for event_id, item in self.db.execute(
                "SELECT items.event_id, raw.item FROM items JOIN raw ON raw.id = items.id WHERE items.id = items.root"):
            audience = reply_audience(json.loads(item), user_id)
            if audience:
                out[event_id] = audience
        return out

    def mark_sent(self, item_id: int, root: int, event_id: str) -> None:
        """A reply written in Matrix and accepted by EduPage: the next poll must not post it again."""
        self.db.execute("INSERT OR IGNORE INTO items VALUES (?, ?, ?)", (item_id, root, event_id))
        self.db.commit()

    def say(self, room_id: str, text: str, answers: str = "") -> None:
        """A bot notice, as a reply to the admin's message it is about when there is one."""
        content = {"msgtype": "m.notice", "body": text, MARK: 0}
        if answers:
            content["m.relates_to"] = {"m.in_reply_to": {"event_id": answers}}
        matrix("PUT", f"/rooms/{q(room_id)}/send/m.room.message/{uuid.uuid4().hex}", content)

    def school_room(self) -> tuple[str, str]:
        """The one EduPage room, and the "EduPage" ghost that writes notices in it."""
        sender = self.ghost({"vlastnik": "school", "vlastnik_meno": "EduPage"})
        row = self.db.execute("SELECT value FROM kv WHERE key = 'school_room'").fetchone()
        if row:
            return row[0], sender
        room_id = matrix(
            "POST",
            "/createRoom",
            {
                "preset": "private_chat",
                "name": "EduPage",
                "invite": [ADMIN],
                "creation_content": {"m.federate": False},
            },
        )["room_id"]
        matrix("POST", f"/join/{q(room_id)}", {}, user=ADMIN)
        self.db.executemany("INSERT OR IGNORE INTO members VALUES (?, ?)", [(room_id, BOT), (room_id, ADMIN)])
        self.db.execute("INSERT INTO kv VALUES ('school_room', ?)", (room_id,))
        self.db.commit()
        self.join(room_id, sender)
        return room_id, sender

    def notices(self, items: list[dict], prefs: dict) -> int:
        """School announcements plus the optional arrival/meal notices; idempotent across restarts."""
        optional = {typ for typ, pref in NOTICE_TYPES.items() if prefs.get(pref)}
        known = {row[0] for row in self.db.execute("SELECT id FROM notices")}
        oldest = int(time.time() * 1000) - NOTICE_MAX_AGE
        fresh = [
            item for item in items
            if (school_notice(item) or item.get("typ") in optional) and str(item.get("timelineid") or "").isdigit()
            and str(item.get("removed") or "0") != "1"
            and (school_notice(item) or item_ts(item) >= oldest)
        ]
        if not fresh:
            return 0
        room_id, school_sender = self.school_room()
        posted = 0
        for item in sorted(fresh, key=item_ts):
            item_id = int(item["timelineid"])
            kind = item["typ"]
            root_event = None
            material = self.material(item)
            if kind == "confirmation":
                parent = str(item.get("reakcia_na") or item.get("ineid") or "")
                root_event = self.root_event(int(parent)) if parent.isdigit() else None
                if not root_event:
                    continue  # wait until the original message is available
                data = item_data(item)
                if not data.get("receipt"):
                    continue
                text = "Potvrdené prečítanie: " + str(data["receipt"])
            else:
                text = " ".join(item_message(item).split()) or kind
                if kind == "signin":
                    text = signin_text(signin_info(item))
                if kind == "homework":
                    details = [html_text(str(item_data(item).get("popis") or "")), material.get("text", ""), homework_due(item)]
                    text = "\n\n".join([text, *filter(None, details)])
                path = SCHOOL_PATHS.get(kind)
                if path:
                    # Keep actions on EduPage: importing an item must never confirm or sign anything.
                    school = (ACCOUNT.creds or {}).get("school", "")
                    if school:
                        text += f"\n\nhttps://{school}.edupage.org/{path}"
            sender = (ADMIN if is_mine(item, (ACCOUNT.creds or {}).get("user_id", "")) else self.ghost(item)) if school_notice(item) else school_sender
            self.join(room_id, sender)
            content = {"msgtype": "m.notice", "body": text, MARK: item_id, "sk.karchi.edupage.kind": kind}
            actions = item_actions(item, (ACCOUNT.creds or {}).get("school", ""))
            if actions:
                content[ACTIONS_KEY] = actions
            if material.get("files"):
                content[FILES_KEY] = material["files"]
            if kind == "signin":
                content[SIGNIN_KEY] = signin_info(item)
            if root_event:
                content["m.relates_to"] = {"m.in_reply_to": {"event_id": root_event}}
            signature = hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()
            hash_key = f"notice_hash_{item_id}"
            cached = self.db.execute("SELECT value FROM kv WHERE key = ?", (hash_key,)).fetchone()
            if item_id in known:
                if cached and cached[0] == signature:
                    continue
                original_id = self.db.execute("SELECT event_id FROM notices WHERE id = ?", (item_id,)).fetchone()[0]
                if not cached:
                    original = matrix("GET", f"/rooms/{q(room_id)}/event/{q(original_id)}", user=ADMIN)
                    if original.get("content") == content:
                        self.db.execute("INSERT OR REPLACE INTO kv VALUES (?, ?)", (hash_key, signature))
                        self.db.commit()
                        continue
                # Standard Matrix edits keep the original thread and timestamp intact.
                wire_content = {**content, "body": "* " + content["body"],
                                "m.new_content": content,
                                "m.relates_to": {"rel_type": "m.replace", "event_id": original_id}}
                revision_key = f"notice_revision_{item_id}"
                revision_row = self.db.execute("SELECT value FROM kv WHERE key = ?", (revision_key,)).fetchone()
                revision = int(revision_row[0]) + 1 if revision_row else 1
                transaction = f"edupage-{item_id}-edit-{revision}-{signature}"
            else:
                wire_content = content
                transaction = f"edupage-{item_id}"
            event_id = matrix(
                "PUT",
                f"/rooms/{q(room_id)}/send/m.room.message/{transaction}",
                wire_content,
                user=sender,
                query={"ts": int(time.time() * 1000) if item_id in known else item_ts(item)},
            )["event_id"]
            self.db.execute("INSERT OR IGNORE INTO notices VALUES (?, ?)", (item_id, event_id))
            self.db.execute("INSERT OR REPLACE INTO kv VALUES (?, ?)", (hash_key, signature))
            if item_id in known:
                self.db.execute("INSERT OR REPLACE INTO kv VALUES (?, ?)", (revision_key, str(revision)))
            self.db.commit()
            posted += 1
        return posted

    def material(self, item: dict) -> dict:
        superid = homework_superid(item)
        row = self.db.execute("SELECT material FROM materials WHERE superid = ?", (superid,)).fetchone() if superid else None
        return json.loads(row[0]) if row else {}

    def fetch_materials(self, edu: Edupage, items: list[dict]) -> None:
        """Reads the material of homework not read yet; a failure is retried on the next poll."""
        known = {row[0] for row in self.db.execute("SELECT superid FROM materials")}
        todo = [i for i in sorted(items, key=item_ts, reverse=True)
                if homework_superid(i) and homework_superid(i) not in known and str(i.get("removed") or "0") != "1"]
        for item in todo[:MATERIALS_PER_POLL]:
            try:
                material = homework_material(edu, item.get("_homework") or {})
            except (requests.RequestException, ValueError, KeyError, MatrixError, urllib.error.URLError) as err:
                log("homework material failed:", homework_superid(item), type(err).__name__)
                continue
            self.db.execute("INSERT OR REPLACE INTO materials VALUES (?, ?)",
                            (homework_superid(item), json.dumps(material, ensure_ascii=False)))
            self.db.commit()

    def keep(self, items: list[dict]) -> None:
        self.db.executemany(
            "INSERT OR REPLACE INTO raw VALUES (?, ?, ?, ?)",
            [(int(i["timelineid"]), str(i.get("typ") or ""), item_ts(i), json.dumps(i, ensure_ascii=False))
             for i in items if str(i.get("timelineid") or "").isdigit()],
        )
        self.db.commit()

    def sync(self, items: list[dict], school: str, user_id: str, settle_before: int | None = None) -> int:
        """Posts unseen messages oldest first; returns how many were posted."""
        known = {row[0] for row in self.db.execute("SELECT id FROM items")}
        messages = [
            item for item in items
            if item.get("typ") == "sprava" and str(item.get("removed") or "0") != "1" and item.get("timelineid")
        ]
        batch = {int(item["timelineid"]) for item in messages}
        messages.sort(key=lambda item: (item_ts(item), int(item["timelineid"])))
        room_id = self.school_room()[0] if messages else ""
        settled = ""
        posted = 0
        for item in messages:
            item_id = int(item["timelineid"])
            if item_id in known:
                continue
            parent = int(item.get("reakcia_na") or 0)
            # Helper copies exist only to notify people; the real reply is the item they point to.
            if item.get("pomocny_zaznam") and parent and (parent in batch or parent in known):
                continue
            root = item_id
            if parent:
                row = self.db.execute("SELECT root FROM items WHERE id = ?", (parent,)).fetchone()
                root = row[0] if row else parent
            sender = ADMIN if is_mine(item, user_id) else self.ghost(item)
            self.join(room_id, sender)
            ts = item_ts(item)
            content = {"msgtype": "m.text", "body": item_text(item, school), MARK: item_id}
            actions = item_actions(item, school)
            if actions:
                content[ACTIONS_KEY] = actions
            root_event = self.root_event(root) if root != item_id else None
            if root_event:
                content["m.relates_to"] = {"m.in_reply_to": {"event_id": root_event}}
            elif item.get("user_meno"):
                content[TO_KEY] = item["user_meno"]
            event_id = matrix(
                "PUT",
                f"/rooms/{q(room_id)}/send/m.room.message/edupage-{item_id}",
                content,
                user=sender,
                query={"ts": ts},
            )["event_id"]
            self.db.execute("INSERT INTO items VALUES (?, ?, ?)", (item_id, root, event_id))
            self.db.commit()
            known.add(item_id)
            if settle_before is not None and ts < settle_before:
                settled = event_id
            posted += 1
        if settled:
            # History shows up like on edupage.org: there, but already read.
            matrix("POST", f"/rooms/{q(room_id)}/receipt/m.read/{q(settled)}", {}, user=ADMIN)
        return posted


# ---------------------------------------------------------------- EduPage account


class NeedsLogin(Exception):
    """The stored session and password no longer work; the user has to log in again."""


class SessionExpired(Exception):
    pass


def school_year_start(today: date) -> date:
    return date(today.year if today.month >= 9 else today.year - 1, 9, 1)


def session_id(edu: Edupage) -> str:
    for cookie in edu.session.cookies:
        if cookie.name == "PHPSESSID" and edu.subdomain in (cookie.domain or ""):
            return cookie.value
    return edu.session.cookies.get("PHPSESSID") or ""


def my_name(edu: Edupage) -> str:
    match = re.match(r"([A-Za-z]+?)(?:Only)?(-?\d+)$", edu.get_user_id() or "")
    group = {"Student": "students", "Ucitel": "teachers", "Rodic": "parents"}.get(match.group(1) if match else "")
    person = ((edu.data.get("dbi") or {}).get(group) or {}).get(match.group(2)) if group else None
    if isinstance(person, dict):
        name = f"{person.get('firstname', '')} {person.get('lastname', '')}".strip()
        if name:
            return name
    return edu.username or "EduPage"


def fetch_timeline(edu: Edupage, since: date) -> list[dict]:
    """Raw timeline items since `since`: the message tab plus everything else, by item id.
    A homework item gets its row from EduPage's homework list under `_homework` (testid, cards)."""
    data = fetch_data(edu, since, "")
    homeworks = {str(hw.get("e_superid")): hw for hw in data.get("homeworks") or [] if isinstance(hw, dict)}
    items = {str(i.get("timelineid")): i for i in data["timelineItems"]}
    items.update({str(i.get("timelineid")): i for i in fetch_tab(edu, since, "messages")})
    for item in items.values():
        if homework_superid(item) in homeworks:
            item["_homework"] = homeworks[homework_superid(item)]
    return list(items.values())


def fetch_tab(edu: Edupage, since: date, tab: str) -> list[dict]:
    return fetch_data(edu, since, tab)["timelineItems"]


def fetch_data(edu: Edupage, since: date, tab: str) -> dict:
    """One timeline tab since `since` (the same call edupage.org makes)."""
    params = [("module", "todo"), ("filterTab", ""), ("akcia", "getData")] + ([("filterTab", tab)] if tab else [])
    resp = edu.session.post(
        f"https://{edu.subdomain}.edupage.org/timeline/",
        params=params,
        data=urllib.parse.urlencode({"datefrom": since.isoformat()}),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    resp.raise_for_status()
    try:
        data = resp.json()
    except ValueError:
        raise SessionExpired() from None  # the login page instead of JSON
    items = data.get("timelineItems") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise SessionExpired()  # an error/login response is not a successful empty poll
    return data


def card_widgets(widget: dict):
    yield widget
    for child in widget.get("widgets") or []:
        if isinstance(child, dict):
            yield from card_widgets(child)


def homework_material(edu: Edupage, hw: dict) -> dict:
    """Text and files of a homework's material cards, loaded the way edupage.org's player loads them.

    Only plain homework whose cards ask for no answer: loading it marks nothing as seen or started
    (checked on 2026-11-09). Tests, exams and homework with answer cards stay on EduPage."""
    if hw.get("typ") != "etesthw|hw" or not hw.get("etestCards") or hw.get("etestAnswerCards") != 0:
        return {}
    base = f"https://{edu.subdomain}.edupage.org"
    resp = edu.session.post(
        f"{base}/elearning/?cmd=MaterialPlayer&akcia=getETestData",
        data={"testid": str(hw["testid"]), "superid": str(hw["e_superid"]), "pridelenieid": "", "vysledokid": ""},
    )
    resp.raise_for_status()
    material = resp.json()["materialData"]
    cards = material.get("cardsData") or {}
    texts, files = [], []
    for cardid in material.get("cardids") or list(cards):
        card = cards.get(str(cardid)) or {}
        for widget in card_widgets(json.loads(card.get("content") or "{}")):
            props = widget.get("props") or {}
            if widget.get("widgetClass") == "TitleETestWidget":
                texts.append(html_text(str(props.get("text") or "")))
            elif widget.get("widgetClass") == "TextETestWidget":
                # A secured card keeps its text only in the parsed copy.
                texts.append(html_text(str(props.get("htmlText") or props.get("_parsedHtmlText") or "")))
            elif widget.get("widgetClass") == "FileETestWidget":
                files += [upload_file(edu, base, f) for f in props.get("files") or [] if isinstance(f, dict) and f.get("src")]
    return {"text": "\n\n".join(filter(None, texts)), "files": [f for f in files if f]}


def upload_file(edu: Edupage, base: str, file: dict) -> dict | None:
    """Copies one card file into the Matrix media store; EduPage serves it only to a logged-in session."""
    url = urllib.parse.urljoin(base + "/", str(file["src"]))
    if urllib.parse.urlsplit(url).netloc != urllib.parse.urlsplit(base).netloc:
        return None
    resp = edu.session.get(url, timeout=60)
    resp.raise_for_status()
    mimetype = resp.headers.get("Content-Type", "application/octet-stream").split(";")[0].strip()
    mimetype = {"image/x-png": "image/png", "image/pjpeg": "image/jpeg"}.get(mimetype, mimetype)
    if mimetype == "text/html":
        raise ValueError("login page instead of a file")
    if len(resp.content) > MAX_FILE_BYTES:
        return None
    name = str(file.get("name") or "subor")
    req = urllib.request.Request(
        f"{HOMESERVER}/_matrix/media/v3/upload?" + urllib.parse.urlencode({"user_id": BOT, "filename": name}),
        data=resp.content, method="POST",
        headers={"Authorization": f"Bearer {AS_TOKEN}", "Content-Type": mimetype},
    )
    with urllib.request.urlopen(req, timeout=60) as up:
        mxc = json.load(up)["content_uri"]
    out = {"name": name, "url": mxc, "mimetype": mimetype, "size": len(resp.content)}
    size = image_size(resp.content)
    if size:
        out.update(w=size[0], h=size[1])
    return out


def image_size(data: bytes) -> tuple[int, int] | None:
    """Pixel size of a PNG, GIF or JPEG; EduPage's own width and height are its preview's."""
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 10:
        return int.from_bytes(data[6:8], "little"), int.from_bytes(data[8:10], "little")
    i = 2 if data[:2] == b"\xff\xd8" else len(data)
    while i + 9 <= len(data) and data[i] == 0xFF:
        marker, length = data[i + 1], int.from_bytes(data[i + 2:i + 4], "big")
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
        i += 2 + length
    return None


def recipient_id(mxid: str) -> str | None:
    """EduPage's id of a person from their ghost, e.g. @edupage_ucitel123 -> Ucitel123; None for others."""
    match = re.match(r"@edupage_(ucitel|student|rodic)(?:only)?(\d+):", mxid)
    return f"{match.group(1).capitalize()}{match.group(2)}" if match else None


def teacher_contacts(edu: Edupage) -> list[dict]:
    """The school's current teachers as people Karchi can write to, under the ghost ids their messages use."""
    teachers = (edu.data.get("dbi") or {}).get("teachers") or {}
    today = date.today().isoformat()
    out = []
    for tid, t in (teachers.items() if isinstance(teachers, dict) else []):
        if not str(tid).isdigit() or not isinstance(t, dict) or (t.get("dateto") and str(t["dateto"]) < today):
            continue
        name = " ".join(str(t.get(k) or "").strip() for k in ("firstname", "lastname")).strip()
        if name:
            out.append({"id": f"@edupage_ucitel{tid}:{SERVER_NAME}", "name": name})
    return sorted(out, key=lambda c: c["name"])


class AttachmentRefused(Exception):
    """EduPage would not take a file (its type or size); the message is not sent without it."""


def matrix_file(mxc: str) -> bytes:
    """A file Karchi attached in Weft, from the homeserver's media store."""
    match = re.fullmatch(r"mxc://([^/]+)/([A-Za-z0-9_-]+)", mxc or "")
    if not match:
        raise AttachmentRefused("príloha nemá platnú adresu")
    req = urllib.request.Request(
        f"{HOMESERVER}/_matrix/client/v1/media/download/{match.group(1)}/{match.group(2)}",
        headers={"Authorization": f"Bearer {AS_TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise AttachmentRefused(f"príloha je väčšia ako {MAX_FILE_BYTES // 1024 // 1024} MB")
    return data


def upload_attachment(edu: Edupage, name: str, mimetype: str, data: bytes) -> tuple[str, str]:
    """Uploads one file the way edupage.org's message form does; returns (its path on EduPage, its name)."""
    resp = edu.session.post(
        f"https://{edu.subdomain}.edupage.org/timeline/?akcia=uploadAtt",
        files={"att": (name, data, mimetype or "application/octet-stream")},
        timeout=120,
    )
    resp.raise_for_status()
    try:
        answer = resp.json()
    except ValueError:
        raise SessionExpired() from None
    path = (answer.get("data") or {}).get("file") if isinstance(answer, dict) else None
    if answer.get("status") != "ok" or not isinstance(path, str) or not path:
        raise AttachmentRefused(f"EduPage neprijal prílohu {name}")
    return path, str((answer.get("data") or {}).get("name") or name)


def send_message(edu: Edupage, recipient: str, text: str, attachments: dict | None = None,
                 user_id: str = "", known: set[int] | None = None) -> int | None:
    """Starts a new message to one person the way edupage.org's "Nová správa" does; returns its timeline id.
    attachments maps each uploaded file's EduPage path to its name."""
    resp = edu.session.post(
        f"https://{edu.subdomain}.edupage.org/timeline/?=&akcia=createItem&eqav=1&maxEqav=7",
        data=RequestData.encode_request_body(
            {"selectedUser": recipient, "text": text, "attachements": json.dumps(attachments or {}),
             "receipt": "0", "typ": "sprava"}
        ),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    resp.raise_for_status()
    try:
        data = json.loads(RequestData.decode_response(resp.text))
    except ValueError:
        raise SessionExpired() from None
    return sent_id(edu, data, user_id, text, None, known or set(), "EduPage did not accept the message")


def send_reply(edu: Edupage, root: int, text: str, attachments: dict | None = None, recipient: str = "",
               user_id: str = "", known: set[int] | None = None) -> int | None:
    """Replies in the thread `root` the way edupage.org does, to `recipient` (see reply_recipient); returns the
    new timeline id, None when EduPage took it but its id could not be found."""
    resp = edu.session.post(
        f"https://{edu.subdomain}.edupage.org/timeline/?akcia=createReply&eqav=1&maxEqav=7",
        data=RequestData.encode_request_body(
            {"groupid": str(root), "recipient": recipient, "text": text,
             "moredata": json.dumps({"attachements": attachments or {}})}
        ),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    resp.raise_for_status()
    try:
        data = json.loads(RequestData.decode_response(resp.text))
    except ValueError:
        raise SessionExpired() from None
    return sent_id(edu, data, user_id, text, root, known or set(), "EduPage odpoveď neprijal")


def sent_id(edu: Edupage, data, user_id: str, text: str, root: int | None, known: set[int], refused: str) -> int | None:
    """The id of what createItem/createReply just made. EduPage names it in "changes" only sometimes (also
    edupage-api issue 62); a reply often comes back as the thread's replies ("reakcie") instead, and otherwise the
    message tab is read again. Raises `refused` only when EduPage said no; None when it said ok but hid the id."""
    if not isinstance(data, dict):
        raise RuntimeError(refused)
    for change in data.get("changes") or []:
        if isinstance(change, dict) and str(change.get("timelineid") or "").isdigit():
            return int(change["timelineid"])
    inner = data.get("data") if isinstance(data.get("data"), dict) else {}
    replies = [*(data.get("reakcie") or []), *(inner.get("reakcie") or [])]
    found = own_item([{"reakcia_na": root, **r} for r in replies if isinstance(r, dict)], user_id, text, root, known) \
        if root is not None else None
    if found is None and user_id:
        try:
            found = own_item(fetch_tab(edu, date.today() - timedelta(days=1), "messages"), user_id, text, root, known)
        except Exception as err:  # it may still have gone; the status below decides what Karchi hears
            log("sent item lookup failed:", type(err).__name__)
    if found is not None:
        return found
    if str(data.get("status") or "").lower() == "ok":
        return None
    raise RuntimeError(refused)


def points_mark(percent: float, scale: dict) -> str:
    """The mark a points grade converts to, by the event's "do" (up to %) thresholds."""
    steps = sorted(scale.get("hodnoty") or [], key=lambda h: float(h.get("do") or 0))
    for step in steps:
        if percent <= float(step.get("do") or 0):
            return str(step.get("znamka") or "")
    return ""


def grade_book(edu: Edupage) -> dict:
    """This half-year's grades as edupage.org's /znamky/ page shows them, for the client's grade panel.

    Parsed here instead of with edupage_api's get_grades, which stops at the first grade whose
    event details are missing; such a grade is skipped instead. Weight: EduPage stores 20 for 1x.
    """
    resp = edu.session.get(f"https://{edu.subdomain}.edupage.org/znamky/")
    resp.raise_for_status()
    match = re.search(r"\.znamkyStudentViewer\((\{.*?\})\);\s*\}\);", resp.text, re.S)
    if not match:
        raise SessionExpired()
    data = json.loads(match.group(1))
    events = (data.get("vsetkyUdalosti") or {}).get("edupage") or {}
    subjects = data.get("predmety") or {}
    teachers = data.get("ucitelia") or {}
    grades = []
    for grade in data.get("vsetkyZnamky") or []:
        details = events.get(str(grade.get("udalostid") or ""))
        value = str(grade.get("data") or "").split(" (", 1)[0].strip()
        if not isinstance(details, dict) or not value:
            continue
        try:
            when = datetime.strptime(grade.get("datum") or "", "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        subject_id = str(details.get("PredmetID") or grade.get("predmetid") or "")
        teacher = teachers.get(str(grade.get("ucitelid") or details.get("UcitelID") or "")) or {}
        entry = {
            "id": str(grade.get("znamkaid") or grade["udalostid"]),
            "subject": subject_id,
            "value": value,
            "date": int(when.timestamp() * 1000),
            "title": details.get("p_meno") or "",
            "weight": round((details.get("p_vaha") or 20) / 20, 2),
            "teacher": f"{teacher.get('firstname', '')} {teacher.get('lastname', '')}".strip(),
            "others": details.get("priemer") or "",
        }
        more = details.get("moredata") if isinstance(details.get("moredata"), dict) else {}
        top = details.get("p_vaha_body")
        if top and value.replace(".", "", 1).isdigit():
            percent = float(value) / float(top) * 100
            entry.update({"max": float(top), "percent": round(percent, 1),
                          "mark": points_mark(percent, more.get("vyhodnotenie") or {})})
        grades.append(entry)
    grades.sort(key=lambda g: g["date"], reverse=True)
    teacher_of: dict[str, str] = {}
    for g in reversed(grades):
        teacher_of.setdefault(g["subject"], g["teacher"])
    return {
        "subjects": [{"id": str(k), "name": (v.get("p_meno") or "").strip(), "short": v.get("p_skratka") or "",
                      "teacher": teacher_of.get(str(k), "")}
                     for k, v in subjects.items() if isinstance(v, dict)],
        "grades": grades,
    }


def tt_call(edu: Edupage, func: str, args: list) -> dict:
    """One call to edupage.org's timetable viewer API (read-only)."""
    module = {"getTTViewerData": "ttviewer", "regularttGetData": "regulartt", "curentttGetData": "currenttt"}[func]
    resp = edu.session.post(
        f"https://{edu.subdomain}.edupage.org/timetable/server/{module}.js?__func={func}",
        json={"__args": [None, *args], "__gsh": edu.gsec_hash},
    )
    resp.raise_for_status()
    return resp.json().get("r") or {}


def teacher_colors(edu: Edupage, ghosts: list[str]) -> dict[str, str]:
    """Each teacher's color, keyed by ghost mxid, as edupage.org's timetable paints their lessons.

    The timetable stores a color per teacher and per subject and colors a lesson by its teacher.
    A teacher without a stored color gets the color of the subject of their lesson nearest to now.
    """
    year = (edu.data.get("dp") or {}).get("year")
    regular = tt_call(edu, "getTTViewerData", [year]).get("regular") or {}
    tables = {
        t.get("id"): t.get("data_rows") or []
        for t in (tt_call(edu, "regularttGetData", [str(regular.get("default_num") or "")]).get("dbiAccessorRes") or {}).get("tables") or []
    }
    stored = {str(t.get("id")): t.get("color") for t in tables.get("teachers", []) if t.get("color")}
    subject_color = {str(s.get("id")): s.get("color") for s in tables.get("subjects", []) if s.get("color")}
    out = {}
    today = date.today()
    now = datetime.now()
    for mxid in ghosts:
        match = re.match(r"@edupage_ucitel(?:only)?(\d+):", mxid)
        if not match:
            continue
        teacher = match.group(1)
        color = stored.get(teacher) or stored.get(f"-{teacher}")
        if not color:
            lessons = tt_call(edu, "curentttGetData", [{
                "year": year,
                "datefrom": (today - timedelta(days=14)).isoformat(),
                "dateto": (today + timedelta(days=14)).isoformat(),
                "table": "teachers",
                "id": teacher,
                "showColors": True,
                "log_module": "CurrentTTView",
            }]).get("ttitems") or []
            best = None
            for lesson in lessons:
                found = subject_color.get(str(lesson.get("subjectid")))
                try:
                    when = datetime.strptime(f"{lesson['date']} {lesson['starttime']}", "%Y-%m-%d %H:%M")
                except (KeyError, ValueError):
                    continue
                distance = abs((when - now).total_seconds())
                if found and lesson.get("type") == "card" and (best is None or distance < best[0]):
                    best = (distance, found)
            color = best[1] if best else None
        if color:
            out[mxid] = color
    return out


def read_account(kind: str) -> dict:
    """Karchi's account data of this type, {} when he has none."""
    try:
        content = matrix("GET", f"/user/{q(ADMIN)}/account_data/{kind}", user=ADMIN)
    except MatrixError as err:
        if err.errcode != "M_NOT_FOUND":
            raise
        return {}
    return content if isinstance(content, dict) else {}


def read_prefs() -> dict:
    try:
        content = matrix("GET", f"/user/{q(ADMIN)}/account_data/{PREFS_TYPE}", user=ADMIN)
    except MatrixError as err:
        if err.errcode != "M_NOT_FOUND":
            raise
        content = {}
    return {**DEFAULT_PREFS, **{k: bool(v) for k, v in content.items() if k in DEFAULT_PREFS}}


def complete_login(edu: Edupage, password: str, school_hint: str) -> dict:
    user_id = edu.get_user_id() or ""
    return {
        "login_id": f"{edu.subdomain}:{user_id}",
        "username": edu.username,
        "password": password,
        "school": edu.subdomain,
        "school_hint": school_hint,
        "session": session_id(edu),
        "user_id": user_id,
        "name": my_name(edu),
    }


# ---------------------------------------------------------------- tests -> calendar
#
# Every upcoming test EduPage announces (an exam event, or a homework whose title names a test) is kept as one
# event in Weft's calendar "Testy", at the first lesson of its subject that day (all day while the timetable does
# not reach it). A test that names pupils (a retake: "(Nováková, Horáková)", " - Kováčová", or an event
# for chosen students) goes in only when Karchi is among them. The bridge owns events with uid edupage-test-*:
# a changed test updates its event, a removed or moved-out one deletes it; Karchi may still edit or delete them.

EXAM_KINDS = {"exam": "Písomka", "sexam": "Krátka písomka", "oexam": "Ústne skúšanie", "pexam": "Projekt"}
TEST_WORDS = re.compile(r"(?i)(?<!\w)(test|písomk|písomn|previerk|skúšan|skúšk)")
TESTS_KV = "tests_calendar"


def fold(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


def named(title: str, surname: str) -> bool:
    """Whether the title names this surname, written as a name or in capitals, with or without diacritics."""
    name = fold(surname)
    return bool(name) and re.search(rf"(?<!\w)(?:{re.escape(name)}|{re.escape(name.upper())})(?!\w)", fold(title)) is not None


def for_others(title: str, people: dict) -> bool:
    """A test that names pupils (a retake) without naming Karchi."""
    return any(named(title, n) for n in people["classmates"]) and not named(title, people["surname"])


def school_people(edu: Edupage) -> dict:
    """Who Karchi is in the school's data, his classmates' surnames and the subjects, for test_event."""
    dbi = edu.data.get("dbi") or {}
    students = dbi.get("students") or {}
    match = re.search(r"(\d+)$", edu.get_user_id() or "")
    me = match.group(1) if match else ""
    mine = students.get(me) or {}
    classmates = {str(s.get("lastname") or "").strip() for i, s in students.items()
                  if i != me and isinstance(s, dict) and (not mine.get("classid") or s.get("classid") == mine.get("classid"))}
    subjects = {str(i): (str(s.get("name") or ""), str(s.get("short") or "")) for i, s in (dbi.get("subjects") or {}).items()
                if isinstance(s, dict)}
    return {"me": me, "surname": str(mine.get("lastname") or ""), "classmates": sorted(n for n in classmates if n),
            "subjects": subjects}


def test_event(item: dict, people: dict) -> dict | None:
    """The calendar entry for a test item, or None when it is not a test or not Karchi's."""
    data = item_data(item)
    typ = item.get("typ")
    if typ == "homework":
        title = str(data.get("nazov") or "").strip().splitlines()[0:1]
        title = re.sub(r"^Zmenené:\s*", "", title[0] if title else "").strip()
        if not TEST_WORDS.search(title):
            return None
        if for_others(title, people):
            return None
        subject_id = str(data.get("predmetid") or "")
    elif typ == "event" and data.get("typ") in EXAM_KINDS:
        title = re.sub(r"\s+", " ", str(data.get("name") or "")).strip()
        if not TEST_WORDS.search(title):
            title = f"{EXAM_KINDS[data['typ']]} – {title}"
        if others_reason(item, people):
            return None
        subject_id = str(data.get("subjectid") or "")
    else:
        return None
    try:
        day = date.fromisoformat(str(data.get("date") or ""))
    except ValueError:
        return None
    meno = str(item.get("user_meno") or "")
    name, short = people["subjects"].get(subject_id) or ((meno.split(" · ", 1)[1], "") if " · " in meno else ("", ""))
    teacher = str(item.get("vlastnik_meno") or "").strip()
    who = ", ".join(x for x in (short, teacher.split()[-1] if teacher else "") if x)
    return {"title": f"{title} ({who})" if who else title, "date": day, "subject": name, "subject_id": subject_id, "period": data.get("period"),
            "notes": " · ".join(x for x in ("Z EduPage", name, teacher) if x)}


def item_subject(item: dict) -> str:
    """The EduPage subject id an item is about, as EduPage itself records it; '' when it names none."""
    data = item_data(item)
    if item.get("typ") == "znamka":
        ids = [k for k in data if re.fullmatch(r"-?\d+", k)]
        return ids[0] if len(ids) == 1 else ""
    return str(data.get("subjectid") or data.get("predmetid") or "")


def group_key(name: str) -> str:
    """A group's name the way the timetable ("seminargroup:3") and events ("Seminár 3") can be matched: "seminar 3"."""
    return " ".join(re.findall(r"[a-z]+|\d+", fold(name).casefold().replace("group", " ")))


def group_family(key: str) -> str:
    return " ".join(w for w in key.split() if not w.isdigit())


def others_reason(item: dict, people: dict, groups: frozenset | None = None) -> str:
    """Why an item is meant for other pupils by EduPage's own data, or '' when it is (also) Karchi's.

    Pupils are listed by id (negative ids are groups, which may hold him: those never count against him);
    a group is named (when his own groups are known: `groups`, else people["groups"]); or a retake names
    classmates and not him."""
    groups = frozenset(people.get("groups") or ()) if groups is None else groups
    data = item_data(item)
    chosen = {str(s) for s in data.get("studentids") or []} if isinstance(data.get("studentids"), list) else set()
    if chosen and people.get("me") and people["me"] not in chosen and not any(s.startswith("-") for s in chosen):
        return "iným žiakom"
    named = {group_key(str(g)) for g in data.get("groupnames") or [] if str(g).strip()} if isinstance(data.get("groupnames"), list) else set()
    mine = {group_key(g) for g in groups}
    # Only a group of a kind he is in (another seminar when he has one) says it is not his; an unknown kind shows.
    if named and not named & mine and {group_family(n) for n in named} & {group_family(m) for m in mine}:
        return "inej skupine"
    title = str(data.get("nazov") or data.get("name") or "")
    if item.get("typ") in ("homework", "event") and people.get("classmates") and for_others(title, people):
        return "iným žiakom"
    return ""


def subject_key(name: str) -> str:
    """A subject's name the way the timetable and the grade book can be matched: no accents, case or change prefix."""
    name = re.sub(r"^\s*(suplovanie|zmena|odpadlo|zrušené|zrusene)\s*:\s*", "", fold(name), flags=re.I)
    return " ".join(name.casefold().split())


def my_lessons(edu: Edupage, today: date) -> list[dict]:
    """Karchi's own timetable this school year and four weeks ahead, as edupage.org's timetable shows it to him
    (his groups only): [{"subject", "groups"}] per lesson."""
    me = re.search(r"(\d+)$", edu.get_user_id() or "")
    if not me:
        return []
    items = tt_call(edu, "curentttGetData", [{
        "year": (edu.data.get("dp") or {}).get("year"),
        "datefrom": school_year_start(today).isoformat(),
        "dateto": (today + timedelta(days=28)).isoformat(),
        "table": "students", "id": me.group(1),
        "showColors": True, "showIgroupsInClasses": True, "showOrig": True, "log_module": "CurrentTTView",
    }]).get("ttitems") or []
    return [{"subject": str(i.get("subjectid") or ""), "groups": [str(g).strip() for g in i.get("groupnames") or [] if str(g).strip()]}
            for i in items if isinstance(i, dict) and i.get("type") == "card" and i.get("subjectid")]


def calendar_subjects(doc: dict) -> set[str]:
    """Subject names (subject_key) in the EduPage timetable calendar Weft shows: Karchi's personal timetable."""
    cal = next((c for c in doc.get("calendars") or [] if c.get("id") == TIMETABLE_CALENDAR), None)
    return {subject_key(str(e.get("title") or "")) for e in (cal or {}).get("events") or [] if not e.get("allDay")} - {""}


def school_facts(book: dict, people: dict, lessons: list[dict] | None, calendar: set[str], learned: set[str],
                 items: list[dict]) -> dict:
    """Which subjects are Karchi's and why, and for each school notice its subject and whether it is for others.

    A subject is his when it is in his own timetable (EduPage's, the calendar copy of it, or seen there before) or
    when he has a grade in it, EduPage lists him among an event's pupils, or it posts to the subject group's own plan
    (CustPlan, for its members only; a whole-class Plan says nothing). Weft hides the rest unless Karchi says
    otherwise (Settings → EduPage)."""
    names = {i: n for i, (n, _short) in people.get("subjects", {}).items()}
    shorts = {i: sh for i, (_n, sh) in people.get("subjects", {}).items()}
    for s in book.get("subjects") or []:
        names.setdefault(s["id"], s["name"])
        shorts.setdefault(s["id"], s.get("short") or "")
    graded: collections.Counter = collections.Counter(g["subject"] for g in book.get("grades") or [])
    in_timetable = set(learned) | {l["subject"] for l in lessons or []}
    timetable_names = {subject_key(names.get(i, "")) for i in in_timetable} | calendar
    groups = frozenset(g for l in lessons or [] for g in l["groups"])
    about, named_me, group_plan = {}, set(), set()
    for item in items:
        subject = item_subject(item)
        data = item_data(item)
        pupils = data.get("studentids") if isinstance(data.get("studentids"), list) else []
        if subject and people.get("me") and people["me"] in {str(x) for x in pupils}:
            named_me.add(subject)  # EduPage lists him among the pupils of this subject's event
        if subject and str(item.get("user") or "").startswith("CustPlan"):
            group_plan.add(subject)  # posted to a subject group's own plan, which reaches only its members
        if not str(item.get("timelineid") or "").isdigit() or not (school_notice(item) or item.get("typ") in NOTICE_TYPES):
            continue
        fact = {"subject": subject, "others": others_reason(item, people, groups)}
        if fact["subject"] or fact["others"]:
            about[str(item["timelineid"])] = {k: v for k, v in fact.items() if v}
    shown = set(graded) | {s["id"] for s in book.get("subjects") or []} | {f["subject"] for f in about.values() if f.get("subject")}
    subjects = []
    for sid in sorted(shown, key=lambda i: fold(names.get(i, i)).casefold()):
        why = []
        if sid in in_timetable or (subject_key(names.get(sid, "")) in timetable_names and names.get(sid)):
            why.append("rozvrh")
        if graded[sid]:
            why.append("známky")
        if sid in named_me:
            why.append("zoznam žiakov")
        if sid in group_plan:
            why.append("skupina predmetu")
        subjects.append({"id": sid, "name": names.get(sid, sid), "short": shorts.get(sid, ""), "mine": bool(why),
                         "why": why, "grades": graded[sid]})
    return {"subjects": subjects, "groups": sorted(groups), "items": about, "timetable": lessons is not None}


def mine_subjects(facts: dict | None, rules: dict) -> set[str] | None:
    """Subject ids that are Karchi's: the facts, with his own word over them; None before the first facts."""
    if not facts:
        return None
    said = rules.get("subjects") if isinstance(rules.get("subjects"), dict) else {}
    return {s["id"] for s in facts["subjects"] if said.get(s["id"], s["mine"]) is True}


def lesson_slot(doc: dict, day: date, subject: str, period) -> tuple[str, str] | None:
    """Start and end (UTC ISO) of the subject's lesson that day in the EduPage timetable calendar."""
    want = fold(subject).strip().casefold()
    cal = next((c for c in doc.get("calendars") or [] if c.get("id") == TIMETABLE_CALENDAR), None)
    if not want or cal is None:
        return None
    lessons = []
    for e in cal.get("events") or []:
        if e.get("allDay"):
            continue  # the timetable calendar also carries EduPage's own events as whole days
        try:
            start = datetime.fromisoformat(str(e["start"]).replace("Z", "+00:00"))
        except (KeyError, ValueError):
            continue
        # A substituted or moved lesson still is that subject's lesson; a cancelled one ("Odpadlo:") is not.
        title = re.sub(r"^(Suplovanie|Zmena):\s*", "", str(e.get("title") or ""))
        if start.astimezone(LOCAL).date() == day and fold(title).strip().casefold() == want:
            hours = re.search(r"Hodin[ay]: (\d+)\.(?:–(\d+)\.)?", str(e.get("description") or ""))
            covers = bool(hours and str(period).isdigit() and int(hours.group(1)) <= int(period) <= int(hours.group(2) or hours.group(1)))
            lessons.append((not covers, start, e))
    if not lessons:
        return None
    _, _, e = min(lessons, key=lambda x: (x[0], x[1]))
    return e["start"], e["end"]


def utc_iso(moment: datetime) -> str:
    return moment.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def plan_tests(items: list[dict], people: dict, doc: dict, state: dict, today: date,
               mine: set[str] | None = None) -> tuple[list[dict], dict]:
    """Calendar ops that bring the Testy calendar in line with EduPage, and the bridge's new record of them.
    `mine`: the subject ids that are Karchi's (mine_subjects); a test in another subject stays out."""
    cal = next((c for c in doc.get("calendars") or [] if str(c.get("name") or "").strip().casefold() == TESTS_CALENDAR.casefold()), None)
    if cal is None:
        raise ValueError(f"no calendar named {TESTS_CALENDAR}")
    latest: dict[str, dict] = {}
    for item in items:
        key = str(item.get("ineid") or "")
        if key and (key not in latest or int(item["timelineid"]) > int(latest[key]["timelineid"])):
            latest[key] = item
    ops, record = [], {}
    for key, item in latest.items():
        test = None if item.get("removed") else test_event(item, people)
        if test is None or test["date"] < today:
            continue
        if mine is not None and test["subject_id"] and test["subject_id"] not in mine:
            continue
        slot = lesson_slot(doc, test["date"], test["subject"], test["period"])
        start, end = slot or (utc_iso(datetime.combine(test["date"], datetime.min.time(), LOCAL)),
                              utc_iso(datetime.combine(test["date"] + timedelta(days=1), datetime.min.time(), LOCAL)))
        event = {"uid": f"edupage-test-{key}", "title": test["title"], "start": start, "end": end,
                 "allDay": slot is None, "notes": test["notes"], "description": test["notes"]}
        sig = hashlib.sha256(json.dumps(event, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]
        record[key] = {"uid": event["uid"], "sig": sig, "date": test["date"].isoformat()}
        if (state.get(key) or {}).get("sig") != sig:
            ops.append({"op": "put", "cal": cal["id"], "event": event})
    for key, old in state.items():
        if key not in record and old.get("date", "") >= today.isoformat():
            ops.append({"op": "del", "cal": cal["id"], "uid": old["uid"]})
    return ops, record


def store_handled(db: sqlite3.Connection, handled: set[str]) -> None:
    """Remembers the newest TIMETABLE_KEEP handled timetable notices."""
    order = sorted(handled, key=lambda n: int(n.split(":")[0]) if n.split(":")[0].isdigit() else 0)
    db.execute("INSERT OR REPLACE INTO kv VALUES (?, ?)", (TIMETABLE_KV, json.dumps(order[-TIMETABLE_KEEP:])))
    db.commit()


def timetable_notices(items: list[dict]) -> set[str]:
    """EduPage's substitution and school event notices in the timeline, one "<id>:<posted>" each."""
    return {f"{i.get('timelineid')}:{i.get('cas_pridania')}" for i in items if i.get("typ") in TIMETABLE_NOTICES}


def refresh_timetable() -> bool:
    """Asks the backend to read the timetable now (a full sync, read-only on EduPage's side); True when it did."""
    try:
        headers = {"Authorization": f"Bearer {TIMETABLE_TOKEN}"} if TIMETABLE_TOKEN else {}
        req = urllib.request.Request(f"{TIMETABLE_URL}/api/sync", data=b"", method="POST", headers=headers)
        with urllib.request.urlopen(req, timeout=300) as resp:
            status = json.load(resp)
        if not isinstance(status, dict):
            raise ValueError("the answer is not a sync status")
    except Exception as err:
        log("timetable refresh failed:", type(err).__name__)
        return False
    log(f"timetable refresh after a school notice: ok={status.get('ok')} lessons={status.get('lessons')}")
    return status.get("ok") is True


def calendar_call(method: str, path: str, body=None) -> dict:
    """Weft's calendar as Karchi, through the double puppet."""
    req = urllib.request.Request(
        f"{CALENDAR_URL}/_calendar/{path}?user_id={q(ADMIN)}",
        data=None if body is None else json.dumps(body).encode(), method=method,
        headers={"Authorization": f"Bearer {PUPPET_TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp)


def sync_tests(db: sqlite3.Connection, people: dict, today: date | None = None, mine: set[str] | None = None) -> int:
    """Brings the Testy calendar up to date with the tests in the raw timeline; returns how many ops it sent."""
    today = today or date.today()
    items = [json.loads(row[0]) for row in db.execute("SELECT item FROM raw WHERE typ IN ('homework', 'event')")]
    row = db.execute("SELECT value FROM kv WHERE key = ?", (TESTS_KV,)).fetchone()
    state = json.loads(row[0]) if row else {}
    doc = calendar_call("GET", "doc").get("doc") or {}
    ops, record = plan_tests(items, people, doc, state, today, mine)
    if ops:
        calendar_call("POST", "ops", {"ops": ops})
    db.execute("INSERT OR REPLACE INTO kv VALUES (?, ?)", (TESTS_KV, json.dumps(record, ensure_ascii=False)))
    db.commit()
    return len(ops)


class Account:
    """The one EduPage account; the poller thread owns the session, HTTP threads read state."""

    def __init__(self):
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.edu: Edupage | None = None
        self.creds: dict | None = json.loads(ACCOUNT_FILE.read_text()) if ACCOUNT_FILE.exists() else None
        self.state = "CONNECTING"
        self.message = ""
        # (room_id, event_id, replied-to event_id, text, recipient ghost, files, reply_to) written by the admin in
        # Matrix, sent by the poller thread: a reply when it answers a message, else a new message to the
        # recipient. files is the FILES_KEY list of the message, reply_to its REPLY_TO_KEY.
        self.outbox: queue.Queue[tuple[str, str, str, str, str, list, str]] = queue.Queue()
        # Teachers Karchi can start a message to, from the school's data at the last poll.
        self.teachers: list[dict] = []
        self.grades_at = 0.0
        self.grade_marks: set[str] | None = None  # timeline ids of the grade notices at the last poll
        # nudge_timetable: a refresh on its way, the notice mark it finished well, and tries per mark.
        self.timetable_busy = False
        self.timetable_done: set[str] | None = None
        self.timetable_tries: dict[str, int] | None = None  # refreshes per notice, loaded from kv on the first poll
        self.grades_sent: dict | None = None
        self.people_sent: dict | None = None
        self.replies_sent: dict | None = None
        self.facts: dict | None = None
        self.facts_sent: dict | None = None
        self.last_success = 0.0

    def save(self) -> None:
        tmp = ACCOUNT_FILE.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as out:
            json.dump(self.creds, out)
        tmp.replace(ACCOUNT_FILE)

    def keep_session(self, edu: Edupage) -> None:
        """Uses `edu` from now on and stores its session, so a restart reuses it instead of the password (which
        EduPage may answer by asking to confirm the sign-in in its app). Call with the lock held."""
        self.edu = edu
        sid = session_id(edu)
        if self.creds and sid and sid != self.creds.get("session"):
            self.creds["session"] = sid
            self.save()

    def login_view(self) -> list[dict]:
        creds = self.creds
        if not creds:
            return []
        return [{
            "id": creds["login_id"],
            "name": creds["name"],
            "state": {"state_event": self.state, "message": self.message},
            "profile": {"name": creds["name"]},
        }]

    def replace(self, edu: Edupage, creds: dict) -> None:
        with self.lock:
            same = self.creds and self.creds.get("login_id") == creds["login_id"]
            creds["backfilled"] = bool(same and self.creds.get("backfilled"))
            self.edu, self.creds = edu, creds
            self.state, self.message = ("CONNECTED" if creds["backfilled"] else "BACKFILLING"), ""
            self.save()
        self.wake.set()

    def logout(self, login_id: str) -> bool:
        with self.lock:
            if not self.creds or self.creds["login_id"] != login_id:
                return False
            edu, self.edu, self.creds = self.edu, None, None
            ACCOUNT_FILE.unlink(missing_ok=True)
        if edu:
            try:
                edu.logout()
            except requests.RequestException:
                pass
        return True

    def connect(self, creds: dict) -> Edupage:
        """Reuses the stored session, else logs in with the stored password."""
        edu = Edupage(request_timeout=30)
        try:
            LoginSession(edu).reload_data(creds["school"], creds["session"], creds["username"])
            return edu
        except BadCredentialsException:
            pass
        edu = Edupage(request_timeout=30)
        try:
            two_factor = edu.login(creds["username"], creds["password"], creds["school"])
        except BadCredentialsException:
            raise NeedsLogin("EduPage neprijal uložené heslo. Prihlás sa znova.") from None
        except CaptchaException:
            raise NeedsLogin("EduPage chce overenie, že nie si robot. Prihlás sa znova.") from None
        if two_factor is not None:
            raise NeedsLogin("EduPage chce potvrdiť prihlásenie v aplikácii. Prihlás sa znova.")
        creds["session"] = session_id(edu)
        return edu

    def poll(self, rooms: Rooms) -> None:
        with self.lock:
            creds = dict(self.creds) if self.creds else None  # connect() writes the new session into this copy
            edu = self.edu
        if not creds:
            return
        try:
            if edu is None:
                edu = self.connect(creds)
            backfill = not creds.get("backfilled")
            since = school_year_start(date.today()) if backfill else date.today() - timedelta(days=RECENT_DAYS)
            try:
                items = fetch_timeline(edu, since)
            except SessionExpired:
                creds = {**creds, "session": ""}
                edu = self.connect(creds)
                items = fetch_timeline(edu, since)
        except NeedsLogin as err:
            with self.lock:
                if self.creds and self.creds["login_id"] == creds["login_id"]:
                    self.edu, self.state, self.message = None, "BAD_CREDENTIALS", str(err)
            return
        except (requests.RequestException, SessionExpired) as err:
            log("edupage unreachable:", type(err).__name__)
            with self.lock:
                self.state, self.message = "TRANSIENT_DISCONNECT", "EduPage neodpovedá, skúsim to znova o pár minút."
            return
        with self.lock:
            if self.creds is None or self.creds["login_id"] != creds["login_id"]:
                return  # logged out or replaced meanwhile
            self.keep_session(edu)
        settle_before = int((time.time() - SETTLE_AFTER_DAYS * 86400) * 1000) if backfill else None
        try:
            teachers = teacher_contacts(edu)
        except Exception as err:  # the school's data is optional; messages keep working without it
            log("teachers failed:", type(err).__name__)
        else:
            with self.lock:
                self.teachers = teachers
        rooms.keep(items)
        self.nudge_timetable(items, rooms.db)
        rooms.fetch_materials(edu, items)
        try:
            posted = rooms.sync(items, creds["school"], creds["user_id"], settle_before)
            prefs = read_prefs()
            noticed = rooms.notices(items, prefs)
        except (MatrixError, urllib.error.URLError) as err:
            log("matrix error:", err)
            return
        log(f"poll ok: {len(items)} source items, posted {posted} messages, {noticed} notices")
        try:
            replies = rooms.reply_audiences(creds["user_id"])
            if replies != self.replies_sent:
                matrix("PUT", f"/user/{q(ADMIN)}/account_data/{REPLIES_TYPE}", replies, user=ADMIN)
                self.replies_sent = replies
        except (MatrixError, urllib.error.URLError) as err:
            log("replies account data failed:", err)
        marks = {str(i.get("timelineid")) for i in items if i.get("typ") == "znamka"}
        if self.grade_marks is not None and marks - self.grade_marks:
            self.grades_at = 0.0  # a new grade: Ctrl+G shows it now, not up to GRADES_EVERY later
            log("new grade: reading the grade book now")
        self.grade_marks = marks
        self.sync_grades(edu, [row[0] for row in rooms.db.execute("SELECT mxid FROM ghosts")], rooms.db)
        try:
            people = {**school_people(edu), "groups": (self.facts or {}).get("groups") or []}
            changed = sync_tests(rooms.db, people, mine=mine_subjects(self.facts, read_account(RULES_TYPE)))
        except Exception as err:  # the calendar is optional; messages keep working without it
            log("tests calendar failed:", type(err).__name__, err)
        else:
            if changed:
                log(f"tests calendar: {changed} changes")
        with self.lock:
            if self.creds and self.creds["login_id"] == creds["login_id"]:
                if backfill:
                    self.creds["backfilled"] = True
                    self.save()
                self.state, self.message = "CONNECTED", ""
                self.last_success = time.time()
                rooms.db.execute("INSERT OR REPLACE INTO kv VALUES ('last_success', ?)", (str(self.last_success),))
                rooms.db.commit()

    def nudge_timetable(self, items: list[dict], db: sqlite3.Connection) -> None:
        """Once per new substitution or school event notice, the timetable backend reads EduPage again. The first poll
        only remembers what is there (also nothing); a notice counts as handled once the backend said its sync went
        well. A notice that only left the fetched days is no news."""
        if not TIMETABLE_URL:
            return
        notices = timetable_notices(items)
        with self.lock:
            done = self.timetable_done
            self.timetable_done = None
            busy = self.timetable_busy
        row = db.execute("SELECT value FROM kv WHERE key = ?", (TIMETABLE_KV,)).fetchone()
        try:
            handled = set(json.loads(row[0])) if row else None
        except (ValueError, TypeError):
            handled = None  # an older format: start over from what is there now
        if handled is None or done:
            handled = (handled or set()) | (notices if handled is None else done)
            store_handled(db, handled)
            if row is None:
                return
        new = frozenset(notices - handled)
        if not new or busy:
            return
        if self.timetable_tries is None:
            stored = db.execute("SELECT value FROM kv WHERE key = ?", (TIMETABLE_TRIES_KV,)).fetchone()
            try:
                self.timetable_tries = {str(n): int(c) for n, c in json.loads(stored[0]).items()} if stored else {}
            except (ValueError, TypeError, AttributeError):
                self.timetable_tries = {}
        tries = {n: c for n, c in self.timetable_tries.items() if n not in handled}  # kept while a notice is away
        if all(tries.get(n, 0) >= TIMETABLE_TRIES for n in new):
            return  # the backend's own rounds bring it in
        tries.update({n: tries.get(n, 0) + 1 for n in new})
        self.timetable_tries = dict(list(tries.items())[-TIMETABLE_KEEP:])
        db.execute("INSERT OR REPLACE INTO kv VALUES (?, ?)", (TIMETABLE_TRIES_KV, json.dumps(self.timetable_tries)))
        db.commit()
        self.timetable_busy = True
        path = db.execute("PRAGMA database_list").fetchone()[2]  # "" for an in-memory database

        def run() -> None:
            ok = False
            try:
                ok = refresh_timetable()
                if ok and path:  # stored at once, so a restart before the next poll does not ask again
                    with closing(sqlite3.connect(path, timeout=10)) as own:
                        row = own.execute("SELECT value FROM kv WHERE key = ?", (TIMETABLE_KV,)).fetchone()
                        store_handled(own, set(json.loads(row[0])) | new if row else set(new))
            except (sqlite3.Error, ValueError, TypeError) as e:
                print(f"timetable: could not store the handled notice: {e}", flush=True)
            finally:
                with self.lock:
                    self.timetable_busy = False
                    if ok:
                        self.timetable_done = set(new)
        threading.Thread(target=run, daemon=True).start()

    def sync_grades(self, edu: Edupage, ghosts: list[str], db: sqlite3.Connection) -> None:
        """Grades for the grade panel, teacher colors and the school facts, refreshed every GRADES_EVERY."""
        if time.time() - self.grades_at < GRADES_EVERY:
            return
        self.grades_at = time.time()
        try:
            people = {"colors": teacher_colors(edu, ghosts), "me": my_name(edu)}
        except Exception as err:  # the timetable is optional, messages keep working without colors
            log("colors failed:", repr(err))
        else:
            if people != self.people_sent:
                matrix("PUT", f"/user/{q(ADMIN)}/account_data/{PEOPLE_TYPE}", people, user=ADMIN)
                self.people_sent = people
        try:
            grades = grade_book(edu)
        except Exception as err:  # the grades page is scraped; a layout change must not stop polling
            log("grades failed:", repr(err))
            return
        if grades != self.grades_sent:
            matrix("PUT", f"/user/{q(ADMIN)}/account_data/{GRADES_TYPE}", grades, user=ADMIN)
            self.grades_sent = grades
        self.sync_facts(edu, grades, db)

    def sync_facts(self, edu: Edupage, book: dict, db: sqlite3.Connection) -> None:
        """Whose subjects and notices are whose (school_facts), for Weft's rules and the Testy calendar."""
        try:
            lessons = my_lessons(edu, date.today())
        except Exception as err:  # the timetable is optional; the calendar copy and the grades still tell
            log("own timetable failed:", repr(err))
            lessons = None
        try:
            calendar = calendar_subjects(calendar_call("GET", "doc").get("doc") or {})
        except Exception as err:
            log("timetable calendar failed:", type(err).__name__)
            calendar = set()
        row = db.execute("SELECT value FROM kv WHERE key = ?", (LEARNED_KV,)).fetchone()
        learned = set(json.loads(row[0])) if row else set()
        if lessons:
            learned |= {l["subject"] for l in lessons}
            db.execute("INSERT OR REPLACE INTO kv VALUES (?, ?)", (LEARNED_KV, json.dumps(sorted(learned))))
            db.commit()
        items = [json.loads(r[0]) for r in db.execute("SELECT item FROM raw")]
        facts = school_facts(book, school_people(edu), lessons, calendar, learned, items)
        self.facts = facts
        if facts != self.facts_sent:
            matrix("PUT", f"/user/{q(ADMIN)}/account_data/{FACTS_TYPE}", facts, user=ADMIN)
            self.facts_sent = facts
            mine = [s["name"] for s in facts["subjects"] if s["mine"]]
            log(f"facts: {len(mine)} of {len(facts['subjects'])} subjects are his, timetable={facts['timetable']}, "
                f"groups={len(facts['groups'])}, {sum(1 for f in facts['items'].values() if f.get('others'))} notices for others")

    def send_outbox(self, rooms: Rooms) -> None:
        while True:
            try:
                room_id, event_id, answers, text, recipient, files, reply_to = self.outbox.get_nowait()
            except queue.Empty:
                return
            if room_id != rooms.school_room()[0]:
                continue
            root = rooms.root_of(answers) if answers else None
            with self.lock:
                teacher = any(t["id"] == recipient for t in self.teachers)
            known = teacher or (rooms.db.execute("SELECT 1 FROM ghosts WHERE mxid = ?", (recipient,)).fetchone() if recipient else None)
            to = recipient_id(recipient) if known and not answers else None
            if root is None and to is None:
                rooms.say(room_id, "Neodoslané: EduPage nevie poslať správu bez adresáta. Odpovedz na konkrétnu správu.", event_id)
                continue
            with self.lock:
                creds, edu = (dict(self.creds) if self.creds else None), self.edu
            if not creds:
                rooms.say(room_id, "Neodoslané: EduPage nie je pripojený.", event_id)
                continue
            try:
                if edu is None:
                    edu = self.connect(creds)
                blobs = [(str(f.get("name") or "subor"), str(f.get("mimetype") or ""), matrix_file(str(f.get("url") or "")))
                         for f in files]

                user_id = str(creds.get("user_id") or "")
                known = {row[0] for row in rooms.db.execute("SELECT id FROM items")}
                to_whom = reply_recipient(rooms.raw_item(root), user_id, reply_to) if root is not None else ""

                def send(e: Edupage) -> int | None:
                    # Uploaded with the session that sends, so a renewed session uploads them again.
                    attachments = dict(upload_attachment(e, *blob) for blob in blobs)
                    if root is not None:
                        return send_reply(e, root, text, attachments, to_whom, user_id, known)
                    return send_message(e, to, text, attachments, user_id, known)
                try:
                    item_id = send(edu)
                except SessionExpired:
                    edu = self.connect({**creds, "session": ""})
                    item_id = send(edu)
                if item_id is None:
                    log("sent, but EduPage did not say under which id")
                else:
                    rooms.mark_sent(item_id, root if root is not None else item_id, event_id)
                with self.lock:
                    if self.creds and self.creds["login_id"] == creds["login_id"]:
                        self.keep_session(edu)
            except AttachmentRefused as err:
                rooms.say(room_id, f"Táto správa neodišla do EduPage: {err}. Skús iný súbor alebo ju pošli bez neho.", event_id)
            except Exception as err:
                log("reply failed:", repr(err))
                rooms.say(room_id, "Táto správa neodišla do EduPage. Skús to znova alebo odpovedz na edupage.org.", event_id)

    def run(self) -> None:
        rooms = Rooms(open_db())
        while True:
            try:
                self.send_outbox(rooms)
                self.poll(rooms)
            except Exception as err:  # keep polling; a bug in one item must not stop the bridge
                log("poll failed:", repr(err))
            self.wake.wait(POLL_SECONDS)
            self.wake.clear()


ACCOUNT = Account()


# ---------------------------------------------------------------- provisioning API

CREDENTIALS_STEP = {
    "type": "user_input",
    "step_id": "sk.karchi.edupage.credentials",
    "instructions": "Prihlás sa rovnako ako na edupage.org.",
    "user_input": {
        "fields": [
            {"type": "username", "id": "username", "name": "Meno alebo e-mail"},
            {"type": "password", "id": "password", "name": "Heslo"},
            {
                "type": "domain",
                "id": "school",
                "name": "Škola",
                "optional": True,
                "description": "Nepovinné. Keď máš účet na viacerých školách, napíš začiatok adresy školy, "
                "napríklad mojaskola z mojaskola.edupage.org.",
            },
        ]
    },
}
CONFIRM_STEP = {
    "type": "display_and_wait",
    "step_id": "sk.karchi.edupage.confirm",
    "instructions": "EduPage chce potvrdiť prihlásenie. Otvor aplikáciu EduPage v telefóne a potvrď ho.",
    "display_and_wait": {"type": "nothing"},
}

PROCESSES: dict[str, dict] = {}
PROCESS_TTL = 15 * 60


class ApiError(Exception):
    def __init__(self, status: int, errcode: str, message: str):
        super().__init__(message)
        self.status, self.errcode, self.message = status, errcode, message


def process(process_id: str) -> dict:
    now = time.time()
    for key in [key for key, value in PROCESSES.items() if now - value["created"] > PROCESS_TTL]:
        PROCESSES.pop(key, None)
    found = PROCESSES.get(process_id)
    if not found:
        raise ApiError(404, "SK.KARCHI.EXPIRED", "Prihlásenie vypršalo. Začni znova.")
    return found


def finish(process_id: str, edu: Edupage, proc: dict) -> dict:
    ACCOUNT.replace(edu, complete_login(edu, proc["password"], proc["school_hint"]))
    PROCESSES.pop(process_id, None)
    return {
        "login_id": process_id,
        "type": "complete",
        "step_id": "sk.karchi.edupage.complete",
        "instructions": f"Successfully logged in as {ACCOUNT.creds['name']}",
        "complete": {"user_login_id": ACCOUNT.creds["login_id"]},
    }


def submit_credentials(process_id: str, proc: dict, body: dict) -> dict:
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")
    school = re.sub(r"(\.edupage\.org.*|^https?://)", "", str(body.get("school") or "").strip().lower())
    if not username or not password:
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Vyplň meno aj heslo.")
    if school and not re.fullmatch(r"[a-z0-9-]{1,63}", school):
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Škola je začiatok adresy, napríklad mojaskola.")
    edu = Edupage(request_timeout=30)
    try:
        two_factor = edu.login(username, password, school) if school else edu.login_auto(username, password)
    except BadCredentialsException:
        raise ApiError(400, "SK.KARCHI.BAD_CREDENTIALS", "Meno alebo heslo nesedí.") from None
    except CaptchaException:
        raise ApiError(
            400,
            "SK.KARCHI.CAPTCHA",
            "EduPage chce overenie, že nie si robot. Prihlás sa raz na edupage.org v prehliadači a skús to znova.",
        ) from None
    except requests.RequestException:
        raise ApiError(504, "SK.KARCHI.UNREACHABLE", "EduPage neodpovedá. Skús to o chvíľu.") from None
    proc.update(password=password, school_hint=school)
    if two_factor is None:
        return finish(process_id, edu, proc)
    proc.update(edu=edu, two_factor=two_factor)
    return {"login_id": process_id, **CONFIRM_STEP}


def wait_confirmation(process_id: str, proc: dict) -> dict:
    two_factor = proc.get("two_factor")
    if two_factor is None:
        raise ApiError(400, "SK.KARCHI.BAD_STATE", "Najprv zadaj meno a heslo.")
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            if two_factor.is_confirmed():
                two_factor.finish()
                return finish(process_id, proc["edu"], proc)
        except SecondFactorFailedException:
            raise ApiError(400, "SK.KARCHI.2FA_FAILED", "Potvrdenie vypršalo. Začni prihlásenie znova.") from None
        except requests.RequestException:
            pass
        time.sleep(2)
    return {"login_id": process_id, **CONFIRM_STEP}


PREFIX = "/_matrix/provision/v3"
SEEN_TXNS: "collections.deque[str]" = collections.deque(maxlen=200)


class Handler(BaseHTTPRequestHandler):
    def reply(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_appservice(self, path: str) -> None:
        """Homeserver pushes (appservice API): the admin's messages in the EduPage room go to EduPage."""
        token = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if token != HS_TOKEN:
            return self.reply(403, {"errcode": "M_FORBIDDEN", "error": ""})
        if not path.startswith("/_matrix/app/v1/transactions/"):
            return self.reply(200 if path == "/_matrix/app/v1/ping" else 404, {})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except ValueError:
            return self.reply(400, {"errcode": "M_BAD_JSON", "error": ""})
        txn = path.rsplit("/", 1)[1]
        if txn not in SEEN_TXNS:
            SEEN_TXNS.append(txn)
            for event in body.get("events") or []:
                content = event.get("content") or {}
                files = content.get(FILES_KEY)
                files = [f for f in files if isinstance(f, dict)] if isinstance(files, list) else []
                if (
                    event.get("type") == "m.room.message"
                    and event.get("sender") == ADMIN
                    and MARK not in content
                    and content.get("msgtype") == "m.text"
                    and isinstance(content.get("body"), str)
                    and (content["body"].strip() or files)
                ):
                    text = re.sub(r"^(> .*\n)+\n", "", content["body"])  # drop a Matrix reply quote
                    answers = ((content.get("m.relates_to") or {}).get("m.in_reply_to") or {}).get("event_id")
                    recipient = content.get(RECIPIENT_KEY) if isinstance(content.get(RECIPIENT_KEY), str) else ""
                    reply_to = content.get(REPLY_TO_KEY) if isinstance(content.get(REPLY_TO_KEY), str) else ""
                    ACCOUNT.outbox.put((event["room_id"], event["event_id"], str(answers or ""), text.strip(), recipient, files, reply_to))
                    ACCOUNT.wake.set()
        self.reply(200, {})

    def do_PUT(self) -> None:
        self.handle_appservice(urllib.parse.urlsplit(self.path).path)

    def handle_api(self, method: str) -> None:
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/_matrix/app/"):
            return self.handle_appservice(path)
        if not path.startswith(PREFIX):
            return self.reply(404, {"errcode": "M_NOT_FOUND", "error": ""})
        token = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if not token or whoami(token) != ADMIN:
            return self.reply(403, {"errcode": "M_FORBIDDEN", "error": "Only the server admin can use this bridge"})
        body = {}
        if method == "POST":
            try:
                raw = self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 16384))
                body = json.loads(raw) if raw else {}
            except ValueError:
                return self.reply(400, {"errcode": "M_BAD_JSON", "error": ""})
            if not isinstance(body, dict):
                return self.reply(400, {"errcode": "M_BAD_JSON", "error": ""})
        parts = [urllib.parse.unquote(part) for part in path[len(PREFIX):].strip("/").split("/")]
        try:
            self.reply(200, route(method, parts, body))
        except ApiError as err:
            self.reply(err.status, {"errcode": err.errcode, "error": err.message})

    def do_GET(self) -> None:
        self.handle_api("GET")

    def do_POST(self) -> None:
        self.handle_api("POST")

    def log_message(self, fmt: str, *args) -> None:  # keep passwords and tokens out of the journal
        pass


def route(method: str, parts: list[str], body: dict) -> dict:
    match method, parts:
        case "GET", ["whoami"]:
            return {
                "network": {"displayname": "EduPage"},
                "login_flows": [FLOW],
                "homeserver": SERVER_NAME,
                "bridge_bot": BOT,
                "logins": ACCOUNT.login_view(),
                "last_success": ACCOUNT.last_success,
            }
        case "GET", ["login", "flows"]:
            return {"flows": [FLOW]}
        case "GET", ["contacts"]:
            with ACCOUNT.lock:
                return {"contacts": list(ACCOUNT.teachers)}
        case "POST", ["login", "start", "password"]:
            process_id = uuid.uuid4().hex
            PROCESSES[process_id] = {"created": time.time()}
            return {"login_id": process_id, **CREDENTIALS_STEP}
        case "POST", ["login", "step", process_id, "sk.karchi.edupage.credentials", "user_input"]:
            return submit_credentials(process_id, process(process_id), body)
        case "POST", ["login", "step", process_id, "sk.karchi.edupage.confirm", "display_and_wait"]:
            return wait_confirmation(process_id, process(process_id))
        case "POST", ["login", "cancel", process_id]:
            PROCESSES.pop(process_id, None)
            return {}
        case "POST", ["logout", login_id]:
            if not ACCOUNT.logout(login_id):
                raise ApiError(404, "SK.KARCHI.NO_LOGIN", "Tento účet tu už nie je.")
            return {}
    raise ApiError(404, "M_UNRECOGNIZED", "")


def main() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=ACCOUNT.run, name="poller", daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("PORT", "29321"))), Handler)
    log(f"edupage bridge on {server.server_address[0]}:{server.server_address[1]}")
    server.serve_forever()


if __name__ == "__main__":
    main()

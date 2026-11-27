"""Matrix accounts on other homeservers (matrix.org, beeper.com, a friend's server) for Weft, as one more network.

Weft's own homeserver stays private (no federation). This bridge signs in to Karchi's account on another
homeserver as a client of its own (a device called "Weft") and mirrors his chats there into Weft's homeserver
through the appservice in REGISTRATION, the way the other bridges do: each chat is a room with an m.bridge state
(protocol "matrix"), its people are ghosts (@matrix_<their id, escaped>:<Weft's server>), and Karchi's own messages
from other clients come in through the double puppet (DOUBLEPUPPET), as his.

What goes across, both ways: text and notices (with formatting), replies, edits, reactions, read receipts and
typing; files and pictures are uploaded again on the other side. End-to-end encrypted rooms work: the bridge's
device has its own Olm account (mautrix-python with python-olm), stored per login in STATE_DIR/<login>/keys.db.
Nothing is backfilled: a chat shows up in Weft with the first message after sign-in, or when Karchi starts it.
Invitations are not accepted by the bridge (spam on public servers); rooms that are themselves bridges on the
other server (m.bridge state, e.g. Beeper's own WhatsApp rooms) are left out, so nothing comes twice.

Provisioning speaks the subset of the mautrix bridgev2 API that Weft's Accounts page and Ctrl+N use:

  GET  /_matrix/provision/v3/whoami
  POST /_matrix/provision/v3/login/start/<password|token>
  POST /_matrix/provision/v3/login/step/<process>/<step>/user_input
  POST /_matrix/provision/v3/login/cancel/<process>
  POST /_matrix/provision/v3/logout/<login>     stops, signs the device out (password logins), forgets keys and chats
  POST /_matrix/provision/v3/create_dm/<@user:server>   -> {"room_id"}: a new encrypted DM, Karchi in it at once
  POST /_matrix/provision/v3/join  {"room": "#alias:server" or "!id:server"}   -> {"room_id"}

Each request carries Karchi's Matrix token for Weft's homeserver (Caddy's /_bridges/matrix/ adds nothing).

Environment: HOMESERVER (Weft's, http://127.0.0.1:8008), SERVER_NAME, ADMIN_MXID, REGISTRATION, DOUBLEPUPPET
(optional), STATE_DIR, PORT (29333).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import shutil
import sqlite3
import time
import urllib.parse
from pathlib import Path

import aiohttp
from aiohttp import web
from mautrix.api import Method
from mautrix.appservice import AppService
from mautrix.appservice.state_store.file import FileASStateStore
from mautrix.client import Client, InternalEventType
from mautrix.client.state_store import SyncStore
from mautrix.client.state_store.asyncpg import PgStateStore
from mautrix.crypto import OlmMachine, PgCryptoStore
from mautrix.client.encryption_manager import DecryptionDispatcher
from mautrix.crypto.attachments import decrypt_attachment, encrypt_attachment
from mautrix.errors import DecryptionError, MatrixError, MatrixRequestError, MNotFound, SessionNotFound
from mautrix.types import (EventType, Filter, LoginType, PresenceState, ReceiptType, RoomCreatePreset, RoomEventFilter,
                           RoomFilter, RoomID, StateFilter, UserID)
from mautrix.util.async_db import Database

log = logging.getLogger("weft.matrix")

HOMESERVER = os.environ.get("HOMESERVER", "http://127.0.0.1:8008")
SERVER_NAME = os.environ["SERVER_NAME"]
ADMIN = UserID(os.environ["ADMIN_MXID"])
STATE_DIR = Path(os.environ.get("STATE_DIR", "state"))
PORT = int(os.environ.get("PORT", "29333"))
PROTOCOL = {"id": "matrix", "displayname": "Matrix"}
GHOST_PREFIX = "matrix_"
DEVICE_NAME = "Weft"
# What the bridge copies across; anything else (calls, polls, stickers of other kinds) stays where it is.
MESSAGE_TYPES = {EventType.ROOM_MESSAGE, EventType.REACTION, EventType.STICKER}
MEDIA_KEYS = ("url", "file")
MEDIA_MAX = 25 * 1024 * 1024  # bytes a file may have to cross; more becomes a note in the chat
GHOSTS_AT_ONCE = 20  # rooms up to this many people get all their ghosts at once, bigger ones as people write
FROM_THERE = "sk.karchi.matrix.remote"
SEND_STATUS = EventType.find("com.beeper.message_send_status", EventType.Class.MESSAGE)
# A Filter object, which mautrix uploads once: a dict would go into ?filter= as Python's text, which Synapse refuses.
SYNC_FILTER = Filter(room=RoomFilter(timeline=RoomEventFilter(limit=20), state=StateFilter(lazy_load_members=True)))  # on a message Weft got from there: its event id there


def registration_value(path: str, key: str) -> str:
    match = re.search(rf"^{key}:\s*['\"]?([^'\"\s]+)", Path(path).read_text(), re.M)
    if not match:
        raise SystemExit(f"no {key} in {path}")
    return match.group(1)


AS_TOKEN = registration_value(os.environ["REGISTRATION"], "as_token")
HS_TOKEN = registration_value(os.environ["REGISTRATION"], "hs_token")
BOT_LOCALPART = registration_value(os.environ["REGISTRATION"], "sender_localpart")
PUPPET_TOKEN = registration_value(os.environ["DOUBLEPUPPET"], "as_token") if os.environ.get("DOUBLEPUPPET") else ""


def ghost_of(remote: str) -> UserID:
    """@alice:matrix.org -> @matrix_alice=3amatrix.org:<server>; every character outside [a-z0-9._-] as =xx."""
    body = "".join(c if re.match(r"[a-z0-9._-]", c) else "".join(f"={b:02x}" for b in c.encode()) for c in remote.lstrip("@"))
    return UserID(f"@{GHOST_PREFIX}{body}:{SERVER_NAME}")


def remote_of(ghost: str) -> str | None:
    m = re.match(rf"^@{GHOST_PREFIX}(.+):{re.escape(SERVER_NAME)}$", ghost, re.I)
    if not m:
        return None
    raw = re.sub(r"(=[0-9a-f]{2})+", lambda g: bytes.fromhex(g.group(0).replace("=", "")).decode("utf-8", "replace"), m.group(1))
    return "@" + raw


# A user link, written with "@" or "%40" (Element and Beeper encode it), alone or as the whole <a> around it.
MATRIX_TO = re.compile(
    r"<a\s(?:[^>]*?\s)?href=[\"']https?://matrix\.to/#/((?:@|%40)[^\"'<>\s?/&]+)[^\"'<>\s]*[\"'][^>]*>(.*?)</a>"  # 1 id, 2 text
    r"|https?://matrix\.to/#/((?:@|%40)[^\"'<>\s?/&]+)(?:\?[^\"'<>\s&]*(?:&amp;[^\"'<>\s&]*)*)?",  # 3 id, its ?via=…
    re.S | re.I)
TRAILING = re.compile(r"[.,;:!?)\]]+$")  # sentence punctuation after a bare link is not part of it


def translate_users(content: dict, to_local: bool, me: str) -> None:
    """Mentions (m.mentions and matrix.to links) name the same people on the other side: going out a ghost becomes
    its remote id and Karchi his remote account, and nothing names Weft's own server or carries Weft's own fields
    (sk.karchi.*); coming in Karchi's remote account becomes him and anyone else a ghost. A link to someone who
    has no account there (another bridge's ghost, a bot) goes out as its text alone."""
    def other(uid) -> str | None:
        if not isinstance(uid, str) or not uid.startswith("@"):
            return None
        if to_local:
            return str(ADMIN) if uid == me else str(ghost_of(uid))
        if uid == ADMIN:
            return me
        if not uid.lower().endswith(f":{SERVER_NAME.lower()}"):
            return uid  # someone of another server, already named as they are there
        return remote_of(uid)

    def href(mapped: str) -> str:
        return f"https://matrix.to/#/{urllib.parse.quote(mapped, safe='@:')}"

    def link(m: re.Match) -> str:
        if m.group(1) is not None:
            mapped = other(urllib.parse.unquote(m.group(1)))
            text = MATRIX_TO.sub(link, m.group(2))  # an auto-linked text is a link too
            return f'<a href="{href(mapped)}">{text}</a>' if mapped else text
        raw = m.group(0)
        tail = TRAILING.search(raw)
        if tail:
            raw = raw[:tail.start()]
        uid = urllib.parse.unquote(MATRIX_TO.match(raw).group(3)) if MATRIX_TO.match(raw) else ""
        mapped = other(uid)
        kept = href(mapped) if mapped else ("" if not to_local else raw)
        return kept + (tail.group(0) if tail else "")

    for part in (content, content.get("m.new_content")):
        if not isinstance(part, dict):
            continue
        if not to_local:
            for key in [k for k in part if k.startswith("sk.karchi.")]:
                part.pop(key)
        mentions = part.get("m.mentions")
        if isinstance(mentions, dict) and isinstance(mentions.get("user_ids"), list):
            # A new dict: an edit's two m.mentions may be one object, and must not be translated twice.
            part["m.mentions"] = {**mentions, "user_ids": [u for u in map(other, mentions["user_ids"]) if u]}
        if isinstance(part.get("formatted_body"), str):
            part["formatted_body"] = MATRIX_TO.sub(link, part["formatted_body"])


class Store:
    """The bridge's own small database: the login, which remote room is which Weft room, and message ids."""

    # Each step brings a database from the version before it to its own; PRAGMA user_version says which ran.
    # A new column or table is a new step at the end, never an edit of an old one. Rows are read by column name.
    MIGRATIONS = [
        """
        CREATE TABLE IF NOT EXISTS login (id TEXT PRIMARY KEY, homeserver TEXT, user_id TEXT, device_id TEXT,
            token TEXT, own_device INTEGER, pickle_key TEXT, since INTEGER, next_batch TEXT, name TEXT);
        CREATE TABLE IF NOT EXISTS portal (remote TEXT PRIMARY KEY, local TEXT UNIQUE, dm INTEGER, name TEXT);
        CREATE TABLE IF NOT EXISTS message (remote TEXT PRIMARY KEY, local TEXT UNIQUE, room TEXT);
        CREATE TABLE IF NOT EXISTS ghost (mxid TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE IF NOT EXISTS skipped (remote TEXT PRIMARY KEY);
        """,
    ]

    def __init__(self, path: Path):
        self.db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode = WAL")
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version > len(self.MIGRATIONS):
            raise SystemExit(f"bridge.db is version {version}, newer than this bridge ({len(self.MIGRATIONS)})")
        for number, step in enumerate(self.MIGRATIONS[version:], start=version + 1):
            self.db.executescript(f"BEGIN; {step}; PRAGMA user_version = {number}; COMMIT;")

    def one(self, sql: str, *args):
        return self.db.execute(sql, args).fetchone()

    def all(self, sql: str, *args):
        return self.db.execute(sql, args).fetchall()

    def run(self, sql: str, *args) -> None:
        self.db.execute(sql, args)


class DBSyncStore(SyncStore):
    def __init__(self, store: Store, login: str):
        self.store, self.login = store, login

    async def put_next_batch(self, next_batch) -> None:
        self.store.run("UPDATE login SET next_batch = ? WHERE id = ?", next_batch, self.login)

    async def get_next_batch(self):
        row = self.store.one("SELECT next_batch FROM login WHERE id = ?", self.login)
        return row[0] if row else None


class Remote:
    """Karchi's account on the other homeserver: a syncing client with its own encryption keys."""

    def __init__(self, bridge: Bridge, row: tuple):
        self.bridge = bridge
        self.id, self.homeserver, self.user_id, self.device_id = row["id"], row["homeserver"], row["user_id"], row["device_id"]
        self.own_device, self.since, self.name = row["own_device"], row["since"], row["name"]
        token, pickle_key = row["token"], row["pickle_key"]
        self.dir = STATE_DIR / self.id
        self.dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        # One file for room state and keys: inside a crypto transaction mautrix hands every Database the same
        # connection (a context variable), so a second file's tables would not be found there.
        self.db = Database.create(f"sqlite:{self.dir / 'keys.db'}", upgrade_table=PgCryptoStore.upgrade_table)
        self.state_store = PgStateStore(self.db)
        self.crypto_store = PgCryptoStore(self.user_id, pickle_key, self.db)
        self.client = Client(mxid=UserID(self.user_id), device_id=self.device_id, base_url=self.homeserver, token=token,
                             state_store=self.state_store, sync_store=DBSyncStore(bridge.store, self.id))
        self.client.ignore_initial_sync = False
        self.client.presence = PresenceState.OFFLINE  # reading here never shows Karchi online there
        self.state = "CONNECTING"
        self.message = ""
        self.sent: set[str] = set()  # transaction ids of what the bridge sent, so their echoes are not copied back
        # Each room's events in the order the server gave them: mautrix runs each handler (and each decryption) as
        # its own task, which let quick messages overtake each other and a reaction come before its message. One queue
        # per room, so a key still on its way holds back only that room.
        self.queues: dict[str, asyncio.Queue] = {}
        self.pumps: dict[str, asyncio.Task] = {}
        self.ready = asyncio.Event()  # set once encryption is on: nothing is sent there before
        self.first_sync, self.had_batch = True, False

    async def start(self) -> None:
        await self.db.start()
        await PgStateStore.upgrade_table.upgrade(self.db)
        await self.crypto_store.open()
        machine = OlmMachine(self.client, self.crypto_store, self.state_store)
        self.client.crypto = machine
        self.client.remove_dispatcher(DecryptionDispatcher)  # decrypted in order by pump() instead
        await machine.load()
        if not await self.crypto_store.get_device_id():
            await self.crypto_store.put_device_id(self.client.device_id)
        if not machine.account.shared:
            await machine.share_keys()
        for kind in (*MESSAGE_TYPES, EventType.ROOM_ENCRYPTED, EventType.RECEIPT, EventType.TYPING, EventType.ROOM_REDACTION):
            self.client.add_event_handler(kind, self.enqueue)
        self.client.add_event_handler(InternalEventType.SYNC_SUCCESSFUL, self.on_sync_ok)
        self.client.add_event_handler(InternalEventType.SYNC_ERRORED, self.on_sync_error)
        self.client.add_event_handler(InternalEventType.SYNC_STOPPED, self.on_sync_stopped)
        self.had_batch = bool(await self.client.sync_store.get_next_batch())
        self.client.start(SYNC_FILTER)
        self.ready.set()

    async def enqueue(self, evt) -> None:
        # No await before this: tasks start in the order they were made.
        room = str(getattr(evt, "room_id", "") or "")
        if room not in self.queues:
            self.queues[room] = asyncio.Queue()
            self.pumps[room] = asyncio.create_task(self.pump(self.queues[room]))
        self.queues[room].put_nowait(evt)

    def wanted(self, evt) -> bool:
        """Old events (from before sign-in) and ones already copied are dropped before any key is waited for."""
        stamp = getattr(evt, "timestamp", None)
        if stamp is not None and stamp < self.since:
            return False
        event_id = getattr(evt, "event_id", None)
        return not (event_id and self.bridge.store.one("SELECT 1 FROM message WHERE remote = ?", event_id))

    async def pump(self, queue: asyncio.Queue) -> None:
        while True:
            evt = await queue.get()
            try:
                if not self.wanted(evt):
                    continue
                if evt.type == EventType.ROOM_ENCRYPTED:
                    if not (evt.serialize().get("content") or {}).get("ciphertext"):
                        continue  # deleted there before it reached Weft: nothing to read, nothing to note
                    clear = await self.decrypt(evt)
                    if not clear:
                        await self.cannot_read(evt)
                        continue
                    evt = clear
                if evt.type in MESSAGE_TYPES:
                    await self.on_message(evt)
                elif evt.type == EventType.ROOM_REDACTION:
                    await self.on_redaction(evt)
                elif evt.type == EventType.RECEIPT:
                    await self.on_receipt(evt)
                elif evt.type == EventType.TYPING:
                    await self.on_typing(evt)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("event %s not handled", getattr(evt, "event_id", evt.type))

    async def decrypt(self, evt):
        """Its key may still be on the way (it comes to the device separately): wait a little for it."""
        for attempt in range(2):
            try:
                return await self.client.crypto.decrypt_megolm_event(evt)
            except SessionNotFound:
                if attempt or not await self.client.crypto.wait_for_session(evt.room_id, evt.content.session_id, timeout=10):
                    log.warning("no key for %s; it stays on the other server", evt.event_id)
                    return None
            except DecryptionError as err:
                log.warning("cannot decrypt %s: %s", evt.event_id, err)
                return None

    async def cannot_read(self, evt) -> None:
        """A message whose key never came still shows that it was there, instead of vanishing."""
        local = await self.bridge.portal(self, evt.room_id)
        if not local:
            return
        who = "Ty (z inej aplikácie)" if evt.sender == self.user_id else evt.sender
        await self.bridge.az.intent.send_notice(local, f"{who}: šifrovaná správa, ktorú Weft nevie prečítať (kľúč k nej neprišiel).")

    async def on_sync_ok(self, evt: dict) -> None:
        self.state, self.message = "CONNECTED", ""
        # After a gap (a restart, the server down) a room with more new events than one sync carries says so.
        first, self.first_sync = self.first_sync, False
        if first and not self.had_batch:
            return
        for room, data in ((evt.get("data") or {}).get("rooms", {}).get("join", {}) or {}).items():
            if (data.get("timeline") or {}).get("limited") and (local := await self.bridge.portal(self, room, create=False)):
                await self.bridge.az.intent.send_notice(local, "Niektoré správy z tohto chatu sa do Weftu nedostali (most bol chvíľu mimo). Nájdeš ich v inej Matrix aplikácii.")

    # mautrix hands internal events over as a dict of its keyword arguments.
    async def on_sync_error(self, evt: dict) -> None:
        err = evt.get("error")
        if isinstance(err, MatrixRequestError) and err.http_status == 401:
            self.state, self.message = "BAD_CREDENTIALS", "The other homeserver signed this device out."
            self.client.stop()
        else:
            self.state, self.message = "TRANSIENT_DISCONNECT", str(err or "")[:200]

    async def on_sync_stopped(self, evt: dict) -> None:
        """A token the server no longer knows ends syncing for good; anything else (the filter not made while the
        server was down) starts it again in a while."""
        err = evt.get("error")
        if err is None or not self.ready.is_set():
            return  # stopped on purpose
        if isinstance(err, MatrixRequestError) and err.http_status == 401:
            self.state, self.message = "BAD_CREDENTIALS", "The other homeserver signed this device out."
            return
        self.state, self.message = "TRANSIENT_DISCONNECT", str(err)[:200]
        await asyncio.sleep(30)
        if self.ready.is_set() and self.bridge.remote is self:
            self.client.start(SYNC_FILTER)

    async def stop(self) -> None:
        self.ready.clear()
        self.client.stop()
        for task in self.pumps.values():
            task.cancel()
        await asyncio.sleep(0)
        try:
            await self.db.stop()
        except Exception:
            pass

    # -------------------------------------------------- the other homeserver → Weft

    def is_echo(self, evt) -> bool:
        txn = getattr(evt.unsigned, "transaction_id", None) if evt.unsigned else None
        return evt.sender == self.user_id and txn in self.sent

    async def on_message(self, evt) -> None:
        if evt.timestamp < self.since or self.is_echo(evt) or self.bridge.store.one("SELECT 1 FROM message WHERE remote = ?", evt.event_id):
            return
        content = evt.content.serialize()
        if not self.bridge.map_relations(content, to_local=True):
            return  # an edit or reaction of something Weft never had (no empty chat is made for it)
        translate_users(content, to_local=True, me=self.user_id)
        portal = await self.bridge.portal(self, evt.room_id)
        if not portal:
            return
        if any(k in content for k in MEDIA_KEYS):
            await self.bridge.copy_media(content, self.client, self.bridge.az.intent, encrypt=False)
        if evt.sender == self.user_id:
            intent = self.bridge.admin_intent()
            if not intent:
                return
        else:
            intent = await self.bridge.ghost(self, portal, evt.sender)
        event_type = EventType.find(str(evt.type), EventType.Class.MESSAGE)
        if content.get("msgtype") == "m.notice" and event_type == EventType.STICKER:
            event_type = EventType.ROOM_MESSAGE  # a sticker that could not pass is a note
        content[FROM_THERE] = evt.event_id
        if isinstance(content.get("m.new_content"), dict):
            content["m.new_content"][FROM_THERE] = evt.event_id  # an edit is read back as its new content
        local = await intent.send_message_event(portal, event_type, content, timestamp=evt.timestamp)
        self.bridge.store.run("INSERT OR IGNORE INTO message (remote, local, room) VALUES (?, ?, ?)", evt.event_id, local, portal)

    async def on_redaction(self, evt) -> None:
        if evt.timestamp < self.since or self.is_echo(evt):
            return
        row = self.bridge.store.one("SELECT local, room FROM message WHERE remote = ?", evt.redacts)
        if not row:
            return
        # Forgotten first: the copy coming back from Weft then finds nothing to redact there again.
        self.bridge.store.run("DELETE FROM message WHERE remote = ?", evt.redacts)
        intent = self.bridge.admin_intent() if evt.sender == self.user_id else await self.bridge.ghost(self, row[1], evt.sender)
        if intent:
            await intent.redact(RoomID(row[1]), row[0])

    async def on_receipt(self, evt) -> None:
        """Someone read up to a message there: their ghost reads it in Weft (Karchi's own receipts stay there)."""
        for remote_event, kinds in evt.content.items():
            row = self.bridge.store.one("SELECT local, room FROM message WHERE remote = ?", remote_event)
            if not row:
                continue
            for user in (kinds.get(ReceiptType.READ) or {}):  # keys are ReceiptType, not plain strings
                if user != self.user_id:
                    intent = await self.bridge.ghost(self, row[1], user)
                    await intent.send_receipt(RoomID(row[1]), row[0])

    async def on_typing(self, evt) -> None:
        portal = self.bridge.store.one("SELECT local FROM portal WHERE remote = ?", evt.room_id)
        if not portal:
            return
        typing = set(evt.content.user_ids) - {self.user_id}
        for user in typing | self.bridge.typing.get(evt.room_id, set()):
            intent = await self.bridge.ghost(self, portal[0], user)
            await intent.set_typing(RoomID(portal[0]), timeout=30000 if user in typing else 0)
        self.bridge.typing[evt.room_id] = typing


class Bridge:
    def __init__(self):
        STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.store = Store(STATE_DIR / "bridge.db")
        self.az = AppService(server=HOMESERVER, domain=SERVER_NAME, as_token=AS_TOKEN, hs_token=HS_TOKEN,
                             bot_localpart=BOT_LOCALPART, id="matrix", ephemeral_events=True,
                             state_store=FileASStateStore(path=str(STATE_DIR / "appservice-state.json"), binary=False),
                             bridge_name="weft-matrix")
        self.az.matrix_event_handler(self.on_local_event)
        self.remote: Remote | None = None
        self.logins: dict[str, dict] = {}  # login process -> what it asked for
        self.login_lock = asyncio.Lock()  # one sign-in at a time: two at once could leave two accounts running
        self.tokens: dict[str, float] = {}  # Weft tokens that proved to be Karchi's, until when
        self.typing: dict[str, set[str]] = {}
        self.admin_typing: dict[str, bool] = {}
        self.portal_locks: dict[str, asyncio.Lock] = {}
        self.local_locks: dict[str, asyncio.Lock] = {}
        self.ghost_names: dict[str, str] = {}
        routes = web.RouteTableDef()
        base = "/_matrix/provision/v3"
        routes.get(f"{base}/whoami")(self.whoami)
        routes.post(f"{base}/login/start/{{flow}}")(self.login_start)
        routes.post(f"{base}/login/step/{{process}}/{{step}}/user_input")(self.login_step)
        routes.post(f"{base}/login/cancel/{{process}}")(self.login_cancel)
        routes.post(f"{base}/logout/{{login}}")(self.logout)
        routes.post(f"{base}/create_dm/{{user}}")(self.create_dm)
        routes.post(f"{base}/join")(self.join)
        self.az.app.add_routes(routes)

    def admin_intent(self):
        return self.az.intent.user(ADMIN, PUPPET_TOKEN, as_token=True) if PUPPET_TOKEN else None

    async def start(self) -> None:
        row = self.store.one("SELECT * FROM login")
        if row:
            self.remote = Remote(self, row)  # before Weft's events can come in, so none finds no account
        await self.az.start(host="127.0.0.1", port=PORT)
        await self.az.intent.ensure_registered()
        await self.az.intent.set_displayname("Matrix")
        if row:
            self.starting = asyncio.create_task(self.keep_starting(row))

    async def keep_starting(self, row: tuple) -> None:
        """The other server may be down when asus boots: try again, longer each time, until it answers. A key store
        once closed cannot open again, so each try is a fresh Remote."""
        delay = 10
        while True:
            remote = self.remote
            if not remote:
                return
            try:
                await remote.start()
                return
            except Exception as err:
                await remote.stop()
                await remote.client.api.session.close()
                if isinstance(err, MatrixRequestError) and err.http_status == 401:
                    # The other server signed this device out: no retry helps, "Znova prihlásiť" does.
                    remote.state, remote.message = "BAD_CREDENTIALS", "The other homeserver signed this device out."
                    return
                remote.state, remote.message = "TRANSIENT_DISCONNECT", str(err)[:200]
                log.warning("start failed, again in %d s: %s", delay, err)
                await asyncio.sleep(delay)
                if self.remote is not remote:
                    return  # signed out meanwhile
                self.remote = Remote(self, row)
                self.remote.state, self.remote.message = remote.state, remote.message
                delay = min(delay * 2, 600)

    # -------------------------------------------------- rooms in Weft

    def map_relations(self, content: dict, to_local: bool) -> bool:
        """Rewrites the event ids a message points at (reply, edit, reaction) into the other side's; False when
        an edit or reaction points at something unknown (a reply keeps its quote and loses only its link)."""
        col_from, col_to = ("remote", "local") if to_local else ("local", "remote")
        look = lambda eid: (self.store.one(f"SELECT {col_to} FROM message WHERE {col_from} = ?", eid) or [None])[0]
        rel = content.get("m.relates_to")
        if not isinstance(rel, dict):
            return True
        reply = (rel.get("m.in_reply_to") or {}).get("event_id")
        if reply:
            mapped = look(reply)
            if mapped:
                rel["m.in_reply_to"]["event_id"] = mapped
            else:
                rel.pop("m.in_reply_to")
        if rel.get("event_id"):
            mapped = look(rel["event_id"])
            if not mapped:
                return False
            rel["event_id"] = mapped
        if not rel:
            content.pop("m.relates_to")
        content.pop("com.beeper.linkpreviews", None)
        return True

    async def copy_media(self, content: dict, source, target, encrypt: bool, outgoing: bool = False) -> None:
        """A file's bytes uploaded again on the other side: decrypted into Weft (its rooms are not encrypted), and
        encrypted with fresh keys into an encrypted room there. Coming into Weft, a file that cannot pass (over
        MEDIA_MAX, a download error) becomes a note; going out it raises, so nothing goes there in Karchi's name."""
        try:
            info = content.get("info") or {}
            if int(info.get("size") or 0) > MEDIA_MAX:
                raise ValueError("too large")
            if isinstance(content.get("file"), dict):
                f = content.pop("file")
                data = await source.download_media(f["url"])
                if len(data) > MEDIA_MAX:
                    raise ValueError("too large")
                data = decrypt_attachment(data, f["key"]["k"], f["hashes"]["sha256"], f["iv"])
            elif content.get("url"):
                data = await source.download_media(content.pop("url"))
                if len(data) > MEDIA_MAX:
                    raise ValueError("too large")
            else:
                return
            if encrypt:
                data, f = encrypt_attachment(data)
                f.url = await target.upload_media(data, mime_type="application/octet-stream")
                content["file"] = f.serialize()
            else:
                content["url"] = await target.upload_media(data, mime_type=info.get("mimetype") or "application/octet-stream",
                                                           filename=content.get("body") or None)
            for key in ("thumbnail_url", "thumbnail_file"):
                info.pop(key, None)
        except Exception as err:
            log.warning("media not copied: %s", err)
            if outgoing:
                raise ValueError(f"súbor neprešiel ({err})") from err
            content.pop("url", None)
            content.pop("file", None)
            content["msgtype"] = "m.notice"
            content["body"] = f"{content.get('body') or 'Súbor'} (súbor neprešiel)"

    async def portal(self, remote: Remote, room: str, create: bool = True) -> RoomID | None:
        """Weft's room for a room on the other homeserver, made on first need."""
        row = self.store.one("SELECT local FROM portal WHERE remote = ?", room)
        if row or not create:
            return RoomID(row[0]) if row else None
        if self.store.one("SELECT 1 FROM skipped WHERE remote = ?", room):
            return None
        lock = self.portal_locks.setdefault(room, asyncio.Lock())
        async with lock:
            row = self.store.one("SELECT local FROM portal WHERE remote = ?", room)
            if row:
                return RoomID(row[0])
            state = await remote.client.get_state(RoomID(room))
            if any(str(e.type) in ("m.bridge", "uk.half-shot.bridge") for e in state):
                self.store.run("INSERT OR IGNORE INTO skipped (remote) VALUES (?)", room)
                return None
            members = [e for e in state if str(e.type) == "m.room.member" and e.content.membership.value in ("join", "invite")]
            others = [e for e in members if e.state_key != remote.user_id]
            name = next((e.content.name for e in state if str(e.type) == "m.room.name" and getattr(e.content, "name", None)), "")
            encrypted = any(str(e.type) == "m.room.encryption" for e in state)
            dm = len(others) == 1 and not name
            if dm:
                name = others[0].content.displayname or others[0].state_key
            elif not name:
                name = ", ".join((e.content.displayname or e.state_key) for e in others[:3]) or room
            bridge = {"bridgebot": self.az.bot_mxid, "creator": self.az.bot_mxid, "protocol": PROTOCOL,
                      "network": {"id": remote.homeserver, "displayname": remote.user_id.split(":", 1)[1]},
                      "channel": {"id": room, "displayname": name}}
            local = await self.az.intent.create_room(
                name=None if dm else name, is_direct=dm, invitees=[ADMIN], preset=RoomCreatePreset.PRIVATE,
                initial_state=[{"type": "m.bridge", "state_key": f"matrix://{room}", "content": bridge}],
                creation_content={"m.federate": False})
            self.store.run("INSERT INTO portal (remote, local, dm, name) VALUES (?, ?, ?, ?)", room, local, int(dm), name)
            puppet = self.admin_intent()
            if puppet:
                try:
                    await puppet.join_room_by_id(local)
                except MatrixError as err:
                    log.warning("Karchi could not join %s: %s", local, err)
            if len(others) <= GHOSTS_AT_ONCE:  # a big public room's people come in when they write
                for e in others:
                    await self.ghost(remote, local, e.state_key, e.content.displayname)
            log.info("portal %s for %s (%s, %s)", local, room, "DM" if dm else "group", "encrypted" if encrypted else "plain")
            return RoomID(local)

    async def ghost(self, remote: Remote, local: str, user: str, name: str | None = None):
        mxid = ghost_of(user)
        intent = self.az.intent.user(mxid)
        await intent.ensure_joined(RoomID(local), bot=self.az.intent)
        if mxid not in self.ghost_names:
            known = self.store.one("SELECT name FROM ghost WHERE mxid = ?", mxid)
            self.ghost_names[mxid] = known[0] if known else ""
        if not name:
            if self.ghost_names[mxid]:
                return intent
            try:
                name = (await remote.client.get_displayname(UserID(user))) or user
            except MatrixError:
                name = user
        if name != self.ghost_names[mxid]:
            await intent.set_displayname(name)
            self.store.run("INSERT OR REPLACE INTO ghost (mxid, name) VALUES (?, ?)", mxid, name)
            self.ghost_names[mxid] = name
        return intent

    # -------------------------------------------------- Weft → the other homeserver

    async def on_local_event(self, evt) -> None:
        # One room's events one after another, in the order they came: a deletion or edit right after its message
        # waits until that message is there, and quick messages keep their order.
        async with self.local_locks.setdefault(evt.room_id, asyncio.Lock()):
            await self.handle_local_event(evt)

    @staticmethod
    async def room_encrypted(remote: Remote, room: RoomID) -> bool:
        """Whether the room there is encrypted, asked of the server when the state store does not know yet (right
        after sign-in): an unknown room is never treated as plain. mautrix encrypts by the same store."""
        known = await remote.state_store.is_encrypted(room)
        if known is not None:
            return bool(known)
        try:
            info = await remote.client.get_state_event(room, EventType.ROOM_ENCRYPTION)
        except MNotFound:
            return False
        await remote.state_store.set_encryption_info(room, info)
        return True

    async def ready_remote(self, wait: float) -> Remote | None:
        """The account once its encryption is on (a start or a retry may be under way), else None after `wait` s."""
        end = time.monotonic() + wait
        while (r := self.remote) and not r.ready.is_set() and time.monotonic() < end:
            try:
                await asyncio.wait_for(r.ready.wait(), 2)
            except asyncio.TimeoutError:
                pass
        r = self.remote
        return r if r and r.ready.is_set() else None

    async def handle_local_event(self, evt) -> None:
        room = evt.room_id
        row = self.store.one("SELECT remote FROM portal WHERE local = ?", room)
        if not row:
            return
        target = RoomID(row[0])
        if evt.type in (EventType.RECEIPT, EventType.TYPING):
            remote = self.remote
            if not remote or not remote.ready.is_set():
                return  # reading and typing while it starts are not worth waiting for
        else:
            if evt.sender != ADMIN or self.store.one("SELECT 1 FROM message WHERE local = ?", evt.event_id):
                return
            if FROM_THERE in (evt.content.serialize() if hasattr(evt.content, "serialize") else evt.content):
                return  # the double puppet's copy of what he wrote there; it may arrive before its id is stored
            remote = await self.ready_remote(90)
            if not remote:
                await self.az.intent.send_notice(RoomID(room), "Neodoslané na Matrix: účet sa ešte nepripojil.")
                return
        if evt.type == EventType.RECEIPT:
            for local_event, kinds in evt.content.items():
                if ADMIN in (kinds.get(ReceiptType.READ) or {}):
                    mapped = self.store.one("SELECT remote FROM message WHERE local = ?", local_event)
                    if mapped:
                        await remote.client.set_fully_read_marker(target, fully_read=mapped[0], read_receipt=mapped[0])
            return
        if evt.type == EventType.TYPING:
            mine = ADMIN in evt.content.user_ids
            if mine != self.admin_typing.get(room, False):  # a ghost starting to type comes here too
                self.admin_typing[room] = mine
                await remote.client.set_typing(target, timeout=30000 if mine else 0)
            return
        if evt.type == EventType.ROOM_REDACTION:
            mapped = self.store.one("SELECT remote FROM message WHERE local = ?", evt.redacts)
            if mapped:
                self.store.run("DELETE FROM message WHERE local = ?", evt.redacts)  # its echo from there stops here
                try:
                    await remote.client.redact(target, mapped[0])
                except Exception as err:
                    await self.az.intent.send_notice(RoomID(room), f"Nevymazané na Matrixe: {getattr(err, 'message', None) or err}")
            return
        if evt.type not in MESSAGE_TYPES:
            return
        content = evt.content.serialize()
        raw = evt.serialize()
        if not raw.get("content") or (raw.get("unsigned") or {}).get("redacted_because"):
            return  # deleted before it reached the bridge: nothing goes there
        if not self.map_relations(content, to_local=False):
            return
        translate_users(content, to_local=False, me=remote.user_id)
        try:
            encrypted = await self.room_encrypted(remote, target)
            if any(k in content for k in MEDIA_KEYS):
                await self.copy_media(content, self.az.intent, remote.client, outgoing=True, encrypt=encrypted)
            if remote.client.crypto is None and encrypted:
                raise ValueError("šifrovanie ešte nie je zapnuté")  # never plain text into an encrypted room
            txn = f"weft{secrets.token_hex(8)}"
            remote.sent.add(txn)
            sent = await remote.client.send_message_event(target, evt.type, content, txn_id=txn)
        except Exception as err:
            # Never a message that looks sent but is not: say so in the chat.
            log.warning("not sent to %s: %s", target, err)
            await self.az.intent.send_notice(RoomID(room), f"Neodoslané na Matrix: {getattr(err, 'message', None) or err}")
            return
        self.store.run("INSERT OR IGNORE INTO message (remote, local, room) VALUES (?, ?, ?)", sent, evt.event_id, room)
        try:  # Weft's ✓ beside the message: the server there took it (the mautrix bridges' send status event)
            await self.az.intent.send_message_event(RoomID(room), SEND_STATUS, {
                "m.relates_to": {"rel_type": "m.reference", "event_id": evt.event_id}, "status": "SUCCESS", "network": "matrix"})
        except Exception as err:
            log.warning("no send status in %s: %s", room, err)

    # -------------------------------------------------- provisioning

    async def authorized(self, request: web.Request) -> bool:
        token = (request.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
        if not token:
            return False
        if self.tokens.get(token, 0) > time.time():
            return True
        async with aiohttp.ClientSession() as http:
            async with http.get(f"{HOMESERVER}/_matrix/client/v3/account/whoami", headers={"Authorization": f"Bearer {token}"}) as res:
                ok = res.status == 200 and (await res.json()).get("user_id") == ADMIN
        if ok:
            self.tokens[token] = time.time() + 300
        return ok

    @staticmethod
    def error(status: int, errcode: str, message: str) -> web.Response:
        return web.json_response({"errcode": errcode, "error": message}, status=status)

    async def guard(self, request: web.Request) -> web.Response | None:
        return None if await self.authorized(request) else self.error(401, "M_FORBIDDEN", "Tento most smie používať len jeho majiteľ.")

    async def whoami(self, request: web.Request) -> web.Response:
        if (denied := await self.guard(request)):
            return denied
        r = self.remote
        logins = [{"id": r.id, "name": r.user_id, "state": {"state_event": r.state, **({"message": r.message} if r.message else {})}}] if r else []
        return web.json_response({"logins": logins, "network": {"displayname": "Matrix", "beeper_bridge_type": "matrix"}})

    FIELDS = {
        "password": [
            {"type": "url", "id": "homeserver", "name": "Server", "description": "matrix.org alebo adresa tvojho servera", "default_value": "https://matrix-client.matrix.org"},
            {"type": "username", "id": "username", "name": "Používateľ", "description": "@ty:matrix.org alebo len meno"},
            {"type": "password", "id": "password", "name": "Heslo"},
        ],
        "token": [
            {"type": "url", "id": "homeserver", "name": "Server", "default_value": "https://matrix.beeper.com"},
            {"type": "token", "id": "token", "name": "Prístupový token", "description": "Token relácie, ktorú si necháš; odhlásenie vo Wefte ju neukončí."},
        ],
    }

    async def login_start(self, request: web.Request) -> web.Response:
        if (denied := await self.guard(request)):
            return denied
        flow = request.match_info["flow"]
        if flow not in self.FIELDS:
            return self.error(404, "M_NOT_FOUND", "Unknown login flow")
        if self.remote and self.remote.state != "BAD_CREDENTIALS":
            return self.error(400, "SK.KARCHI.ALREADY", f"Už si prihlásený ako {self.remote.user_id}: najprv sa odhlás.")
        process = secrets.token_hex(8)
        self.logins[process] = {"flow": flow, "at": time.time()}
        return web.json_response({"login_id": process, "type": "user_input", "step_id": f"sk.karchi.matrix.{flow}",
                                  "instructions": "Prihlás sa do svojho Matrix účtu. Weft si pridá vlastné šifrované zariadenie „Weft“.",
                                  "user_input": {"fields": self.FIELDS[flow]}})

    async def login_cancel(self, request: web.Request) -> web.Response:
        if (denied := await self.guard(request)):
            return denied
        self.logins.pop(request.match_info["process"], None)
        return web.json_response({})

    async def login_step(self, request: web.Request) -> web.Response:
        if (denied := await self.guard(request)):
            return denied
        async with self.login_lock:
            return await self.sign_in(request)

    async def sign_in(self, request: web.Request) -> web.Response:
        process = self.logins.pop(request.match_info["process"], None)
        if not process:
            return self.error(404, "M_NOT_FOUND", "Toto prihlásenie skončilo, začni znova.")
        if self.remote and self.remote.state != "BAD_CREDENTIALS":
            return self.error(400, "SK.KARCHI.ALREADY", "Už si prihlásený.")
        body = await request.json()
        homeserver = await self.resolve_homeserver(str(body.get("homeserver") or "").strip(), str(body.get("username") or ""))
        if not homeserver:
            return self.error(400, "SK.KARCHI.INVALID_INPUT", "Ten server neodpovedá ako Matrix server.")
        client = Client(base_url=homeserver)
        try:
            if process["flow"] == "password":
                user = str(body.get("username") or "").strip()
                res = await client.login(identifier=user.lstrip("@").split(":")[0] if ":" not in user else user,
                                         login_type=LoginType.PASSWORD, password=str(body.get("password") or ""),
                                         device_name=DEVICE_NAME, store_access_token=True, update_hs_url=False)
                user_id, device_id, token, own = res.user_id, res.device_id, res.access_token, 1
            else:
                user_id, device_id, token, own = await self.token_login(client, homeserver, str(body.get("token") or "").strip())
        except MatrixRequestError as err:
            return self.error(400, "SK.KARCHI.INVALID_INPUT", err.message or "Prihlásenie zlyhalo.")
        except ValueError as err:
            return self.error(400, "SK.KARCHI.INVALID_INPUT", str(err))
        finally:
            await client.api.session.close()
        # Signing in again after the other server signed Weft out keeps its chats; only the same account may.
        old = self.remote
        if old and (old.state != "BAD_CREDENTIALS" or old.user_id != user_id):
            if own:
                await self.drop_session(homeserver, token)
            return self.error(400, "SK.KARCHI.ALREADY", f"Weft má účet {old.user_id}: prihlás ten, alebo sa najprv odhlás.")
        old_row = self.store.one("SELECT * FROM login") if old else None
        if old:
            self.remote = None
            await old.stop()
            await old.client.api.session.close()
        login_id = re.sub(r"[^a-z0-9]+", "_", user_id.lower()).strip("_") or "login"
        aside = STATE_DIR / f"{login_id}.before"  # the signed-out account's keys, back in place if this fails
        shutil.rmtree(aside, ignore_errors=True)
        if old_row and (STATE_DIR / login_id).exists():
            (STATE_DIR / login_id).rename(aside)
        shutil.rmtree(STATE_DIR / login_id, ignore_errors=True)  # keys of an earlier sign-out never come back
        self.store.run("DELETE FROM login")
        self.store.run("INSERT INTO login (id, homeserver, user_id, device_id, token, own_device, pickle_key, since, name) "
                       "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", login_id, homeserver, user_id, device_id,
                       token, own, secrets.token_hex(32), int(time.time() * 1000), user_id)
        remote = Remote(self, self.store.one("SELECT * FROM login WHERE id = ?", login_id))
        try:
            await remote.start()
        except Exception as err:
            # Nothing half signed in stays behind to fail at every restart.
            log.warning("sign-in could not start: %s", err)
            await remote.stop()
            if own:
                try:
                    await remote.client.logout()
                except MatrixError:
                    pass
            await remote.client.api.session.close()
            self.store.run("DELETE FROM login")
            shutil.rmtree(remote.dir, ignore_errors=True)
            if old_row:  # the signed-out account stays as it was, so "Znova prihlásiť" is offered again
                if aside.exists():
                    aside.rename(STATE_DIR / login_id)
                self.store.run(f"INSERT INTO login ({', '.join(old_row.keys())}) VALUES ({', '.join('?' * len(old_row))})", *old_row)
                self.remote = Remote(self, old_row)
                self.remote.state, self.remote.message = "BAD_CREDENTIALS", "The other homeserver signed this device out."
            return self.error(400, "SK.KARCHI.START_FAILED", f"Prihlásenie sa nepodarilo dokončiť: {getattr(err, 'message', None) or err}")
        self.remote = remote
        shutil.rmtree(aside, ignore_errors=True)
        if old_row:
            for (local,) in self.store.all("SELECT local FROM portal"):
                try:
                    await self.az.intent.send_notice(RoomID(local), "Matrix je znova prihlásený. Čo prišlo, kým bol odhlásený, sa do Weftu nedostalo; nájdeš to v inej Matrix aplikácii.")
                except MatrixError:
                    pass
        return web.json_response({"type": "complete", "step_id": "sk.karchi.matrix.complete", "instructions": f"Prihlásený ako {user_id}.",
                                  "complete": {"user_login_id": login_id}})

    @staticmethod
    async def drop_session(homeserver: str, token: str) -> None:
        client = Client(base_url=homeserver, token=token)
        try:
            await client.logout()
        except Exception:
            pass
        finally:
            await client.api.session.close()

    @staticmethod
    async def token_login(client: Client, homeserver: str, token: str) -> tuple[str, str, str, int]:
        """A token of a session Karchi keeps (Beeper has no passwords). Its device already has keys, and two key sets
        on one device break encryption for both, so Weft asks that session for a one-time login token and signs in a
        device of its own. Only a session that has no keys yet may be used as it is."""
        client.api.token = token
        who = await client.whoami()
        if not who.device_id:
            raise ValueError("Tento token nemá zariadenie; Weft ho potrebuje na šifrovanie.")
        try:
            res = await client.api.request(Method.POST, "/_matrix/client/v1/login/get_token", {})
            fresh = Client(base_url=homeserver)
            try:
                own = await fresh.login(token=res["login_token"], login_type=LoginType.TOKEN, device_name=DEVICE_NAME,
                                        store_access_token=True, update_hs_url=False)
            finally:
                await fresh.api.session.close()
            return own.user_id, own.device_id, own.access_token, 1
        except (MatrixRequestError, KeyError) as err:
            log.info("no login token from the session (%s); checking its device", err)
        keys = await client.query_keys({who.user_id: [who.device_id]})
        if (keys.device_keys.get(who.user_id) or {}).get(who.device_id):
            raise ValueError("Táto relácia už má vlastné šifrovacie kľúče a server nedovolí z nej prihlásiť nové zariadenie. "
                             "Prihlás sa heslom, alebo daj token novej relácie, ktorá ešte nič nešifrovala.")
        return who.user_id, who.device_id, token, 0

    @staticmethod
    async def resolve_homeserver(given: str, username: str) -> str | None:
        """An address as typed (or the server part of @you:server) to the client API's base URL, through
        .well-known when the server publishes one."""
        if not given and ":" in username:
            given = username.split(":", 1)[1]
        if not given:
            return None
        base = given if re.match(r"^https?://", given) else f"https://{given}"
        base = base.rstrip("/")
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as http:
            try:
                async with http.get(f"{base}/.well-known/matrix/client") as res:
                    if res.status == 200:
                        found = (await res.json(content_type=None)).get("m.homeserver", {}).get("base_url")
                        if found:
                            base = found.rstrip("/")
            except (aiohttp.ClientError, ValueError, asyncio.TimeoutError):
                pass
            # A password never goes out unencrypted: plain http only to this machine.
            if not re.match(r"^https://|^http://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(/|$)", base):
                return None
            try:
                async with http.get(f"{base}/_matrix/client/versions") as res:
                    return base if res.status == 200 else None
            except (aiohttp.ClientError, asyncio.TimeoutError):
                return None

    async def logout(self, request: web.Request) -> web.Response:
        """Signs out: no more sync, the device gone there (when Weft made it), keys, ids and chats gone here.
        The chats themselves stay on the other homeserver; Weft's copies are left by everyone, Karchi included."""
        if (denied := await self.guard(request)):
            return denied
        async with self.login_lock:  # never in the middle of a sign-in, which may be putting keys back
            return await self.sign_out(request)

    async def sign_out(self, request: web.Request) -> web.Response:
        r = self.remote
        if not r or r.id != request.match_info["login"]:
            return self.error(404, "M_NOT_FOUND", "Taký účet tu nie je.")
        self.remote = None
        await r.stop()
        if r.own_device:
            try:
                await r.client.logout()
            except Exception as err:  # a network error too: the local clean-up below always runs
                log.warning("remote logout: %s", err)
        await r.client.api.session.close()
        puppet = self.admin_intent()
        for (local,) in self.store.all("SELECT local FROM portal"):
            try:
                await self.az.intent.send_notice(RoomID(local), "Matrix vo Wefte je odhlásený: tento chat sa už neaktualizuje.")
                if puppet:
                    await puppet.leave_room(RoomID(local))
                # Only the ghosts in this room, not every ghost ever seen.
                for mxid in await self.az.intent.get_joined_members(RoomID(local)):
                    if mxid.startswith("@matrix_"):
                        try:
                            await self.az.intent.user(UserID(mxid)).leave_room(RoomID(local))
                        except Exception:
                            pass
                await self.az.intent.leave_room(RoomID(local))
            except Exception as err:
                log.warning("leaving %s: %s", local, err)
        for table in ("login", "portal", "message", "skipped", "ghost"):
            self.store.run(f"DELETE FROM {table}")
        for cache in (self.ghost_names, self.typing, self.admin_typing, self.portal_locks):
            cache.clear()
        shutil.rmtree(r.dir, ignore_errors=True)
        return web.json_response({})

    async def create_dm(self, request: web.Request) -> web.Response:
        if (denied := await self.guard(request)):
            return denied
        r = self.remote
        user = request.match_info["user"]
        if not r:
            return self.error(400, "SK.KARCHI.NOT_LOGGED_IN", "Najprv sa prihlás na Matrix.")
        if not re.match(r"^@[^:\s]+:[^\s]+$", user):
            return self.error(400, "SK.KARCHI.INVALID_INPUT", "Adresa na Matrixe vyzerá ako @meno:server.")
        name = user
        try:
            name = getattr(await r.client.get_profile(UserID(user)), "displayname", None) or user
        except MatrixRequestError as err:
            # Many servers show profiles only to people who share a room; only "no such user" stops here.
            if err.http_status == 404 and getattr(err, "errcode", "") == "M_NOT_FOUND":
                return self.error(404, "M_NOT_FOUND", f"{user}: {err.message}")
        try:
            direct = (await r.client.get_account_data(EventType.DIRECT)) or {}
        except MatrixRequestError:
            direct = {}
        direct = {k: list(v) for k, v in dict(direct).items()}
        # A DM Karchi already has there (from Weft or another client) opens instead of a second one.
        try:
            joined = set(await r.client.get_joined_rooms())
        except MatrixRequestError:
            joined = set()
        for known in direct.get(user, []):
            if (local := await self.portal(r, known, create=known in joined)):
                return web.json_response({"room_id": local, "dm_room_mxid": local, "id": user, "name": name})
        room = await r.client.create_room(
            preset=RoomCreatePreset.TRUSTED_PRIVATE, is_direct=True, invitees=[UserID(user)],
            initial_state=[{"type": "m.room.encryption", "state_key": "", "content": {"algorithm": "m.megolm.v1.aes-sha2"}}])
        direct.setdefault(user, []).append(room)
        await r.client.set_account_data(EventType.DIRECT, direct)
        await r.state_store.set_encryption_info(room, {"algorithm": "m.megolm.v1.aes-sha2"})
        local = await self.portal(r, room)
        return web.json_response({"room_id": local, "dm_room_mxid": local, "id": user, "name": name})

    async def join(self, request: web.Request) -> web.Response:
        if (denied := await self.guard(request)):
            return denied
        r = self.remote
        if not r:
            return self.error(400, "SK.KARCHI.NOT_LOGGED_IN", "Najprv sa prihlás na Matrix.")
        target = str((await request.json()).get("room") or "").strip()
        if not re.match(r"^#[^:\s]+:[^\s]+$|^![^\s]+$", target):  # room ids of version 12 have no server part
            return self.error(400, "SK.KARCHI.INVALID_INPUT", "Adresa miestnosti vyzerá ako #nazov:server.")
        try:
            room = await r.client.join_room(target, max_retries=0)
        except MatrixRequestError as err:
            return self.error(400, "M_FORBIDDEN" if err.http_status == 403 else "M_NOT_FOUND", f"{target}: {err.message}")
        local = await self.portal(r, room)
        if not local:
            try:
                await r.client.leave_room(room)  # not left sitting in a room Weft does not show
            except MatrixError:
                pass
            return self.error(400, "SK.KARCHI.BRIDGED", "Tá miestnosť je sama most na inú sieť; Weft ju vynechá.")
        return web.json_response({"room_id": local})


async def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("mau.client.sync").setLevel(logging.WARNING)
    bridge = Bridge()
    await bridge.start()
    log.info("listening on 127.0.0.1:%d", PORT)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())

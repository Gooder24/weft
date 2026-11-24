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
from pathlib import Path

import aiohttp
from aiohttp import web
from mautrix.appservice import AppService
from mautrix.appservice.state_store.file import FileASStateStore
from mautrix.client import Client, InternalEventType
from mautrix.client.state_store import SyncStore
from mautrix.client.state_store.asyncpg import PgStateStore
from mautrix.crypto import OlmMachine, PgCryptoStore
from mautrix.errors import MatrixError, MatrixRequestError
from mautrix.types import (EventType, LoginType, PresenceState, ReceiptType, RoomCreatePreset, RoomID, UserID)
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
    m = re.match(rf"^@{GHOST_PREFIX}(.+):{re.escape(SERVER_NAME)}$", ghost)
    if not m:
        return None
    raw = re.sub(r"(=[0-9a-f]{2})+", lambda g: bytes.fromhex(g.group(0).replace("=", "")).decode("utf-8", "replace"), m.group(1))
    return "@" + raw


class Store:
    """The bridge's own small database: the login, which remote room is which Weft room, and message ids."""

    def __init__(self, path: Path):
        self.db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS login (id TEXT PRIMARY KEY, homeserver TEXT, user_id TEXT, device_id TEXT,
                token TEXT, own_device INTEGER, pickle_key TEXT, since INTEGER, next_batch TEXT, name TEXT);
            CREATE TABLE IF NOT EXISTS portal (remote TEXT PRIMARY KEY, local TEXT UNIQUE, dm INTEGER, name TEXT);
            CREATE TABLE IF NOT EXISTS message (remote TEXT PRIMARY KEY, local TEXT UNIQUE, room TEXT);
            CREATE TABLE IF NOT EXISTS ghost (mxid TEXT PRIMARY KEY, name TEXT);
            CREATE TABLE IF NOT EXISTS skipped (remote TEXT PRIMARY KEY);
        """)

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
        self.id, self.homeserver, self.user_id, self.device_id, token, self.own_device, pickle_key, self.since, _, self.name = row
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

    async def start(self) -> None:
        await self.db.start()
        await PgStateStore.upgrade_table.upgrade(self.db)
        await self.crypto_store.open()
        machine = OlmMachine(self.client, self.crypto_store, self.state_store)
        self.client.crypto = machine
        await machine.load()
        if not await self.crypto_store.get_device_id():
            await self.crypto_store.put_device_id(self.client.device_id)
        if not machine.account.shared:
            await machine.share_keys()
        for kind in MESSAGE_TYPES:
            self.client.add_event_handler(kind, self.on_message)
        self.client.add_event_handler(EventType.RECEIPT, self.on_receipt)
        self.client.add_event_handler(EventType.TYPING, self.on_typing)
        self.client.add_event_handler(EventType.ROOM_REDACTION, self.on_redaction)
        self.client.add_event_handler(InternalEventType.SYNC_SUCCESSFUL, self.on_sync_ok)
        self.client.add_event_handler(InternalEventType.SYNC_ERRORED, self.on_sync_error)
        self.client.start({"room": {"timeline": {"limit": 20}, "state": {"lazy_load_members": True}}})

    async def on_sync_ok(self, _evt) -> None:
        self.state, self.message = "CONNECTED", ""

    async def on_sync_error(self, evt) -> None:
        err = getattr(evt, "error", None)
        if isinstance(err, MatrixRequestError) and err.http_status == 401:
            self.state, self.message = "BAD_CREDENTIALS", "The other homeserver signed this device out."
            self.client.stop()
        else:
            self.state, self.message = "TRANSIENT_DISCONNECT", str(err or "")[:200]

    async def stop(self) -> None:
        self.client.stop()
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
        portal = await self.bridge.portal(self, evt.room_id)
        if not portal:
            return
        content = evt.content.serialize()
        if not self.bridge.map_relations(content, to_local=True):
            return  # an edit or reaction of something Weft never had
        if any(k in content for k in MEDIA_KEYS):
            await self.bridge.copy_media(content, self.client, self.bridge.az.intent)
        if evt.sender == self.user_id:
            intent = self.bridge.admin_intent()
            if not intent:
                return
        else:
            intent = await self.bridge.ghost(self, portal, evt.sender)
        event_type = EventType.find(str(evt.type), EventType.Class.MESSAGE)
        local = await intent.send_message_event(portal, event_type, content, timestamp=evt.timestamp)
        self.bridge.store.run("INSERT OR IGNORE INTO message VALUES (?, ?, ?)", evt.event_id, local, portal)

    async def on_redaction(self, evt) -> None:
        if evt.timestamp < self.since or self.is_echo(evt):
            return
        row = self.bridge.store.one("SELECT local, room FROM message WHERE remote = ?", evt.redacts)
        if not row:
            return
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
        self.tokens: dict[str, float] = {}  # Weft tokens that proved to be Karchi's, until when
        self.typing: dict[str, set[str]] = {}
        self.portal_locks: dict[str, asyncio.Lock] = {}
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
        await self.az.start(host="127.0.0.1", port=PORT)
        await self.az.intent.ensure_registered()
        await self.az.intent.set_displayname("Matrix")
        row = self.store.one("SELECT * FROM login")
        if row:
            self.remote = Remote(self, row)
            await self.remote.start()

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

    async def copy_media(self, content: dict, source, target) -> None:
        """A file's bytes uploaded again on the other homeserver (an encrypted file stays encrypted, same keys)."""
        try:
            if "file" in content and isinstance(content["file"], dict):
                data = await source.download_media(content["file"]["url"])
                content["file"]["url"] = await target.upload_media(data, mime_type="application/octet-stream")
            elif content.get("url"):
                info = content.get("info") or {}
                data = await source.download_media(content["url"])
                content["url"] = await target.upload_media(data, mime_type=info.get("mimetype") or "application/octet-stream",
                                                           filename=content.get("body") or None)
            info = content.get("info") or {}
            for key in ("thumbnail_url",):
                info.pop(key, None)
            info.pop("thumbnail_file", None)
        except Exception as err:
            log.warning("media not copied: %s", err)
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
                self.store.run("INSERT OR IGNORE INTO skipped VALUES (?)", room)
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
            self.store.run("INSERT INTO portal VALUES (?, ?, ?, ?)", room, local, int(dm), name)
            puppet = self.admin_intent()
            if puppet:
                try:
                    await puppet.join_room_by_id(local)
                except MatrixError as err:
                    log.warning("Karchi could not join %s: %s", local, err)
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
            self.store.run("INSERT OR REPLACE INTO ghost VALUES (?, ?)", mxid, name)
            self.ghost_names[mxid] = name
        return intent

    # -------------------------------------------------- Weft → the other homeserver

    async def on_local_event(self, evt) -> None:
        remote = self.remote
        if not remote:
            return
        room = evt.room_id
        row = self.store.one("SELECT remote FROM portal WHERE local = ?", room)
        if not row:
            return
        target = RoomID(row[0])
        if evt.type == EventType.RECEIPT:
            for local_event, kinds in evt.content.items():
                if ADMIN in (kinds.get(ReceiptType.READ) or {}):
                    mapped = self.store.one("SELECT remote FROM message WHERE local = ?", local_event)
                    if mapped:
                        await remote.client.set_fully_read_marker(target, fully_read=mapped[0], read_receipt=mapped[0])
            return
        if evt.type == EventType.TYPING:
            await remote.client.set_typing(target, timeout=30000 if ADMIN in evt.content.user_ids else 0)
            return
        if evt.sender != ADMIN or self.store.one("SELECT 1 FROM message WHERE local = ?", evt.event_id):
            return
        if evt.type == EventType.ROOM_REDACTION:
            mapped = self.store.one("SELECT remote FROM message WHERE local = ?", evt.redacts)
            if mapped:
                await remote.client.redact(target, mapped[0])
            return
        if evt.type not in MESSAGE_TYPES:
            return
        content = evt.content.serialize()
        if not self.map_relations(content, to_local=False):
            return
        if any(k in content for k in MEDIA_KEYS):
            await self.copy_media(content, self.az.intent, remote.client)
        txn = f"weft{secrets.token_hex(8)}"
        remote.sent.add(txn)
        sent = await remote.client.send_message_event(target, evt.type, content, txn_id=txn)
        self.store.run("INSERT OR IGNORE INTO message VALUES (?, ?, ?)", sent, evt.event_id, room)

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
        if self.remote:
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
        process = self.logins.pop(request.match_info["process"], None)
        if not process:
            return self.error(404, "M_NOT_FOUND", "Toto prihlásenie skončilo, začni znova.")
        if self.remote:
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
                client.api.token = str(body.get("token") or "").strip()
                who = await client.whoami()
                if not who.device_id:
                    return self.error(400, "SK.KARCHI.INVALID_INPUT", "Tento token nemá zariadenie; Weft ho potrebuje na šifrovanie.")
                user_id, device_id, token, own = who.user_id, who.device_id, client.api.token, 0
        except MatrixRequestError as err:
            return self.error(400, "SK.KARCHI.INVALID_INPUT", err.message or "Prihlásenie zlyhalo.")
        finally:
            await client.api.session.close()
        login_id = re.sub(r"[^a-z0-9]+", "_", user_id.lower()).strip("_")
        shutil.rmtree(STATE_DIR / login_id, ignore_errors=True)  # keys of an earlier sign-out never come back
        self.store.run("DELETE FROM login")
        self.store.run("INSERT INTO login VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)", login_id, homeserver, user_id, device_id,
                       token, own, secrets.token_hex(32), int(time.time() * 1000), user_id)
        self.remote = Remote(self, self.store.one("SELECT * FROM login WHERE id = ?", login_id))
        await self.remote.start()
        return web.json_response({"type": "complete", "step_id": "sk.karchi.matrix.complete", "instructions": f"Prihlásený ako {user_id}.",
                                  "complete": {"user_login_id": login_id}})

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
        r = self.remote
        if not r or r.id != request.match_info["login"]:
            return self.error(404, "M_NOT_FOUND", "Taký účet tu nie je.")
        self.remote = None
        await r.stop()
        if r.own_device:
            try:
                await r.client.logout()
            except MatrixError as err:
                log.warning("remote logout: %s", err)
        await r.client.api.session.close()
        puppet = self.admin_intent()
        for (local,) in self.store.all("SELECT local FROM portal"):
            try:
                await self.az.intent.send_notice(RoomID(local), "Matrix vo Wefte je odhlásený: tento chat sa už neaktualizuje.")
                if puppet:
                    await puppet.leave_room(RoomID(local))
                for (mxid,) in self.store.all("SELECT mxid FROM ghost"):
                    try:
                        await self.az.intent.user(UserID(mxid)).leave_room(RoomID(local))
                    except MatrixError:
                        pass
                await self.az.intent.leave_room(RoomID(local))
            except MatrixError as err:
                log.warning("leaving %s: %s", local, err)
        for table in ("login", "portal", "message", "skipped"):
            self.store.run(f"DELETE FROM {table}")
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
        try:
            profile = await r.client.get_profile(UserID(user))
        except MatrixRequestError as err:
            return self.error(404, "M_NOT_FOUND", f"{user}: {err.message}")
        name = getattr(profile, "displayname", None) or user
        try:
            direct = (await r.client.get_account_data(EventType.DIRECT)) or {}
        except MatrixRequestError:
            direct = {}
        direct = {k: list(v) for k, v in dict(direct).items()}
        # A DM Weft already shows opens again instead of a second one.
        for known in direct.get(user, []):
            if (local := await self.portal(r, known, create=False)):
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
        if not re.match(r"^[#!][^:\s]+:[^\s]+$", target):
            return self.error(400, "SK.KARCHI.INVALID_INPUT", "Adresa miestnosti vyzerá ako #nazov:server.")
        try:
            room = await r.client.join_room(target, max_retries=0)
        except MatrixRequestError as err:
            return self.error(400, "M_FORBIDDEN" if err.http_status == 403 else "M_NOT_FOUND", f"{target}: {err.message}")
        local = await self.portal(r, room)
        if not local:
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

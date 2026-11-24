"""The Matrix bridge (server/matrix/bridge.py) against two throwaway Tuwunel homeservers on 127.0.0.1: "weft.test"
(Weft's, with the bridge's appservice and a double puppet) and "remote.test" (the other server, with Karchi's
account there and a friend). Nothing federates and nothing leaves the machine.

    python3 -m venv --system-site-packages /tmp/mxvenv && /tmp/mxvenv/bin/pip install -r server/matrix/requirements.txt
    TUWUNEL=~/matrix-spike/bin/tuwunel /tmp/mxvenv/bin/python tests/matrix/run.py

(python3-olm from the system: `apt install python3-olm`.) Checks: sign-in, a new encrypted DM there and back,
a reply each way, read receipts each way, typing, joining a room by its #alias, and that signing out leaves no
login, keys, ids or rooms behind and ends the device on the other server.
"""
import asyncio
import json
import os
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import aiohttp
from mautrix.client import Client
from mautrix.client.state_store.asyncpg import PgStateStore
from mautrix.crypto import OlmMachine, PgCryptoStore
from mautrix.types import EventType, MessageType, ReceiptType, RoomCreatePreset, TextMessageEventContent, UserID
from mautrix.util.async_db import Database

ROOT = Path(__file__).resolve().parents[2]
TUWUNEL = os.path.expanduser(os.environ.get("TUWUNEL", "tuwunel"))
results: list[bool] = []


def ok(name: str, passed: bool, detail="") -> None:
    results.append(bool(passed))
    print(f"{'ok  ' if passed else 'FAIL'} {name}{f' ({detail})' if detail != '' else ''}", flush=True)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def until(check, seconds=30.0, every=0.2):
    """Waits for something the servers do on their own (a sync, a push); gives the last value."""
    end = time.monotonic() + seconds
    value = None
    while time.monotonic() < end:
        value = await check()
        if value:
            return value
        await asyncio.sleep(every)
    return value


def homeserver(base: Path, name: str, port: int, token: str, appservices: Path | None) -> subprocess.Popen:
    (base / name).mkdir()
    conf = base / name / "tuwunel.toml"
    conf.write_text("\n".join([
        "[global]", f'server_name = "{name}"', f'database_path = "{base / name / "db"}"', 'address = ["127.0.0.1"]',
        f"port = {port}", "allow_registration = true", f'registration_token = "{token}"', "allow_federation = false",
        'new_user_displayname_suffix = ""', 'log = "warn"', "log_colors = false",
        *([f'appservice_dir = "{appservices}"'] if appservices else []), ""]))
    return subprocess.Popen([TUWUNEL, "-c", str(conf)], stdout=open(base / name / "log", "w"), stderr=subprocess.STDOUT)


class HS:
    def __init__(self, http: aiohttp.ClientSession, url: str, token: str = ""):
        self.http, self.url, self.token = http, url, token

    async def call(self, method: str, path: str, body=None, token=None, base="/_matrix/client/v3"):
        headers = {"Authorization": f"Bearer {token or self.token}"} if (token or self.token) else {}
        async with self.http.request(method, self.url + base + path, json=body, headers=headers) as res:
            data = await res.json(content_type=None)
            return res.status, data

    async def register(self, user: str, reg_token: str) -> tuple[str, str]:
        body = {"username": user, "password": f"pw-{user}-{reg_token}", "initial_device_display_name": "test"}
        status, data = await self.call("POST", "/register", body)
        if status == 401:
            body["auth"] = {"type": "m.login.registration_token", "token": reg_token, "session": data.get("session")}
            status, data = await self.call("POST", "/register", body)
        assert status == 200, data
        return data["user_id"], data["access_token"]


class LocalSync:
    """Karchi on Weft's homeserver: what his /sync brings, kept for the checks."""

    def __init__(self, hs: HS):
        self.hs, self.since, self.events, self.ephemeral, self.left, self.joined = hs, None, [], [], set(), set()
        self.state: dict[str, list] = {}

    async def step(self):
        q = f"?timeout=1000{'&since=' + self.since if self.since else ''}"
        status, data = await self.hs.call("GET", "/sync" + q)
        if status != 200:
            return
        self.since = data["next_batch"]
        for room, r in data.get("rooms", {}).get("join", {}).items():
            self.joined.add(room)
            self.state.setdefault(room, []).extend(r.get("state", {}).get("events", []))
            for e in r.get("timeline", {}).get("events", []):
                e["room_id"] = room
                self.events.append(e)
                if "state_key" in e:
                    self.state[room].append(e)
            for e in r.get("ephemeral", {}).get("events", []):
                e["room_id"] = room
                self.ephemeral.append(e)
        for room in data.get("rooms", {}).get("leave", {}):
            self.left.add(room)
            self.joined.discard(room)

    def find(self, room, pred):
        return next((e for e in self.events if e["room_id"] == room and pred(e)), None)


async def friend_client(base: Path, url: str, user: str, token: str, device: str) -> tuple[Client, dict]:
    """The friend on the other server, with encryption (another mautrix client, as Element would be)."""
    d = base / "friend"
    d.mkdir()
    db = Database.create(f"sqlite:{d / 'keys.db'}", upgrade_table=PgCryptoStore.upgrade_table)
    await db.start()
    await PgStateStore.upgrade_table.upgrade(db)
    state = PgStateStore(db)
    store = PgCryptoStore(user, "friend-pickle", db)
    await store.open()
    client = Client(mxid=UserID(user), device_id=device, base_url=url, token=token, state_store=state)
    machine = OlmMachine(client, store, state)
    client.crypto = machine
    await machine.load()
    await store.put_device_id(device)
    await machine.share_keys()
    seen = {"messages": [], "receipts": [], "encrypted": set(), "db": db}

    async def on_invite(evt):
        if evt.state_key == user and evt.content.membership.value == "invite":
            await client.join_room(evt.room_id)

    async def on_message(evt):
        seen["messages"].append(evt)

    async def on_encrypted(evt):
        seen["encrypted"].add(evt.event_id)

    async def on_receipt(evt):
        seen["receipts"].append(evt)

    client.add_event_handler(EventType.ROOM_MEMBER, on_invite)
    client.add_event_handler(EventType.ROOM_MESSAGE, on_message)
    client.add_event_handler(EventType.ROOM_ENCRYPTED, on_encrypted)
    client.add_event_handler(EventType.RECEIPT, on_receipt)
    client.start(None)
    return client, seen


async def main() -> int:
    base = Path(tempfile.mkdtemp(prefix="weft-matrix-test-"))
    procs = []
    http = aiohttp.ClientSession()
    friend = None
    try:
        p1, p2, pb = free_port(), free_port(), free_port()
        reg = secrets.token_hex(8)
        apps = base / "appservices"
        apps.mkdir()
        as_token, hs_token, dp_token = (secrets.token_hex(16) for _ in range(3))
        (apps / "matrix.yaml").write_text(f"""id: matrix
url: http://127.0.0.1:{pb}
as_token: {as_token}
hs_token: {hs_token}
sender_localpart: matrixbot
rate_limited: false
de.sorunome.msc2409.push_ephemeral: true
receive_ephemeral: true
namespaces:
  users:
  - regex: ^@matrixbot:weft\\.test$
    exclusive: true
  - regex: ^@matrix_.*:weft\\.test$
    exclusive: true
""")
        (apps / "doublepuppet.yaml").write_text(f"""id: doublepuppet
url: null
as_token: {dp_token}
hs_token: {secrets.token_hex(16)}
sender_localpart: doublepuppet
rate_limited: false
namespaces:
  users:
  - regex: '@.*:weft\\.test'
    exclusive: false
""")
        procs.append(homeserver(base, "weft.test", p1, reg, apps))
        procs.append(homeserver(base, "remote.test", p2, reg, None))
        local = HS(http, f"http://127.0.0.1:{p1}")
        remote = HS(http, f"http://127.0.0.1:{p2}")

        async def up(h):
            try:
                return (await h.call("GET", "/versions", base="/_matrix/client"))[0] == 200
            except aiohttp.ClientError:
                return False
        ok("both homeservers start", await until(lambda: up(local)) and await until(lambda: up(remote)))
        karchi, karchi_token = await local.register("karchi", reg)
        local.token = karchi_token
        remote_karchi, remote_token = await remote.register("karchi", reg)
        friend_id, friend_token = await remote.register("friend", reg)
        _, who = await remote.call("GET", "/account/whoami", token=friend_token)

        env = {**os.environ, "HOMESERVER": local.url, "SERVER_NAME": "weft.test", "ADMIN_MXID": karchi,
               "REGISTRATION": str(apps / "matrix.yaml"), "DOUBLEPUPPET": str(apps / "doublepuppet.yaml"),
               "STATE_DIR": str(base / "bridge"), "PORT": str(pb), "LOG_LEVEL": "INFO"}
        procs.append(subprocess.Popen([sys.executable, str(ROOT / "server/matrix/bridge.py")], env=env,
                                      stdout=open(base / "bridge.log", "w"), stderr=subprocess.STDOUT))
        prov = HS(http, f"http://127.0.0.1:{pb}", karchi_token)
        P = "/_matrix/provision/v3"

        async def bridge_up():
            try:
                return (await prov.call("GET", "/whoami", base=P))[0] == 200
            except aiohttp.ClientError:
                return False
        ok("the bridge starts", await until(bridge_up))
        status, _ = await prov.call("GET", "/whoami", base=P, token="not-karchis")
        ok("provisioning refuses anyone but Karchi", status == 401, status)

        # Sign-in with the password form Weft shows.
        _, start = await prov.call("POST", "/login/start/password", {}, base=P)
        fields = [f["id"] for f in start.get("user_input", {}).get("fields", [])]
        ok("login asks for homeserver, username and password", fields == ["homeserver", "username", "password"], fields)
        status, done = await prov.call("POST", f"/login/step/{start['login_id']}/{start['step_id']}/user_input",
                                       {"homeserver": remote.url, "username": remote_karchi, "password": f"pw-karchi-{reg}"}, base=P)
        ok("sign-in completes", status == 200 and done.get("type") == "complete", done)
        login_id = done.get("complete", {}).get("user_login_id")

        async def connected():
            _, w = await prov.call("GET", "/whoami", base=P)
            return w.get("logins") and w["logins"][0]["state"]["state_event"] == "CONNECTED" and w["logins"][0]
        login = await until(connected)
        ok("whoami shows the account connected", bool(login) and login["name"] == remote_karchi, login)
        _, devices = await remote.call("GET", "/devices", token=remote_token)
        weft_device = next((d["device_id"] for d in devices.get("devices", []) if d.get("display_name") == "Weft"), None)
        ok("a device called Weft exists there", bool(weft_device))

        friend, seen = await friend_client(base, remote.url, friend_id, friend_token, who["device_id"])
        sync = LocalSync(local)
        await sync.step()

        # Ctrl+N: a new DM by @name:server, encrypted, Karchi in it at once.
        status, dm = await prov.call("POST", f"/create_dm/{friend_id}", {}, base=P)
        room = dm.get("room_id")
        ok("create_dm answers with Weft's room", status == 200 and bool(room), dm)

        async def karchi_in():
            await sync.step()
            return room in sync.joined
        ok("Karchi is in the new chat in Weft", await until(karchi_in))
        bridge_state = next((e for e in sync.state.get(room, []) if e["type"] == "m.bridge"), None)
        ok("the chat is marked as Matrix (m.bridge)", bool(bridge_state) and bridge_state["content"]["protocol"]["id"] == "matrix", bridge_state and bridge_state["content"].get("protocol"))
        remote_room = bridge_state and bridge_state["content"]["channel"]["id"]

        async def friend_joined():
            _, m = await remote.call("GET", f"/rooms/{remote_room}/joined_members", token=friend_token)
            return friend_id in (m.get("joined") or {})
        ok("the friend accepts the DM there", await until(friend_joined))

        # Weft → there, encrypted.
        _, sent = await local.call("PUT", f"/rooms/{room}/send/m.room.message/t1", {"msgtype": "m.text", "body": "Ahoj z Weftu"})
        got = await until(lambda: asyncio.sleep(0, next((m for m in seen["messages"] if m.content.body == "Ahoj z Weftu"), None)))
        ok("a message from Weft arrives there", bool(got))
        ok("…end-to-end encrypted", bool(got) and got.event_id in seen["encrypted"])

        # There → Weft, encrypted, as a reply to it.
        content = TextMessageEventContent(msgtype=MessageType.TEXT, body="Ahoj späť")
        content.set_reply(got)
        friend_event = await friend.send_message(remote_room, content)
        enc = await remote.call("GET", f"/rooms/{remote_room}/event/{friend_event}", token=friend_token)
        ok("the friend's answer is encrypted on the wire", enc[1].get("type") == "m.room.encrypted", enc[1].get("type"))

        async def answer():
            await sync.step()
            return sync.find(room, lambda e: e["type"] == "m.room.message" and e["content"].get("body", "").endswith("Ahoj späť"))
        reply = await until(answer)
        ghost = reply and reply["sender"]
        ok("the answer arrives in Weft from the friend's ghost", bool(reply) and ghost.startswith("@matrix_friend=3aremote.test:"), ghost)
        ok("…as a reply to Weft's message", bool(reply) and reply["content"].get("m.relates_to", {}).get("m.in_reply_to", {}).get("event_id") == sent["event_id"])
        names = await local.call("GET", f"/rooms/{room}/joined_members")
        ok("the ghost carries the friend's name", (names[1].get("joined", {}).get(ghost) or {}).get("display_name") in ("friend", friend_id))

        # Weft → there, a reply back.
        _, mine = await local.call("PUT", f"/rooms/{room}/send/m.room.message/t2", {
            "msgtype": "m.text", "body": "Super", "m.relates_to": {"m.in_reply_to": {"event_id": reply["event_id"]}}})
        back = await until(lambda: asyncio.sleep(0, next((m for m in seen["messages"] if m.content.body == "Super"), None)))
        ok("Weft's reply arrives there as a reply", bool(back) and back.content.get_reply_to() == friend_event, back and back.content.get_reply_to())

        # Read receipts each way.
        await local.call("POST", f"/rooms/{room}/receipt/m.read/{reply['event_id']}", {})
        read_there = await until(lambda: asyncio.sleep(0, any(friend_event in r.content and remote_karchi in (r.content[friend_event].get(ReceiptType.READ) or {}) for r in seen["receipts"])))
        ok("Karchi's reading in Weft shows there as read", bool(read_there))
        await friend.send_receipt(remote_room, back.event_id)

        async def read_here():
            await sync.step()
            return any(e["type"] == "m.receipt" and mine["event_id"] in e["content"] and ghost in e["content"][mine["event_id"]].get("m.read", {}) for e in sync.ephemeral)
        ok("the friend's reading shows in Weft on Karchi's message", await until(read_here))

        # Typing there shows as the ghost typing in Weft.
        await friend.set_typing(remote_room, timeout=10000)

        async def typing_here():
            await sync.step()
            return any(e["type"] == "m.typing" and ghost in e["content"].get("user_ids", []) for e in sync.ephemeral)
        ok("typing there shows in Weft", await until(typing_here))
        await friend.set_typing(remote_room, timeout=0)

        # Joining a room by its #alias.
        club = await friend.create_room(alias_localpart="klub", preset=RoomCreatePreset.PUBLIC, name="Klub")
        status, joined = await prov.call("POST", "/join", {"room": "#klub:remote.test"}, base=P)
        club_local = joined.get("room_id")
        ok("join by #alias answers with Weft's room", status == 200 and bool(club_local), joined)
        await friend.send_text(club, "Vitaj v klube")

        async def club_msg():
            await sync.step()
            return sync.find(club_local, lambda e: e["content"].get("body") == "Vitaj v klube")
        ok("a message in the joined room arrives in Weft", bool(await until(club_msg)))
        name = next((e["content"].get("name") for e in sync.state.get(club_local, []) if e["type"] == "m.room.name"), None)
        ok("the joined room keeps its name", name == "Klub", name)
        status, _ = await prov.call("POST", "/join", {"room": "#nikde:remote.test"}, base=P)
        ok("an alias that does not exist is refused", status in (400, 404), status)

        # Signing out cleans up.
        bridge_token = sqlite3.connect(base / "bridge" / "bridge.db").execute("SELECT token FROM login").fetchone()[0]
        status, _ = await prov.call("POST", f"/logout/{login_id}", {}, base=P)
        ok("sign-out answers", status == 200, status)
        _, w = await prov.call("GET", "/whoami", base=P)
        ok("no login is left", w.get("logins") == [], w)
        status, _ = await remote.call("GET", "/account/whoami", token=bridge_token)
        ok("the bridge's token no longer works there", status == 401, status)
        _, devices = await remote.call("GET", "/devices", token=remote_token)
        ok("…the Weft device is no longer listed", not any(d.get("display_name") == "Weft" for d in devices.get("devices", [])), [d.get("display_name") for d in devices.get("devices", [])])
        db = sqlite3.connect(base / "bridge" / "bridge.db")
        counts = {t: db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("login", "portal", "message")}
        ok("no login, chats or message ids are kept", not any(counts.values()), counts)
        ok("the keys are deleted", not (base / "bridge" / login_id).exists())

        async def left():
            await sync.step()
            return {room, club_local} <= sync.left
        ok("Karchi has left the Matrix chats in Weft", await until(left))
    finally:
        if friend:
            friend.stop()
            await seen["db"].stop()  # its worker thread would keep the test running
        await http.close()
        for p in procs[::-1]:
            p.terminate()
        for p in procs:
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.kill()
        if os.environ.get("KEEP"):
            print("kept", base)
        else:
            shutil.rmtree(base, ignore_errors=True)
    failed = results.count(False)
    print(f"FAILED {failed}" if failed else f"all {len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

"""A throwaway homeserver with three people (the owner and two invited friends) and a bridge's puppet, for checking
that each Weft service keeps every person's data to that person. Standard library only.

    with harness.Server() as hs:
        hs.owner, hs.anna, hs.boris   # (user_id, token)
        hs.puppet                     # (user_id, appservice token, user_id query) of a bridge's ghost
        port = hs.service(["python3", "-I", "server/calendar/kalendar.py"], env={...})  # waits until it listens

TUWUNEL=~/matrix-spike/bin/tuwunel by default.
"""
import json, os, secrets, shutil, socket, subprocess, sys, tempfile, time, urllib.error, urllib.request
from pathlib import Path

TUWUNEL = os.path.expanduser(os.environ.get("TUWUNEL", "~/matrix-spike/bin/tuwunel"))
NAME = "weft.test"
FAILED = []


def ok(name, passed, detail=""):
    print(("ok   " if passed else "FAIL ") + name + (f"  ({detail})" if detail and not passed else ""), flush=True)
    if not passed: FAILED.append(name)


def done():
    print(f"\n{'all passed' if not FAILED else str(len(FAILED)) + ' failed: ' + ', '.join(FAILED)}")
    sys.exit(1 if FAILED else 0)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def call(method, url, body=None, token=None, raw=None, headers=None):
    """(status, json or text) of one request; never raises for an HTTP error."""
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    h = {"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {}), **(headers or {})}
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r: text = r.read().decode()
        status = r.status
    except urllib.error.HTTPError as e:
        status, text = e.code, e.read().decode()
    try: return status, json.loads(text)
    except ValueError: return status, text


def wait_port(port, seconds=30):
    end = time.time() + seconds
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1): return
        except OSError: time.sleep(0.1)
    raise RuntimeError(f"nothing listens on {port}")


class Server:
    def __init__(self):
        self.base = Path(tempfile.mkdtemp(prefix="weft-hostia-"))
        self.port, self.procs = free_port(), []
        self.url = f"http://127.0.0.1:{self.port}"
        self.appservices = self.base / "appservices"

    def __enter__(self):
        self.appservices.mkdir()
        self.as_token, hs_token = secrets.token_hex(16), secrets.token_hex(16)
        # A bridge like the real ones: an exclusive namespace of ghosts and a bot.
        (self.appservices / "netbridge.yaml").write_text("\n".join([
            "id: netbridge", "url: null", f"as_token: {self.as_token}", f"hs_token: {hs_token}",
            "sender_localpart: netbot", "rate_limited: false", "namespaces:", "  users:",
            f"  - regex: ^@net_.*:{NAME.replace('.', chr(92) + '.')}$", "    exclusive: true",
            f"  - regex: ^@netbot:{NAME.replace('.', chr(92) + '.')}$", "    exclusive: true", ""]))
        self.dp_token = secrets.token_hex(16)
        (self.appservices / "doublepuppet.yaml").write_text("\n".join([
            "id: doublepuppet", "url: null", f"as_token: {self.dp_token}", f"hs_token: {secrets.token_hex(16)}",
            "sender_localpart: doublepuppet", "rate_limited: false", "namespaces:", "  users:",
            f"  - regex: '@.*:{NAME.replace('.', chr(92) + '.')}'", "    exclusive: false", ""]))
        reg = secrets.token_hex(8)
        conf = self.base / "tuwunel.toml"
        conf.write_text("\n".join([
            "[global]", f'server_name = "{NAME}"', f'database_path = "{self.base / "db"}"', 'address = ["127.0.0.1"]',
            f"port = {self.port}", "allow_registration = true", f'registration_token = "{reg}"', "allow_federation = false",
            'new_user_displayname_suffix = ""', 'log = "warn"', "log_colors = false",
            f'appservice_dir = "{self.appservices}"', ""]))
        self.procs.append(subprocess.Popen([TUWUNEL, "-c", str(conf)], stdout=open(self.base / "hs.log", "w"), stderr=subprocess.STDOUT))
        wait_port(self.port, 60)
        self.owner, self.anna, self.boris = (self.register(u, reg) for u in ("karchi", "anna", "boris"))
        ghost = f"@net_ghost:{NAME}"
        call("POST", f"{self.url}/_matrix/client/v3/register", {"type": "m.login.application_service", "username": "net_ghost"}, token=self.as_token)
        self.puppet = (ghost, self.as_token, ghost)
        return self

    def register(self, user, reg):
        body = {"username": user, "password": secrets.token_hex(12), "initial_device_display_name": "test"}
        status, data = call("POST", f"{self.url}/_matrix/client/v3/register", body)
        if status == 401:
            body["auth"] = {"type": "m.login.registration_token", "token": reg, "session": data.get("session")}
            status, data = call("POST", f"{self.url}/_matrix/client/v3/register", body)
        assert status == 200, data
        return data["user_id"], data["access_token"]

    def service(self, argv, env, port=None):
        """Starts a service with HS, OWNER and APPSERVICE_DIR set; returns its port (env PORT)."""
        port = port or free_port()
        full = {**os.environ, "HS": self.url, "OWNER": self.owner[0], "APPSERVICE_DIR": str(self.appservices), "PORT": str(port), **env}
        self.procs.append(subprocess.Popen(argv, env=full, stdout=open(self.base / f"svc-{port}.log", "w"), stderr=subprocess.STDOUT))
        wait_port(port)
        return port

    def __exit__(self, *a):
        for p in reversed(self.procs):
            p.terminate()
            try: p.wait(10)
            except subprocess.TimeoutExpired: p.kill()
        if not os.environ.get("KEEP"): shutil.rmtree(self.base, ignore_errors=True)
        else: print("kept", self.base)

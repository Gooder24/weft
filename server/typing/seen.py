#!/usr/bin/env python3
"""Whether a network took Karchi's „píše…“: Weft asks, the bridges' own logs answer.

  GET /_typing/wait?room=<room id>   waits up to 8 s for the bridge to report Karchi's typing in that chat
                                      {"state": "shown" | "failed" | "unknown", "net": "...", "error": "..."}

The bridgev2 bridges (Messenger and Instagram on mautrix-meta, WhatsApp) log „Sent typing event“ after the
network accepted it and „Failed to bridge Matrix typing event“ when it refused; this service follows their journal
(`journalctl --user -f`) and keeps the latest line per chat in memory. Legacy Discord logs success only at debug
level, so its chats stay „unknown“. Karchi's token only (whoami against the homeserver, cached 5 minutes).
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("TYPING_PORT", "29334"))
HS = os.environ.get("TYPING_HS", "http://127.0.0.1:8008")
OWNER = os.environ.get("TYPING_OWNER") or os.environ.get("OWNER", "")  # Karchi's Matrix ID, ~/.config/weft/weft.env
UNITS = {"matrix-spike-messenger": "messenger", "matrix-spike-instagram": "instagram", "matrix-spike-whatsapp": "whatsapp"}
WAIT = 8.0     # seconds a request waits for the bridge
FRESH = 2.0    # Weft asks as it starts typing, so an answer older than this belongs to an earlier start
ANSI = re.compile(r"\x1b\[[0-9;]*m")
FIELD = re.compile(r'(\w+)=("(?:[^"\\]|\\.)*"|\S*)')


def parse(line):
    """A bridge log line about Karchi's typing as (room, typing, error) or None. typing is None on a failure."""
    line = ANSI.sub("", line)
    sent = "Sent typing event" in line
    if not sent and "Failed to bridge Matrix typing event" not in line:
        return None
    f = {k: v[1:-1].replace('\\"', '"') if v.startswith('"') else v for k, v in FIELD.findall(line)}
    room = f.get("portal_mxid", "")
    if not room.startswith("!") or (OWNER and f.get("user_id") != OWNER):
        return None
    if sent:
        return room, f.get("typing") == "true", None
    return room, None, f.get("error") or "failed"


class Reports:
    def __init__(self):
        self.cond = threading.Condition()
        self.last = {}  # room -> {"at", "typing", "error", "net"}

    def add(self, room, typing, error, net):
        with self.cond:
            self.last[room] = {"at": time.monotonic(), "typing": typing, "error": error, "net": net}
            if len(self.last) > 2000:
                for old in sorted(self.last, key=lambda r: self.last[r]["at"])[:1000]:
                    self.last.pop(old, None)
            self.cond.notify_all()

    def wait(self, room, started):
        """The bridge's answer to typing that started at `started` (monotonic), or None after WAIT."""
        def answer():
            x = self.last.get(room)
            # A failure before this request was an earlier stop's; Weft asks before it sends the start.
            if x and (x["typing"] and x["at"] >= started - FRESH or x["error"] and x["at"] >= started):
                return x
            return None
        with self.cond:
            self.cond.wait_for(answer, WAIT)
            return answer()


REPORTS = Reports()


def follow():
    args = ["journalctl", "--user", "-f", "-n", "0", "-o", "json"]
    for unit in UNITS:
        args += ["-u", unit]
    while True:
        p = subprocess.Popen(args, stdout=subprocess.PIPE, text=True, errors="replace")
        for raw in p.stdout:
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            msg = rec.get("MESSAGE")
            if isinstance(msg, list):  # journald keeps a line with colour codes as bytes, as the bridges' lines are
                msg = bytes(b & 0xFF for b in msg if isinstance(b, int)).decode("utf-8", "replace")
            if not isinstance(msg, str):
                continue
            got = parse(msg)
            if got:
                unit = (rec.get("_SYSTEMD_USER_UNIT") or rec.get("USER_UNIT") or "").removesuffix(".service")
                REPORTS.add(*got, UNITS.get(unit, ""))
        p.wait()
        time.sleep(2)


def whoami(token):
    req = urllib.request.Request(HS + "/_matrix/client/v3/account/whoami", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)["user_id"]


class Api(BaseHTTPRequestHandler):
    tokens = {}

    def log_message(self, *a):
        pass

    def send(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def karchi(self):
        token = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
        if not token:
            return False
        now = time.time()
        for t, at in list(self.tokens.items()):
            if now - at >= 300:
                self.tokens.pop(t, None)
        if token in self.tokens:
            return True
        try:
            ok = whoami(token) == OWNER
        except Exception:
            return False
        if ok:
            self.tokens[token] = now
        return ok

    def do_GET(self):
        started = time.monotonic()
        u = urllib.parse.urlsplit(self.path)
        room = urllib.parse.parse_qs(u.query).get("room", [""])[0]
        if u.path != "/_typing/wait":
            return self.send(404, {"error": "not found"})
        if not self.karchi():
            return self.send(401, {"error": "Karchi's token only"})
        if not room.startswith("!") or len(room) > 255:
            return self.send(400, {"error": "room missing"})
        x = REPORTS.wait(room, started)
        if not x:
            return self.send(200, {"state": "unknown"})
        if x["error"]:
            return self.send(200, {"state": "failed", "net": x["net"], "error": x["error"][:300]})
        return self.send(200, {"state": "shown", "net": x["net"]})


def main():
    if sys.argv[1:2] == ["parse"]:  # check a log line: seen.py parse '<line>'
        print(parse(sys.argv[2]))
        return
    if not OWNER:
        sys.exit("OWNER is not set: add it to ~/.config/weft/weft.env")
    threading.Thread(target=follow, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Api).serve_forever()


if __name__ == "__main__":
    main()

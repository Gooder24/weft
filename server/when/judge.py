#!/usr/bin/env python3
"""Weft's judge for calendar suggestions: is a message with a time a plan to put into the calendar?

  POST /_when/judge {"text": "...", "when": "št 19. 11. 17:00"}  ->  {"plan": true, "title": "Tréning"}

app/when.js finds the time on the device; this only answers what words cannot: "zajtra o 17:00 tréning, nemôžem
ostať dlho" is a plan, "tréning sa presúva" and "pošlem ti video, preskoč na 12:34" are not. A small language model
runs on asus itself (llama.cpp's llama-server, unit matrix-spike-when-llm), so the text never leaves Karchi's
machines. For Karchi's token only, checked with the homeserver on every question (a logged-out token is refused at
once). Only the verdict is kept, by a hash of the text and time (neither the text nor the title) in
state/judged.sqlite; one question is asked of the model at a time, and when it is busy or down the app falls back to
what when.js alone would offer.

  python3 judge.py ask "text" "when"   asks once from the command line (no cache), for checks
"""
import hashlib
import json
import os
import sqlite3
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "common"))
import weft_users

PORT = int(os.environ.get("WHEN_PORT", "29331"))
LLM = os.environ.get("WHEN_LLM", "http://127.0.0.1:29332")
HS = os.environ.get("WHEN_HS", "http://127.0.0.1:8008")
OWNER = os.environ.get("WHEN_OWNER") or os.environ.get("OWNER", "")  # the owner's Matrix ID, from ~/.config/weft/weft.env
STATE = os.environ.get("WHEN_STATE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "state"))
WAIT = 25.0          # seconds a question may wait for the model, its answer included
PER_MINUTE = 40      # questions to the model per minute

PROMPT = """You read one chat message (Slovak or English) and decide whether it states a plan, appointment or \
deadline that its reader would put into a calendar at the time given. The time was read from the message already.

Answer plan=false when the message cancels, refuses or moves the event without giving this as the new time, when it \
is past, only a wish or a question about something else, a score or a guess, a time inside a video or a song, an \
amount, or something sent or done at that time rather than an event. A plan stays a plan when the writer only adds \
that they cannot stay long or will be late. When it says the event was moved (presunuli, posunuli mi termín, moved, \
rescheduled) and still names the time read, that is its new time: a plan.

Examples: "V piatok o 18:00 krúžok, prídem neskôr" is a plan; "Krúžok v piatok o 18:00 odpadá" is not; "Party on \
Saturday at 8, I'll leave early" is a plan; "I'll send you the notes on Saturday at 8" is not; "Krúžok presunuli na \
štvrtok o 16:00" is a plan; "The meeting moved from Friday at 3, new date TBD" is not; "Zajtra o 7 futbal?" and \
"Lunch on Friday at 12?" are plans (a question that proposes or confirms the meeting is a plan).

title: what happens, 1 to 5 words in the message's language, without the day or time, first letter capital \
("Tréning", "Diktát zo slovenčiny", "Dinner with Anna"). Empty when the message names nothing."""

SCHEMA = {"type": "object", "properties": {"plan": {"type": "boolean"}, "title": {"type": "string", "maxLength": 60}},
          "required": ["plan", "title"]}


def ask(text, when):
    """The model's answer, or None when it cannot answer now."""
    body = {
        "messages": [{"role": "system", "content": PROMPT},
                     {"role": "user", "content": f"Message: {text}\nTime read from it: {when}"}],
        "temperature": 0, "max_tokens": 48, "cache_prompt": True,
        "response_format": {"type": "json_schema", "json_schema": {"name": "judgement", "schema": SCHEMA}},
    }
    req = urllib.request.Request(LLM + "/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=WAIT) as r:
        out = json.loads(json.load(r)["choices"][0]["message"]["content"])
    title = " ".join(str(out.get("title") or "").split())[:60]
    return {"plan": bool(out.get("plan")), "title": title or None}


class Judge:
    def __init__(self):
        os.makedirs(STATE, mode=0o700, exist_ok=True)
        path = os.path.join(STATE, "judged.sqlite")
        self.db = sqlite3.connect(path, check_same_thread=False)
        os.chmod(path, 0o600)
        # An older "judged" table also kept titles: it goes, and the verdicts start over.
        if self.db.execute("select 1 from sqlite_master where name = 'judged'").fetchone():
            self.db.execute("drop table judged")
            self.db.commit()
            self.db.execute("vacuum")   # and its pages with it
        self.db.execute("create table if not exists verdicts (key text primary key, plan integer, at real)")
        self.db.commit()
        self.lock = threading.Lock()      # the database
        self.model = threading.Lock()     # one question to the model at a time
        self.asked = []
        self.owner_waiting = 0            # the owner's questions waiting for the model: others then wait their turn

    def get(self, text, when, person=""):
        # person: "" for the owner (his verdicts keep their keys), anyone else's Matrix ID, so a kept verdict never
        # tells one person what another person's messages said.
        key = hashlib.sha256(f"{person}\n{when}\n{text}".encode() if person else f"{when}\n{text}".encode()).hexdigest()
        with self.lock:
            row = self.db.execute("select plan from verdicts where key = ?", (key,)).fetchone()
        if row:   # the title is not kept: the device falls back to its own
            return {"plan": bool(row[0]), "title": None}
        # The owner waits for the model; anyone else asks only while it is free, so at most one of their questions
        # (a few seconds) is ever ahead of his.
        if person:
            if self.owner_waiting or not self.model.acquire(blocking=False): return None
        else:
            with self.lock: self.owner_waiting += 1
            try: got = self.model.acquire(timeout=WAIT)
            finally:
                with self.lock: self.owner_waiting -= 1
            if not got: return None
        try:
            with self.lock:   # asked meanwhile by another window
                row = self.db.execute("select plan from verdicts where key = ?", (key,)).fetchone()
            if row:
                return {"plan": bool(row[0]), "title": None}
            now = time.time()
            self.asked = [t for t in self.asked if now - t < 60]
            # A third of the model's minute stays the owner's, however many others ask.
            if len(self.asked) >= (PER_MINUTE if not person else max(1, PER_MINUTE * 2 // 3)):
                return None
            self.asked.append(now)
            try:
                out = ask(text, when)
            except Exception:
                return None
            with self.lock:
                self.db.execute("insert or replace into verdicts values (?, ?, ?)", (key, int(out["plan"]), now))
                self.db.commit()
            return out
        finally:
            self.model.release()


USERS = weft_users.Users(HS, OWNER)
ASKS = weft_users.Limit(120, 3600)  # questions an hour of one person other than the owner: the model is shared


class Api(BaseHTTPRequestHandler):
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

    def person(self):
        """"" for the owner, the Matrix ID of anyone else of this server, None for everyone else."""
        user = USERS.who((self.headers.get("Authorization") or "").removeprefix("Bearer ").strip())
        return None if user is None else "" if user == OWNER else user

    def do_POST(self):
        if self.path != "/_when/judge":
            return self.send(404, {"error": "not found"})
        person = self.person()
        if person is None:
            return self.send(401, {"error": "a token of this server's people only"})
        try:
            size = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(size, 8192)) or b"{}")
            text, when = str(body["text"]), str(body["when"])
        except Exception:
            return self.send(400, {"error": "text and when, please"})
        if not text.strip() or len(text) > 500 or len(when) > 60:
            return self.send(400, {"error": "text missing or too long"})
        if person and not ASKS.take(person):
            return self.send(503, {"error": "the model is busy or down"})
        out = JUDGE.get(text, when, person)
        if out is None:
            return self.send(503, {"error": "the model is busy or down"})
        self.send(200, out)


def main():
    if sys.argv[1:2] == ["ask"]:
        print(json.dumps(ask(sys.argv[2], sys.argv[3]), ensure_ascii=False))
        return
    if not OWNER: sys.exit("OWNER is not set: add it to ~/.config/weft/weft.env")
    global JUDGE
    JUDGE = Judge()
    ThreadingHTTPServer(("127.0.0.1", PORT), Api).serve_forever()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Attachments of EduPage messages, copied into Matrix when Weft shows them (POST /attachment): only addresses a kept
message names, once, with the right type; a 25 MB one or EduPage's login page is said plainly. Nothing reaches
EduPage or a homeserver; the items are made up in EduPage's shape.

Run with the bridge's venv (edupage_api): python tests/edupage/attachment_test.py [server/edupage/bridge.py]"""
import importlib.util, io, json, os, sqlite3, sys, tempfile, threading

here = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp()
open(f"{tmp}/reg.yaml", "w").write("as_token: AS\nhs_token: HS\n")
open(f"{tmp}/dp.yaml", "w").write("as_token: DP\n")
os.environ.update(ADMIN_MXID="@me:test", REGISTRATION=f"{tmp}/reg.yaml", DOUBLEPUPPET=f"{tmp}/dp.yaml",
                  STATE_DIR=tmp, HOMESERVER="http://127.0.0.1:9")
path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "../../server/edupage/bridge.py")
spec = importlib.util.spec_from_file_location("bridge", path)
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

fails = 0


def check(name, ok, got=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" → {got!r}"))
    fails += not ok


BASE = "https://skola.edupage.org"
PIC = "/elearning/abcimg?z%3Aplagat"
DOC = "/elearning/abc?z%3Asuhlas"
item = {"timelineid": 1, "typ": "sprava", "vlastnik": "Ucitel7", "text": "Pozrite si plagát.",
        "data": json.dumps({"attachements": {PIC: "plagat.jpg", DOC: "Súhlas.pdf"}}).replace("/", "\\/")}
db = sqlite3.connect(":memory:", check_same_thread=False)
db.execute("CREATE TABLE raw (id INTEGER PRIMARY KEY, typ TEXT NOT NULL, ts INTEGER NOT NULL, item TEXT NOT NULL)")
db.execute("INSERT INTO raw VALUES (1, 'sprava', 0, ?)", (json.dumps(item),))
check("the item keeps EduPage's escaped slashes and still names its files",
      b.item_data(item)["attachements"][PIC] == "plagat.jpg")

JPEG = b"\xff\xd8\xff\xc0\x00\x11\x08\x00\x20\x00\x40" + b"\x00" * 64


class Resp:
    def __init__(self, content, ctype, status=200, location=""):
        self.content, self.status_code = content, status
        self.headers = {"Content-Type": ctype, **({"Location": location} if location else {})}
    def raise_for_status(self): pass
    def close(self): self.closed = True
    def iter_content(self, size):
        if isinstance(self.content, bytes):
            yield self.content
        else:
            yield from self.content


class Session:
    def __init__(self, login=False): self.gets, self.login, self.cookies = [], login, {}

    # The bridge asks the adapter itself (get_once), never Session.get.
    def prepare_request(self, req): return req.url
    def get_adapter(self, url): return self

    def send(self, url, stream=False, timeout=None):
        assert stream
        self.gets.append(url)
        if "away" in url:
            return Resp(b"", "text/html", 302, "https://127.0.0.1/secret")
        if "moved" in url:
            return Resp(b"", "text/html", 302, "/elearning/abcimg?z%3Aplagat")
        if "tocloudb" in url:
            return Resp(b"", "text/html", 301, "https://cloud-b.edupage.org/cloud?z%3Asuhlas.pdf")
        if "cloud-b.edupage.org" in url:
            return Resp(b"%PDF-1.4", "application/pdf")
        if "tocloud" in url:
            return Resp(b"", "text/html", 301, "https://cloud-2.edupage.org/cloud?z%3Aplagat.jpg")
        if "othercloud" in url:
            return Resp(b"", "text/html", 301, "https://ina.edupage.org/cloud?z")
        if "cloud-2.edupage.org" in url:
            return Resp(JPEG, "image/jpeg")
        if self.login:
            return Resp(b"<html>login</html>", "text/html; charset=utf-8")
        if "big" in url:  # says its size; its body is never read
            r = Resp(None, "application/pdf")
            r.headers["Content-Length"] = str(b.MAX_FILE_BYTES + 1)
            return r
        if "huge" in url:  # does not say its size: read only until it is too big
            self.chunks = 0
            def chunks():
                while True:
                    self.chunks += 1
                    yield b"\0" * (1 << 20)
            return Resp(chunks(), "application/pdf")
        return Resp(JPEG if "img" in url else b"%PDF-1.4", "application/octet-stream")


class Edu:
    subdomain = "skola"
    def __init__(self, login=False): self.session = Session(login)


uploads = []


def urlopen(req, timeout=None):
    uploads.append((req.full_url, req.headers.get("Content-type"), len(req.data)))
    return io.BytesIO(json.dumps({"content_uri": f"mxc://test/{len(uploads)}"}).encode())


b.urllib.request.urlopen = urlopen
b.ACCOUNT.lock = threading.Lock()
b.ACCOUNT.creds = {"login_id": "skola:Student100", "school": "skola", "user_id": "Student100", "session": "s"}
b.ACCOUNT.edu = Edu()

pic = b.message_attachment(db, BASE + PIC)
check("a picture is copied with its type and size",
      pic == {"name": "plagat.jpg", "url": "mxc://test/1", "mimetype": "image/jpeg", "size": len(JPEG), "w": 64, "h": 32}
      and uploads[0][1] == "image/jpeg", (pic, uploads))
again = b.message_attachment(db, BASE + PIC)
check("asked again, it comes from the kept copy", again == pic and len(b.ACCOUNT.edu.session.gets) == 1 and len(uploads) == 1)
doc = b.message_attachment(db, BASE + DOC)
check("a document gets its type from its name", doc["mimetype"] == "application/pdf" and doc["name"] == "Súhlas.pdf", doc)

for name, url in (("an address no message names", BASE + "/elearning/other"),
                  ("another school's address", "https://ina.edupage.org" + PIC),
                  ("a page outside elearning", BASE + "/user/")):
    try:
        b.message_attachment(db, url)
        check(f"{name} is refused", False, "no error")
    except b.ApiError as err:
        check(f"{name} is refused", err.status == 404, err.status)
check("refusals read nothing from EduPage", len(b.ACCOUNT.edu.session.gets) == 2)

big = {**item, "timelineid": 2, "data": json.dumps({"attachements": {"/elearning/big": "video.mp4"}})}
db.execute("INSERT INTO raw VALUES (2, 'sprava', 0, ?)", (json.dumps(big),))
try:
    b.message_attachment(db, BASE + "/elearning/big")
    check("over 25 MB: said, not copied", False, "no error")
except b.ApiError as err:
    check("over 25 MB: said, not copied", err.status == 413 and len(uploads) == 2, (err.status, uploads))

huge = {**item, "timelineid": 3, "data": json.dumps({"attachements": {"/elearning/huge": "film.mp4"}})}
db.execute("INSERT INTO raw VALUES (3, 'sprava', 0, ?)", (json.dumps(huge),))
try:
    b.message_attachment(db, BASE + "/elearning/huge")
    check("over 25 MB without a stated size: reading stops, not copied", False, "no error")
except b.ApiError as err:
    check("over 25 MB without a stated size: reading stops, not copied", err.status == 413 and len(uploads) == 2
          and b.ACCOUNT.edu.session.chunks == b.MAX_FILE_BYTES // (1 << 20) + 1, (err.status, b.ACCOUNT.edu.session.chunks))

for key, name in (("/elearning/away", "von.pdf"), ("/elearning/moved", "presun.jpg"), ("/elearning/tocloud", "c.jpg"), ("/elearning/tocloudb", "e.pdf"), ("/elearning/othercloud", "d.jpg")):
    db.execute("INSERT INTO raw VALUES (?, 'sprava', 0, ?)", (len(key), json.dumps({**item, "timelineid": len(key), "data": json.dumps({"attachements": {key: name}})})))
try:
    b.message_attachment(db, BASE + "/elearning/away")
    check("a redirect off the school's site is not followed", False, "no error")
except b.ApiError as err:
    check("a redirect off the school's site is not followed", err.status == 502 and not any("127.0.0.1" in g for g in b.ACCOUNT.edu.session.gets), err.status)
cloud = b.message_attachment(db, BASE + "/elearning/tocloud")
check("a redirect to EduPage's file store is followed", cloud["mimetype"] == "image/jpeg" and "cloud-2.edupage.org" in b.ACCOUNT.edu.session.gets[-1], cloud)
check("a lettered file store too", b.message_attachment(db, BASE + "/elearning/tocloudb")["mimetype"] == "application/pdf")
try:
    b.message_attachment(db, BASE + "/elearning/othercloud")
    check("a redirect to another school is not followed", False, "no error")
except b.ApiError as err:
    check("a redirect to another school is not followed", err.status == 502, err.status)
moved = b.message_attachment(db, BASE + "/elearning/moved")
check("a redirect within the school's site is followed", moved["mimetype"] == "image/jpeg" and b.ACCOUNT.edu.session.gets[-1].endswith("abcimg?z%3Aplagat"), moved)

# The session ended: EduPage answers with its login page; the bridge signs in again once and keeps that session.
signed = []
b.ACCOUNT.edu = Edu(login=True)
b.ACCOUNT.connect = lambda creds: signed.append(creds) or Edu()
b.ACCOUNT.save = lambda: None
db.execute("DELETE FROM attachments")
got = b.message_attachment(db, BASE + DOC)
check("an ended session is renewed once and kept", got["mimetype"] == "application/pdf" and len(signed) == 1
      and signed[0]["session"] == "" and not b.ACCOUNT.edu.session.login, (got, signed))

b.ACCOUNT.edu = Edu(login=True)
b.ACCOUNT.connect = lambda creds: Edu(login=True)
db.execute("DELETE FROM attachments")
try:
    b.message_attachment(db, BASE + DOC)
    check("EduPage still refusing: said plainly", False, "no error")
except b.ApiError as err:
    check("EduPage still refusing: said plainly", err.status == 502, err.status)

# A real requests session against a local server: a redirect with a large body is answered without reading that body.
import http.server, socket
sent = []
class Big(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(301)
        self.send_header("Location", "https://cloud-2.edupage.org/x")
        self.send_header("Content-Length", str(64 << 20))
        self.end_headers()
        try:
            for _ in range(64):
                self.wfile.write(b"\0" * (1 << 20))
                sent.append(1)
        except OSError:
            pass
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Big)
threading.Thread(target=srv.serve_forever, daemon=True).start()
r = b.get_once(b.requests.Session(), f"http://127.0.0.1:{srv.server_address[1]}/elearning/r")
check("a redirect's body is not read", r.status_code == 301 and r.raw.tell() < (8 << 20), r.raw.tell())
r.close()
srv.shutdown()

print("FAILS:", fails)
sys.exit(1 if fails else 0)

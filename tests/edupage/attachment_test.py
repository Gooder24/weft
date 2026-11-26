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


class Session:
    def __init__(self, login=False): self.gets, self.login, self.cookies = [], login, {}

    def get(self, url, timeout=None, allow_redirects=True):
        assert allow_redirects is False
        self.gets.append(url)
        if "away" in url:
            return Resp(b"", "text/html", 302, "https://127.0.0.1/secret")
        if "moved" in url:
            return Resp(b"", "text/html", 302, "/elearning/abcimg?z%3Aplagat")
        if self.login:
            return Resp(b"<html>login</html>", "text/html; charset=utf-8")
        if "big" in url:
            return Resp(b"x" * (b.MAX_FILE_BYTES + 1), "application/pdf")
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

for key, name in (("/elearning/away", "von.pdf"), ("/elearning/moved", "presun.jpg")):
    db.execute("INSERT INTO raw VALUES (?, 'sprava', 0, ?)", (len(key), json.dumps({**item, "timelineid": len(key), "data": json.dumps({"attachements": {key: name}})})))
try:
    b.message_attachment(db, BASE + "/elearning/away")
    check("a redirect off the school's site is not followed", False, "no error")
except b.ApiError as err:
    check("a redirect off the school's site is not followed", err.status == 502 and not any("127.0.0.1" in g for g in b.ACCOUNT.edu.session.gets), err.status)
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

print("FAILS:", fails)
sys.exit(1 if fails else 0)

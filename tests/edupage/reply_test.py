#!/usr/bin/env python3
"""Replies to EduPage from Weft: to whom they go (everyone or the author alone) and how a sent reply is found when
EduPage's answer does not name it. Nothing reaches EduPage or a homeserver; the items are made up in EduPage's shape.

Run with the bridge's venv (edupage_api): python tests/edupage/reply_test.py [server/edupage/bridge.py]"""
import importlib.util, json, os, queue, sqlite3, sys, tempfile, threading

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


ME = "Student100"
# A teacher's message to a whole class, one to the pupil alone, one whose author allowed replies only to herself,
# one to several classes, and the pupil's own question to a teacher.
CLASS = {"timelineid": 10, "typ": "sprava", "vlastnik": "Ucitel7", "user": "StudTrieda5", "data": "{\"repliesByUser\": []}"}
ALONE = {"timelineid": 11, "typ": "sprava", "vlastnik": "Ucitel7", "user": "Student100", "data": "{}"}
AUTHOR = {"timelineid": 12, "typ": "sprava", "vlastnik": "Ucitel-1", "user": "StudTrieda5",
          "data": json.dumps({"hiddenRecipients": "1", "repliesToAllDisabled": "1"})}
MANY = {"timelineid": 13, "typ": "sprava", "vlastnik": "Ucitel7", "user": "Ucitel8",
        "data": json.dumps({"toMultiple": [{"id": "StudTrieda5"}, {"id": "StudTrieda6"}]})}
OWN = {"timelineid": 14, "typ": "sprava", "vlastnik": "Student100", "user": "Ucitel7", "data": "{}"}

check("class message: Karchi chooses", b.reply_audience(CLASS, ME) == "all")
check("message to him alone: no choice", b.reply_audience(ALONE, ME) is None)
check("replies to the author only", b.reply_audience(AUTHOR, ME) == "author")
check("several classes: Karchi chooses", b.reply_audience(MANY, ME) == "all")
check("his own message: no choice", b.reply_audience(OWN, ME) is None)

check("class, no choice sent: author alone", b.reply_recipient(CLASS, ME, "") == "Ucitel7")
check("class, 'one': author alone", b.reply_recipient(CLASS, ME, "one") == "Ucitel7")
check("class, 'all': everyone", b.reply_recipient(CLASS, ME, "all") == "")
check("author-only thread ignores 'all'", b.reply_recipient(AUTHOR, ME, "all") == "Ucitel-1")
check("two-person thread: EduPage's one answer", b.reply_recipient(ALONE, ME, "all") == "" and b.reply_recipient(OWN, ME, "") == "")
check("unknown thread: as before", b.reply_recipient(None, ME, "") == "")
try:
    b.reply_recipient({**CLASS, "vlastnik": ""}, ME, "")
    check("a class thread without an author is refused, not sent to everyone", False, "no error")
except RuntimeError:
    check("a class thread without an author is refused, not sent to everyone", True)

# The reply and EduPage's helper copy of the question, as EduPage lists them after a reply.
reply = {"timelineid": "21", "reakcia_na": "14", "vlastnik": "Student100", "user": "Ucitel7", "text": "Ďakujem,\nrozumiem."}
helper = {"timelineid": "22", "reakcia_na": "14", "vlastnik": "Student100", "user": "StudentOnly100", "pomocny_zaznam": 1, "text": "Otázka?"}
older = {"timelineid": "19", "reakcia_na": "14", "vlastnik": "Student100", "text": "Ďakujem, rozumiem."}
check("own reply found by its text, helper copy and known ones skipped",
      b.own_item([older, reply, helper], ME, "Ďakujem, rozumiem.", 14, {19}) == 21)
check("a reply in another thread is not it", b.own_item([reply], ME, "Ďakujem, rozumiem.", 15, set()) is None)
check("someone else's reply is not it", b.own_item([{**reply, "vlastnik": "Ucitel7"}], ME, "Ďakujem, rozumiem.", 14, set()) is None)
check("EduPage's &quot; is the same text", b.own_item([{**reply, "text": "Povedal &quot;áno&quot;"}], ME, 'Povedal "áno"', 14, set()) == 21)
check("a removed own reply is not it", b.own_item([{**reply, "removed": "1"}], ME, "Ďakujem, rozumiem.", 14, set()) is None)
check("an own reply added before the send is not it",
      b.own_item([{**reply, "cas_pridania": "2026-11-26 13:00:00"}], ME, "Ďakujem, rozumiem.", 14, set(), "2026-11-26 14:03:00") is None
      and b.own_item([{**reply, "cas_pridania": "2026-11-26 14:05:00"}], ME, "Ďakujem, rozumiem.", 14, set(), "2026-11-26 14:03:00") == 21)


class Resp:
    def __init__(self, body): self.text = json.dumps(body)
    def raise_for_status(self): pass
    def json(self): return json.loads(self.text)


class Session:
    answer: dict = {}
    tab: list = []

    def __init__(self): self.posts, self.cookies = [], {}

    def post(self, url, params=None, data=None, headers=None, files=None, timeout=None):
        self.posts.append((url, data))
        if "createReply" in url or "createItem" in url:
            return Resp(Session.answer)
        return Resp({"timelineItems": Session.tab})  # the message tab read again


class Edu:
    subdomain = "skola"
    def __init__(self): self.session = Session()


b.RequestData.encode_request_body = staticmethod(lambda d: d)
b.RequestData.decode_response = staticmethod(lambda text: text)

edu = Edu()
Session.answer = {"changes": [{"timelineid": "31"}]}
check("id from 'changes'", b.send_reply(edu, 14, "x", None, "Ucitel7", ME, set()) == 31)
check("recipient goes to createReply", edu.session.posts[0][1]["recipient"] == "Ucitel7", edu.session.posts[0][1])

edu = Edu()
Session.answer = {"status": "ok", "data": {"reakcie": [older, reply]}}
check("id from the thread's replies when 'changes' is missing",
      b.send_reply(edu, 14, "Ďakujem, rozumiem.", None, "", ME, {19}) == 21 and len(edu.session.posts) == 1, edu.session.posts)

edu = Edu()
Session.answer, Session.tab = {"status": "ok", "changes": []}, [helper, reply]
check("id from the message tab when the answer names nothing",
      b.send_reply(edu, 14, "Ďakujem, rozumiem.", None, "", ME, set()) == 21 and len(edu.session.posts) == 2)

edu = Edu()
Session.answer, Session.tab = {"status": "ok"}, []
check("ok without any id: sent, id unknown (no false failure)", b.send_reply(edu, 14, "x", None, "", ME, set()) is None)

edu = Edu()
Session.answer, Session.tab = {"status": "ok", "changes": [{"timelineid": "19"}, {"timelineid": "23", "vlastnik": "Ucitel7"}]}, [reply]
check("'changes' naming a known or someone else's item is not taken",
      b.send_reply(edu, 14, "Ďakujem, rozumiem.", None, "", ME, {19}) == 21)

edu = Edu()
Session.answer, Session.tab = {"status": "ok", "changes": [{"timelineid": "81", "reakcia_na": "15"}, {"timelineid": "82", "cas_pridania": "2026-01-01 08:00:00"}]}, []
check("a change in another thread or older than the send is not taken",
      b.send_reply(edu, 14, "x", None, "", ME, set(), "2026-11-26 14:00:00") is None)

edu = Edu()
Session.answer, Session.tab = {"status": "error", "changes": [{"timelineid": "77"}]}, []
try:
    b.send_reply(edu, 14, "x", None, "", ME, set())
    check("a refusal wins over a 'changes' entry", False, "no error")
except RuntimeError:
    check("a refusal wins over a 'changes' entry", True)

edu = Edu()
Session.answer, Session.tab = {"status": "fail"}, [reply]
try:
    b.send_reply(edu, 14, "Ďakujem, rozumiem.", None, "", ME, set())
    check("a refusal is not hidden by an own same-text item", False, "no error")
except RuntimeError:
    check("a refusal is not hidden by an own same-text item", True)

edu = Edu()
Session.answer, Session.tab = {"status": "fail"}, []
try:
    b.send_reply(edu, 14, "x", None, "", ME, set())
    check("a refusal still raises", False, "no error")
except RuntimeError:
    check("a refusal still raises", True)

edu = Edu()
Session.answer, Session.tab = {"changes": []}, [{"timelineid": "40", "vlastnik": "Student100", "text": "Dobrý deň"}]
check("new message found in the tab too", b.send_message(edu, "Ucitel7", "Dobrý deň", None, ME, set()) == 40)

# The whole path: Weft's choice reaches createReply, the reply is marked sent, nothing false is said.
db = sqlite3.connect(":memory:")
db.executescript("CREATE TABLE items (id INTEGER PRIMARY KEY, root INTEGER NOT NULL, event_id TEXT NOT NULL);"
                 "CREATE TABLE raw (id INTEGER PRIMARY KEY, typ TEXT NOT NULL, ts INTEGER NOT NULL, item TEXT NOT NULL);"
                 "CREATE TABLE ghosts (mxid TEXT PRIMARY KEY, name TEXT NOT NULL);")
for item, ev in ((CLASS, "$class"), (ALONE, "$alone"), (AUTHOR, "$author"), (OWN, "$own")):
    db.execute("INSERT INTO items VALUES (?, ?, ?)", (item["timelineid"], item["timelineid"], ev))
    db.execute("INSERT INTO raw VALUES (?, 'sprava', 0, ?)", (item["timelineid"], json.dumps(item)))
said = []


class Rooms(b.Rooms):
    def school_room(self): return ("!room", "@edupage_school:test")
    def say(self, room, text, answers=""): said.append(text)
    def join(self, room, mxid): pass


rooms = Rooms(db)
check("Weft learns which threads ask", rooms.reply_audiences(ME) == {"$class": "all", "$author": "author"}, rooms.reply_audiences(ME))

acct = b.Account.__new__(b.Account)
acct.lock, acct.outbox, acct.teachers = threading.Lock(), queue.Queue(), []
acct.creds = {"login_id": "skola:" + ME, "school": "skola", "user_id": ME}
for choice, event in (("", "$r1"), ("all", "$r2")):
    acct.edu = Edu()
    Session.answer = {"changes": [{"timelineid": "5" + event[-1]}]}
    acct.outbox.put(("!room", event, "$class", "Ahoj", "", [], choice))
    acct.send_outbox(rooms)
    sent = acct.edu.session.posts[-1][1]
    check(f"class thread, choice {choice or 'none'!r}: recipient {sent['recipient']!r}",
          sent["recipient"] == ("" if choice == "all" else "Ucitel7") and sent["groupid"] == "10")
check("both marked sent, nothing said", db.execute("SELECT id FROM items WHERE event_id IN ('$r1','$r2')").fetchall() == [(51,), (52,)] and not said, said)

acct.edu = Edu()
Session.answer, Session.tab = {"status": "ok"}, []
acct.outbox.put(("!room", "$r3", "$own", "Ešte niečo", "", [], ""))
acct.send_outbox(rooms)
check("taken without an id: no 'neodišla'", not said, said)
now = b.datetime.now(b.LOCAL).strftime("%Y-%m-%d %H:%M:%S")
older = {"timelineid": "59", "typ": "sprava", "reakcia_na": "14", "vlastnik": ME, "text": "Ešte niečo", "cas_pridania": "2026-01-01 08:00:00"}
posted = []
b.matrix = lambda method, path, body=None, **k: posted.append(path) or {"event_id": f"$posted{len(posted)}"}
check("an older reply of the same text is posted, not taken for it",
      Rooms(db).sync([older], "skola", ME) == 1 and db.execute("SELECT 1 FROM unnamed").fetchall() == [(1,)])
check("the poll (also after a restart) links it instead of posting it again",
      Rooms(db).sync([{"timelineid": "60", "typ": "sprava", "reakcia_na": "14", "vlastnik": ME, "text": "Ešte  niečo", "cas_pridania": now}], "skola", ME) == 0
      and db.execute("SELECT root, event_id FROM items WHERE id = 60").fetchone() == (14, "$r3")
      and not db.execute("SELECT 1 FROM unnamed").fetchall())

# A thread whose first message was never kept raw: answered when Karchi wrote it, refused for anyone else's.
db.execute("INSERT INTO items VALUES (98, 98, '$mine'), (99, 99, '$theirs')")
b.matrix = lambda method, path, *a, **k: {"sender": "@me:test" if "%24mine" in path or "$mine" in path else "@edupage_ucitel1:test"}
check("own first message without raw: replies go to whom he wrote", rooms.recipient_for(98, ME, "") == "")
try:
    rooms.recipient_for(97, ME, "")
    check("a thread the bridge does not know is refused", False, "no error")
except RuntimeError:
    check("a thread the bridge does not know is refused", True)
acct.edu = Edu()
acct.outbox.put(("!room", "$r4", "$theirs", "Hm", "", [], ""))
acct.send_outbox(rooms)
check("someone else's without raw: nothing sent, Karchi told", not acct.edu.session.posts and said and "neodišla" in said[-1], (acct.edu.session.posts, said))

print("FAILS:", fails)
sys.exit(1 if fails else 0)

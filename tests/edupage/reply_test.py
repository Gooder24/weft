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
    status_code = 200
    def __init__(self, body, status=200): self.text, self.status_code = json.dumps(body), status
    def raise_for_status(self): pass
    def json(self): return json.loads(self.text)


class Session:
    answer: dict = {}
    tab: list = []
    lost = None  # an exception the send's connection ends with
    tab_lost = None  # an exception reading the message tab again ends with

    def __init__(self): self.posts, self.cookies = [], {}

    def post(self, url, params=None, data=None, headers=None, files=None, timeout=None):
        self.posts.append((url, data))
        if ("createReply" in url or "createItem" in url) and Session.lost:
            if isinstance(Session.lost, int):
                return Resp({}, Session.lost)
            raise Session.lost
        if "createReply" in url or "createItem" in url:
            return Resp(Session.answer)
        if Session.tab_lost:
            raise Session.tab_lost
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
    def say(self, room, text, answers="", txn=""): said.append(text)
    def join(self, room, mxid): pass


rooms = Rooms(db)
check("Weft learns which threads ask", rooms.reply_audiences(ME) == {"$class": "all", "$author": "author"}, rooms.reply_audiences(ME))

acct = b.Account.__new__(b.Account)
acct.lock, acct.outbox, acct.teachers = threading.Lock(), queue.Queue(), []
acct.creds = {"login_id": "skola:" + ME, "school": "skola", "user_id": ME}
statuses = []  # what the bridge writes into the room: only its send status, for Weft's ✓
b.matrix = lambda method, path, body=None, **k: statuses.append((path.split("/send/")[-1].split("/")[0], (body or {}).get("m.relates_to", {}).get("event_id"), (body or {}).get("status"))) or {}
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
check("each reply EduPage took gets the send status Weft shows as ✓", statuses == [("com.beeper.message_send_status", e, "SUCCESS") for e in ("$r1", "$r2", "$r3")], statuses)
now = b.datetime.now(b.LOCAL).strftime("%Y-%m-%d %H:%M:%S")
older = {"timelineid": "59", "typ": "sprava", "reakcia_na": "14", "vlastnik": ME, "text": "Ešte niečo", "cas_pridania": "2026-01-01 08:00:00"}
posted = []
b.matrix = lambda method, path, body=None, **k: posted.append(path) or {"event_id": f"$posted{len(posted)}"}
check("an older reply of the same text is posted, not taken for it",
      Rooms(db).sync([older], "skola", ME) == 1 and db.execute("SELECT 1 FROM unnamed").fetchall() == [(1,)])
db.execute("INSERT INTO unnamed VALUES ('$stale', 14, 'Staré', '2020-01-01 00:00:00')")
check("a day-old unmatched send never takes a new item",
      Rooms(db).sync([{"timelineid": "61", "typ": "sprava", "reakcia_na": "14", "vlastnik": ME, "text": "Staré", "cas_pridania": now}], "skola", ME) == 1)
check("the poll (also after a restart) links it instead of posting it again",
      Rooms(db).sync([{"timelineid": "60", "typ": "sprava", "reakcia_na": "14", "vlastnik": ME, "text": "Ešte  niečo", "cas_pridania": now}], "skola", ME) == 0
      and db.execute("SELECT root, event_id FROM items WHERE id = 60").fetchone() == (14, "$r3")
      and not db.execute("SELECT 1 FROM unnamed").fetchall())

# A thread whose first message was never kept raw: answered when Karchi wrote it, refused for anyone else's.
db.execute("INSERT INTO items VALUES (98, 98, '$mine'), (99, 99, '$theirs')")
b.matrix = lambda method, path, body=None, **k: (statuses.append(((body or {}).get("status"), (body or {}).get("m.relates_to", {}).get("event_id"))) if "/send/" in path else None) or \
    {"sender": "@me:test" if "%24mine" in path or "$mine" in path else "@edupage_ucitel1:test"}
check("own first message without raw: replies go to whom he wrote", rooms.recipient_for(98, ME, "") == "")
try:
    rooms.recipient_for(97, ME, "")
    check("a thread the bridge does not know is refused", False, "no error")
except RuntimeError:
    check("a thread the bridge does not know is refused", True)
acct.edu = Edu()
acct.outbox.put(("!room", "$r4", "$theirs", "Hm", "", [], ""))
acct.send_outbox(rooms)
check("…and a refused one none", not any("$r4" in x for x in statuses), statuses)
check("someone else's without raw: nothing sent, Karchi told", not acct.edu.session.posts and said and "neodišla" in said[-1], (acct.edu.session.posts, said))

# The connection breaks after the reply went out: nothing false is said, it is never sent again, and the poll that
# finds it gives its ✓; one no poll finds in UNSURE_MINUTES is said not to have gone.
events = []
b.matrix = lambda method, path, body=None, **k: events.append(((body or {}).get("status"), (body or {}).get("m.relates_to", {}).get("event_id"))) or {"event_id": "$x"}
said.clear()
acct.edu = Edu()
Session.lost = b.requests.ConnectionError("Connection aborted.")
acct.outbox.put(("!room", "$lost", "$own", "Stratená odpoveď", "", [], ""))
acct.send_outbox(rooms)
check("an answer lost on the way: nothing said, sent once, no ✓ yet", not said and len(acct.edu.session.posts) == 1 and not events
      and db.execute("SELECT 1 FROM unsure WHERE event_id = '$lost'").fetchone(), (said, acct.edu.session.posts, events))
now = b.datetime.now(b.LOCAL).strftime("%Y-%m-%d %H:%M:%S")
check("the poll that finds it links it and gives the ✓",
      Rooms(db).sync([{"timelineid": "70", "typ": "sprava", "reakcia_na": "14", "vlastnik": ME, "text": "Stratená odpoveď", "cas_pridania": now}], "skola", ME) == 0
      and db.execute("SELECT event_id FROM items WHERE id = 70").fetchone() == ("$lost",) and ("SUCCESS", "$lost") in events
      and not db.execute("SELECT 1 FROM unsure WHERE event_id = '$lost'").fetchall(), events)
acct.edu = Edu()
Session.lost = b.requests.ReadTimeout("read timed out")
acct.outbox.put(("!room", "$gone", "$own", "Neprišla", "", [], ""))
acct.send_outbox(rooms)
rooms.settle_unsure()
check("not found yet: still nothing said", not said, said)
db.execute("UPDATE unsure SET at = '2020-01-01 00:00:00' WHERE event_id = '$gone'")
rooms.settle_unsure()
check("not found in time: said not to have gone, once; kept a day to be linked if it shows up", len(said) == 1 and "neodišla" in said[0]
      and db.execute("SELECT notice FROM unsure WHERE event_id = '$gone'").fetchone() == ("-",)
      and db.execute("SELECT 1 FROM unnamed WHERE event_id = '$gone'").fetchone(), said)
rooms.settle_unsure()
check("…and not again", len(said) == 1, said)
acct.edu = Edu()
Session.lost = b.requests.ConnectTimeout("no route")
acct.outbox.put(("!room", "$never", "$own", "Nikam", "", [], ""))
acct.send_outbox(rooms)
check("a connection that never reached EduPage: said at once", len(said) == 2 and "neodišla" in said[1]
      and not db.execute("SELECT 1 FROM unsure WHERE event_id = '$never'").fetchall()
      and not db.execute("SELECT 1 FROM unnamed WHERE event_id = '$never'").fetchall(), said)

# A gateway's 504 after EduPage took it is not a failure either; the same Matrix event delivered again is not sent again;
# one that shows up only after its "neodišla" is linked, gets its ✓, and that notice is taken back.
class Rooms2(Rooms):
    def say(self, room, text, answers="", txn=""):
        said.append(text)
        return f"$notice{len(said)}"


rooms2 = Rooms2(db)
said.clear()
events.clear()
acct.edu = Edu()
Session.lost = 504
acct.outbox.put(("!room", "$late", "$own", "Neskoro", "", [], ""))
acct.send_outbox(rooms2)
check("a 504 after the send: nothing said, unsure", not said and db.execute("SELECT 1 FROM unsure WHERE event_id = '$late'").fetchone(), said)
Session.lost = None
acct.outbox.put(("!room", "$late", "$own", "Neskoro", "", [], ""))
acct.send_outbox(rooms2)
check("the same event delivered again is not sent again", len(acct.edu.session.posts) == 1, acct.edu.session.posts)
db.execute("UPDATE unsure SET at = '2020-01-01 00:00:00' WHERE event_id = '$late'")
rooms2.settle_unsure()
check("not seen in time: said", said == ["Táto správa neodišla do EduPage. Skús to znova alebo odpovedz na edupage.org."], said)
paths = []
b.matrix = lambda method, path, body=None, **k: paths.append(path) or events.append(((body or {}).get("status"), (body or {}).get("m.relates_to", {}).get("event_id"))) or {"event_id": "$x"}
now = b.datetime.now(b.LOCAL).strftime("%Y-%m-%d %H:%M:%S")
check("seen later after all: linked, not posted again",
      Rooms2(db).sync([{"timelineid": "71", "typ": "sprava", "reakcia_na": "14", "vlastnik": ME, "text": "Neskoro", "cas_pridania": now}], "skola", ME) == 0
      and db.execute("SELECT event_id FROM items WHERE id = 71").fetchone() == ("$late",), paths)
check("…its ✓ comes and the early „neodišla“ is taken back", ("SUCCESS", "$late") in events and any("/redact/%24notice1/" in p_ or "/redact/$notice1/" in p_ for p_ in paths)
      and not db.execute("SELECT 1 FROM unsure WHERE event_id = '$late'").fetchall(), (events, paths))
Session.lost = None

# The homeserver refuses the redaction once: the notice is taken back after the next poll.
said.clear()
acct.edu = Edu()
Session.lost = 504
acct.outbox.put(("!room", "$late2", "$own", "Ešte neskôr", "", [], ""))
acct.send_outbox(rooms2)
Session.lost = None
db.execute("UPDATE unsure SET at = '2020-01-01 00:00:00' WHERE event_id = '$late2'")
rooms2.settle_unsure()
paths.clear()
def refusing(method, path, body=None, **k):
    paths.append(path)
    if "/redact/" in path:
        raise b.urllib.error.URLError("homeserver away")
    return {"event_id": "$x"}
b.matrix = refusing
Rooms2(db).sync([{"timelineid": "72", "typ": "sprava", "reakcia_na": "14", "vlastnik": ME, "text": "Ešte neskôr", "cas_pridania": now}], "skola", ME)
check("a refused redaction is kept to try again", db.execute("SELECT notice FROM unsure WHERE event_id = '$late2'").fetchone() == (f"$notice{len(said)}",), paths)
paths.clear()
b.matrix = lambda method, path, body=None, **k: paths.append(path) or {"event_id": "$x"}
rooms2.settle_unsure()
check("…and taken back after the next poll, without saying „neodišla“ again", any("/redact/" in p_ for p_ in paths) and len(said) == 1
      and not db.execute("SELECT 1 FROM unsure WHERE event_id = '$late2'").fetchone(), (paths, said))
db.execute("INSERT INTO unsure VALUES ('$late', '!room', '2020-01-01 00:00:00', '$n')")  # linked, its redaction still due
Rooms2(db)
check("a linked send's pending redaction survives a restart's cleanup", db.execute("SELECT 1 FROM unsure WHERE event_id = '$late'").fetchone())
db.execute("DELETE FROM unsure")

# The homeserver takes the "neodišla" but its answer is lost: the retry after the next poll is the same notice.
class Rooms3(b.Rooms):
    def school_room(self): return ("!room", "@edupage_school:test")
    def join(self, room, mxid): pass


acct.edu = Edu()
Session.lost = 504
acct.outbox.put(("!room", "$twice", "$own", "Dvakrát", "", [], ""))
acct.send_outbox(rooms)
Session.lost = None
db.execute("UPDATE unsure SET at = '2020-01-01 00:00:00' WHERE event_id = '$twice'")
txns = []
def lost_answer(method, path, body=None, **k):
    txns.append(path)
    if len(txns) == 1:
        raise b.urllib.error.URLError("answer lost")
    return {"event_id": "$said"}
b.matrix = lost_answer
for _ in range(2):
    try:
        Rooms3(db).settle_unsure()
    except b.urllib.error.URLError:
        pass
check("a notice whose answer was lost is sent again as the same transaction", len(txns) == 2 and txns[0] == txns[1]
      and db.execute("SELECT notice FROM unsure WHERE event_id = '$twice'").fetchone() == ("$said",), txns)
db.execute("DELETE FROM unsure")

# The "neodišla" reached the room but its answer was lost, and the very next poll finds the reply: the notice is found
# by its own transaction and taken back.
acct.edu = Edu()
Session.lost = 504
acct.outbox.put(("!room", "$quick", "$own", "Hneď", "", [], ""))
acct.send_outbox(rooms)
Session.lost = None
db.execute("UPDATE unsure SET at = '2020-01-01 00:00:00' WHERE event_id = '$quick'")
calls = []
def notice_kept(method, path, body=None, **k):
    calls.append(path)
    if len(calls) == 1:
        raise b.urllib.error.URLError("answer lost")
    return {"event_id": "$said-quick"}
b.matrix = notice_kept
try:
    Rooms3(db).settle_unsure()
except b.urllib.error.URLError:
    pass
now = b.datetime.now(b.LOCAL).strftime("%Y-%m-%d %H:%M:%S")
Rooms3(db).sync([{"timelineid": "73", "typ": "sprava", "reakcia_na": "14", "vlastnik": ME, "text": "Hneď", "cas_pridania": now}], "skola", ME)
check("a notice whose answer was lost is still taken back when the reply shows up next",
      calls[0].split("/send/")[-1] == next(c for c in calls[1:] if "/m.room.message/" in c).split("/send/")[-1]
      and any("/redact/%24said-quick/" in c for c in calls) and not db.execute("SELECT 1 FROM unsure WHERE event_id = '$quick'").fetchone(), calls)
db.execute("DELETE FROM unsure")

# The bridge stops while EduPage is answering: after the restart the same event is not sent again, and the poll that
# finds the reply links it with its ✓ and says nothing.
class Crash(BaseException): pass


said.clear()
events.clear()
b.matrix = lambda method, path, body=None, **k: events.append(((body or {}).get("status"), (body or {}).get("m.relates_to", {}).get("event_id"))) or {"event_id": "$x"}
acct.edu = Edu()
Session.lost = Crash()
acct.outbox.put(("!room", "$crash", "$own", "Pri páde", "", [], ""))
try:
    acct.send_outbox(rooms2)
    check("a crash during the send stops the bridge", False, "no crash")
except Crash:
    pass
Session.lost = None
rooms4 = Rooms2(db)  # the restart
check("a crash during the send leaves it pending through the restart",
      db.execute("SELECT 1 FROM unnamed WHERE event_id = '$crash'").fetchone() and db.execute("SELECT 1 FROM unsure WHERE event_id = '$crash'").fetchone())
acct.edu = Edu()
acct.outbox.put(("!room", "$crash", "$own", "Pri páde", "", [], ""))
acct.send_outbox(rooms4)
check("…the event delivered again is not sent again", not acct.edu.session.posts, acct.edu.session.posts)
now = b.datetime.now(b.LOCAL).strftime("%Y-%m-%d %H:%M:%S")
check("…and the poll links it with a ✓, saying nothing",
      rooms4.sync([{"timelineid": "74", "typ": "sprava", "reakcia_na": "14", "vlastnik": ME, "text": "Pri páde", "cas_pridania": now}], "skola", ME) == 0
      and db.execute("SELECT event_id FROM items WHERE id = 74").fetchone() == ("$crash",) and ("SUCCESS", "$crash") in events and not said
      and not db.execute("SELECT 1 FROM unsure WHERE event_id = '$crash'").fetchall(), (events, said))
acct.edu = Edu()
Session.answer = {"changes": [{"timelineid": "75"}]}
acct.outbox.put(("!room", "$fine", "$own", "Normálne", "", [], ""))
acct.send_outbox(rooms4)
check("a send EduPage names leaves nothing pending",
      db.execute("SELECT event_id FROM items WHERE id = 75").fetchone() == ("$fine",)
      and not db.execute("SELECT 1 FROM unnamed WHERE event_id = '$fine' UNION ALL SELECT 1 FROM unsure WHERE event_id = '$fine'").fetchall())

# EduPage answers without a status and the tab cannot be read to look: not known either way, so the poll decides.
said.clear()
events.clear()
acct.edu = Edu()
Session.answer, Session.tab_lost = {"changes": []}, b.requests.ReadTimeout("read timed out")
acct.outbox.put(("!room", "$mute", "$own", "Bez stavu", "", [], ""))
acct.send_outbox(rooms4)
Session.tab_lost = None
check("no status and the tab not read: nothing said, pending",
      not said and db.execute("SELECT 1 FROM unsure WHERE event_id = '$mute'").fetchone()
      and db.execute("SELECT 1 FROM unnamed WHERE event_id = '$mute'").fetchone(), said)
Session.answer, Session.tab = {"changes": []}, []
acct.edu = Edu()
acct.outbox.put(("!room", "$nothing", "$own", "Nič", "", [], ""))
acct.send_outbox(rooms4)
check("no status and not in the tab yet: nothing said, pending (EduPage may show it later)", not said
      and db.execute("SELECT 1 FROM unnamed WHERE event_id = '$nothing'").fetchone()
      and db.execute("SELECT 1 FROM unsure WHERE event_id = '$nothing'").fetchone(), said)
now = b.datetime.now(b.LOCAL).strftime("%Y-%m-%d %H:%M:%S")
check("…shown by the next poll: linked with a ✓, not posted again",
      rooms4.sync([{"timelineid": "77", "typ": "sprava", "reakcia_na": "14", "vlastnik": ME, "text": "Nič", "cas_pridania": now}], "skola", ME) == 0
      and db.execute("SELECT event_id FROM items WHERE id = 77").fetchone() == ("$nothing",) and ("SUCCESS", "$nothing") in events and not said, (events, said))

# A send that surely failed is said with settle_unsure's own transaction: if its rows outlive it, no second notice.
class TxnRooms(Rooms2):
    def say(self, room, text, answers="", txn=""):
        said.append((text, txn))
        return "$t"


said.clear()
acct.edu = Edu()
Session.lost = b.requests.ConnectTimeout("no route")
acct.outbox.put(("!room", "$sure", "$own", "Isto nie", "", [], ""))
acct.send_outbox(TxnRooms(db))
Session.lost = None
check("a sure failure is said with the one transaction settle_unsure would use", said == [(b.NOT_SENT, b.unsure_txn("$sure"))], said)

# The database refuses even the pending rows (locked): nothing goes out and Karchi is told.
class LockedDB:
    def __init__(self, real): self.real = real
    def execute(self, *a): return self.real.execute(*a)
    def commit(self): raise sqlite3.OperationalError("database is locked")
    def rollback(self): self.real.rollback()


said.clear()
locked_rooms = Rooms2(db)
locked_rooms.db = LockedDB(db)
acct.edu = Edu()
acct.outbox.put(("!room", "$nodb", "$own", "Bez databázy", "", [], ""))
acct.send_outbox(locked_rooms)
check("pending rows refused: nothing sent, „neodišla“ said, nothing left", not acct.edu.session.posts and len(said) == 1 and "neodišla" in said[0]
      and not db.execute("SELECT 1 FROM unnamed WHERE event_id = '$nodb' UNION ALL SELECT 1 FROM unsure WHERE event_id = '$nodb'").fetchall(),
      (acct.edu.session.posts, said))

# EduPage named it but writing that down failed (a locked database): nothing false is said and the poll links it.
class Locked(Rooms2):
    def mark_sent(self, item_id, root, event_id): raise sqlite3.OperationalError("database is locked")


said.clear()
events.clear()
acct.edu = Edu()
Session.answer = {"changes": [{"timelineid": "76"}]}
acct.outbox.put(("!room", "$locked", "$own", "Zamknuté", "", [], ""))
acct.send_outbox(Locked(db))
check("named but not recorded: nothing said, still pending", not said
      and db.execute("SELECT 1 FROM unnamed WHERE event_id = '$locked'").fetchone()
      and db.execute("SELECT 1 FROM unsure WHERE event_id = '$locked'").fetchone(), said)
now = b.datetime.now(b.LOCAL).strftime("%Y-%m-%d %H:%M:%S")
check("…and the poll links it with a ✓, not posting it again",
      rooms4.sync([{"timelineid": "76", "typ": "sprava", "reakcia_na": "14", "vlastnik": ME, "text": "Zamknuté", "cas_pridania": now}], "skola", ME) == 0
      and db.execute("SELECT event_id FROM items WHERE id = 76").fetchone() == ("$locked",) and ("SUCCESS", "$locked") in events and not said, (events, said))
db.execute("DELETE FROM unsure")

old = sqlite3.connect(":memory:")
old.execute("CREATE TABLE unsure (event_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, at TEXT NOT NULL)")
old.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, root INTEGER NOT NULL, event_id TEXT NOT NULL)")
Rooms(old)
check("the first deployed unsure table gets its notice column", "notice" in {r[1] for r in old.execute("PRAGMA table_info(unsure)")})

print("FAILS:", fails)
sys.exit(1 if fails else 0)

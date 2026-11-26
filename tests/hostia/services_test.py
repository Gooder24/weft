"""Links, the plan judge and „píše…“ answer every person of the server, each only about their own:
python3 -I tests/hostia/services_test.py"""
import importlib.util, json, os, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import Server, call, ok, done, free_port
from services_test_lib import load, serve

class FakeModel(BaseHTTPRequestHandler):
    asked, delay = 0, 0
    def log_message(self, *a): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        FakeModel.asked += 1
        time.sleep(FakeModel.delay)
        body = json.dumps({"choices": [{"message": {"content": json.dumps({"plan": True, "title": "Tréning"})}}]}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)


with Server() as hs:
    common = {"APPSERVICE_DIR": str(hs.appservices), "OWNER": hs.owner[0]}

    # ---- links
    links = load("links", "server/links/links.py", {**common, "LINKS_HS": hs.url, "LINKS_OWNER": hs.owner[0]})
    fetched = []
    def fake(url, cap=None, accept=None, connect=None):
        fetched.append(url)
        return url, 200, "text/html", b'<html><head><meta property="og:title" content="Titulok"><meta property="og:image" content="https://example.org/a.png"></head></html>'
    links.READER = links.Reader(fetcher=fake)
    port = serve(links)
    res = lambda who, u="https://example.org/x": call("GET", f"http://127.0.0.1:{port}/_links/resolve?url={u}", token=who)
    s, b = res(hs.anna[1])
    ok("links: anna gets a card", s == 200 and b.get("title") == "Titulok", (s, b))
    n = len(fetched)
    s, b = res(hs.boris[1])
    ok("links: boris's card is read for him, not taken from anna's", s == 200 and len(fetched) == n + 1, (len(fetched), n))
    s, b = res(hs.anna[1])
    ok("links: anna's second ask comes from her cache", len(fetched) == n + 1, len(fetched))
    s, _ = call("GET", f"http://127.0.0.1:{port}/_links/image?url=https://example.org/a.png", token=hs.owner[1])
    ok("links: the owner may not fetch an image only friends' cards named", s == 404, s)
    s, _ = res(hs.puppet[1] + "x")
    ok("links: a bad token gets nothing", s == 401, s)
    ghost_tok = call("POST", f"{hs.url}/_matrix/client/v3/login", {"type": "m.login.application_service", "identifier": {"type": "m.id.user", "user": "net_ghost"}}, token=hs.as_token)[1].get("access_token")
    s, _ = res(ghost_tok) if ghost_tok else (401, None)
    ok("links: a bridge's ghost gets nothing", s == 401, s)
    same = [res(hs.boris[1], f"https://same.org/{i}")[1].get("status") for i in range(9)]
    ok("links: a friend's links of one site never limit the owner's of it", same.count("limited") >= 1 and res(hs.owner[1], "https://same.org/owner")[1].get("status") == "ok", same)
    many = [res(hs.boris[1], f"https://ex{i}.org/")[1].get("status") for i in range(12)]
    ok("links: one friend cannot use up the reading of all", many.count("limited") >= 2 and res(hs.owner[1], "https://owner.org/o")[1].get("status") == "ok", many)

    import urllib.request
    r = urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/_links/resolve?url=https://example.org/x", headers={"Authorization": f"Bearer {hs.anna[1]}"}))
    ok("links: answers vary by account, so a shared browser never shows one account another's", r.headers.get("Vary") == "Authorization")

    imgs = {"a": "https://i.org/x.png", "b": "https://i.org/y.png", "c": "https://i.org/x.png", "d": "https://i.org/z.png"}
    def pic(url, cap=None, accept=None, connect=None):
        return url, 200, "text/html", f'<meta property="og:title" content="t"><meta property="og:image" content="{imgs[url.rstrip("/").rsplit("/", 1)[-1]]}">'.encode()
    keep, links.CACHE_MAX = links.CACHE_MAX, 2
    r = links.Reader(fetcher=pic)
    for k in "abcd": r.get(f"https://p.org/{k}")
    links.CACHE_MAX = keep
    ok("links: an image a new card names again stays allowed", r.image_ok("https://i.org/x.png") and not r.image_ok("https://i.org/y.png"))

    # ---- the plan judge
    mport = free_port()
    threading.Thread(target=ThreadingHTTPServer(("127.0.0.1", mport), FakeModel).serve_forever, daemon=True).start()
    when = load("judge", "server/when/judge.py", {**common, "WHEN_HS": hs.url, "WHEN_LLM": f"http://127.0.0.1:{mport}", "WHEN_STATE": str(hs.base / "when")})
    when.JUDGE = when.Judge()
    port = serve(when)
    judge = lambda who, t="zajtra o 17:00 tréning": call("POST", f"http://127.0.0.1:{port}/_when/judge", {"text": t, "when": "2026-11-27T17:00"}, token=who)
    s, b = judge(hs.anna[1])
    ok("when: anna gets a verdict", s == 200 and b.get("plan") is True, (s, b))
    before = FakeModel.asked
    s, b = judge(hs.boris[1])
    ok("when: boris's same text is judged for him, not answered from anna's verdict", s == 200 and FakeModel.asked == before + 1, FakeModel.asked)
    s, b = judge(hs.owner[1])
    ok("when: the owner's too", s == 200 and FakeModel.asked == before + 2, FakeModel.asked)
    s, b = judge(hs.owner[1])
    ok("when: the owner's second ask comes from his kept verdict", s == 200 and FakeModel.asked == before + 2, FakeModel.asked)
    s, _ = judge("nope")
    ok("when: a bad token gets nothing", s == 401, s)
    # A slow model (7–12 s on asus): friends' questions never make the owner's wait past his limit.
    FakeModel.delay = 1.5
    when.WAIT = 2.5
    results = {}
    def ask_as(name, who, t):
        results[name] = judge(who, t)[0]
    threads = [threading.Thread(target=ask_as, args=(f"b{i}", hs.boris[1], f"piatok {i} o 18:00")) for i in range(4)]
    for t in threads: t.start()
    time.sleep(0.2)
    ask_as("owner", hs.owner[1], "sobota o 9:00 výlet")
    for t in threads: t.join()
    ok("when: the owner is answered while a friend's questions are asked", results["owner"] == 200, results)
    ok("when: only one friend question at a time reaches the model", sum(1 for k, v in results.items() if k != "owner" and v == 200) <= 1, results)
    FakeModel.delay = 0
    when.PER_MINUTE, when.JUDGE.asked = 3, []
    friend = [judge(hs.anna[1], f"nedeľa {i} o 10:00")[0] for i in range(3)]
    ok("when: friends' questions never use up the owner's minute", friend == [200, 200, 503] and judge(hs.owner[1], "pondelok o 8:00 test")[0] == 200, friend)

    # ---- „píše…“
    typing = load("seen", "server/typing/seen.py", {**common, "TYPING_HS": hs.url, "TYPING_OWNER": hs.owner[0]})
    typing.WAIT = 1.0
    port = serve(typing)
    line = lambda user, room: f'INF Sent typing event portal_mxid="{room}" user_id="{user}" typing=true'
    ok("typing: a guest bridge's line names its person", typing.parse(line(hs.anna[0], "!a:weft.test"))[:2] == (hs.anna[0], "!a:weft.test"))
    def later():
        time.sleep(0.2)
        typing.REPORTS.add(*typing.parse(line(hs.anna[0], "!r:weft.test")), "whatsapp")
    threading.Thread(target=later).start()
    s, b = call("GET", f"http://127.0.0.1:{port}/_typing/wait?room=!r:weft.test", token=hs.anna[1])
    ok("typing: anna hears about her own typing", s == 200 and b.get("state") == "shown", (s, b))
    s, b = call("GET", f"http://127.0.0.1:{port}/_typing/wait?room=!r:weft.test", token=hs.owner[1])
    ok("typing: the owner hears nothing about anna's", s == 200 and b.get("state") == "unknown", (s, b))
    s, b = call("GET", f"http://127.0.0.1:{port}/_typing/wait?room=!r:weft.test", token=hs.boris[1])
    ok("typing: nor does boris", s == 200 and b.get("state") == "unknown", (s, b))
    s, _ = call("GET", f"http://127.0.0.1:{port}/_typing/wait?room=!r:weft.test", token="nope")
    ok("typing: a bad token gets nothing", s == 401, s)
    ok("typing: guest bridges are followed", "matrix-spike-whatsapp-guests" in typing.UNITS)

# ---- who is a person, and their folders (no server needed)
import tempfile
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "server", "common"))
import weft_users, public_net
d = tempfile.mkdtemp()
with open(os.path.join(d, "a.yaml"), "w") as f:
    f.write("id: a\nsender_localpart: abot\nnamespaces:\n  users:\n  - exclusive: true\n    regex: '@ab_.*:x\\.test'\n")
u = weft_users.Users("http://unused", "@owner:x.test", appservice_dir=d)
ok("people: exclusive written before regex still owns its puppets", not u.human("@ab_1:x.test") and not u.human("@abot:x.test") and u.human("@ann:x.test"))
for name, text in (("broken.yaml", "id: [unclosed"), ("list.yaml", "- a\n- b\n"), ("odd.yaml", "namespaces:\n  users: ['@x_.*']\n")):
    with open(os.path.join(d, name), "w") as f: f.write(text)
with open(os.path.join(d, "latin.yaml"), "wb") as f: f.write(b"id: \xff\xfe\n")
ok("people: a file that is no registration is skipped, the others still count", not u.human("@ab_2:x.test") and u.human("@ann2:x.test"))
ok("people: any localpart the homeserver registers is a person", u.human("@.alice:x.test") and u.human("@alice+qa:x.test"))
base = tempfile.mkdtemp()
folders = {weft_users.home(base, f"@{lp}:x.test", "@owner:x.test") for lp in (".alice", "alice+qa", "..", "alice")}
ok("people: every localpart has its own folder inside users/", len(folders) == 4 and all(os.path.dirname(f) == os.path.join(base, "users") for f in folders), folders)

# ---- downloads reach only the internet, also when a name changes its answer between check and connection
import socket
real = socket.getaddrinfo
answers = iter([[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", 443))], [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]])
socket.getaddrinfo = lambda *a, **k: next(answers)
kal = load("kalendar", "server/calendar/kalendar.py", {"OWNER": "@owner:x.test"})
try:
    try: kal.fetch_ics("https://rebind.example/cal.ics"); refused = False  # checked public, then asus at the connection
    except ValueError: refused = True
    except Exception as e: refused = "not on the internet" in str(e)  # urllib wraps it
finally:
    socket.getaddrinfo = real
ok("downloads: a name that turns into asus's own address is refused at the connection", refused is True)
tried = []
class FakeSocket:
    def __init__(self, family=None, *a):
        if family == socket.AF_INET6: raise OSError(97, "Address family not supported")
    def settimeout(self, t): pass
    def close(self): pass
    def connect(self, addr):
        tried.append(addr[0])
        if addr[0] == "93.184.215.14": raise OSError("unreachable")
two = [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:2800:21f:cb07:6820:80da:af6b:8b2c", 443, 0, 0)), (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", 443)), (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.15", 443))]
real_socket, socket.getaddrinfo, socket.socket = socket.socket, lambda *a, **k: two, FakeSocket
try: got = public_net.public_socket("two.example", 443, 2)
finally: socket.getaddrinfo, socket.socket = real, real_socket
ok("downloads: when one checked address does not answer, the next one is tried", isinstance(got, FakeSocket) and tried == ["93.184.215.14", "93.184.215.15"], tried)
done()

"""Links, the plan judge and „píše…“ answer every person of the server, each only about their own:
python3 -I tests/hostia/services_test.py"""
import importlib.util, json, os, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import Server, call, ok, done, free_port

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


def load(name, path, env):
    os.environ.update(env)
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def serve(mod):
    port = free_port()
    srv = ThreadingHTTPServer(("127.0.0.1", port), mod.Api)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return port


class FakeModel(BaseHTTPRequestHandler):
    asked = 0
    def log_message(self, *a): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        FakeModel.asked += 1
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
    many = [res(hs.boris[1], f"https://ex{i}.org/")[1].get("status") for i in range(12)]
    ok("links: one friend cannot use up the reading of all", many.count("limited") >= 2 and res(hs.owner[1], "https://owner.org/o")[1].get("status") == "ok", many)

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
done()

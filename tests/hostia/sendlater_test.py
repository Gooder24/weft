"""Send later sends every person's scheduled messages as that person, once they said hello:
python3 -I tests/hostia/sendlater_test.py"""
import os, sys, time, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import Server, call, ok, done

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
q = lambda s: urllib.parse.quote(s, safe="")


def until(check, seconds=20):
    end = time.time() + seconds
    while time.time() < end:
        got = check()
        if got: return got
        time.sleep(0.3)
    return check()


with Server() as hs:
    mx = lambda m, p, b=None, t=None: call(m, f"{hs.url}/_matrix/client/v3{p}", b, token=t)
    rooms = {}
    for name, (user, token) in (("anna", hs.anna), ("boris", hs.boris), ("owner", hs.owner)):
        rooms[name] = mx("POST", "/createRoom", {"name": name}, token)[1]["room_id"]
    def schedule(who, room, text):
        user, token = who
        item = {"id": f"t-{text}", "room": room, "at": int(time.time() * 1000) - 1000, "content": {"msgtype": "m.text", "body": text}}
        return mx("PUT", f"/user/{q(user)}/account_data/sk.karchi.sendlater", {"items": [item]}, token)[0]
    def said(room, token, text):
        s, b = mx("GET", f"/rooms/{q(room)}/messages?dir=b&limit=20", None, token)
        return next((e["sender"] for e in b.get("chunk", []) if e.get("type") == "m.room.message" and e["content"].get("body") == text), None)
    def item(who):
        s, b = mx("GET", f"/user/{q(who[0])}/account_data/sk.karchi.sendlater", None, who[1])
        return (b.get("items") or [{}])[0]

    ok("scheduling works", all(schedule(w, rooms[n], n) == 200 for n, w in (("anna", hs.anna), ("boris", hs.boris), ("owner", hs.owner))))
    folder = hs.base / "sendlater"; folder.mkdir()
    (folder / "token").write_text(hs.owner[1]); (folder / "dp").write_text(hs.dp_token)
    port = hs.service(["python3", "-u", os.path.join(ROOT, "server/sendlater/sendlater.py")],
                      {"TOKEN_FILE": str(folder / "token"), "DOUBLEPUPPET_TOKEN_FILE": str(folder / "dp"), "PEOPLE_FILE": str(folder / "people.json")})
    ok("the owner's message goes as him", until(lambda: said(rooms["owner"], hs.owner[1], "owner")) == hs.owner[0])
    ok("anna's waits until her Weft says hello", said(rooms["anna"], hs.anna[1], "anna") is None)
    hello = lambda token: call("POST", f"http://127.0.0.1:{port}/_sendlater/hello", {}, token=token)[0]
    ok("a bad token gets no hello", hello("nope") == 401)
    ok("anna says hello", hello(hs.anna[1]) == 200)
    ok("anna's message goes as anna", until(lambda: said(rooms["anna"], hs.anna[1], "anna")) == hs.anna[0])
    ok("and is marked sent in her list", until(lambda: item(hs.anna).get("sent")))
    (folder / "dp").chmod(0)
    ok("a hello the service cannot act on is refused, not swallowed", hello(hs.boris[1]) == 503)
    (folder / "dp").chmod(0o600)
    ok("boris's still waits", said(rooms["boris"], hs.boris[1], "boris") is None and not item(hs.boris).get("sent"))
    ok("anna is kept for the next start", "anna" in (folder / "people.json").read_text() and oct((folder / "people.json").stat().st_mode & 0o777) == "0o600")
    ok("the owner is not listed among the others", hello(hs.owner[1]) == 200 and hs.owner[0] not in (folder / "people.json").read_text())
    ok("boris's next hello works", hello(hs.boris[1]) == 200)
    ok("and his message goes as boris", until(lambda: said(rooms["boris"], hs.boris[1], "boris")) == hs.boris[0])
    # A later item of anna's after a restart of the service: she is watched again without a new hello.
    hs.procs[-1].terminate(); hs.procs[-1].wait(10)
    mx("PUT", f"/user/{q(hs.anna[0])}/account_data/sk.karchi.sendlater", {"items": [{"id": "t-again", "room": rooms["anna"], "at": int(time.time() * 1000), "content": {"msgtype": "m.text", "body": "again"}}]}, hs.anna[1])
    hs.service(["python3", "-u", os.path.join(ROOT, "server/sendlater/sendlater.py")],
               {"TOKEN_FILE": str(folder / "token"), "DOUBLEPUPPET_TOKEN_FILE": str(folder / "dp"), "PEOPLE_FILE": str(folder / "people.json")}, port=port)
    ok("after a restart anna's next message still goes", until(lambda: said(rooms["anna"], hs.anna[1], "again")) == hs.anna[0])
done()

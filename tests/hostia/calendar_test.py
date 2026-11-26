"""Each person of the server has a calendar of their own: python3 -I tests/hostia/calendar_test.py"""
import http.client, os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import Server, call, ok, done

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")

with Server() as hs:
    data = tempfile.mkdtemp(prefix="cal-", dir=hs.base)
    port = hs.service(["python3", "-I", "-u", os.path.join(ROOT, "server/calendar/kalendar.py")], {"CALENDAR_DATA": data})
    url = f"http://127.0.0.1:{port}/_calendar"
    def doc(who, query=""): return call("GET", f"{url}/doc{query}", token=who)
    def ops(who, body, query=""): return call("POST", f"{url}/ops{query}", {"ops": body}, token=who)
    add = lambda cid, name: [{"op": "addcal", "cal": cid, "name": name, "color": "#89b4fa"}]
    event = lambda cid, uid: [{"op": "put", "cal": cid, "event": {"uid": uid, "title": "t", "start": "2026-11-27T10:00:00Z", "end": "2026-11-27T11:00:00Z"}}]

    s, b = ops(hs.anna[1], add("a", "Annin") + event("a", "a1"))
    ok("anna adds a calendar", s == 200, b)
    s, b = ops(hs.owner[1], add("k", "Karchiho"))
    ok("the owner adds one", s == 200, b)
    s, b = doc(hs.anna[1])
    ok("anna sees only hers", s == 200 and [c["id"] for c in b["doc"]["calendars"]] == ["a"], b)
    s, b = doc(hs.boris[1])
    ok("boris has none", s == 200 and b["doc"] is None, b)
    s, b = doc(hs.owner[1])
    ok("the owner sees only his", s == 200 and [c["id"] for c in b["doc"]["calendars"]] == ["k"], b)
    s, b = ops(hs.boris[1], [{"op": "del", "cal": "a", "uid": "a1"}])
    ok("boris cannot touch anna's event", s == 400 or (s == 200 and not any(c["id"] == "a" for c in b["doc"]["calendars"])), (s, b))
    s, b = doc(hs.anna[1])
    ok("anna's event is still there", s == 200 and b["doc"]["calendars"][0]["events"][0]["uid"] == "a1", b)
    ok("the owner's file stays where it was", os.path.exists(os.path.join(data, "calendars.json")))
    ok("anna's file is under users/anna", os.path.exists(os.path.join(data, "users", "anna", "calendars.json")))
    ok("anna's folder is hers only", oct(os.stat(os.path.join(data, "users", "anna")).st_mode & 0o777) == "0o700")

    s, b = doc(hs.puppet[1], f"?user_id={hs.puppet[2]}")
    ok("a bridge's ghost has no calendar", s == 401, (s, b))
    s, b = doc("not-a-token")
    ok("a bad token gets nothing", s == 401, (s, b))
    s, b = doc(None)
    ok("no token gets nothing", s == 401, (s, b))
    s, b = doc(hs.dp_token, f"?user_id={hs.anna[0]}")
    ok("the double puppet acting as anna gets anna's", s == 200 and b["doc"]["calendars"][0]["id"] == "a", (s, b))
    s, b = doc(hs.dp_token, f"?user_id={hs.owner[0]}")
    ok("the double puppet acting as the owner gets his", s == 200 and b["doc"]["calendars"][0]["id"] == "k", (s, b))

    codes = [call("GET", f"{url}/fetch?url=http://127.0.0.1/x.ics", token=hs.boris[1])[0] for _ in range(61)]
    ok("a friend's .ics downloads are limited", codes[:60] == [400] * 60 and codes[60] == 429, codes[-3:])
    codes = [call("GET", f"{url}/fetch?url=http://127.0.0.1/x.ics", token=hs.owner[1])[0] for _ in range(61)]
    ok("the owner's are not", set(codes) == {400}, set(codes))
    # Only the headers: the service answers before reading what is too large.
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    c.putrequest("POST", "/_calendar/ops"); c.putheader("Authorization", f"Bearer {hs.anna[1]}")
    c.putheader("Content-Length", str(21 * 1024 * 1024)); c.endheaders()
    s = c.getresponse().status; c.close()
    ok("a friend's request has a size limit", s == 413, s)
done()

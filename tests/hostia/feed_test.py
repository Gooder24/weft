"""Each person of the server has a feed of their own (sources, reading windows, Instagram session):
python3 -I tests/hostia/feed_test.py"""
import os, sys, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import Server, call, ok, done
from services_test_lib import load, serve

with Server() as hs:
    data = str(hs.base / "feed")
    feed = load("feed", "server/feed/feed.py", {"APPSERVICE_DIR": str(hs.appservices), "OWNER": hs.owner[0], "HS": hs.url,
                                                 "FEED_DATA": data, "FEED_INSTAGRAM_PAUSED": "0"})
    feed.resolve_source = lambda url, name: {"url": url, "name": name or url, "kind": "rss"}
    port = serve(feed)
    url = f"http://127.0.0.1:{port}/_feed"
    doc = lambda who: call("GET", f"{url}/doc", token=who)
    post = lambda who, path, body={}: call("POST", f"{url}/{path}", body, token=who)
    account = lambda who, user: call("GET", f"{hs.url}/_matrix/client/v3/user/{urllib.parse.quote(user)}/account_data/sk.karchi.window", token=who)

    s, b = post(hs.anna[1], "settings", {"sources": [{"url": "https://example.org/anna.xml", "name": "Annin blog"}]})
    ok("feed: anna adds a source", s == 200 and [x["name"] for x in b["settings"]["sources"]] == ["Annin blog"], (s, b))
    s, b = doc(hs.boris[1])
    ok("feed: boris has no sources", s == 200 and b["settings"]["sources"] == [], b.get("settings"))
    s, b = doc(hs.owner[1])
    ok("feed: nor has the owner", s == 200 and b["settings"]["sources"] == [], b.get("settings"))
    s, b = post(hs.anna[1], "policy", {"count": 5, "minutes": 20})
    ok("feed: anna sets her windows", s == 200 and b["policy"]["next"]["count"] == 5, b.get("policy"))
    s, b = doc(hs.owner[1])
    ok("feed: the owner's windows stay his", b["policy"].get("next") is None, b.get("policy"))
    s, b = post(hs.anna[1], "window")
    ok("feed: anna opens a window", s == 200 and b["access"] is True, (s, b.get("access")))
    s, b = doc(hs.boris[1])
    ok("feed: boris's stays closed", s == 200 and b["access"] is False and not (b["window"] or {}).get("start"), b.get("window"))
    s, b = account(hs.anna[1], hs.anna[0])
    ok("feed: anna's window reaches her own account data", s == 200 and b.get("start"), (s, b))
    s, b = account(hs.owner[1], hs.owner[0])
    ok("feed: nothing reached the owner's", s == 404, (s, b))
    s, b = post(hs.boris[1], "refresh")
    ok("feed: boris cannot collect without his own window", s == 403, s)

    class FakeInstagram:  # never Instagram itself: it answers that the cookies are account 1's
        def __init__(self, cookies=None): self.cookies = cookies
        def request(self, path): return {"user": {"pk": 1}}
    feed.Instagram = FakeInstagram
    s, b = post(hs.anna[1], "instagram/connect", {"cookies": {"sessionid": "x", "csrftoken": "y", "ds_user_id": "1"}})
    ok("feed: anna's Instagram session is kept in her folder", s == 200 and b["instagramConnected"] and os.path.exists(os.path.join(data, "users", "anna", "instagram-session.json")), (s, b.get("instagramConnected")))
    s, b = doc(hs.owner[1])
    ok("feed: the owner's Instagram is not anna's", not b["instagramConnected"] and not os.path.exists(os.path.join(data, "instagram-session.json")), b.get("instagramConnected"))
    s, b = doc(hs.boris[1])
    ok("feed: nor is boris's", not b["instagramConnected"], b.get("instagramConnected"))
    ok("feed: anna's files are under users/anna", os.path.exists(os.path.join(data, "users", "anna", "settings.json")))
    ok("feed: the owner's folder has none of anna's", not os.path.exists(os.path.join(data, "settings.json")) or "anna" not in open(os.path.join(data, "settings.json")).read())
    call("POST", f"{hs.url}/_matrix/client/v3/logout", {}, token=hs.boris[1])
    s, _ = doc(hs.boris[1])
    ok("feed: a logged-out token gets nothing at once", s == 401, s)
    s, _ = doc(hs.puppet[1] + "x")
    ok("feed: a bad token gets nothing", s == 401, s)
done()

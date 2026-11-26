#!/usr/bin/env python3
"""Weft's calendar on asus: the master copy of Kalendarix's calendars.json and the API Weft edits it through.

The file keeps Kalendarix's layout (docs/calendars-json.md in github.com/Gooder24/kalendarix-archive), so the
same data shows in Weft, in Kalendarix on x270 and in its desktop widget. Two ways in:

  HTTP on 127.0.0.1:29327 behind Caddy /_calendar/ (a Matrix token of any person of this server; each person has a
  calendars.json of their own: the owner's in data/, everyone else's in data/users/<localpart>/; the timetable
  mirror and the merge CLI are the owner's only):
    GET  /_calendar/doc            -> {"version", "doc"}  (doc is null until the first change or timetable round)
    POST /_calendar/ops {"ops": [...]}, applied all or nothing, each one of:
      {"op": "put", "cal": id, "event": {...}} | {"op": "del", "cal": id, "uid": uid}
      {"op": "addcal", "cal": id, "name": text, "color": "#rrggbb"[, "category", "autoAccent", "events": [...] (an
        imported .ics), "sourceUrl" (a subscription)]} | {"op": "updcal", "cal": id[, "name", "category", "color",
        "autoAccent"]} | {"op": "delcal", "cal": id}
      {"op": "accent", "cal": id, "key": titleKey, "color": "#rrggbb" | null}: the second colour of every event of
        that title (Kalendarix's calendar.accents), also in the timetable
      {"op": "addcat", "id", "name", "color"} | {"op": "updcat", "id"[, "name", "color"]} | {"op": "delcat", "id"}:
        categories of Karchi's own, with Kalendarix's rules (src/core/document.ts)
      {"op": "feed", "cal": id, "events": [...]}: a fresh download of a subscribed calendar in place of the last one
    Weft needs nothing else: without a file the first change starts one. addcal of an id that is there and delcal
    of one that is not change nothing, so a batch sent again after a lost answer does no harm.
  GET  /_calendar/fetch?url=<http(s) address> -> {"text"}: an .ics a subscription reads; the browser may not (CORS).
  CLI, for a computer that keeps its own calendars.json (x270 runs it over ssh, see x270/):
    kalendar.py merge < {"base": what it last wrote from here (or null), "local": its calendars.json}
    -> the merged file on stdout, which is now also the master. A three-way merge per calendar and per event,
    so an edit on either side survives and nothing is doubled; when both changed the same event differently,
    the computer's edit wins. The computer keeps the base itself and moves it on only once it has written the
    file, so a merge it could not write is merged again next time instead of reading as deletions.

  GET  /_calendar/doc?have=<version> -> {"version", "same": true} when nothing changed since that version.

Events a sync program owns (uid ending in @name, see isManaged) are not changed through the API. The EduPage
timetable is one: with TIMETABLE_URL set, the service itself keeps it in step with Kalendarix EduPage's backend
(see mirror_timetable).
"""
import fcntl, hashlib, json, os, re, sys, threading, time, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "common"))
import public_net, weft_users

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("CALENDAR_DATA", os.path.join(HERE, "data"))
MASTER = os.path.join(DATA, "calendars.json")
HS = os.environ.get("HS", "http://127.0.0.1:8008")
OWNER = os.environ.get("OWNER", "")  # the owner's Matrix ID, from ~/.config/weft/weft.env on asus; the HTTP service needs it
PORT = int(os.environ.get("PORT", "29327"))
MAX_OPS = 20 * 1024 * 1024  # one request of a person other than the owner: an imported .ics with years of events
MAX_DOC = int(os.environ.get("CALENDAR_MAX_DOC", 50 * 1024 * 1024))  # one person's calendars.json (not the owner's)


# ------------------------------------------------------------------ the file

class locked:
    """One writer at a time: the HTTP service and a merge from x270 may run together."""
    def __init__(self, folder=None):
        self.folder = folder or DATA
    def __enter__(self):
        os.makedirs(self.folder, exist_ok=True)
        self.f = open(os.path.join(self.folder, ".lock"), "w")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self
    def __exit__(self, *a):
        self.f.close()

def read(path):
    try:
        with open(path, encoding="utf-8") as f: return json.load(f)
    except FileNotFoundError: return None

def dump(doc):
    return json.dumps(doc, ensure_ascii=False, indent=2)

def write(path, doc):
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f: f.write(dump(doc))
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)

def empty():
    """A calendars.json with nothing in it yet, in Kalendarix's current schema."""
    return {"schema": 2, "calendars": []}

def version(doc):
    return hashlib.sha1(dump(doc).encode()).hexdigest()[:12] if doc is not None else ""


# ------------------------------------------------------------------ merge

GONE = object()  # a field that is not there, as opposed to one that is null

def pick(b, l, m):
    """Three-way choice for one value; None (whole events) or GONE (fields) means absent."""
    if l == m: return l
    if l == b: return m
    if m == b: return l
    return l

def by_key(items, key):
    return {x[key]: x for x in items or [] if isinstance(x, dict) and key in x}

def merge(base, local, master):
    """Three-way merge of two calendars.json against their common base. Calendars merge field by field; an event
    whose uid is in one calendar on every side is one thing with a home calendar, so a move and an edit on
    different sides (or moves on both) end up as one event, each field picked on its own. A uid that some side
    keeps in several calendars (the same .ics imported twice) merges calendar by calendar. Conflicts: local wins."""
    base, local, master = base or {}, local or {}, master or {}
    local = timetable_from(local, master)
    out = {}
    for k in dict.fromkeys([*master, *local]):
        if k == "calendars": continue
        v = pick(base.get(k, GONE), local.get(k, GONE), master.get(k, GONE))
        if v is not GONE: out[k] = v
    bc, lc, mc = (by_key(d.get("calendars"), "id") for d in (base, local, master))
    meta = lambda c: {k: v for k, v in c.items() if k != "events"}

    def merged_meta(cid):
        # A side that removed the calendar changes nothing about its name or colour.
        mb = meta(bc[cid]) if cid in bc else {}
        ml = meta(lc[cid]) if cid in lc else mb
        mm = meta(mc[cid]) if cid in mc else mb
        cal = {}
        for k in dict.fromkeys([*mm, *ml]):
            v = pick(mb.get(k, GONE), ml.get(k, GONE), mm.get(k, GONE))
            if v is not GONE: cal[k] = v
        return cal

    order = list(dict.fromkeys([*mc, *lc]))
    kept = {cid: merged_meta(cid) for cid in order if pick(cid in bc, cid in lc, cid in mc)}
    placed = {cid: [] for cid in order}

    def place(cid, event, changed):
        # An event added or changed in a calendar the other side removed brings the calendar back.
        if cid not in kept:
            if not changed or cid not in placed: return
            kept[cid] = merged_meta(cid)
        placed[cid].append(event)

    def fields(be, le, me):
        event = {}
        for k in dict.fromkeys([*me, *le]):
            v = pick(be.get(k, GONE), le.get(k, GONE), me.get(k, GONE))
            if v is not GONE: event[k] = v
        return event

    def where(cals):
        found = {}
        for cid, c in cals.items():
            for e in c.get("events") or []:
                if isinstance(e, dict) and "uid" in e: found.setdefault(e["uid"], []).append((cid, e))
        return found
    bw, lw, mw = where(bc), where(lc), where(mc)
    single = lambda uid: all(len(w.get(uid, ())) <= 1 for w in (bw, lw, mw))
    uids = list(dict.fromkeys(e["uid"] for cals in (mc, lc) for c in cals.values() for e in c.get("events") or [] if isinstance(e, dict) and "uid" in e))
    for uid in uids:
        if single(uid):
            b, l, m = (w[uid][0] if uid in w else None for w in (bw, lw, mw))
            if l is None or m is None:
                r = pick(b, l, m)
                if r is not None: place(r[0], r[1], r != b)
                continue
            bh, be = b or (None, {})
            home = pick(bh, l[0], m[0])
            event = fields(be, l[1], m[1])
            place(home, event, b is None or (home, event) != b)
        else:
            # In several calendars somewhere (an .ics imported twice, or one uid twice in a calendar): each
            # calendar's copies pair up in order and merge field by field.
            for cid in order:
                bl, ll, ml = ([e for c2, e in w.get(uid, ()) if c2 == cid] for w in (bw, lw, mw))
                for n in range(max(len(ll), len(ml))):
                    be, le, me = (x[n] if n < len(x) else None for x in (bl, ll, ml))
                    e = fields(be or {}, le, me) if le is not None and me is not None else pick(be, le, me)
                    if e is not None: place(cid, e, e != be)
    # Events without a uid (none of Kalendarix's own) are told apart only by their content: each distinct one
    # is kept as many times as the three-way pick of its counts says.
    blob = lambda e: json.dumps(e, sort_keys=True, ensure_ascii=False)
    def plain(cals, cid):
        return [e for e in (cals.get(cid) or {}).get("events") or [] if not (isinstance(e, dict) and "uid" in e)]
    for cid in order:
        bl, ll, ml = (plain(cals, cid) for cals in (bc, lc, mc))
        count = lambda xs, x: sum(blob(y) == x for y in xs)
        for x in dict.fromkeys(blob(e) for e in (*ml, *ll)):
            e = json.loads(x)
            times = pick(count(bl, x), count(ll, x), count(ml, x))
            for _ in range(times): place(cid, e, times != count(bl, x))
    # Each calendar keeps the order the computer's file had (then Weft's), whatever order events were merged in;
    # the n-th copy of a uid (or of a uid-less event) takes the n-th place of its kind.
    def key_of(e, seen):
        k = e["uid"] if isinstance(e, dict) and "uid" in e else "\0" + blob(e)
        n = seen.get(k, 0)
        seen[k] = n + 1
        return (k, n)
    def rank(cid):
        pos = {}
        for cals in (lc, mc):
            seen = {}
            for e in (cals.get(cid) or {}).get("events") or []: pos.setdefault(key_of(e, seen), len(pos))
        return pos
    for cid in placed:
        pos, seen = rank(cid), {}
        keyed = [(pos.get(key_of(e, seen), len(pos) + i), e) for i, e in enumerate(placed[cid])]
        placed[cid] = [e for _, e in sorted(keyed, key=lambda x: x[0])]
    out["calendars"] = [{**kept[cid], "events": placed[cid]} for cid in order if cid in kept]
    return out

def timetable_from(local, master):
    """`local` with master's EduPage timetable lessons: asus mirrors the backend all the time, while a computer that
    slept brings an old copy, and its stale lessons must not win the merge (nor have their uids, which are only a
    day's row numbers, paired up field by field with other lessons)."""
    mt = next((c for c in master.get("calendars") or [] if isinstance(c, dict) and c.get("id") == TIMETABLE_CAL), None)
    if mt is None or not isinstance(local.get("calendars"), list):
        return local
    if not any(isinstance(c, dict) and c.get("id") == TIMETABLE_CAL for c in local["calendars"]):
        # Removed on the computer (or never there): the service puts it back anyway, so keep it, history included.
        return {**local, "calendars": [*local["calendars"], mt]}
    ours = [e for e in mt.get("events") or [] if timetable_owned(e)]
    cals = [{**c, "events": [e for e in c.get("events") or [] if not timetable_owned(e)] + ours}
            if isinstance(c, dict) and c.get("id") == TIMETABLE_CAL else c for c in local["calendars"]]
    return {**local, "calendars": cals}

def managed(event, cal_id):
    if event.get("remote") is True: return True
    uid = str(event.get("uid", ""))
    at = uid.rfind("@")
    return 0 <= at < len(uid) - 1 and cal_id.startswith(uid[at + 1:] + "-")

TESTS_NAME = "Testy"  # the EduPage bridge finds the calendar it writes tests into by this name (TESTS_CALENDAR)

def undeletable(cal):
    """Why a calendar may not be removed, or None: a program fills it and would fail or bring it back. A subscription
    may go: Weft (or Kalendarix) refreshes only a calendar that is there."""
    if cal["id"] == TIMETABLE_CAL: return "this calendar belongs to a sync program"
    if cal.get("sourceUrl"): return None
    if any(isinstance(e, dict) and managed(e, cal["id"]) for e in cal.get("events") or []):
        return "this calendar belongs to a sync program"
    if str(cal.get("name") or "").strip().casefold() == TESTS_NAME.casefold():
        return "the EduPage bridge writes tests into this calendar"
    return None

HEX = re.compile(r"#[0-9a-fA-F]{6}")
BUILT_IN_CATEGORIES = {"school", "school-events", "tests", "trips", "holidays", "family"}  # Kalendarix's own (categories.ts)
FRESH = {"description": "", "notes": "", "location": "", "allDay": False, "rrule": None, "exdates": [], "alarmMinutes": ""}
is_tests = lambda n: str(n or "").strip().casefold() == TESTS_NAME.casefold()

def hex_color(v, what="color"):
    if not isinstance(v, str) or not HEX.fullmatch(v): raise ValueError(f"{what} must be #rrggbb")
    return v.lower()

def new_events(events, remote=False):
    """Events of an imported or subscribed .ics, checked as a put checks one."""
    if not isinstance(events, list): raise ValueError("events must be a list")
    out = []
    for e in events:
        if not isinstance(e, dict) or not isinstance(e.get("uid"), str) or not e["uid"]: raise ValueError("an event needs a uid")
        for k in ("title", "start", "end"):
            if not isinstance(e.get(k), str): raise ValueError(f"event.{k} must be text")
        out.append({**FRESH, **e, **({"remote": True} if remote else {})})
    return out

def own_categories(doc):
    """Categories of Karchi's own by id, as Kalendarix reads them: the file's list, then a category only a calendar names."""
    out = {}
    for c in doc.get("categories") or []:
        if isinstance(c, dict) and isinstance(c.get("id"), str) and c["id"] and isinstance(c.get("color"), str) and HEX.fullmatch(c["color"]):
            out[c["id"]] = {"id": c["id"], "name": str(c.get("name") or "").strip() or c["id"], "color": c["color"].lower()}
    for cal in doc.get("calendars") or []:
        cid = cal.get("category")
        if not isinstance(cid, str) or not cid or cid in out or cid in BUILT_IN_CATEGORIES: continue
        color = next((c for c in (cal.get("customColor"), cal.get("color")) if isinstance(c, str) and HEX.fullmatch(c)), None)
        if color: out[cid] = {"id": cid, "name": str(cal.get("name") or "").strip() or cid, "color": color.lower()}
    return out

def calendar_fields(op, cal=None):
    """name, category, colour and autoAccent of addcal and updcal; colour fields as Kalendarix keeps them (withColors)."""
    out = {}
    if "name" in op or cal is None:
        name = op.get("name")
        if not isinstance(name, str) or not name.strip(): raise ValueError("a calendar needs a name")
        out["name"] = name.strip()
    if "color" in op or cal is None:
        color = hex_color(op.get("color"))
        out["color"] = out["customColor"] = color
    if "category" in op:
        if not isinstance(op["category"], str): raise ValueError("category must be text")
        out["category"] = op["category"]
    if "autoAccent" in op:
        if not isinstance(op["autoAccent"], bool): raise ValueError("autoAccent must be true or false")
        out["autoAccent"] = op["autoAccent"]
    return out

def apply_ops(doc, ops):
    cals = by_key(doc.get("calendars"), "id")
    for op in ops:
        if not isinstance(op, dict): raise ValueError("an op is an object")
        kind = op.get("op")
        if kind == "addcal":
            cid = op.get("cal")
            if not isinstance(cid, str) or not cid: raise ValueError("a calendar needs an id")
            fields = calendar_fields(op)
            if cid in cals: continue
            if is_tests(fields["name"]) and any(is_tests(c.get("name")) for c in cals.values()):
                raise ValueError("there is a Testy calendar already: the EduPage bridge writes into one")
            url = op.get("sourceUrl")
            if url is not None and not (isinstance(url, str) and re.match(r"https?://", url)): raise ValueError("sourceUrl must be an http(s) address")
            # Kalendarix's fields for a calendar of one's own; the colour it shows is customColor.
            cals[cid] = {"id": cid, **fields, "visible": True, **({"sourceUrl": url} if url else {}), "events": new_events(op.get("events") or [])}
            doc.setdefault("calendars", []).append(cals[cid])
            continue
        if kind in ("addcat", "updcat", "delcat"):
            cat_op(doc, op)
            continue
        if op.get("op") == "delcal":
            cal = cals.get(op.get("cal"))
            if cal is None: continue
            why = undeletable(cal)
            if why: raise ValueError(why)
            doc["calendars"] = [c for c in doc["calendars"] if c is not cal]
            del cals[cal["id"]]
            continue
        cal = cals.get(op.get("cal"))
        if cal is None: raise ValueError(f"no calendar {op.get('cal')!r}")
        if kind == "updcal":
            fields = calendar_fields(op, cal)
            # The EduPage bridge finds the calendar it writes tests into by its name.
            if "name" in fields and is_tests(cal.get("name")) and not is_tests(fields["name"]): raise ValueError("the EduPage bridge finds the Testy calendar by its name")
            if "name" in fields and is_tests(fields["name"]) and not is_tests(cal.get("name")) and any(is_tests(c.get("name")) for c in cals.values()):
                raise ValueError("there is a Testy calendar already: the EduPage bridge writes into one")
            cal.update(fields)
            continue
        if kind == "accent":
            key, color = op.get("key"), op.get("color")
            if not isinstance(key, str) or not key: raise ValueError("an accent needs the title's key")
            accents = dict(cal.get("accents") or {})
            if color is None: accents.pop(key, None)
            else: accents[key] = hex_color(color)
            cal["accents"] = accents
            continue
        if kind == "feed":
            if not cal.get("sourceUrl"): raise ValueError("only a subscribed calendar takes a download")
            # Events added by hand stay; the last download goes.
            cal["events"] = [e for e in cal.get("events") or [] if e.get("remote") is not True] + new_events(op.get("events"), remote=True)
            cal["fetchedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
            continue
        events = cal.setdefault("events", [])
        uid = op.get("uid") or (op.get("event") or {}).get("uid")
        if not isinstance(uid, str) or not uid: raise ValueError("an event needs a uid")
        old = next((e for e in events if e.get("uid") == uid), None)
        if (old and managed(old, cal["id"])) or managed({"uid": uid}, cal["id"]):
            raise ValueError("this event belongs to a sync program")
        if op.get("op") == "del":
            cal["events"] = [e for e in events if e.get("uid") != uid]
        elif op.get("op") == "put":
            event = op["event"]
            for k in ("title", "start", "end"):
                if not isinstance(event.get(k), str): raise ValueError(f"event.{k} must be text")
            # Fields Weft does not send (repetition, Kalendarix's colours, another program's) stay as they were.
            new = {**(old or FRESH), **event}
            if old: events[events.index(old)] = new
            else: events.append(new)
        else:
            raise ValueError(f"unknown op {op.get('op')!r}")
    return doc

def cat_op(doc, op):
    """A category of Karchi's own added, renamed or recoloured, or removed (Kalendarix's addCategory, updateCategory,
    deleteCategory): calendars of that kind follow; a removed one's calendars keep its colour as their own."""
    cid = op.get("id")
    if not isinstance(cid, str) or not cid: raise ValueError("a category needs an id")
    stored = [c for c in doc.get("categories") or [] if isinstance(c, dict)]
    own = own_categories(doc)
    if op["op"] == "addcat":
        name = op.get("name")
        if not isinstance(name, str) or not name.strip(): raise ValueError("a category needs a name")
        color = hex_color(op.get("color"))
        if cid in BUILT_IN_CATEGORIES: raise ValueError("Kalendarix has a category of that id")
        if not any(c.get("id") == cid for c in stored): doc["categories"] = [*stored, {"id": cid, "name": name.strip(), "color": color}]
        return
    cur = own.get(cid)
    if cur is None: return  # gone already, or one that comes with Kalendarix
    if op["op"] == "updcat":
        nxt = dict(cur)
        if "name" in op:
            if not isinstance(op["name"], str) or not op["name"].strip(): raise ValueError("a category needs a name")
            nxt["name"] = op["name"].strip()
        if "color" in op: nxt["color"] = hex_color(op["color"])
        doc["categories"] = [({**c, **nxt} if c.get("id") == cid else c) for c in stored] if any(c.get("id") == cid for c in stored) else [*stored, nxt]
        for cal in doc.get("calendars") or []:
            if cal.get("category") == cid: cal["color"] = cal["customColor"] = nxt["color"]
        return
    doc["categories"] = [c for c in stored if c.get("id") != cid]
    for cal in doc.get("calendars") or []:
        for e in cal.get("events") or []:
            if isinstance(e, dict) and e.get("category") == cid: del e["category"]
        if cal.get("category") == cid:
            cal.update({"category": "", "color": cur["color"], "customColor": cur["color"]})

FETCH_MAX = 10 * 1024 * 1024

class PublicOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def public_url(url):
    """An http(s) address on the internet: never asus itself or the home network, whatever the feed's server says."""
    import ipaddress, socket
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname: raise ValueError("an http(s) address is needed")
    for info in socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80)):
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global: raise ValueError("that address is not on the internet")
    return url

def fetch_ics(url):
    url = re.sub(r"^webcal://", "https://", url.strip(), flags=re.I)
    req = urllib.request.Request(public_url(url), headers={"User-Agent": "Weft calendar", "Accept": "text/calendar, */*"})
    with public_net.opener(PublicOnly).open(req, timeout=20) as r:  # each connection checked again
        data = r.read(FETCH_MAX + 1)
    if len(data) > FETCH_MAX: raise ValueError("the calendar is larger than 10 MB")
    return data.decode("utf-8", "replace")


# ------------------------------------------------------------------ the EduPage timetable

# Kalendarix EduPage's backend (github.com/Gooder24/kalendarix-edupage, on dell) reads EduPage's daily plan, so a
# substitution, a cancelled or moved lesson and a school event are in its events within minutes. They go into the
# calendar its x270 client writes too, with the same id, uids and fields, so both copies hold the same thing; asus
# runs all the time, so for these events its copy is the one a merge keeps (see merge).
TIMETABLE_URL = os.environ.get("TIMETABLE_URL", "").rstrip("/")  # from ~/.config/weft/weft.env; empty turns it off
TIMETABLE_TOKEN = os.environ.get("TIMETABLE_TOKEN", "")  # the backend's KX_TOKEN, when it has one
TIMETABLE_EVERY = int(os.environ.get("TIMETABLE_EVERY", "120"))
TIMETABLE_CAL = "lifeos-edupage"
TIMETABLE_OURS = "@lifeos"
LOCAL_TZ = ZoneInfo("Europe/Bratislava")

def timetable_owned(event):
    return isinstance(event, dict) and str(event.get("uid", "")).endswith(TIMETABLE_OURS)

def utc_ms(iso):
    # Kalendarix stores Date.toISOString(): UTC with milliseconds.
    return datetime.fromisoformat(iso).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

def timetable_event(e):
    """One backend event the way kalendarix_edupage_sync.py writes it into calendars.json."""
    out = {"uid": e["uid"], "title": e["title"], "description": e["description"], "notes": e["description"],
           "location": e["location"], "start": utc_ms(e["start"]), "end": utc_ms(e["end"]), "allDay": e["all_day"],
           "rrule": None, "exdates": [], "alarmMinutes": ""}
    if e.get("color"): out["color"] = e["color"]
    return out

def put_timetable(doc, events, today):
    """The backend's events in place of the timetable calendar's earlier ones; True when anything changed.
    Events added to that calendar by hand stay, as do its name, colour and visibility, and lessons of past days the
    backend no longer has (uid "<date>-<n>@lifeos"; it serves 30 days back)."""
    cals = doc.setdefault("calendars", [])
    cal = next((c for c in cals if isinstance(c, dict) and c.get("id") == TIMETABLE_CAL), None)
    if cal is None:
        cal = {"id": TIMETABLE_CAL, "name": "EduPage rozvrh", "color": "#a6e3a1", "visible": True, "colorSlot": 1,
               "customColor": "#a6e3a1", "events": []}
        cals.append(cal)
    current = cal.get("events") or []
    # Days the backend sent, and today and later, are replaced whole. A past day it sent nothing for stays: it never
    # reads past days again, so such a day is one its store does not have (too old, or it was off), not an empty one.
    sent = {e["uid"][:10] for e in events}
    stays = lambda e: timetable_owned(e) and str(e["uid"])[:10] < today.isoformat() and str(e["uid"])[:10] not in sent
    # Always in this order (hand-made, kept lessons, the backend's), the order timetable_from gives a merge too.
    updated = [e for e in current if not timetable_owned(e)] + [e for e in current if stays(e)] + [timetable_event(e) for e in events]
    if updated == current and "events" in cal: return False
    cal["events"] = updated
    return True

def fetch_timetable(url):
    """The backend's events and when it last read EduPage; ([], None) before its first successful read."""
    headers = {"Authorization": f"Bearer {TIMETABLE_TOKEN}"} if TIMETABLE_TOKEN else {}
    with urllib.request.urlopen(urllib.request.Request(f"{url}/api/events", headers=headers), timeout=30) as r:
        body = json.load(r)
    if not isinstance(body, dict) or not isinstance(body.get("events"), list):
        raise ValueError("not an events answer")
    events, fresh = body["events"], body.get("last_success_at")
    for e in events:  # every field there and of its kind, before anything is written
        if not (isinstance(e, dict) and all(isinstance(e.get(k), str) for k in ("uid", "title", "description", "location", "start", "end"))
                and e["uid"].endswith(TIMETABLE_OURS) and isinstance(e.get("all_day"), bool) and isinstance(e.get("color"), (str, type(None)))):
            raise ValueError("an event is not what the backend sends")
        timetable_event(e)
    if fresh is not None and not (isinstance(fresh, str) and fresh):
        raise ValueError("last_success_at is not a time")
    return events, fresh

def mirror_timetable(url=TIMETABLE_URL):
    """One round: the backend's timetable into the master. Returns (events written or None if unchanged, the
    backend's last successful read of EduPage)."""
    events, fresh = fetch_timetable(url)
    if fresh is None: return None, None  # never read EduPage yet: an empty list says nothing
    with locked():
        doc = read(MASTER) or empty()
        if not put_timetable(doc, events, datetime.now(LOCAL_TZ).date()): return None, fresh
        write(MASTER, doc)
    return len(events), fresh

def mirror_loop():
    failing, seen = False, None
    while True:
        try:
            n, fresh = mirror_timetable()
            if n is not None: print(f"timetable: {n} events from the backend (EduPage read at {fresh})", flush=True)
            elif fresh != seen: print(f"timetable: unchanged (EduPage read at {fresh})", flush=True)
            if failing: print("timetable: backend reachable again", flush=True)
            failing, seen = False, fresh
        except Exception as e:  # dell asleep or restarting: the last copy stays, the next round tries again
            if not failing: print(f"timetable: backend unreachable ({type(e).__name__}: {e}); keeping the last copy", flush=True)
            failing = True
        time.sleep(TIMETABLE_EVERY)


# ------------------------------------------------------------------ HTTP

USERS = weft_users.Users(HS, OWNER)
FETCHES = weft_users.Limit(60, 3600)  # .ics downloads per person an hour: subscriptions refresh every 30 minutes

class Api(BaseHTTPRequestHandler):

    def log_message(self, *a): pass

    def send(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def caller(self):
        """The folder of the calling person's calendar, or None. user_id: an appservice token (the EduPage bridge's
        double puppet) acting as that person; the homeserver checks it."""
        token = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
        as_user = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("user_id", [None])[0]
        self.user = USERS.who(token, as_user)
        return self.user and weft_users.home(DATA, self.user, OWNER)

    def do_GET(self):
        folder = self.caller()
        if not folder: return self.send(401, {"error": "a token of this server's people only"})
        if self.path.split("?")[0] == "/_calendar/fetch":
            if self.user != OWNER and not FETCHES.take(self.user): return self.send(429, {"error": "too many downloads, try again later"})
            url = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("url", [""])[0]
            try: return self.send(200, {"text": fetch_ics(url)})
            except ValueError as e: return self.send(400, {"error": str(e)})
            except Exception as e: return self.send(422, {"error": f"{type(e).__name__}: {e}"})  # the feed's fault: not "offline" in Weft
        if self.path.split("?")[0] != "/_calendar/doc": return self.send(404, {"error": "not found"})
        doc = read(os.path.join(folder, "calendars.json"))
        v = version(doc)
        have = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("have", [None])[0]
        # A client polling for changes gets the whole file only when it differs from what it has.
        if have and have == v: return self.send(200, {"version": v, "same": True})
        self.send(200, {"version": v, "doc": doc})

    def do_POST(self):
        folder = self.caller()
        if not folder: return self.send(401, {"error": "a token of this server's people only"})
        if self.path.split("?")[0] != "/_calendar/ops": return self.send(404, {"error": "not found"})
        try:
            size = int(self.headers.get("Content-Length") or 0)
            if folder != DATA and size > MAX_OPS: return self.send(413, {"error": "too large"})
            body = json.loads(self.rfile.read(size) or b"{}")
            master = os.path.join(folder, "calendars.json")
            with locked(folder):
                doc = apply_ops(read(master) or empty(), body.get("ops") or [])
                if folder != DATA and len(dump(doc)) > MAX_DOC: return self.send(413, {"error": "calendar too large"})
                write(master, doc)
            self.send(200, {"version": version(doc), "doc": doc})
        except (ValueError, KeyError, TypeError, AttributeError) as e:
            self.send(400, {"error": str(e)})


def main():
    if sys.argv[1:] == ["merge"]:
        body = json.loads(sys.stdin.read())
        local = body.get("local") or {}
        if not isinstance(local.get("calendars"), list): sys.exit("merge: local is not a calendars.json")
        with locked():
            master = read(MASTER)
            merged = merge(body.get("base"), local, master) if master is not None else local
            if merged != master: write(MASTER, merged)
        sys.stdout.write(dump(merged))
        return
    if not OWNER: sys.exit("OWNER is not set: add it to ~/.config/weft/weft.env")
    os.makedirs(DATA, exist_ok=True)
    if TIMETABLE_URL: threading.Thread(target=mirror_loop, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Api).serve_forever()

if __name__ == "__main__":
    main()

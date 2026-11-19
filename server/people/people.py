#!/usr/bin/env python3
"""The people map Weft shows on Ctrl+M: who Karchi knows, and from where.

    people.py                build the map and save it as Karchi's account data sk.karchi.friends
    people.py --dry [FILE]   only print a summary (and write the map to FILE)

It reads, on asus and nothing from the network:
  - the message archive (../archive/archive.db): how much and when he wrote with each person;
  - the homeserver: who is in which group chat, and the room of each one-to-one chat (so Weft can open it);
  - the WhatsApp bridge's copy of his phone's address book: the name he saved a number under beats a nickname;
  - Instagram's "Download your information" exports in ~/exports/instagram: who was in which Instagram group;
  - facts.json next to this file (private, mode 600, never in git): the branches with their colours, which group chat
    belongs to which branch, and private per-person metadata (name, branches, relations, a note). "was" lists the branches a person used to be in (left a club): they stay on
    the map there, marked as former, even while a group chat still puts them in.

Karchi's own corrections in Weft (sk.karchi.friends.edits) are separate and never touched here."""
import collections, hashlib, json, os, re, sys, time, unicodedata, urllib.parse, urllib.request, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPIKE = Path.home() / "matrix-spike"
HS = os.environ.get("HS", "http://127.0.0.1:8008")
TOKEN = (SPIKE / "archive" / "token").read_text().strip()
FACTS = json.loads((HERE / "facts.json").read_text())
KEY = "sk.karchi.friends"
q = lambda s: urllib.parse.quote(s, safe="")
NETS = {"facebookgo": "messenger", "facebook": "messenger", "instagramgo": "instagram", "instagram": "instagram",
        "discordgo": "discord", "discord": "discord", "whatsapp": "whatsapp", "teams": "teams"}


def call(method, path, body=None):
    req = urllib.request.Request(HS + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def norm(name):
    """One key for a person's names across networks: 'Tomáš Kováč (WA)' and 'Tomas Kovac' meet."""
    n = re.sub(r"\s*\((WA|IG|FB)\)\s*$", "", name or "").strip()
    n = "".join(ch for ch in unicodedata.normalize("NFKD", n) if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", n.lower()).strip()


def fix(s):
    """Meta writes UTF-8 bytes as if each were a Latin-1 character."""
    try: return s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError): return s


ME = {norm(n) for n in FACTS.get("me", [])}
# One person behind two accounts: the second name's key folds into the first's.
SAME = {norm(b): norm(a) for a, *rest in FACTS.get("same", []) for b in rest}
SKIP = re.compile(r"^(\+|instagram user|pouzivatel facebooku|wordle|webhook)|\(bot\)$", re.I)


class People:
    def __init__(self):
        self.p = collections.defaultdict(lambda: {"names": collections.Counter(), "n": 0, "first": None, "last": None,
                                                  "groups": set(), "rooms": set(), "mxids": set()})

    def touch(self, name, group=None, mxid=None):
        key = norm(name)
        key = SAME.get(key, key)
        if not key or key in ME or SKIP.search(key): return None
        p = self.p[key]
        p["names"][re.sub(r"\s*\(WA\)$", "", name).strip()] += 1
        if group: p["groups"].add(group)
        if mxid: p["mxids"].add(mxid)
        return p

    def talk(self, p, n, first, last):
        p["n"] += n
        p["first"] = min(filter(None, [p["first"], first]), default=None)
        p["last"] = max(filter(None, [p["last"], last]), default=None)


def collect():
    people = People()
    me = call("GET", "/_matrix/client/v3/account/whoami")["user_id"]
    db = __import__("sqlite3").connect(f"file:{SPIKE / 'archive' / 'archive.db'}?mode=ro", uri=True)
    counts = collections.defaultdict(list)  # archive chat -> [(sender, me, n, first, last)]
    for chat, sender, mine, n, a, b in db.execute("SELECT chat, sender, me, count(*), min(ts), max(ts) FROM messages GROUP BY 1, 2, 3"):
        counts[chat].append((sender, mine, n, a, b))
    chats = {cid: (title, room, src) for cid, title, room, src in db.execute("SELECT id, title, room, source FROM chats")}
    by_room = collections.defaultdict(list)
    for cid, (_, room, _) in chats.items():
        if room: by_room[room].append(cid)

    def talked(p, cids):
        for cid in cids:
            for _, _, n, a, b in counts.get(cid, []):
                people.talk(p, n, a, b)

    # The homeserver: one-to-one chats and who is in each group. A Discord channel counts as its server.
    dc = __import__("sqlite3").connect(f"file:{SPIKE / 'discord' / 'bridge.db'}?mode=ro", uri=True)
    guilds = dict(dc.execute("SELECT dcid, name FROM guild"))
    guild_of = {mx: guilds.get(g) for mx, g in dc.execute("SELECT mxid, dc_guild_id FROM portal WHERE mxid IS NOT NULL")}
    for rid in call("GET", "/_matrix/client/v3/joined_rooms")["joined_rooms"]:
        try: state = call("GET", f"/_matrix/client/v3/rooms/{q(rid)}/state")
        except Exception: continue
        name = next((e["content"].get("name") for e in state if e["type"] == "m.room.name"), None) or ""
        net = next((e["content"].get("protocol", {}).get("id") for e in state if e["type"] in ("m.bridge", "uk.half-shot.bridge")), None)
        members = [(e["content"].get("displayname") or e["state_key"], e["state_key"]) for e in state if e["type"] == "m.room.member"
                   and e["content"].get("membership") == "join" and "bot:" not in e["state_key"] and e["state_key"] != me]
        if net not in NETS: continue
        group = f"discord:{guild_of[rid]}" if guild_of.get(rid) else name or rid
        if len(members) == 1 and not guild_of.get(rid) and not name.startswith("#"):
            p = people.touch(*members[0][:1], mxid=members[0][1])
            if p:
                p["rooms"].add(rid)
                talked(p, [c for c in by_room[rid] if chats[c][2] == "matrix"])
        elif len(members) >= 2:
            for m, mxid in members: people.touch(m, group, mxid)

    # Instagram's export: its one-to-one chats (the long history) and who was in each group.
    threads = collections.defaultdict(lambda: {"title": "", "people": set()})
    for z in sorted((Path.home() / "exports" / "instagram").glob("*.zip")):
        zf = zipfile.ZipFile(z)
        for entry in zf.namelist():
            m = re.search(r"/messages/(inbox/[^/]+)/message_\d+\.json$", entry)
            if not m: continue
            d = json.load(zf.open(entry))
            t = threads[m.group(1)]
            t["title"] = fix(d.get("title") or "")
            t["people"] |= {fix(x["name"]) for x in d.get("participants", [])}
    for path, t in threads.items():
        others = [x for x in t["people"] if norm(x) not in ME]
        cid = f"instagram:{path}"
        if len(others) == 1:
            p = people.touch(others[0])
            if p and cid in chats:
                talked(p, [cid])
                if chats[cid][1]: p["rooms"].add(chats[cid][1])
        else:
            for x in others: people.touch(x, t["title"])
    return people


def full(name):
    """'Jana Nováková' rather than 'janka_n', 'Janka' or '𝒥𝒶𝓃𝓀𝒶': two words of plain letters."""
    return bool(name) and len(re.findall(r"[^\W\d_]{2,}", name)) >= 2 and not re.search(r"[\d_.@]", name) \
        and unicodedata.normalize("NFKC", name) == name and all(unicodedata.category(ch)[0] in "LZ" or ch in "-'" for ch in name.strip())


def address_book():
    """WhatsApp ghost id ('421900123456' or 'lid-2206…') -> the name saved for that number in the owner's phone."""
    db = __import__("sqlite3").connect(f"file:{SPIKE / 'whatsapp' / 'bridge.db'}?mode=ro", uri=True)
    out = {}
    for jid, full in db.execute("SELECT their_jid, full_name FROM whatsmeow_contacts WHERE full_name != ''"):
        user, _, server = jid.partition("@")
        out[f"lid-{user}" if server == "lid" else user] = full.strip()
    return out


def build(people):
    # Group title (a Discord server as "discord:<name>") -> "branch/sub". A rule starting with "~" only tags people
    # already on the map, so a 150-member group chat does not bring in everyone who ever joined it.
    groups = FACTS["groups"]
    known = {SAME.get(norm(k), norm(k)): v for k, v in FACTS["people"].items()}
    book = address_book()
    out, emitted = [], set()
    for key, p in people.p.items():
        fact = known.get(key, {})
        was = fact.get("was", [])
        refs = list(fact.get("b", [])) + [r for r in was if r not in fact.get("b", [])]
        onmap = bool(fact) or p["n"] >= FACTS.get("talked_from", 15)
        for g in sorted(p["groups"]):
            rule = groups.get(g) or []
            for ref in [rule] if isinstance(rule, str) else rule:  # a list: the group belongs to several branches
                if ref.startswith("~"):
                    if not onmap: continue
                    ref = ref[1:]
                if ref and ref not in refs and not any(r.startswith(ref + "/") for r in refs): refs.append(ref)
        refs = [r for r in refs if not any(o.startswith(r + "/") for o in refs if o != r)]  # a sub-branch says the branch
        if not refs and p["n"] >= FACTS.get("others_from", 150): refs = ["ine"]
        if not refs or fact.get("hide"): continue
        emitted.add(key)
        # Of the names a person goes by in different chats: a first and last name beats a nickname, plain capitalised
        # letters beat 𝚏𝚊𝚗𝚌𝚢 or lowercase ones, and "Nováková" beats "Novakova".
        nice = lambda n: unicodedata.normalize("NFKC", n) == n and n[:1].isupper()
        handle = max(p["names"], key=lambda n: (full(n), nice(n), not n.isascii(), p["names"][n], n))
        saved = next((book[m.split(":")[0][len("@whatsapp_"):]] for m in sorted(p["mxids"])
                      if m.startswith("@whatsapp_") and m.split(":")[0][len("@whatsapp_"):] in book), None)
        # His saved name wins over a nickname, not over a full name ("Peter" in the phone, "Peter Horák" in chats).
        name = fact.get("name") or fact.get("real") or (saved if full(saved) and not full(handle) else handle)  # handles stay as aliases
        month = lambda ms: time.strftime("%Y-%m", time.gmtime(ms / 1000)) if ms else None
        out.append({k: v for k, v in {
            "id": hashlib.sha1(key.encode()).hexdigest()[:10], "name": name,
            "alias": [n for n in p["names"] if n != name][:4] or None, "b": refs, "sib": fact.get("sib"),
            "was": [r for r in was if r in refs] or None, "rel": fact.get("rel"), "note": fact.get("note"), "n": p["n"] or None,
            "sibq": fact.get("sibq"), "unsure": fact.get("unsure"),
            "first": month(p["first"]), "last": month(p["last"]), "rooms": sorted(p["rooms"]) or None,
        }.items() if v})
    # People known only from elsewhere (teachers from EduPage, family without a chat).
    for name, fact in FACTS["people"].items():
        if fact.get("extra") and norm(name) not in emitted:
            out.append({k: v for k, v in {"id": hashlib.sha1(norm(name).encode()).hexdigest()[:10], "name": fact.get("name") or name,
                        "b": fact["b"] + [r for r in fact.get("was", []) if r not in fact["b"]], "was": fact.get("was"), "rel": fact.get("rel"), "note": fact.get("note"), "sib": fact.get("sib")}.items() if v})
    out.sort(key=lambda x: -(x.get("n") or 0))
    return {"at": int(time.time() * 1000), "branches": FACTS["branches"], "people": out}


if __name__ == "__main__":
    collected = collect()
    data = build(collected)
    # Facts whose person no chat knows any more (renamed account, typo): they quietly do nothing, so say so.
    lost = [k for k, v in FACTS["people"].items() if not v.get("extra") and SAME.get(norm(k), norm(k)) not in collected.p]
    if lost: print(f"facts without a person ({len(lost)}):", ", ".join(lost[:20]))
    size = len(json.dumps(data, ensure_ascii=False).encode())
    per = collections.Counter(r.split("/")[0] for x in data["people"] for r in x["b"])
    print(f"{len(data['people'])} people, {size // 1024} kB:", ", ".join(f"{k} {v}" for k, v in per.most_common()))
    if "--dry" in sys.argv[1:-1] or (sys.argv[-1] != "--dry" and "--dry" in sys.argv):
        Path(sys.argv[-1]).write_text(json.dumps(data, ensure_ascii=False))
    if "--dry" not in sys.argv:
        me = call("GET", "/_matrix/client/v3/account/whoami")["user_id"]
        call("PUT", f"/_matrix/client/v3/user/{q(me)}/account_data/{KEY}", data)
        print("saved as", KEY)

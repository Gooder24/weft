"""Who is calling a Weft service, and where that person's data lives.

Every account of this homeserver is a Weft user with data of their own; only the bridges' puppets and bots are not.

    import sys, os; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "common"))
    import weft_users
    users = weft_users.Users(hs=HS, owner=OWNER)
    user = users.who(token, as_user)          # the caller's Matrix ID, or None
    path = weft_users.home(DATA, user, OWNER) # DATA for the owner (his files never move), DATA/users/<localpart> for others

`as_user` is the `user_id` query of an appservice token (a bridge's double puppet acting as someone); the homeserver
checks it. Who is a puppet comes from the exclusive user namespaces in the appservice registrations (APPSERVICE_DIR,
by default ~/matrix-spike/appservices), read again when that folder changes.
"""
import glob, json, os, re, threading, time, urllib.parse, urllib.request

import yaml

# What a homeserver may register (the spec's historical user id grammar: printable ASCII without a colon).
LOCALPART = re.compile(r"^[\x21-\x39\x3b-\x7e]+$")


def localpart(user):
    return user[1:].split(":", 1)[0] if user and user.startswith("@") else ""


def home(base, user, owner):
    """The folder of this user's data. The owner keeps the service's own folder; anyone else gets users/<localpart>."""
    if user == owner: return base
    lp = localpart(user)
    if not LOCALPART.match(lp): raise ValueError(f"not a user id: {user!r}")
    # One folder name per localpart, never "." or "..": every character but a-z 0-9 _ = - is written as %xx.
    path = os.path.join(base, "users", "".join(c if re.match(r"[a-z0-9_=\-]", c) else f"%{ord(c):02x}" for c in lp))
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def namespaces(folder):
    """The exclusive user patterns and bot ids of every appservice registration in folder."""
    patterns, bots = [], set()
    for f in sorted(glob.glob(os.path.join(folder, "*.yaml"))):
        # A file that is not a registration (half written, a note) is skipped: the homeserver ignores it too.
        try: reg = yaml.safe_load(open(f, encoding="utf-8"))
        except (OSError, yaml.YAMLError): continue
        if not isinstance(reg, dict): continue
        if reg.get("sender_localpart"): bots.add(str(reg["sender_localpart"]))
        users = (reg.get("namespaces") or {}).get("users") if isinstance(reg.get("namespaces"), dict) else None
        # A registration without exclusive users (the double puppet's @.*) owns nobody.
        for ns in users if isinstance(users, list) else []:
            if isinstance(ns, dict) and ns.get("exclusive") is True and ns.get("regex"):
                try: patterns.append(re.compile(str(ns["regex"])))
                except re.error: continue
    return patterns, bots


class Users:
    def __init__(self, hs, owner, appservice_dir=None, ttl=60):
        self.hs, self.owner, self.ttl = hs, owner, ttl
        self.dir = appservice_dir or os.environ.get("APPSERVICE_DIR") or os.path.expanduser("~/matrix-spike/appservices")
        self.server = owner.split(":", 1)[1] if ":" in owner else ""
        self.cache, self.lock = {}, threading.Lock()
        self.seen_dir, self.patterns, self.bots = None, [], set()

    def _namespaces(self):
        try: stamp = max((os.stat(f).st_mtime for f in glob.glob(os.path.join(self.dir, "*.yaml"))), default=0)
        except OSError: stamp = 0
        if stamp != self.seen_dir:
            self.patterns, self.bots = namespaces(self.dir)
            self.seen_dir = stamp
        return self.patterns, self.bots

    def human(self, user):
        """A person's account of this server: not another server's, not a bridge's puppet or bot."""
        if not user or not user.startswith("@") or user.split(":", 1)[-1] != self.server: return False
        if not LOCALPART.match(localpart(user)): return False
        patterns, bots = self._namespaces()
        return localpart(user) not in bots and not any(p.match(user) for p in patterns)

    def whoami(self, token, as_user=None):
        query = "?" + urllib.parse.urlencode({"user_id": as_user}) if as_user else ""
        hs = self.hs() if callable(self.hs) else self.hs  # a callable: the service may move its homeserver (tests)
        req = urllib.request.Request(hs + "/_matrix/client/v3/account/whoami" + query, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=10) as r: return json.load(r)["user_id"]

    def who(self, token, as_user=None):
        """The caller's Matrix ID when the token is good and belongs to a person of this server, else None."""
        if not token: return None
        key, now = (token, as_user), time.time()
        with self.lock:
            for k, (_, at) in list(self.cache.items()):
                if now - at >= self.ttl: self.cache.pop(k, None)
            if key in self.cache: return self.cache[key][0]
        try: user = self.whoami(token, as_user)
        except Exception: return None
        # The owner never depends on the registrations being readable; anyone else is refused if they are not.
        try: person = user == self.owner or self.human(user)
        except Exception: person = False
        if not person: return None
        with self.lock: self.cache[key] = (user, now)
        return user


class Limit:
    """At most `count` uses per `per` seconds for each key (a user), so no account can wear out a shared resource."""
    def __init__(self, count, per):
        self.count, self.per, self.used, self.lock = count, per, {}, threading.Lock()

    def take(self, key):
        now = time.time()
        with self.lock:
            times = [t for t in self.used.get(key, []) if now - t < self.per]
            if len(times) >= self.count:
                self.used[key] = times
                return False
            times.append(now)
            self.used[key] = times
            return True

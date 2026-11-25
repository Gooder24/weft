#!/usr/bin/env python3
"""Weft's "send later": sends Karchi's scheduled messages when they come due, whether Weft is open or not.

Weft keeps them in his account data under sk.karchi.sendlater as {"items": [{id, room, at, seq, content}]},
`at` in ms. An item with `gap` (ms, Rozoslať) is paced: its batch goes only `gap` after the last paced batch of the
same network (`net`, else its room) went, so a list due all at once after an outage still goes out one by one.
This waits on /sync for changes to that list (or until the next one is due), sends each due item with its id
as the transaction id, so a retry after a crash cannot send it twice, and marks it sent (or failed, with the
server's error). Weft shows what is still waiting and can cancel it or move it to now.
Its own device logs in once with a token from mint-login-token.py; the token stays in ./token (0600)."""
import json, os, stat, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("HS", "http://127.0.0.1:8008")
KEY = "sk.karchi.sendlater"
TOKEN_FILE = os.environ.get("TOKEN_FILE", os.path.join(HERE, "token"))
MINT = os.path.expanduser("~/matrix-spike/homeserver/mint-login-token.py")
KEEP_DONE_MS = 7 * 24 * 3600e3  # sent and failed items stay a week, so Weft can still say what happened
q = lambda s: urllib.parse.quote(s, safe="")


class HttpError(Exception):
    def __init__(self, status, body):
        super().__init__(f"{status} {body.get('errcode', '')}")
        self.status, self.body = status, body


def call(method, path, body=None, token=None, timeout=60):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            raise HttpError(e.code, json.load(e)) from None
        except json.JSONDecodeError:
            raise HttpError(e.code, {}) from None


def login():
    if os.path.exists(TOKEN_FILE):
        token = open(TOKEN_FILE).read().strip()
        try:
            return token, call("GET", "/_matrix/client/v3/account/whoami", token=token)["user_id"]
        except HttpError as e:
            if e.status != 401:
                raise
    one_time = subprocess.run([sys.executable, MINT], capture_output=True, text=True, check=True).stdout.strip()
    r = call("POST", "/_matrix/client/v3/login", {"type": "m.login.token", "token": one_time, "initial_device_display_name": "Weft: odoslať neskôr"})
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
    os.write(fd, r["access_token"].encode())
    os.close(fd)
    return r["access_token"], r["user_id"]


def items(token, user):
    try:
        return call("GET", f"/_matrix/client/v3/user/{q(user)}/account_data/{KEY}", token=token).get("items", [])
    except HttpError as e:
        if e.status == 404:
            return []
        raise


def mark(token, user, results, now):
    """Writes what happened onto the list as it is now on the server: Weft may have changed it meanwhile."""
    current = items(token, user)
    for it in current:
        if it.get("id") in results:
            it.update(results[it["id"]])
    legacy = lambda it: not it.get("batch") and not it.get("replyTo")
    def keep(it):
        done = it.get("sent") or it.get("failed")
        if not done or now - done < KEEP_DONE_MS: return True
        # An older Weft's first part stays while a later part of its room waits: gone would read as cancelled (`orphan`).
        return legacy(it) and not it.get("seq") and any(
            legacy(x) and x.get("seq") and x["room"] == it["room"] and not (x.get("sent") or x.get("failed")) for x in current)
    current = [it for it in current if keep(it)]
    call("PUT", f"/_matrix/client/v3/user/{q(user)}/account_data/{KEY}", {"items": current}, token=token)


def is_discord(token, room):
    """The room is bridged to Discord (its m.bridge state names the protocol)."""
    for ev in call("GET", f"/_matrix/client/v3/rooms/{q(room)}/state", token=token):
        if ev.get("type") in ("m.bridge", "uk.half-shot.bridge") and (ev.get("content") or {}).get("protocol", {}).get("id") in ("discordgo", "discord"):
            return True
    return False


def held_reply(token, it):
    """Why a due Discord reply must not go out, or None. The bridge has no threads: a reply to a message from a
    Discord thread goes to the whole channel, and so may one whose target cannot be read any more."""
    # Weft names the reply on every item of a batch (`replyTo`), also on those that carry no reply themselves.
    to = ((it.get("content") or {}).get("m.relates_to") or {}).get("m.in_reply_to", {}).get("event_id") or it.get("replyTo")
    if not to or not is_discord(token, it["room"]): return None
    try: ev = call("GET", f"/_matrix/client/v3/rooms/{q(it['room'])}/event/{q(to)}", token=token)
    except HttpError as e:
        if e.status == 429 or e.status >= 500: raise
        return "the message it answers cannot be read, and the reply could go to the whole Discord channel"
    if not ev.get("content") or "redacted_because" in (ev.get("unsigned") or {}) \
            or (ev["content"].get("m.relates_to") or {}).get("rel_type") == "m.thread":
        return "a reply to a message from a Discord thread would go to the whole channel"
    return None


def reply_rel(it):
    return ((it.get("content") or {}).get("m.relates_to") or {}).get("m.in_reply_to")


def carriers(it, every):
    """The items that carry the reply `it` was scheduled with, when `it` (a file or the text after the first part)
    does not carry it itself. Weft's batch: its part with the reply. An older Weft wrote no `batch`/`replyTo` and its
    `at` may have moved („Poslať teraz“), so its batch is not known: every unsent reply of the same room it wrote."""
    if reply_rel(it): return []
    if it.get("batch"):
        return [x for x in every if x is not it and x.get("batch") == it["batch"] and reply_rel(x)]
    if it.get("replyTo") or not it.get("seq"): return []
    return [x for x in every if x is not it and x["room"] == it["room"] and not x.get("batch") and not x.get("seq")
            and not x.get("sent") and reply_rel(x)]


def orphan(it, every):
    """A later part an older Weft wrote (no `batch`) whose first part is gone from the list: cancelled, since a sent
    one stays listed. Whether that part carried a reply is not known any more."""
    return not it.get("batch") and not it.get("replyTo") and bool(it.get("seq")) and not reply_rel(it) and not any(
        x is not it and x["room"] == it["room"] and not x.get("batch") and not x.get("seq") for x in every)


def paced_last(every, it, results):
    """When the last paced batch of `it`'s network went (ms), from the list and this round's results."""
    net = lambda x: x.get("net") or x["room"]
    went = [x.get("sent") or results.get(x["id"], {}).get("sent") for x in every if x.get("gap") and net(x) == net(it)]
    return max([w for w in went if w] or [0])


def paced(every, it, results, now):
    """None when a paced item may go now, "wait" while a part of its batch before it has not gone or (its first
    part) another batch of its network went less than `gap` ago, else why it must not go at all."""
    if not it.get("gap"): return None
    done = lambda x, k: x.get(k) or results.get(x["id"], {}).get(k)
    mates = [x for x in every if x is not it and it.get("batch") and x.get("batch") == it["batch"]]
    earlier = [x for x in mates if x.get("seq", 0) < it.get("seq", 0)]
    if any(done(x, "failed") and not done(x, "sent") for x in earlier): return "the message before it did not go"
    if earlier: return "wait" if any(not done(x, "sent") for x in earlier) else None
    if any(done(x, "sent") for x in mates): return None
    return "wait" if now - paced_last(every, it, results) < it["gap"] else None


def send_due(token, user, now):
    every = items(token, user)
    due = sorted((it for it in every if not it.get("sent") and not it.get("failed") and it.get("at", 0) <= now),
                 key=lambda it: (it["at"], it.get("seq", 0)))
    results = {}
    # The files and text scheduled together with a held reply stay with it: one `batch` (Weft writes it; older
    # items: the later `seq` of the same room and time).
    held = {}
    group = lambda it: it.get("batch") or (it["room"], it["at"])
    sent = lambda x: x.get("sent") or results.get(x["id"], {}).get("sent")
    failed = lambda x: x.get("failed") or results.get(x["id"], {}).get("failed")
    queue, waited = list(due), set()
    while queue:
        it = queue.pop(0)
        pace = paced(every, it, results, now)
        if pace == "wait": continue  # next_due says when
        try:
            why = pace or (held.get(group(it)) if it.get("batch") or it.get("seq") else None) or held_reply(token, it)
            content = it["content"]
            if not why:
                # A part after the reply goes only once its reply went: never alone to the channel.
                cs = carriers(it, every)
                why = next((held_reply(token, c) for c in cs if not sent(c) and held_reply(token, c)), None)
                if not why and any(failed(c) and not sent(c) for c in cs):
                    why = "the reply it was scheduled with did not go"
                if not why and any(not sent(c) for c in cs):
                    # Its reply goes later (or later in this round): this part waits for it.
                    if it["id"] not in waited and any(c in queue for c in cs): waited.add(it["id"]); queue.append(it)
                    continue
                if not why and it.get("batch") and it.get("replyTo") and not cs:
                    # Its reply's part was taken off the list: this part answers instead of going without it.
                    content = {**content, "m.relates_to": {"m.in_reply_to": {"event_id": it["replyTo"]}}}
                if not why and orphan(it, every) and is_discord(token, it["room"]):
                    why = "its first part was cancelled, and it may belong to a Discord reply; send it again from Weft"
            if why:
                held[group(it)] = why
                results[it["id"]] = {"failed": now, "error": why}
                print(f"held {it['id']}: {why}", flush=True)
                continue
            r = call("PUT", f"/_matrix/client/v3/rooms/{q(it['room'])}/send/m.room.message/{q(it['id'])}", content, token=token)
            results[it["id"]] = {"sent": now, "event_id": r.get("event_id")}
            print(f"sent {it['id']}", flush=True)
        except HttpError as e:
            if e.status == 429 or e.status >= 500:
                break  # the server is busy: the same item goes out on the next round
            results[it["id"]] = {"failed": now, "error": e.body.get("error") or str(e)}
            print(f"failed {it['id']}: {e}", flush=True)
    if results:
        mark(token, user, results, now)


def next_due(token, user):
    every = items(token, user)
    open_ = [it for it in every if not it.get("sent") and not it.get("failed")]
    # A part waiting for its reply is due when that reply is.
    def when(it):
        at = max([it["at"]] + [c["at"] for c in carriers(it, every) if not c.get("sent") and not c.get("failed")])
        if not it.get("gap"): return at
        # A paced batch's first part is due `gap` after its network's last one, its later parts with it.
        earlier = [x for x in every if x is not it and it.get("batch") and x.get("batch") == it["batch"] and x.get("seq", 0) < it.get("seq", 0)]
        if earlier: return max([at] + [when(x) for x in earlier if not x.get("sent") and not x.get("failed")])
        return max(at, paced_last(every, it, {}) + it["gap"])
    waiting = [when(it) for it in open_]
    return min(waiting) if waiting else None


def main():
    token, user = login()
    flt = q(json.dumps({"presence": {"not_types": ["*"]}, "account_data": {"types": [KEY]}, "room": {"rooms": []}}))
    since = None
    print(f"waiting for scheduled messages of {user}", flush=True)
    while True:
        try:
            now = int(time.time() * 1000)
            send_due(token, user, now)
            due = next_due(token, user)
            left = None if due is None else due - int(time.time() * 1000)
            # Still waiting after its time means the server turned it away for now: try again in a while.
            wait = 30000 if left is None else 10000 if left <= 0 else min(30000, left)
            # /sync returns at once when the list changes, else after `wait`.
            r = call("GET", f"/_matrix/client/v3/sync?filter={flt}&timeout={wait}" + (f"&since={q(since)}" if since else ""), token=token, timeout=wait / 1000 + 30)
            since = r.get("next_batch", since)
        except HttpError as e:
            if e.status == 401:
                token, user = login()
            else:
                print(f"error: {e}", flush=True)
                time.sleep(10)
        except (OSError, ValueError) as e:
            print(f"error: {e}", flush=True)
            time.sleep(10)


if __name__ == "__main__":
    main()

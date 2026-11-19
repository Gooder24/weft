#!/usr/bin/env python3
"""Move explicitly enabled Gmail accounts' Promotions and Social messages to Trash.

Runs on the server, independently of any desktop. Dry-run unless --apply is given;
policy.json must also opt in each account. Never expunges or empties Trash.
"""
import argparse
import datetime
import fcntl
import imaplib
import importlib.util
import json
import os
from pathlib import Path
import re
import ssl
import sys

HERE = Path(__file__).resolve().parent
STATE = Path(os.environ.get("STATE_DIR", HERE / "state"))
QUERY = "{category:promotions category:social} -in:trash -in:spam -in:sent -in:drafts"
BATCH = 100


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def private_json(path, data):
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump(data, out, ensure_ascii=False, indent=2)
    tmp.replace(path)


def publish(report, apply):
    if apply:
        status = STATE / "cleanup-status.json"
        try:
            previous = json.loads(status.read_text())
            report["last_success"] = previous.get("last_success") if isinstance(previous, dict) else None
        except (OSError, ValueError):
            report["last_success"] = None
        if report["ok"]:
            report["last_success"] = report["checked_at"]
        private_json(status, report)
    print(json.dumps(report))


def ok(reply):
    if reply[0] != "OK":
        raise RuntimeError("IMAP command refused")
    return reply[1]


def mailbox(conn, flag):
    for row in ok(conn.list()):
        # Gmail LIST uses quoted, modified UTF-7 names. Return the quoted wire name
        # unchanged: no English folder names and no lossy decode/re-encode.
        match = re.fullmatch(rb'\(([^)]*)\) (?:"(?:[^"\\]|\\.)*"|NIL) (.+)', row or b"")
        if match and flag.encode() in match[1].split():
            return match[2].decode("ascii")
    raise RuntimeError("Required special-use mailbox missing")


def search(conn, query, uids=None):
    args = (["UID", b",".join(uids)] if uids else []) + ["X-GM-RAW", conn._quote(query)]
    return (ok(conn.uid("search", None, *args))[0] or b"").split()


def connect(creds):
    conn = imaplib.IMAP4_SSL("imap.gmail.com", ssl_context=ssl.create_default_context(), timeout=30)
    try:
        if "refresh_token" in creds:
            # Reuse the bridge's OAuth implementation without starting its checker.
            os.environ.setdefault("ADMIN_MXID", "@unused:localhost")
            spec = importlib.util.spec_from_file_location("weft_gmail_bridge", HERE / "bridge.py")
            bridge = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(bridge)
            token = bridge.token_request({"grant_type": "refresh_token", "refresh_token": creds["refresh_token"]})
            conn.authenticate("XOAUTH2", bridge.xoauth2(creds["email"], token["access_token"]))
        else:
            conn.login(creds["email"], creds["password"])
        return conn
    except Exception:
        conn.logout()
        raise


def clean(conn, apply, audit):
    caps = b" ".join(ok(conn.capability())).upper().split()
    if b"X-GM-EXT-1" not in caps or b"MOVE" not in caps:
        raise RuntimeError("Gmail search and atomic MOVE required")
    source, trash = mailbox(conn, "\\All"), mailbox(conn, "\\Trash")
    ok(conn.select(source, readonly=not apply))
    candidates = search(conn, QUERY)
    result = {"matched": len(candidates), "moved": 0, "remaining": len(candidates)}
    if not apply:
        return result
    for start in range(0, len(candidates), BATCH):
        # Restrict the mutation to fresh matches in this batch, never an open UID range.
        current = search(conn, QUERY, candidates[start:start + BATCH])
        if not current:
            continue
        rows = ok(conn.uid("fetch", b",".join(current), "(UID X-GM-MSGID FLAGS)"))
        entry = {"at": now(), "uids": [x.decode() for x in current],
                 "source": source, "trash": trash,
                 "metadata": [r.decode("ascii") for r in rows if isinstance(r, bytes)]}
        # Persist intent before MOVE so even a dropped response remains auditable.
        audit({**entry, "phase": "intent"})
        ok(conn.uid("move", b",".join(current), trash))
        audit({**entry, "phase": "moved"})
        result["moved"] += len(current)
    result["remaining"] = len(search(conn, QUERY))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(STATE / "cleanup.lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        try:
            policy = json.loads((STATE / "cleanup-policy.json").read_text())
            accounts = json.loads((STATE / "accounts.json").read_text())
            enabled = policy.get("enabled_accounts", [])
            if not isinstance(accounts, dict) or not isinstance(enabled, list) or not all(isinstance(x, str) for x in enabled):
                raise ValueError("Invalid account policy")
        except (OSError, ValueError, AttributeError) as exc:
            publish({"checked_at": now(), "applied": args.apply, "ok": False,
                     "configuration_error_type": type(exc).__name__, "accounts": []}, args.apply)
            return 1
        results = []
        failed = False
        for account in enabled:
            conn = None
            try:
                creds = accounts[account]
                conn = connect(creds)
                def audit(entry):
                    fd = os.open(STATE / "cleanup-audit.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
                    with os.fdopen(fd, "a") as out:
                        out.write(json.dumps({"account": account, **entry}) + "\n")
                        out.flush()
                        os.fsync(out.fileno())
                results.append({"account": account, "ok": True, **clean(conn, args.apply, audit)})
            except Exception as exc:
                # IMAP exceptions can contain authentication details: log class only.
                results.append({"account": account, "ok": False, "error_type": type(exc).__name__})
                failed = True
            finally:
                if conn:
                    try:
                        conn.logout()
                    except (OSError, imaplib.IMAP4.error):
                        pass
        report = {"checked_at": now(), "applied": args.apply, "ok": not failed, "query": QUERY, "accounts": results}
        publish(report, args.apply)
        return int(failed)


if __name__ == "__main__":
    sys.exit(main())

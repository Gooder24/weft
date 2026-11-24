#!/usr/bin/env python3
"""server/archive/estimate.py against made-up sources: a fake IMAP server, small exports, a fake archive.

    python3 tests/estimate/estimate_test.py
"""
import imaplib
import json
import socketserver
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "server/archive"))
import estimate  # noqa: E402

NOW = 1795521600000  # 2026-11-24 12:00 UTC
DAY = 86_400_000


class FakeIMAP(socketserver.StreamRequestHandler):
    """Just enough of Gmail's IMAP: All Mail with three mails, each answered by size and date only."""
    mails = [(11, 5_000, 10), (12, 2_000_000, 60), (13, 30_000, 500)]  # uid, size, days old
    seen = []

    def handle(self):
        self.wfile.write(b"* OK fake Gmail ready\r\n")
        for line in self.rfile:
            tag, _, rest = line.decode().rstrip("\r\n").partition(" ")
            FakeIMAP.seen.append(rest)
            cmd = rest.split(" ")[0].upper()
            out = []
            if cmd == "CAPABILITY": out.append("* CAPABILITY IMAP4rev1")
            elif cmd == "LIST":
                out += ['* LIST (\\HasNoChildren) "/" "INBOX"', '* LIST (\\All \\HasNoChildren) "/" "[Gmail]/All Mail"']
            elif cmd == "EXAMINE":
                out += [f"* {len(self.mails)} EXISTS", "* OK [UIDVALIDITY 7] ok"]
            elif cmd == "UID" and rest.upper().startswith("UID FETCH 1:* (RFC822.SIZE INTERNALDATE)"):
                for seq, (uid, size, days) in enumerate(self.mails, 1):
                    when = time.strftime("%d-%b-%Y %H:%M:%S +0000", time.gmtime((NOW - days * DAY) / 1000))
                    out.append(f'* {seq} FETCH (UID {uid} RFC822.SIZE {size} INTERNALDATE "{when}")')
            elif cmd == "LOGOUT":
                self.wfile.write(f"* BYE\r\n{tag} OK bye\r\n".encode())
                return
            elif cmd != "LOGIN":
                self.wfile.write(f"{tag} BAD not in this fake\r\n".encode())
                continue
            self.wfile.write("".join(o + "\r\n" for o in out + [f"{tag} OK done"]).encode())


class Estimate(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def test_periods_and_exactness(self):
        items = [estimate.Item("messenger", NOW - 5 * DAY, 10, 0, [1_000_000]),
                 estimate.Item("messenger", NOW - 100 * DAY, 10, 0, [None]),
                 estimate.Item("instagram", NOW - 400 * DAY, None, None, None)]
        r = estimate.summarize(items, now_ms=NOW)
        p = r["periods"]
        self.assertEqual([p[k]["total"]["messages"] for k in ("30", "90", "365", "all")], [1, 1, 2, 3])
        self.assertEqual(p["30"]["total"]["media_bytes"], 1_000_000)
        self.assertEqual(p["30"]["total"]["media_exact"], 1.0)
        self.assertEqual(p["30"]["total"]["archive_bytes"], estimate.OVERHEAD + 10)
        # A file of unknown size takes the network's measured size; a message that may have files, its share.
        self.assertEqual(p["365"]["total"]["media_bytes"], 1_000_000 + estimate.PROFILES["messenger"].file_bytes)
        ig = estimate.PROFILES["instagram"]
        self.assertEqual(p["all"]["networks"]["instagram"]["media_bytes"], round(ig.media_share * ig.files * ig.file_bytes))
        self.assertEqual(p["all"]["networks"]["instagram"]["media_exact"], 0.0)
        self.assertEqual(r["oldest"]["instagram"], NOW - 400 * DAY)
        self.assertIn("celá história: 3 správ", estimate.text(r))

    def test_gmail_reads_sizes_only(self):
        FakeIMAP.seen = []
        server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), FakeIMAP)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            conn = imaplib.IMAP4("127.0.0.1", server.server_address[1])
            conn.login("someone@example.com", "x")
            items = list(estimate.from_gmail(conn))
            conn.logout()
        finally:
            server.shutdown()
        self.assertEqual(sorted(round((NOW - i.ts) / DAY) for i in items), [10, 60, 500])
        big = [i for i in items if i.media]
        self.assertEqual(len(big), 1)
        self.assertEqual(big[0].media[0], (2_000_000 - estimate.PROFILES["gmail"].body - 4_000) * 3 // 4)
        sent = " ".join(FakeIMAP.seen).upper()
        # Read-only (EXAMINE, never SELECT), and no mail body, flag or move is ever asked for.
        self.assertIn("EXAMINE", sent)
        for word in ("SELECT", "BODY", "STORE", "COPY", "MOVE", "EXPUNGE", "RFC822 ", "RFC822)"):
            self.assertNotIn(word, sent)
        r = estimate.summarize(items, now_ms=NOW)
        self.assertEqual(r["periods"]["90"]["total"]["messages"], 2)

    def test_messenger_export_sizes_from_zip(self):
        z = self.tmp / "messages.zip"
        thread = {"threadName": "Skupina", "participants": ["A", "B"], "messages": [
            {"senderName": "A", "timestamp": NOW - DAY, "text": "ahoj", "media": [{"uri": "media/p.jpg"}]},
            {"senderName": "B", "timestamp": NOW - 200 * DAY, "text": "", "isUnsent": True, "media": []},
            {"senderName": "B", "timestamp": NOW - 2 * DAY, "text": "x", "media": [{"uri": "Failed to download media"}]}]}
        with zipfile.ZipFile(z, "w") as f:
            f.writestr("1.json", json.dumps(thread))
            f.writestr("media/p.jpg", b"\0" * 12_345)
        items = list(estimate.from_messenger([z]))
        self.assertEqual(len(items), 3)
        r = estimate.summarize(items, now_ms=NOW)["periods"]
        self.assertEqual(r["30"]["total"]["media_files"], 1)
        self.assertEqual(r["30"]["total"]["media_bytes"], 12_345)
        self.assertEqual(r["30"]["total"]["media_exact"], 1.0)
        self.assertEqual(r["all"]["total"]["messages"], 3)

    def test_instagram_export_sizes_from_zip(self):
        z = self.tmp / "ig.zip"
        msgs = {"title": "Niekto", "participants": [{"name": "Niekto"}], "messages": [
            {"sender_name": "Niekto", "timestamp_ms": NOW - 3 * DAY, "content": "pozri",
             "photos": [{"uri": "your_instagram_activity/messages/inbox/niekto_1/photos/a.jpg"}]},
            {"sender_name": "Niekto", "timestamp_ms": NOW - 3 * DAY + 1, "content": "Niekto liked a message"}]}
        with zipfile.ZipFile(z, "w") as f:
            f.writestr("your_instagram_activity/messages/inbox/niekto_1/message_1.json", json.dumps(msgs))
            f.writestr("your_instagram_activity/messages/inbox/niekto_1/photos/a.jpg", b"\0" * 4_000)
        items = list(estimate.from_instagram([z]))
        self.assertEqual(len(items), 1)  # a reaction is no message, as archive.py imports it
        self.assertEqual(items[0].media, [4_000])

    def test_archive_and_calibration(self):
        db = self.tmp / "archive.db"
        c = sqlite3.connect(db)
        c.executescript("""
          CREATE TABLE chats (id TEXT PRIMARY KEY, network TEXT, title TEXT, room TEXT, source TEXT NOT NULL);
          CREATE TABLE messages (id TEXT PRIMARY KEY, chat TEXT NOT NULL, ts INTEGER NOT NULL, sender TEXT NOT NULL, me INTEGER NOT NULL, body TEXT NOT NULL);
          CREATE TABLE message_media (message TEXT NOT NULL, position INTEGER NOT NULL, path TEXT, kind TEXT NOT NULL, mime TEXT NOT NULL,
            bytes INTEGER, original_uri TEXT NOT NULL, w INTEGER, h INTEGER, duration INTEGER, thumb TEXT, PRIMARY KEY (message, position));
          CREATE TABLE history_data (message TEXT PRIMARY KEY, network TEXT NOT NULL, account TEXT NOT NULL, chat TEXT NOT NULL, remote_id TEXT NOT NULL, raw TEXT NOT NULL);
          INSERT INTO chats VALUES ('c', 'discord', 't', NULL, 'history');""")
        for i in range(300):
            c.execute("INSERT INTO messages VALUES (?, 'c', ?, 's', 0, ?)", (f"m{i}", NOW - i * DAY, "x" * 20))
            c.execute("INSERT INTO history_data VALUES (?, 'discord', 'a', 'c', ?, ?)", (f"m{i}", str(i), "r" * 100))
        for i in range(0, 300, 5):  # every fifth has a photo; half of them not fetched yet
            c.execute("INSERT INTO message_media VALUES (?, 0, ?, 'image', 'image/jpeg', 50000, 'u', NULL, NULL, NULL, NULL)",
                      (f"m{i}", None if i % 10 else f"discord/{i}.jpg"))
        c.commit()
        c.close()
        r = estimate.summarize(estimate.from_archive(db), now_ms=NOW)["periods"]["all"]["total"]
        self.assertEqual((r["messages"], r["media_files"], r["media_bytes"]), (300, 30, 30 * 50_000))
        profiles, overhead = estimate.calibrate(db)
        d = profiles["discord"]
        self.assertEqual((d.body, d.raw, d.media_share, d.file_bytes), (20, 100, 0.1, 50_000))
        self.assertGreater(overhead, 0)

    def test_beeper(self):
        try:
            import import_beeper  # noqa: F401  (the Beeper import; the estimate reads its network names)
        except ImportError:
            self.skipTest("server/archive/import_beeper.py is not here")
        folder = self.tmp / "BeeperTexts"
        (folder / "media/local.beeper.com").mkdir(parents=True)
        (folder / "media/local.beeper.com/abc").write_bytes(b"\0" * 777)
        c = sqlite3.connect(folder / "index.db")
        c.executescript("""CREATE TABLE threads (threadID TEXT, accountID TEXT, thread TEXT);
          CREATE TABLE mx_room_messages (roomID TEXT, id INTEGER, eventID TEXT, type TEXT, timestamp INTEGER, message TEXT,
            isDeleted INTEGER, isSentByMe INTEGER, senderContactID TEXT);""")
        c.execute("INSERT INTO threads VALUES ('!r', 'wa', ?)", (json.dumps({"extra": {"bridge": {"protocol": {"id": "whatsapp"}}}}),))
        rows = [("TEXT", NOW - DAY, {"text": "ahoj"}), ("IMAGE", NOW - 2 * DAY, {"text": "", "attachments": [{"srcURL": "mxc://local.beeper.com/abc?k=1"}]}),
                ("REACTION", NOW - DAY, {"text": "x"})]
        for i, (kind, ts, msg) in enumerate(rows):
            c.execute("INSERT INTO mx_room_messages VALUES ('!r', ?, ?, ?, ?, ?, 0, 0, 'p')", (i, f"$e{i}", kind, ts, json.dumps(msg)))
        c.commit()
        c.close()
        items = list(estimate.from_beeper(folder))
        self.assertEqual([(i.network, i.media) for i in items], [("whatsapp", []), ("whatsapp", [777])])


if __name__ == "__main__":
    unittest.main(verbosity=2)

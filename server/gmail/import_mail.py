#!/usr/bin/env python3
"""Resumable read-only Gmail archive. No mailbox flags, sends, moves or deletes."""
import email.policy
import email.utils
from email.parser import BytesParser
import hashlib
import os
import mimetypes
import urllib.parse
import json
import re
import sqlite3
import time
import traceback
from pathlib import Path
import importlib.util
spec = importlib.util.spec_from_file_location('gmail_cleanup', Path(__file__).resolve().with_name('cleanup.py'))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)

ROOT = Path.home() / 'matrix-spike'


def decode_message(raw, fallback):
    msg = BytesParser(policy=email.policy.default).parsebytes(raw)
    body = msg.get_body(preferencelist=('plain', 'html'))
    try:
        text = body.get_content() if body else ''
    except (LookupError, UnicodeError):
        text = (body.get_payload(decode=True) or b'').decode('utf-8', errors='replace')
    if body and body.get_content_type() == 'text/html':
        import html
        text = html.unescape(re.sub('<[^>]+>', ' ', text))
    attachments = [p.get_filename() for p in msg.iter_attachments() if p.get_filename()]
    subject = str(msg.get('Subject', '(bez predmetu)'))
    sender = str(msg.get('From', 'Gmail'))
    try:
        date = email.utils.parsedate_to_datetime(msg.get('Date', ''))
        ts = int(date.timestamp() * 1000)
    except (TypeError, ValueError, OverflowError):
        ts = fallback
    return subject, sender, ts, subject + '\n\n' + str(text) + ''.join('\n[Príloha: ' + x + ']' for x in attachments)


def store_attachments(db, message, raw):
    """Content-addressed files, committed before their rows; reruns never duplicate an attachment."""
    msg = BytesParser(policy=email.policy.default).parsebytes(raw)
    folder = ROOT / 'archive/media/gmail'
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    for position, part in enumerate(msg.walk()):
        name = part.get_filename()
        if not name and part.get_content_disposition() != 'attachment': continue
        payload = part.get_payload(decode=True)
        if payload is None and part.get_content_type() == 'message/rfc822':
            payload = b'\n'.join(p.as_bytes() for p in part.get_payload())
        if payload is None: continue
        mime = part.get_content_type()
        suffix = mimetypes.guess_extension(mime) or '.bin'
        digest = hashlib.sha256(payload).hexdigest()
        path = folder / (digest + suffix)
        if not path.exists():
            tmp = folder / (digest + '.tmp')
            with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'wb') as out:
                out.write(payload)
            tmp.replace(path)
        kind = mime.split('/')[0] if mime.split('/')[0] in ('image', 'video', 'audio') else 'file'
        uri = 'gmail-attachment/' + urllib.parse.quote(name or ('attachment' + suffix), safe='')
        db.execute('INSERT INTO message_media (message,position,path,kind,mime,bytes,original_uri) VALUES (?,?,?,?,?,?,?) '
            'ON CONFLICT(message,position) DO UPDATE SET path=excluded.path,kind=excluded.kind,mime=excluded.mime,bytes=excluded.bytes,original_uri=excluded.original_uri',
            (message, position, str(path.relative_to(ROOT / 'archive/media')), kind, mime, len(payload), uri))


def is_draft(meta):
    """A mail still being written (Gmail's Drafts, also every autosaved version in All Mail): never history."""
    labels = re.search(rb'X-GM-LABELS \(([^)]*)\)', meta)
    return bool(labels and re.search(rb'(^|\s)"?\\\\?Draft"?(\s|$)', labels[1])) or bool(re.search(rb'FLAGS \([^)]*\\Draft', meta))


def store_message(db, account, validity, uid, meta, raw):
    if is_draft(meta):  # read again once sent: Gmail gives the sent mail a new UID
        db.execute('INSERT OR IGNORE INTO gmail_media_import VALUES (?,?,?)', (account, validity, int(uid)))
        db.execute('INSERT OR IGNORE INTO gmail_import VALUES (?,?,?)', (account, validity, int(uid)))
        return None
    ident = re.search(rb'X-GM-MSGID (\d+)', meta)
    thread = re.search(rb'X-GM-THRID (\d+)', meta)
    if not ident or not thread: raise ValueError('Gmail identity missing')
    stamp = __import__('imaplib').Internaldate2tuple(meta)
    fallback = int(time.mktime(stamp) * 1000) if stamp else int(time.time()*1000)
    subject, sender, ts, body = decode_message(raw, fallback)
    prefix = 'gmail:' + hashlib.sha256(account.encode()).hexdigest()[:20] + ':'
    chat = prefix + thread[1].decode()
    message = prefix + ident[1].decode()
    db.execute("INSERT INTO chats VALUES (?, 'gmail', ?, ?, 'gmail') ON CONFLICT(id) DO NOTHING", (chat, account + ' · ' + subject, 'archive:' + chat))
    db.execute('INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?)', (message, chat, ts, sender, int(email.utils.parseaddr(sender)[1].lower() == account.lower()), body))
    store_attachments(db, message, raw)
    db.execute('INSERT OR IGNORE INTO gmail_media_import VALUES (?,?,?)', (account, validity, int(uid)))
    db.execute('INSERT OR IGNORE INTO gmail_import VALUES (?,?,?)', (account, validity, int(uid)))
    return message


def import_attachments(conn, db, account, validity, limit=20):
    # Old messages have already been read for text. Ask Gmail only for attachment-bearing mail.
    uids = cleanup.search(conn, 'has:attachment')
    done = {str(uid).encode() for uid, in db.execute(
        'SELECT uid FROM gmail_media_import WHERE account=? AND validity=?', (account, validity))}
    pending = [uid for uid in reversed(uids) if uid not in done]
    print(json.dumps({'account_id': hashlib.sha256(account.encode()).hexdigest()[:8], 'attachment_messages_pending': len(pending)}), flush=True)
    for uid in pending[:limit]:
        rows = cleanup.ok(conn.uid('fetch', uid, '(UID X-GM-MSGID X-GM-THRID X-GM-LABELS FLAGS INTERNALDATE BODY.PEEK[])'))
        found = False
        for row in rows:
            if not isinstance(row, tuple): continue
            ident = re.search(rb'X-GM-MSGID (\d+)', row[0])
            if not ident: raise ValueError('Gmail identity missing')
            message = 'gmail:' + hashlib.sha256(account.encode()).hexdigest()[:20] + ':' + ident[1].decode()
            with db:
                if is_draft(row[0]):
                    pass
                elif not db.execute('SELECT 1 FROM messages WHERE id=?', (message,)).fetchone():
                    store_message(db, account, validity, uid, *row)
                else:
                    store_attachments(db, message, row[1])
                db.execute('INSERT OR IGNORE INTO gmail_media_import VALUES (?,?,?)', (account, validity, int(uid)))
            found = True
        if not found: continue  # vanished UIDs disappear from the next Gmail search
        time.sleep(.1)
    return len(pending) > limit


def collect(creds, db):
    account = creds['email']
    conn = cleanup.connect(creds)
    try:
        cleanup.ok(conn.select(cleanup.mailbox(conn, '\\All'), readonly=True))
        validity = conn.response('UIDVALIDITY')[1][0].decode()
        uids = (cleanup.ok(conn.uid('search', None, 'ALL'))[0] or b'').split()
        saved = {str(x[0]).encode() for x in db.execute('SELECT uid FROM gmail_import WHERE account=? AND validity=?', (account, validity))}
        remaining = [uid for uid in reversed(uids) if uid not in saved]
        print(json.dumps({'account_id': hashlib.sha256(account.encode()).hexdigest()[:8], 'total': len(uids), 'remaining': len(remaining)}), flush=True)
        for uid in remaining[:100]:
            rows = cleanup.ok(conn.uid('fetch', uid, '(UID X-GM-MSGID X-GM-THRID X-GM-LABELS FLAGS INTERNALDATE BODY.PEEK[])'))
            for row in rows:
                if not isinstance(row, tuple): continue
                with db:
                    store_message(db, account, validity, uid, *row)
            time.sleep(.1)
        media_pending = import_attachments(conn, db, account, validity)
        return max(0, len(remaining) - 100) or media_pending
    finally:
        conn.logout()


def main():
    db = sqlite3.connect(ROOT / 'archive/archive.db', timeout=60)
    db.execute('CREATE TABLE IF NOT EXISTS gmail_import (account TEXT, validity TEXT, uid INTEGER, PRIMARY KEY(account,validity,uid))')
    db.execute('CREATE TABLE IF NOT EXISTS gmail_media_import (account TEXT, validity TEXT, uid INTEGER, PRIMARY KEY(account,validity,uid))')
    while True:
        pending = False
        failed = False
        for creds in json.loads((cleanup.STATE / 'accounts.json').read_text()).values():
            try: pending = bool(collect(creds, db)) or pending
            except Exception as err:
                failed = True
                print(json.dumps({'error': type(err).__name__, 'errno': getattr(err, 'errno', None), 'function': traceback.extract_tb(err.__traceback__)[-1].name}), flush=True)
        print('Gmail pass finished', flush=True)
        time.sleep(60 if failed else 5 if pending else 300)


if __name__ == '__main__': main()

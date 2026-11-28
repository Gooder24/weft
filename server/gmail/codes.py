"""One-time codes in a mail: find_code(subject, text) gives the code ("482913", "G-482913", "A7K2PQ") or None.

Only a code that something calls a code counts: a keyword (code, kód, verification, one-time, PIN…) in the
subject or right before the number. Discount codes, order and phone numbers, sums, dates and years do not.
A parcel locker's or pickup point's code (Packeta: "Kód pre otvorenie schránky", "Heslo pre vydanie zásielky") counts too.
"""
import email.policy
import hashlib
import email.utils
import html
import imaplib
import math
import os
import re
import select
import ssl
import threading
import time
from email.parser import BytesParser

KEYWORD = re.compile(
    r"\bcodes?\b|\bpasscode\b|\botp\b|\bpin\b|\b2fa\b|\bverif\w*|\bone[- ]time\b"
    r"|\bk[oó]d\w*|\boverova\w*|\boveren\w*|\bpotvrdzova\w*|\bpotvrzova\w*|\bjednoraz\w*|\bprihlasova\w*"
    r"|\bověřov\w*|\bbest[äa]tigungs\w*|\bsicherheitscode\w*|\bc[oó]digo\w*|\bcodice\w*",
    re.I,
)
# Words that make a "code" something else: shopping, tracking, places.
NOT_OTP = re.compile(
    r"zľav\w*|zlav\w*|sleva\w*|slev\w*|discount|coupon|kup[oó]n\w*|promo\w*|voucher|gift|darček\w*|rabatt\w*|"
    r"tracking|sledovan\w*|zásielk\w*|zasielk\w*|parcel|package|order|objedn\w*|faktúr\w*|invoice|"
    r"postal|zip|psč|poštov\w*|qr|iban|swift|referral|booking|rezerv\w*|reservation|ticket|letenk\w*|vstupenk\w*|"
    r"zákazník\w*|zakaznik\w*|customer|klient\w*|client|transakc\w*|transaction|platb\w*|payment|doklad\w*|"
    r"referen\w*|variabil\w*|symbol\w*|account number|checkout|\bsave\b|ušetr\w*|nákup\w*|"
    r"deliver\w*|courier|kuriér\w*|doruč\w*|vyzdvihn\w*|pickup",
    re.I,
)
# Keywords that only a one-time code wears: right before a number they win over NOT_OTP ("use verification
# code 481750 to approve the payment" is a code, "use code 683451 at checkout" is not).
STRONG = re.compile(
    r"\bverif\w*|\bone[- ]time\b|\botp\b|\b2fa\b|\bpasscode\b|\bsecurity code|\boverova\w*|\boveren\w*"
    r"|\bpotvrdzova\w*|\bpotvrzova\w*|\bjednoraz\w*|\bověřov\w*|\bbezpečnostn\w* k[oó]d|\bbest[äa]tigungs\w*"
    r"|\bsicherheitscode\w*",
    re.I,
)
# A candidate: digits (4–8, or 3+3 split by a space or dash, or a letter prefix like G-123456),
# or 6–8 capitals and digits mixed.
CANDIDATE = re.compile(
    r"(?<![\w+€$£#./:,-])(?<!\d )"
    r"(?P<code>[A-Z]{1,3}-[0-9]{4,8}|[0-9]{3}[ -][0-9]{3}|[0-9]{4,8}|(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8})"
    r"(?![\w€$£%/:-]|[.,]\d| \d| ?(?:€|eur|kč|czk|usd|\$|%|ks|min|km|kg|m\b|h\b))",
    re.I,
)
# A parcel's pickup code: what follows these words is the code, though the mail is all about a parcel. Packeta prints
# its six-digit Z-BOX code one digit per line or cell; another lone digit after them means no code. The code is a whole
# token, case-sensitive and with a digit, so a word ("alebo", "ALEBO") or a date after the label never is one. It is
# only looked for when the mail has no other code.
_DIGIT = r"[0-9](?=\s|$)"
PICKUP = re.compile(
    r"(?i:k[oó]d\s+pr[eo]\s+(?:otvorenie|otevření)\s+schránky|heslo\s+pr[eo]\s+(?:vydanie|vydání)\s+(?:zásielky|zásilky)"
    r"|vyzdvihnúť\s+pomocou\s+mobilnej\s+aplikácie\s+alebo\s+kódu)\s*(?:je\s*)?:?\s*"
    rf"(?P<code>{_DIGIT}(?:\s+{_DIGIT}){{5}}(?!\s+{_DIGIT})|(?=[A-Z0-9]*[0-9])[A-Z0-9]{{4,8}}(?![\w-]|[./:]\w))"
)
# A label alone on its line with the code alone on the next one ("Login Code" / "5PJF5", Steam's five characters).
# Under such a label a code of capitals only counts when it has no vowel (Steam's alphabet has none), so a word in
# capitals never is one.
LABELED = re.compile(r"(?m)^(?P<label>[^\d\n]{1,40})\n[ \t]*(?P<code>[A-Z0-9]{5,8})[ \t]*$")
# The label has to name a code itself ("Login Code", "Přihlašovací kód"), not only talk about verifying something.
LABEL_WORD = re.compile(r"\b(?:code|k[oó]d|pin|otp|passcode)\b", re.I)
# A number right after these is a phone number to call, whatever the mail is about.
PHONE = re.compile(r"\bcall\b|\bzavolaj\w*|\bvolajte\b|\bphone\b|\btelef\w*|\btel\b|\bhotline\b|\blink[au]\b|\bmobil\w*", re.I)
NEAR = 80  # how far before a code its keyword may be (characters)


def plain(text: str) -> str:
    """Mail text without HTML, links and runs of blank space."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")  # plain parts mostly come with CRLF
    text = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", text)
    # The quoted earlier mail of a reply (Gmail's and others' HTML): it is cut off up to its end.
    while True:  # innermost first, so a nested quote goes whole and text between two quotes stays
        text, n = re.subn(r"(?is)<blockquote\b(?:(?!<blockquote\b).)*?</blockquote>", " ", text)
        if not n:
            break
    text = re.sub(r"(?i)<br\s*/?>|</(p|div|tr|td|h\d|li|table)>", "\n", text)
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    text = re.sub(r"(?m)^\s*>.*$", " ", text)  # quoted lines of an earlier mail in a reply
    text = re.sub(r"\bhttps?://\S+|\bwww\.\S+|\S+@\S+\.\w+", " ", text)
    text = re.sub(r"[ \t ​]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n", text).strip()


def _plausible(code: str, before: str = "") -> bool:
    digits = re.sub(r"\D", "", code)
    if code.isdigit() and len(code) == 4 and 1900 <= int(code) <= 2099 and not re.search(
            r"\b(pin|code|k[oó]d|passcode)\s*(is|je|:)?\s*$", before, re.I):
        return False  # a year, unless it is what "PIN is" or "kód:" introduces
    if digits and len(set(digits)) == 1 and len(digits) >= 6:
        return False  # 000000, a placeholder
    if not code.isdigit() and not re.search(r"\d", code):
        return False
    if re.fullmatch(r"[A-Za-z0-9]{6,8}", code) and not code.isupper() and not code.isdigit():
        return False  # mixed-case words are words
    return True


def find_code(subject: str, text: str) -> str | None:
    subject = plain(subject or "")
    body = plain(text or "")[:6000]
    subject_says = bool(KEYWORD.search(subject)) and not NOT_OTP.search(subject)
    best = None
    for where, source in ((0, subject), (1, body)):
        for m in CANDIDATE.finditer(source):
            code = m.group("code")
            if not _plausible(code, source[max(0, m.start() - 20):m.start()]):
                continue
            # Letters and digits mixed are mostly order or booking numbers: only one alone on its line counts.
            if not re.fullmatch(r"\d+|\d{3}[ -]\d{3}|[A-Z]{1,3}-\d+", code) and not _alone(source, m):
                continue
            before = source[max(0, m.start() - NEAR):m.start()]
            after = source[m.end():m.end() + 40]
            around = before[-40:] + " " + after
            # A strong keyword counts only with no shopping word between it and the code ("verification … promo code").
            if PHONE.search(before[-25:]):
                continue
            strong = [x for x in STRONG.finditer(before[-40:])]
            strong = bool(strong) and not NOT_OTP.search(before[-40:][strong[-1].end():])
            if NOT_OTP.search(around) and not strong:
                continue
            near = list(KEYWORD.finditer(before))
            # "123456 is your code": the keyword may also follow closely.
            follows = KEYWORD.search(after[:30]) if not near else None
            if not near and not follows and not (subject_says and where == 1 and _alone(source, m)):
                continue
            if near and not strong and NOT_OTP.search(before[near[-1].start() - 20 if near[-1].start() >= 20 else 0:]):
                continue
            distance = (len(before) - near[-1].end()) if near else 30
            score = (
                (3 if _alone(source, m) else 0)
                + (2 if len(re.sub(r"\D", "", code)) == 6 else 0)
                + (1 if code.isdigit() or re.fullmatch(r"\d{3}[ -]\d{3}|[A-Z]{1,3}-\d+", code) else 0)
                + (1 if where == 1 else 0)
                - distance / 40
            )
            if best is None or score > best[0]:
                best = (score, code)
    for m in LABELED.finditer(body):
        label, code = m.group("label").strip(" :\t"), m.group("code")
        if not LABEL_WORD.search(label) or len(label.split()) > 4 or NOT_OTP.search(label):
            continue
        if not _plausible(code) and not re.fullmatch(r"[B-DF-HJ-NP-TV-Z]{5,8}", code):
            continue
        if code.isdigit() or (best is not None and best[0] >= 4):
            continue  # digits are the candidates' own; a better one already won
        best = (4, code)
    if best is None and (pickup := PICKUP.search(body)):
        return re.sub(r"\s", "", pickup.group("code"))
    return best[1] if best else None


def _alone(source: str, m: re.Match) -> bool:
    """The code stands on its own line (perhaps after a colon), as code mails print it."""
    start = source.rfind("\n", 0, m.start()) + 1
    end = source.find("\n", m.end())
    line = source[start:end if end >= 0 else len(source)]
    rest = (line[:m.start() - start] + line[m.end() - start:]).strip(" :.-–\t*")
    return len(rest) <= 2 or bool(re.fullmatch(r"[^\d\n]{0,40}:", line[:m.start() - start].strip()))


# ---------------------------------------------------------------- watching INBOX for them

MODES = ("popup", "notify", "off")  # Weft shows a window; a window and a system notification; nothing
DEFAULT_MODE = "popup"
TTL = 10 * 60  # a code older than this has most likely expired, so Weft stops showing it
FRESH = 15 * 60  # mail that came longer ago than this is not a code to show (Gmail delivered it late)
# On the bridge's start (or a new UIDVALIDITY) mail of the last two minutes is still looked at, so a code that
# came during a restart is not missed; one closed before it shows again only in a Weft opened after it.
START_BACK = 120
BACK_MAILS = 50  # at most this many of them
IDLE_SECONDS = int(os.environ.get("CODES_IDLE_SECONDS", 4 * 60))  # one IDLE; Gmail drops quiet ones after ~10 min
RECONNECT_SECONDS = int(os.environ.get("CODES_RECONNECT_SECONDS", 25 * 60))  # a fresh connection (and token)
RETRY_SECONDS = int(os.environ.get("CODES_RETRY_SECONDS", 30))
MAX_FETCH = 65536


class AuthFailed(Exception):
    """Gmail refused the stored login; the watcher stops until the login is checked or replaced."""


class Store:
    """The codes of the last TTL seconds, in memory only (never on disk). seq changes with every new or
    dismissed code, so a waiting Weft wakes; it starts from the clock, so a restart never repeats a number."""

    def __init__(self):
        self.cond = threading.Condition()
        self.seq = int(time.time() * 1000)
        self.items: list[dict] = []
        self.on_new = None  # called with each new code, outside the lock (Web Push)

    def _prune(self) -> None:
        now = time.time()
        self.items = [x for x in self.items if now - x["at"] / 1000 < TTL]

    def add(self, item: dict) -> bool:
        with self.cond:
            self._prune()
            if any(x["login"] == item["login"] and x["mail"] == item["mail"] for x in self.items):
                return False  # the same mail seen again after a reconnect
            self.seq += 1
            # The id follows the mail, so a Weft that closed a code before a restart of the bridge still knows it.
            code_id = hashlib.sha256(f"{item['login']}|{item['mail']}".encode()).hexdigest()[:16]
            self.items.append({**item, "id": code_id, "dismissed": False})
            self.cond.notify_all()
        if self.on_new:
            self.on_new(item)
        return True

    def dismiss(self, code_id: str) -> bool:
        with self.cond:
            for x in self.items:
                if x["id"] == code_id and not x["dismissed"]:
                    x["dismissed"] = True
                    self.seq += 1
                    self.cond.notify_all()
                    return True
            return any(x["id"] == code_id for x in self.items)

    def changed(self) -> None:
        """Something outside changed what is shown (an account's mode); waiting Wefts ask again."""
        with self.cond:
            self.seq += 1
            self.cond.notify_all()

    def wait(self, since: int, timeout: float) -> tuple[int, list[dict]]:
        with self.cond:
            self.cond.wait_for(lambda: self.seq != since, timeout)
            self._prune()
            return self.seq, [dict(x) for x in self.items]


def idle(conn: imaplib.IMAP4, seconds: float) -> bool:
    """One IMAP IDLE (RFC 2177) on the selected mailbox: True once Gmail says the mailbox grew, False when
    the window ends quietly. imaplib before Python 3.14 has no idle(), so this speaks it through imaplib's
    own line reader. ready() looks into imaplib's buffer before select() waits on the socket, so a line
    already read from the network is never left waiting; there is no read timeout, which would break
    imaplib's file for good."""
    tag = conn._new_tag()
    conn.tagged_commands.pop(tag, None)  # answered here, not through imaplib
    conn.send(tag + b" IDLE\r\n")
    grew = False
    while not (first := _line(conn)).startswith(b"+"):  # untagged news may come before the go-ahead
        if not first.startswith(b"*"):
            raise imaplib.IMAP4.abort("IDLE refused")
        grew = grew or first.rstrip().upper().endswith(b"EXISTS")
    end = time.monotonic() + seconds
    while not grew:
        left = end - time.monotonic()
        if left <= 0:
            break
        if not ready(conn) and not select.select([conn.sock], [], [], left)[0]:
            break
        line = _line(conn)
        if line.startswith(b"* BYE"):
            raise imaplib.IMAP4.abort("Gmail closed the IDLE")
        grew = line.startswith(b"*") and line.rstrip().upper().endswith(b"EXISTS")
    conn.send(b"DONE\r\n")
    while True:
        line = _line(conn)
        if line.startswith(tag + b" "):
            if not line[len(tag) + 1:].upper().startswith(b"OK"):
                raise imaplib.IMAP4.abort("IDLE ended badly")
            return grew
        if line.startswith(b"* BYE"):
            raise imaplib.IMAP4.abort("Gmail closed the IDLE")


def ready(conn: imaplib.IMAP4) -> bool:
    """Whether a line can be read without waiting: in imaplib's buffer (which select() cannot see), in the TLS
    layer, or on the socket. A non-blocking peek reads only what is already there."""
    if conn.sock.pending():
        return True
    old = conn.sock.gettimeout()
    try:
        conn.sock.settimeout(0.0)
        return bool(conn.file.peek(1))
    except (ssl.SSLWantReadError, BlockingIOError):
        return False
    finally:
        conn.sock.settimeout(old)


def _line(conn: imaplib.IMAP4) -> bytes:
    line = conn.readline()
    if not line:  # imaplib's readline gives b"" when Gmail closed the connection
        raise imaplib.IMAP4.abort("connection closed")
    return line


def read_mail(raw: bytes) -> tuple[str, str, str, str]:
    """(sender name, sender address, subject, text) of a mail, also of one cut off after MAX_FETCH bytes."""
    msg = BytesParser(policy=email.policy.default).parsebytes(raw)
    name, address = email.utils.parseaddr(str(msg.get("From", "")))
    texts = []
    for kind in ("plain", "html"):
        try:
            part = msg.get_body(preferencelist=(kind,))
            if part is not None:
                texts.append(str(part.get_content()))
        except (LookupError, UnicodeError, ValueError, KeyError):
            continue
    if not texts and not msg.is_multipart():
        texts.append((msg.get_payload(decode=True) or b"").decode("utf-8", errors="replace"))
    return name, address, str(msg.get("Subject", "")), "\n".join(texts)


def login_of(creds: dict) -> tuple:
    return creds.get("email"), creds.get("password"), creds.get("refresh_token")


class Watchers:
    """One thread per Gmail account whose codes are wanted: an IDLE connection on INBOX, read-only (EXAMINE,
    BODY.PEEK; nothing in the mailbox changes). wanted(key) -> creds or None decides, login(creds) signs in."""

    def __init__(self, wanted, login, store: Store, log):
        self.wanted, self.login, self.store, self.log = wanted, login, store, log
        self.lock = threading.Lock()
        self.threads: dict[str, threading.Thread] = {}
        # Where each account's watch got to, (UIDVALIDITY, last UID), so mail that came while the connection
        # was down is still looked at after the reconnect.
        self.marks: dict[str, tuple[str, int]] = {}
        # Accounts switched off since this process started: mail that came before they were back on (inf while
        # still off) is never shown, also when off and on again fell into one IDLE of a running watch.
        self.since: dict[str, float] = {}

    def forget(self, key: str) -> None:
        """The account was switched off or removed: what comes until it is back on is never shown."""
        with self.lock:
            self.marks.pop(key, None)
            self.since[key] = math.inf

    def back_on(self, key: str) -> None:
        """The account's codes were switched on again: mail from now on counts."""
        with self.lock:
            if self.since.get(key) == math.inf:
                self.since[key] = time.time()

    def sync(self, keys) -> None:
        """Starts a watcher for each wanted account that has none (after a change, and on every login check)."""
        with self.lock:
            for key in keys:
                if key not in self.threads and self.wanted(key):
                    self.threads[key] = threading.Thread(target=self.run, args=(key,), name="codes", daemon=True)
                    self.threads[key].start()

    def run(self, key: str) -> None:
        wait = RETRY_SECONDS
        refused = None  # the login Gmail refused; a new one (signed in again) is tried at once
        while True:
            creds = self.wanted(key)
            if not creds or login_of(creds) == refused:
                with self.lock:  # decided under the lock sync() holds, so a change meanwhile is never missed
                    creds = self.wanted(key)
                    if not creds or login_of(creds) == refused:
                        self.threads.pop(key, None)
                        if not creds:
                            self.marks.pop(key, None)  # switched on again later, it starts from then
                            self.since[key] = math.inf
                        return
            watching = []  # one item once INBOX is open: a dropped watch is retried at once, a failing one ever later
            try:
                self.session(key, creds, watching)
                wait = RETRY_SECONDS
            except AuthFailed:
                self.log("codes: login refused, waiting for the next login check")
                refused = login_of(creds)
            except Exception as err:  # Gmail away, connection dropped: again later, waiting longer each time
                self.log("codes: watch failed:", type(err).__name__)
                if watching:
                    wait = RETRY_SECONDS
                time.sleep(wait)
                wait = min(wait * 2, 600)

    def session(self, key: str, creds: dict, watching: list) -> None:
        conn = self.login(creds)
        try:
            ok, _ = conn.select("INBOX", readonly=True)
            if ok != "OK":
                raise imaplib.IMAP4.abort("no INBOX")
            validity = (conn.response("UIDVALIDITY")[1] or [b""])[0]
            nxt = conn.response("UIDNEXT")[1]
            mark = self.marks.get(key)
            back = 0
            # The same UIDVALIDITY goes on from the mark; under a new one its UIDs mean nothing, but its time says how far back to look.
            if mark and mark[0] == validity:
                last = mark[1]  # a reconnect or a new login of the same account: nothing in between is missed
            else:
                if nxt and nxt[0]:
                    last = int(nxt[0]) - 1
                else:
                    found = (conn.uid("search", None, "ALL")[1][0] or b"").split()
                    last = int(found[-1]) if found else 0
                # A start of the bridge or a new UIDVALIDITY: the newest mails of the last two minutes too.
                # After it was off, from when it was switched back on (Gmail may have been away since then).
                with self.lock:
                    if self.since.get(key) == math.inf:  # wanted again (signed in again, say) without back_on()
                        self.since[key] = time.time()
                    since = self.since.get(key)
                start = since if since is not None else (mark[2] if mark else None)
                back = START_BACK if start is None else min(FRESH, max(START_BACK, time.time() - start + 5))
                last = max(0, last - BACK_MAILS)
            self.marks[key] = (validity, last, time.time())
            watching.append(True)
            started = time.monotonic()
            while True:
                # First what came while the connection was down (after a reconnect), then each time INBOX grows.
                conn.untagged_responses.pop("EXISTS", None)
                checked = time.time()
                ok, data = conn.uid("search", None, f"UID {last + 1}:*")
                if ok != "OK":
                    raise imaplib.IMAP4.abort("search failed")
                for uid in sorted(int(x) for x in (data[0] or b"").split() if int(x) > last):
                    self.look(conn, key, creds, validity, uid, back or FRESH)
                    last = uid
                    self.marks[key] = (validity, last, checked)
                self.marks[key] = (validity, last, checked)
                back = 0
                if time.monotonic() - started >= RECONNECT_SECONDS:
                    return
                now = self.wanted(key)
                if not now or login_of(now) != login_of(creds):
                    return  # turned off, removed or signed in again: run() decides
                # Mail that came during the search or fetch was announced to imaplib, not to an IDLE.
                if conn.untagged_responses.pop("EXISTS", None):
                    continue
                idle(conn, IDLE_SECONDS)
                if not self.wanted(key):
                    return  # switched off while waiting: what came meanwhile is not shown later either
        finally:
            try:
                conn.logout()
            except (imaplib.IMAP4.error, OSError):
                pass

    def look(self, conn: imaplib.IMAP4, key: str, creds: dict, validity, uid: int, fresh: float = FRESH) -> None:
        """Reads one new mail; a code in it goes to the store. A refused fetch raises, so the mail is tried
        again after the reconnect instead of being skipped."""
        ok, rows = conn.uid("fetch", str(uid), "(INTERNALDATE)")
        if ok != "OK":
            raise imaplib.IMAP4.abort("fetch failed")
        stamps = [imaplib.Internaldate2tuple(r if isinstance(r, bytes) else r[0]) for r in rows if r]
        # INTERNALDATE has whole seconds: mail of the second it was switched on counts (a code must not be lost).
        since = int(min(self.since.get(key, 0), time.time()))
        if not any(stamps) or all(time.time() - time.mktime(t) > fresh or time.mktime(t) < since for t in stamps if t):
            return  # old mail (a long outage, a moved message, while off): only its date was read
        ok, rows = conn.uid("fetch", str(uid), f"(BODY.PEEK[]<0.{MAX_FETCH}>)")
        if ok != "OK":
            raise imaplib.IMAP4.abort("fetch failed")
        for row in rows:
            if not isinstance(row, tuple):
                continue
            try:
                name, address, subject, text = read_mail(row[1])
            except Exception as err:  # one odd mail must not stop the watch
                self.log("codes: unreadable mail:", type(err).__name__)
                continue
            if address.lower() == creds["email"].lower():
                continue  # sent by the account itself
            code = find_code(subject, text)
            if code and self.store.add({
                "login": key, "account": creds["email"], "mail": _message_id(row[1]) or f"{_text(validity)}:{uid}", "code": code,
                "from": name or address, "address": address, "subject": subject[:160], "at": int(time.time() * 1000),
            }):
                self.log("codes: a code arrived")


def _text(value) -> str:
    return value.decode() if isinstance(value, bytes) else str(value)


def _message_id(raw: bytes) -> str | None:
    """The mail's Message-ID: the same mail under a new UIDVALIDITY is still one code."""
    head = raw.split(b"\r\n\r\n", 1)[0].split(b"\n\n", 1)[0]
    m = re.search(rb"(?im)^message-id:\s*(<[^>\r\n]{1,250}>)", head)
    return m.group(1).decode("ascii", "replace") if m else None

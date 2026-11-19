"""Gmail accounts for Weft.

It connects accounts: any number of Gmail addresses, each signed in over IMAP either through Google's
own sign-in (OAuth, XOAUTH2) or with a Google app password (myaccount.google.com/apppasswords), never
with the account's real password. import_mail.py and cleanup.py build on the stored logins. The bridge
itself also watches each account's INBOX for one-time codes (codes.py, IMAP IDLE, read-only) so Weft can
show one the moment it arrives.

Signing in through Google needs an OAuth client of type "Desktop app" from Karchi's own Google Cloud
project, published "In production" (a client in Testing loses its logins after 7 days). Its id and secret
live in STATE_DIR/google-client.json, mode 600: {"client_id": ..., "client_secret": ...}. Google sends
the browser back to a loopback address nothing listens on; Karchi pastes that address into Weft, and the
bridge trades the code in it for a refresh token.

It speaks the subset of the mautrix bridgev2 provisioning API that Weft's Accounts page uses, so
Gmail looks like any other bridge there:

  GET  /_matrix/provision/v3/whoami
  POST /_matrix/provision/v3/login/start/<password|google>
  POST /_matrix/provision/v3/login/step/<process>/<step>/user_input
  POST /_matrix/provision/v3/login/cancel/<process>
  POST /_matrix/provision/v3/logout/<login>
  POST /_matrix/provision/v3/send/<login>   a new mail: {"to", "cc", "subject", "text",
                                             "files": [{"url": mxc, "name", "mimetype"}]}
  GET  /_matrix/provision/v3/codes?since=<seq>&wait=<s>   long poll: {"seq", "ttl", "codes": [...]}
  POST /_matrix/provision/v3/codes/<id>/dismiss       copied or closed, on every device
  POST /_matrix/provision/v3/codes/mode/<login>       {"mode": "popup" | "notify" | "off"}
  GET  /_matrix/provision/v3/push/key                 the Web Push (VAPID) public key
  POST /_matrix/provision/v3/push/subscribe           {"endpoint", "key"}: this device hears of "notify" codes
  POST /_matrix/provision/v3/push/unsubscribe         {"endpoint"}

Only the admin Matrix user may call it. Sending goes through Gmail's SMTP with the same login, so
Gmail itself keeps the mail in Sent; nothing else here writes to a mailbox.
"""
import base64
import hashlib
import imaplib
import importlib.util
import json
import math
import mimetypes
import os
import re
import secrets
import smtplib
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from email.message import EmailMessage
from email.utils import formatdate, getaddresses, make_msgid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# The one-time code finder and INBOX watcher next to this file (python -I does not put it on sys.path).
_spec = importlib.util.spec_from_file_location("gmail_codes", Path(__file__).resolve().with_name("codes.py"))
codes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(codes)
_spec = importlib.util.spec_from_file_location("gmail_push", Path(__file__).resolve().with_name("push.py"))
push = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(push)

HOMESERVER = os.environ.get("HOMESERVER", "http://127.0.0.1:8008")
ADMIN = os.environ["ADMIN_MXID"]
SERVER_NAME = ADMIN.split(":", 1)[1]
STATE_DIR = Path(os.environ.get("STATE_DIR", Path(__file__).resolve().parent / "state"))
ACCOUNTS_FILE = STATE_DIR / "accounts.json"
IMAP_HOST = os.environ.get("IMAP_HOST", "imap.gmail.com")
IMAP_PORT = int(os.environ.get("IMAP_PORT", "993"))
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
# Gmail refuses a message over 25 MB; attachments grow by a third in base64, so files may total 18.75 MB
# (Weft's Nový mail holds the same limit).
MAX_MAIL_BYTES = 25 * 1024 * 1024
MAX_ATTACH_BYTES = MAX_MAIL_BYTES * 3 // 4
TOO_LARGE = "Prílohy sú spolu väčšie ako 18 MB, Gmail ich neprijme."
MAX_SEND_BODY = 1024 * 1024
# imaplib does not check certificates unless given a context; IMAP_CAFILE is only for tests.
TLS = ssl.create_default_context(cafile=os.environ.get("IMAP_CAFILE"))
# How often a stored login is tried again, so the Accounts page shows a revoked app password.
CHECK_SECONDS = int(os.environ.get("CHECK_SECONDS", 30 * 60))
# After a network failure that account alone is tried again sooner, doubling the wait each time up to
# CHECK_SECONDS; only this many failures in a row show as disconnected.
RETRY_SECONDS = int(os.environ.get("RETRY_SECONDS", 2 * 60))
TRANSIENT_LIMIT = 3
# Refusals that wait for Karchi: the account goes to BAD_CREDENTIALS and the bridge stops signing in
# until he connects it again, so Google never sees a stream of failed logins.
NEEDS_KARCHI = ("SK.KARCHI.BAD_CREDENTIALS", "SK.KARCHI.GOOGLE_ALERT", "SK.KARCHI.NO_GOOGLE_CLIENT")
FLOW = {"id": "password", "name": "Heslo aplikácie", "description": "Gmail cez IMAP s heslom aplikácie od Googlu"}
GOOGLE_FLOW = {"id": "google", "name": "Google", "description": "Gmail cez prihlásenie Googlom"}
GOOGLE_CLIENT_FILE = STATE_DIR / "google-client.json"
AUTH_URL = os.environ.get("GOOGLE_AUTH_URL", "https://accounts.google.com/o/oauth2/v2/auth")
TOKEN_URL = os.environ.get("GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token")
# A loopback address is the only redirect a Desktop app client may use; the port is arbitrary.
REDIRECT_URI = "http://127.0.0.1:47823/"
MAIL_SCOPE = "https://mail.google.com/"
GOOGLE_STEP_ID = "sk.karchi.gmail.google"
STEP_ID = "sk.karchi.gmail.credentials"
CREDENTIALS_STEP = {
    "type": "user_input",
    "step_id": STEP_ID,
    "instructions": "Gmail sa pripája heslom aplikácie, nie tvojím heslom. Na myaccount.google.com/apppasswords "
    "si vytvor heslo s názvom Weft (účet musí mať zapnuté overenie v dvoch krokoch) a vlož ho sem.",
    "user_input": {
        "fields": [
            {"type": "username", "id": "email", "name": "Gmail adresa"},
            {
                "type": "password",
                "id": "password",
                "name": "Heslo aplikácie",
                "description": "16 písmen, ako ho Google ukáže, aj s medzerami.",
            },
        ]
    },
}
PROCESSES: dict[str, dict] = {}
PROCESS_TTL = 15 * 60


def log(*args) -> None:
    print(*args, file=sys.stderr, flush=True)


class ApiError(Exception):
    def __init__(self, status: int, errcode: str, message: str):
        super().__init__(message)
        self.status, self.errcode, self.message = status, errcode, message


def whoami(token: str) -> str | None:
    req = urllib.request.Request(
        HOMESERVER + "/_matrix/client/v3/account/whoami",
        headers={"Authorization": "Bearer " + token},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.load(resp).get("user_id")
    except (urllib.error.URLError, ValueError):
        return None


UNREACHABLE = "Gmail neodpovedá. Skús to o chvíľu."


def xoauth2(email: str, access_token: str):
    """imaplib's AUTHENTICATE callback: the token first, then an empty line after Gmail's error challenge."""
    replies = [f"user={email}\x01auth=Bearer {access_token}\x01\x01".encode()]
    return lambda _challenge: replies.pop() if replies else b""


def imap_check(email: str, password: str | None = None, access_token: str | None = None) -> None:
    """Signs in (app password or OAuth access token) and out; raises ApiError with a message for the
    Accounts page when it fails.

    Only Gmail's AUTHENTICATIONFAILED means a wrong or revoked login; any other refusal
    ([UNAVAILABLE], too many connections) or a dropped connection is an outage worth retrying.
    """
    try:
        conn = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT, ssl_context=TLS, timeout=20)
    except (OSError, imaplib.IMAP4.error):
        raise ApiError(504, "SK.KARCHI.UNREACHABLE", UNREACHABLE) from None
    try:
        if password is None:
            conn.authenticate("XOAUTH2", xoauth2(email, access_token or ""))
        else:
            conn.login(email, password)
    except imaplib.IMAP4.abort:
        raise ApiError(504, "SK.KARCHI.UNREACHABLE", UNREACHABLE) from None
    except imaplib.IMAP4.error as err:
        reply = str(err).upper()
        if re.search(r"\[(WEB)?ALERT\b", reply):  # Google wants Karchi to act, retrying will not help
            raise ApiError(
                400,
                "SK.KARCHI.GOOGLE_ALERT",
                "Google prihlásenie zastavil. Prihlás sa raz na mail.google.com v prehliadači a potom účet pripoj znova.",
            ) from None
        if "AUTHENTICATIONFAILED" not in reply:
            raise ApiError(503, "SK.KARCHI.UNREACHABLE", "Gmail teraz prihlásenie dočasne odmieta. Skús to o chvíľu.") from None
        if password is None:
            raise ApiError(400, "SK.KARCHI.BAD_CREDENTIALS", GOOGLE_REVOKED) from None
        raise ApiError(
            400,
            "SK.KARCHI.BAD_CREDENTIALS",
            "Gmail heslo neprijal. Skontroluj adresu a vytvor nové heslo aplikácie na myaccount.google.com/apppasswords.",
        ) from None
    except OSError:
        raise ApiError(504, "SK.KARCHI.UNREACHABLE", UNREACHABLE) from None
    finally:
        try:
            conn.logout()
        except (imaplib.IMAP4.error, OSError):
            pass


GOOGLE_REVOKED = "Google prístup pre Weft zrušil alebo vypršal. Pripoj účet znova cez Google."
GOOGLE_DOWN = "Google neodpovedá. Skús to o chvíľu."
BAD_GOOGLE_CLIENT = (
    "Google nepozná klienta Weftu (zmazaný alebo zmenený projekt v Google Cloud). "
    "Oprav google-client.json na asuse a pripoj účet znova."
)


def google_client() -> dict | None:
    try:
        data = json.loads(GOOGLE_CLIENT_FILE.read_text())
    except (OSError, ValueError):
        return None
    ok = isinstance(data, dict) and all(isinstance(data.get(k), str) and data[k] for k in ("client_id", "client_secret"))
    return data if ok else None


def token_request(fields: dict) -> dict:
    """POST to Google's token endpoint. A refusal (invalid_grant: revoked, expired, used code) raises
    BAD_CREDENTIALS; anything else is an outage."""
    client = google_client()
    if not client:
        raise ApiError(503, "SK.KARCHI.NO_GOOGLE_CLIENT", NO_GOOGLE_CLIENT)
    data = urllib.parse.urlencode({**fields, "client_id": client["client_id"], "client_secret": client["client_secret"]}).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(TOKEN_URL, data=data), timeout=20) as resp:
            answer = json.load(resp)
    except urllib.error.HTTPError as err:
        try:
            code = json.load(err).get("error")
        except (ValueError, AttributeError):
            code = None
        if code == "invalid_grant":
            raise ApiError(400, "SK.KARCHI.BAD_CREDENTIALS", GOOGLE_REVOKED) from None
        if code in ("unauthorized_client", "invalid_client", "invalid_request", "redirect_uri_mismatch"):
            raise ApiError(400, "SK.KARCHI.BAD_CREDENTIALS", BAD_GOOGLE_CLIENT) from None
        raise ApiError(504, "SK.KARCHI.UNREACHABLE", GOOGLE_DOWN) from None
    except (OSError, ValueError):
        raise ApiError(504, "SK.KARCHI.UNREACHABLE", GOOGLE_DOWN) from None
    if not isinstance(answer, dict) or not answer.get("access_token"):
        raise ApiError(502, "SK.KARCHI.UNREACHABLE", GOOGLE_DOWN)
    return answer


def watch_login(creds: dict) -> imaplib.IMAP4_SSL:
    """A signed-in IMAP connection for the code watcher; a refused login raises codes.AuthFailed."""
    access = None
    if "refresh_token" in creds:
        try:
            access = token_request({"grant_type": "refresh_token", "refresh_token": creds["refresh_token"]})["access_token"]
        except ApiError as err:
            if err.errcode in NEEDS_KARCHI:
                raise codes.AuthFailed() from None
            raise
    conn = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT, ssl_context=TLS, timeout=30)
    try:
        if access is None:
            conn.login(creds["email"], creds["password"])
        else:
            conn.authenticate("XOAUTH2", xoauth2(creds["email"], access))
    except imaplib.IMAP4.abort:
        conn.shutdown()
        raise
    except imaplib.IMAP4.error as err:
        conn.shutdown()
        if "AUTHENTICATIONFAILED" in str(err).upper() or re.search(r"\[(WEB)?ALERT\b", str(err).upper()):
            raise codes.AuthFailed() from None
        raise
    return conn


def login_check(creds: dict) -> None:
    """Signs in with a stored login, whichever kind it is."""
    if "refresh_token" in creds:
        if not google_client():
            raise ApiError(503, "SK.KARCHI.NO_GOOGLE_CLIENT", "Na asuse chýba google-client.json. Keď ho vrátiš, pripoj účet znova cez Google.")
        token = token_request({"grant_type": "refresh_token", "refresh_token": creds["refresh_token"]})
        imap_check(creds["email"], access_token=token["access_token"])
    else:
        imap_check(creds["email"], creds["password"])


ADDRESS = re.compile(r"[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+")


def addresses(raw) -> list[str]:
    """'Ema <ema@example.com>, jano@example.org' -> ['Ema <ema@example.com>', 'jano@example.org']; ApiError when one is not an address."""
    if not raw:
        return []
    if not isinstance(raw, str):
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Adresy napíš ako text.")
    out = []
    for name, addr in getaddresses([raw.replace(";", ",")]):
        if not ADDRESS.fullmatch(addr):
            raise ApiError(400, "SK.KARCHI.INVALID_INPUT", f"„{(name or addr).strip()}“ nie je e-mailová adresa.")
        out.append(f"{name} <{addr}>" if name else addr)
    return out


def media_file(token: str, mxc: str) -> bytes:
    """A file Karchi attached in Weft, read from the homeserver with his own token."""
    match = re.fullmatch(r"mxc://([^/]+)/([A-Za-z0-9_-]+)", mxc or "")
    if not match:
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Príloha nemá platnú adresu.")
    req = urllib.request.Request(
        f"{HOMESERVER}/_matrix/client/v1/media/download/{match.group(1)}/{match.group(2)}",
        headers={"Authorization": "Bearer " + token},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read(MAX_ATTACH_BYTES + 1)
    except (OSError, urllib.error.URLError):
        raise ApiError(502, "SK.KARCHI.UNREACHABLE", "Prílohu sa nepodarilo načítať. Skús to znova.") from None
    if len(data) > MAX_ATTACH_BYTES:
        raise ApiError(413, "SK.KARCHI.TOO_LARGE", TOO_LARGE)
    return data


def build_mail(sender: str, body: dict, token: str) -> EmailMessage:
    to, cc = addresses(body.get("to")), addresses(body.get("cc"))
    if not to:
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Napíš, komu mail ide.")
    subject = body.get("subject") if isinstance(body.get("subject"), str) else ""
    text = body.get("text") if isinstance(body.get("text"), str) else ""
    files = body.get("files") if isinstance(body.get("files"), list) else []
    if not text.strip() and not files:
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Mail je prázdny.")
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Subject"] = subject.strip()
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=sender.rsplit("@", 1)[1])
    msg.set_content(text)
    total = 0
    for f in files:
        if not isinstance(f, dict):
            continue
        name = str(f.get("name") or "subor")
        data = media_file(token, str(f.get("url") or ""))
        total += len(data)
        if total > MAX_ATTACH_BYTES:
            raise ApiError(413, "SK.KARCHI.TOO_LARGE", TOO_LARGE)
        kind = str(f.get("mimetype") or "") or mimetypes.guess_type(name)[0] or "application/octet-stream"
        main, _, sub = kind.partition("/")
        msg.add_attachment(data, maintype=main or "application", subtype=sub or "octet-stream", filename=name)
    return msg


def send_mail(creds: dict, msg: EmailMessage) -> None:
    """Sends over Gmail's SMTP with the stored login; Gmail files the mail under Sent by itself."""
    try:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=TLS, timeout=60) as smtp:
            if "refresh_token" in creds:
                access = token_request({"grant_type": "refresh_token", "refresh_token": creds["refresh_token"]})["access_token"]
                auth = f"user={creds['email']}\x01auth=Bearer {access}\x01\x01"
                smtp.auth("XOAUTH2", lambda challenge=None: auth if challenge is None else "")
            else:
                smtp.login(creds["email"], creds["password"])
            refused = smtp.send_message(msg)
    except smtplib.SMTPAuthenticationError:
        raise ApiError(401, "SK.KARCHI.BAD_CREDENTIALS", "Gmail neprijal prihlásenie. Pripoj účet znova v Nastaveniach.") from None
    except smtplib.SMTPRecipientsRefused:
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Gmail odmietol adresy príjemcov.") from None
    except smtplib.SMTPDataError as err:
        raise ApiError(400, "SK.KARCHI.REFUSED", f"Gmail mail odmietol: {err.smtp_error.decode(errors='replace')[:200]}") from None
    except (OSError, smtplib.SMTPException):
        raise ApiError(504, "SK.KARCHI.UNREACHABLE", "Gmail neodpovedá, mail neodišiel. Skús to o chvíľu.") from None
    if refused:
        raise ApiError(400, "SK.KARCHI.PARTLY", "Mail neodišiel na: " + ", ".join(refused))


def secret_of(creds: dict) -> str:
    return creds.get("refresh_token") or creds.get("password") or ""


class Accounts:
    """Stored logins (address and app password or Google refresh token, file mode 600) and their
    last known state."""

    def __init__(self):
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.creds: dict[str, dict] = load_accounts()
        self.state: dict[str, tuple[str, str]] = {key: ("CONNECTING", "") for key in self.creds}
        self.failures: dict[str, tuple[int, float]] = {}  # network failures in a row, since when
        self.next_at: dict[str, float] = {}  # when each login is checked next

    def save(self) -> None:
        tmp = ACCOUNTS_FILE.with_suffix(".tmp")
        tmp.unlink(missing_ok=True)  # a leftover from a crash could carry other permissions
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as out:
            json.dump(self.creds, out)
        tmp.replace(ACCOUNTS_FILE)

    def view(self) -> list[dict]:
        with self.lock:
            out = []
            for key, creds in sorted(self.creds.items(), key=lambda kv: kv[1].get("added", 0)):
                state, message = self.state.get(key, ("CONNECTING", ""))
                out.append({
                    "id": key,
                    "name": creds["email"],
                    "state": {"state_event": state, "message": message},
                    "profile": {"email": creds["email"], "name": creds["email"]},
                    "sk.karchi.codes": creds.get("codes", codes.DEFAULT_MODE),
                })
            return out

    def put(self, email: str, secret: dict) -> str:
        """secret is {"password": ...} or {"refresh_token": ...}; a new one replaces the old kind."""
        key = email.lower()
        with self.lock:
            old = self.creds.get(key, {})
            added = old.get("added") or time.time()
            self.creds[key] = {"email": email, **secret, "added": added, **({"codes": old["codes"]} if "codes" in old else {})}
            self.state[key] = ("CONNECTED", "")
            self.failures.pop(key, None)
            self.next_at[key] = time.time() + CHECK_SECONDS
            self.save()
        WATCHERS.sync([key])
        return key

    def remove(self, key: str) -> bool:
        with self.lock:
            if self.creds.pop(key, None) is None:
                return False
            self.state.pop(key, None)
            self.failures.pop(key, None)
            self.next_at.pop(key, None)
            self.save()
        WATCHERS.forget(key)
        CODES.changed()
        return True

    def set_mode(self, key: str, mode: str) -> None:
        if mode not in codes.MODES:
            raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Neznáme nastavenie kódov.")
        with self.lock:
            if key not in self.creds:
                raise ApiError(404, "SK.KARCHI.NO_LOGIN", "Tento účet tu už nie je.")
            self.creds[key]["codes"] = mode
            self.save()
        if mode == "off":
            WATCHERS.forget(key)
        else:
            WATCHERS.back_on(key)
        CODES.changed()
        WATCHERS.sync([key])

    def watched(self, key: str) -> dict | None:
        """The login whose INBOX the code watcher should follow, or None (codes off, removed, refused)."""
        with self.lock:
            creds = self.creds.get(key)
            if not creds or creds.get("codes", codes.DEFAULT_MODE) == "off":
                return None
            if self.state.get(key, ("",))[0] == "BAD_CREDENTIALS":
                return None
            return dict(creds)

    def shown_codes(self, items: list[dict]) -> list[dict]:
        """Codes Weft may show: of accounts still here and not switched off, each with its account's mode."""
        with self.lock:
            modes = {key: c.get("codes", codes.DEFAULT_MODE) for key, c in self.creds.items()}
        return [{**x, "mode": modes[x["login"]]} for x in items if modes.get(x["login"], "off") != "off"]

    def mode(self, key: str) -> str:
        with self.lock:
            return (self.creds.get(key) or {}).get("codes", codes.DEFAULT_MODE) if key in self.creds else "off"

    def check_due(self) -> float:
        """Tries each login that is due; returns how many seconds until the next one is."""
        now = time.time()
        with self.lock:
            todo = [
                (key, dict(creds)) for key, creds in self.creds.items()
                if self.state.get(key, ("",))[0] != "BAD_CREDENTIALS" and self.next_at.get(key, 0) <= now
            ]
        for key, creds in todo:
            try:
                login_check(creds)
                result = ("CONNECTED", "")
            except ApiError as err:
                result = ("BAD_CREDENTIALS", err.message) if err.errcode in NEEDS_KARCHI else None
            except Exception as err:  # one odd account must not stop the others
                log("check failed:", type(err).__name__)
                result = None
            with self.lock:
                # A login replaced or removed while this check ran keeps what put() or remove() decided.
                if secret_of(self.creds.get(key, {})) != secret_of(creds):
                    continue
                if result is None:
                    count, since = self.failures.get(key, (0, time.time()))
                    self.failures[key] = (count + 1, since)
                    self.next_at[key] = time.time() + min(RETRY_SECONDS * 2 ** count, CHECK_SECONDS)
                    if count + 1 >= TRANSIENT_LIMIT:
                        when = time.strftime("%H:%M", time.localtime(since))
                        self.state[key] = ("TRANSIENT_DISCONNECT", f"Gmail neodpovedá od {when}.")
                else:
                    self.failures.pop(key, None)
                    self.next_at[key] = time.time() + CHECK_SECONDS
                    self.state[key] = result
        with self.lock:
            due = [self.next_at.get(key, 0) for key in self.creds if self.state.get(key, ("",))[0] != "BAD_CREDENTIALS"]
        return max(1.0, min(due, default=time.time() + CHECK_SECONDS) - time.time())

    def run(self) -> None:
        while True:
            wait = float(CHECK_SECONDS)
            try:
                wait = self.check_due()
            except Exception as err:  # keep the checker alive; the API threads do not depend on it
                log("check failed:", type(err).__name__)
            with self.lock:
                keys = list(self.creds)
            WATCHERS.sync(keys)  # also restarts a watcher whose login Gmail refused once it checks out again
            self.wake.wait(wait)
            self.wake.clear()


ACCOUNTS: Accounts
CODES = codes.Store()
WATCHERS: codes.Watchers


def load_accounts() -> dict[str, dict]:
    """The stored logins; a file that cannot be read is set aside, so the bridge still starts."""
    if not ACCOUNTS_FILE.exists():
        return {}
    try:
        data = json.loads(ACCOUNTS_FILE.read_text())
        if isinstance(data, dict) and all(isinstance(v, dict) and "email" in v and ("password" in v or "refresh_token" in v) for v in data.values()):
            return data
    except (OSError, ValueError):
        pass
    aside = ACCOUNTS_FILE.with_name(f"accounts.json.bad-{int(time.time())}")
    ACCOUNTS_FILE.replace(aside)
    log(f"unreadable accounts file moved to {aside.name}; starting without logins")
    return {}


def process(process_id: str) -> dict:
    now = time.time()
    for key in [key for key, value in list(PROCESSES.items()) if now - value["created"] > PROCESS_TTL]:
        PROCESSES.pop(key, None)
    found = PROCESSES.get(process_id)
    if not found:
        raise ApiError(404, "SK.KARCHI.EXPIRED", "Prihlásenie vypršalo. Začni znova.")
    return found


def app_password(raw: str) -> str:
    """Google shows app passwords as four groups of four letters; anything else is not one."""
    password = re.sub(r"\s+", "", raw)
    if not re.fullmatch(r"[A-Za-z]{16}", password):
        raise ApiError(
            400,
            "SK.KARCHI.NOT_APP_PASSWORD",
            "Toto nie je heslo aplikácie (16 písmen). Svoje heslo od Googlu sem nedávaj; vytvor si heslo "
            "aplikácie na myaccount.google.com/apppasswords.",
        )
    return password.lower()


def submit_credentials(process_id: str, body: dict) -> dict:
    email = str(body.get("email") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}", email):
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Napíš celú adresu, napríklad meno@gmail.com.")
    password = app_password(str(body.get("password") or ""))
    imap_check(email, password)
    key = ACCOUNTS.put(email, {"password": password})
    PROCESSES.pop(process_id, None)
    log("connected an account")
    return {
        "login_id": process_id,
        "type": "complete",
        "step_id": "sk.karchi.gmail.complete",
        "instructions": f"Pripojené: {email}",
        "complete": {"user_login_id": key},
    }


NO_GOOGLE_CLIENT = (
    "Prihlásenie cez Google ešte nie je na serveri nastavené (chýba Google Cloud klient). "
    "Zatiaľ sa dá pripojiť heslom aplikácie."
)


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def start_google(process_id: str) -> dict:
    client = google_client()
    if not client:
        raise ApiError(503, "SK.KARCHI.NO_GOOGLE_CLIENT", NO_GOOGLE_CLIENT)
    verifier = secrets.token_urlsafe(48)
    PROCESSES[process_id] = {"created": time.time(), "verifier": verifier}
    url = AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": client["client_id"],
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": f"{MAIL_SCOPE} openid email",
        "access_type": "offline",
        "prompt": "consent select_account",  # consent: Google sends a refresh token every time
        "state": process_id,
        "code_challenge": b64url(hashlib.sha256(verifier.encode()).digest()),
        "code_challenge_method": "S256",
    })
    return {
        "login_id": process_id,
        "type": "user_input",
        "step_id": GOOGLE_STEP_ID,
        "instructions": "Otvor Google, vyber účet a povoľ Weftu prístup k pošte. Keď Google napíše, že aplikáciu "
        "neoveril, klikni Advanced → Go to Weft. Prehliadač potom ukáže, že sa stránka nedá načítať; to je "
        "v poriadku. Skopíruj celú adresu z jeho riadku a vlož ju sem.",
        "sk.karchi.open_url": url,
        "user_input": {"fields": [{"type": "text", "id": "redirect", "name": "Adresa stránky, ktorá sa nenačítala"}]},
    }


def email_from_id_token(id_token: str) -> str:
    """The address in the id token. It came straight from Google's token endpoint over TLS, so its
    signature needs no check here."""
    try:
        payload = id_token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return str(claims["email"])
    except (IndexError, KeyError, ValueError, TypeError):
        raise ApiError(502, "SK.KARCHI.UNREACHABLE", "Google neposlal adresu účtu.") from None


def submit_google(process_id: str, found: dict, body: dict) -> dict:
    pasted = re.sub(r"\s+", "", str(body.get("redirect") or ""))  # a copy can carry spaces or line breaks
    # The whole address, or only what follows "?" when the browser hid the http:// part.
    query = urllib.parse.parse_qs(pasted.split("?", 1)[-1].split("#", 1)[0])
    code, state = query.get("code", [""])[0], query.get("state", [""])[0]
    if state and state != process_id:  # nothing traded: this sign-in stays open for the newest tab's address
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Táto adresa patrí k staršiemu pokusu. Vlož adresu z poslednej "
                       "karty Googlu, alebo klikni znova Otvoriť Google.")
    if query.get("error"):
        raise ApiError(400, "SK.KARCHI.DENIED", "Google prístup nepovolil; na konci treba kliknúť Allow.")
    if not code or not state:
        # Nothing was traded, so this sign-in stays open (Weft keeps it) and the right address still works.
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Toto nie je celá adresa od Googlu. Skopíruj celý riadok adresy, začína http://127.0.0.1.")
    try:
        token = token_request({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
            "code_verifier": found["verifier"],
        })
    except ApiError as err:
        if err.message == GOOGLE_REVOKED:  # invalid_grant here: the code was used already or is too old
            err.message = "Tento kód od Googlu už neplatí."
        raise
    if MAIL_SCOPE not in str(token.get("scope", "")).split():
        raise ApiError(400, "SK.KARCHI.DENIED", "Google nedal prístup k pošte; nechaj zaškrtnutý prístup ku Gmailu.")
    if not token.get("refresh_token"):
        raise ApiError(502, "SK.KARCHI.UNREACHABLE", "Google neposlal trvalý prístup.")
    email = email_from_id_token(str(token.get("id_token") or ""))
    try:
        imap_check(email, access_token=token["access_token"])
    except ApiError as err:
        if err.errcode == "SK.KARCHI.BAD_CREDENTIALS":  # the grant is minutes old, so it is not "revoked"
            err.message = "Google prístup povolil, ale Gmail prihlásenie cez IMAP odmietol."
        raise
    key = ACCOUNTS.put(email, {"refresh_token": token["refresh_token"]})
    PROCESSES.pop(process_id, None)
    log("connected an account through Google")
    return {
        "login_id": process_id,
        "type": "complete",
        "step_id": "sk.karchi.gmail.complete",
        "instructions": f"Pripojené: {email}",
        "complete": {"user_login_id": key},
    }


def route(method: str, parts: list[str], body: dict, token: str = "") -> dict:
    match method, parts:
        case "GET", ["whoami"]:
            return {
                "network": {"displayname": "Gmail"},
                "login_flows": [GOOGLE_FLOW, FLOW],
                "homeserver": SERVER_NAME,
                "logins": ACCOUNTS.view(),
            }
        case "GET", ["login", "flows"]:
            return {"flows": [GOOGLE_FLOW, FLOW]}
        case "POST", ["login", "start", "password"]:
            process_id = uuid.uuid4().hex
            PROCESSES[process_id] = {"created": time.time()}
            return {"login_id": process_id, **CREDENTIALS_STEP}
        case "POST", ["login", "start", "google"]:
            return start_google(uuid.uuid4().hex)
        case "POST", ["login", "step", process_id, step_id, "user_input"] if step_id == STEP_ID:
            process(process_id)
            return submit_credentials(process_id, body)
        case "POST", ["login", "step", process_id, step_id, "user_input"] if step_id == GOOGLE_STEP_ID:
            # Weft starts a fresh sign-in after any failure here (a Google code works once), so every
            # message ends with what to do next.
            try:
                found = process(process_id)
                if "verifier" not in found:
                    raise ApiError(404, "SK.KARCHI.EXPIRED", "Prihlásenie vypršalo.")
                return submit_google(process_id, found, body)
            except ApiError as err:
                if err.errcode != "SK.KARCHI.INVALID_INPUT" and err.message != BAD_GOOGLE_CLIENT:
                    err.message = err.message.removesuffix(" Začni znova.") + " Klikni znova Otvoriť Google."
                raise
        case "POST", ["login", "cancel", process_id]:
            PROCESSES.pop(process_id, None)
            return {}
        case "POST", ["send", login_id]:
            with ACCOUNTS.lock:
                creds = dict(ACCOUNTS.creds.get(login_id) or {})
            if not creds:
                raise ApiError(404, "SK.KARCHI.NO_LOGIN", "Tento účet tu už nie je.")
            send_mail(creds, build_mail(creds["email"], body, token))
            return {}
        case "GET", ["codes"]:
            # Long poll: answers when a code comes or goes (seq differs from since), at the latest after wait s.
            try:
                since = int(body.get("since") or 0)
                wait = float(body.get("wait") or 0)
            except ValueError:
                raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "") from None
            wait = min(max(wait, 0), 30) if math.isfinite(wait) else 0
            seq, items = CODES.wait(since, wait)
            # now: the bridge's clock, so a device whose clock is off still counts each code's ten minutes right
            return {"seq": seq, "ttl": codes.TTL, "now": int(time.time() * 1000), "codes": ACCOUNTS.shown_codes(items)}
        case "POST", ["codes", code_id, "dismiss"]:
            CODES.dismiss(code_id)
            return {}
        case "POST", ["codes", "mode", login_id]:
            ACCOUNTS.set_mode(login_id, str(body.get("mode") or ""))
            return {}
        case "GET", ["push", "key"]:
            return {"key": PUSH.public}
        case "POST", ["push", "subscribe"]:
            if not PUSH.subscribe(str(body.get("endpoint") or ""), str(body.get("key") or "")):
                raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "")
            return {}
        case "POST", ["push", "unsubscribe"]:
            PUSH.unsubscribe(str(body.get("endpoint") or ""))
            return {}
        case "POST", ["logout", login_id]:
            if not ACCOUNTS.remove(login_id):
                raise ApiError(404, "SK.KARCHI.NO_LOGIN", "Tento účet tu už nie je.")
            return {}
    raise ApiError(404, "M_UNRECOGNIZED", "")


PREFIX = "/_matrix/provision/v3"


class Handler(BaseHTTPRequestHandler):
    def reply(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")  # codes and logins never stay in a cache
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_api(self, method: str) -> None:
        path = urllib.parse.urlsplit(self.path).path
        if not path.startswith(PREFIX):
            return self.reply(404, {"errcode": "M_NOT_FOUND", "error": ""})
        token = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if not token or whoami(token) != ADMIN:
            return self.reply(403, {"errcode": "M_FORBIDDEN", "error": "Only the server admin can use this bridge"})
        body = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(self.path).query)) if method == "GET" else {}
        if method == "POST":
            try:
                raw = self.rfile.read(min(int(self.headers.get("Content-Length") or 0), MAX_SEND_BODY))
                body = json.loads(raw) if raw else {}
            except ValueError:
                return self.reply(400, {"errcode": "M_BAD_JSON", "error": ""})
            if not isinstance(body, dict):
                return self.reply(400, {"errcode": "M_BAD_JSON", "error": ""})
        parts = [urllib.parse.unquote(part) for part in path[len(PREFIX):].strip("/").split("/")]
        try:
            self.reply(200, route(method, parts, body, token))
        except ApiError as err:
            self.reply(err.status, {"errcode": err.errcode, "error": err.message})

    def do_GET(self) -> None:
        self.handle_api("GET")

    def do_POST(self) -> None:
        self.handle_api("POST")

    def log_message(self, fmt: str, *args) -> None:  # keep addresses and passwords out of the journal
        pass


def main() -> None:
    global ACCOUNTS, WATCHERS, PUSH
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    ACCOUNTS = Accounts()
    PUSH = push.Push(STATE_DIR, ssl.create_default_context(cafile=os.environ.get("PUSH_CAFILE")), log)
    # A code of an account set to "window and notification" also reaches devices where Weft is closed.
    CODES.on_new = lambda item: PUSH.send_all() if ACCOUNTS.mode(item["login"]) == "notify" else None
    WATCHERS = codes.Watchers(ACCOUNTS.watched, watch_login, CODES, log)
    threading.Thread(target=ACCOUNTS.run, name="checker", daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("PORT", "29323"))), Handler)
    log(f"gmail bridge on {server.server_address[0]}:{server.server_address[1]}")
    server.serve_forever()


if __name__ == "__main__":
    main()

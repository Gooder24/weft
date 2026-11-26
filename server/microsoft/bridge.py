"""Microsoft accounts for Weft: Outlook mail and Teams chats.

Any number of Microsoft accounts, each signed in through Microsoft's own page (OAuth with PKCE) with Karchi's
own app registration from STATE_DIR/microsoft-client.json, mode 600: {"client_id": ...} (a public client of
"Mobile and desktop applications" with the redirect http://localhost; a "client_secret" is sent when present).
Microsoft sends the browser back to that address, where nothing listens; Karchi pastes it into Weft, and the
bridge trades the code in it for a refresh token. Outlook and Teams are connected separately, so a personal
Outlook.com address and a school or work Teams can live side by side.

Outlook works like Gmail: its mail (every folder, read-only) goes into Weft's archive and search in batches,
newest first, and a new mail or a reply goes out through Microsoft Graph, which keeps it in Sent Items.

Teams chats (one-to-one, group and meeting chats; not team channels, which need a tenant admin) become
Matrix rooms through the appservice in REGISTRATION, as the other bridges do: people are ghost users
(@teams_<Entra id>), Karchi's own messages from elsewhere come in through the double puppet. Graph has no push
for a delegated login, so the bridge polls every POLL_SECONDS. What Karchi writes in a Teams room (text, files,
photos, replies, edits, deletions, reactions) is pushed by the homeserver and sent with his login. Nothing
marks chats read in Teams.

Provisioning speaks the subset of the mautrix bridgev2 API that Weft's Accounts page uses, once per product:

  GET  /<outlook|teams>/_matrix/provision/v3/whoami
  POST /<outlook|teams>/_matrix/provision/v3/login/start/microsoft
  POST /<outlook|teams>/_matrix/provision/v3/login/step/<process>/<step>/user_input
  POST /<outlook|teams>/_matrix/provision/v3/login/cancel/<process>
  POST /<outlook|teams>/_matrix/provision/v3/logout/<login>
  POST /outlook/_matrix/provision/v3/send/<login>     a new mail, as Gmail's: {"to", "cc", "subject", "text", "files"}
  GET  /<outlook|teams>/_matrix/provision/v3/consent   what each login may do, what waits, the admin's link
  POST /<outlook|teams>/_matrix/provision/v3/features  {"off": [CHOICES ids]}: what Weft leaves out (both products)
  POST /teams/_matrix/provision/v3/meeting/<login>    a meeting in that account's calendar, see create_meeting
  POST /teams/_matrix/provision/v3/search_users       {"query"}: people in Karchi's organization
  GET  /teams/_matrix/provision/v3/resolve_identifier/<Entra id or address>
  POST /teams/_matrix/provision/v3/create_dm/<Entra id>

Only the admin Matrix user may call it.
"""
import base64
import hashlib
import html
import json
import mimetypes
import os
import queue
import re
import secrets
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from email.utils import getaddresses
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOMESERVER = os.environ.get("HOMESERVER", "http://127.0.0.1:8008")
ADMIN = os.environ["ADMIN_MXID"]
SERVER_NAME = ADMIN.split(":", 1)[1]
STATE_DIR = Path(os.environ.get("STATE_DIR", Path(__file__).resolve().parent / "state"))
ACCOUNTS_FILE = STATE_DIR / "accounts.json"
CLIENT_FILE = STATE_DIR / "microsoft-client.json"
ARCHIVE_DB = Path(os.environ.get("ARCHIVE_DB", Path.home() / "matrix-spike/archive/archive.db"))
GRAPH = os.environ.get("GRAPH_URL", "https://graph.microsoft.com/v1.0").rstrip("/")
LOGIN = os.environ.get("MS_LOGIN_URL", "https://login.microsoftonline.com").rstrip("/")
# Entra lets a desktop client use http://localhost with any port; this exact one is registered.
REDIRECT_URI = "http://localhost"
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "20"))
MAIL_SECONDS = int(os.environ.get("MAIL_SECONDS", "300"))
CHECK_SECONDS = int(os.environ.get("CHECK_SECONDS", 30 * 60))
RETRY_SECONDS = int(os.environ.get("RETRY_SECONDS", 2 * 60))
TRANSIENT_LIMIT = 3
# A new Teams login brings its chats of these last days (one page each, already read); older ones come when they move.
FIRST_DAYS = int(os.environ.get("FIRST_DAYS", "14"))
FIRST_MESSAGES = 20
# Outlook.com takes 20 MB of attachments, Exchange more; the smaller limit holds for both. Weft holds the same.
MAIL_FILES_MAX = 20 * 1024 * 1024
SMALL_ATTACH = 3 * 1024 * 1024  # Graph takes files under this inline; this size and bigger go up in an upload session
FILE_MAX = 25 * 1024 * 1024  # a Teams file Weft brings over or sends
MAX_BODY = 1024 * 1024
# Karchi's read of a Teams chat goes to Teams at most this often per chat (Teams marks the whole chat, not a message).
READ_GAP = float(os.environ.get("READ_GAP_SECONDS", "5"))
READ_PACE = float(os.environ.get("READ_PACE_SECONDS", "1"))  # checks of all chats start at most this often (Graph limits)
MARK = "sk.karchi.teams"  # on every event the bridge writes itself, so the homeserver's push of it is ignored
NEEDS_KARCHI = ("SK.KARCHI.BAD_CREDENTIALS", "SK.KARCHI.NO_CLIENT")
CONSUMERS = "9188040d-6c67-4c5b-b112-36a304b66dad"  # the tenant of personal Microsoft accounts
G = "https://graph.microsoft.com/"
PRODUCTS = {
    "outlook": {
        "name": "Outlook",
        "tenant": "common",
        "scopes": ["offline_access", "openid", "profile", "email", G + "User.Read", G + "Mail.ReadWrite", G + "Mail.Send"],
        "needs": "Mail.Send",
        "what": "k pošte",
    },
    "teams": {
        "name": "Teams",
        "tenant": "organizations",
        "scopes": ["offline_access", "openid", "profile", "email", G + "User.Read", G + "User.ReadBasic.All",
                   G + "Chat.ReadWrite", G + "Files.ReadWrite.All"],
        "needs": "Chat.ReadWrite",
        "what": "k chatom v Teams",
    },
}
# Everything else Outlook and Teams can do for Karchi, asked for once so no feature needs another consent later.
# A work or school sign-in (Teams, or Outlook through an organization's own app) asks for USER_SCOPES, both products'
# at once; an Outlook sign-in that may be a personal account asks for Outlook's "scopes" and "extra". A user may grant
# all of these alone where the organization lets users consent. A feature redeems the refresh token for its own
# scopes (scoped_token), so a login that has only "scopes" keeps its mail and chats. ADMIN_ONLY needs an admin, and
# admin_consent_url() lets one grant all of it, both products, for the whole organization in one step.
WORK_ONLY = [G + "Mail.ReadWrite.Shared", G + "Mail.Send.Shared", G + "Calendars.ReadWrite.Shared"]  # not for personal accounts
PRODUCTS["outlook"]["extra"] = [G + s for s in ("Calendars.ReadWrite", "Contacts.ReadWrite", "MailboxSettings.ReadWrite",
                                                "People.Read", "Tasks.ReadWrite")]
PRODUCTS["teams"]["extra"] = [G + s for s in ("Calendars.ReadWrite", "OnlineMeetings.ReadWrite", "Presence.Read.All",
                                              "Presence.ReadWrite", "Team.ReadBasic.All", "Channel.ReadBasic.All",
                                              "ChannelMessage.Send", "People.Read")]
ADMIN_ONLY = [G + s for s in ("ChannelMessage.Read.All", "ChannelMember.Read.All", "TeamMember.Read.All", "ChatMember.ReadWrite",
                              "OnlineMeetingTranscript.Read.All", "OnlineMeetingRecording.Read.All")]
# What each permission gives, in the words Settings and `weft ms-consent` use for a missing one.
FEATURES = {
    "Mail.ReadWrite": "pošta", "Mail.Send": "odosielanie pošty", "Chat.ReadWrite": "chaty", "Files.ReadWrite.All": "súbory",
    "User.ReadBasic.All": "ľudia z firmy", "User.Read": "tvoj profil", "Calendars.ReadWrite": "kalendár a stretnutia",
    "Contacts.ReadWrite": "kontakty", "MailboxSettings.ReadWrite": "automatická odpoveď a nastavenia schránky",
    "People.Read": "ľudia, s ktorými píšeš", "Tasks.ReadWrite": "úlohy (To Do)", "OnlineMeetings.ReadWrite": "Teams stretnutia",
    "Presence.Read.All": "kto je online", "Presence.ReadWrite": "tvoj stav v Teams", "Team.ReadBasic.All": "tímy",
    "Channel.ReadBasic.All": "kanály tímov", "ChannelMessage.Send": "písanie do kanálov", "Mail.ReadWrite.Shared": "zdieľané schránky",
    "Mail.Send.Shared": "odosielanie zo zdieľaných schránok", "Calendars.ReadWrite.Shared": "zdieľané kalendáre",
    "ChannelMessage.Read.All": "čítanie kanálov", "ChannelMember.Read.All": "ľudia v kanáloch", "TeamMember.Read.All": "ľudia v tímoch",
    "ChatMember.ReadWrite": "pridávanie ľudí do chatov", "OnlineMeetingTranscript.Read.All": "prepisy stretnutí",
    "OnlineMeetingRecording.Read.All": "nahrávky stretnutí",
}
USER_SCOPES = list(dict.fromkeys(s for p in PRODUCTS.values() for s in p["scopes"] + p["extra"] + WORK_ONLY))
ALL_SCOPES = USER_SCOPES + ADMIN_ONLY
# What Karchi may leave out (Settings → Účty → Outlook or Teams, POST /features; state/features.json {"off": [ids]}).
# One choice for both products, since a work sign-in asks for both at once; mail and chats ("scopes") are always on.
# A sign-in, the admin's link and the consent report ask only for what is on, and the bridge never uses what is off.
CHOICES = [
    {"id": "calendar", "name": "kalendár a stretnutia", "scopes": ["Calendars.ReadWrite", "OnlineMeetings.ReadWrite"]},
    {"id": "contacts", "name": "kontakty a ľudia, s ktorými píšeš", "scopes": ["Contacts.ReadWrite", "People.Read"]},
    {"id": "tasks", "name": "úlohy (To Do)", "scopes": ["Tasks.ReadWrite"]},
    {"id": "mailbox", "name": "automatická odpoveď a nastavenia schránky", "scopes": ["MailboxSettings.ReadWrite"]},
    {"id": "shared", "name": "zdieľané schránky a kalendáre", "work": True,
     "scopes": ["Mail.ReadWrite.Shared", "Mail.Send.Shared", "Calendars.ReadWrite.Shared"]},
    {"id": "presence", "name": "kto je online a tvoj stav v Teams", "scopes": ["Presence.Read.All", "Presence.ReadWrite"]},
    {"id": "channels", "name": "tímy, kanály a písanie do nich", "scopes": ["Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Send"]},
    {"id": "channel_read", "name": "čítanie kanálov a ľudia v tímoch", "admin": True,
     "scopes": ["ChannelMessage.Read.All", "ChannelMember.Read.All", "TeamMember.Read.All"]},
    {"id": "chat_members", "name": "pridávanie ľudí do chatov", "admin": True, "scopes": ["ChatMember.ReadWrite"]},
    {"id": "recordings", "name": "prepisy a nahrávky stretnutí", "admin": True,
     "scopes": ["OnlineMeetingTranscript.Read.All", "OnlineMeetingRecording.Read.All"]},
]
FEATURES_FILE = STATE_DIR / "features.json"
assert {G + s for c in CHOICES for s in c["scopes"]} == set(ALL_SCOPES) - {s for p in PRODUCTS.values() for s in p["scopes"]}


FEATURES_LOCK = threading.Lock()


def features_off() -> set[str]:
    """No file: everything on. A file that cannot be read: everything off, so nothing turned off comes back by itself."""
    try:
        off = json.loads(FEATURES_FILE.read_bytes()).get("off")
        if not isinstance(off, list):
            raise ValueError
    except FileNotFoundError:
        return set()
    except (OSError, ValueError, AttributeError):
        log("features.json cannot be read; every optional feature counts as off until Settings saves a choice")
        return {c["id"] for c in CHOICES}
    return {c["id"] for c in CHOICES if c["id"] in off}


def set_features_off(off: object) -> None:
    if not isinstance(off, list) or not all(isinstance(i, str) for i in off):
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Pošli zoznam vypnutých funkcií.")
    known = {c["id"] for c in CHOICES}
    if set(off) - known:
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Takú funkciu Weft nepozná.")
    with FEATURES_LOCK:
        tmp = FEATURES_FILE.with_name(f"features.json.{uuid.uuid4().hex}.tmp")
        tmp.write_text(json.dumps({"off": sorted(set(off))}))
        tmp.replace(FEATURES_FILE)


def allowed(scopes: list[str]) -> list[str]:
    """These scopes without the ones of features turned off."""
    off = {G + s for c in CHOICES if c["id"] in features_off() for s in c["scopes"]}
    return [s for s in scopes if s not in off]


def feature_on(feature: str) -> bool:
    return feature not in features_off()


def choices() -> list[dict]:
    off = features_off()
    return [{"id": c["id"], "name": c["name"], "on": c["id"] not in off, "admin": bool(c.get("admin")),
             "work": bool(c.get("work"))} for c in CHOICES]
# A sign-in that asked for "extra" and was refused for want of consent, or closed unfinished: the next one in this
# time asks only "scopes".
BASE_ONLY: dict[str, float] = {}
BASE_ONLY_SECONDS = 3600
STEP_ID = "sk.karchi.microsoft.signin"
PROCESSES: dict[str, dict] = {}
PROCESS_TTL = 15 * 60
SEEN_TXNS: list[str] = []


def log(*args) -> None:
    print(*args, file=sys.stderr, flush=True)


class ApiError(Exception):
    def __init__(self, status: int, errcode: str, message: str):
        super().__init__(message)
        self.status, self.errcode, self.message = status, errcode, message


UNREACHABLE = "Microsoft neodpovedá. Skús to o chvíľu."
REVOKED = "Microsoft prístup pre Weft zrušil alebo vypršal. Pripoj účet znova."
NO_CLIENT = ("Prihlásenie cez Microsoft nejde: microsoft-client.json na asuse je pokazený (treba v ňom client_id, "
             "alebo ho zmaž a Weft sa prihlási cez Microsoft Graph Command Line Tools).")
BAD_CLIENT = ("Microsoft nepozná appku Weft (zmazaná alebo zle nastavená registrácia v Entra). "
              "Oprav microsoft-client.json na asuse a pripoj účet znova.")


def now_ms() -> int:
    return int(time.time() * 1000)


def iso_ms(stamp: str | None) -> int:
    """Graph's 2026-11-18T10:20:30.123Z as milliseconds; 0 when there is none."""
    if not stamp:
        return 0
    try:
        return int(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return 0


def iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def q(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def short(text: str, n: int = 20) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:n]


# ---------------------------------------------------------------- Microsoft sign-in


# Without an own Entra app (microsoft-client.json), sign-in goes through Microsoft's public app for using one's own
# Graph data, Microsoft Graph Command Line Tools: a public client for school, work and personal accounts that takes
# http://localhost. A school that allows no user consent still asks its admin, as it would for any app.
DEFAULT_CLIENT = {"client_id": "14d82eec-204b-4c2f-b7e8-296a70dab67e", "name": "Microsoft Graph Command Line Tools"}


def ms_client() -> dict | None:
    try:
        data = json.loads(CLIENT_FILE.read_text())
    except FileNotFoundError:
        return dict(DEFAULT_CLIENT)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("client_id"), str) and data["client_id"] else None


def admin_consent_url(tenant: str = "") -> str:
    """One page where an admin of the school or company grants Weft everything (ALL_SCOPES) for every user there.
    Microsoft then sends the admin's browser to http://localhost with admin_consent=True; nothing else is needed."""
    client = ms_client() or DEFAULT_CLIENT
    tenant = tenant if tenant and tenant != CONSUMERS else str(client.get("tenant") or "")
    if tenant in ("", "common", "consumers"):  # Microsoft takes no admin consent there; the admin's sign-in picks the tenant
        tenant = "organizations"
    return f"{LOGIN}/{tenant}/v2.0/adminconsent?" + urllib.parse.urlencode({
        "client_id": client["client_id"], "scope": " ".join(allowed(ALL_SCOPES)), "redirect_uri": REDIRECT_URI, "state": "weft"})


def needs_admin(tenant: str = "") -> str:
    return f"Správca tvojej školy alebo firmy schváli Weft pre všetkých naraz týmto odkazom: {admin_consent_url(tenant)}"


def consent_refusal(code: str, description: str) -> bool:
    if re.search(r"AADSTS(530\d\d|50105)\b", description):  # Conditional Access or not assigned to the app, not consent
        return False
    return code in ("access_denied", "consent_required") or any(
        c in description for c in ("AADSTS65001", "AADSTS65004", "AADSTS90094", "AADSTS900941"))


def aad_message(code: str, description: str, product: str) -> ApiError:
    """Microsoft's refusal (error and AADSTS code in its description) as what Karchi can do about it."""
    what = PRODUCTS[product]["what"]
    if "AADSTS65001" in description or "AADSTS90094" in description or "AADSTS900941" in description:
        return ApiError(400, "SK.KARCHI.DENIED", f"Tvoja škola alebo firma nepustí Weft {what} bez súhlasu správcu. "
                        + needs_admin())
    if re.search(r"AADSTS530\d\d\b", description):
        return ApiError(400, "SK.KARCHI.DENIED", "Pravidlá tvojej školy alebo firmy (Conditional Access) Weft nepustia.")
    if "AADSTS50105" in description:
        app = (ms_client() or DEFAULT_CLIENT).get("name") or "Weft"
        return ApiError(400, "SK.KARCHI.DENIED", f"Správca tvojej školy alebo firmy ťa k appke {app} nepriradil; "
                        f"musí ťa pridať v Entra (Enterprise applications → {app} → Users and groups).")
    if code in ("access_denied", "consent_required"):
        return ApiError(400, "SK.KARCHI.DENIED", f"Microsoft prístup nepovolil; na konci treba kliknúť Accept (Prijať).")
    if code in ("invalid_client", "unauthorized_client") or "AADSTS700016" in description or "AADSTS7000218" in description:
        return ApiError(400, "SK.KARCHI.BAD_CREDENTIALS", BAD_CLIENT)
    if code == "interaction_required":
        return ApiError(400, "SK.KARCHI.BAD_CREDENTIALS", "Microsoft chce, aby si sa prihlásil znova (napríklad nové "
                        "overenie v dvoch krokoch). Pripoj účet znova.")
    if code == "invalid_grant":
        return ApiError(400, "SK.KARCHI.BAD_CREDENTIALS", REVOKED)
    return ApiError(504, "SK.KARCHI.UNREACHABLE", UNREACHABLE)


def token_request(tenant: str, fields: dict, product: str, client_id: str = "", scopes: list[str] | None = None) -> dict:
    """client_id: the app a login was made with (its refresh token works only there), if not today's.
    scopes: other than the product's own (a refresh token gives any scope its sign-in consented to)."""
    client = ms_client()
    if client_id and client_id != (client or {}).get("client_id"):
        client = {"client_id": client_id}
    if not client:
        raise ApiError(503, "SK.KARCHI.NO_CLIENT", NO_CLIENT)
    data = {**fields, "client_id": client["client_id"], "scope": " ".join(scopes or PRODUCTS[product]["scopes"])}
    if client.get("client_secret"):
        data["client_secret"] = client["client_secret"]
    req = urllib.request.Request(f"{LOGIN}/{tenant}/oauth2/v2.0/token", data=urllib.parse.urlencode(data).encode())
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            answer = json.load(resp)
    except urllib.error.HTTPError as err:
        try:
            body = json.load(err)
        except (ValueError, AttributeError):
            body = {}
        raise aad_message(str(body.get("error") or ""), str(body.get("error_description") or ""), product) from None
    except (OSError, ValueError):
        raise ApiError(504, "SK.KARCHI.UNREACHABLE", UNREACHABLE) from None
    if not isinstance(answer, dict) or not answer.get("access_token"):
        raise ApiError(502, "SK.KARCHI.UNREACHABLE", UNREACHABLE)
    return answer


def claims_of(id_token: str) -> dict:
    """The id token's claims. It came straight from Microsoft's token endpoint over TLS: no signature check here."""
    try:
        payload = id_token.split(".")[1]
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return data if isinstance(data, dict) else {}
    except (IndexError, ValueError, TypeError):
        return {}


class Throttled(Exception):
    def __init__(self, seconds: float):
        super().__init__(f"throttled for {seconds}s")
        self.seconds = seconds


def graph_raw(access: str | None, method: str, url: str, body=None, *, data: bytes | None = None,
              headers: dict | None = None, timeout: int = 60, raw: bool = False):
    """One Graph request. A URL outside GRAPH never gets the token (upload sessions sign their own links)."""
    if not url.startswith("http"):
        url = GRAPH + url
    head = dict(headers or {})
    if access and url.startswith(GRAPH):
        head["Authorization"] = "Bearer " + access
    if body is not None:
        data = json.dumps(body).encode()
        head.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, method=method, headers=head)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read()
            if raw:
                return payload, resp.headers.get("Content-Type", "")
            return json.loads(payload) if payload.strip() else {}
    except urllib.error.HTTPError as err:
        if err.code in (429, 503, 504):
            raise Throttled(float(err.headers.get("Retry-After") or 30)) from None
        try:
            detail = json.load(err).get("error") or {}
        except (ValueError, AttributeError):
            detail = {}
        raise GraphError(err.code, str(detail.get("code") or ""), str(detail.get("message") or "")) from None
    except (OSError, ValueError):
        raise ApiError(504, "SK.KARCHI.UNREACHABLE", UNREACHABLE) from None


class GraphError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(f"{status} {code} {message}")
        self.status, self.code, self.message = status, code, message


def secret_of(creds: dict) -> str:
    return creds.get("refresh_token") or ""


def signin_of(creds: dict) -> float:
    """Which sign-in a login is: every put() (a new sign-in, also of the same account) gives a new one."""
    return creds.get("signed_in") or creds.get("added") or 0


class Accounts:
    """Stored logins by product and Entra object id (refresh token, file mode 600) and their last known state.
    Microsoft hands out a new refresh token with every access token; this is its only writer."""

    def __init__(self):
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.creds: dict[str, dict[str, dict]] = load_accounts()
        self.state: dict[tuple, tuple[str, str]] = {}
        self.failures: dict[tuple, tuple[int, float]] = {}
        self.next_at: dict[tuple, float] = {}
        self.access: dict[tuple, tuple[str, float]] = {}
        self.refreshing: dict[tuple, threading.Lock] = {}
        for product, logins in self.creds.items():
            for key in logins:
                self.state[(product, key)] = ("CONNECTING", "")

    def save(self) -> None:
        tmp = ACCOUNTS_FILE.with_suffix(".tmp")
        tmp.unlink(missing_ok=True)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as out:
            json.dump(self.creds, out)
        tmp.replace(ACCOUNTS_FILE)

    def logins(self, product: str) -> dict[str, dict]:
        with self.lock:
            return {k: dict(v) for k, v in self.creds.get(product, {}).items()}

    def get(self, product: str, key: str) -> dict | None:
        with self.lock:
            found = self.creds.get(product, {}).get(key)
            return dict(found) if found else None

    def usable(self, product: str) -> list[str]:
        with self.lock:
            return [k for k in sorted(self.creds.get(product, {}), key=lambda k: self.creds[product][k].get("added", 0))
                    if self.state.get((product, k), ("",))[0] != "BAD_CREDENTIALS"]

    def tenant_of(self, product: str, key: str) -> str:
        with self.lock:
            return str(self.creds.get(product, {}).get(key, {}).get("tid") or "")

    def view(self, product: str) -> list[dict]:
        with self.lock:
            out = []
            for key, creds in sorted(self.creds.get(product, {}).items(), key=lambda kv: kv[1].get("added", 0)):
                state, message = self.state.get((product, key), ("CONNECTING", ""))
                out.append({
                    "id": key,
                    "name": creds["email"],
                    "state": {"state_event": state, "message": message},
                    "profile": {"email": creds["email"], "name": creds.get("name") or creds["email"]},
                })
            return out

    def put(self, product: str, key: str, creds: dict, access: tuple[str, float]) -> None:
        with self.lock:
            old = self.creds.setdefault(product, {}).get(key, {})
            self.creds[product][key] = {**creds, "added": old.get("added") or time.time(), "signed_in": time.time()}
            self.state[(product, key)] = ("CONNECTED", "")
            self.failures.pop((product, key), None)
            self.next_at[(product, key)] = time.time() + CHECK_SECONDS
            self.access[(product, key)] = access
            self.save()
        self.wake.set()

    def remove(self, product: str, key: str) -> bool:
        with self.lock:
            if self.creds.get(product, {}).pop(key, None) is None:
                return False
            for table in (self.state, self.failures, self.next_at, self.access):
                table.pop((product, key), None)
            self.save()
            return True

    def signin(self, product: str, key: str) -> float:
        with self.lock:
            return signin_of(self.creds.get(product, {}).get(key) or {})

    def mark(self, product: str, key: str, err: ApiError, signin: float) -> None:
        """A refusal that waits for Karchi (revoked login, missing client): no more sign-ins until he reconnects.
        Only for the sign-in that was refused: one he made meanwhile stays connected."""
        if err.errcode in NEEDS_KARCHI:
            with self.lock:
                live = self.creds.get(product, {}).get(key)
                if live and signin_of(live) == signin:
                    self.state[(product, key)] = ("BAD_CREDENTIALS", err.message)

    def token(self, product: str, key: str, force: bool = False) -> str:
        with self.lock:
            lock = self.refreshing.setdefault((product, key), threading.Lock())
        with lock:
            with self.lock:
                cached = self.access.get((product, key))
                creds = self.creds.get(product, {}).get(key)
                if not creds:
                    raise ApiError(404, "SK.KARCHI.NO_LOGIN", "Tento účet tu už nie je.")
                if self.state.get((product, key), ("",))[0] == "BAD_CREDENTIALS":
                    raise ApiError(401, "SK.KARCHI.BAD_CREDENTIALS", self.state[(product, key)][1] or REVOKED)
                creds = dict(creds)
            if cached and not force and cached[1] > time.time() + 60:
                return cached[0]
            tenant = "consumers" if creds.get("tid") == CONSUMERS else creds.get("tid") or PRODUCTS[product]["tenant"]
            try:
                answer = token_request(tenant, {"grant_type": "refresh_token", "refresh_token": creds["refresh_token"]}, product,
                                           str(creds.get("client") or ""))
            except ApiError as err:
                self.mark(product, key, err, signin_of(creds))
                with self.lock:
                    if not self.creds.get(product, {}).get(key):
                        raise ApiError(404, "SK.KARCHI.NO_LOGIN", "Tento účet tu už nie je.") from None
                raise
            with self.lock:
                live = self.creds.get(product, {}).get(key)
                # Signed out or signed in again while this refresh ran: its answer belongs to a login that is gone.
                if not live:
                    raise ApiError(404, "SK.KARCHI.NO_LOGIN", "Tento účet tu už nie je.")
                if signin_of(live) != signin_of(creds):
                    fresh = self.access.get((product, key))
                    if fresh:
                        return fresh[0]
                    raise ApiError(503, "SK.KARCHI.RETRY", "Účet sa práve znova pripojil, skús to o chvíľu.")
                if answer.get("refresh_token"):
                    live["refresh_token"] = answer["refresh_token"]
                    self.save()
                self.access[(product, key)] = (answer["access_token"], time.time() + int(answer.get("expires_in") or 3600))
            return answer["access_token"]

    def scoped_token(self, product: str, key: str, scopes: list[str]) -> str:
        """An access token for scopes beyond the product's own (a meeting's calendar). A refusal leaves the login as it
        is: chats and mail never depend on these scopes. A rotated refresh token is kept, as token() does."""
        return self.redeem(product, key, scopes)["access_token"]

    def consented(self, product: str, key: str) -> set[str]:
        """The Graph permissions this login's app may use now (Microsoft lists them for /.default), without G."""
        answer = self.redeem(product, key, [G + ".default", "offline_access"])
        return {s.rsplit("/", 1)[-1] for s in str(answer.get("scope", "")).split() if s.startswith(G)}

    def redeem(self, product: str, key: str, scopes: list[str]) -> dict:
        with self.lock:
            lock = self.refreshing.setdefault((product, key), threading.Lock())
        with lock:
            with self.lock:
                creds = self.creds.get(product, {}).get(key)
                if not creds:
                    raise ApiError(404, "SK.KARCHI.NO_LOGIN", "Tento účet tu už nie je.")
                creds = dict(creds)
            tenant = "consumers" if creds.get("tid") == CONSUMERS else creds.get("tid") or PRODUCTS[product]["tenant"]
            answer = token_request(tenant, {"grant_type": "refresh_token", "refresh_token": creds["refresh_token"]}, product,
                                   str(creds.get("client") or ""), scopes)
            with self.lock:
                live = self.creds.get(product, {}).get(key)
                if live and signin_of(live) == signin_of(creds) and answer.get("refresh_token"):
                    live["refresh_token"] = answer["refresh_token"]
                    self.save()
            return answer

    def graph(self, product: str, key: str, method: str, url: str, body=None, **kw):
        """Graph as this login; an expired access token is renewed once."""
        signin = self.signin(product, key)
        try:
            return graph_raw(self.token(product, key), method, url, body, **kw)
        except GraphError as err:
            if err.status != 401:
                raise
        try:
            return graph_raw(self.token(product, key, force=True), method, url, body, **kw)
        except GraphError as err:
            if err.status == 401:
                failed = ApiError(401, "SK.KARCHI.BAD_CREDENTIALS", REVOKED)
                self.mark(product, key, failed, signin)
                raise failed from None
            raise

    def check_due(self) -> float:
        now = time.time()
        with self.lock:
            todo = [(p, k) for p, logins in self.creds.items() for k in logins
                    if self.state.get((p, k), ("",))[0] != "BAD_CREDENTIALS" and self.next_at.get((p, k), 0) <= now]
        for product, key in todo:
            creds = self.get(product, key) or {}
            try:
                self.graph(product, key, "GET", "/me?$select=id")
                result = ("CONNECTED", "")
            except ApiError as err:
                result = ("BAD_CREDENTIALS", err.message) if err.errcode in NEEDS_KARCHI else None
            except (GraphError, Throttled):
                result = None
            except Exception as err:  # one odd account must not stop the others
                log("check failed:", type(err).__name__)
                result = None
            with self.lock:
                # A login removed, or connected again, while this check ran keeps what remove() or put() decided.
                if signin_of(self.creds.get(product, {}).get(key) or {}) != signin_of(creds):
                    continue
                if result is None:
                    count, since = self.failures.get((product, key), (0, time.time()))
                    self.failures[(product, key)] = (count + 1, since)
                    self.next_at[(product, key)] = time.time() + min(RETRY_SECONDS * 2 ** count, CHECK_SECONDS)
                    if count + 1 >= TRANSIENT_LIMIT:
                        when = time.strftime("%H:%M", time.localtime(since))
                        self.state[(product, key)] = ("TRANSIENT_DISCONNECT", f"Microsoft neodpovedá od {when}.")
                else:
                    self.failures.pop((product, key), None)
                    self.next_at[(product, key)] = time.time() + CHECK_SECONDS
                    self.state[(product, key)] = result
        with self.lock:
            due = [self.next_at.get((p, k), 0) for p, logins in self.creds.items() for k in logins
                   if self.state.get((p, k), ("",))[0] != "BAD_CREDENTIALS"]
        return max(1.0, min(due, default=time.time() + CHECK_SECONDS) - time.time())

    def run(self) -> None:
        while True:
            wait = float(CHECK_SECONDS)
            try:
                wait = self.check_due()
            except Exception as err:
                log("check failed:", type(err).__name__)
            self.wake.wait(min(wait, CHECK_SECONDS))
            self.wake.clear()


ACCOUNTS: Accounts


def load_accounts() -> dict[str, dict[str, dict]]:
    if not ACCOUNTS_FILE.exists():
        return {}
    try:
        data = json.loads(ACCOUNTS_FILE.read_text())
        if isinstance(data, dict) and all(
            p in PRODUCTS and isinstance(v, dict) and all(isinstance(c, dict) and c.get("refresh_token") and c.get("email") for c in v.values())
            for p, v in data.items()
        ):
            return data
    except (OSError, ValueError):
        pass
    aside = ACCOUNTS_FILE.with_name(f"accounts.json.bad-{int(time.time())}")
    ACCOUNTS_FILE.replace(aside)
    log(f"unreadable accounts file moved to {aside.name}; starting without logins")
    return {}


def process(process_id: str) -> dict:
    now = time.time()
    for key in [k for k, v in list(PROCESSES.items()) if now - v["created"] > PROCESS_TTL]:
        PROCESSES.pop(key, None)
    found = PROCESSES.get(process_id)
    if not found:
        raise ApiError(404, "SK.KARCHI.EXPIRED", "Prihlásenie vypršalo.")
    return found


def signin_scopes(product: str, client: dict, full: bool = False) -> list[str]:
    """Everything at once, unless such a sign-in was just refused or left unfinished (see BASE_ONLY) and Karchi did not
    ask for everything himself (full: Settings → „Povoliť vybrané“)."""
    if not full and time.time() - BASE_ONLY.get(product, 0) < BASE_ONLY_SECONDS:
        return PRODUCTS[product]["scopes"]
    return all_user_scopes(product, client)


def all_user_scopes(product: str, client: dict) -> list[str]:
    spec = PRODUCTS[product]
    if product == "teams" or str(client.get("tenant") or "common") not in ("common", "consumers"):
        return allowed(list(dict.fromkeys(spec["scopes"] + USER_SCOPES)))
    return allowed(spec["scopes"] + spec["extra"])


def start_login(product: str, full: bool = False) -> dict:
    client = ms_client()
    if not client:
        raise ApiError(503, "SK.KARCHI.NO_CLIENT", NO_CLIENT)
    process_id = uuid.uuid4().hex
    verifier = secrets.token_urlsafe(48)
    scopes = signin_scopes(product, client, full)
    PROCESSES[process_id] = {"created": time.time(), "verifier": verifier, "product": product,
                             "extras": scopes != PRODUCTS[product]["scopes"]}
    spec = PRODUCTS[product]
    url = f"{LOGIN}/{client.get('tenant') or spec['tenant']}/oauth2/v2.0/authorize?" + urllib.parse.urlencode({
        "client_id": client["client_id"],
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "response_mode": "query",
        "scope": " ".join(scopes),
        "state": process_id,
        "prompt": "select_account",
        "code_challenge": b64url(hashlib.sha256(verifier.encode()).digest()),
        "code_challenge_method": "S256",
    })
    school = " Prihlás sa školským alebo pracovným účtom; osobné konto Teams Microsoft cudzím appkám nesprístupní." if product == "teams" else ""
    return {
        "login_id": process_id,
        "type": "user_input",
        "step_id": STEP_ID,
        "instructions": f"Otvor Microsoft, vyber účet a povoľ Weftu prístup {spec['what']}.{school} Prehliadač potom "
        "ukáže, že sa stránka nedá načítať; to je v poriadku. Skopíruj celú adresu z jeho riadku a vlož ju sem."
        + (" Ak Microsoft chce schválenie správcu a ďalej ťa nepustí, klikni tu Zrušiť a pripoj účet znova: Weft vtedy "
           "pýta len to, čo treba na poštu a chaty." if PROCESSES[process_id]["extras"] else
           " Weft teraz pýta len to, čo treba na poštu a chaty; ostatné funkcie pridá prihlásenie (Znova prihlásiť) "
           "po hodine alebo súhlas správcu." if all_user_scopes(product, client) != scopes else ""),
        "sk.karchi.open_url": url,
        "sk.karchi.open_label": "Otvoriť Microsoft",
        "user_input": {"fields": [{"type": "text", "id": "redirect", "name": "Adresa stránky, ktorá sa nenačítala"}]},
    }


def submit_login(product: str, process_id: str, found: dict, body: dict) -> dict:
    pasted = re.sub(r"\s+", "", str(body.get("redirect") or ""))
    query = urllib.parse.parse_qs(pasted.split("?", 1)[-1].split("#", 1)[0])
    code, state = query.get("code", [""])[0], query.get("state", [""])[0]
    if state and state != process_id:
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Táto adresa patrí k staršiemu pokusu. Vlož adresu z poslednej "
                       "karty Microsoftu, alebo klikni znova Otvoriť Microsoft.")
    if query.get("error"):
        error, description = query["error"][0], query.get("error_description", [""])[0]
        if found.get("extras") and consent_refusal(error, description):
            BASE_ONLY[product] = time.time()
            raise ApiError(400, "SK.KARCHI.DENIED", "Microsoft nedal Weftu všetko, čo pýtal (napríklad čaká na súhlas "
                           "správcu). Ďalšie prihlásenie pýta len to, čo už smie. " + needs_admin())
        raise aad_message(error, description, product)
    if not code or not state:
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Toto nie je celá adresa od Microsoftu. Skopíruj celý riadok "
                       "adresy, začína http://localhost.")
    client = ms_client() or {}
    try:
        token = token_request(client.get("tenant") or PRODUCTS[product]["tenant"], {
            "grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT_URI, "code_verifier": found["verifier"],
        }, product)
    except ApiError as err:
        if err.message == REVOKED:  # invalid_grant here: the code was used already or is too old
            err.message = "Tento kód od Microsoftu už neplatí."
        elif err.errcode == "SK.KARCHI.DENIED" and found.get("extras") and "bez súhlasu správcu" in err.message:
            BASE_ONLY[product] = time.time()
            err.message += " Weft sa teraz pripojí len k tomu, čo už smie."
        raise
    granted = {s.rsplit("/", 1)[-1].lower() for s in str(token.get("scope", "")).split()}
    if PRODUCTS[product]["needs"].lower() not in granted:
        raise ApiError(400, "SK.KARCHI.DENIED", f"Microsoft nedal Weftu prístup {PRODUCTS[product]['what']}.")
    if not token.get("refresh_token"):
        raise ApiError(502, "SK.KARCHI.UNREACHABLE", "Microsoft neposlal trvalý prístup.")
    claims = claims_of(str(token.get("id_token") or ""))
    if product == "teams" and claims.get("tid") == CONSUMERS:
        raise ApiError(400, "SK.KARCHI.DENIED", "Toto je osobný účet Microsoft. Teams sa dá pripojiť len školským "
                       "alebo pracovným účtom.")
    try:
        me = graph_raw(token["access_token"], "GET", "/me?$select=id,displayName,mail,userPrincipalName")
        if product == "teams":
            graph_raw(token["access_token"], "GET", "/me/chats?$top=1")
    except GraphError as err:
        raise ApiError(400, "SK.KARCHI.DENIED", f"Microsoft prihlásenie prijal, ale {PRODUCTS[product]['name']} "
                       f"prístup odmietol ({err.status} {err.code}).") from None
    except Throttled:
        raise ApiError(503, "SK.KARCHI.UNREACHABLE", UNREACHABLE) from None
    oid = str(me.get("id") or claims.get("oid") or "")
    if not re.fullmatch(r"[A-Za-z0-9-]{8,64}", oid):
        raise ApiError(502, "SK.KARCHI.UNREACHABLE", "Microsoft neposlal, kto si.")
    email = str(me.get("mail") or claims.get("email") or claims.get("preferred_username") or me.get("userPrincipalName") or oid)
    creds = {"email": email, "name": str(me.get("displayName") or claims.get("name") or email), "oid": oid,
             "tid": str(claims.get("tid") or ""), "refresh_token": token["refresh_token"], "client": client.get("client_id", "")}
    key = oid.lower()
    ACCOUNTS.put(product, key, creds, (token["access_token"], time.time() + int(token.get("expires_in") or 3600)))
    PROCESSES.pop(process_id, None)
    log(f"connected a {product} account")
    if product == "teams":
        TEAMS.wake.set()
    else:
        MAIL_WAKE.set()
    return {"login_id": process_id, "type": "complete", "step_id": "sk.karchi.microsoft.complete",
            "instructions": f"Pripojené: {email}", "complete": {"user_login_id": key}}


# ---------------------------------------------------------------- Outlook: sending


ADDRESS = re.compile(r"[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+")
TOO_LARGE = "Prílohy sú spolu väčšie ako 20 MB, Outlook ich neprijme."


def recipients(raw) -> list[dict]:
    if not raw:
        return []
    if not isinstance(raw, str):
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Adresy napíš ako text.")
    out = []
    for name, addr in getaddresses([raw.replace(";", ",")]):
        if not ADDRESS.fullmatch(addr):
            raise ApiError(400, "SK.KARCHI.INVALID_INPUT", f"„{(name or addr).strip()}“ nie je e-mailová adresa.")
        out.append({"emailAddress": {"address": addr, **({"name": name} if name else {})}})
    return out


def homeserver_file(mxc: str, token: str | None, limit: int, too_large: str) -> bytes:
    """A file in Weft: with Karchi's token (a mail from the Accounts API) or as the bridge bot (a Teams room)."""
    match = re.fullmatch(r"mxc://([^/]+)/([A-Za-z0-9_-]+)", mxc or "")
    if not match:
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Príloha nemá platnú adresu.")
    url = f"{HOMESERVER}/_matrix/client/v1/media/download/{match.group(1)}/{match.group(2)}"
    if token is None:
        url += "?user_id=" + q(BOT)
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + (token or AS_TOKEN)})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = resp.read(limit + 1)
    except (OSError, urllib.error.URLError):
        raise ApiError(502, "SK.KARCHI.UNREACHABLE", "Prílohu sa nepodarilo načítať. Skús to znova.") from None
    if len(data) > limit:
        raise ApiError(413, "SK.KARCHI.TOO_LARGE", too_large)
    return data


def upload_in_session(url: str, data: bytes) -> dict:
    """An upload session (mail attachment or OneDrive file): chunks of 320 KiB multiples, without the token."""
    chunk = 10 * 320 * 1024
    answer = {}
    for start in range(0, max(len(data), 1), chunk):
        part = data[start:start + chunk]
        answer = graph_raw(None, "PUT", url, data=part, timeout=120, headers={
            "Content-Length": str(len(part)), "Content-Range": f"bytes {start}-{start + len(part) - 1}/{len(data)}",
            "Content-Type": "application/octet-stream"})
    return answer


def send_mail(key: str, body: dict, token: str) -> None:
    to, cc = recipients(body.get("to")), recipients(body.get("cc"))
    if not to:
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Napíš, komu mail ide.")
    subject = body.get("subject") if isinstance(body.get("subject"), str) else ""
    text = body.get("text") if isinstance(body.get("text"), str) else ""
    files = [f for f in body.get("files") or [] if isinstance(f, dict)] if isinstance(body.get("files"), list) else []
    if not text.strip() and not files:
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Mail je prázdny.")
    blobs, total = [], 0
    for f in files:
        name = str(f.get("name") or "subor")
        data = homeserver_file(str(f.get("url") or ""), token, MAIL_FILES_MAX, TOO_LARGE)
        total += len(data)
        if total > MAIL_FILES_MAX:
            raise ApiError(413, "SK.KARCHI.TOO_LARGE", TOO_LARGE)
        blobs.append((name, str(f.get("mimetype") or "") or mimetypes.guess_type(name)[0] or "application/octet-stream", data))
    message = {"subject": subject.strip(), "body": {"contentType": "Text", "content": text},
               "toRecipients": to, "ccRecipients": cc}
    call = lambda *a, **kw: ACCOUNTS.graph("outlook", key, *a, **kw)
    attachment = lambda name, kind, data: {"@odata.type": "#microsoft.graph.fileAttachment", "name": name,
                                           "contentType": kind, "contentBytes": base64.b64encode(data).decode()}
    try:
        if total < SMALL_ATTACH:
            message["attachments"] = [attachment(*b) for b in blobs]
            call("POST", "/me/sendMail", {"message": message, "saveToSentItems": True})
            return
        # Bigger files go into a draft, each in its own upload session; the draft is sent last.
        draft = call("POST", "/me/messages", message)["id"]
        try:
            for name, kind, data in blobs:
                if len(data) < SMALL_ATTACH:
                    call("POST", f"/me/messages/{q(draft)}/attachments", attachment(name, kind, data))
                    continue
                session = call("POST", f"/me/messages/{q(draft)}/attachments/createUploadSession",
                               {"AttachmentItem": {"attachmentType": "file", "name": name, "size": len(data), "contentType": kind}})
                upload_in_session(session["uploadUrl"], data)
            call("POST", f"/me/messages/{q(draft)}/send")
        except Exception:
            try:
                call("DELETE", f"/me/messages/{q(draft)}")  # no half-made draft left in Drafts
            except Exception:
                pass
            raise
    except GraphError as err:
        if err.code in ("ErrorInvalidRecipients", "ErrorInvalidRecipientsInRecipients"):
            raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Outlook odmietol adresy príjemcov.") from None
        if err.status == 403:
            raise ApiError(403, "SK.KARCHI.REFUSED", "Outlook tomuto účtu posielanie nedovolí.") from None
        if err.status == 413 or err.code in ("ErrorMessageSizeExceeded", "RequestEntityTooLarge"):
            raise ApiError(413, "SK.KARCHI.TOO_LARGE", TOO_LARGE) from None
        raise ApiError(400, "SK.KARCHI.REFUSED", f"Outlook mail odmietol: {err.message[:200]}") from None
    except Throttled:
        raise ApiError(504, "SK.KARCHI.UNREACHABLE", "Outlook teraz neprijíma, mail neodišiel. Skús to o chvíľu.") from None


# ---------------------------------------------------------------- Outlook: the archive

MAIL_WAKE = threading.Event()
MAIL_SELECT = "id,conversationId,subject,from,receivedDateTime,body,hasAttachments,isDraft"


def html_text(markup: str) -> str:
    s = re.sub(r"(?is)<(script|style|head)\b.*?</\1>", "", markup)
    s = re.sub(r"(?i)<br\s*/?>", "\n", s)
    s = re.sub(r"(?i)</(p|div|li|tr|h\d|blockquote)>", "\n", s)
    s = re.sub(r"(?i)<li\b[^>]*>", "• ", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s).replace("\xa0", " ")
    s = re.sub(r"[ \t]+\n", "\n", s)
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def mail_row(account: str, msg: dict) -> tuple:
    """(chat id, title, message id, ts, sender, me, body) of one Outlook message, as Gmail's are kept."""
    prefix = "outlook:" + short(account.lower()) + ":"
    subject = str(msg.get("subject") or "(bez predmetu)")
    sender = (msg.get("from") or {}).get("emailAddress") or {}
    addr = str(sender.get("address") or "")
    who = f"{sender.get('name')} <{addr}>" if sender.get("name") and addr else addr or str(sender.get("name") or "Outlook")
    body = msg.get("body") or {}
    text = str(body.get("content") or "")
    if str(body.get("contentType") or "").lower() == "html":
        text = html_text(text)
    names = msg.get("_attachments") or []
    return (prefix + short(str(msg.get("conversationId") or msg["id"]), 24), f"{account} · {subject}",
            prefix + short(str(msg["id"]), 32), iso_ms(msg.get("receivedDateTime")) or now_ms(), who,
            int(addr.lower() == account.lower()), subject + "\n\n" + text + "".join("\n[Príloha: " + n + "]" for n in names))


def import_batch(key: str, creds: dict, db: sqlite3.Connection) -> bool:
    """New mail since the last pass, then one page of older history (newest first); True while history remains."""
    account = creds["email"]
    oldest, newest, done = db.execute("SELECT oldest, newest, done FROM outlook_import WHERE account = ?", (key,)).fetchone() or (None, None, 0)
    head = {"Prefer": 'outlook.body-content-type="text", IdType="ImmutableId"'}
    base = f"/me/messages?$select={MAIL_SELECT}&$orderby=" + q("receivedDateTime desc") + "&$top="

    def keep(items: list[dict]) -> tuple[int, list[int]]:
        fresh, stamps = 0, []
        for msg in items:
            if msg.get("hasAttachments"):
                try:
                    found = ACCOUNTS.graph("outlook", key, "GET", f"/me/messages/{q(msg['id'])}/attachments?$select=name,isInline",
                                           headers=head).get("value") or []
                    msg["_attachments"] = [str(a["name"]) for a in found if a.get("name") and not a.get("isInline")]
                except GraphError:
                    pass
            chat, title, ident, ts, sender, me, body = mail_row(account, msg)
            with db:
                db.execute("INSERT INTO chats VALUES (?, 'outlook', ?, ?, 'outlook') ON CONFLICT(id) DO NOTHING", (chat, title, "archive:" + chat))
                fresh += db.execute("INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?)", (ident, chat, ts, sender, me, body)).rowcount
            stamps.append(ts)
        return fresh, stamps

    mail = lambda page: [m for m in page.get("value") or [] if isinstance(m, dict) and m.get("id") and not m.get("isDraft")]
    if newest is not None:
        url = base + "50&$filter=" + q(f"receivedDateTime gt {iso(newest)}")
        for _ in range(20):
            page = ACCOUNTS.graph("outlook", key, "GET", url, headers=head)
            _, stamps = keep(mail(page))
            newest = max([newest, *stamps])
            with db:
                db.execute("UPDATE outlook_import SET newest = ? WHERE account = ?", (newest, key))
            url = page.get("@odata.nextLink")
            if not url:
                break
    if done:
        return False
    page = ACCOUNTS.graph("outlook", key, "GET", base + "100" + ("&$filter=" + q(f"receivedDateTime le {iso(oldest)}") if oldest else ""), headers=head)
    items = mail(page)
    fresh, stamps = keep(items)
    if stamps:
        oldest = min([*stamps, *([oldest] if oldest else [])])
        newest = max([*stamps, *([newest] if newest else [])])
    if items and not fresh and len(page.get("value") or []) >= 100:
        oldest -= 1  # a full page of mail at the very same time already kept: step past it
    finished = not page.get("@odata.nextLink")
    with db:
        db.execute("INSERT INTO outlook_import VALUES (?, ?, ?, ?) ON CONFLICT(account) DO UPDATE SET oldest = excluded.oldest, "
                   "newest = max(coalesce(outlook_import.newest, 0), coalesce(excluded.newest, 0)), done = excluded.done",
                   (key, oldest, newest if newest is not None else now_ms(), int(finished)))
    return not finished


def open_archive() -> sqlite3.Connection:
    db = sqlite3.connect(ARCHIVE_DB, timeout=60)
    db.execute("CREATE TABLE IF NOT EXISTS outlook_import (account TEXT PRIMARY KEY, oldest INTEGER, newest INTEGER, done INTEGER NOT NULL DEFAULT 0)")
    return db


def mail_loop() -> None:
    db = None
    while True:
        pending = False
        try:
            db = db or open_archive()
            for key in ACCOUNTS.usable("outlook"):
                creds = ACCOUNTS.get("outlook", key)
                if not creds:
                    continue
                try:
                    pending = import_batch(key, creds, db) or pending
                except (ApiError, GraphError, Throttled) as err:
                    log("outlook import:", type(err).__name__, getattr(err, "status", ""), getattr(err, "code", ""))
        except sqlite3.Error as err:
            log("outlook import: archive", err)
            db = None
        MAIL_WAKE.wait(5 if pending else MAIL_SECONDS)
        MAIL_WAKE.clear()


def consent_report(product: str) -> dict:
    """What each login of this product may do and what still waits for consent, with the admin's link."""
    logins, tenant = [], ""
    for login in ACCOUNTS.view(product):
        key = login["id"]
        tenant = tenant or ("" if ACCOUNTS.tenant_of(product, key) == CONSUMERS else ACCOUNTS.tenant_of(product, key))
        personal = ACCOUNTS.tenant_of(product, key) == CONSUMERS
        wanted = allowed(PRODUCTS[product]["scopes"] + PRODUCTS[product]["extra"] if personal else
                         all_user_scopes(product, ms_client() or {}) + ADMIN_ONLY)
        wanted = [s.rsplit("/", 1)[-1] for s in dict.fromkeys(wanted) if s.startswith(G)]
        try:
            have = ACCOUNTS.consented(product, key)
        except ApiError as err:
            logins.append({"id": key, "name": login["name"], "error": err.message})
            continue
        logins.append({"id": key, "name": login["name"], "granted": sorted(have),
                       "missing": [{"scope": s, "what": FEATURES.get(s, s), "admin": G + s in ADMIN_ONLY}
                                   for s in wanted if s not in have]})
    return {"logins": logins, "admin_url": admin_consent_url(tenant), "choices": choices()}


# ---------------------------------------------------------------- Teams: meetings


CALENDAR_SCOPES = [G + "Calendars.ReadWrite"]
NEEDS_CALENDAR = ("Teams kalendár Weft ešte nesmie. Pripoj Teams znova (Nastavenia → Účty → Teams) a povoľ aj kalendár, "
                  "alebo ak to tvoja firma nedovolí, ")
UTC_TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z")


def create_meeting(key: str, body: dict) -> dict:
    """A meeting in the Teams account's calendar: {"subject", "start", "end" (UTC, ...Z), "attendees" ("a@b, c@d"),
    "online" (a Teams link, default true)}. Exchange sends the invitations itself."""
    subject = body.get("subject").strip() if isinstance(body.get("subject"), str) else ""
    start, end = body.get("start"), body.get("end")
    if not subject:
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Stretnutie potrebuje názov.")
    if not (isinstance(start, str) and UTC_TIME.fullmatch(start) and isinstance(end, str) and UTC_TIME.fullmatch(end)):
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Začiatok a koniec píš v UTC, napríklad 2026-01-31T14:40:00Z.")
    if end <= start:
        raise ApiError(400, "SK.KARCHI.INVALID_INPUT", "Koniec je pred začiatkom.")
    attendees = [{**a, "type": "required"} for a in recipients(body.get("attendees"))]
    if not feature_on("calendar"):
        raise ApiError(403, "SK.KARCHI.FEATURE_OFF", "Kalendár a stretnutia máš vo Wefte vypnuté. Zapni ich v Nastavenia → "
                       "Účty → Teams → Čo smie Weft.")
    try:
        access = ACCOUNTS.scoped_token("teams", key, CALENDAR_SCOPES)
    except ApiError as err:
        if err.errcode in ("SK.KARCHI.DENIED", "SK.KARCHI.BAD_CREDENTIALS"):
            raise ApiError(403, "SK.KARCHI.NEEDS_SIGNIN", NEEDS_CALENDAR + needs_admin(ACCOUNTS.tenant_of("teams", key))) from None
        raise
    online = body.get("online", True) is not False
    event = {"subject": subject, "start": {"dateTime": start[:-1], "timeZone": "UTC"},
             "end": {"dateTime": end[:-1], "timeZone": "UTC"}, "attendees": attendees,
             **({"isOnlineMeeting": True, "onlineMeetingProvider": "teamsForBusiness"} if online else {})}
    try:
        made = graph_raw(access, "POST", "/me/events", event)
    except GraphError as err:
        if err.status in (401, 403):
            raise ApiError(403, "SK.KARCHI.NEEDS_SIGNIN", NEEDS_CALENDAR + needs_admin(ACCOUNTS.tenant_of("teams", key))) from None
        raise ApiError(400, "SK.KARCHI.REFUSED", f"Teams stretnutie odmietol: {err.message[:200]}") from None
    except Throttled:
        raise ApiError(504, "SK.KARCHI.UNREACHABLE", "Microsoft teraz neprijíma, stretnutie nevzniklo. Skús to o chvíľu.") from None
    log("created a teams meeting")
    return {"id": made.get("id"), "webLink": made.get("webLink"),
            "joinUrl": (made.get("onlineMeeting") or {}).get("joinUrl"), "start": start, "end": end,
            "attendees": [a["emailAddress"]["address"] for a in attendees]}


# ---------------------------------------------------------------- Teams: Matrix side


def as_token(path: str, key: str = "as_token") -> str:
    match = re.search(rf"^{key}:\s*['\"]?([^'\"\s]+)", Path(path).read_text(), re.M)
    if not match:
        raise SystemExit(f"no {key} in {path}")
    return match.group(1)


AS_TOKEN = as_token(os.environ["REGISTRATION"])
HS_TOKEN = as_token(os.environ["REGISTRATION"], "hs_token")
PUPPET_TOKEN = as_token(os.environ["DOUBLEPUPPET"])
BOT = f"@teamsbot:{SERVER_NAME}"


class MatrixError(Exception):
    def __init__(self, status: int, errcode: str, message: str):
        super().__init__(f"{status} {errcode} {message}")
        self.errcode = errcode


def matrix(method: str, path: str, body=None, *, user: str | None = BOT, query=None) -> dict:
    params = {**({"user_id": user} if user else {}), **(query or {})}
    url = f"{HOMESERVER}/_matrix/client/v3{path}" + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), method=method, headers={
        "Authorization": f"Bearer {PUPPET_TOKEN if user == ADMIN else AS_TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as err:
        try:
            data = json.loads(err.read() or b"{}")
        except ValueError:
            data = {}
        raise MatrixError(err.code, data.get("errcode", ""), data.get("error", "")) from None


def matrix_upload(data: bytes, name: str, kind: str) -> str:
    req = urllib.request.Request(f"{HOMESERVER}/_matrix/media/v3/upload?filename={q(name)}&user_id={q(BOT)}", data=data,
                                 method="POST", headers={"Authorization": f"Bearer {AS_TOKEN}", "Content-Type": kind})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.load(resp)["content_uri"]


REACTIONS = {"like": "👍", "heart": "❤️", "laugh": "😆", "surprised": "😮", "sad": "😢", "angry": "😡"}


def reaction_key(kind: str) -> str:
    """Teams' reaction as the emoji Weft shows; reactions are kept by it in both directions."""
    key = REACTIONS.get(kind, kind)
    return "❤️" if key in ("❤", "♥️", "♥") else key


def teams_reaction(key: str) -> str:
    """Weft's emoji as Teams takes it: its six classic names, any other emoji as itself."""
    return next((k for k, v in REACTIONS.items() if v == reaction_key(key)), key)


def teams_text(markup: str) -> str:
    s = re.sub(r'(?is)<emoji\b[^>]*\balt="([^"]*)"[^>]*>(\s*</emoji>)?', r"\1", markup or "")
    s = re.sub(r"(?is)<attachment\b[^>]*>\s*</attachment>", "", s)
    s = re.sub(r"(?is)<at\b[^>]*>(.*?)</at>", r"@\1", s)
    s = re.sub(r"(?is)<img\b[^>]*>", "", s)
    return html_text(s)


AT = re.compile(r'(?is)<at\b[^>]*\bid="?(\d+)"?[^>]*>(.*?)</at>')
PIN = re.compile("\ue000(\\d+)\ue001")
LINK = re.compile(r'(?is)<a\b[^>]*\bhref="https://matrix\.to/#/(@[^"/?]+)"[^>]*>(.*?)</a>')


def mention_markup(formatted: str, people: dict[str, str]) -> tuple[str, list[dict]]:
    """Weft's formatted_body (escaped text, <br> and matrix.to links, app.js textMessage) as Teams HTML: a link to a
    Teams person becomes <at>, listed in mentions; people maps ghost mxid -> Entra id."""
    formatted = re.sub(r"(?is)<mx-reply>.*?</mx-reply>", "", formatted)
    mentions = []

    def at(m):
        mxid, name = urllib.parse.unquote(m.group(1)), html_text(m.group(2)).lstrip("@")
        oid = people.get(mxid)
        if not oid:
            return html.escape(name)
        mentions.append({"id": len(mentions), "mentionText": name,
                         "mentioned": {"user": {"id": oid, "displayName": name, "userIdentityType": "aadUser"}}})
        return f'<at id="{len(mentions) - 1}">{html.escape(name)}</at>'
    return LINK.sub(at, formatted), mentions


HOSTED = re.compile(r'<img\b[^>]*\bsrc="([^"]+/hostedContents/[^"/]+/\$value)"', re.I)


SCHEMA = """
    CREATE TABLE IF NOT EXISTS chats (account TEXT NOT NULL, chat TEXT NOT NULL, room TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', cursor TEXT NOT NULL DEFAULT '',
        preview INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account, chat));
    CREATE TABLE IF NOT EXISTS ghosts (mxid TEXT PRIMARY KEY, name TEXT NOT NULL, photo INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS members (room TEXT NOT NULL, mxid TEXT NOT NULL, PRIMARY KEY (room, mxid));
    -- A Teams message and the events it became (text first, then its files), edited: Teams' lastEditedDateTime.
    -- A message id is unique only within its chat, so everything is per room (one account's chat).
    CREATE TABLE IF NOT EXISTS messages (room TEXT NOT NULL, msg TEXT NOT NULL,
        event TEXT NOT NULL, edited TEXT NOT NULL DEFAULT '', deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (room, msg));
    CREATE INDEX IF NOT EXISTS messages_event ON messages (event);
    CREATE TABLE IF NOT EXISTS parts (event TEXT PRIMARY KEY, room TEXT NOT NULL, msg TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reactions (room TEXT NOT NULL, msg TEXT NOT NULL, user TEXT NOT NULL,
        kind TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY (room, msg, user, kind));
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)
"""


def chat_db() -> sqlite3.Connection:
    db = sqlite3.connect(STATE_DIR / "teams.db", check_same_thread=False, timeout=30, isolation_level=None)
    # One transaction (SQLite's DDL is transactional): a start that stops halfway leaves the database as it was.
    db.execute("BEGIN IMMEDIATE")
    try:
        cols = lambda t: {c[1] for c in db.execute(f"PRAGMA table_info({t})")}
        names = lambda: {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        # The first version kept messages, parts and reactions per account; a Teams message id is unique only in its
        # chat (its room). Its tables are renamed, the current ones made, and the rows carried over per room.
        for t in ("messages", "parts", "reactions"):
            if "account" in cols(t) and f"old_{t}" not in names():
                db.execute(f"ALTER TABLE {t} RENAME TO old_{t}")
        if "old_messages" in names():
            db.execute("DROP INDEX IF EXISTS messages_event")
        for statement in SCHEMA.split(";"):
            if statement.strip():
                db.execute(statement)
        old = names()
        if "old_messages" in old:
            db.execute("INSERT OR IGNORE INTO messages SELECT room, msg, event, edited, deleted FROM old_messages")
            if "old_parts" in old:
                db.execute("INSERT OR IGNORE INTO parts SELECT p.event, m.room, p.msg FROM old_parts p JOIN old_messages m USING (account, msg)")
            if "old_reactions" in old:
                db.execute("INSERT OR IGNORE INTO reactions SELECT m.room, r.msg, r.user, r.kind, r.event FROM old_reactions r "
                           "JOIN old_messages m USING (account, msg)")
        for t in ("messages", "parts", "reactions"):
            db.execute(f"DROP TABLE IF EXISTS old_{t}")
        db.execute("COMMIT")
    except BaseException:
        db.execute("ROLLBACK")
        raise
    db.isolation_level = ""  # the rest of the bridge commits by itself, as before
    return db


class Teams:
    """Teams chats as Matrix rooms, for every connected Teams login."""

    def __init__(self):
        self.db = chat_db()
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.outbox: queue.Queue = queue.Queue()
        self.turn: dict[str, int] = {}  # per account: which recently active chats are looked at again next
        self.sweep: dict[str, int] = {}  # per account: which of all its chats is looked at again next
        self.rooms_lock = threading.Lock()  # one room per chat, also when Ctrl+N and a poll meet
        self.receipts: dict[str, list[str]] = {}  # room -> the events Karchi's last receipts there named
        self.receipt_at: dict[str, float] = {}  # event -> when Karchi's receipt on it came (wall clock)
        self.dirty: set[str] = set()  # rooms to look at again (a receipt, or a message of someone else)
        self.busy: set[str] = set()  # rooms being looked at now
        self.read_at: dict[str, float] = {}  # room -> not before this (monotonic): READ_GAP, or Microsoft's Retry-After
        self.read_cv = threading.Condition()
        self.read_next = 0.0  # no chat's check starts before this (monotonic)

    # -------------------------------------------------- small helpers

    def kv(self, key: str, value: str | None = None) -> str | None:
        with self.lock:
            if value is None:
                row = self.db.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
                return row[0] if row else None
            self.db.execute("INSERT OR REPLACE INTO kv VALUES (?, ?)", (key, value))
            self.db.commit()
            return value

    def graph(self, account: str, method: str, url: str, body=None, **kw):
        return ACCOUNTS.graph("teams", account, method, url, body, **kw)

    def me(self, account: str) -> str:
        return (ACCOUNTS.get("teams", account) or {}).get("oid", account).lower()

    def ghost(self, account: str, user: dict) -> str:
        oid = str(user.get("id") or "").lower()
        if oid == self.me(account):
            return ADMIN
        key = re.sub(r"[^a-z0-9-]", "", oid) or short(str(user.get("displayName") or "Teams"), 16)
        mxid = f"@teams_{key}:{SERVER_NAME}"
        name = str(user.get("displayName") or "").strip()
        with self.lock:
            row = self.db.execute("SELECT name, photo FROM ghosts WHERE mxid = ?", (mxid,)).fetchone()
        if row is None:
            try:
                matrix("POST", "/register", {"type": "m.login.application_service", "username": f"teams_{key}"}, user=None)
            except MatrixError as err:
                if err.errcode != "M_USER_IN_USE":
                    raise
        if name and (row is None or row[0] != name):
            matrix("PUT", f"/profile/{q(mxid)}/displayname", {"displayname": name}, user=mxid)
        if row is None or (name and row[0] != name):
            with self.lock:
                self.db.execute("INSERT INTO ghosts VALUES (?, ?, 0) ON CONFLICT(mxid) DO UPDATE SET name = excluded.name",
                                (mxid, name or (row[0] if row else "Teams")))
                self.db.commit()
        if (row is None or not row[1]) and oid and re.fullmatch(r"[0-9a-f-]{36}", oid):
            self.photo(account, oid, mxid)
        return mxid

    def photo(self, account: str, oid: str, mxid: str) -> None:
        """The person's Teams photo, once; nobody's photo is tried again and again."""
        try:
            data, kind = self.graph(account, "GET", f"/users/{q(oid)}/photos/96x96/$value", raw=True, timeout=30)
            if data and kind.startswith("image/"):
                url = matrix_upload(data, "photo.jpg", kind)
                matrix("PUT", f"/profile/{q(mxid)}/avatar_url", {"avatar_url": url}, user=mxid)
        except (GraphError, Throttled, ApiError, MatrixError, OSError):
            pass
        with self.lock:
            self.db.execute("UPDATE ghosts SET photo = 1 WHERE mxid = ?", (mxid,))
            self.db.commit()

    def join(self, room: str, mxid: str) -> None:
        with self.lock:
            if self.db.execute("SELECT 1 FROM members WHERE room = ? AND mxid = ?", (room, mxid)).fetchone():
                return
        if mxid != ADMIN:
            try:
                matrix("POST", f"/rooms/{q(room)}/invite", {"user_id": mxid})
            except MatrixError as err:
                if err.errcode != "M_FORBIDDEN":
                    raise
        matrix("POST", f"/join/{q(room)}", {}, user=mxid)
        with self.lock:
            self.db.execute("INSERT OR IGNORE INTO members VALUES (?, ?)", (room, mxid))
            self.db.commit()

    def chat_of_room(self, room: str) -> tuple[str, str] | None:
        with self.lock:
            row = self.db.execute("SELECT account, chat FROM chats WHERE room = ?", (room,)).fetchone()
        return (row[0], row[1]) if row else None

    def room_of(self, account: str, chat: str) -> str | None:
        with self.lock:
            row = self.db.execute("SELECT room FROM chats WHERE account = ? AND chat = ?", (account, chat)).fetchone()
        return row[0] if row else None

    def notice(self, room: str, text: str, about: str = "") -> None:
        content = {"msgtype": "m.notice", "body": text, MARK: 1}
        if about:
            content["m.relates_to"] = {"m.in_reply_to": {"event_id": about}}
        matrix("PUT", f"/rooms/{q(room)}/send/m.room.message/{uuid.uuid4().hex}", content)

    def failed(self, room: str, event: str, reason: str) -> None:
        """Weft's „neodišlo“ under the message: the wording of the mautrix bridges' notice (app.js bridgeFailure)."""
        try:
            self.notice(room, f"⚠️ Your message was not bridged: {reason}", event)
        except MatrixError as err:
            log("teams: failure notice", err)

    # -------------------------------------------------- rooms

    def members_of(self, account: str, chat: str) -> list[dict]:
        found = self.graph(account, "GET", f"/chats/{q(chat)}/members").get("value") or []
        return [m for m in found if isinstance(m, dict) and m.get("userId")]

    def chat_name(self, account: str, info: dict, members: list[dict]) -> str:
        if info.get("topic"):
            return str(info["topic"])
        if info.get("chatType") == "oneOnOne":
            other = [m for m in members if str(m.get("userId")).lower() != self.me(account)]
            return str((other or members or [{}])[0].get("displayName") or "")
        return ""  # a group without a name: Weft names it by its people, as Teams does

    def ensure_room(self, account: str, info: dict) -> str:
        with self.rooms_lock:
            return self.make_room(account, info)

    def make_room(self, account: str, info: dict) -> str:
        chat = str(info["id"])
        room = self.room_of(account, chat)
        if room:
            return room
        members = self.members_of(account, chat)
        ghosts = [self.ghost(account, {"id": m.get("userId"), "displayName": m.get("displayName")}) for m in members]
        name = self.chat_name(account, info, members)
        direct = info.get("chatType") == "oneOnOne"
        bridge = {"bridgebot": BOT, "creator": BOT,
                  "protocol": {"id": "teams", "displayname": "Microsoft Teams"},
                  "channel": {"id": chat, "displayname": name}}
        state = [{"type": "m.bridge", "state_key": f"teams://{short(account + chat)}", "content": bridge}]
        room = matrix("POST", "/createRoom", {
            "preset": "private_chat", "invite": [ADMIN], "is_direct": direct,
            **({"name": name} if name and not direct else {}),
            "initial_state": state, "creation_content": {"m.federate": False},
        })["room_id"]
        with self.lock:
            self.db.execute("INSERT INTO chats (account, chat, room, kind, name) VALUES (?, ?, ?, ?, ?)",
                            (account, chat, room, str(info.get("chatType") or ""), name))
            self.db.executemany("INSERT OR IGNORE INTO members VALUES (?, ?)", [(room, BOT)])
            self.db.commit()
        self.join(room, ADMIN)
        for mxid in ghosts:
            if mxid != ADMIN:
                self.join(room, mxid)
        return room

    def rename(self, account: str, info: dict, room: str) -> None:
        """A group renamed in Teams gets its new name in Weft."""
        topic = str(info.get("topic") or "")
        with self.lock:
            row = self.db.execute("SELECT name, kind FROM chats WHERE room = ?", (room,)).fetchone()
        if not row or row[1] == "oneOnOne" or not topic or topic == row[0]:
            return
        matrix("PUT", f"/rooms/{q(room)}/state/m.room.name/", {"name": topic})
        matrix("PUT", f"/rooms/{q(room)}/state/m.bridge/{q('teams://' + short(account + str(info['id'])))}", {
            "bridgebot": BOT, "creator": BOT, "protocol": {"id": "teams", "displayname": "Microsoft Teams"},
            "channel": {"id": str(info["id"]), "displayname": topic}})
        with self.lock:
            self.db.execute("UPDATE chats SET name = ? WHERE room = ?", (topic, room))
            self.db.commit()

    # -------------------------------------------------- Teams → Matrix

    def files_of(self, account: str, msg: dict) -> list[tuple[str, str, bytes | None, str]]:
        """(name, mimetype, bytes or None when too big or unreadable, link) of a message's photos and files."""
        out = []
        for n, src in enumerate(HOSTED.findall(str((msg.get("body") or {}).get("content") or ""))):
            src = html.unescape(src)
            if not src.startswith(GRAPH + "/"):
                continue  # only Graph gets Karchi's token
            try:
                data, kind = self.graph(account, "GET", src, raw=True, timeout=120)
                ext = mimetypes.guess_extension(kind.split(";")[0]) or ".png"
                out.append((f"obrazok-{n + 1}{ext}", kind.split(";")[0] or "image/png", data if len(data) <= FILE_MAX else None, ""))
            except (GraphError, Throttled):
                out.append((f"obrazok-{n + 1}.png", "image/png", None, ""))
        for att in msg.get("attachments") or []:
            if not isinstance(att, dict) or att.get("contentType") != "reference" or not att.get("contentUrl"):
                continue
            url, name = str(att["contentUrl"]), str(att.get("name") or "subor")
            kind = mimetypes.guess_type(name)[0] or "application/octet-stream"
            share = "u!" + b64url(url.encode())
            try:
                item = self.graph(account, "GET", f"/shares/{share}/driveItem?$select=name,size,file,@microsoft.graph.downloadUrl")
                link = item.get("@microsoft.graph.downloadUrl")
                if int(item.get("size") or 0) > FILE_MAX or not link:
                    out.append((name, kind, None, url))
                    continue
                data = graph_raw(None, "GET", link, raw=True, timeout=180)[0]
                out.append((name, (item.get("file") or {}).get("mimeType") or kind, data, url))
            except (GraphError, Throttled, ApiError):
                out.append((name, kind, None, url))
        return out

    def cards_of(self, msg: dict) -> str:
        kinds = [a.get("contentType") for a in msg.get("attachments") or [] if isinstance(a, dict)]
        cards = [k for k in kinds if k and k not in ("reference", "messageReference")]
        return "\n[Karta z Teams – otvor ju v Teams]" if cards else ""

    def text_of(self, account: str, msg: dict) -> tuple[str, dict]:
        """A Teams message's text, and its mentions as Weft reads them (formatted_body with matrix.to links)."""
        body = msg.get("body") or {}
        markup = str(body.get("content") or "")
        if str(body.get("contentType")).lower() != "html":
            return markup.strip(), {}
        people = {}
        for m in msg.get("mentions") or []:
            user = ((m or {}).get("mentioned") or {}).get("user") or {}
            if user.get("id") and isinstance(m.get("id"), int):
                people[m["id"]] = self.ghost(account, user)
        names: list[tuple[str, str]] = []

        def pin(m):
            names.append((people.get(int(m.group(1)), ""), html_text(m.group(2))))
            return f"\ue000{len(names) - 1}\ue001"
        text = teams_text(AT.sub(pin, markup))
        if not names:
            return text, {}
        plain = PIN.sub(lambda m: names[int(m.group(1))][1], text)
        linked = [mx for mx, _ in names if mx]
        if not linked:
            return plain, {}
        rich = PIN.sub(lambda m: (f'<a href="https://matrix.to/#/{html.escape(names[int(m.group(1))][0])}">{html.escape(names[int(m.group(1))][1])}</a>'
                                  if names[int(m.group(1))][0] else html.escape(names[int(m.group(1))][1])), html.escape(text, quote=False))
        return plain, {"format": "org.matrix.custom.html", "formatted_body": rich.replace("\n", "<br>"),
                       "m.mentions": {"user_ids": sorted(set(linked))}}

    def post(self, account: str, room: str, msg: dict, seen: bool = False) -> str | None:
        """A new Teams message as events (text, then files); returns the first event. seen: history Karchi already read
        in Teams."""
        sender = self.ghost(account, (msg.get("from") or {}).get("user") or {"displayName": "Teams"})
        self.join(room, sender)
        ts = iso_ms(msg.get("createdDateTime")) or now_ms()
        text, rich = self.text_of(account, msg)
        cards = self.cards_of(msg)
        if cards:
            text, rich = text + cards, {}
        if msg.get("subject"):
            text, rich = f"{msg['subject']}\n{text}".strip(), {}
        reply = None
        for att in msg.get("attachments") or []:
            if isinstance(att, dict) and att.get("contentType") == "messageReference" and att.get("id"):
                with self.lock:
                    row = self.db.execute("SELECT event FROM messages WHERE room = ? AND msg = ?", (room, str(att["id"]))).fetchone()
                reply = row[0] if row else None
        files = self.files_of(account, msg)
        events = []
        base = f"teams-{short(room + str(msg['id']), 24)}"
        mark = {MARK: str(msg["id"])}
        rel = {"m.relates_to": {"m.in_reply_to": {"event_id": reply}}} if reply else {}
        if text or not files:
            content = {"msgtype": "m.text", "body": text or "[prázdna správa]", **rich, **mark, **rel}
            events.append(matrix("PUT", f"/rooms/{q(room)}/send/m.room.message/{base}-0", content, user=sender, query={"ts": ts})["event_id"])
            rel = {}
        for n, (name, kind, data, link) in enumerate(files, 1):
            if data is None:
                content = {"msgtype": "m.text", "body": f"[Súbor: {name}]" + (f" {link}" if link else " (nedá sa preniesť, otvor ho v Teams)"), **mark, **rel}
            else:
                url = matrix_upload(data, name, kind)
                msgtype = "m.image" if kind.startswith("image/") else "m.video" if kind.startswith("video/") else "m.audio" if kind.startswith("audio/") else "m.file"
                content = {"msgtype": msgtype, "body": name, "url": url, "info": {"mimetype": kind, "size": len(data)}, **mark, **rel}
            events.append(matrix("PUT", f"/rooms/{q(room)}/send/m.room.message/{base}-{n}", content, user=sender, query={"ts": ts})["event_id"])
            rel = {}
        with self.lock:
            try:
                self.db.execute("INSERT OR REPLACE INTO messages VALUES (?, ?, ?, ?, 0)",
                                (room, str(msg["id"]), events[0], str(msg.get("lastEditedDateTime") or "")))
                self.db.executemany("INSERT OR IGNORE INTO parts VALUES (?, ?, ?)", [(e, room, str(msg["id"])) for e in events])
                if sender != ADMIN:  # one transaction with the message: a check of Karchi's reading never sees one without the other
                    self.note_incoming(room, events[-1], str(msg["id"]), ts, seen)
                self.db.commit()
            except BaseException:
                self.db.rollback()  # nothing of it stays for a later commit to carry
                raise
        return events[0]

    # -------------------------------------------------- Karchi's reading → Teams
    # Teams can only mark a whole chat read (markChatReadForUser). So it is told only when Karchi's receipt reaches
    # the newest message someone else wrote there and Teams has no message of someone else the bridge has not brought:
    # Weft's receipt stops before a message waiting for its reading window, so that one never shows as seen. The
    # bridge's own receipts for history Karchi read in Teams come back here too; they name nothing Teams does not know.
    # Graph's action has no message boundary: a message arriving in Teams between the last look (one GET) and the mark goes with it.

    def note_incoming(self, room: str, event: str, msg: str, ts: int, seen: bool) -> None:
        """The newest message of someone else in a room, written in the caller's transaction (post commits it with the
        message itself)."""
        with self.lock:
            now = json.loads(self.kv(f"incoming:{room}") or "null")
            if not now or int(now.get("ts") or 0) <= ts:
                put = "INSERT OR REPLACE INTO kv VALUES (?, ?)"
                # noted: when the bridge had it (a receipt given before then was not given for it)
                self.db.execute(put, (f"incoming:{room}", json.dumps({"event": event, "msg": msg, "ts": ts, "noted": time.time()})))
                if seen:
                    self.db.execute(put, (f"marked:{room}", event))
        if not seen:  # a receipt that waited for this message (the newest, or one that held the chat back) goes again
            with self.read_cv:
                if self.receipts.get(room):
                    self.dirty.add(room)
                    self.read_cv.notify()

    def receipt(self, edu: dict) -> None:
        """A receipt the homeserver pushed: Karchi's public m.read in one of this bridge's rooms."""
        room = str(edu.get("room_id") or "")
        content = edu.get("content")
        if edu.get("type") != "m.receipt" or not isinstance(content, dict) or not self.chat_of_room(room):
            return
        for target, kinds in content.items():
            readers = kinds.get("m.read") if isinstance(kinds, dict) else None
            mine = readers.get(ADMIN) if isinstance(readers, dict) else None
            if isinstance(mine, dict) and mine.get("thread_id", "main") == "main" and str(target).startswith("$"):
                # When Karchi gave it (the homeserver's time; a transaction can come late, after a bridge restart).
                given = mine.get("ts") / 1000 if isinstance(mine.get("ts"), (int, float)) and mine["ts"] > 0 else time.time()
                with self.read_cv:
                    self.receipt_at[str(target)] = min(self.receipt_at.get(str(target), given), given)
                    # The last few targets, not only the newest arrived: a receipt from another device may be older.
                    seen = [t for t in self.receipts.get(room, []) if t != target] + [str(target)]
                    self.receipts[room] = seen[-20:]
                    for t in seen[:-20]:
                        self.receipt_at.pop(t, None)
                    self.dirty.add(room)
                    self.read_cv.notify()

    def read_loop(self) -> None:
        """Looks at each chat with something new to tell, each in its own thread (one slow chat holds up no other),
        one chat at most every READ_GAP or after Microsoft's Retry-After."""
        while True:
            with self.read_cv:
                while True:
                    now = time.monotonic()
                    free = [r for r in self.dirty if r not in self.busy]
                    due = [r for r in free if self.read_at.get(r, 0) <= now]
                    if due and self.read_next <= now:
                        ready = due[:1]
                        self.read_next = now + READ_PACE
                        break
                    waits = [self.read_at[r] - now for r in free if r not in due] + ([self.read_next - now] if due else [])
                    self.read_cv.wait(min(waits) if waits else None)
                for room in ready:
                    self.dirty.discard(room)
                    self.busy.add(room)
            for room in ready:
                threading.Thread(target=self.read_one, args=(room,), name="teams-read", daemon=True).start()

    def read_one(self, room: str) -> None:
        with self.read_cv:
            targets = list(self.receipts.get(room, []))
        pause, again, best = 0.0, False, None
        try:
            asked, best = self.mark_read(room, targets)
            pause = READ_GAP if asked else 0.0
        except Throttled as err:
            pause, again = max(READ_GAP, err.seconds), True
        except (GraphError, ApiError) as err:
            log("teams: read", err)
            pause = READ_GAP
        except Exception as err:  # never leaves the chat busy for good
            log("teams: read", type(err).__name__, err)
            pause = READ_GAP
        finally:
            with self.read_cv:
                self.busy.discard(room)
                if best:  # only the furthest of the looked-at receipts is kept, with those that came meanwhile
                    self.receipts[room] = ([best] + [t for t in self.receipts.get(room, []) if t not in targets and t != best])[:20]
                    for t in targets:
                        if t not in self.receipts[room]:
                            self.receipt_at.pop(t, None)
                if pause:
                    self.read_at[room] = time.monotonic() + pause
                if again:
                    self.dirty.add(room)
                self.read_cv.notify()

    def mark_read(self, room: str, targets: list[str]) -> tuple[bool, str | None]:
        """Tells Teams Karchi read the chat, if a target reaches its newest unread message. Returns whether Graph was
        asked (then the chat waits READ_GAP) and the furthest target."""
        account, chat = self.chat_of_room(room) or ("", "")
        creds = ACCOUNTS.get("teams", account) if account else None

        def ts(event: str) -> int:
            try:
                return int(matrix("GET", f"/rooms/{q(room)}/event/{q(event)}").get("origin_server_ts") or 0)
            except MatrixError:
                return 0  # gone or not visible: it reaches nothing
        at = {t: ts(t) for t in targets}
        best = max(targets, key=lambda t: at[t], default=None)

        # One snapshot of the newest message of someone else; the bridge writes a message and this note together.
        with self.lock:
            newest = json.loads(self.kv(f"incoming:{room}") or "null")
            marked = self.kv(f"marked:{room}")
        if not creds or not newest or newest["event"] == marked:
            return False, best  # nothing came since Teams last knew the chat was read
        # The newest message's last event (its last file), or an event past it whose receipt came after the bridge had
        # the message: a bridged message keeps its Teams time, so Karchi's reply sent before it arrived lies past it in
        # time without his having seen it. An earlier part, or another event at the same ms, is not enough.
        last = ts(newest["event"])
        noted = float(newest.get("noted") or 0)
        with self.read_cv:
            came = {t: self.receipt_at.get(t, 0.0) for t in targets}
        if not last or not any(t == newest["event"] or (at[t] > last and came[t] > noted) for t in targets):
            return False, best
        # Teams' own newest messages: there must be one of someone else, and every such one must be one the bridge
        # brought, and nothing newer than the snapshot may have come meanwhile. Otherwise the chat would be marked with
        # a message Weft has not shown. Between this answer and the mark nothing else is asked.
        # One access token (valid at least a minute) for the look and the mark: no sign-in renewal between them.
        access = ACCOUNTS.token("teams", account)
        recent = graph_raw(access, "GET", f"/chats/{q(chat)}/messages?$top=50&$orderby=" + q("createdDateTime desc")).get("value") or []
        others = [str(m.get("id") or "") for m in recent if isinstance(m, dict) and m.get("messageType") == "message"
                  and not m.get("deletedDateTime") and str((((m.get("from") or {}).get("user")) or {}).get("id") or "").lower() != self.me(account)]
        with self.lock:
            if (not others or any(not self.msg_known(room, m) for m in others)
                    or json.loads(self.kv(f"incoming:{room}") or "null") != newest):
                return True, best
        graph_raw(access, "POST", f"/chats/{q(chat)}/markChatReadForUser",
                  {"user": {"id": creds.get("oid") or account, "tenantId": creds.get("tid") or ""}})
        self.kv(f"marked:{room}", newest["event"])
        return True, best

    def msg_known(self, room: str, msg: str) -> bool:
        with self.lock:
            return self.db.execute("SELECT 1 FROM messages WHERE room = ? AND msg = ?", (room, msg)).fetchone() is not None

    def apply(self, account: str, room: str, msg: dict, settle_before: int) -> str | None:
        """One message as Graph has it now: new, edited, deleted, or its reactions changed. Returns an event that
        may count as read (older than settle_before)."""
        if msg.get("messageType") == "systemEventMessage" and msg.get("id"):
            return self.call_log(account, room, msg, settle_before)
        if msg.get("messageType") != "message" or not msg.get("id"):
            return None
        ident = str(msg["id"])
        with self.lock:
            row = self.db.execute("SELECT event, edited, deleted FROM messages WHERE room = ? AND msg = ?", (room, ident)).fetchone()
        if row is None:
            if msg.get("deletedDateTime"):
                return None
            old = (iso_ms(msg.get("createdDateTime")) or now_ms()) < settle_before
            event = self.post(account, room, msg, old)
            self.react(account, room, ident, event, msg)
            return event if old else None
        event, edited, deleted = row
        if deleted:
            return None
        if msg.get("deletedDateTime"):
            with self.lock:
                parts = [r[0] for r in self.db.execute("SELECT event FROM parts WHERE room = ? AND msg = ?", (room, ident))]
                self.db.execute("UPDATE messages SET deleted = 1 WHERE room = ? AND msg = ?", (room, ident))
                self.db.commit()
            for part in parts or [event]:
                try:
                    matrix("PUT", f"/rooms/{q(room)}/redact/{q(part)}/{uuid.uuid4().hex}", {"reason": "zmazané v Teams", MARK: 1})
                except MatrixError as err:
                    log("teams: redact", err)
            return None
        if msg.get("lastEditedDateTime") and str(msg["lastEditedDateTime"]) != edited:
            text, rich = self.text_of(account, msg)
            sender = self.ghost(account, (msg.get("from") or {}).get("user") or {})
            new = {"msgtype": "m.text", "body": text or "[prázdna správa]", **rich}
            matrix("PUT", f"/rooms/{q(room)}/send/m.room.message/{uuid.uuid4().hex}", {
                "msgtype": "m.text", "body": "* " + new["body"], "m.new_content": new, MARK: ident,
                "m.relates_to": {"rel_type": "m.replace", "event_id": event}}, user=sender)
            with self.lock:
                self.db.execute("UPDATE messages SET edited = ? WHERE room = ? AND msg = ?", (str(msg["lastEditedDateTime"]), room, ident))
                self.db.commit()
        self.react(account, room, ident, event, msg)
        return None

    def call_log(self, account: str, room: str, msg: dict, settle_before: int) -> str | None:
        """Teams' note that a call or meeting ended, as the call row Weft knows from the mautrix bridges: the text
        „Call (3:12)“ marked com.beeper.action_message, from whoever started it. Graph tells who started it and how
        long it took, not whether it had video or whether anybody answered; a call without a length is just „Call“.
        Teams' other system notes (somebody added, a call started, a recording) stay out of the room."""
        detail = msg.get("eventDetail") if isinstance(msg.get("eventDetail"), dict) else {}
        if not str(detail.get("@odata.type") or "").endswith("callEndedEventMessageDetail") or detail.get("callEventType") not in ("call", "meeting"):
            return None
        ident = str(msg["id"])
        if self.msg_known(room, ident):
            return None
        sender = self.ghost(account, ((detail.get("initiator") or {}).get("user")) or {"displayName": "Teams"})
        self.join(room, sender)
        ts = iso_ms(msg.get("createdDateTime")) or now_ms()
        took = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.\d+)?S)?", str(detail.get("callDuration") or ""))
        days, hours, minutes, seconds = (int(x or 0) for x in took.groups()) if took else (0, 0, 0, 0)
        hours += days * 24
        length = f" ({hours}:{minutes:02}:{seconds:02})" if hours else f" ({minutes}:{seconds:02})" if minutes or seconds else ""
        content = {"msgtype": "m.text", "body": "Call" + length, "com.beeper.action_message": {"type": "call", "call_type": ""}, MARK: ident}
        event = matrix("PUT", f"/rooms/{q(room)}/send/m.room.message/teams-{short(room + ident, 24)}-0", content, user=sender, query={"ts": ts})["event_id"]
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO messages VALUES (?, ?, ?, '', 0)", (room, ident, event))
            self.db.execute("INSERT OR IGNORE INTO parts VALUES (?, ?, ?)", (event, room, ident))
            self.db.commit()
        return event if ts < settle_before else None

    def react(self, account: str, room: str, ident: str, event: str, msg: dict) -> None:
        now = {(str(((r.get("user") or {}).get("user") or {}).get("id") or (r.get("user") or {}).get("id") or "").lower(),
                reaction_key(str(r.get("reactionType") or ""))) for r in msg.get("reactions") or [] if isinstance(r, dict)}
        now = {x for x in now if x[0] and x[1]}
        with self.lock:
            had = {(u, k): e for u, k, e in self.db.execute(
                "SELECT user, kind, event FROM reactions WHERE room = ? AND msg = ?", (room, ident))}
        for user, kind in now - set(had):
            mxid = self.ghost(account, {"id": user})
            if mxid != ADMIN:
                self.join(room, mxid)
            sent = matrix("PUT", f"/rooms/{q(room)}/send/m.reaction/{uuid.uuid4().hex}", {
                "m.relates_to": {"rel_type": "m.annotation", "event_id": event, "key": kind}, MARK: ident}, user=mxid)
            with self.lock:
                self.db.execute("INSERT OR REPLACE INTO reactions VALUES (?, ?, ?, ?, ?)", (room, ident, user, kind, sent["event_id"]))
                self.db.commit()
        for (user, kind), ev in had.items():
            if (user, kind) in now:
                continue
            try:
                matrix("PUT", f"/rooms/{q(room)}/redact/{q(ev)}/{uuid.uuid4().hex}", {MARK: 1})
            except MatrixError as err:
                log("teams: unreact", err)
            with self.lock:
                self.db.execute("DELETE FROM reactions WHERE room = ? AND msg = ? AND user = ? AND kind = ?", (room, ident, user, kind))
                self.db.commit()

    def changes(self, account: str, chat: str, cursor: int) -> list[dict]:
        """Messages created or changed after cursor (ms; a new chat: its last page), oldest first."""
        if cursor:
            url = f"/chats/{q(chat)}/messages?$top=50&$orderby=" + q("lastModifiedDateTime desc") + "&$filter=" + q(f"lastModifiedDateTime gt {iso(cursor)}")
            pages = 10
        else:
            url = f"/chats/{q(chat)}/messages?$top={FIRST_MESSAGES}&$orderby=" + q("createdDateTime desc")
            pages = 1
        out = []
        for _ in range(pages):
            page = self.graph(account, "GET", url)
            out += [m for m in page.get("value") or [] if isinstance(m, dict)]
            url = page.get("@odata.nextLink")
            if not url:
                break
        return sorted(out, key=lambda m: (iso_ms(m.get("createdDateTime")), str(m.get("id"))))

    def sync_chat(self, account: str, info: dict, settle_before: int) -> None:
        chat = str(info["id"])
        room = self.ensure_room(account, info)
        self.rename(account, info, room)
        with self.lock:
            cursor = int(self.db.execute("SELECT cursor FROM chats WHERE room = ?", (room,)).fetchone()[0] or 0)
        messages = self.changes(account, chat, cursor)
        settled = None
        for msg in messages:
            settled = self.apply(account, room, msg, settle_before) or settled
            cursor = max(cursor, iso_ms(msg.get("lastModifiedDateTime")) or iso_ms(msg.get("createdDateTime")))
        preview = iso_ms(((info.get("lastMessagePreview") or {}).get("createdDateTime")))
        with self.lock:
            self.db.execute("UPDATE chats SET cursor = ?, preview = max(preview, ?) WHERE room = ?", (str(cursor), preview, room))
            self.db.commit()
        if settled:
            matrix("POST", f"/rooms/{q(room)}/receipt/m.read/{q(settled)}", {}, user=ADMIN)

    def poll(self, account: str) -> None:
        first = self.kv(f"since:{account}") is None
        since = int(self.kv(f"since:{account}") or (now_ms() - FIRST_DAYS * 86400_000))
        polled = int(self.kv(f"polled:{account}") or 0)
        # On the first sync everything is history Karchi saw in Teams; later only what came after the last poll is new.
        settle_before = now_ms() if first else polled
        started = now_ms()
        chats = self.graph(account, "GET", "/me/chats?$expand=lastMessagePreview&$orderby=" + q("lastMessagePreview/createdDateTime desc") + "&$top=50").get("value") or []
        moved = []
        for info in chats:
            if not isinstance(info, dict) or not info.get("id"):
                continue
            at = iso_ms(((info.get("lastMessagePreview") or {}).get("createdDateTime")))
            with self.lock:
                row = self.db.execute("SELECT preview FROM chats WHERE account = ? AND chat = ?", (account, str(info["id"]))).fetchone()
            if row is None and at >= since or row is not None and at > row[0]:
                moved.append(info)
        # Edits, reactions and deletions do not move a chat: each poll looks again at two recently active chats and
        # at one more of all of them in turn, so an old chat catches up within (number of chats) polls.
        with self.lock:
            recent = [r[0] for r in self.db.execute("SELECT chat FROM chats WHERE account = ? AND preview > ? ORDER BY preview DESC LIMIT 12",
                                                    (account, now_ms() - 3 * 86400_000))]
            every = [r[0] for r in self.db.execute("SELECT chat FROM chats WHERE account = ? ORDER BY chat", (account,))]
        ids = {str(i["id"]) for i in moved}
        again = [c for c in recent if c not in ids]
        turn, sweep = self.turn.get(account, 0), self.sweep.get(account, 0)
        picked = [again[(turn + n) % len(again)] for n in range(min(2, len(again)))] if again else []
        if every:
            picked.append(every[sweep % len(every)])
        self.turn[account], self.sweep[account] = turn + 2, sweep + 1
        for chat in dict.fromkeys(c for c in picked if c not in ids):
            moved.append(next((i for i in chats if str(i.get("id")) == chat), {"id": chat}))
        for info in moved:
            try:
                self.sync_chat(account, info, settle_before)
            except Throttled:
                raise
            except Exception as err:  # one chat must not hold up the others
                log("teams: chat sync", type(err).__name__, getattr(err, "status", ""), getattr(err, "code", "") or getattr(err, "errcode", ""))
        if first:
            self.kv(f"since:{account}", str(since))
        self.kv(f"polled:{account}", str(started))

    # -------------------------------------------------- Matrix → Teams

    def take(self, event: dict) -> None:
        """An event the homeserver pushed: Karchi's own, in one of this bridge's rooms, not written by the bridge."""
        content = event.get("content") or {}
        if event.get("sender") != ADMIN or MARK in content or not self.chat_of_room(str(event.get("room_id") or "")):
            return
        if event.get("type") in ("m.room.message", "m.reaction", "m.room.redaction"):
            self.outbox.put(event)
            self.wake.set()

    def send_outbox(self) -> None:
        while True:
            try:
                event = self.outbox.get_nowait()
            except queue.Empty:
                return
            room = event["room_id"]
            account, chat = self.chat_of_room(room) or ("", "")
            try:
                if not ACCOUNTS.get("teams", account):
                    raise ApiError(401, "SK.KARCHI.BAD_CREDENTIALS", "not logged in: Teams účet je odhlásený")
                kind = event["type"]
                if kind == "m.reaction":
                    self.send_reaction(account, chat, room, event)
                elif kind == "m.room.redaction":
                    self.send_redaction(account, chat, room, event)
                elif (event.get("content") or {}).get("m.relates_to", {}).get("rel_type") == "m.replace":
                    self.send_edit(account, chat, room, event)
                else:
                    self.send_message(account, chat, room, event)
            except ApiError as err:
                reason = "not logged in, relogin" if err.errcode in NEEDS_KARCHI or err.errcode == "SK.KARCHI.NO_LOGIN" else err.message
                self.failed(room, event["event_id"], reason)
            except Throttled:
                self.failed(room, event["event_id"], "timed out: Teams teraz neprijíma, skús to o chvíľu")
            except GraphError as err:
                log("teams: send", err.status, err.code)
                self.failed(room, event["event_id"], f"Teams správu odmietol ({err.status} {err.code})")
            except Exception as err:
                log("teams: send", repr(err))
                self.failed(room, event["event_id"], "Teams správu neprijal")

    def msg_of(self, room: str, event: str) -> str | None:
        with self.lock:
            row = self.db.execute("SELECT msg FROM parts WHERE room = ? AND event = ?", (room, event)).fetchone() \
                or self.db.execute("SELECT msg FROM messages WHERE room = ? AND event = ?", (room, event)).fetchone()
        return row[0] if row else None

    def upload_drive(self, account: str, chat: str, name: str, data: bytes) -> dict:
        """A file into Karchi's OneDrive (Microsoft Teams Chat Files, as Teams does), readable by the chat's people."""
        path = "/me/drive/root:/" + q("Microsoft Teams Chat Files") + "/" + q(name)
        if len(data) <= 4 * 1024 * 1024:
            item = self.graph(account, "PUT", f"{path}:/content?@microsoft.graph.conflictBehavior=rename", data=data,
                              headers={"Content-Type": "application/octet-stream"}, timeout=180)
        else:
            session = self.graph(account, "POST", f"{path}:/createUploadSession", {"item": {"@microsoft.graph.conflictBehavior": "rename"}})
            item = upload_in_session(session["uploadUrl"], data)
        people = [str(m.get("email")) for m in self.members_of(account, chat)
                  if m.get("email") and str(m.get("userId")).lower() != self.me(account)]
        if people:
            self.graph(account, "POST", f"/me/drive/items/{q(item['id'])}/invite", {
                "recipients": [{"email": e} for e in people], "requireSignIn": True, "sendInvitation": False, "roles": ["read"]})
        return item

    def send_message(self, account: str, chat: str, room: str, event: dict) -> None:
        content = event.get("content") or {}
        msgtype = content.get("msgtype")
        text = re.sub(r"^(> .*\n)+\n", "", str(content.get("body") or "")) if msgtype in ("m.text", "m.notice", "m.emote") else ""
        markup, mentions = self.markup(content, text)
        attachments, hosted = [], []
        if msgtype in ("m.image", "m.file", "m.video", "m.audio"):
            name = str(content.get("filename") or content.get("body") or "subor")
            kind = str((content.get("info") or {}).get("mimetype") or mimetypes.guess_type(name)[0] or "application/octet-stream")
            data = homeserver_file(str(content.get("url") or ""), None, FILE_MAX, "súbor je väčší ako 25 MB")
            caption = str(content.get("body") or "") if content.get("filename") and content.get("body") != content.get("filename") else ""
            markup = html.escape(caption).replace("\n", "<br>")
            if msgtype == "m.image" and len(data) < SMALL_ATTACH:
                hosted.append({"@microsoft.graph.temporaryId": "1", "contentBytes": base64.b64encode(data).decode(), "contentType": kind})
                markup += '<img src="../hostedContents/1/$value" alt="obrázok">'
            else:
                item = self.upload_drive(account, chat, name, data)
                guid = (re.search(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f-]{27}", str(item.get("eTag") or "")) or [uuid.uuid4().hex])[0]
                attachments.append({"id": guid.lower(), "contentType": "reference", "contentUrl": item.get("webUrl"), "name": item.get("name") or name})
                markup += f'<attachment id="{guid.lower()}"></attachment>'
        elif msgtype not in ("m.text", "m.notice", "m.emote") or not text.strip():
            return
        answers = ((content.get("m.relates_to") or {}).get("m.in_reply_to") or {}).get("event_id")
        quoted = self.msg_of(room, answers) if answers else None
        body = {"body": {"contentType": "html", "content": markup}}
        if mentions:
            body["mentions"] = mentions
        if attachments or hosted:
            body["attachments"] = attachments
        if hosted:
            body["hostedContents"] = hosted
        if quoted:
            original = self.graph(account, "GET", f"/chats/{q(chat)}/messages/{q(quoted)}")
            ref = {"id": quoted, "contentType": "messageReference", "content": json.dumps({
                "messageId": quoted, "messagePreview": teams_text(str((original.get("body") or {}).get("content") or ""))[:200],
                "messageSender": original.get("from")})}
            body["attachments"] = [*body.get("attachments", []), ref]
            body["body"]["content"] = f'<attachment id="{quoted}"></attachment>' + markup
        sent = self.graph(account, "POST", f"/chats/{q(chat)}/messages", body)
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO messages VALUES (?, ?, ?, ?, 0)",
                            (room, str(sent["id"]), event["event_id"], str(sent.get("lastEditedDateTime") or "")))
            self.db.execute("INSERT OR IGNORE INTO parts VALUES (?, ?, ?)", (event["event_id"], room, str(sent["id"])))
            self.db.commit()

    def markup(self, content: dict, text: str) -> tuple[str, list[dict]]:
        """What Karchi wrote as Teams HTML; his @mentions of people in Teams become Teams mentions."""
        formatted = content.get("formatted_body")
        if content.get("format") == "org.matrix.custom.html" and isinstance(formatted, str) and "matrix.to" in formatted:
            ghosts = {f"@teams_{oid}:{SERVER_NAME}": oid for oid in (re.findall(r"@teams_([0-9a-f-]{36}):", urllib.parse.unquote(formatted)))}
            return mention_markup(formatted, ghosts)
        return html.escape(text).replace("\n", "<br>"), []

    def send_edit(self, account: str, chat: str, room: str, event: dict) -> None:
        content = event.get("content") or {}
        target = self.msg_of(room, str(content["m.relates_to"].get("event_id") or ""))
        if not target:
            raise ApiError(404, "SK.KARCHI.UNKNOWN", "Teams túto správu nepozná")
        new = content.get("m.new_content") or {}
        markup, mentions = self.markup(new, str(new.get("body") or ""))
        self.graph(account, "PATCH", f"/chats/{q(chat)}/messages/{q(target)}",
                   {"body": {"contentType": "html", "content": markup}, **({"mentions": mentions} if mentions else {})})
        current = self.graph(account, "GET", f"/chats/{q(chat)}/messages/{q(target)}")
        with self.lock:
            self.db.execute("UPDATE messages SET edited = ? WHERE room = ? AND msg = ?", (str(current.get("lastEditedDateTime") or ""), room, target))
            self.db.commit()

    def send_reaction(self, account: str, chat: str, room: str, event: dict) -> None:
        rel = (event.get("content") or {}).get("m.relates_to") or {}
        target = self.msg_of(room, str(rel.get("event_id") or ""))
        key = str(rel.get("key") or "")
        if not target or not key:
            raise ApiError(404, "SK.KARCHI.UNKNOWN", "Teams túto správu nepozná")
        self.graph(account, "POST", f"/chats/{q(chat)}/messages/{q(target)}/setReaction", {"reactionType": teams_reaction(key)})
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO reactions VALUES (?, ?, ?, ?, ?)", (room, target, self.me(account), reaction_key(key), event["event_id"]))
            self.db.commit()

    def send_redaction(self, account: str, chat: str, room: str, event: dict) -> None:
        redacts = str(event.get("redacts") or (event.get("content") or {}).get("redacts") or "")
        with self.lock:
            reaction = self.db.execute("SELECT msg, kind FROM reactions WHERE room = ? AND event = ? AND user = ?",
                                       (room, redacts, self.me(account))).fetchone()
        if reaction:
            self.graph(account, "POST", f"/chats/{q(chat)}/messages/{q(reaction[0])}/unsetReaction", {"reactionType": teams_reaction(reaction[1])})
            with self.lock:
                self.db.execute("DELETE FROM reactions WHERE room = ? AND event = ?", (room, redacts))
                self.db.commit()
            return
        target = self.msg_of(room, redacts)
        if not target:
            return  # a notice or something Teams never had
        me = self.me(account)
        self.graph(account, "POST", f"/users/{q(me)}/chats/{q(chat)}/messages/{q(target)}/softDelete")
        with self.lock:
            self.db.execute("UPDATE messages SET deleted = 1 WHERE room = ? AND msg = ?", (room, target))
            self.db.commit()

    # -------------------------------------------------- people, new chats

    def login_for(self, login_id: str) -> str:
        usable = ACCOUNTS.usable("teams")
        if login_id:
            if login_id not in usable:
                raise ApiError(404, "FI.MAU.NOT_LOGGED_IN", "not logged in: tento Teams účet tu nie je")
            return login_id
        if not usable:
            raise ApiError(404, "FI.MAU.NOT_LOGGED_IN", "not logged in: Teams nie je pripojený")
        return usable[0]

    def person(self, account: str, user: dict) -> dict:
        oid = str(user.get("id") or "").lower()
        dm = ""
        with self.lock:
            for room, in self.db.execute("SELECT c.room FROM chats c JOIN members m ON m.room = c.room WHERE c.account = ? "
                                         "AND c.kind = 'oneOnOne' AND m.mxid = ?", (account, f"@teams_{oid}:{SERVER_NAME}")):
                dm = room
        return {"id": oid, "name": str(user.get("displayName") or ""), "identifiers": [f"teams:{user.get('mail') or user.get('userPrincipalName') or oid}"],
                "mxid": f"@teams_{oid}:{SERVER_NAME}", **({"dm_room_mxid": dm} if dm else {})}

    def search(self, account: str, query: str) -> list[dict]:
        text = query.replace('"', "").strip()
        if len(text) < 2:
            return []
        found = self.graph(account, "GET", "/users?$top=20&$select=id,displayName,mail,userPrincipalName&$search="
                           + q(f'"displayName:{text}" OR "mail:{text}"'), headers={"ConsistencyLevel": "eventual"}).get("value") or []
        return [self.person(account, u) for u in found if isinstance(u, dict) and u.get("id") and str(u["id"]).lower() != self.me(account)]

    def resolve(self, account: str, ident: str) -> dict:
        try:
            user = self.graph(account, "GET", f"/users/{q(ident)}?$select=id,displayName,mail,userPrincipalName")
        except GraphError as err:
            if err.status in (400, 404):
                raise ApiError(404, "M_NOT_FOUND", "Teams takého človeka nepozná.") from None
            raise
        return self.person(account, user)

    def create_dm(self, account: str, ident: str) -> dict:
        found = self.resolve(account, ident)
        if found.get("dm_room_mxid"):
            return {"dm_room_mxid": found["dm_room_mxid"]}
        bind = lambda oid: {"@odata.type": "#microsoft.graph.aadUserConversationMember", "roles": ["owner"],
                            "user@odata.bind": f"https://graph.microsoft.com/v1.0/users('{oid}')"}
        info = self.graph(account, "POST", "/chats", {"chatType": "oneOnOne", "members": [bind(self.me(account)), bind(found["id"])]})
        return {"dm_room_mxid": self.ensure_room(account, info)}

    def run(self) -> None:
        last: dict[str, float] = {}
        bot = False
        while True:
            if not bot:
                try:  # the appservice's own user writes rooms and notices
                    matrix("POST", "/register", {"type": "m.login.application_service", "username": "teamsbot"}, user=None)
                    bot = True
                except MatrixError as err:
                    bot = err.errcode == "M_USER_IN_USE"
                except OSError:
                    pass
            try:
                self.send_outbox()
                for account in ACCOUNTS.usable("teams"):
                    if time.time() - last.get(account, 0) < POLL_SECONDS:
                        continue
                    last[account] = time.time()
                    try:
                        self.poll(account)
                    except Throttled as err:
                        last[account] = time.time() + err.seconds
                    except (ApiError, GraphError, MatrixError) as err:
                        log("teams: poll", type(err).__name__, getattr(err, "status", ""), getattr(err, "code", "") or getattr(err, "errcode", ""))
                    self.send_outbox()  # what Karchi wrote while a long poll ran goes out before the next one
            except Exception as err:  # the loop never dies; the next round tries again
                log("teams: loop", repr(err))
            self.wake.wait(POLL_SECONDS)
            self.wake.clear()


TEAMS: Teams


# ---------------------------------------------------------------- API


def route(product: str, method: str, parts: list[str], body: dict, args: dict, token: str) -> dict:
    spec = PRODUCTS[product]
    flow = {"id": "microsoft", "name": "Microsoft", "description": f"{spec['name']} cez prihlásenie Microsoftom"}
    match method, parts:
        case "GET", ["whoami"]:
            return {"network": {"displayname": spec["name"]}, "login_flows": [flow], "homeserver": SERVER_NAME,
                    "logins": ACCOUNTS.view(product)}
        case "GET", ["login", "flows"]:
            return {"flows": [flow]}
        case "POST", ["login", "start", "microsoft"]:
            return start_login(product, args.get("full") == "1")
        case "POST", ["login", "step", process_id, step_id, "user_input"] if step_id == STEP_ID:
            # Weft starts a fresh sign-in after any failure that is not a wrong paste (a code works once).
            try:
                found = process(process_id)
                if found.get("product") != product:
                    raise ApiError(404, "SK.KARCHI.EXPIRED", "Prihlásenie vypršalo.")
                return submit_login(product, process_id, found, body)
            except ApiError as err:
                if err.errcode != "SK.KARCHI.INVALID_INPUT" and err.message != BAD_CLIENT:
                    err.message += " Klikni znova Otvoriť Microsoft."
                raise
        case "POST", ["login", "cancel", process_id]:
            # A full sign-in closed unfinished: Microsoft may have stopped it at "Need admin approval" with no way back
            # to Weft, so the next one asks only for what mail and chats need.
            if (PROCESSES.pop(process_id, None) or {}).get("extras"):
                BASE_ONLY[product] = time.time()
            return {}
        case "POST", ["logout", login_id]:
            if not ACCOUNTS.remove(product, login_id):
                raise ApiError(404, "SK.KARCHI.NO_LOGIN", "Tento účet tu už nie je.")
            return {}
        case "POST", ["send", login_id] if product == "outlook":
            if not ACCOUNTS.get("outlook", login_id):
                raise ApiError(404, "SK.KARCHI.NO_LOGIN", "Tento účet tu už nie je.")
            send_mail(login_id, body, token)
            MAIL_WAKE.set()  # the sent mail comes into the archive with the next batch
            return {}
        case "GET", ["consent"]:
            return consent_report(product)
        case "POST", ["features"]:
            set_features_off(body.get("off"))
            return {"choices": choices()}
        case "POST", ["meeting", login_id] if product == "teams":
            return create_meeting(TEAMS.login_for(login_id), body)
        case "POST", ["search_users"] if product == "teams":
            return {"results": TEAMS.search(TEAMS.login_for(args.get("login_id", "")), str(body.get("query") or ""))}
        case "GET", ["resolve_identifier", ident] if product == "teams":
            return TEAMS.resolve(TEAMS.login_for(args.get("login_id", "")), ident)
        case "POST", ["create_dm", ident] if product == "teams":
            return TEAMS.create_dm(TEAMS.login_for(args.get("login_id", "")), ident)
    raise ApiError(404, "M_UNRECOGNIZED", "")


def whoami(token: str) -> str | None:
    req = urllib.request.Request(HOMESERVER + "/_matrix/client/v3/account/whoami", headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.load(resp).get("user_id")
    except (urllib.error.URLError, ValueError, OSError):
        return None


PREFIX = re.compile(r"^/(outlook|teams)/_matrix/provision/v3(/.*)?$")


class Handler(BaseHTTPRequestHandler):
    def reply(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self) -> dict | None:
        try:
            raw = self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 64 * MAX_BODY))
            body = json.loads(raw) if raw else {}
        except ValueError:
            return None
        return body if isinstance(body, dict) else None

    def appservice(self, path: str) -> None:
        if self.headers.get("Authorization", "").removeprefix("Bearer ").strip() != HS_TOKEN:
            return self.reply(403, {"errcode": "M_FORBIDDEN", "error": ""})
        if not path.startswith("/_matrix/app/v1/transactions/"):
            return self.reply(200 if path == "/_matrix/app/v1/ping" else 404, {})
        body = self.body()
        if body is None:
            return self.reply(400, {"errcode": "M_BAD_JSON", "error": ""})
        txn = path.rsplit("/", 1)[1]
        if txn not in SEEN_TXNS:
            SEEN_TXNS.append(txn)
            del SEEN_TXNS[:-500]
            for event in body.get("events") or []:
                if isinstance(event, dict):
                    TEAMS.take(event)
            for edu in body.get("ephemeral") or body.get("de.sorunome.msc2409.ephemeral") or []:
                if isinstance(edu, dict):
                    TEAMS.receipt(edu)
        self.reply(200, {})

    def api(self, method: str) -> None:
        url = urllib.parse.urlsplit(self.path)
        if url.path.startswith("/_matrix/app/"):
            return self.appservice(url.path)
        match = PREFIX.match(url.path)
        if not match:
            return self.reply(404, {"errcode": "M_NOT_FOUND", "error": ""})
        token = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if not token or whoami(token) != ADMIN:
            return self.reply(403, {"errcode": "M_FORBIDDEN", "error": "Only the server admin can use this bridge"})
        body = self.body() if method == "POST" else {}
        if body is None:
            return self.reply(400, {"errcode": "M_BAD_JSON", "error": ""})
        parts = [urllib.parse.unquote(p) for p in (match.group(2) or "").strip("/").split("/")]
        args = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        try:
            self.reply(200, route(match.group(1), method, parts, body, args, token))
        except ApiError as err:
            self.reply(err.status, {"errcode": err.errcode, "error": err.message})
        except GraphError as err:
            self.reply(502, {"errcode": "SK.KARCHI.REFUSED", "error": f"Microsoft odmietol ({err.status} {err.code})."})
        except Throttled:
            self.reply(429, {"errcode": "M_LIMIT_EXCEEDED", "error": "Microsoft teraz obmedzuje požiadavky."})
        except MatrixError as err:
            log("api: matrix", err)
            self.reply(502, {"errcode": "SK.KARCHI.UNREACHABLE", "error": "Homeserver neodpovedal."})

    def do_GET(self) -> None:
        self.api("GET")

    def do_POST(self) -> None:
        self.api("POST")

    def do_PUT(self) -> None:
        self.api("PUT")

    def log_message(self, fmt: str, *args) -> None:  # keep addresses and codes out of the journal
        pass


def main() -> None:
    global ACCOUNTS, TEAMS
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    ACCOUNTS = Accounts()
    TEAMS = Teams()
    threading.Thread(target=ACCOUNTS.run, name="checker", daemon=True).start()
    threading.Thread(target=TEAMS.run, name="teams", daemon=True).start()
    threading.Thread(target=TEAMS.read_loop, name="teams-read", daemon=True).start()
    threading.Thread(target=mail_loop, name="outlook", daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("PORT", "29330"))), Handler)
    log(f"microsoft bridge on {server.server_address[0]}:{server.server_address[1]}")
    server.serve_forever()


if __name__ == "__main__":
    main()
